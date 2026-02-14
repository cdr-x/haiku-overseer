import { FastMCP } from "fastmcp";
import { z } from "zod";
import path from "path";
import fs from "fs";
import {
  openDb,
  insertEvent,
  getRecentEvents,
  getAllEvents,
  getAllEventsChronological,
  getErrorCount,
  insertPrompt,
  upsertSessionSummary,
  getSessionSummary,
  getRecentSummaries,
  insertTokenUsage,
  getTotalTokenUsage,
} from "./db.js";
import { callHaiku } from "./haiku.js";

// Database: project-local or HAIKU_DB_PATH env var
const dbPath =
  process.env.HAIKU_DB_PATH ||
  path.join(process.cwd(), ".haiku-overseer", "memory.db");
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = openDb(dbPath);

// Read project CLAUDE.md
let claudeMd = "";
const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
if (fs.existsSync(claudeMdPath)) {
  claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
}

const SYSTEM_PROMPT = `You are an expert overseer watching a developer's Claude Code session in real time.

Your job:
- Watch the full conversation (user prompts + assistant responses + tool results)
- Notice mistakes, errors, anti-patterns, or risky operations BEFORE they snowball
- Suggest improvements, better approaches, or things the user may have missed
- When errors occur repeatedly, identify the root cause pattern
- Flag security issues, performance problems, or architectural concerns
- Be proactive: if you see a direction heading toward trouble, warn early
- Keep recommendations concise and actionable (under 150 words)
- If everything looks fine, say so briefly — don't inject noise
- When files_changed is provided, check if tests should have been run
- When git_diff is provided, scan for secrets, overly broad changes, or removed test coverage
- You may reference previous session summaries for continuity

You will receive the recent conversation log and the latest turn.
Respond with a short advisory block. Focus on what's most important RIGHT NOW.
If there's nothing useful to add, respond with just: "LGTM"${claudeMd ? `\n\nProject rules (CLAUDE.md):\n${claudeMd}` : ""}`;

function buildEventLog(sessionId: string): string {
  const events = getRecentEvents(db, sessionId, 15).reverse();
  if (events.length === 0) return "(no prior events)";

  return events
    .map((e) => {
      const meta = e.meta ? ` [${e.meta}]` : "";
      const content =
        e.content.length > 500 ? e.content.slice(0, 500) + "..." : e.content;
      return `[${e.role}${meta}] ${content}`;
    })
    .join("\n");
}

// --- Debounce / Batching for rapid observe_turn calls ---

interface PendingBatch {
  turns: Array<{
    user_prompt: string;
    assistant_response: string;
    tool_results?: string;
    errors?: string;
    files_changed?: string;
    git_diff?: string;
  }>;
  resolvers: Array<(value: string) => void>;
}

const inFlightSessions = new Map<string, Promise<string>>();
const pendingBatches = new Map<string, PendingBatch>();

async function executeHaikuCall(
  sessionId: string,
  turns: PendingBatch["turns"]
): Promise<string> {
  const errorCount = getErrorCount(db, sessionId, 5);
  const eventLog = buildEventLog(sessionId);

  // Load recent session summaries for cross-session context
  const summaries = getRecentSummaries(db, 3);
  let summaryContext = "";
  if (summaries.length > 0) {
    summaryContext =
      "Previous session context:\n" +
      summaries
        .map((s) => `[${s.session_id}] ${s.summary}`)
        .join("\n") +
      "\n\n";
  }

  // Build latest turns section
  const latestSection = turns
    .map((t, i) => {
      let section = `User: ${t.user_prompt}\nAssistant: ${t.assistant_response}`;
      if (t.tool_results) section += `\nTool results: ${t.tool_results}`;
      if (t.errors) section += `\nErrors: ${t.errors}`;
      if (t.files_changed) section += `\nFiles changed: ${t.files_changed}`;
      if (t.git_diff) {
        const truncatedDiff =
          t.git_diff.length > 2000
            ? t.git_diff.slice(0, 2000) + "...(truncated)"
            : t.git_diff;
        section += `\nGit diff:\n${truncatedDiff}`;
      }
      return turns.length > 1 ? `--- Turn ${i + 1} ---\n${section}` : section;
    })
    .join("\n\n");

  const userMsg = `${summaryContext}Event log:\n${eventLog}\n\n${
    errorCount > 2
      ? `WARNING: ${errorCount} errors in the last 5 minutes — look for a pattern.\n\n`
      : ""
  }Latest turn${turns.length > 1 ? "s" : ""}:\n${latestSection}`;

  const { text: haikuResponse, usage } = await callHaiku(SYSTEM_PROMPT, userMsg);
  insertTokenUsage(db, sessionId, usage.input_tokens, usage.output_tokens);

  // Log the overseer response
  const firstTurn = turns[0];
  if (haikuResponse.trim() === "LGTM") {
    insertEvent(db, sessionId, "injection", "LGTM");
    insertPrompt(db, sessionId, firstTurn.user_prompt, null, haikuResponse);
    return "";
  }

  const injection = `<overseer>\n${haikuResponse}\n</overseer>`;
  insertEvent(db, sessionId, "injection", haikuResponse);
  insertPrompt(
    db,
    sessionId,
    firstTurn.user_prompt,
    injection,
    haikuResponse
  );
  return injection;
}

