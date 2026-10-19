# プレートテクトニクス（HTML5 版）

PhET の Java シミュレーション「Plate Tectonics」（`plate-tectonics_ja.jar`, v1.02）を、
ブラウザだけで動くように作り直したものです。Windows 以外（Mac / iPad / Chromebook / Linux）でも動きます。

## 遊び方

- `index.html` をブラウザ（Chrome / Edge / Safari / Firefox）で開くだけ。インストール不要・オフラインで動作。
  - ダブルクリックで開けない環境では、このフォルダで `python -m http.server` を実行し
    `http://localhost:8000/` を開いてください。
  - 公開版: https://ypsilonmeister.github.io/plate-tectonics-html5/ （iPad からも使えます）
- **地殻タブ**: 真ん中の地殻の「温度・構成・厚み」を変えると、地殻が浮き沈みします（アイソスタシー）。
  ズームで地球の中心（マントル・外核・内核）まで見られます。温度計・密度計・定規はツールボックスからドラッグ。
- **プレート運動タブ**: 右下の地殻ブロックを左右の点線の箱にドラッグ。
  - 手動モード: 赤い玉のハンドルを引っ張るか、矢印を押し続けると時間が進みます。
  - 自動モード: 動き方（収束・発散・変換）を選んで ▶ を押します。

## 構成

| ファイル | 内容 |
|---|---|
| `js/core.js` | 数学・Observable・サンプル/領域/地形など共通モデル |
| `js/crust-model.js` | 地殻タブのモデル（CrustModel の移植） |
| `js/plate-motion-model.js` | プレート運動モデルと 5 種の挙動（沈み込み・衝突・発散・トランスフォーム等） |
| `js/tools.js` | 温度計・密度計・定規・地殻ブロックの 2D 描画 |
| `js/view.js` | three.js による 3D 描画、カメラ、ラベル描画 |
| `js/app.js` | タブ・パネル・ドラッグ操作・ループ |
| `lib/three.min.js` | three.js r149 |
| `js/noise-texture.js` | 元の jar に含まれる noise.png（埋め込み） |
| `test/` | `node test/plate-motion.test.js` でモデルの自動テスト、`tools-demo.html` で計器の見た目確認 |

元の jar とデコンパイルした Java ソースは、移植の参照用に手元だけで使い、このリポジトリには含めていません。
原作: PhET Interactive Simulations, University of Colorado Boulder（Jon Olson, Sam Reid ほか）。
