import Database from "better-sqlite3";
import path from "path";

export interface PromptRow {
  id: number;
  session_id: string;
  prompt: string;
  injection: string | null;
  haiku_response: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  session_id: string;
  role: string; // "user" | "tool_result" | "error" | "injection" | "files_changed" | "diff"
  content: string;
  meta: string | null; // JSON string for tool name, exit code, etc.
  created_at: string;
}

export interface SessionSummaryRow {
  id: number;
  session_id: string;
  summary: string;
  created_at: string;
}

export interface ContextVarRow {
  id: number;
  session_id: string;
  var_name: string;
  var_value: string;
  var_meta: string | null;
  updated_at: string;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      injection TEXT,
      haiku_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS last_advisory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      is_lgtm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
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
    CREATE TABLE IF NOT EXISTS micro_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_range TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing DBs
  const cols = db.prepare("PRAGMA table_info(token_usage)").all() as { name: string }[];
  const colNames = cols.map(c => c.name);
  if (!colNames.includes("cache_creation_tokens")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.includes("cache_read_tokens")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  }

  // FTS5 for full-text search across turns
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      user_prompt,
      assistant_response,
      content=turns,
      content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, user_prompt, assistant_response)
      VALUES (new.id, new.user_prompt, new.assistant_response);
    END;
  `);

  // Backfill FTS from existing turns that aren't indexed yet
  const ftsCount = (db.prepare("SELECT COUNT(*) as cnt FROM turns_fts").get() as { cnt: number }).cnt;
  const turnsCount = (db.prepare("SELECT COUNT(*) as cnt FROM turns").get() as { cnt: number }).cnt;
  if (turnsCount > 0 && ftsCount < turnsCount) {
    db.exec(`
      INSERT OR IGNORE INTO turns_fts(rowid, user_prompt, assistant_response)
      SELECT id, user_prompt, assistant_response FROM turns;
    `);
  }

  // Indexes for efficient queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turns_session_time ON turns(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_turns_time ON turns(created_at);
  `);

  return db;
}

export function insertPrompt(
  db: Database.Database,
  sessionId: string,
  prompt: string,
  injection: string | null,
  haikuResponse: string | null
): void {
  db.prepare(
    `INSERT INTO prompts (session_id, prompt, injection, haiku_response) VALUES (?, ?, ?, ?)`
  ).run(sessionId, prompt, injection, haikuResponse);
}

export function getRecentPrompts(
  db: Database.Database,
  sessionId: string,
  limit = 10
): PromptRow[] {
  return db
    .prepare(
      `SELECT * FROM prompts WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit) as PromptRow[];
}

export function getRecentEvents(
  db: Database.Database,
  sessionId: string,
  limit = 20
): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit) as EventRow[];
}

export function insertEvent(
  db: Database.Database,
  sessionId: string,
  role: string,
  content: string,
  meta: string | null = null
): void {
  db.prepare(
    `INSERT INTO events (session_id, role, content, meta) VALUES (?, ?, ?, ?)`
  ).run(sessionId, role, content, meta);
}

export function getErrorCount(
  db: Database.Database,
  sessionId: string,
  sinceMins = 5
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE session_id = ? AND role = 'error' AND created_at > datetime('now', '-' || ? || ' minutes')`
    )
    .get(sessionId, sinceMins) as { cnt: number };
  return row.cnt;
}

export function getAllEvents(
  db: Database.Database,
  sessionId: string,
  limit = 100
): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit) as EventRow[];
}

export function getAllEventsChronological(
  db: Database.Database,
  sessionId: string
): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as EventRow[];
}

export function upsertSessionSummary(
  db: Database.Database,
  sessionId: string,
  summary: string
): void {
  db.prepare(
    `INSERT INTO session_summaries (session_id, summary) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, created_at = datetime('now')`
  ).run(sessionId, summary);
}

