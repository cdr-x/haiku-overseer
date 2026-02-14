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
  role: string; // "user" | "tool_result" | "error" | "injection"
  content: string;
  meta: string | null; // JSON string for tool name, exit code, etc.
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
