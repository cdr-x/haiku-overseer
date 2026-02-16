# Execution Trace: haiku-overseer-mcp

> How the `src/` of haiku-overseer works, from cold start to every tool call.

---

## 1. Source Files at a Glance

| File | Lines | Role |
|------|-------|------|
| `src/server.ts` | 643 | Entry point, MCP tool definitions, debounce/batching logic |
| `src/db.ts` | 239 | SQLite persistence layer (5 tables, 17 exported functions) |
| `src/haiku.ts` | 24 | Anthropic API client (Haiku 4.5) |
| `src/logger.ts` | 37 | Optional file-based debug logger |

---

## 2. Cold Start (server.ts:1-56)

When `node dist/server.js` runs:

```
1. Import FastMCP, zod, path, fs
2. Import all db functions from ./db.js
3. Import callHaiku from ./haiku.js
4. Import log1, log2 from ./logger.js
```

### 2a. Logger Initialization (logger.ts:8-18)

Happens at import time (module-level side effects):

```
- Read LOG_STATE env var → if "true", logging is enabled
- Read LOG_VERBOSITY_LEVEL env var → 1 (INFO) or 2 (DEBUG)
- If enabled: create/append WriteStream to .haiku-overseer/debug.log
- If disabled: logStream stays null, all log() calls are no-ops
```

### 2b. Database Setup (server.ts:22-29 → db.ts:29-72)

```
- Resolve dbPath: process.env.HAIKU_DB_PATH || cwd()/.haiku-overseer/memory.db
- Create .haiku-overseer/ directory if missing
- openDb(dbPath):
    → new Database(dbPath)                     // better-sqlite3
    → PRAGMA journal_mode = WAL                // concurrent reads during writes
    → CREATE TABLE IF NOT EXISTS prompts       // prompt+injection+haiku_response
    → CREATE TABLE IF NOT EXISTS events        // role-tagged conversation events
    → CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id)
    → CREATE TABLE IF NOT EXISTS session_summaries  // one summary per session (UNIQUE)
    → CREATE TABLE IF NOT EXISTS token_usage   // per-call input/output token counts
    → CREATE TABLE IF NOT EXISTS turns         // hook-captured raw turns (future use)
```

### 2c. Load Project Rules (server.ts:31-36)

```
- Read CLAUDE.md from CWD (if it exists)
- Store in `claudeMd` variable for injection into system prompt
```

### 2d. Build System Prompt (server.ts:38-55)

A static string telling Haiku how to behave as an overseer. If `claudeMd` is non-empty, the project's CLAUDE.md rules are appended at the end.

### 2e. Initialize Maps (server.ts:85-86)

```
inFlightSessions = new Map()   // sessionId → Promise<string> (in-progress Haiku call)
pendingBatches   = new Map()   // sessionId → { turns[], resolvers[] }
```

### 2f. Register 7 MCP Tools (server.ts:249-627)

The `FastMCP` server instance is created and 7 tools are added (detailed below).

### 2g. Start Listening (server.ts:641-642)

```
log1("haiku-overseer v3.0.0 starting")
server.start({ transportType: "stdio" })   // FastMCP listens on stdin/stdout
```

The server is now live. Claude Code communicates with it over stdio using the MCP protocol.

---

## 3. Core Execution Path: `observe_turn`

This is the tool called after **every** conversation turn. It's the hot path.

### 3.1 Entry (server.ts:287-306)

Claude Code calls `observe_turn` with:
- `session_id` (default: "default")
- `user_prompt` — what the user said
- `assistant_response` — what Claude said
- `tool_results?` — tool outputs
- `errors?` — any errors
- `files_changed?` — comma-separated file list
- `git_diff?` — diff snippet

The `execute` handler immediately delegates to `debouncedObserveTurn()`.

### 3.2 Immediate Event Storage (server.ts:163-179)

**Before any Haiku call**, all data is written to the `events` table:

```
insertEvent(db, sessionId, "user",          user_prompt)
insertEvent(db, sessionId, "assistant",     assistant_response)
insertEvent(db, sessionId, "tool_result",   tool_results)        // if present
insertEvent(db, sessionId, "error",         errors)              // if present
insertEvent(db, sessionId, "files_changed", files_changed)       // if present
insertEvent(db, sessionId, "diff",          git_diff)            // if present
```

Each `insertEvent` (db.ts:110-120) runs:
```sql
INSERT INTO events (session_id, role, content, meta) VALUES (?, ?, ?, ?)
```

