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
      '国内・PCT国際段階・外国(国別)の作業履歴をまとめて表示します。\n' +
      '「#担当者名」(例: #山崎。全角＃も可)を送信すると、その担当者に紐づく整理番号のうち\n' +
      '直近1ヶ月以内にチャット履歴があるものの一覧を表示します。\n' +
      '「#担当者名.N」(例: #山崎.3)で、直近Nヶ月に遡って検索できます(最大12)。'
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

    const tantoCommand = extractTantoCommand_(message.argumentText || rawText || '');
    if (tantoCommand) {
      const data = fetchTantoSeiriNums_(tantoCommand.tanto, tantoCommand.months);
      return textResponse_(formatTantoMessage_(tantoCommand.tanto, tantoCommand.months, data.records));
    }

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

    return textResponse_(formatProgressMessage_(seiriNum, data.records, data.filing, data.chatHistory));
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

// 「#担当者名.N」の月数指定の上限。Nがこれを超えても12ヶ月前に丸める。
const TANTO_COMMAND_MAX_MONTHS = 12;

/**
 * メッセージが「#担当者名」または「#担当者名.N」(N=遡る月数)形式の
 * コマンドかどうかを判定する。先頭の#は半角(#)・全角(＃)のどちらも受け付ける。
 * マッチすれば { tanto, months } を、マッチしなければnullを返す。
 * ドットの後が数字でない場合は、ドット部分ごと担当者名の一部とみなし、
 * monthsはデフォルトの1ヶ月とする。
 */
