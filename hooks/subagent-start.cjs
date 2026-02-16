// hooks/subagent-start.cjs
// SubagentStart hook: logs when sub-agents (Task tool) spawn
const { openDb, upsertContextVar, getContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const agentId = data.agent_id || "unknown";
    const agentType = data.agent_type || data.subagent_type || "unknown";

    const db = openDb(data.cwd);

    // Load existing subagent tracking
    let subagents = {};
    const existing = getContextVar(db, sessionId, "SUBAGENTS");
    if (existing) {
      try { subagents = JSON.parse(existing.var_value); } catch {}
    }

    subagents[agentId] = {
      type: agentType,
      status: "running",
      started_at: new Date().toISOString(),
    };

    const activeCount = Object.values(subagents).filter((s) => s.status === "running").length;
    upsertContextVar(
      db,
      sessionId,
      "SUBAGENTS",
      JSON.stringify(subagents),
      JSON.stringify({ active: activeCount, total: Object.keys(subagents).length })
    );

    db.close();

    console.log(JSON.stringify({
      systemMessage: `[Overseer] Subagent spawned: ${agentType} (${activeCount} active)`,
    }));
  } catch {
    process.exit(0);
  }
});
