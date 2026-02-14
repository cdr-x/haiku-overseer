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
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
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
  outputTokens: number
): void {
  db.prepare(
    `INSERT INTO token_usage (session_id, input_tokens, output_tokens) VALUES (?, ?, ?)`
  ).run(sessionId, inputTokens, outputTokens);
}

export function getSessionTokenUsage(
  db: Database.Database,
  sessionId: string
): { total_input: number; total_output: number; call_count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output, COUNT(*) as call_count FROM token_usage WHERE session_id = ?`
    )
    .get(sessionId) as { total_input: number; total_output: number; call_count: number };
  return row;
}

export function getTotalTokenUsage(
  db: Database.Database
): { total_input: number; total_output: number; call_count: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output, COUNT(*) as call_count FROM token_usage`
    )
    .get() as { total_input: number; total_output: number; call_count: number };
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
