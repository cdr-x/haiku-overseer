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

    -- RLM: Intent-Experience-Utility triplet storage (MemRL-inspired)
    CREATE TABLE IF NOT EXISTS rlm_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER,
      intent TEXT,
      chunk_text TEXT NOT NULL,
      chunk_hash TEXT UNIQUE,
      chunk_type TEXT,
      utility REAL DEFAULT 0.5,
      retrieval_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      embedding BLOB,
      token_count INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rlm_chunks_session ON rlm_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_chunks_type ON rlm_chunks(chunk_type);

    -- RLM: Bellman conversation log
    CREATE TABLE IF NOT EXISTS rlm_bellman_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER,
      exchange_number INTEGER,
      prompt_summary TEXT,
      response_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- RLM: Auto-generated skills
    CREATE TABLE IF NOT EXISTS rlm_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT UNIQUE NOT NULL,
      description TEXT,
      trigger_patterns TEXT,
      instruction_template TEXT,
      source_chunks TEXT,
      confidence REAL DEFAULT 0.5,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing DBs
  const chunkCols = db.prepare("PRAGMA table_info(rlm_chunks)").all() as { name: string }[];
  const chunkColNames = chunkCols.map(c => c.name);
  if (!chunkColNames.includes("memory_weight")) {
    db.exec("ALTER TABLE rlm_chunks ADD COLUMN memory_weight REAL DEFAULT 1.0");
  }

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
    CREATE INDEX IF NOT EXISTS idx_events_role_created ON events(role, created_at);
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

// --- RLM Chunks ---

export interface RlmChunkRow {
  id: number;
  session_id: string;
  turn_number: number | null;
  intent: string | null;
  chunk_text: string;
  chunk_hash: string;
  chunk_type: string | null;
  utility: number;
  retrieval_count: number;
  success_count: number;
  embedding: Buffer | null;
  token_count: number | null;
  memory_weight: number;
  created_at: string;
}

export function insertChunk(
  db: Database.Database,
  sessionId: string,
  turnNumber: number | null,
  intent: string | null,
  chunkText: string,
  chunkHash: string,
  chunkType: string | null,
  tokenCount: number | null
): number {
  const info = db.prepare(
    `INSERT OR IGNORE INTO rlm_chunks (session_id, turn_number, intent, chunk_text, chunk_hash, chunk_type, token_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, turnNumber, intent, chunkText, chunkHash, chunkType, tokenCount);
  return Number(info.lastInsertRowid);
}

export function getChunkByHash(
  db: Database.Database,
  chunkHash: string
): RlmChunkRow | undefined {
  return db.prepare(`SELECT * FROM rlm_chunks WHERE chunk_hash = ?`).get(chunkHash) as RlmChunkRow | undefined;
}

export function updateChunkEmbedding(
  db: Database.Database,
  chunkId: number,
  embedding: Buffer
): void {
  db.prepare(
    `UPDATE rlm_chunks SET embedding = ? WHERE id = ?`
  ).run(embedding, chunkId);
}

export function getAllEmbeddings(
  db: Database.Database
): Array<{ id: number; embedding: Buffer; utility: number; memory_weight: number; chunk_text: string; chunk_type: string | null; intent: string | null; created_at: string }> {
  return db.prepare(
    `SELECT id, embedding, utility, COALESCE(memory_weight, 1.0) as memory_weight, chunk_text, chunk_type, intent, created_at FROM rlm_chunks WHERE embedding IS NOT NULL`
  ).all() as Array<{ id: number; embedding: Buffer; utility: number; memory_weight: number; chunk_text: string; chunk_type: string | null; intent: string | null; created_at: string }>;
}

export function getTopRetrievedIntents(
  db: Database.Database,
  limit = 5
): Array<{ intent: string; retrieval_count: number }> {
  return db.prepare(
    `SELECT intent, retrieval_count FROM rlm_chunks
     WHERE intent IS NOT NULL AND retrieval_count > 0
     ORDER BY retrieval_count DESC LIMIT ?`
  ).all(limit) as Array<{ intent: string; retrieval_count: number }>;
}

export function getChunksByIds(
  db: Database.Database,
  ids: number[]
): RlmChunkRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM rlm_chunks WHERE id IN (${placeholders})`
  ).all(...ids) as RlmChunkRow[];
}

export function updateChunkUtility(
  db: Database.Database,
  chunkId: number,
  utility: number
): void {
  db.prepare(`UPDATE rlm_chunks SET utility = ? WHERE id = ?`).run(utility, chunkId);
}

export function incrementChunkRetrieval(
  db: Database.Database,
  chunkId: number
): void {
  db.prepare(`UPDATE rlm_chunks SET retrieval_count = retrieval_count + 1 WHERE id = ?`).run(chunkId);
}

export function incrementChunkSuccess(
  db: Database.Database,
  chunkId: number
): void {
  db.prepare(`UPDATE rlm_chunks SET success_count = success_count + 1 WHERE id = ?`).run(chunkId);
}

