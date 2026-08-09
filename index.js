import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import puppeteer from 'puppeteer';

// ===== 設定 =====
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LISTING_URL = process.env.LISTING_URL || 'https://tonamel.com/competitions?game=dmps&region=JP';
const CHECK_CRON = process.env.CHECK_CRON || '0 * * * *'; // 新着大会チェック：1時間ごと
const DAILY_REMINDER_CRON = process.env.DAILY_REMINDER_CRON || '0 9 * * *'; // 当日リマインド：毎日9:00
const HOURLY_REMINDER_CRON = process.env.HOURLY_REMINDER_CRON || '*/15 * * * *'; // 開始1時間前チェック：15分おき
const TZ = process.env.TZ || 'Asia/Tokyo';
const DATA_FILE = path.join(process.cwd(), 'data.json');

if (!WEBHOOK_URL) {
  console.error('[ERROR] DISCORD_WEBHOOK_URL が設定されていません。.envを確認してください。');
  process.exit(1);
}

// ===== データ永続化 =====
// { competitions: { [id]: { id, url, title, date, time, startAt, official, remindedDay, remindedHour } } }
async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { competitions: {} };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ===== Discord通知 =====
async function sendWebhook(content) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error('[ERROR] Webhook送信失敗:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[ERROR] Webhook送信中に例外:', err);
  }
}

// ===== 一覧ページから大会リンクを取得 =====
async function scrapeListing(page) {
  await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  await page.waitForSelector('a[href*="/competition/"]', { timeout: 30000 }).catch(() => {
    console.warn('[WARN] 大会リンクが見つかりませんでした。サイト構造が変わった可能性があります。');
  });

  const links = await page.$$eval('a[href*="/competition/"]', (as) => as.map((a) => a.href));

  const seen = new Set();
  const results = [];
  for (const href of links) {
    const m = href.match(/\/competition\/([A-Za-z0-9]+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id) || id.length < 3) continue; // matchup等の長いIDを除外
    seen.add(id);
    results.push({ id, url: `https://tonamel.com/competition/${id}` });
  }
  return results;
}

// ===== 個別大会ページから タイトル・開始日時・公認かどうか を取得 =====
async function fetchDetail(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('body', { timeout: 30000 });

  // ページタイトルがJSで書き換わるまで少し待つ（"Tonamel"のままの取得失敗を減らす）
  try {
    await page.waitForFunction(
      () => document.title && document.title.trim().toLowerCase() !== 'tonamel',
      { timeout: 15000 }
    );
  } catch {
    // 15秒待っても変わらなければそのまま進める（呼び出し元で失敗扱いにする）
  }

  const pageTitle = await page.title();
  const title = pageTitle.replace(/\s*-\s*Tonamel\s*$/, '').trim();

  // 「イベント開始予定」欄が実際に描画されるまで待つ（無い大会もあるので、無ければタイムアウトで諦める）
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('イベント開始予定'),
      { timeout: 20000 }
    );
  } catch {
    // 見つからない場合はそのまま進める（その大会は開始日時なしとして扱われる）
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  // 折りたたまれたルール欄など、innerTextで拾えない非表示テキストも対象にする
  const fullText = await page.evaluate(() => document.body.textContent);
  const metaDesc = await page
    .$eval('meta[name="description"]', (el) => el.content)
    .catch(() => '');
  const searchText = `${title}\n${bodyText}\n${fullText}\n${metaDesc}`;

  // 「イベント開始予定 2026/08/06(木) 21:00 ～」のような構造化された表示を抽出
  const dtMatch = bodyText.match(
    /イベント開始予定\s*\n?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\([^)]*\)\s*(\d{1,2}):(\d{2})/
  );

  let date = null;
  let time = null;
  let startAt = null;
  if (dtMatch) {
    const [, y, mo, d, hh, mm] = dtMatch;
    date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    startAt = `${date}T${time}:00+09:00`;
  }

  // 「公認」の文字がページ内にあるかで公認大会かどうかを判定
  const official = /公認/.test(searchText) || /公認/.test(title);

  // レギュレーション（ND/AD/SP）の判定：主催者の説明文中の表記ゆれに対応
  let regulation = null;
  if (/New\s*Division|ニューディビジョン|フォーマット[:：]?\s*ND\b|レギュレーション[:：]?\s*ND\b/i.test(searchText)) {
    regulation = 'ND';
  } else if (/All\s*Division|オールディビジョン|フォーマット[:：]?\s*AD\b|レギュレーション[:：]?\s*AD\b/i.test(searchText)) {
    regulation = 'AD';
  } else if (/SP\s*ルール|スペシャルルール|SPマッチ|フォーマット[:：]?\s*SP\b/i.test(searchText)) {
    regulation = 'SP';
  }

  // 本文で見つからなかった場合、大会名自体に単独でND/AD/SPと入っているケースを拾う
  // （記号・空白・文字列の端で区切られている場合のみ検出し、他の単語の一部を誤検出しないようにする）
  if (!regulation) {
    const titleTagMatch = title.match(/(?:^|[^A-Za-z])(ND|AD|SP)(?:$|[^A-Za-z])/);
    if (titleTagMatch) {
      regulation = titleTagMatch[1].toUpperCase();
    }
  }

  return { title, date, time, startAt, official, regulation };
}

