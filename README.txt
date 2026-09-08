共通利用センター / pay2
======================

このフォルダー一式だけでCloudflareへデプロイする正本です。
旧版・差分ファイル・追加パッチとの組み合わせは不要です。

構成
----
index.js
package.json
wrangler.jsonc
schema.sql
README.txt
public/
  index.html

Cloudflare
----------
D1: DB -> pay2-db
R2: BUCKET -> pay2-image
Static Assets: ASSETS -> public
compatibility_date: 2026-08-08（固定）

保持している主な機能
--------------------
・対象Webアプリの追加・編集・非表示
・無料 / 月額の設定
・無料期間（日数）の設定
・月額価格（円）の設定
・有料利用期間（日数）の設定
・無料期間終了後の決済判定
・Square Sandboxカード決済
・Sandbox決済成功後、各アプリに設定した有料利用期間を付与
・利用者と利用権のD1保存
・Square Application ID / Location ID の管理画面保存
・Square Access Token はCloudflare Secretのみ
・管理者パスワード変更
・管理者パスワードは平文保存せず、D1には照合用ハッシュのみ保存

Secret
------
ADMIN_KEY
SQUARE_ACCESS_TOKEN

この2つの値はZIP、GitHub、HTML、D1へ平文で入れません。
最初の管理者ログインはCloudflare SecretのADMIN_KEYを使用します。
管理画面でパスワードを変更した後は、D1のハッシュで照合します。

D1テーブルはindex.jsが起動時に自動作成します。schema.sqlの手動実行は不要です。