export function getSessionSummary(
  db: Database.Database,
  sessionId: string
): string | null {
  const row = db
    .prepare(
      `SELECT summary FROM session_summaries WHERE session_id = ?`
    )
    .get(sessionId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

export function getRecentSummaries(
  db: Database.Database,
  limit = 3
): SessionSummaryRow[] {
  return db
    .prepare(
      `SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as SessionSummaryRow[];
}

// --- Token usage ---

export function insertTokenUsage(
  db: Database.Database,
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0
): void {
  db.prepare(
    `INSERT INTO token_usage (session_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);
}

export interface TokenUsageStats {
  total_input: number;
  total_output: number;
  total_cache_creation: number;
  total_cache_read: number;
  call_count: number;
}

export function getSessionTokenUsage(
  db: Database.Database,
  sessionId: string
): TokenUsageStats {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output, COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read, COUNT(*) as call_count FROM token_usage WHERE session_id = ?`
    )
    .get(sessionId) as TokenUsageStats;
  return row;
}

export function getTotalTokenUsage(
  db: Database.Database
): TokenUsageStats {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output, COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation, COALESCE(SUM(cache_read_tokens), 0) as total_cache_read, COUNT(*) as call_count FROM token_usage`
    )
    .get() as TokenUsageStats;
  return row;
}

// --- Turns (hook-captured) ---

export function insertTurn(
  db: Database.Database,
  sessionId: string,
  userPrompt: string,
  assistantResponse: string
): void {
  db.prepare(
    `INSERT INTO turns (session_id, user_prompt, assistant_response) VALUES (?, ?, ?)`
  ).run(sessionId, userPrompt, assistantResponse);
}

// --- Context Variables (RLM-inspired) ---

export function upsertContextVar(
  db: Database.Database,
  sessionId: string,
  varName: string,
  varValue: string,
  varMeta: string | null = null
): void {
  db.prepare(
    `INSERT INTO context_vars (session_id, var_name, var_value, var_meta)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, var_name) DO UPDATE SET
       var_value = excluded.var_value,
       var_meta = excluded.var_meta,
       updated_at = datetime('now')`
  ).run(sessionId, varName, varValue, varMeta);
}

export function getContextVar(
  db: Database.Database,
  sessionId: string,
  varName: string
): ContextVarRow | undefined {
  return db
    .prepare(
      `SELECT * FROM context_vars WHERE session_id = ? AND var_name = ?`
    )
    .get(sessionId, varName) as ContextVarRow | undefined;
}

export function getAllContextVars(
  db: Database.Database,
  sessionId: string
): ContextVarRow[] {
  return db
    .prepare(
      `SELECT * FROM context_vars WHERE session_id = ? ORDER BY var_name`
    )
    .all(sessionId) as ContextVarRow[];
}

export function getContextVarsByNames(
  db: Database.Database,
  sessionId: string,
  varNames: string[]
): ContextVarRow[] {
  if (varNames.length === 0) return [];
  const placeholders = varNames.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM context_vars WHERE session_id = ? AND var_name IN (${placeholders}) ORDER BY var_name`
    )
    .all(sessionId, ...varNames) as ContextVarRow[];
}

// --- Micro-summaries (hierarchical) ---

export interface MicroSummaryRow {
  id: number;
  session_id: string;
  turn_range: string;
  summary: string;
  created_at: string;
}

export function insertMicroSummary(
  db: Database.Database,
  sessionId: string,
  turnRange: string,
  summary: string
): void {
  db.prepare(
    `INSERT INTO micro_summaries (session_id, turn_range, summary) VALUES (?, ?, ?)`
  ).run(sessionId, turnRange, summary);
}

export function getRecentMicroSummaries(
  db: Database.Database,
  sessionId: string,
  limit = 10
): MicroSummaryRow[] {
  return db
    .prepare(
      `SELECT * FROM micro_summaries WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit) as MicroSummaryRow[];
}

export function getMicroSummaryCount(
  db: Database.Database,
  sessionId: string
): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM micro_summaries WHERE session_id = ?`)
    .get(sessionId) as { cnt: number };
  return row.cnt;
}

export function deleteContextVar(
  db: Database.Database,
  sessionId: string,
  varName: string
): void {
  db.prepare(
    `DELETE FROM context_vars WHERE session_id = ? AND var_name = ?`
  ).run(sessionId, varName);
}

// --- Last Advisory (for statusline) ---

export interface LastAdvisoryRow {
  id: number;
  session_id: string;
  content: string;
  is_lgtm: number;
  updated_at: string;
}

export function upsertLastAdvisory(
  db: Database.Database,
  sessionId: string,
  content: string,
  isLgtm: boolean
): void {
  db.prepare(
    `INSERT INTO last_advisory (session_id, content, is_lgtm)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       content = excluded.content,
       is_lgtm = excluded.is_lgtm,
       updated_at = datetime('now')`
  ).run(sessionId, content, isLgtm ? 1 : 0);
}

export function getLastAdvisory(
  db: Database.Database,
  sessionId: string
): LastAdvisoryRow | undefined {
  return db
    .prepare(`SELECT * FROM last_advisory WHERE session_id = ?`)
    .get(sessionId) as LastAdvisoryRow | undefined;
}

// --- FTS5 Search + Cross-session queries ---

export interface TurnRow {
  id: number;
  session_id: string;
  user_prompt: string;
  assistant_response: string;
  created_at: string;
}

export interface FtsResult extends TurnRow {
  snippet_prompt: string;
  snippet_response: string;
  rank: number;
}

export function searchTurns(
  db: Database.Database,
  query: string,
  sessionId?: string,
  limit = 20,
  offset = 0
): FtsResult[] {
  const ftsQuery = query.replace(/['"]/g, "");
  if (sessionId) {
    return db
      .prepare(
        `SELECT t.*, snippet(turns_fts, 0, '>>>', '<<<', '...', 32) as snippet_prompt,
                snippet(turns_fts, 1, '>>>', '<<<', '...', 32) as snippet_response,
                rank
         FROM turns_fts
         JOIN turns t ON t.id = turns_fts.rowid
         WHERE turns_fts MATCH ? AND t.session_id = ?
         ORDER BY rank
         LIMIT ? OFFSET ?`
      )
      .all(ftsQuery, sessionId, limit, offset) as FtsResult[];
  }
  return db
    .prepare(
      `SELECT t.*, snippet(turns_fts, 0, '>>>', '<<<', '...', 32) as snippet_prompt,
              snippet(turns_fts, 1, '>>>', '<<<', '...', 32) as snippet_response,
              rank
       FROM turns_fts
       JOIN turns t ON t.id = turns_fts.rowid
       WHERE turns_fts MATCH ?
       ORDER BY rank
       LIMIT ? OFFSET ?`
    )
    .all(ftsQuery, limit, offset) as FtsResult[];
}

export function getTurnRange(
  db: Database.Database,
  sessionId: string,
  limit = 20,
  offset = 0
): TurnRow[] {
  return db
    .prepare(
      `SELECT * FROM turns WHERE session_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offset) as TurnRow[];
}

export interface SessionListItem {
  session_id: string;
  turn_count: number;
  first_turn: string;
  last_turn: string;
  summary: string | null;
}

export function listSessions(
  db: Database.Database,
  limit = 20
): SessionListItem[] {
  return db
    .prepare(
      `SELECT t.session_id,
              COUNT(*) as turn_count,
              MIN(t.created_at) as first_turn,
              MAX(t.created_at) as last_turn,
              s.summary
       FROM turns t
       LEFT JOIN session_summaries s ON s.session_id = t.session_id
       GROUP BY t.session_id
       ORDER BY MAX(t.created_at) DESC
       LIMIT ?`
    )
    .all(limit) as SessionListItem[];
}

export function purgeTurns(
  db: Database.Database,
  olderThanDays: number
): number {
  const result = db
    .prepare(
      `DELETE FROM turns WHERE created_at < datetime('now', '-' || ? || ' days')`
    )
    .run(olderThanDays);
  // Rebuild FTS index after purge
  db.exec(`INSERT INTO turns_fts(turns_fts) VALUES('rebuild')`);
  return result.changes;
}