// ===== 新着大会チェック =====
async function checkForNewCompetitions(browser) {
  console.log('[INFO] 新着大会チェック開始:', new Date().toISOString());
  const data = await loadData();

  const listPage = await browser.newPage();
  await listPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
  );

  let listing;
  try {
    listing = await scrapeListing(listPage);
  } catch (err) {
    console.error('[ERROR] 一覧ページの取得に失敗:', err);
    await listPage.close();
    return;
  }
  await listPage.close();

  const detailPage = await browser.newPage();
  await detailPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
  );

  for (const { id, url } of listing) {
    if (data.competitions[id]) continue; // 既知の大会はスキップ

    let detail;
    try {
      detail = await fetchDetail(detailPage, url);
    } catch (err) {
      console.error(`[ERROR] 詳細ページ取得失敗 (${id}):`, err);
      detail = null;
    }

    // タイトルが取れていない（読み込み未完了など）場合は記録せず、次回チェックでリトライする
    const titleLooksInvalid = !detail || !detail.title || detail.title.trim().toLowerCase() === 'tonamel';
    if (titleLooksInvalid) {
      console.warn(`[WARN] タイトル取得に失敗したため今回はスキップ（次回リトライ）: ${url}`);
      continue;
    }

    data.competitions[id] = {
      id,
      url,
      title: detail.title,
      date: detail.date,
      time: detail.time,
      startAt: detail.startAt,
      official: detail.official,
      regulation: detail.regulation,
      remindedDay: false,
      remindedHour: false,
    };

    if (!detail.official) {
      console.log(`[INFO] 非公認大会のためスキップ: ${detail.title}`);
      continue;
    }

    console.log(`[INFO] 新着公認大会を記録（通知はしない）: ${detail.title}`);
  }

  await detailPage.close();
  await saveData(data);
  console.log('[INFO] 新着大会チェック終了');
}

// ===== 当日9:00リマインド =====
async function checkDailyReminders() {
  console.log('[INFO] 当日リマインドチェック開始:', new Date().toISOString());
  const data = await loadData();
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

  for (const comp of Object.values(data.competitions)) {
    if (!comp.official || !comp.date || comp.remindedDay) continue;
    if (comp.date === todayStr) {
      const timeText = comp.time ? `${comp.time}～` : '';
      const regText = comp.regulation ? `\nレギュレーション: ${comp.regulation}` : '';
      await sendWebhook(`⏰ 本日開催：**${comp.title}**\n${timeText}${regText}\n${comp.url}`);
      comp.remindedDay = true;
      console.log(`[INFO] 当日リマインド送信: ${comp.title}`);
    }
  }

  await saveData(data);
  console.log('[INFO] 当日リマインドチェック終了');
}

// ===== 開始1時間前リマインド（15分おきにチェック）=====
async function checkHourlyReminders() {
  const data = await loadData();
  const now = new Date();

  for (const comp of Object.values(data.competitions)) {
    if (!comp.official || !comp.startAt || comp.remindedHour) continue;
    const startAt = new Date(comp.startAt);
    const diffMin = (startAt - now) / 60000;

    // 45分〜60分前のウィンドウで検知（15分おきチェックなので取りこぼし防止に幅を持たせる）
    if (diffMin <= 60 && diffMin > 45) {
      const regText = comp.regulation ? `（${comp.regulation}）` : '';
      await sendWebhook(`⏰ まもなく開始：**${comp.title}**${regText} が1時間後に開始します（${comp.time}～）\n${comp.url}`);
      comp.remindedHour = true;
      console.log(`[INFO] 1時間前リマインド送信: ${comp.title}`);
      await saveData(data);
    }
  }
}

// ===== 起動 =====
console.log('[INFO] DMPS大会通知Bot 起動');
console.log(`[INFO] 監視URL: ${LISTING_URL}`);
console.log(`[INFO] 新着チェック cron: ${CHECK_CRON}`);
console.log(`[INFO] 当日リマインド cron: ${DAILY_REMINDER_CRON}`);
console.log(`[INFO] 1時間前リマインド cron: ${HOURLY_REMINDER_CRON}`);

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

async function runNewCompetitionsCheck() {
  const browser = await launchBrowser();
  try {
    await checkForNewCompetitions(browser);
  } finally {
    await browser.close();
  }
}

// 起動時に1回実行
runNewCompetitionsCheck().then(checkDailyReminders).then(checkHourlyReminders);

cron.schedule(CHECK_CRON, runNewCompetitionsCheck, { timezone: TZ });
cron.schedule(DAILY_REMINDER_CRON, checkDailyReminders, { timezone: TZ });
cron.schedule(HOURLY_REMINDER_CRON, checkHourlyReminders, { timezone: TZ });
