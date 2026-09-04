共通利用センター / Cloudflare公開用
================================

このZIPを正本として使用してください。
別ファイルとの組み合わせは不要です。

ファイル配置
------------
index.js
package.json
wrangler.jsonc
schema.sql
README.txt
public/
  index.html

Cloudflare接続
--------------
D1:
  binding = DB
  database_name = pay2-db

R2:
  binding = BUCKET
  bucket_name = pay2-image

Static Assets:
  binding = ASSETS
  directory = ./public

public/index.html は完成済み画面をそのまま保持しています。
index.js も完成済みWorkerの内容をそのまま保持しています。

D1の必要テーブルは index.js が起動時に自動作成します。
schema.sql は確認用で、Cloudflare Studioへ手動で貼り付ける必要はありません。

Squareの秘密情報はファイルに保存しません。
SQUARE_ACCESS_TOKEN と ADMIN_KEY はCloudflare Secretで管理します。
