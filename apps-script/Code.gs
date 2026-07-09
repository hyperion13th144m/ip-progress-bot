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
