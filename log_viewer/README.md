# Triton-3 / UmiBot Log Viewer

Triton-3とUmiBotがmicroSDへ保存した`DATA.CSV`と`EVENT.CSV`を、ブラウザ内だけで解析・表示する静的Webアプリです。選択したログはサーバーへ送信されません。共通時間範囲、同期カーソル、選択点インスペクタ、イベント、生DATA、品質診断、サイクル比較、GPS航跡を業務向けの複数ビューで確認できます。

## 必要環境

- Node.js 20.19以降
- npm

## 開発

```sh
npm install
npm run generate:samples
npm test
npm run dev
```

開発サーバーが表示するローカルURLをブラウザで開いてください。ES Modulesを使用するため、`index.html`を`file://`で直接開く方法はサポートしません。

## 静的ビルド

```sh
npm install
npm run generate:samples
npm test
npm run build
```

公開用ファイルは`dist/`に生成されます。Viteの`base`を`./`にしているため、独自ドメイン直下だけでなくサブディレクトリにも配置できます。

## Cloudflare Pagesへの配置

このアプリにバックエンド、API、Functions、環境変数は不要です。

1. 上記手順で`npm run build`を実行します。
2. Cloudflare PagesのDirect Uploadで、生成された`dist/`ディレクトリをアップロードします。
3. 公開URLで画面を開き、同梱サンプルを読み込めることを確認します。

このリポジトリから自動デプロイは行いません。Cloudflare以外の静的ホスティングでも`dist/`をそのまま配信できます。

`public/_headers`はビルド時に`dist/_headers`へコピーされます。Content Security Policyでは解析API、CDN、スクリプト等への外部通信を無効化しています。GPSは既定でオフライン簡易航跡を表示します。ユーザーが画面上で`OpenStreetMap`へ切り替えた場合だけ、座標周辺の地図タイル画像を`tile.openstreetmap.org`から取得します。CSV本体を送信する処理はありません。

## 主なコマンド

- `npm run dev`: ローカル開発サーバーを起動
- `npm run preview`: ビルド済み`dist/`をローカル確認
- `npm run build`: `dist/`へ静的サイトを生成
- `npm test`: Node.js標準テストランナーでテストを実行
- `npm run generate:samples`: 正常系・異常系のダミーCSVを再生成

## 検証内容

- 正常／敵対的ダミーCSV: `public/samples/{triton,umibot}-{normal,adversarial}/`
- 自動試験: `tests/log-core.test.mjs`（正常系、CSV破損、再起動、millis周回、20万行など）
- 元の表示案を採用しなかった理由と将来形式案: `AUDIT.md`

## GPS表示とテーマ

- `簡易`: 完全オフラインの相対航跡。緑が開始、赤が終了、黄が全グラフと同期した選択時刻です。
- `OpenStreetMap`: 利用者が明示的に切り替えたときだけ外部タイルを取得します。解析データやCSVはアップロードしません。
- テーマ: `自動 → ライト → ダーク`の順に切り替わり、選択はブラウザへ保存されます。

共有カードは`public/og.png`です。公開URLが確定した後、必要に応じて`index.html`の`og:image`を絶対URLへ置き換えてください。
