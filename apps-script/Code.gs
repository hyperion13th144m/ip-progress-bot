/**
 * 整理番号 進捗検索 Google Chat Bot
 * -----------------------------------------------------------------
 * ユーザーがChatに整理番号を送ると、社内API(server.js)を呼び出して
 * JuninProcess / ForeignProcess / ForeignCProcess の作業履歴をまとめて返す。
 *
 * デプロイ手順の詳細はプロジェクトルートの README.md を参照。
 * -----------------------------------------------------------------
 */

// ---- 設定 -------------------------------------------------------------
// API_BASE_URL / API_KEY はスクリプトプロパティに保存する(コードに直書きしない)。
// 初回のみ setConfig() を編集して1回だけ実行してください。
function setConfig() {
  PropertiesService.getScriptProperties().setProperties({
    API_BASE_URL: 'https://your-exposed-endpoint.example.com', // 社内APIの公開URL(末尾スラッシュなし)
    API_KEY: 'change-me-to-a-random-secret', // server.js の .env と同じ値
  });
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  if (!props.API_BASE_URL || !props.API_KEY) {
    throw new Error(
      'スクリプトプロパティ API_BASE_URL / API_KEY が未設定です。setConfig() を編集して実行してください。'
    );
  }
  return props;
}

// ---- Chat app トリガー ---------------------------------------------------

/**
 * Botがスペースに追加された時
 */
function onAddedToSpace(event) {
  return textResponse_(
    '整理番号 検索Botです。整理番号を送信してください(例: 12345-JP)。\n' +
      '国内・PCT国際段階・外国(国別)の作業履歴をまとめて表示します。'
  );
}

/**
 * Botがスペースから削除された時
 */
function onRemovedFromSpace(event) {
  console.log('Bot removed from space');
}

/**
 * メッセージ受信時のメインハンドラ
 */
function onMessage(event) {
  try {
    const message =
      (event.chat && event.chat.messagePayload && event.chat.messagePayload.message) || {};
    const rawText = message.text || '';
    const seiriNum = extractSeiriNum_(rawText, message);

    if (!seiriNum) {
      return textResponse_(
        '整理番号が読み取れませんでした。整理番号だけを送信してください(例: 12345-JP)。'
      );
    }

    const data = fetchProgress_(seiriNum);

    if (data.count === 0) {
      return textResponse_(`整理番号「${seiriNum}」の作業履歴は見つかりませんでした。`);
    }

    return textResponse_(formatProgressMessage_(seiriNum, data.records, data.filing));
  } catch (err) {
    console.error(err);
    return textResponse_(`エラーが発生しました: ${err.message}`);
  }
}

/**
 * テキスト返信を Google Workspace Add-ons(Chat)が要求する
 * DataActions 形式にラップする。
 */
function textResponse_(text) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: { text },
        },
      },
    },
  };
}

// ---- ヘルパー関数 ---------------------------------------------------------

/**
 * メッセージ本文から整理番号を取り出す。
 * Botへのメンション部分(@Bot名)は message.argumentText に
 * メンション除去済みのテキストが入るので、まずそちらを優先して使う。
 */
function extractSeiriNum_(rawText, message) {
  const text = message.argumentText || rawText || '';
  // 前後の空白・「整理番号:」等のラベルを除去
  const cleaned = text
    .replace(/整理番号[:：]?/g, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > 20) return null; // SeiriNum は nvarchar(20)
  return cleaned;
}

/**
 * 社内APIを呼び出して進捗レコードを取得する
 */
function fetchProgress_(seiriNum) {
  const config = getConfig_();
  const url =
    config.API_BASE_URL.replace(/\/$/, '') +
    '/api/progress?seiriNum=' +
    encodeURIComponent(seiriNum);

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-api-key': config.API_KEY },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`API呼び出し失敗 (status ${status}): ${response.getContentText()}`);
  }

  return JSON.parse(response.getContentText());
}

// 表示順(この順番でグループ化して表示)
const CATEGORY_ORDER = ['国内', 'PCT国際段階', '外国(国別)'];
const MAX_RECORDS_PER_CATEGORY = 15;
// filing.yearType(3=昭和, 4=平成, 5=西暦)に対応する元号表記
const GENGO_LABEL = { 3: '昭', 4: '平', 5: '20' };

/**
 * 検索結果をChatメッセージ用のテキストに整形する。
 * カテゴリごとにグループ化し、各カテゴリ内は新しい順に表示する。
 */