export function updateChunkMemoryWeight(
  db: Database.Database,
  chunkId: number,
  weight: number
): void {
  db.prepare(`UPDATE rlm_chunks SET memory_weight = ? WHERE id = ?`).run(weight, chunkId);
}

export function getRecentChunks(
  db: Database.Database,
  sessionId: string,
  limit = 50
): RlmChunkRow[] {
  return db.prepare(
    `SELECT * FROM rlm_chunks WHERE session_id = ? ORDER BY id DESC LIMIT ?`
  ).all(sessionId, limit) as RlmChunkRow[];
}

export function getTotalChunkCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) as cnt FROM rlm_chunks`).get() as { cnt: number }).cnt;
}

// --- RLM Bellman Log ---

export function insertBellmanLog(
  db: Database.Database,
  sessionId: string,
  turnNumber: number | null,
  exchangeNumber: number,
  promptSummary: string,
  responseJson: string
): void {
  db.prepare(
    `INSERT INTO rlm_bellman_log (session_id, turn_number, exchange_number, prompt_summary, response_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, turnNumber, exchangeNumber, promptSummary, responseJson);
}

export function getRecentBellmanRewards(
  db: Database.Database,
  limit = 20
): number[] {
  const rows = db.prepare(
    `SELECT response_json FROM rlm_bellman_log WHERE exchange_number = 1 ORDER BY id DESC LIMIT ?`
  ).all(limit) as Array<{ response_json: string }>;
  const rewards: number[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.response_json);
      if (typeof parsed.reward === "number") rewards.push(parsed.reward);
    } catch {}
  }
  return rewards;
}

// --- RLM Skills ---

export interface RlmSkillRow {
  id: number;
  skill_name: string;
  description: string | null;
  trigger_patterns: string | null;
  instruction_template: string | null;
  source_chunks: string | null;
  confidence: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export function insertOrUpdateSkill(
  db: Database.Database,
  skillName: string,
  description: string | null,
  triggerPatterns: string | null,
  instructionTemplate: string | null,
  sourceChunks: string | null,
  confidence: number
): void {
  db.prepare(
    `INSERT INTO rlm_skills (skill_name, description, trigger_patterns, instruction_template, source_chunks, confidence)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_name) DO UPDATE SET
       description = excluded.description,
       trigger_patterns = excluded.trigger_patterns,
       instruction_template = excluded.instruction_template,
       source_chunks = excluded.source_chunks,
       confidence = excluded.confidence,
       updated_at = datetime('now')`
  ).run(skillName, description, triggerPatterns, instructionTemplate, sourceChunks, confidence);
}

export function getAllSkills(db: Database.Database): RlmSkillRow[] {
  return db.prepare(`SELECT * FROM rlm_skills ORDER BY confidence DESC`).all() as RlmSkillRow[];
}

export function updateSkillUsage(
  db: Database.Database,
  skillName: string
): void {
  db.prepare(
    `UPDATE rlm_skills SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE skill_name = ?`
  ).run(skillName);
}

export function updateSkillConfidence(
  db: Database.Database,
  skillName: string,
  confidence: number
): void {
  db.prepare(
    `UPDATE rlm_skills SET confidence = ?, updated_at = datetime('now') WHERE skill_name = ?`
  ).run(confidence, skillName);
}

// --- Health Check helpers ---

export interface ChunkStats {
  total_chunks: number;
  stale_chunks: number;
  avg_utility: number;
  total_skills: number;
}

export function getChunkStats(db: Database.Database): ChunkStats {
  const chunkRow = db.prepare(
    `SELECT COUNT(*) as total, COALESCE(AVG(utility), 0) as avg_util FROM rlm_chunks`
  ).get() as { total: number; avg_util: number };

  const staleRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM rlm_chunks WHERE retrieval_count = 0 AND utility < 0.3 AND created_at < datetime('now', '-30 days')`
  ).get() as { cnt: number };

  let totalSkills = 0;
  try {
    totalSkills = (db.prepare(`SELECT COUNT(*) as cnt FROM rlm_skills`).get() as { cnt: number }).cnt;
  } catch {}

  return {
    total_chunks: chunkRow.total,
    stale_chunks: staleRow.cnt,
    avg_utility: Math.round(chunkRow.avg_util * 100) / 100,
    total_skills: totalSkills,
  };
}

export function checkDbIntegrity(db: Database.Database): "healthy" | "degraded" | "unhealthy" {
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") return "unhealthy";
  } catch {
    return "unhealthy";
  }

  const chunkCount = (db.prepare(`SELECT COUNT(*) as cnt FROM rlm_chunks`).get() as { cnt: number }).cnt;
  const eventCount = (db.prepare(`SELECT COUNT(*) as cnt FROM events`).get() as { cnt: number }).cnt;
  if (chunkCount > 500 || eventCount > 10000) return "degraded";

  return "healthy";
}
