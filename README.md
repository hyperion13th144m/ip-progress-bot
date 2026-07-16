# 整理番号 進捗検索 Google Chat Bot

Google Chatに整理番号を送ると、社内SQL Serverの3テーブル(`JuninProcess` / `ForeignProcess` /
`ForeignCProcess`)を横断検索して、その案件の作業履歴を時系列でまとめて返すBotです。

## 全体構成

```
Google Chat ユーザー
    │  「12345-JP」と送信
    ▼
Google Apps Script (Chat Bot / onMessage)
    │  HTTPS + x-api-key で問い合わせ
    ▼
社内APIサーバー (Node.js / api-server)  ※社内ネットワーク内で稼働
    │  SQL接続 (mssql)
    ▼
社内SQL Server (JuninProcess / ForeignProcess / ForeignCProcess)
```

DBが社内ネットワーク限定で外部から直接つなげないため、間に「社内APIサーバー」を1つ挟む構成に
しています。Apps Script単体の`JDBC`サービスは外部公開ホストにしか繋がらないため、社内DBに
直接は接続できません。

---

## 1. 社内APIサーバー (`api-server/`)

### セットアップ

```bash
cd api-server
npm install
cp .env.example .env
# .env を編集: DB_SERVER, DB_DATABASE, DB_USER, DB_PASSWORD, API_KEY など
npm start
```

- `GET /api/progress?seiriNum=12345-JP` を叩くと、該当整理番号の作業履歴をJSONで返します。
- `x-api-key` ヘッダーが `.env` の `API_KEY` と一致しないと401を返します。
- `sagyoTT`(時刻のみ有効・日付部分はUnixEpoch)と`sagyoDD`(日付のみ有効)を組み合わせて
  `actualDateTime` という実際の作業日時を算出し、これでソートしています。
- `GET /api/tanto-seiri-nums?tanto=山崎&months=3` : 担当者(tantosya)に紐づく整理番号セットを
  マスタテーブルから求め(国内は`JuninTable.SeiriNum`を`Tantosya`列で、外国は`ForeignTable`
  (`tantosya`列)と`ForeignCountry`をSeiriNumで結合した`F_Num`列で判定)、それぞれ
  `ChatHistory`上の最新の`ChatAt`/`Category`/`URL`を1件取得したうえで、最新`ChatAt`が直近
  `months`ヶ月以内のものだけを`records`配列(`{ SeiriNum, ChatAt, Category, URL }`)で
  返します。`months`は省略時1、
  12を超える値は12に丸められます。

### 動作確認

```bash
curl -H "x-api-key: <.envのAPI_KEY>" "http://localhost:3000/api/progress?seiriNum=12345-JP"
```

### 進捗レコード memo更新UI

`api-server` 起動後、ブラウザで `http://localhost:3000/`(または公開URL)を開くと、
対象テーブル(国内/PCT国際段階/外国(国別))と整理番号でレコードを検索し、一覧から対象レコードを
選ぶとmemoの現在値がテキスト欄に初期表示されるので、編集して更新できるUIが使えます。画面上部で
APIキー(`.env`の`API_KEY`と同じ値)を入力する必要があります。

対象テーブルは `JuninProcess`(国内) / `ForeignProcess`(PCT国際段階) / `ForeignCProcess`(外国(国別))
の3つで、APIには `table` パラメータ(`junin` / `foreign` / `foreignc`)で指定します。

- `GET /api/records?table=junin&seiriNum=12345-JP` : 該当レコードの一覧(SeiriNum/sagyoDD/sagyoTT等)を返す
- `POST /api/records/memo` : `{ table, seiriNum, sagyoDD, sagyoTT, text }` を渡すと、
  `SeiriNum + sagyoDD + sagyoTT` で特定したレコードのmemoを`text`でそのまま上書きする(追記ではなく
  置き換え。対象テーブルへのINSERTは行わない)



### Dockerでの起動(推奨: cloudflared込み)

api-server と cloudflared(Cloudflare Tunnel)を `docker-compose` でまとめて起動できます。

