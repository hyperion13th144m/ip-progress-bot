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
```

---

## 3. 注意点・今後の拡張候補

- 現状は `GET /api/progress` に整理番号を渡すだけのシンプルなAPIです。クライアント名や
  案件種別(特許/意匠/商標)で絞り込みたい場合は、別途そのマスタ情報がどのテーブルにあるか
  教えてもらえれば、検索条件を拡張できます。
- 1カテゴリあたり最大15件まで表示(Chatメッセージが長くなりすぎないように)。それ以上は
  「他n件(省略)」と表示されます。上限を変えたい場合は `Code.gs` の
  `MAX_RECORDS_PER_CATEGORY` を編集してください。
- 監査ログが必要であれば、`api-server/server.js` の `/api/progress` に
  アクセスログ(誰がいつどの整理番号を検索したか)を追加することも可能です。
  (Google Chatの`event.user`情報をApps Script側でAPIに渡すよう拡張すれば実現できます)