async function debouncedObserveTurn(
  sessionId: string,
  turn: PendingBatch["turns"][0]
): Promise<string> {
  // Always store events immediately (full content, no truncation)
  insertEvent(db, sessionId, "user", turn.user_prompt);
  insertEvent(db, sessionId, "assistant", turn.assistant_response);
  if (turn.tool_results) {
    insertEvent(db, sessionId, "tool_result", turn.tool_results);
  }
  if (turn.errors) {
    insertEvent(db, sessionId, "error", turn.errors);
  }
  if (turn.files_changed) {
    insertEvent(db, sessionId, "files_changed", turn.files_changed);
  }
  if (turn.git_diff) {
    insertEvent(db, sessionId, "diff", turn.git_diff);
  }

  // Check if a Haiku call is already in-flight for this session
  const existing = inFlightSessions.get(sessionId);
  if (existing) {
    // Batch this turn — it will be processed after the in-flight call returns
    let batch = pendingBatches.get(sessionId);
    if (!batch) {
      batch = { turns: [], resolvers: [] };
      pendingBatches.set(sessionId, batch);
    }
    batch.turns.push(turn);
    return new Promise<string>((resolve) => {
      batch!.resolvers.push(resolve);
    });
  }

  // First call in a quiet period — fire immediately
  const promise = executeHaikuCall(sessionId, [turn]);
  inFlightSessions.set(sessionId, promise);

  try {
    const result = await promise;

    // Check if there are pending batched calls
    const batch = pendingBatches.get(sessionId);
    if (batch && batch.turns.length > 0) {
      pendingBatches.delete(sessionId);
      // Fire one more Haiku call with combined context
      const batchPromise = executeHaikuCall(sessionId, batch.turns);
      inFlightSessions.set(sessionId, batchPromise);
      try {
        const batchResult = await batchPromise;
        // Resolve all pending promises with the same result
        for (const resolve of batch.resolvers) {
          resolve(batchResult);
        }
      } finally {
        inFlightSessions.delete(sessionId);
        // Handle any calls that arrived during the batch call
        const nextBatch = pendingBatches.get(sessionId);
        if (nextBatch && nextBatch.turns.length > 0) {
          pendingBatches.delete(sessionId);
          const nextPromise = executeHaikuCall(sessionId, nextBatch.turns);
          nextPromise.then((r) => {
            for (const resolve of nextBatch.resolvers) resolve(r);
          });
        }
      }
    } else {
      inFlightSessions.delete(sessionId);
    }

    return result;
  } catch (err) {
    inFlightSessions.delete(sessionId);
    // Resolve any pending batches with error
    const batch = pendingBatches.get(sessionId);
    if (batch) {
      pendingBatches.delete(sessionId);
      for (const resolve of batch.resolvers) resolve("");
    }
    throw err;
  }
}

// --- Server setup ---

const server = new FastMCP({
  name: "haiku-overseer",
  version: "3.0.0",
});

// Tool 1: observe_turn — core tool with debounce, file tracking, diff support
server.addTool({
  name: "observe_turn",
  description:
    "Call this after EVERY turn to let the Haiku overseer observe the conversation. " +
    "Provide the user's prompt and your response. Returns advisory feedback if the " +
    "overseer spots issues, errors, or suggestions. Returns empty string if all looks good.",
  parameters: z.object({
    session_id: z
      .string()
      .default("default")
      .describe("Session identifier to group turns into a conversation"),
    user_prompt: z.string().describe("What the user asked"),
    assistant_response: z
      .string()
      .describe("What you (Claude) responded — summary or full"),
    tool_results: z
      .string()
      .optional()
      .describe("Any tool outputs from this turn"),
    errors: z
      .string()
      .optional()
      .describe("Any errors encountered during this turn"),
    files_changed: z
      .string()
      .optional()
      .describe("Comma-separated list of files modified this turn"),
    git_diff: z
      .string()
      .optional()
      .describe("Git diff snippet of changes made this turn"),
  }),
  execute: async (params) => {
    const {
      session_id,
      user_prompt,
      assistant_response,
      tool_results,
      errors,
      files_changed,
      git_diff,
    } = params;

    return debouncedObserveTurn(session_id, {
      user_prompt,
      assistant_response,
      tool_results,
      errors,
      files_changed,
      git_diff,
    });
  },
});