function formatProgressMessage_(seiriNum, records, filing) {
  const byCategory = {};
  records.forEach((r) => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  const lines = [];
  lines.push(`*整理番号: ${seiriNum}*  (該当 ${records.length} 件)`);

  if (filing) {
    lines.push(formatFilingHeaderLine_(filing));
  }

  const categories = CATEGORY_ORDER.filter((c) => byCategory[c]).concat(
    Object.keys(byCategory).filter((c) => CATEGORY_ORDER.indexOf(c) === -1)
  );

  categories.forEach((category) => {
    const list = byCategory[category]
      .slice()
      .sort((a, b) => new Date(b.actualDateTime) - new Date(a.actualDateTime));

    lines.push('');
    lines.push(`*【${category}】* (${list.length}件)`);

    const shown = list.slice(0, MAX_RECORDS_PER_CATEGORY);
    shown.forEach((r) => {
      const dt = formatDateTime_(r.actualDateTime);
      let line = `・${dt}  ${r.sagyo || '(作業名未設定)'}`;
      if (r.tanto) line += `  [担当: ${r.tanto}]`;
      lines.push(line);
      if (r.memo) lines.push(`    メモ: ${linkifyUrls_(r.memo)}`);
      if (r.kigen) lines.push(`    期限: ${formatDateTime_(r.kigen)}`);
      if (r.sagyoKanryo) lines.push(`    完了: ${formatDateTime_(r.sagyoKanryo)}`);
    });

    if (list.length > MAX_RECORDS_PER_CATEGORY) {
      lines.push(`    …他 ${list.length - MAX_RECORDS_PER_CATEGORY} 件(省略)`);
    }
  });

  if (filing) {
    lines.push('');
    lines.push(`*【出願手続履歴】* (${filing.procedures.length}件)`);
    if (filing.procedures.length === 0) {
      lines.push('・(履歴なし)');
    } else {
      filing.procedures.forEach((p) => {
        lines.push(`・${p.procedureDate}  ${p.procedure}`);
      });
    }
  }

  return lines.join('\n');
}

/**
 * 「出願番号：」行を組み立てる。documentUrlがあればChatのリンク記法にする。
 */
function formatFilingHeaderLine_(filing) {
  const gengo = GENGO_LABEL[filing.yearType] || '';
  const label = `${filing.lawExpr}${gengo}${filing.filingYear}-${filing.filingSequence}`;
  const value = filing.documentUrl ? `<${filing.documentUrl}|${label}>` : label;
  return `出願番号：${value}`;
}

/**
 * テキスト中のURLを Chat のリンク記法 <URL|リンク> に置き換える。
 */
function linkifyUrls_(text) {
  return text.replace(/https?:\/\/[^\s。、,)\]}"']+/g, (url) => `<${url}|リンク>`);
}

function formatDateTime_(isoOrDateString) {
  if (!isoOrDateString) return '';
  const d = new Date(isoOrDateString);
  if (isNaN(d.getTime())) return String(isoOrDateString);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

// ---- 整理番号 自動追記(スペース監視ポーリング) -----------------------------
//
// 事務員が「整理番号 + 要件(フリーフォーマット)」を投稿するスペースを対象に、
// 5分おきのポーリングで新着メッセージから整理番号を検出し、該当テーブルに
// memo=そのメッセージのURL とする作業履歴を自動追加する。
//
// 事前準備(いずれも1度だけ手動実行):
//   1. setMonitorConfig() 内のスペースresource name(例: 'spaces/AAAAxxxxxxx',
//      複数ならカンマ区切り)を書き換えてから実行する。スペースIDはChatの
//      URL(https://mail.google.com/chat/u/0/#chat/space/AAAAxxxxxxx)などから
//      確認できる。
//   2. setupPollingTrigger() を実行し、5分おきの時間主導型トリガーを作成する。
//   3. 初回実行時、chat.messages.readonly スコープの承認ダイアログが出る。

function setMonitorConfig() {
  PropertiesService.getScriptProperties().setProperty(
    'MONITOR_SPACES',
    'spaces/your-space-id-here' // カンマ区切りで複数指定可
  );
}

function setupPollingTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'pollSeiriNumMessages')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pollSeiriNumMessages').timeBased().everyMinutes(5).create();
}

// テーブル判定パターン。1メッセージに複数の整理番号が含まれる場合は先頭に近い
// ものを採用する。FP\d+PCT は FP\d+PCT[A-Z]{2} の前方一致になり得るため、
// 具体的な(長い)パターンを先に判定する。
const SEIRI_NUM_PATTERNS = [
  { table: 'foreignc', re: /(?<![A-Za-z0-9])FP\d+PCT[A-Z]{2}(?![A-Za-z0-9])/g },
  { table: 'foreign', re: /(?<![A-Za-z0-9])FP\d+PCT(?![A-Za-z0-9])/g },
  { table: 'junin', re: /(?<![A-Za-z0-9])[A-Z]\d{9}(?![A-Za-z0-9])/g },
];

const AUTO_MEMO_SAGYO = '事務所メインより自動追加';
const AUTO_MEMO_TANTO = '自動追記';