### 3.3 Debounce Check (server.ts:182-195)

```
Is there an in-flight Haiku call for this sessionId?
  YES → batch this turn:
        - Get or create PendingBatch for sessionId
        - Push turn data into batch.turns[]
        - Return a new Promise; push its resolver into batch.resolvers[]
        - (This Promise won't resolve until the batch is processed later)
  NO  → proceed to step 3.4
```

### 3.4 Execute Haiku Call (server.ts:198-199 → 88-157)

```
executeHaikuCall(sessionId, [turn]):

  1. Count errors in last 5 minutes          → getErrorCount(db, sessionId, 5)
  2. Build event log (last 15 events)        → buildEventLog(sessionId)
       - getRecentEvents(db, sessionId, 15).reverse()
       - Truncate each event content to 500 chars
       - Format: "[role meta] content"

  3. Load cross-session memory               → getRecentSummaries(db, 3)
       - Up to 3 most recent session summaries
       - Prepended as "Previous session context:"

  4. Build latest turn section:
       "User: {prompt}\nAssistant: {response}"
       + optional: Tool results, Errors, Files changed, Git diff (truncated to 2000 chars)
       - If multiple batched turns, each is labeled "--- Turn N ---"

  5. Compose user message:
       {summaryContext}
       Event log:\n{eventLog}
       [WARNING if errorCount > 2]
       Latest turn:\n{latestSection}

  6. Call Haiku API                           → callHaiku(SYSTEM_PROMPT, userMsg)
```

### 3.5 Haiku API Call (haiku.ts:10-24)

```
client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  system: systemPrompt,
  messages: [{ role: "user", content: userMessage }]
})

→ Extract text from first content block
→ Return { text, usage: { input_tokens, output_tokens } }
```

### 3.6 Process Response (server.ts:134-157)

```
- Record token usage                         → insertTokenUsage(db, sessionId, in, out)

- If response.trim() === "LGTM":
    insertEvent(db, sessionId, "injection", "LGTM")
    insertPrompt(db, sessionId, prompt, null, "LGTM")
    return ""                                // empty string = no advisory

- Otherwise:
    injection = "<overseer>\n{response}\n</overseer>"
    insertEvent(db, sessionId, "injection", response)
    insertPrompt(db, sessionId, prompt, injection, response)
    return injection                         // advisory shown to Claude Code
```

### 3.7 Drain Pending Batches (server.ts:205-232)

After the Haiku call completes:

```
Was anything batched while we were waiting?
  YES → pendingBatches.delete(sessionId)
        executeHaikuCall(sessionId, batch.turns)   // one call with all batched turns
        Resolve all batch.resolvers[] with the result
        Check AGAIN for anything that queued during THIS call (recursive drain)
  NO  → inFlightSessions.delete(sessionId)
```

### 3.8 Error Handling (server.ts:235-244)

If any Haiku call throws:
- Clear `inFlightSessions` for this session
- Resolve all pending batch promises with `""` (fail silent to caller)
- Re-throw the error

---

## 4. Supporting Tools

### Tool 2: `get_session_history` (server.ts:310-346)

```
getRecentEvents(db, session_id, limit).reverse()
→ Optionally filter by role (user/assistant/error/tool_result)
→ Return JSON array of { role, content, meta, created_at }
```

### Tool 3: `get_error_summary` (server.ts:349-382)

```
getErrorCount(db, session_id, since_minutes)
getRecentEvents(db, session_id, 50) → filter role === "error" → last 10
→ Return { error_count, since_minutes, recent_errors[] }
```

### Tool 4: `get_project_rules` (server.ts:385-402)

```
Read CLAUDE.md from params.cwd or process.cwd()
→ Return file contents or "No CLAUDE.md found"
```

### Tool 5: `summarize_session` (server.ts:405-455)

```
getAllEvents(db, session_id, 100).reverse()
→ Format as "[role meta] content"
→ callHaiku("You are a concise session summarizer...", eventText)
→ upsertSessionSummary(db, session_id, summary)   // INSERT ... ON CONFLICT UPDATE
→ Return { session_id, summary }
```

### Tool 6: `export_session` (server.ts:458-558)

```
getAllEventsChronological(db, session_id)     // ORDER BY id ASC
→ Group events into turns:
    - "user" event starts a new turn
    - Subsequent assistant/tool_result/error/files_changed/diff/injection events belong to that turn
    - Orphan non-user events are rendered standalone
→ Generate Markdown with ## Turn N headers
→ Append session summary if one exists
→ Write to .haiku-overseer/{session_id}.md (or custom path)
```

