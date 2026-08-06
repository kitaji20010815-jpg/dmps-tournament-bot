# DMPS 公認大会通知Bot

Tonamelの大会一覧ページ（`https://tonamel.com/competitions?game=dmps&region=JP`）を定期的にチェックし、

- 新しい大会が公開されたら Discord に通知
- 大会の開催日が近づいたら（デフォルト: 3日前・前日）リマインド通知

を Discord の Webhook 経由で送るBotです。

## 必要なもの

- Node.js 18以上
- Discordの **Webhook URL**
  - サーバー設定 → 連携サービス（インテグレーション） → ウェブフック → 新しいウェブフック
  - 通知したいチャンネルを選んで「ウェブフックURLをコピー」

## セットアップ

```bash
npm install
cp .env.example .env
```

`.env` を開いて `DISCORD_WEBHOOK_URL` に発行したWebhook URLを貼り付けてください。
他の項目（監視頻度・リマインド日数など）は必要に応じて変更できます。

## 起動

```bash
npm start
```

起動すると即座に1回チェックが走り、その後は `CHECK_CRON`（デフォルト1時間ごと）で新着大会チェック、`REMINDER_CRON`（デフォルト毎日9:00）でリマインドチェックが自動実行されます。

## 常時稼働させる場合

自分のPCで動かし続けるのは現実的ではないので、以下のような無料〜低価格のホスティングにデプロイするのがおすすめです。

- **Railway** / **Render**: GitHubリポジトリを繋いでNode.jsアプリとしてデプロイ可能。環境変数に`.env`の内容を設定。
- 注意: PuppeteerはChromiumを内部で使うため、ホスティング先によっては追加のビルド設定（依存パッケージのインストール）が必要な場合があります。デプロイ時にエラーが出たら「puppeteer chromium buildpack [ホスティング名]」で検索してみてください。

## データの保存

見つけた大会の情報は `data.json` に保存され、二重通知を防ぎます。Botを再起動してもこのファイルがあれば通知済みの大会は再通知されません。

## サイト構造が変わった場合

Tonamelの一覧ページの構造が変わり大会が検出できなくなった場合は、`index.js` の `scrapeListing()` 内のセレクタ（`a[href*="/competition/"]`）を実際のページのDOM構造に合わせて調整してください。