function extractTantoCommand_(text) {
  const m = /^\s*[#＃](\S+)\s*$/.exec(text || '');
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;

  const monthMatch = /^(.+)\.(\d+)$/.exec(raw);
  if (!monthMatch) {
    return { tanto: raw, months: 1 };
  }

  const months = Math.min(parseInt(monthMatch[2], 10), TANTO_COMMAND_MAX_MONTHS);
  return { tanto: monthMatch[1], months };
}

/**
 * 社内APIを呼び出して、指定担当者に紐づく整理番号一覧
 * (最新のChatAtが直近monthsヶ月以内のものに限る)を取得する
 */
function fetchTantoSeiriNums_(tanto, months) {
  const config = getConfig_();
  const url =
    config.API_BASE_URL.replace(/\/$/, '') +
    '/api/tanto-seiri-nums?tanto=' +
    encodeURIComponent(tanto) +
    '&months=' +
    encodeURIComponent(months);

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

/**
 * 担当者別整理番号一覧をChatメッセージ用のテキストに整形する。
 * 各整理番号について、最新のChatAt・Category・URL(リンク)を1行で表示する。
 */
function formatTantoMessage_(tanto, months, records) {
  if (!records || records.length === 0) {
    return `担当: ${tanto}(直近${months}ヶ月)\nチャット履歴のある整理番号は見つかりませんでした。`;
  }

  const lines = [`*担当: ${tanto}*  (直近${months}ヶ月・該当 ${records.length} 件)`];
  records.forEach((r) => {
    const dt = formatDateTime_(r.ChatAt);
    lines.push(`・${r.SeiriNum}　${dt}　${r.Category}　<${r.URL}|リンク>`);
  });
  return lines.join('\n');
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
function formatProgressMessage_(seiriNum, records, filing, chatHistory) {
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
      filing.procedures
        .slice()
        .sort((a, b) => new Date(b.procedureDate) - new Date(a.procedureDate))
        .forEach((p) => {
          lines.push(`・${p.procedureDate}  ${p.procedure}`);
        });
    }
  }

  if (chatHistory) {
    lines.push('');
    lines.push(`*【チャット履歴】* (${chatHistory.length}件)`);
    if (chatHistory.length === 0) {
      lines.push('・(履歴なし)');
    } else {
      chatHistory
        .slice()
        .sort((a, b) => new Date(b.ChatAt) - new Date(a.ChatAt))
        .forEach((h) => {
          const dt = formatDateTime_(h.ChatAt);
          lines.push(`・${dt}　${h.Category}　<${h.URL}|リンク>`);
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
// ものを採用する。FP\d+PCT は FP\d+(PCT)?[A-Z]{2} の前方一致になり得るため、
// 具体的な(長い)パターンを先に判定する。
const SEIRI_NUM_PATTERNS = [
  { table: 'foreignc', re: /(?<![A-Za-z0-9])FP\d+(PCT)?[A-Z]{2}(-DIV)?(?![A-Za-z0-9])/g },
  { table: 'foreign', re: /(?<![A-Za-z0-9])FP\d+PCT(?![A-Za-z0-9])/g },
  { table: 'junin', re: /(?<![A-Za-z0-9])[A-Z]\d{9}(?![A-Za-z0-9])/g },
];

// メッセージ本文からChatHistory.Categoryを判定するルール。
// 上から順に判定し、最初にマッチしたものを採用する(どれにもマッチしなければ'その他')。
// 実際のチャット履歴(約4.5万件)を解析して作成した。
const CATEGORY_RULES = [
  { category: '受任依頼', re: /受任/ },
  { category: '年金納付', re: /年金.{0,5}納付/ },
  { category: '審査請求', re: /審査請求/ },
  { category: '早期審査', re: /早期審査/ },
  { category: '分割出願', re: /分割出願/ },
  { category: '原稿送付', re: /(送付|送って).{0,10}(原稿|第[0-9０-９]+稿)|(原稿|第[0-9０-９]+稿).{0,10}(送付|送って)/ },
  { category: '原稿チェック依頼', re: /原稿.{0,10}(チェック|確認)/ },
  { category: '意見書・補正書対応', re: /(意見書|補正書).{0,10}(提出|チェック|送付|送って|確認|作成|依頼|お願い)/ },
  { category: '中間対応', re: /(対処方針|コメント|見解書|拒絶理由通知|OA|ＯＡ|応答指示|現地指示|現地代理人).{0,10}(チェック|送付|送って|作成|依頼|回答|受領|受けました|お願い)/ },
  { category: '打合せ', re: /(打合せ|打ち合わせ).{0,10}(資料|依頼)/ },
  { category: '出願手続', re: /出願.{0,10}(手続|依頼)/ },
  { category: '請求書・費用', re: /請求書|見積|入金/ },
  { category: '催促・リマインド', re: /（再掲）|\(再掲\)|再送|リマインド|【要ご返信】|進捗伺い/ },
  // 2026-07 追加: var/messages.json の「その他」分類を分析し、頻出だが上記ルールに
  // 引っかからなかったパターンを追加(詳細は分析結果参照)。既存ルールより後ろに置き、
  // 既存の分類結果を上書きしないようにしている。
  { category: '特許査定受領', re: /特許査定/ },
  { category: '提出依頼', re: /提出依頼/ },
  { category: '回答受領', re: /(様.{0,15}(届きました|回答があり|回答を受け|回答ありました)|クライアント回答)/ },
  { category: '原稿チェック依頼', re: /(出願|最終).{0,10}(チェック|確認)/ },
  // 2026-07 追加(2回目): 実際に残った「その他」を人手でサンプルレビューし、
  // 付与された候補カテゴリ名をもとに追加。同上の理由で既存ルールより後ろに置く。
  { category: '合意書・宿題', re: /合意書/ },
  { category: '国内移行', re: /移行期限|移行国/ },
  { category: '審査官応答', re: /審査官/ },
  { category: '請求書・費用', re: /当所費用|費用をご指示/ },
  { category: '打合せ', re: /(打合せ|打ち合わせ).{0,10}(日程|リンク)/ },
  { category: '催促・リマインド', re: /進捗/ },
  { category: '修正・検討の依頼', re: /(修正|検討|差し替え|差替).{0,10}(お願い|依頼|届き|送付|指示|きました)/ },
];

// 行頭が「#」(半角)で始まる行は、その行末までをカテゴリとして明示指定できる
// (例: 「#原稿確認依頼」だけの行があれば、カテゴリは「原稿確認依頼」になる)。
// CATEGORY_RULESのキーワード判定より優先する。
// 半角#のみを対象とする(実チャットデータ約4.5万件を解析した結果、行頭の半角#は
// 一件も無かった一方、全角＃は「＃弊所は...」のような追伸的な文の先頭にも
// 使われており誤判定の恐れがあったため)。
const CATEGORY_OVERRIDE_LINE_RE = /^#(.+)$/m;

// CATEGORY_RULESは本文全体ではなく先頭100文字のみに適用する
// (var/messages.jsonの分析・ルール作成もこの前提で行っている)。
const CATEGORY_RULES_HEAD_LENGTH = 100;

function classifyCategory_(text) {
  const t = text || '';

  // #override行は本文全体を対象に判定する(先頭100文字に絞らない)
  const overrideMatch = CATEGORY_OVERRIDE_LINE_RE.exec(t);
  if (overrideMatch) {
    const category = overrideMatch[1].trim();
    if (category) return category.slice(0, 50); // Category列はnvarchar(50)
  }

  const head = t.slice(0, CATEGORY_RULES_HEAD_LENGTH);
  const hit = CATEGORY_RULES.find((rule) => rule.re.test(head));
  return hit ? hit.category : 'その他';
}

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

    const seiriNums = extractAllSeiriNums_(message.text || '');
    if (seiriNums.length === 0) return;

    const chatUrl = buildMessageUrl_(message.name);
    const category = classifyCategory_(message.text || '');

    // 1メッセージに複数の整理番号が含まれる場合、全ての整理番号に対して
    // 同じ内容(ChatAt/URL/Category)の作業履歴を追加する。
    seiriNums.forEach((seiriNum) => {
      try {
        // トリガーの多重実行や、バッチ途中のエラーで同じメッセージ範囲が
        // 再ポーリングされた場合でも二重登録しないよう、追加前に同じチャットURLの
        // レコードが既に存在しないか確認する。
        if (chatHistoryAlreadyAdded_(seiriNum, chatUrl)) {
          return;
        }
        addChatHistory_(seiriNum, category, chatUrl, createTime);
      } catch (err) {
        console.error(`ChatHistory自動追加失敗 (${seiriNum}):`, err);
      }
    });
  });

  // Chat APIのcreateTimeはミリ秒未満(マイクロ秒)まで精度を持つが、
  // JSのDateはミリ秒に切り捨てられる。切り捨てた値をそのままsinceとして
  // 保存すると、次回ポーリングのフィルタ(createTime > since)に対して
  // 元のメッセージの実際のcreateTime(端数分だけ大きい)が一致してしまい、
  // 最後に処理した同じメッセージが再取得されてしまう。1ms加算して除外する。
  props.setProperty(lastPollKey, new Date(latestCreateTime.getTime() + 1).toISOString());
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
 * フリーフォーマットの本文に含まれる整理番号を全て抜き出す。
 * 同じ整理番号が複数回登場する場合は重複排除するため、集合(Set)にまとめてから返す。
 */
function extractAllSeiriNums_(text) {
  if (!text) return [];

  const found = new Set();
  SEIRI_NUM_PATTERNS.forEach((p) => {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      found.add(m[0]);
    }
  });

  return Array.from(found);
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
 * 当該整理番号のChatHistoryに、同じチャットURLを持つレコードが既にあるか
 * 確認する(自動追加の冪等性チェック)。
 */
function chatHistoryAlreadyAdded_(seiriNum, chatUrl) {
  const config = getConfig_();
  const url =
    config.API_BASE_URL.replace(/\/$/, '') +
    '/api/chat-history?seiriNum=' + encodeURIComponent(seiriNum);

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-api-key': config.API_KEY },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`重複チェック失敗 (status ${status}): ${response.getContentText()}`);
  }

  const data = JSON.parse(response.getContentText());
  return (data.records || []).some((r) => r.URL === chatUrl);
}

/**
 * 社内APIの POST /api/chat-history を呼び出し、ChatHistoryにChat URLを1件自動追加する。
 */
function addChatHistory_(seiriNum, category, chatUrl, chatAt) {
  const config = getConfig_();
  const url = config.API_BASE_URL.replace(/\/$/, '') + '/api/chat-history';

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': config.API_KEY },
    payload: JSON.stringify({
      seiriNum,
      category,
      url: chatUrl,
      chatAt: chatAt.toISOString(),
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 201) {
    throw new Error(`追加失敗 (status ${status}): ${response.getContentText()}`);
  }
}
