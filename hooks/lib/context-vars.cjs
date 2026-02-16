// hooks/lib/context-vars.cjs
// Shared DB utilities for context variables in hooks
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function openDb(cwd) {
  const dbPath = path.join(cwd || process.cwd(), ".haiku-overseer", "memory.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_vars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      var_name TEXT NOT NULL,
      var_value TEXT NOT NULL,
      var_meta TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, var_name)
    );
    CREATE INDEX IF NOT EXISTS idx_context_vars_session ON context_vars(session_id, var_name);
  `);
  return db;
}

function upsertContextVar(db, sessionId, varName, varValue, varMeta) {
  db.prepare(
    `INSERT INTO context_vars (session_id, var_name, var_value, var_meta)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, var_name) DO UPDATE SET
       var_value = excluded.var_value,
       var_meta = excluded.var_meta,
       updated_at = datetime('now')`
  ).run(sessionId, varName, varValue, varMeta || null);
}

function getAllContextVars(db, sessionId) {
  return db
    .prepare("SELECT * FROM context_vars WHERE session_id = ? ORDER BY var_name")
    .all(sessionId);
}

function getContextVarsByNames(db, sessionId, varNames) {
  if (!varNames || varNames.length === 0) return [];
  const placeholders = varNames.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM context_vars WHERE session_id = ? AND var_name IN (${placeholders}) ORDER BY var_name`)
    .all(sessionId, ...varNames);
}

function getContextVar(db, sessionId, varName) {
  return db
    .prepare("SELECT * FROM context_vars WHERE session_id = ? AND var_name = ?")
    .get(sessionId, varName);
}

function deleteContextVar(db, sessionId, varName) {
  db.prepare("DELETE FROM context_vars WHERE session_id = ? AND var_name = ?")
    .run(sessionId, varName);
}

module.exports = { openDb, upsertContextVar, getAllContextVars, getContextVarsByNames, getContextVar, deleteContextVar };
