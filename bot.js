import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';

// ===== 設定 =====
export const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
export const LISTING_URL = process.env.LISTING_URL || 'https://tonamel.com/competitions?game=dmps&region=JP';
export const TZ = process.env.TZ || 'Asia/Tokyo';
const DATA_FILE = path.join(process.cwd(), 'data.json');

if (!WEBHOOK_URL) {
  console.error('[ERROR] DISCORD_WEBHOOK_URL が設定されていません。GitHub SecretsまたはActions変数を確認してください。');
  process.exit(1);
}

// ===== データ永続化 =====
// { competitions: { [id]: { id, url, title, date, time, startAt, official, regulation, remindedDay, remindedHour } } }
export async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { competitions: {} };
  }
}

export async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ===== Discord通知 =====
export async function sendWebhook(content) {
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

export async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
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
    if (seen.has(id) || id.length < 3) continue;
    seen.add(id);
    results.push({ id, url: `https://tonamel.com/competition/${id}` });
  }
  return results;
}

// ===== 個別大会ページから タイトル・開始日時・公認かどうか を取得 =====
async function fetchDetail(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('body', { timeout: 30000 });

  try {
    await page.waitForFunction(
      () => document.title && document.title.trim().toLowerCase() !== 'tonamel',
      { timeout: 15000 }
    );
  } catch {
    // タイトルが変わらなくても、そのまま処理する
  }

  const pageTitle = await page.title();
  const title = pageTitle.replace(/\s*-\s*Tonamel\s*$/, '').trim();

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const fullText = await page.evaluate(() => document.body?.textContent || '');
  const metaDesc = await page.$eval('meta[name="description"]', (el) => el.content).catch(() => '');

  // JSON-LDのstartDateを探す
  let structuredStart = null;
  try {
    structuredStart = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
      const starts = [];
      const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (typeof value.startDate === 'string') starts.push(value.startDate);
        for (const child of Object.values(value)) walk(child);
      };
      for (const node of nodes) {
        try {
          walk(JSON.parse(node.textContent || ''));
        } catch {
          // JSON-LDでないものは無視
        }
      }
      return starts[0] || null;
    });
  } catch {
    structuredStart = null;
  }

  const searchText = `${title}\n${bodyText}\n${fullText}\n${metaDesc}`;
  const normalizedText = searchText
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let date = null;
  let time = null;
  let startAt = null;

  // 方法1：JSON-LDのstartDate
  if (structuredStart) {
    const isoMatch = structuredStart.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
    if (isoMatch) {
      const [, y, mo, d, hh, mm] = isoMatch;
      date = `${y}-${mo}-${d}`;
      time = `${String(hh).padStart(2, '0')}:${mm}`;
      startAt = `${date}T${time}:00+09:00`;
    }
  }

  const patterns = [
    /(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\s*\([^)]*\))?\s*(\d{1,2}):(\d{2})/,
    /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*\([^)]*\))?\s*(\d{1,2}):(\d{2})/,
  ];

  // 方法2：「イベント開始予定」の近くから
  if (!startAt) {
    const labelIndex = normalizedText.indexOf('イベント開始予定');
    if (labelIndex >= 0) {
      const area = normalizedText.slice(labelIndex, labelIndex + 300);
      for (const pattern of patterns) {
        const match = area.match(pattern);
        if (match) {
          const [, y, mo, d, hh, mm] = match;
          date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          time = `${String(hh).padStart(2, '0')}:${mm}`;
          startAt = `${date}T${time}:00+09:00`;
          break;
        }
      }
    }
  }

  // 方法3：ページ全体から
  if (!startAt) {
    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match) {
        const [, y, mo, d, hh, mm] = match;
        date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        time = `${String(hh).padStart(2, '0')}:${mm}`;
        startAt = `${date}T${time}:00+09:00`;
        break;
      }
    }
  }

  if (startAt) {
    console.log(`[INFO] 開始日時取得成功: ${date} ${time} (${url})`);
  } else {
    console.warn(`[WARN] 日時抽出失敗 (${url})`);
  }

  const official = /公認/.test(searchText) || /公認/.test(title);

  let regulation = null;
  if (/New\s*Division|ニューディビジョン|フォーマット[:：]?\s*ND\b|レギュレーション[:：]?\s*ND\b/i.test(searchText)) {
    regulation = 'ND';
  } else if (/All\s*Division|オールディビジョン|フォーマット[:：]?\s*AD\b|レギュレーション[:：]?\s*AD\b/i.test(searchText)) {
    regulation = 'AD';
  } else if (/SP\s*ルール|スペシャルルール|SPマッチ|フォーマット[:：]?\s*SP\b/i.test(searchText)) {
    regulation = 'SP';
  }
  if (!regulation) {
    const titleTagMatch = title.match(/(?:^|[^A-Za-z])(ND|AD|SP)(?:$|[^A-Za-z])/);
    if (titleTagMatch) regulation = titleTagMatch[1].toUpperCase();
  }

  return { title, date, time, startAt, official, regulation };
}

// ===== 新着大会チェック（1回だけ実行） =====
export async function checkForNewCompetitions() {
  console.log('[INFO] 新着大会チェック開始:', new Date().toISOString());
  const data = await loadData();
  const browser = await launchBrowser();

  try {
    const listPage = await browser.newPage();
    await listPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
    );
    await listPage.setViewport({ width: 1280, height: 900 });

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
    await detailPage.setViewport({ width: 1280, height: 900 });

    for (const { id, url } of listing) {
      const existing = data.competitions[id];
      if (existing && existing.date && existing.startAt) continue;

      let detail;
      try {
        detail = await fetchDetail(detailPage, url);
      } catch (err) {
        console.error(`[ERROR] 詳細ページ取得失敗 (${id}):`, err);
        detail = null;
      }

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
        remindedDay: existing?.remindedDay ?? false,
        remindedHour: existing?.remindedHour ?? false,
      };

      if (!detail.official) {
        console.log(`[INFO] 非公認大会のためスキップ: ${detail.title}`);
        continue;
      }
      console.log(`[INFO] 公認大会を記録/更新（通知はしない）: ${detail.title}`);
    }

    await detailPage.close();
  } finally {
    await browser.close();
  }

  await saveData(data);
  console.log('[INFO] 新着大会チェック終了');
}

// ===== 当日9:00リマインド（1回だけ実行） =====
export async function checkDailyReminders() {
  console.log('[INFO] 当日リマインドチェック開始:', new Date().toISOString());
  const data = await loadData();
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });

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

// ===== 開始1時間前リマインド（1回だけ実行） =====
export async function checkHourlyReminders() {
  console.log('[INFO] 1時間前リマインドチェック開始:', new Date().toISOString());
  const data = await loadData();
  const now = new Date();

  for (const comp of Object.values(data.competitions)) {
    if (!comp.official || !comp.startAt || comp.remindedHour) continue;
    const startAt = new Date(comp.startAt);
    const diffMin = (startAt - now) / 60000;

    if (diffMin <= 65 && diffMin > 40) {
      const regText = comp.regulation ? `（${comp.regulation}）` : '';
      await sendWebhook(`⏰ まもなく開始：**${comp.title}**${regText} が1時間後に開始します（${comp.time}～）\n${comp.url}`);
      comp.remindedHour = true;
      console.log(`[INFO] 1時間前リマインド送信: ${comp.title}`);
    }
  }

  await saveData(data);
  console.log('[INFO] 1時間前リマインドチェック終了');
}