### Tool 7: `get_health` (server.ts:561-627)

```
Collects:
  - DB file size (MB)
  - Total event count         → SELECT COUNT(*) FROM events
  - Total turn count          → SELECT COUNT(*) FROM turns
  - Distinct session count    → SELECT COUNT(DISTINCT session_id) FROM events
  - Token usage totals        → getTotalTokenUsage(db)
  - Estimated cost            → (input/1M * $0.80) + (output/1M * $4.00)
  - Last error                → SELECT ... FROM events WHERE role='error' ORDER BY id DESC LIMIT 1
→ Return JSON object
```

---

## 5. Shutdown (server.ts:629-639)

```
SIGTERM or SIGINT → db.close() (wrapped in try/catch to swallow errors)
```

---

## 6. Database Schema (db.ts)

```sql
prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  injection     TEXT,              -- null if LGTM
  haiku_response TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
)

events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL,     -- user|assistant|tool_result|error|injection|files_changed|diff
  content       TEXT NOT NULL,
  meta          TEXT,              -- optional JSON metadata
  created_at    TEXT DEFAULT (datetime('now'))
)
-- INDEX idx_events_session ON events(session_id, id)

session_summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL UNIQUE,
  summary       TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
)

token_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
)

turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  user_prompt       TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  created_at        TEXT DEFAULT (datetime('now'))
)
```

---

## 7. Data Flow Diagram

```
Claude Code (stdio)
       │
       ▼
  ┌─────────────┐
  │  FastMCP     │  ← parses MCP protocol messages
  │  (server.ts) │
  └──────┬───────┘
         │
         ├─── observe_turn ──► debouncedObserveTurn()
         │                          │
         │                    ┌─────┴──────┐
         │                    │ Store events│ → db.ts → SQLite (events table)
         │                    └─────┬──────┘
         │                          │
         │                    ┌─────┴──────────────┐
         │                    │ In-flight check     │
         │                    │  YES → batch & wait │
         │                    │  NO  → proceed      │
         │                    └─────┬──────────────┘
         │                          │
         │                    ┌─────┴──────────┐
         │                    │ executeHaikuCall│
         │                    │  - buildEventLog│
         │                    │  - getRecentSummaries│
         │                    │  - callHaiku()  │ → haiku.ts → Anthropic API
         │                    │  - store tokens │ → db.ts → SQLite
         │                    │  - store result │ → db.ts → SQLite
         │                    └─────┬──────────┘
         │                          │
         │                    ┌─────┴──────┐
         │                    │ Drain batch │ (if turns queued during call)
         │                    └─────┬──────┘
         │                          │
         │                    return "" or "<overseer>...</overseer>"
         │
         ├─── get_session_history ──► db.ts → SQLite
         ├─── get_error_summary ────► db.ts → SQLite
         ├─── get_project_rules ────► fs.readFileSync(CLAUDE.md)
         ├─── summarize_session ────► db.ts + haiku.ts → SQLite + Anthropic API
         ├─── export_session ───────► db.ts → SQLite → fs.writeFileSync(.md)
         └─── get_health ──────────► db.ts → SQLite (aggregation queries)
```

---

## 8. Key Design Decisions

| Decision | Why |
|----------|-----|
| **Debounce + batch** | Claude Code can fire multiple `observe_turn` calls faster than Haiku can respond. Batching prevents API flooding and reduces cost. |
| **WAL mode** | SQLite WAL allows concurrent reads while a write is in progress — important since events are stored before the Haiku call returns. |
| **Event sourcing** | Every piece of conversation data is stored as an immutable event. This enables export, summarization, and error pattern detection. |
| **Cross-session memory** | Recent session summaries are injected into the Haiku prompt, giving continuity across separate Claude Code sessions. |
| **LGTM short-circuit** | When Haiku has nothing to say, return empty string — no noise injected into the conversation. |
| **Truncation** | Event log entries capped at 500 chars, git diffs at 2000 chars — keeps Haiku input tokens manageable. |
| **stdio transport** | MCP standard for local tool servers — no HTTP overhead, works with Claude Code's native MCP integration. |

---

## 9. Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Yes | — | Authentication for Haiku API calls |
| `HAIKU_DB_PATH` | No | `.haiku-overseer/memory.db` | Custom database location |
| `LOG_STATE` | No | `false` | Enable debug logging to file |
| `LOG_VERBOSITY_LEVEL` | No | `1` | `1` = INFO, `2` = DEBUG |
