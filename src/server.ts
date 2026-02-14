import { FastMCP } from "fastmcp";
import { z } from "zod";
import path from "path";
import fs from "fs";
import {
  openDb,
  insertEvent,
  getRecentEvents,
  getErrorCount,
  insertPrompt,
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

const server = new FastMCP({
  name: "haiku-overseer",
  version: "2.0.0",
});

// Tool 1: observe_turn — core tool, replaces /inject and /notify
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
  }),
  execute: async (params) => {
    const {
      session_id,
      user_prompt,
      assistant_response,
      tool_results,
      errors,
    } = params;

    // Log the turn
    insertEvent(db, session_id, "user", user_prompt);
    insertEvent(db, session_id, "assistant", assistant_response);
    if (tool_results) {
      insertEvent(db, session_id, "tool_result", tool_results);
    }
    if (errors) {
      insertEvent(db, session_id, "error", errors);
    }

    // Build context for Haiku
    const errorCount = getErrorCount(db, session_id, 5);
    const eventLog = buildEventLog(session_id);

    const userMsg = `Event log:\n${eventLog}\n\n${
      errorCount > 2
        ? `WARNING: ${errorCount} errors in the last 5 minutes — look for a pattern.\n\n`
        : ""
    }Latest turn:\nUser: ${user_prompt}\nAssistant: ${assistant_response}${
      tool_results ? `\nTool results: ${tool_results}` : ""
    }${errors ? `\nErrors: ${errors}` : ""}`;

    const haikuResponse = await callHaiku(SYSTEM_PROMPT, userMsg);

    // Log the overseer response
    if (haikuResponse.trim() === "LGTM") {
      insertEvent(db, session_id, "injection", "LGTM");
      insertPrompt(db, session_id, user_prompt, null, haikuResponse);
      return "";
    }

    const injection = `<overseer>\n${haikuResponse}\n</overseer>`;
    insertEvent(db, session_id, "injection", haikuResponse);
    insertPrompt(db, session_id, user_prompt, injection, haikuResponse);
    return injection;
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
    const allEvents = getRecentEvents(db, session_id, 50).reverse();
    const errorEvents = allEvents.filter((e) => e.role === "error").slice(-10);

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