```bash
cd api-server
cp .env.example .env   # DB接続情報・API_KEYを編集
cd ..
cp .env.example .env   # ルート直下。TUNNEL_TOKENを編集
docker compose up -d --build
```

- `TUNNEL_TOKEN` は Cloudflare Zero Trust ダッシュボード(Networks > Tunnels > Create a tunnel)
  で発行されるトークンです。
- トンネル作成後、Public Hostname の設定で **Service: `http://api-server:3000`** を指定してください
  (`api-server` は docker-compose内のサービス名なので、ポート開放やhosts編集は不要です)。
- ログ確認: `docker compose logs -f cloudflared`

### 社内サーバーをインターネットに公開する方法(いずれか)

社内ネットワーク内のサーバーを、外部からのApps Script呼び出しに対応させる必要があります。
ファイアウォールを直接開けたくない場合は以下がおすすめです。

1. **Cloudflare Tunnel(推奨・無料)**
   - 社内サーバーに `cloudflared` をインストールし、ポート開放なしで
     `https://xxxx.trycloudflare.com` のようなURLを払い出せます。
   - `cloudflared tunnel --url http://localhost:3000`
2. **社内プロキシ/リバースプロキシ + 固定IPでApps Script送信元を許可**
   - Google側の送信元IPは固定できないため、基本的にはAPI keyでの認証に頼ることになります。
3. **VPN経由でCloud Run/Cloud Functionsから社内DBに接続**(GCPをすでに使っている場合)
   - Serverless VPC Access + Cloud VPN/Interconnect で社内ネットワークに接続し、
     API自体をCloud Run上で動かす方法。構成はやや複雑になります。

いずれの方法でも **HTTPS + API_KEY必須** にし、`.env`のAPI_KEYは十分にランダムな値にしてください。

---

## 2. Google Chat Bot (`apps-script/`)

### デプロイ手順

#### 1. プロジェクト作成・コードのコピー

1. https://script.google.com で新規プロジェクトを作成する。
2. 歯車アイコン(プロジェクトの設定)→「**"appsscript.json" マニフェスト ファイルをエディタで
   表示する**」にチェックを入れる(チェックしないと `appsscript.json` がファイル一覧に出てこず、
   「ファイルを追加」で作ると `appsscript.json.gs` という別物になってしまうので注意)。
3. `Code.gs` と `appsscript.json` の内容をこのリポジトリのものと同じにする(コピー&ペースト、
   または `clasp` でpush)。

#### 2. GCPプロジェクトを標準プロジェクトに切り替える

Apps Scriptプロジェクトは作成時、自動生成された「**GCPデフォルト**」プロジェクトに紐づいています。
このデフォルトプロジェクトはOAuth同意画面の編集ができないため、標準のGCPプロジェクトに切り替える
必要があります。

