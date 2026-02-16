// hooks/user-prompt-submit.cjs
// UserPromptSubmit hook: injects all context variables directly into additionalContext
const { openDb, getAllContextVars } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";

    const db = openDb(data.cwd);
    const allVars = getAllContextVars(db, sessionId);
    db.close();

    // Filter out internal vars (prefixed with _)
    const vars = allVars.filter(v => !v.var_name.startsWith("_"));
    if (vars.length === 0) process.exit(0);

    // Build full context: inject values directly (they're small enough)
    const sections = vars.map(v => {
      let value = v.var_value;
      // Pretty-print JSON values
      try {
        const parsed = JSON.parse(value);
        value = JSON.stringify(parsed, null, 2);
      } catch {}
      return `[${v.var_name}] (updated ${v.updated_at})\n${value}`;
    });

    // Build a short preview for systemMessage
    function varPreview(v) {
      if (v.var_meta) {
        try {
          const meta = JSON.parse(v.var_meta);
          const parts = [];
          if (meta.count !== undefined) parts.push(`${meta.count} items`);
          if (meta.last) parts.push(meta.last.split(/[/\\]/).pop());
          if (meta.lastTool) parts.push(meta.lastTool);
          if (meta.loop) parts.push("LOOP");
          if (meta.active !== undefined) parts.push(`${meta.active} active`);
          if (meta.warning) parts.push(meta.warning);
          if (parts.length > 0) return `[${parts.join(", ")}]`;
        } catch {}
      }
      return `${v.var_value.length}ch`;
    }

    const previews = vars.map(v => `${v.var_name} ${varPreview(v)}`).join(" · ");

    const result = {
      systemMessage: `[Overseer] ${vars.length} vars: ${previews}`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Session context:\n${sections.join("\n\n")}`,
      },
    };
    console.log(JSON.stringify(result));
  } catch {
    process.exit(0);
  }
});
