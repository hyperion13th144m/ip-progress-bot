/**
 * 整理番号による進捗検索API
 * -----------------------------------------------------------------
 * JuninProcess(国内) / ForeignProcess(PCT国際段階) / ForeignCProcess(外国・国別)
 * の3テーブルを整理番号で検索し、作業履歴を時系列でまとめて返すAPI。
 *
 * 前提:
 *  - このサーバーは社内ネットワーク内(DBにアクセスできる場所)で動かす。
 *  - Google Apps Script(Chat Bot)からはインターネット経由で叩かれるため、
 *    外部公開する場合は必ず API_KEY による認証をかけること。
 *    (公開方法の例はプロジェクトルートの README.md を参照)
 *
 * 起動方法:
 *   npm install
 *   cp .env.example .env   # 値を編集
 *   npm start
 * -----------------------------------------------------------------
 */

// DB上のsagyoDD/sagyoTT/kigen/sagyoKanryoはタイムゾーン情報を持たない
// 日本時間(JST)の素朴な値。mssqlドライバのデフォルト(useUTC: true)だと
// これをUTCの値と取り違えてシリアライズしてしまい、Code.gs/UI側で
// Asia/Tokyo変換をかけると9時間ずれる。プロセスのタイムゾーンをJSTに固定した
// 上でuseUTC: falseにし、DBの素朴な値をJSTのローカル時刻として扱う。
process.env.TZ = 'Asia/Tokyo';

const path = require('path');
const express = require('express');
const morgan = require('morgan');
const sql = require('mssql');
require('dotenv').config();

const app = express();
app.use(morgan('combined'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- DB接続設定 -----------------------------------------------------
const dbConfig = {
  server: process.env.DB_SERVER,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true', // Azure SQL等は true, オンプレは環境に合わせる
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    useUTC: false, // DBの素朴な値をJST(上記TZ設定)のローカル時刻として読み書きする
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(dbConfig)
      .connect()
      .then((pool) => {
        console.log('DB接続プール作成完了');
        return pool;
      })
      .catch((err) => {
        poolPromise = null; // 失敗したら次回リトライできるようにする
        throw err;
      });
  }
  return poolPromise;
}

// ---- 認証ミドルウェア -------------------------------------------------
function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!process.env.API_KEY) {
    console.warn('警告: API_KEY が未設定です。認証なしで動作しています。');
    return next();
  }
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---- 3テーブルをUNIONして整理番号で検索するクエリ ------------------------
// sagyoDD: 作業日(日付部分が正しい)
// sagyoTT: 作業時刻(datetime型だが、日付部分は全レコードUnixEpoch=1970-01-01。時刻部分のみ有効)
// -> sagyoDDの日付 + sagyoTTの時刻 を文字列結合してキャストし、実際の作業日時を作る
const SEARCH_QUERY = `
SELECT
  SeiriNum,
  category,
  CAST(
    CONVERT(varchar(10), sagyoDD, 120) + ' ' + CONVERT(varchar(8), sagyoTT, 108)
    AS datetime
  ) AS actualDateTime,
  sagyo,
  tanto,
  memo,
  kigen,
  sagyoKanryo,
  folder
FROM (
  SELECT SeiriNum, sagyoDD, sagyoTT, sagyo, tanto, memo, kigen, sagyoKanryo, folder,
         N'国内' AS category
  FROM JuninProcess
  WHERE SeiriNum = @seiriNum

  UNION ALL

  SELECT SeiriNum, sagyoDD, sagyoTT, sagyo, tanto, memo, kigen, sagyoKanryo, folder,
         N'PCT国際段階' AS category
  FROM ForeignProcess
  WHERE SeiriNum = @seiriNum

  UNION ALL

  SELECT SeiriNum, sagyoDD, sagyoTT, sagyo, tanto, memo, kigen, sagyoKanryo, folder,
         N'外国(国別)' AS category
  FROM ForeignCProcess
  WHERE SeiriNum = @seiriNum
) AS combined
ORDER BY actualDateTime ASC;
`;