// Tool 2: get_session_history — query past conversation
server.addTool({
  name: "get_session_history",
  description:
    "Query the conversation history for a session. Useful for reviewing what happened earlier or in previous sessions.",
  parameters: z.object({
    session_id: z.string().default("default").describe("Session to query"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Number of events to return"),
    role_filter: z
      .enum(["all", "user", "assistant", "error", "tool_result"])
      .default("all")
      .describe("Filter events by role"),
  }),
  execute: async (params) => {
    const { session_id, limit, role_filter } = params;
    let events = getRecentEvents(db, session_id, limit).reverse();

    if (role_filter !== "all") {
      events = events.filter((e) => e.role === role_filter);
    }

    return JSON.stringify(
      events.map((e) => ({
        role: e.role,
        content: e.content,
        meta: e.meta,
        created_at: e.created_at,
      })),
      null,
      2
    );
  },
});

// Tool 3: get_error_summary — error pattern detection
server.addTool({
  name: "get_error_summary",
  description:
    "Count and summarize recent errors to detect loops or patterns.",
  parameters: z.object({
    session_id: z.string().default("default").describe("Session to query"),
    since_minutes: z
      .number()
      .default(5)
      .describe("Look back this many minutes for errors"),
  }),
  execute: async (params) => {
    const { session_id, since_minutes } = params;
    const count = getErrorCount(db, session_id, since_minutes);

    // Fetch recent error events for content
    const allEvts = getRecentEvents(db, session_id, 50).reverse();
    const errorEvents = allEvts.filter((e) => e.role === "error").slice(-10);

    return JSON.stringify(
      {
        error_count: count,
        since_minutes,
        recent_errors: errorEvents.map((e) => ({
          content: e.content,
          meta: e.meta,
          created_at: e.created_at,
        })),
      },
      null,
      2
    );
  },
});

// Tool 4: get_project_rules — exposes CLAUDE.md
server.addTool({
  name: "get_project_rules",
  description: "Read the project's CLAUDE.md rules file on demand.",
  parameters: z.object({
    cwd: z
      .string()
      .optional()
      .describe("Directory to read CLAUDE.md from (defaults to server CWD)"),
  }),
  execute: async (params) => {
    const dir = params.cwd || process.cwd();
    const filePath = path.join(dir, "CLAUDE.md");
    if (!fs.existsSync(filePath)) {
      return "No CLAUDE.md found in " + dir;
    }
    return fs.readFileSync(filePath, "utf-8");
  },
});

// Tool 5: summarize_session — generate and store session summary
server.addTool({
  name: "summarize_session",
  description:
    "Summarize a session's conversation history using Haiku. Stores the summary for cross-session memory.",
  parameters: z.object({
    session_id: z
      .string()
      .default("default")
      .describe("Session to summarize"),
  }),
  execute: async (params) => {
    const { session_id } = params;
    const events = getAllEvents(db, session_id, 100).reverse();

    if (events.length === 0) {
      return "No events found for session: " + session_id;
    }

    const eventText = events
      .map((e) => {
        const meta = e.meta ? ` [${e.meta}]` : "";
        return `[${e.role}${meta}] ${e.content}`;
      })
      .join("\n");

    const summaryPrompt = `Summarize the following coding session concisely (3-5 sentences). Focus on:
- What was the user working on?
- What was accomplished?
- Were there any unresolved issues or errors?
- Any important decisions or patterns?

Session events:
${eventText}`;

    const { text: summary, usage } = await callHaiku(
      "You are a concise session summarizer. Produce a brief summary of the coding session.",
      summaryPrompt
    );
    insertTokenUsage(db, session_id, usage.input_tokens, usage.output_tokens);

    upsertSessionSummary(db, session_id, summary);

    return JSON.stringify(
      { session_id, summary },
      null,
      2
    );
  },
});

// Tool 6: export_session — export session as markdown
server.addTool({
  name: "export_session",
  description:
    "Export a session's full history as a readable Markdown file.",
  parameters: z.object({
    session_id: z
      .string()
      .default("default")
      .describe("Session to export"),
    output_path: z
      .string()
      .optional()
      .describe(
        "Output file path (defaults to ./.haiku-overseer/{session_id}.md)"
      ),
  }),
  execute: async (params) => {
    const { session_id, output_path } = params;
    const events = getAllEventsChronological(db, session_id);

    if (events.length === 0) {
      return "No events found for session: " + session_id;
    }

    const filePath =
      output_path ||
      path.join(
        process.cwd(),
        ".haiku-overseer",
        `${session_id}.md`
      );
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

    const now = new Date().toISOString();
    let md = `# Session: ${session_id}\n*Exported: ${now}*\n\n`;

    // Group events into turns
    let turnNum = 0;
    let i = 0;
    while (i < events.length) {
      const e = events[i];

      if (e.role === "user") {
        turnNum++;
        md += `## Turn ${turnNum}\n`;
        md += `**User:** ${e.content}\n\n`;
        i++;

        // Collect associated events for this turn
        while (i < events.length && events[i].role !== "user") {
          const next = events[i];
          switch (next.role) {
            case "assistant":
              md += `**Assistant:** ${next.content}\n\n`;
              break;
            case "tool_result":
              md += `**Tool result:** ${next.content}\n\n`;
              break;
            case "error":
              md += `**Error:** ${next.content}\n\n`;
              break;
            case "files_changed":
              md += `**Files changed:** ${next.content}\n\n`;
              break;
            case "diff":
              md += `**Diff:**\n\`\`\`diff\n${next.content}\n\`\`\`\n\n`;
              break;
            case "injection":
              md += `> **Overseer:** ${next.content}\n\n`;
              break;
            default:
              md += `**${next.role}:** ${next.content}\n\n`;
              break;
          }
          i++;
        }
      } else {
        // Orphan event (not preceded by user)
        switch (e.role) {
          case "injection":
            md += `> **Overseer:** ${e.content}\n\n`;
            break;
          default:
            md += `**${e.role}:** ${e.content}\n\n`;
            break;
        }
        i++;
      }
    }

    // Append session summary if one exists
    const summary = getSessionSummary(db, session_id);
    if (summary) {
      md += `---\n\n## Session Summary\n${summary}\n`;
    }

    fs.writeFileSync(filePath, md, "utf-8");
    return `Exported ${events.length} events to: ${filePath}`;
  },
});

// Tool 7: get_health — server health and stats
server.addTool({
  name: "get_health",
  description:
    "Get health and usage statistics for the haiku-overseer server.",
  parameters: z.object({}),
  execute: async () => {
    // DB file size
    let dbSizeMb = 0;
    try {
      const stat = fs.statSync(dbPath);
      dbSizeMb = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
    } catch {}

    // Total events
    const totalEvents = (
      db.prepare(`SELECT COUNT(*) as cnt FROM events`).get() as { cnt: number }
    ).cnt;

    // Total turns (hook-captured)
    let totalTurns = 0;
    try {
      totalTurns = (
        db.prepare(`SELECT COUNT(*) as cnt FROM turns`).get() as { cnt: number }
      ).cnt;
    } catch {}

    // Session count
    const sessionCount = (
      db.prepare(`SELECT COUNT(DISTINCT session_id) as cnt FROM events`).get() as { cnt: number }
    ).cnt;

    // Token usage
    const tokenUsage = getTotalTokenUsage(db);
    const estimatedCost =
      (tokenUsage.total_input / 1_000_000) * 0.8 +
      (tokenUsage.total_output / 1_000_000) * 4;

    // Last error
    let lastError: { content: string; created_at: string } | null = null;
    const errorRow = db
      .prepare(
        `SELECT content, created_at FROM events WHERE role = 'error' ORDER BY id DESC LIMIT 1`
      )
      .get() as { content: string; created_at: string } | undefined;
    if (errorRow) lastError = errorRow;

    return JSON.stringify(
      {
        db_size_mb: dbSizeMb,
        total_events: totalEvents,
        total_turns: totalTurns,
        session_count: sessionCount,
        token_usage: {
          total_input_tokens: tokenUsage.total_input,
          total_output_tokens: tokenUsage.total_output,
          total_api_calls: tokenUsage.call_count,
          estimated_cost_usd:
            Math.round(estimatedCost * 10000) / 10000,
        },
        last_error: lastError,
      },
      null,
      2
    );
  },
});

// Graceful shutdown
process.on("SIGTERM", () => {
  try {
    db.close();
  } catch {}
});
process.on("SIGINT", () => {
  try {
    db.close();
  } catch {}
});

server.start({ transportType: "stdio" });
