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

const express = require('express');
const sql = require('mssql');
require('dotenv').config();

const app = express();
app.use(express.json());

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
    const result = await pool
      .request()
      .input('seiriNum', sql.NVarChar(20), seiriNum)
      .query(SEARCH_QUERY);

    return res.json({
      seiriNum,
      count: result.recordset.length,
      records: result.recordset,
    });
  } catch (err) {
    console.error('検索エラー:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`進捗検索API起動: http://localhost:${PORT}`);
});