// ---- 整理番号 -> 出願番号 -> 対特許庁手続履歴(filing) -----------------------
// AppliNum(9桁数値)は ABBCCCCCC の形式:
//   A   : 元号種別 (3=昭和, 4=平成, 5=西暦)
//   BB  : 年 (Aが5の場合は西暦下2桁)
//   CCCCCC : 通し番号
// 整理番号がどの法律のテーブルにヒットするかで law(法律種別)を判定する。
// 同じ整理番号が複数の法律テーブルにヒットすることは想定しないが、
// 念のため 1(特許) > 2(実案) > 3(意匠) > 4(商標) の優先順で1件のみ採用する。
const LAW_EXPR = { 1: '特許', 2: '実案', 3: '意匠', 4: '商標' };
const TYUKAN_TABLE_BY_LAW = {
  1: 'TyukanForTokkyo',
  2: 'TyukanForJituyo',
  3: 'TyukanForDesign',
  4: 'TyukanForBrand',
};

const FILING_LOOKUP_QUERY = `
SELECT TOP 1 AppliNum, law
FROM (
  SELECT AppliNum, 1 AS law FROM TokkyoTable WHERE SeiriNum = @seiriNum
  UNION ALL
  SELECT AppliNum, 2 AS law FROM JituyoTable WHERE SeiriNum = @seiriNum
  UNION ALL
  SELECT AppliNum, 3 AS law FROM DesignTable WHERE SeiriNum = @seiriNum
  UNION ALL
  SELECT AppliNum, 4 AS law FROM BrandTable WHERE SeiriNum = @seiriNum
) AS matched
ORDER BY law ASC;
`;

