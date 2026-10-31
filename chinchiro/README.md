# チンチロ（飲み会用）

各自のスマホでGoogleログインして、ルームで順番にサイコロを振るチンチロです。
**マルチカウンターと同じ構成・同じデザイン**で作っています（素のHTML/CSS/JavaScript ＋ Firebase）。

- 公開先：マルチカウンターと同じ Firebase プロジェクト `multi-counter-2f556` に、チンチロ用の公開サイトを追加
- データ：Firestore（東京）。マルチカウンターとは別の場所（`chinchiroRooms` / `chinchiroUsers`）に保存
- ログイン：Google

## できること

| 画面 | 内容 |
|---|---|
| プレイ | 手番の人が「サイコロを振る」。役が出るまで最大3投。全員の画面に同じ出目がリアルタイムで出る |
| 周の結果 | 全員が振り終わると、最強の人の色で結果を全画面表示（順位・最強・最弱） |
| 代わりに振る / スキップ | 手番の人が席を外しているとき、他の人が代理で振る、または今回だけ飛ばす |
| 招待 | QRコード・リンク送信・コピー（LINEで開いたときは外部ブラウザへ切り替え） |
| 記録 | 周ごとの出目（振り直しの途中も含む）。メンバー別にも表示。最新1000ターンほどを保存 |
| 分析 | 期間（今日・昨日・直近100回・直近10周・今週・先週・今月・全期間・期間指定）を選んで、概要・個人の偏り・役ごとのランキング・対戦表 |
| 設定 | メンバー（色・休憩・順番・シャッフル・外す）／ルール（ションベンの有無と確率）／ルーム（名前・新規・最近のルーム）／この端末（表示名・振動・効果音・消灯防止） |

- 1日の区切りは**朝5時**（深夜まで続く飲み会が「今日」に入るように）
- 端末の「戻る」操作では、いちばん手前のシートや結果画面だけが閉じます

## ルール（役の強さ）

ピンゾロ（1・1・1）＞ アラシ（2〜6のゾロ目、数字が大きいほど強い）＞ シゴロ（4・5・6）＞ 6の目〜1の目 ＞ 目なし ＞ ションベン（設定でオンのときだけ）＞ ヒフミ（1・2・3）

サイコロは振った人の端末で、暗号用の乱数（`crypto.getRandomValues`）を使って決めます。

## 公開（デプロイ）

マルチカウンターと同じく、gcloud のログイン情報（Application Default Credentials）で firebase-tools を動かします。

```bash
# 1. ログイン（表示されたURLをブラウザで開き、Googleアカウントで許可 → 表示されたコードを貼る）
gcloud auth application-default login --no-launch-browser \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/firebase,openid,https://www.googleapis.com/auth/userinfo.email
gcloud auth application-default set-quota-project multi-counter-2f556

# 2. 初回のみ：公開サイトを作って、このフォルダの設定と結びつける
firebase hosting:sites:create <サイトID> --project multi-counter-2f556
firebase target:apply hosting chinchiro <サイトID> --project multi-counter-2f556
#    さらに Firebase Authentication の「承認済みドメイン」に <サイトID>.web.app を追加する

# 3. 公開（Firestoreのルールはマルチカウンターの分も含めた全体を上書きするので、firestore.rules を必ず両方入りのまま保つ）
npm run deploy
```

## 手元で動かす

```bash
cd chinchiro
npm install
npm test                 # 役判定・理論確率・手番進行・分析のユニットテスト
npm run emulators        # Firebaseエミュレータ（http://localhost:5000/?emu=1 で開く）
npm run e2e              # ブラウザで3人同時プレイ〜分析〜再読み込みまでの通しテスト
```

エミュレータで開いた画面では、開発者ツールのコンソールで `__cc.login('taro', 'たろう')` を実行するとログインできます。

## ファイル構成

```
chinchiro/
├── firebase.json / .firebaserc   … 公開先・エミュレータの設定
├── firestore.rules               … マルチカウンター＋チンチロのルール（両方入り）
├── public/
│   ├── index.html / style.css    … 画面（マルチカウンターと同じデザインの土台）
│   └── js/
│       ├── app.js       … ログイン・ルーム・同期・プレイ画面・シート
│       ├── game.js      … 手番・周・スキップ・休憩の進行（トランザクション内で使う純粋関数）
│       ├── rules.js     … 役判定・強さ・理論確率
│       ├── analysis.js  … 期間フィルター・集計・統計検定・ランキング
│       ├── stats.js     … 分析シート
│       ├── ui.js        … 色・サイコロ・役ラベルなどの部品
│       └── config.js    … Firebaseの接続設定
├── test/                … ユニットテスト
└── scripts/e2e.mjs      … ブラウザ通しテスト（エミュレータ使用）
```

## データの持ち方（Firestore）

- `chinchiroRooms/{ルームID}`：ルーム名・メンバー（名前・色・休憩）・順番・ルール・いまの周の進行・直前の周の結果
- `chinchiroRooms/{ルームID}/chunks/{番号}`：出目の記録を100件ずつ。新しい塊を作るときに11個前を消すので、常に最新1000〜1100件
- `chinchiroUsers/{uid}`：表示名・好きな色・最近のルーム
