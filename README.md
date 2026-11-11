# News Hub

広告なしのシンプルなニュースまとめ。政治 / 経済 / 金融 / 車 / コスメ / 国内 / 国際 / スポーツ / エンタメ / IT / 科学 / ライフ。各カードは見出し＋画像＋2行の概要。

タブは右上の ⚙ から、表示/非表示・並び替え・キーワードタブの追加ができます（設定はブラウザごとに保存され、他の人には影響しません）。

- NHK・朝日・Yahoo!ニュース・東洋経済・Investing.com・レスポンス・WWD JAPAN などのRSSを集約
- サーバーが3分ごとにRSSを再取得、画面は1分ごとに自動更新
- 依存ライブラリなし（Node 18+）

## ローカル実行

```
npm start   # http://localhost:3000
```

## Renderへのデプロイ

Render → New → Blueprint でこのリポジトリを選ぶ（`render.yaml` を自動検出）。
無料プランは15分アクセスが無いとスリープし、次のアクセスで数十秒かけて復帰します。

## GitHub Pagesにフロントだけ置く場合

`public/config.js` の `NEWS_API_BASE` にRenderのURLを設定し、`public/` をPagesで公開。

## 媒体・ジャンルの変更

`server.js` の `FEEDS` を編集。

<!-- auto-deploy check -->
