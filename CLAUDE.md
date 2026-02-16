# Haiku Overseer — Project Rules

## Build & Run

```bash
npm run build    # TypeScript → dist/
npm start        # Start MCP server (stdio transport)
```

## Architecture

- `src/server.ts` — FastMCP server, all tool definitions
- `src/db.ts` — SQLite (better-sqlite3) schema, queries, FTS5
- `src/haiku.ts` — Anthropic API wrapper (Haiku 4.5)
- `hooks/` — Claude Code hooks (CJS, run as subprocesses)
- `.haiku-overseer/memory.db` — project-local SQLite database

## MCP Tool Reference

### observe_turn
Call after EVERY turn. Returns advisory or empty string.
```json
{
  "tool": "observe_turn",
  "params": {
    "user_prompt": "What the user asked",
    "assistant_response": "What you responded — summary or full",
    "session_id": "default",
    "errors": "Any errors encountered",
    "files_changed": "src/foo.ts, src/bar.ts",
    "git_diff": "diff --git a/..."
  }
}
```

### get_session_history
Query conversation history for a session.
```json
{
  "tool": "get_session_history",
  "params": {
    "session_id": "default",
    "limit": 15,
    "role_filter": "all"
  }
}
```
Returns: Array of `{ role, content, meta, created_at }`.

### get_error_summary
Detect error loops or patterns.
```json
{
  "tool": "get_error_summary",
  "params": {
    "session_id": "default",
    "since_minutes": 5
  }
}
```
Returns: `{ error_count, since_minutes, recent_errors[] }`.

### get_project_rules
Read CLAUDE.md on demand.
```json
{
  "tool": "get_project_rules",
  "params": { "cwd": "/path/to/project" }
}
```

### summarize_session
Generate and store a session summary using Haiku.
```json
{
  "tool": "summarize_session",
  "params": { "session_id": "default" }
}
```
Returns: `{ session_id, summary }`.

### export_session
Export session history as Markdown.
```json
{
  "tool": "export_session",
  "params": {
    "session_id": "default",
    "output_path": "./.haiku-overseer/my-session.md"
  }
}
```

### get_health
Server health and usage stats.
```json
{
  "tool": "get_health",
  "params": {}
}
```
Returns: `{ db_size_mb, total_events, total_turns, session_count, token_usage: { total_input_tokens, total_output_tokens, estimated_cost_usd } }`.

### get_context_vars
Retrieve structured session state (files modified, errors, current task, decisions).
```json
{
  "tool": "get_context_vars",
  "params": {
    "session_id": "default",
    "var_names": ["FILES_MODIFIED", "ERROR_PATTERNS"]
  }
}
```
Returns: `{ VAR_NAME: { value, meta, updated_at } }`. Omit `var_names` for all vars.

### clear_context_vars
Clear stale context variables (e.g. after git commit).
```json
{
  "tool": "clear_context_vars",
  "params": {
    "session_id": "default",
    "var_names": ["FILES_MODIFIED", "ERROR_PATTERNS", "ERROR_LOOP"]
  }
}
```

### search_transcript
Full-text search across all session transcripts (FTS5).
```json
{
  "tool": "search_transcript",
  "params": {
    "query": "authentication error",
    "session_id": "optional-session-id",
    "limit": 10,
    "offset": 0
  }
}
```
Supports FTS5 syntax: AND, OR, NOT, prefix (`fix*`). Returns: `{ query, count, results: [{ turn_id, session_id, snippet_prompt, snippet_response, created_at }] }`.

### get_turns
Retrieve raw conversation turns, paginated.
```json
{
  "tool": "get_turns",
  "params": {
    "session_id": "default",
    "limit": 20,
    "offset": 0
  }
}
```
Returns: `{ session_id, count, offset, turns: [{ id, user_prompt, assistant_response, created_at }] }`.

### list_sessions
List all sessions with turn counts and summaries.
```json
{
  "tool": "list_sessions",
  "params": { "limit": 20 }
}
```
Returns: `{ count, sessions: [{ session_id, turn_count, first_turn, last_turn, summary }] }`.

## Workflows & Examples

### 1. Resume Previous Work

