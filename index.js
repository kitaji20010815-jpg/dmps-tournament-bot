import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import puppeteer from 'puppeteer';

// ===== 設定 =====
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LISTING_URL = process.env.LISTING_URL || 'https://tonamel.com/competitions?game=dmps&region=JP';
const CHECK_CRON = process.env.CHECK_CRON || '0 * * * *'; // 1時間ごと
const REMINDER_CRON = process.env.REMINDER_CRON || '0 9 * * *'; // 毎日9:00
const REMINDER_DAYS = (process.env.REMINDER_DAYS || '3,1').split(',').map((n) => parseInt(n.trim(), 10));
const DATA_FILE = path.join(process.cwd(), 'data.json');

if (!WEBHOOK_URL) {
  console.error('[ERROR] DISCORD_WEBHOOK_URL が設定されていません。.envを確認してください。');
  process.exit(1);
}

// ===== データ永続化 =====
// { competitions: { [id]: { id, url, title, date: 'YYYY-MM-DD'|null, notified: true, remindedDays: number[] } } }
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

// ===== 一覧ページから大会リンクを取得（JS描画なのでPuppeteer使用）=====
async function scrapeListing() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
    );
    await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 大会カードが描画されるまで待つ（構造が変わった場合はここのセレクタを調整）
    await page.waitForSelector('a[href*="/competition/"]', { timeout: 30000 }).catch(() => {
      console.warn('[WARN] 大会リンクが見つかりませんでした。サイト構造が変わった可能性があります。');
    });

    const links = await page.$$eval('a[href*="/competition/"]', (as) =>
      as.map((a) => a.href)
    );

    // 重複除去 + IDだけ抽出
    const seen = new Set();
    const results = [];
    for (const href of links) {
      const m = href.match(/\/competition\/([A-Za-z0-9]+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      results.push({ id, url: `https://tonamel.com/competition/${id}` });
    }
    return results;
  } finally {
    await browser.close();
  }
}

// ===== 個別大会ページから タイトル・開催日 を取得（静的fetchで十分）=====
async function fetchDetail(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DMPS-Tournament-Bot/1.0)' },
  });
  const html = await res.text();

  const titleMatch = html.match(/<title>(.*?)<\/title>/s);
  let title = titleMatch ? titleMatch[1].replace(/\s*-\s*Tonamel\s*$/, '').trim() : url;

  const descMatch = html.match(/<meta name="description" content="(.*?)"/s);
  const desc = descMatch ? descMatch[1] : '';

  // 開催日：2025年5月11日 のようなパターンを抽出
  const dateMatch = desc.match(/開催日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  let date = null;
  if (dateMatch) {
    const [, y, mo, d] = dateMatch;
    date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // タイトルまたは説明文に「公認」が含まれる大会だけを対象とする
  const official = /公認/.test(title) || /公認/.test(desc);

  return { title, date, official };
}

// ===== 新着大会チェック =====
async function checkForNewCompetitions() {
  console.log('[INFO] 新着大会チェック開始:', new Date().toISOString());
  const data = await loadData();

  let listing;
  try {
    listing = await scrapeListing();
  } catch (err) {
    console.error('[ERROR] 一覧ページの取得に失敗:', err);
    return;
  }

  for (const { id, url } of listing) {
    if (data.competitions[id]) continue; // 既知の大会はスキップ

    let detail;
    try {
      detail = await fetchDetail(url);
    } catch (err) {
      console.error(`[ERROR] 詳細ページ取得失敗 (${id}):`, err);
      detail = { title: url, date: null, official: false };
    }

    data.competitions[id] = {
      id,
      url,
      title: detail.title,
      date: detail.date,
      official: detail.official,
      notified: detail.official,
      remindedDays: [],
    };

    if (!detail.official) {
      console.log(`[INFO] 非公認大会のためスキップ: ${detail.title}`);
      continue;
    }

    const dateText = detail.date ? `\n開催日: ${detail.date}` : '';
    await sendWebhook(`📢 新しい公認大会が見つかりました！\n**${detail.title}**${dateText}\n${url}`);
    console.log(`[INFO] 新着大会を通知: ${detail.title}`);
  }

  await saveData(data);
  console.log('[INFO] 新着大会チェック終了');
}

// ===== 開催日リマインドチェック =====
async function checkReminders() {
  console.log('[INFO] リマインドチェック開始:', new Date().toISOString());
  const data = await loadData();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const comp of Object.values(data.competitions)) {
    if (!comp.date || !comp.official) continue;
    const eventDate = new Date(comp.date + 'T00:00:00');
    const diffDays = Math.round((eventDate - today) / (1000 * 60 * 60 * 24));

    if (REMINDER_DAYS.includes(diffDays) && !comp.remindedDays.includes(diffDays)) {
      const label = diffDays === 0 ? '本日開催' : `${diffDays}日後に開催`;
      await sendWebhook(`⏰ リマインド：**${comp.title}** が${label}です（${comp.date}）\n${comp.url}`);
      comp.remindedDays.push(diffDays);
      console.log(`[INFO] リマインド送信: ${comp.title} (${diffDays}日前)`);
    }
  }

  await saveData(data);
  console.log('[INFO] リマインドチェック終了');
}

// ===== 起動 =====
console.log('[INFO] DMPS大会通知Bot 起動');
console.log(`[INFO] 監視URL: ${LISTING_URL}`);
console.log(`[INFO] 新着チェック cron: ${CHECK_CRON}`);
console.log(`[INFO] リマインド cron: ${REMINDER_CRON} (${REMINDER_DAYS.join(',')}日前)`);

// 起動時に1回実行
checkForNewCompetitions().then(checkReminders);

cron.schedule(CHECK_CRON, checkForNewCompetitions, { timezone: process.env.TZ || 'Asia/Tokyo' });
cron.schedule(REMINDER_CRON, checkReminders, { timezone: process.env.TZ || 'Asia/Tokyo' });
