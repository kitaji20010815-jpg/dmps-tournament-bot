# DMPS 公認大会通知Bot（GitHub Actions版）

Tonamelの大会一覧ページ（`https://tonamel.com/competitions?game=dmps&region=JP`）を定期的にチェックし、

- 大会**当日の朝9:00**にリマインド通知
- 大会**開始1時間前**にリマインド通知

をDiscordのWebhook経由で送るBotです。**サーバーを借りずに、GitHub Actionsの無料枠だけで動きます。**

## 仕組み

常時起動のサーバーではなく、GitHubが決まった時間に自動でプログラムを起動→終了するのを繰り返す仕組みです。

- `新着大会チェック`：1時間ごとに大会一覧を確認し、大会データを`data.json`に記録
- `当日9時リマインド`：毎日9:00に、本日開催の大会があれば通知
- `開始1時間前リマインド`：15分ごとに、まもなく開始する大会があれば通知

それぞれ実行後、更新した`data.json`を自動でリポジトリにコミットして保存します。

## セットアップ手順

### 1. GitHub Secretsの設定

1. このリポジトリの「Settings」タブを開く
2. 左メニューの「Secrets and variables」→「Actions」
3. 「New repository secret」をクリック
4. Name: `DISCORD_WEBHOOK_URL`、Secret: DiscordのWebhook URLを貼り付けて保存

### 2. Actionsの書き込み権限を有効にする

1. 「Settings」→「Actions」→「General」
2. 一番下の「Workflow permissions」で「Read and write permissions」を選択して保存
   （これをやらないと、`data.json`の自動保存ができません）

### 3. ファイルをアップロード

このリポジトリの中身を、以下の構成でアップロードしてください。

```
dmps-tournament-bot/
├── .github/
│   └── workflows/
│       ├── check-new.yml
│       ├── daily-reminder.yml
│       └── hourly-reminder.yml
├── bot.js
├── run-check.js
├── run-daily.js
├── run-hourly.js
├── package.json
└── data.json
```

### 4. 動作確認

1. リポジトリの「Actions」タブを開く
2. 「新着大会チェック」を選び、右側の「Run workflow」ボタンで手動実行
3. 緑色のチェックマークが付けば成功。ログも確認できます

あとは放っておけば、自動でスケジュール通りに動き続けます。

## 注意点

- GitHub Actionsのスケジュール実行は、混雑状況によって数分遅れることがあります
- Private（非公開）リポジトリでも、月2,000分の無料枠の範囲なら課金されません（このBotの使用量なら十分収まります）