When starting a new session and the user says "continue where we left off" or you want context from prior work:

1. **List recent sessions** to find the previous one:
   ```json
   { "tool": "list_sessions", "params": { "limit": 5 } }
   ```
   → Look at `summary` and `last_turn` to identify the right session.

2. **Read the last turns** from that session:
   ```json
   { "tool": "get_turns", "params": { "session_id": "abc-123", "limit": 10, "offset": 0 } }
   ```
   → Shows full user prompts and assistant responses in chronological order. Use `offset` to paginate through longer sessions.

3. **Search for specific context** if you need to find a particular decision or file:
   ```json
   { "tool": "search_transcript", "params": { "query": "database migration", "session_id": "abc-123", "limit": 5 } }
   ```
   → Returns matching turns with `snippet_prompt` and `snippet_response` highlighted around the match.

### 2. Find How Something Was Implemented

When you need to find past decisions, code patterns, or how a feature was built across any session:

1. **Search all sessions** with FTS5 syntax:
   ```json
   { "tool": "search_transcript", "params": { "query": "authentication AND JWT", "limit": 10 } }
   ```
   → Omit `session_id` to search across all sessions. Supports:
   - `AND` / `OR` / `NOT` — e.g. `"refactor AND NOT test"`
   - Prefix matching — e.g. `"migrat*"` matches migrate, migration, migrating
   - Phrases — e.g. `"error handling"` (space-separated words are implicit AND)

2. **Drill into the matching session** for full context:
   ```json
   { "tool": "get_turns", "params": { "session_id": "found-session-id", "limit": 20 } }
   ```

### 3. Debug a Recurring Error

When an error keeps appearing and you suspect it happened before:

1. **Check current session errors**:
   ```json
   { "tool": "get_error_summary", "params": { "session_id": "default", "since_minutes": 10 } }
   ```
   → Returns `error_count` and `recent_errors[]` with content and timestamps.

2. **Search past sessions** for the same error:
   ```json
   { "tool": "search_transcript", "params": { "query": "SQLITE_BUSY OR \"database is locked\"", "limit": 10 } }
   ```
   → Find if this error appeared before and what fixed it by reading the surrounding turns.

3. **Read the fix** from the prior session:
   ```json
   { "tool": "get_turns", "params": { "session_id": "prior-session-id", "limit": 10, "offset": 15 } }
   ```
   → Paginate to the turns after the error to see the resolution.

### 4. Session Lifecycle

The full flow for a well-instrumented session:

1. **Every turn** — call `observe_turn` with the user prompt and your response:
   ```json
   {
     "tool": "observe_turn",
     "params": {
       "user_prompt": "Fix the login bug",
       "assistant_response": "Found the issue in auth.ts — the token was expired...",
       "session_id": "default",
       "files_changed": "src/auth.ts",
       "errors": "TypeError: Cannot read property 'token' of undefined"
     }
   }
   ```

2. **Check accumulated state** with context variables:
   ```json
   { "tool": "get_context_vars", "params": { "session_id": "default" } }
   ```
   → Returns all vars: `FILES_MODIFIED`, `ERROR_PATTERNS`, `CURRENT_TASK`, etc. Each has `value`, `meta`, and `updated_at`.

3. **At session end** — generate a summary for future sessions:
   ```json
   { "tool": "summarize_session", "params": { "session_id": "default" } }
   ```
   → Haiku generates a 3-5 sentence summary stored in the database. This summary appears in `list_sessions` results and is used as cross-session context for the overseer.

4. **Next session** — the summary is available via:
   ```json
   { "tool": "list_sessions", "params": { "limit": 5 } }
   ```

### 5. Cleanup After Commit

After a git commit, reset tracked file changes so context vars stay fresh:

```json
{
  "tool": "clear_context_vars",
  "params": {
    "session_id": "default",
    "var_names": ["FILES_MODIFIED", "ERROR_PATTERNS", "ERROR_LOOP"]
  }
}
```
→ Returns `{ cleared: ["FILES_MODIFIED", "ERROR_PATTERNS", "ERROR_LOOP"], message: "Cleared 3 context variable(s)" }`. Only clear what's stale — if errors are still relevant, keep `ERROR_PATTERNS`.