/**
 * 時間主導型トリガーから呼ばれるエントリポイント。
 * MONITOR_SPACES に設定された各スペースをポーリングする。
 */
function pollSeiriNumMessages() {
  const props = PropertiesService.getScriptProperties();
  const spacesRaw = props.getProperty('MONITOR_SPACES');
  if (!spacesRaw) {
    console.log('MONITOR_SPACES未設定のためスキップ。setMonitorConfig()を編集して実行してください。');
    return;
  }

  spacesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((space) => {
      try {
        pollSpace_(space);
      } catch (err) {
        console.error(`${space} のポーリングでエラー:`, err);
      }
    });
}

/**
 * 1スペース分のポーリング処理。前回ポーリング以降の新着メッセージを取得し、
 * 整理番号を検出したメッセージがあれば自動追加する。
 */
function pollSpace_(space) {
  const props = PropertiesService.getScriptProperties();
  const lastPollKey = `LAST_POLL_${space}`;
  const lastPollIso = props.getProperty(lastPollKey);
  // 初回は過去10分から取得開始(5分間隔ポーリングの取りこぼし防止に余裕を持たせる)
  const since = lastPollIso ? new Date(lastPollIso) : new Date(Date.now() - 10 * 60 * 1000);

  const messages = listMessagesSince_(space, since);
  if (messages.length === 0) return;

  let latestCreateTime = since;
  messages.forEach((message) => {
    const createTime = new Date(message.createTime);
    if (createTime > latestCreateTime) latestCreateTime = createTime;

    if (message.sender && message.sender.type === 'BOT') return; // Bot自身の発言は無視
    if (message.threadReply) return; // スレッドの子メッセージ(返信)は対象外。先頭メッセージのみ処理する

    const found = extractFirstSeiriNum_(message.text || '');
    if (!found) return;

    const chatUrl = buildMessageUrl_(message.name);

    try {
      addAutoRecord_(found.table, found.seiriNum, chatUrl, AUTO_MEMO_TANTO);
    } catch (err) {
      console.error(`自動追加失敗 (${found.table}/${found.seiriNum}):`, err);
    }
  });

  props.setProperty(lastPollKey, latestCreateTime.toISOString());
}

/**
 * Chat REST API で指定スペースの createTime > since のメッセージを取得する。
 * スクリプトを承認したユーザーの権限(chat.messages.readonly)で呼び出されるため、
 * そのユーザーが対象スペースのメンバーである必要がある。
 */
function listMessagesSince_(space, since) {
  const filter = encodeURIComponent(`createTime > "${since.toISOString()}"`);
  const url =
    `https://chat.googleapis.com/v1/${space}/messages?filter=${filter}&orderBy=createTime%20asc&pageSize=100`;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Chat API messages.list失敗 (status ${status}): ${response.getContentText()}`);
  }

  const data = JSON.parse(response.getContentText());
  return data.messages || [];
}

/**
 * フリーフォーマットの本文から最初の整理番号を抜き出し、テーブルを判定する。
 */
function extractFirstSeiriNum_(text) {
  if (!text) return null;

  let best = null;
  SEIRI_NUM_PATTERNS.forEach((p) => {
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (m && (!best || m.index < best.index)) {
      best = { seiriNum: m[0], table: p.table, index: m.index };
    }
  });

  return best ? { seiriNum: best.seiriNum, table: best.table } : null;
}

/**
 * メッセージのresource name(spaces/{space}/messages/{threadId}.{messageId})から
 * ブラウザで開けるURLを組み立てる。
 * {message}部分は「{threadId}.{messageId}」の複合ID(スレッド先頭メッセージでは
 * threadId===messageId)になっており、Chat UIの「リンクをコピー」で得られるURLは
 * これを「.」区切りではなく「/」区切りのパスにした
 * https://chat.google.com/room/{space}/{threadId}/{messageId} という形式(実機で確認済み)。
 * 末尾の「?cls=…」はUI由来のトラッキング用パラメータで、無くてもアクセス可能。
 */
function buildMessageUrl_(messageName) {
  const parts = messageName.split('/'); // ['spaces', '{space}', 'messages', '{threadId}.{messageId}']
  const spaceId = parts[1];
  const messagePath = parts[3].replace(/\./g, '/');
  return `https://chat.google.com/room/${spaceId}/${messagePath}`;
}

/**
 * 社内APIの POST /api/records を呼び出し、作業履歴を1件自動追加する。
 */
function addAutoRecord_(table, seiriNum, memo, tanto) {
  const config = getConfig_();
  const url = config.API_BASE_URL.replace(/\/$/, '') + '/api/records';

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': config.API_KEY },
    payload: JSON.stringify({
      table,
      seiriNum,
      sagyo: AUTO_MEMO_SAGYO,
      tanto,
      memo,
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 201) {
    throw new Error(`追加失敗 (status ${status}): ${response.getContentText()}`);
  }
}
