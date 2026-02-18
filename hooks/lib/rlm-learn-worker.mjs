// hooks/lib/rlm-learn-worker.mjs
// Detached background worker that runs learnFromTurn deterministically.
// Spawned by capture-turn.cjs (Stop hook) so learning happens every turn,
// not only when Claude calls observe_turn.
//
// Input: JSON on stdin with { cwd, sessionId, userPrompt, assistantResponse, errors? }
// Output: none (writes to DB + debug log)

import path from "path";
import { pathToFileURL } from "url";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input);
    const { cwd, sessionId, userPrompt, assistantResponse, errors } = data;
    if (!cwd || !userPrompt) process.exit(0);

    // Resolve dist/ from the project root — use file:// URLs for Windows ESM compatibility
    const distDir = path.join(cwd, "dist");
    const dbUrl = pathToFileURL(path.join(distDir, "db.js")).href;
    const rlmUrl = pathToFileURL(path.join(distDir, "rlm.js")).href;

    // Dynamic import of compiled ESM modules
    const dbMod = await import(dbUrl);
    const rlmMod = await import(rlmUrl);

    const dbPath = path.join(cwd, ".haiku-overseer", "memory.db");
    const db = dbMod.openDb(dbPath);

    try {
      // Snapshot pre-learning state for drift detection
      const allBefore = dbMod.getAllEmbeddings(db);
      const qBefore = new Map(allBefore.map(e => [e.id, e.utility]));

      await rlmMod.learnFromTurn(db, sessionId, userPrompt, assistantResponse, errors || undefined);

      // Snapshot post-learning state and compute deltas
      const allAfter = dbMod.getAllEmbeddings(db);
      const moved = [];
      for (const chunk of allAfter) {
        const oldQ = qBefore.get(chunk.id);
        if (oldQ !== undefined && Math.abs(chunk.utility - oldQ) > 0.001) {
          moved.push({ id: chunk.id, q_old: Math.round(oldQ * 1000) / 1000, q_new: Math.round(chunk.utility * 1000) / 1000 });
        }
      }

      // Write RLM_LEARNING_RESULT context var for downstream validation
      const Database = (await import("better-sqlite3")).default;
      const cvDb = new Database(path.join(cwd, ".haiku-overseer", "memory.db"));
      cvDb.pragma("journal_mode = WAL");
      cvDb.exec(`CREATE TABLE IF NOT EXISTS context_vars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, var_name TEXT NOT NULL,
        var_value TEXT NOT NULL, var_meta TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(session_id, var_name)
      )`);
      cvDb.prepare(
        `INSERT INTO context_vars (session_id, var_name, var_value, var_meta)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, var_name)
         DO UPDATE SET var_value=excluded.var_value, var_meta=excluded.var_meta, updated_at=datetime('now')`
      ).run(
        sessionId,
        "RLM_LEARNING_RESULT",
        JSON.stringify({ chunks_moved: moved.length, new_chunks: allAfter.length - qBefore.size, deltas: moved.slice(0, 10) }),
        JSON.stringify({ chunks_moved: moved.length, timestamp: new Date().toISOString() })
      );
      cvDb.close();
    } finally {
      db.close();
    }
  } catch (err) {
    // Write errors to debug log for diagnosis
    try {
      const fs = await import("fs");
      const data = JSON.parse(input);
      const logPath = path.join(data.cwd || process.cwd(), ".haiku-overseer", "rlm-debug.log");
      fs.default.appendFileSync(logPath, `[${new Date().toISOString()}] [worker] ERROR: ${String(err)}\n`);
    } catch {
      process.stderr.write(`rlm-learn-worker error: ${String(err)}\n`);
    }
  }
  process.exit(0);
});