1. [Google Cloud Console](https://console.cloud.google.com/) で新しいプロジェクトを作成する。
2. 作成したプロジェクトの**プロジェクト番号**(数字のみ)を控える。
3. スクリプトエディタの歯車アイコン(プロジェクトの設定)→「**GCPプロジェクトを変更**」→
   手順2のプロジェクト番号を入力して切り替える。

#### 3. GCPプロジェクト側の設定

切り替えた標準プロジェクトで、以下を設定する。

1. 「APIs & Services」→「Library」で **Google Chat API** を検索して有効化する。
2. `setConfig()` を手動実行する際に権限承認が必要になるが、`appsscript.json` の
   `oauthScopes` は `script.external_request` / `script.scriptapp` の2つで足りる
   (このBotは `onMessage` の中で自前APIを`UrlFetchApp`で呼ぶだけで、Chat REST APIを
   直接呼んでいないため)。**`chat.bot` のような制限付きスコープは追加不要**。
   むしろ`chat.bot`はOAuth同意画面に手動追加しようとしても
   「無効なため追加されませんでした」となり追加できないので、マニフェストには入れないこと。

#### 4. デプロイ

1. 「デプロイ」→「新しいデプロイ」→ 種類の選択(歯車アイコン)で **「アドオン」** を選ぶ
   (「ウェブアプリ」「実行可能API」「ライブラリ」ではない点に注意。Google Chatとの連携は
   アドオンのデプロイIDを使う仕組みになっている)。
2. デプロイ後に表示される**デプロイID**をコピーしておく。

#### 5. 初回の認証・スクリプトプロパティ設定

1. スクリプトエディタ上部の「実行する関数を選択」プルダウンで `setConfig` を選ぶ。
   - **末尾に`_`が付く関数名(例: `setConfig_`)はこのプルダウンに表示されない**ので、
     手動実行したい関数の名前には`_`を付けないこと。
2. `setConfig` 内の `API_BASE_URL`(社内APIサーバーの公開URL。上記のcloudflaredで発行された
   URL)と `API_KEY`(`api-server/.env` の `API_KEY` と同じ値)を書き換えてから実行する。
3. 「承認が必要です」ダイアログが出たら、アカウントを選択→「このアプリはGoogleで確認されて
   いません」の警告が出る場合は「詳細」→「(プロジェクト名)に移動(安全ではないページ)」→
   要求されたスコープを確認して「許可」。
4. 実行に成功したら、`API_BASE_URL` / `API_KEY` の値は元のプレースホルダーに戻して保存してよい
   (値はスクリプトプロパティ側に保存済みなのでコードに残す必要はない)。

#### 6. Google Chat APIの構成

同じGCPプロジェクトで「APIs & Services」→「**Google Chat API**」→「構成」タブを開き、以下を設定する。

- アプリ名・[アイコン](apps-script/assets/chat-bot-icon-256.png)(256×256px)・説明
- 機能: 「ダイレクトメッセージを受信する」「スペースに参加する」等、必要な項目にチェック
- 接続設定: **Apps Script プロジェクト** を選び、手順4でコピーした**デプロイID**を入力
- トリガー機能: `onMessage` / `onAddToSpace` / `onRemoveFromSpace` の関数名を入力
  (`onAppCommand` はスラッシュコマンドを使う場合のみ必要。使わないので空欄でよい)
- **App status**: 「LIVE - available to users」にする(「Draft」のままだとChat側の検索に
  一切出てこない)
- 公開範囲(Visibility): 検証する自分のアカウントが含まれているか確認。組織内で使うなら
  「ドメイン内の全員が検出してインストール可能」が確実
- 保存後、反映まで数分〜数十分かかることがある

#### 7. Google Chatに追加する

1. [chat.google.com](https://chat.google.com) →「+ チャットを開始」→「アプリ」→ 設定したアプリ名
   で検索して追加(DMまたは任意のスペースに追加)
2. 整理番号(例: `12345-JP`)を送信して動作確認する

#### コードを変更したときの再デプロイ

`Code.gs` / `appsscript.json` を変更したら、保存するだけではChat側に反映されない。
「デプロイ」→「デプロイを管理」→ 対象デプロイの鉛筆(編集)アイコン→バージョンで
**「新バージョン」を選択**してから「デプロイ」を押す必要がある(既存バージョンのままだと
変更前のコードのまま動き続ける)。

#### レスポンス形式に関する注意

このBotはAdd-on形式でデプロイしているため、`onMessage` / `onAddToSpace` の返り値は
単純な `{ text: "..." }` ではなく、`hostAppDataAction.chatDataAction.createMessageAction.message`
でラップする必要がある(`Code.gs` の `textResponse_()` がこれを行っている)。また受信イベントの
本文は `event.message.text` ではなく `event.chat.messagePayload.message.text` に格納されている。

### 使い方

Botに整理番号だけを送信します。

```
12345-JP
```

返信例:

```
整理番号: 12345-JP  (該当 8 件)

【国内】 (5件)
・2024-06-05 14:20  拒絶理由通知受領  [担当: 田中]
    メモ: 応答期限は現地代理人に確認済み
・2024-03-05 14:20  受任処理  [担当: 田中]
...

【PCT国際段階】 (3件)
・2023-11-02 09:10  国際調査報告受領  [担当: 佐藤]
...

【出願手続履歴】 (4件)
・2023-05-10  出願

【チャット履歴】 (2件)
・2024-06-04 10:05　原稿送付　<https://chat.google.com/room/...|リンク>
・2024-06-05 14:10　中間対応　<https://chat.google.com/room/...|リンク>
```

#### 担当者別 整理番号一覧

`#担当者名`(先頭は半角#・全角＃のどちらでも可)の形式でBotに送信すると、担当者(tantosya)に
紐づく整理番号(国内は`JuninTable`、外国は`ForeignTable`+`ForeignCountry`から取得)のうち、
`ChatHistory`の最新`ChatAt`が直近1ヶ月以内のものだけを一覧表示します。各整理番号の行には、
その整理番号の最新の`ChatAt`/`Category`/`URL`を表示します
(社内APIの`GET /api/tanto-seiri-nums?tanto=...`を使用)。

`#担当者名.N`(末尾に`.数字`)を付けると、遡る月数をN ヶ月に変更できます
(例: `#山崎.3` で直近3ヶ月)。Nは1〜12の範囲に丸められ(12超は12、ドット以降が数字で
なければ1ヶ月扱い)、省略時は1ヶ月です。

```
#山崎
＃山崎.3
```

返信例:

```
担当: 山崎  (直近1ヶ月・該当 3 件)
・E012026015     2026-02-23 10:23  原稿送付   リンク
・I092022001     2026-02-24 10:23  出願依頼   リンク
・FP2023001JP    2026-03-01 09:05  中間対応   リンク
```

---

## 3. 整理番号ごとのチャット履歴自動記録(スペース監視ポーリング)

事務員が「整理番号 + 要件(フリーフォーマット)」を投稿するスペースを対象に、5分おきの
ポーリングで新着メッセージを取得し、整理番号を検出したら `ChatHistory` テーブルに
`SeiriNum` / `ChatAt`(メッセージ投稿日時) / `Category`(下記ルールで自動判定) / `URL`(メッセージへの
リンク)を自動追加します。1メッセージに複数の整理番号が含まれる場合は、重複を除いた
**全ての整理番号**に対して同じ内容(ChatAt/URL/Category)のレコードを追加します。
`onMessage`(Botへの直接送信・メンション)とは独立した仕組みで、`apps-script/Code.gs` の
`pollSeiriNumMessages` が本体です。

過去は `JuninProcess`等の`memo`列にチャットURLを追記していましたが、現在は行いません
(チャットURL・カテゴリは全て`ChatHistory`に集約しています)。

### 整理番号の抽出パターン

| テーブル | 整理番号パターン |
|---|---|
| 国内 (`junin`) | `^[A-Z]\d{9}$` |
| PCT国際段階 (`foreign`) | `^FP\d+PCT$` |
| 外国(国別) (`foreignc`) | `^FP\d+(PCT)?[A-Z]{2}(-DIV)?$`(`PCT`部分が無いこともある。`-DIV`は分割出願案件に付くことがある) |

これらのパターンは整理番号の**抽出**にのみ使う(=`ChatHistory`にテーブル種別は保存しない)。
実装は `apps-script/Code.gs` の `SEIRI_NUM_PATTERNS` / `extractAllSeiriNums_`。

### カテゴリ判定ルール

`ChatHistory.Category` は、メッセージ本文に含まれるキーワードから `apps-script/Code.gs` の
`CATEGORY_RULES`(`classifyCategory_` 関数)で自動判定しています。**上から順に判定し、最初に
マッチしたものを採用**します(どれにもマッチしなければ「その他」)。

#### 手動指定(最優先)

行頭が `#`(半角)で始まる行があれば、キーワード判定より優先してその行末までを
そのままカテゴリとして採用します(`CATEGORY_OVERRIDE_LINE_RE`)。例:

```
X022099001 メールがありました。ご確認ください。
#原稿確認依頼
```

→ カテゴリは「原稿確認依頼」になる(下表のキーワード判定は行われない)。前後の空白は
トリムし、50文字を超える場合は切り詰めます(`Category`列が`nvarchar(50)`のため)。

- 行頭`#`の行が複数ある場合は、**最初(最も上)の行のみ**を採用します
  (`CATEGORY_OVERRIDE_LINE_RE`に`g`フラグを付けていないため、`exec()`は常に先頭から
  検索して最初の1件だけを返す)。
- 1行の中に`#`が複数ある場合(例: `#abc #def`)は区切らず、行末までまるごと
  (`"abc #def"`)が1つのカテゴリになります。

半角`#`を選んだ理由: 実データ(スレッド先頭メッセージ約45,545件)を調べたところ、行頭が
半角`#`の行は1件も無かった(全角`＃`は5件あり、「＃弊所は…」のような追伸的な文の先頭にも
使われていたため除外)。`+`/`＋`も候補にしたが、`+81`のような電話番号の行頭と衝突する
実例があったため採用しなかった。

#### キーワード判定

このルールは実際のGoogle Chatエクスポート(スレッド先頭メッセージ 約45,545件)を解析して
作成したものです。ヒット件数は解析当時(2026年7月)の参考値なので、実際の運用でズレを感じたら
下表とコードを見比べて調整してください。

| 優先順位 | カテゴリ | 判定キーワード(正規表現) | 解析時のヒット件数 |
|---|---|---|---|
| 1 | 受任依頼 | `受任` | 620 |
| 2 | 年金納付 | `年金.{0,5}納付` | 113 |
| 3 | 審査請求 | `審査請求` | 863 |
| 4 | 早期審査 | `早期審査` | 440 |
| 5 | 分割出願 | `分割出願` | 407 |
| 6 | 原稿送付 | `(送付\|送って).{0,10}(原稿\|第[0-9０-９]+稿)` \| `(原稿\|第[0-9０-９]+稿).{0,10}(送付\|送って)` | 1,111(※1) |
| 7 | 原稿チェック依頼 | `原稿.{0,10}(チェック\|確認)` | 205 |
| 8 | 意見書・補正書対応 | `(意見書\|補正書).{0,10}(提出\|チェック\|送付\|送って\|確認\|作成\|依頼)` | 2,096 |
| 9 | 中間対応 | `(コメント\|見解書\|拒絶理由通知\|OA\|ＯＡ\|現地指示\|現地代理人).{0,10}(チェック\|送付\|送って\|作成\|依頼)` | 4,286 |
| 10 | 打合せ | `(打合せ\|打ち合わせ).{0,10}(資料\|依頼)` | 531(※2) |
| 11 | 出願手続 | `出願手続` | 146 |
| 12 | 請求書・費用 | `請求書` \| `見積` \| `入金` | 1,169 |
| 13 | 催促・リマインド | `（再掲）` \| `再送` \| `リマインド` \| `【要ご返信】` \| `進捗伺い` | 206 |
| — | その他 | (いずれにも該当しない) | 33,614(約74%) |

※1: 原稿送付は初回解析後、「送って」「第N稿」表記も拾えるよう正規表現を改訂した(2026年7月)。
表のヒット件数は改訂前(初回解析時)の値のまま。

※2: 打合せは元々「打合せ資料」(326件)と「打合せ依頼」(打合せ資料と重複しない分173件)の
2カテゴリだったものを1つに統合(2026年7月)。

キーワード・カテゴリを追加/修正するときは `apps-script/Code.gs` の `CATEGORY_RULES` 配列を
編集してください。判定は先頭から順に行われる(最初のマッチが勝つ)ので、より具体的なパターンほど
上に置くこと。編集後はApps Script側の再デプロイが必要です(下記「コードを変更したときの
再デプロイ」を参照)。

参考: 「催促」(客→事務員→弁理士)と「リマインド」(事務員→弁理士)は、実データ上
「（再掲）」「再送」等の同じ言い回しが使われており本文だけでは区別できなかったため、
1つの「催促・リマインド」カテゴリに統合しています。

### セットアップ(いずれも1度だけ手動実行)

1. `appsscript.json` に `chat.messages.readonly` スコープを追加済みなので、再デプロイ後に
   スクリプトエディタで `setMonitorConfig` を選んで実行する前に、関数内のスペースresource name
   (例: `spaces/AAAAxxxxxxx`。複数ならカンマ区切り)を書き換える。スペースIDは
   `https://mail.google.com/chat/u/0/#chat/space/AAAAxxxxxxx` のようなURLから確認できる。
2. `setMonitorConfig` を実行する。
3. `setupPollingTrigger` を実行し、5分おきの時間主導型トリガーを作成する。
4. 初回実行時、`chat.messages.readonly` の承認ダイアログが出る(承認したアカウントの権限で
   メッセージ一覧を取得するため、そのアカウントが監視対象スペースのメンバーである必要がある)。

### 注意点

- **メッセージURLの組み立て**: Google Chat APIの`Message`リソースには公式なpermalinkフィールドが
  存在しないため、`buildMessageUrl_()` はメッセージのresource name
  (`spaces/{space}/messages/{threadId}.{messageId}`)を`https://chat.google.com/room/{space}/{threadId}/{messageId}`
  に変換して組み立てている(実機でChat UIの「リンクをコピー」結果と一致することを確認済み。
  UI側のURLに付く`?cls=…`はトラッキング用パラメータで無くてもアクセス可能)。
- 整理番号のパターンにマッチしても`JuninProcess`/`ForeignProcess`/`ForeignCProcess`のいずれにも
  そのSeiriNumが存在しない場合(誤字等)は追加されず、Apps Scriptの実行ログにエラーが
  記録されるだけです(スペースへの通知は行いません)。
- Botの発言(`sender.type === 'BOT'`)はスキャン対象から除外しています。
- スレッドの子メッセージ(返信、`threadReply === true`)は対象外です。各スレッドの
  先頭メッセージのみを監視します。
- 追加前に同じ整理番号+同じチャットURLの組み合わせが`ChatHistory`に既に登録されていないか
  確認する冪等性チェックが入っているため、トリガーの多重実行やエラー後の再ポーリングで同じメッセージが
  再取得されても二重登録はされません。`pollSeiriNumMessages`のトリガーが複数
  登録されていないかは、Apps Scriptエディタの「トリガー」ページで定期的に確認してください
  (`setupPollingTrigger()`は実行するたびに同名トリガーを削除してから1つだけ作り直します)。

### 将来の選択肢: オンデマンド方式への移行検討

現状は5分おきのポーリングで新着メッセージを`ChatHistory`に同期する**事前同期方式**。
将来的には、Botが整理番号を受け取った時点でその場で`spaces.messages.list`
(`listMessagesSince_`のロジックを流用)を叩いて該当整理番号を含むメッセージを検索・整形して
返す**オンデマンド方式**への移行も検討しうる。それぞれのメリットは以下の通り(2026年7月時点の
検討メモ。移行を決めたわけではない)。

| | 事前同期方式(現状) | オンデマンド方式 |
|---|---|---|
| メリット | クエリ時のレイテンシが低い / 過去メッセージを都度スキャンしなくて済む / 自前インデックスなので検索精度をコントロールしやすい | 二重管理・同期漏れのリスクがない / 常時ポーリングのApps Scriptトリガーが落ちても機能に影響しない / 実装がシンプルになる |

## 4. 注意点・今後の拡張候補

- 現状は `GET /api/progress` に整理番号を渡すだけのシンプルなAPIです。クライアント名や
  案件種別(特許/意匠/商標)で絞り込みたい場合は、別途そのマスタ情報がどのテーブルにあるか
  教えてもらえれば、検索条件を拡張できます。
- 1カテゴリあたり最大15件まで表示(Chatメッセージが長くなりすぎないように)。それ以上は
  「他n件(省略)」と表示されます。上限を変えたい場合は `Code.gs` の
  `MAX_RECORDS_PER_CATEGORY` を編集してください。
- 監査ログが必要であれば、`api-server/server.js` の `/api/progress` に
  アクセスログ(誰がいつどの整理番号を検索したか)を追加することも可能です。
  (Google Chatの`event.user`情報をApps Script側でAPIに渡すよう拡張すれば実現できます)
