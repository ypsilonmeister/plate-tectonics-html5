# プレートテクトニクス（HTML5 版）

PhET の Java シミュレーション「Plate Tectonics」（v1.02）を、ブラウザだけで動くように作り直した**非公式の移植版**です。
Windows 以外（Mac / iPad / Chromebook / Linux）でも、インストールなしで遊べます。

**遊ぶ:** https://ypsilonmeister.github.io/plate-tectonics-html5/

- **地殻タブ**: 地殻の温度・構成・厚みを変えて、地殻が浮き沈みする様子（アイソスタシー）を見る
- **プレート運動タブ**: 地殻ブロックを置いて、沈み込み・衝突・発散・トランスフォームを再現する

使い方とファイル構成は [html5/README.md](html5/README.md) にあります。

## 原本との一致

元の jar のモデルを画面なしで動かし、同じ操作をした HTML5 版と数値で突き合わせています。地殻とプレートの組み合わせ 28 通り、地殻タブの設定 6 通りのすべてで一致しました。画面の見た目も原本と並べて比べています。手順は [verify/README.md](verify/README.md) にあります。

## ライセンスと原作

- 原作: [PhET Interactive Simulations](https://phet.colorado.edu/), University of Colorado Boulder（Jon Olson, Sam Reid ほか）。この移植版は PhET が作成・承認したものではありません。
- PhET のシミュレーションのソースコードは GNU GPL で公開されています。この移植版も同じく [GNU GPL v3](LICENSE) で公開します。
- `html5/lib/three.min.js` は [three.js](https://threejs.org/)（MIT ライセンス）です。