function formatDate(date) {
  if (!date) return null;
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// ---- 出願番号 -> 文書URL -------------------------------------------------
// 社内LAN限定の文書サーバーへのURLを組み立てる。
// URL形式: ${URL_PREFIX}/${YEAR_PART}/${lawExpr}${元号}${filingYear}-${filingSequence}/
const GENGO_BASE_YEAR = { 3: 1925, 4: 1988, 5: 2000 }; // 3=昭和, 4=平成, 5=西暦
const GENGO_LABEL = { 3: '昭', 4: '平', 5: '20' };

// 西暦年(YYYY)を、偶数年始まりの2年区切り("YYYY-XX")に変換する。
// 偶数年: `${YYYY}-${(YYYY+1)%100}` / 奇数年: `${YYYY-1}-${YYYY%100}`
function buildYearPart(seirekiYear) {
  if (seirekiYear % 2 === 0) {
    return `${seirekiYear}-${String((seirekiYear + 1) % 100).padStart(2, '0')}`;
  }
  return `${seirekiYear - 1}-${String(seirekiYear % 100).padStart(2, '0')}`;
}

function buildDocumentUrl(lawExpr, yearType, filingYear, filingSequence) {
  const urlPrefix = process.env.DOC_SERVER_URL_PREFIX;
  if (!urlPrefix) {
    console.warn('警告: DOC_SERVER_URL_PREFIX が未設定のため documentUrl を生成できません。');
    return null;
  }
  const seirekiYear = GENGO_BASE_YEAR[yearType] + parseInt(filingYear, 10);
  const yearPart = buildYearPart(seirekiYear);
  const gengo = GENGO_LABEL[yearType];
  return `${urlPrefix.replace(/\/$/, '')}/${yearPart}/${lawExpr}${gengo}${filingYear}-${filingSequence}/`;
}

async function getFiling(pool, seiriNum) {
  const lookupResult = await pool
    .request()
    .input('seiriNum', sql.NVarChar(20), seiriNum)
    .query(FILING_LOOKUP_QUERY);

  if (lookupResult.recordset.length === 0) {
    return null;
  }

  const { AppliNum, law } = lookupResult.recordset[0];
  const appliNumStr = String(AppliNum);
  const lawExpr = LAW_EXPR[law];
  const yearType = parseInt(appliNumStr.substring(0, 1), 10);
  const filingYear = appliNumStr.substring(1, 3);
  const filingSequence = appliNumStr.substring(3, 9);

  const proceduresResult = await pool
    .request()
    .input('appliNum', sql.Int, AppliNum)
    .query(
      `SELECT Kind, AppliDate FROM ${TYUKAN_TABLE_BY_LAW[law]} WHERE AppliNum = @appliNum ORDER BY AppliDate ASC`
    );

  return {
    law,
    lawExpr,
    yearType,
    filingYear,
    filingSequence,
    documentUrl: buildDocumentUrl(lawExpr, yearType, filingYear, filingSequence),
    procedures: proceduresResult.recordset.map((r) => ({
      procedureDate: formatDate(r.AppliDate),
      procedure: r.Kind,
    })),
  };
}

// ---- ChatHistoryテーブル ------------------------------------------------
// Google ChatのURLと、その内容を表すカテゴリを整理番号ひもづけで記録する。
// 従来 JuninProcess/ForeignProcess/ForeignCProcess の memo列に書いていた
// Chat URLは、今後このテーブルに集約する(このAPIサーバーではmemo列への
// Chat URL追加は行わない)。
// テーブルが存在しない場合に起動時に自動作成できるよう、DDLはここに定義する
// (手動実行用のDDLは api-server/sql/create_chat_history.sql にも置いてある)。
const ENSURE_CHAT_HISTORY_TABLE_QUERY = `
IF OBJECT_ID('dbo.ChatHistory', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ChatHistory (
    id       INT IDENTITY(1,1) NOT NULL,
    SeiriNum NVARCHAR(20)      NOT NULL,
    ChatAt   DATETIME          NOT NULL,
    Category NVARCHAR(50)      NOT NULL,
    URL      NVARCHAR(500)     NOT NULL,
    CONSTRAINT PK_ChatHistory PRIMARY KEY CLUSTERED (id)
  );
  CREATE INDEX IX_ChatHistory_SeiriNum ON dbo.ChatHistory (SeiriNum);
END
`;

async function ensureChatHistoryTable(pool) {
  await pool.request().query(ENSURE_CHAT_HISTORY_TABLE_QUERY);
}

// 新規追加時、整理番号がJuninProcess/ForeignProcess/ForeignCProcessのいずれにも
// 存在しない場合はタイプミス等の可能性が高いため追加を拒否する(POST /api/records
// と同じ考え方の存在チェック)。
const CHAT_HISTORY_SEIRINUM_EXISTS_QUERY = `
SELECT TOP 1 1 AS found FROM (
  SELECT SeiriNum FROM JuninProcess WHERE SeiriNum = @seiriNum
  UNION ALL
  SELECT SeiriNum FROM ForeignProcess WHERE SeiriNum = @seiriNum
  UNION ALL
  SELECT SeiriNum FROM ForeignCProcess WHERE SeiriNum = @seiriNum
) AS matched;
`;

const CHAT_HISTORY_LIST_QUERY = `
SELECT id, SeiriNum, ChatAt, Category, URL
FROM ChatHistory
WHERE SeiriNum = @seiriNum
ORDER BY ChatAt ASC;
`;

const CHAT_HISTORY_INSERT_QUERY = `
INSERT INTO ChatHistory (SeiriNum, ChatAt, Category, URL)
OUTPUT INSERTED.id, INSERTED.SeiriNum, INSERTED.ChatAt, INSERTED.Category, INSERTED.URL
VALUES (@seiriNum, @chatAt, @category, @url);
`;

// idはIDENTITY主キーなので、ChatHistoryの更新/削除はSeiriNum+ChatAt等の複合キーではなく
// idだけで一意に特定できる。
const CHAT_HISTORY_UPDATE_QUERY = `
UPDATE ChatHistory
SET Category = @category, URL = @url
OUTPUT INSERTED.id, INSERTED.SeiriNum, INSERTED.ChatAt, INSERTED.Category, INSERTED.URL
WHERE id = @id;
`;

const CHAT_HISTORY_DELETE_QUERY = `
DELETE FROM ChatHistory
OUTPUT DELETED.id
WHERE id = @id;
`;

// ---- memo更新対象テーブルのホワイトリスト --------------------------------
// テーブル名はSQLの識別子でありパラメータ化(バインド変数)できないため、
// クライアントから受け取るのは下記キーのみとし、実テーブル名は必ずこの
// マップ経由で解決する(生のテーブル名をそのまま文字列連結しない)。
const RECORD_TABLES = {
  junin: { table: 'JuninProcess', label: '国内' },
  foreign: { table: 'ForeignProcess', label: 'PCT国際段階' },
  foreignc: { table: 'ForeignCProcess', label: '外国(国別)' },
};

function resolveTable(key) {
  return Object.prototype.hasOwnProperty.call(RECORD_TABLES, key) ? RECORD_TABLES[key] : null;
}

// sagyoDD/sagyoTTはUPDATE時にレコードを一意に特定するためのキーとして
// クライアントにそのまま返す(SEARCH_QUERYと同様、日付+時刻の組み合わせ)。
function buildListQuery(tableName) {
  return `
SELECT SeiriNum, sagyoDD, sagyoTT, sagyo, tanto, memo, kigen, sagyoKanryo, folder
FROM ${tableName}
WHERE SeiriNum = @seiriNum
ORDER BY sagyoDD ASC, sagyoTT ASC;
`;
}

// SeiriNum + sagyoDD + sagyoTT の組み合わせで対象レコードを一意に特定する。
// memoは@textで上書きする(既存値の追記ではない。編集フォーム側で既存memoを
// 初期値として表示し、ユーザーが編集した結果をそのまま設定する想定)。
// (INSERTは行わない。該当レコードが無ければ404を返す)
function buildMemoUpdateQuery(tableName) {
  return `
UPDATE ${tableName}
SET memo = @text
OUTPUT INSERTED.memo
WHERE SeiriNum = @seiriNum AND sagyoDD = @sagyoDD AND sagyoTT = @sagyoTT;
`;
}

// memoと同じ一意特定方法でsagyo列を上書きする。
function buildSagyoUpdateQuery(tableName) {
  return `
UPDATE ${tableName}
SET sagyo = @text
OUTPUT INSERTED.sagyo
WHERE SeiriNum = @seiriNum AND sagyoDD = @sagyoDD AND sagyoTT = @sagyoTT;
`;
}

// memo/sagyo更新と同じ一意特定方法でレコードを削除する。
function buildDeleteQuery(tableName) {
  return `
DELETE FROM ${tableName}
OUTPUT DELETED.SeiriNum
WHERE SeiriNum = @seiriNum AND sagyoDD = @sagyoDD AND sagyoTT = @sagyoTT;
`;
}

// 新規追加時、整理番号が対象テーブルに1件も存在しない場合はタイプミス等の
// 可能性が高いため追加を拒否する。そのための存在チェック。
function buildSeiriNumExistsQuery(tableName) {
  return `SELECT TOP 1 1 AS found FROM ${tableName} WHERE SeiriNum = @seiriNum;`;
}

// kigen/sagyoKanryo/folderはこのフォームでは入力させないためINSERT対象に含めず、
// NULLのまま挿入する。
function buildInsertQuery(tableName) {
  return `
INSERT INTO ${tableName} (SeiriNum, sagyoDD, sagyoTT, sagyo, tanto, memo)
OUTPUT INSERTED.SeiriNum, INSERTED.sagyoDD, INSERTED.sagyoTT, INSERTED.sagyo,
       INSERTED.tanto, INSERTED.memo, INSERTED.kigen, INSERTED.sagyoKanryo, INSERTED.folder
VALUES (@seiriNum, @sagyoDD, @sagyoTT, @sagyo, @tanto, @memo);
`;
}

// GET /api/records?table=junin&seiriNum=XXXXX
// table: junin(国内=JuninProcess) / foreign(PCT国際段階=ForeignProcess) / foreignc(外国(国別)=ForeignCProcess)
app.get('/api/records', requireApiKey, async (req, res) => {
  const entry = resolveTable((req.query.table || '').trim());
  if (!entry) {
    return res.status(400).json({ error: 'table must be one of: junin, foreign, foreignc' });
  }

  const seiriNum = (req.query.seiriNum || '').trim();
  if (!seiriNum) {
    return res.status(400).json({ error: 'seiriNum is required' });
  }
  if (seiriNum.length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .query(buildListQuery(entry.table));

    return res.json({
      table: req.query.table,
      seiriNum,
      count: result.recordset.length,
      records: result.recordset,
    });
  } catch (err) {
    console.error(`${entry.table}一覧取得エラー:`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/records
// body: { table, seiriNum, sagyo, tanto, memo }
// sagyoDD/sagyoTTはクライアントに入力させず、サーバー側で現在日時から生成する。
// sagyoTTはSEARCH_QUERYと同じ規約(日付部分はUnixEpoch=1970-01-01固定、時刻部分のみ有効)
// に合わせて組み立てる。kigen/sagyoKanryo/folderはNULLのまま挿入する。
app.post('/api/records', requireApiKey, async (req, res) => {
  const { table, seiriNum, sagyo, tanto, memo } = req.body || {};

  const entry = resolveTable(table);
  if (!entry) {
    return res.status(400).json({ error: 'table must be one of: junin, foreign, foreignc' });
  }

  const seiriNumTrimmed = (seiriNum || '').trim();
  if (!seiriNumTrimmed) {
    return res.status(400).json({ error: 'seiriNum is required' });
  }
  if (seiriNumTrimmed.length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  const sagyoTrimmed = (sagyo || '').trim();
  if (!sagyoTrimmed) {
    return res.status(400).json({ error: 'sagyo is required' });
  }

  const now = new Date();
  const sagyoDD = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sagyoTT = new Date(1970, 0, 1, now.getHours(), now.getMinutes(), now.getSeconds());

  try {
    const pool = await getPool();

    const existsResult = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNumTrimmed)
      .query(buildSeiriNumExistsQuery(entry.table));
    if (existsResult.recordset.length === 0) {
      return res.status(400).json({ error: 'seiriNum_not_found' });
    }

    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNumTrimmed)
      .input('sagyoDD', sql.DateTime, sagyoDD)
      .input('sagyoTT', sql.DateTime, sagyoTT)
      .input('sagyo', sql.NVarChar(sql.MAX), sagyoTrimmed)
      .input('tanto', sql.NVarChar(sql.MAX), (tanto || '').trim() || null)
      .input('memo', sql.NVarChar(sql.MAX), typeof memo === 'string' ? memo : '')
      .query(buildInsertQuery(entry.table));

    return res.status(201).json({ record: result.recordset[0] });
  } catch (err) {
    console.error(`${entry.table}新規追加エラー:`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/records/memo
// body: { table, seiriNum, sagyoDD, sagyoTT, text }
// sagyoDD/sagyoTTは GET /api/records のレスポンスに含まれる値をそのまま渡すこと。
app.post('/api/records/memo', requireApiKey, async (req, res) => {
  const { table, seiriNum, sagyoDD, sagyoTT, text } = req.body || {};

  const entry = resolveTable(table);
  if (!entry) {
    return res.status(400).json({ error: 'table must be one of: junin, foreign, foreignc' });
  }
  if (!seiriNum || !sagyoDD || !sagyoTT || typeof text !== 'string') {
    return res.status(400).json({ error: 'table, seiriNum, sagyoDD, sagyoTT, text are all required' });
  }
  if (String(seiriNum).length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  const sagyoDDDate = new Date(sagyoDD);
  const sagyoTTDate = new Date(sagyoTT);
  if (Number.isNaN(sagyoDDDate.getTime()) || Number.isNaN(sagyoTTDate.getTime())) {
    return res.status(400).json({ error: 'invalid sagyoDD or sagyoTT' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .input('sagyoDD', sql.DateTime, sagyoDDDate)
      .input('sagyoTT', sql.DateTime, sagyoTTDate)
      .input('text', sql.NVarChar(sql.MAX), text)
      .query(buildMemoUpdateQuery(entry.table));

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'record_not_found' });
    }

    return res.json({ memo: result.recordset[0].memo });
  } catch (err) {
    console.error(`${entry.table} memo更新エラー:`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/records/sagyo
// body: { table, seiriNum, sagyoDD, sagyoTT, text }
// sagyoDD/sagyoTTは GET /api/records のレスポンスに含まれる値をそのまま渡すこと。
app.post('/api/records/sagyo', requireApiKey, async (req, res) => {
  const { table, seiriNum, sagyoDD, sagyoTT, text } = req.body || {};

  const entry = resolveTable(table);
  if (!entry) {
    return res.status(400).json({ error: 'table must be one of: junin, foreign, foreignc' });
  }
  if (!seiriNum || !sagyoDD || !sagyoTT || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'table, seiriNum, sagyoDD, sagyoTT, text are all required' });
  }
  if (String(seiriNum).length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  const sagyoDDDate = new Date(sagyoDD);
  const sagyoTTDate = new Date(sagyoTT);
  if (Number.isNaN(sagyoDDDate.getTime()) || Number.isNaN(sagyoTTDate.getTime())) {
    return res.status(400).json({ error: 'invalid sagyoDD or sagyoTT' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .input('sagyoDD', sql.DateTime, sagyoDDDate)
      .input('sagyoTT', sql.DateTime, sagyoTTDate)
      .input('text', sql.NVarChar(sql.MAX), text.trim())
      .query(buildSagyoUpdateQuery(entry.table));

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'record_not_found' });
    }

    return res.json({ sagyo: result.recordset[0].sagyo });
  } catch (err) {
    console.error(`${entry.table} sagyo更新エラー:`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/records/delete
// body: { table, seiriNum, sagyoDD, sagyoTT }
// sagyoDD/sagyoTTは GET /api/records のレスポンスに含まれる値をそのまま渡すこと。
// (DELETEメソッド+bodyはクライアント/プロキシによって扱いが不安定なためPOSTで統一する)
app.post('/api/records/delete', requireApiKey, async (req, res) => {
  const { table, seiriNum, sagyoDD, sagyoTT } = req.body || {};

  const entry = resolveTable(table);
  if (!entry) {
    return res.status(400).json({ error: 'table must be one of: junin, foreign, foreignc' });
  }
  if (!seiriNum || !sagyoDD || !sagyoTT) {
    return res.status(400).json({ error: 'table, seiriNum, sagyoDD, sagyoTT are all required' });
  }
  if (String(seiriNum).length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  const sagyoDDDate = new Date(sagyoDD);
  const sagyoTTDate = new Date(sagyoTT);
  if (Number.isNaN(sagyoDDDate.getTime()) || Number.isNaN(sagyoTTDate.getTime())) {
    return res.status(400).json({ error: 'invalid sagyoDD or sagyoTT' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .input('sagyoDD', sql.DateTime, sagyoDDDate)
      .input('sagyoTT', sql.DateTime, sagyoTTDate)
      .query(buildDeleteQuery(entry.table));

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'record_not_found' });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error(`${entry.table} 削除エラー:`, err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/chat-history?seiriNum=XXXXX
app.get('/api/chat-history', requireApiKey, async (req, res) => {
  const seiriNum = (req.query.seiriNum || '').trim();
  if (!seiriNum) {
    return res.status(400).json({ error: 'seiriNum is required' });
  }
  if (seiriNum.length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .query(CHAT_HISTORY_LIST_QUERY);

    return res.json({
      seiriNum,
      count: result.recordset.length,
      records: result.recordset,
    });
  } catch (err) {
    console.error('ChatHistory一覧取得エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/chat-history
// body: { seiriNum, category, url, chatAt? }
// chatAtは省略時サーバーの現在時刻を使う。指定する場合はDateとしてパース可能な
// 形式(ISO文字列等)で渡すこと。
app.post('/api/chat-history', requireApiKey, async (req, res) => {
  const { seiriNum, category, url, chatAt } = req.body || {};

  const seiriNumTrimmed = (seiriNum || '').trim();
  if (!seiriNumTrimmed) {
    return res.status(400).json({ error: 'seiriNum is required' });
  }
  if (seiriNumTrimmed.length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  const categoryTrimmed = (category || '').trim();
  if (!categoryTrimmed) {
    return res.status(400).json({ error: 'category is required' });
  }
  if (categoryTrimmed.length > 50) {
    return res.status(400).json({ error: 'category too long (max 50 chars)' });
  }

  const urlTrimmed = (url || '').trim();
  if (!urlTrimmed) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (urlTrimmed.length > 500) {
    return res.status(400).json({ error: 'url too long (max 500 chars)' });
  }

  const chatAtDate = chatAt ? new Date(chatAt) : new Date();
  if (Number.isNaN(chatAtDate.getTime())) {
    return res.status(400).json({ error: 'invalid chatAt' });
  }

  try {
    const pool = await getPool();

    const existsResult = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNumTrimmed)
      .query(CHAT_HISTORY_SEIRINUM_EXISTS_QUERY);
    if (existsResult.recordset.length === 0) {
      return res.status(400).json({ error: 'seiriNum_not_found' });
    }

    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNumTrimmed)
      .input('chatAt', sql.DateTime, chatAtDate)
      .input('category', sql.NVarChar(50), categoryTrimmed)
      .input('url', sql.NVarChar(500), urlTrimmed)
      .query(CHAT_HISTORY_INSERT_QUERY);

    return res.status(201).json({ record: result.recordset[0] });
  } catch (err) {
    console.error('ChatHistory新規追加エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/chat-history/update
// body: { id, category, url }
app.post('/api/chat-history/update', requireApiKey, async (req, res) => {
  const { id, category, url } = req.body || {};

  const idNum = Number(id);
  if (!Number.isInteger(idNum)) {
    return res.status(400).json({ error: 'id is required' });
  }

  const categoryTrimmed = (category || '').trim();
  if (!categoryTrimmed) {
    return res.status(400).json({ error: 'category is required' });
  }
  if (categoryTrimmed.length > 50) {
    return res.status(400).json({ error: 'category too long (max 50 chars)' });
  }

  const urlTrimmed = (url || '').trim();
  if (!urlTrimmed) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (urlTrimmed.length > 500) {
    return res.status(400).json({ error: 'url too long (max 500 chars)' });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', sql.Int, idNum)
      .input('category', sql.NVarChar(50), categoryTrimmed)
      .input('url', sql.NVarChar(500), urlTrimmed)
      .query(CHAT_HISTORY_UPDATE_QUERY);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'record_not_found' });
    }

    return res.json({ record: result.recordset[0] });
  } catch (err) {
    console.error('ChatHistory更新エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/chat-history/delete
// body: { id }
app.post('/api/chat-history/delete', requireApiKey, async (req, res) => {
  const { id } = req.body || {};

  const idNum = Number(id);
  if (!Number.isInteger(idNum)) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const pool = await getPool();
    const result = await pool.request().input('id', sql.Int, idNum).query(CHAT_HISTORY_DELETE_QUERY);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'record_not_found' });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error('ChatHistory削除エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ---- 担当者別 整理番号一覧 ------------------------------------------------
// 担当者(tantosya)に紐づく整理番号セットは、作業履歴テーブル(JuninProcess等)ではなく
// マスタテーブルから求める。
//  - 国内: JuninTable.SeiriNum(Tantosya列で担当者を判定)
//  - 外国: ForeignTable(tantosya列で担当者を判定)とForeignCountryをSeiriNumで結合し、
//    ForeignCountry.F_Num(国別の整理番号)を採用する
// それぞれについてChatHistory上の最新のChatAtをCROSS APPLYで1件取得する
// (同時刻の複数件はid DESCで一意化)。最新のChatAtが直近@monthsヶ月以内のものだけに
// 絞り込んで返す(「直近Nヶ月以内のレコードが1件でもあるか」と「最新のChatAtが直近N
// ヶ月以内か」はChatAtの最大値で判定する限り同値なので、この絞り込みで表示用の最新履歴も
// 同時に取れる)。
const TANTO_SEIRI_NUMS_QUERY = `
WITH TantoSeiri AS (
  SELECT DISTINCT SeiriNum FROM JuninTable WHERE Tantosya = @tanto
  UNION
  SELECT DISTINCT fc.F_Num AS SeiriNum
  FROM ForeignTable ft
  JOIN ForeignCountry fc ON ft.SeiriNum = fc.SeiriNum
  WHERE ft.tantosya = @tanto
)
SELECT ts.SeiriNum, latest.ChatAt, latest.Category, latest.URL
FROM TantoSeiri ts
CROSS APPLY (
  SELECT TOP 1 ChatAt, Category, URL
  FROM ChatHistory ch
  WHERE ch.SeiriNum = ts.SeiriNum
  ORDER BY ChatAt DESC, id DESC
) latest
WHERE latest.ChatAt >= DATEADD(month, -@months, GETDATE())
ORDER BY ts.SeiriNum;
`;

// 「/担当者名.N」で指定できる遡り月数の上限。GAS側(Code.gs)でも同じ上限で
// 丸めているが、APIを直接叩かれた場合の防御としてサーバー側でも丸める。
const TANTO_SEIRI_NUMS_MAX_MONTHS = 12;

// GET /api/tanto-seiri-nums?tanto=山崎&months=3
// months省略時・数値変換できない場合は1ヶ月とし、12を超える場合は12に丸める。
app.get('/api/tanto-seiri-nums', requireApiKey, async (req, res) => {
  const tanto = (req.query.tanto || '').trim();
  if (!tanto) {
    return res.status(400).json({ error: 'tanto is required' });
  }

  let months = parseInt(req.query.months, 10);
  if (!Number.isInteger(months) || months < 1) months = 1;
  if (months > TANTO_SEIRI_NUMS_MAX_MONTHS) months = TANTO_SEIRI_NUMS_MAX_MONTHS;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('tanto', sql.NVarChar(sql.MAX), tanto)
      .input('months', sql.Int, months)
      .query(TANTO_SEIRI_NUMS_QUERY);

    return res.json({
      tanto,
      months,
      count: result.recordset.length,
      records: result.recordset,
    });
  } catch (err) {
    console.error('担当者別整理番号取得エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ---- ヘルスチェック ---------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---- 進捗検索エンドポイント ---------------------------------------------
// GET /api/progress?seiriNum=XXXXX
app.get('/api/progress', requireApiKey, async (req, res) => {
  const seiriNum = (req.query.seiriNum || '').trim();

  if (!seiriNum) {
    return res.status(400).json({ error: 'seiriNum is required' });
  }
  if (seiriNum.length > 20) {
    return res.status(400).json({ error: 'seiriNum too long (max 20 chars)' });
  }

  try {
    const pool = await getPool();
    const [result, filing, chatHistoryResult] = await Promise.all([
      pool.request().input('seiriNum', sql.NVarChar(20), seiriNum).query(SEARCH_QUERY),
      getFiling(pool, seiriNum),
      pool.request().input('seiriNum', sql.NVarChar(20), seiriNum).query(CHAT_HISTORY_LIST_QUERY),
    ]);

    return res.json({
      seiriNum,
      count: result.recordset.length,
      records: result.recordset,
      filing,
      chatHistory: chatHistoryResult.recordset,
    });
  } catch (err) {
    console.error('検索エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    const pool = await getPool();
    await ensureChatHistoryTable(pool);
    console.log('ChatHistoryテーブル確認完了');
  } catch (err) {
    console.error('起動時のChatHistoryテーブル確認に失敗しました:', err);
  }

  app.listen(PORT, () => {
    console.log(`進捗検索API起動: http://localhost:${PORT}`);
  });
})();
