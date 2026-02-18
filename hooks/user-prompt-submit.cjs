// hooks/user-prompt-submit.cjs
// UserPromptSubmit hook: injects context variables + RLM context into additionalContext
const { openDb, getAllContextVars, getContextVar, upsertContextVar, deleteContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const userPrompt = data.prompt || data.user_prompt || "";

    const db = openDb(data.cwd);
    const allVars = getAllContextVars(db, sessionId);

    // Filter out internal vars (prefixed with _) and internal-only signal vars
    const internalVars = new Set(["RLM_LEARNING_RESULT", "LAST_INJECTED_CHUNKS"]);
    const vars = allVars.filter(v => !v.var_name.startsWith("_") && !internalVars.has(v.var_name));

    // Build context variable sections
    const sections = vars.map(v => {
      let value = v.var_value;
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

    // RLM retrieval (async, with timeout)
    let rlmContext = "";
    let rlmPreview = "";
    let suggestedCommands = null; // hoisted for SUGGESTED_COMMANDS persistence
    if (userPrompt) {
      try {
        const { retrieve } = require("./lib/rlm-retrieve.cjs");
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RLM timeout")), 2000)
        );
        const retrievalPromise = retrieve(data.cwd || process.cwd(), userPrompt);
        const rlmResult = await Promise.race([retrievalPromise, timeoutPromise]);

        const hasChunks = rlmResult && rlmResult.chunks && rlmResult.chunks.length > 0;
        const hasCommands = rlmResult && rlmResult.suggestedCommands && rlmResult.suggestedCommands.length > 0;

        if (hasCommands) {
          suggestedCommands = rlmResult.suggestedCommands;
        }

        if (hasChunks || hasCommands) {
          // Build <rlm-context> XML block
          let varSection = "";
          if (hasChunks) {
            const varEntries = rlmResult.chunks.map(c =>
              `    <var id="${c.id}" type="${c.chunkType || 'unknown'}" similarity="${c.similarity}" utility="${c.utility}" tokens="${c.tokenCount}">${(c.intent || c.chunkText.slice(0, 200)).replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]))}</var>`
            ).join("\n");
            varSection = `\n  <variables count="${rlmResult.chunks.length}" total_chunks="${rlmResult.totalChunks}">\n${varEntries}\n  </variables>`;
          }

          // Build <commands> section from suggestedCommands
          let commandsSection = "";
          if (hasCommands) {
            const cmdEntries = rlmResult.suggestedCommands.map(cmd => {
              const safeDesc = (cmd.description || "").replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
              return `    <cmd name="${cmd.name}" confidence="${cmd.confidence}" description="${safeDesc}"/>`;
            }).join("\n");
            commandsSection = `\n  <commands>\n${cmdEntries}\n  </commands>`;

            // Add suggestion text for the top command
            const topCmd = rlmResult.suggestedCommands[0];
            if (topCmd.confidence >= 0.5) {
              commandsSection += `\n  <suggestion>Consider running ${topCmd.name} for this task.</suggestion>`;
            }
          }

          // Build instructions summary from top chunks
          let instructionsSection = "";
          if (hasChunks) {
            const topIntents = rlmResult.chunks
              .filter(c => c.combinedScore > 0.3)
              .slice(0, 5)
              .map(c => c.intent || c.chunkText.slice(0, 100))
              .join("; ");
            if (topIntents) {
              instructionsSection = `\n  <instructions>\n    Based on ${rlmResult.chunks.length} relevant prior interactions. Key context: ${topIntents}\n  </instructions>`;
            }
          }

          rlmContext = `<rlm-context>${varSection}${commandsSection}${instructionsSection}\n</rlm-context>`;

          rlmPreview = `RLM: ${rlmResult.chunks ? rlmResult.chunks.length : 0}/${rlmResult.totalChunks} chunks`;
          if (hasCommands) {
            rlmPreview += `, cmds: ${rlmResult.suggestedCommands.map(c => c.name).join(",")}`;
          }

          // Drift detection: compare current injected chunks against previous turn
          if (hasChunks) {
            try {
              const currentIds = rlmResult.chunks.map(c => c.id);
              const prevVar = getContextVar(db, sessionId, "LAST_INJECTED_CHUNKS");
              let driftSummary = "";
              if (prevVar) {
                const prevIds = JSON.parse(prevVar.var_value);
                const prevSet = new Set(prevIds);
                const currSet = new Set(currentIds);
                const added = currentIds.filter(id => !prevSet.has(id));
                const removed = prevIds.filter(id => !currSet.has(id));
                const retained = currentIds.filter(id => prevSet.has(id));
                const overlapPct = prevIds.length > 0
                  ? Math.round((retained.length / prevIds.length) * 100)
                  : 0;
                driftSummary = `drift: ${added.length} new/${removed.length} dropped (${overlapPct}% overlap)`;
                rlmPreview += `, ${driftSummary}`;
              }

              // Read RLM_LEARNING_RESULT for learning summary
              const learnVar = getContextVar(db, sessionId, "RLM_LEARNING_RESULT");
              if (learnVar) {
                try {
                  const learn = JSON.parse(learnVar.var_value);
                  const learnSummary = `learning: ${learn.chunks_moved} chunks moved`;
                  rlmPreview += `, ${learnSummary}`;
                } catch {}
              }

              // Write current chunk IDs for next turn's drift comparison
              upsertContextVar(
                db, sessionId, "LAST_INJECTED_CHUNKS",
                JSON.stringify(currentIds),
                JSON.stringify({ count: currentIds.length, timestamp: new Date().toISOString() })
              );
            } catch {}
          }
        }
      } catch {
        // RLM retrieval failed silently — don't block the hook
      }
    }

    // Persist SUGGESTED_COMMANDS for downstream hooks (capture-turn, post-tool-use)
    try {
      if (suggestedCommands && suggestedCommands.length > 0) {
        const highConfCmds = suggestedCommands.filter(c => c.confidence >= 0.5);
        if (highConfCmds.length > 0) {
          upsertContextVar(
            db, sessionId, "SUGGESTED_COMMANDS",
            JSON.stringify(highConfCmds.map(c => ({ name: c.name, confidence: c.confidence, description: c.description || "" }))),
            JSON.stringify({ count: highConfCmds.length, top: highConfCmds[0].name })
          );
        } else {
          deleteContextVar(db, sessionId, "SUGGESTED_COMMANDS");
        }
      } else {
        deleteContextVar(db, sessionId, "SUGGESTED_COMMANDS");
      }
    } catch {}
    db.close();

    // Combine all context
    const contextParts = [];
    if (sections.length > 0) {
      contextParts.push(`Session context:\n${sections.join("\n\n")}`);
    }
    if (rlmContext) {
      contextParts.push(rlmContext);
    }

    if (contextParts.length === 0) process.exit(0);

    const previews = vars.map(v => `${v.var_name} ${varPreview(v)}`).join(" · ");
    const systemParts = [];
    if (vars.length > 0) systemParts.push(`${vars.length} vars: ${previews}`);
    if (rlmPreview) systemParts.push(rlmPreview);

    const output = {
      systemMessage: `[Overseer] ${systemParts.join(" | ")}`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: contextParts.join("\n\n"),
      },
    };
    console.log(JSON.stringify(output));
  } catch {
    process.exit(0);
  }
});
