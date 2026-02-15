// hooks/statusline.cjs
// Claude Code status line: shows haiku-overseer metrics from memory.db
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const dbPath = path.join(process.cwd(), ".haiku-overseer", "memory.db");
    if (!fs.existsSync(dbPath)) {
      console.log("\x1b[35m\u{1F441} Overseer:\x1b[0m waiting for first call...");
      return;
    }

    const db = new Database(dbPath);

    const usage = db.prepare(
      "SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COUNT(*) as cnt FROM token_usage"
    ).get();
    const estCost = ((usage.inp / 1e6) * 0.8 + (usage.out / 1e6) * 4).toFixed(4);

    let turns = 0;
    try { turns = db.prepare("SELECT COUNT(*) as c FROM turns").get().c; } catch {}

    const errors = db.prepare(
      "SELECT COUNT(*) as c FROM events WHERE role='error' AND created_at > datetime('now','-5 minutes')"
    ).get().c;

    const lastInj = db.prepare(
      "SELECT content FROM events WHERE role='injection' ORDER BY id DESC LIMIT 1"
    ).get();
    const isLgtm = !lastInj || lastInj.content === "LGTM";

    const parts = [
      `\x1b[35m\u{1F441}\x1b[0m ${usage.cnt} calls \u00B7 $${estCost}`,
      `${turns} turns`,
    ];
    if (errors > 0) parts.push(`\x1b[31m${errors} err\x1b[0m`);
    if (isLgtm && lastInj) parts.push("\x1b[32m\u2713\x1b[0m");

    console.log(parts.join(" | "));

    // Show advisory content across multiple lines when last response wasn't LGTM
    if (!isLgtm && lastInj) {
      console.log(`\x1b[33m\u26A0 Last advisory:\x1b[0m`);
      const lines = lastInj.content.split("\n").filter((l) => l.trim());
      const maxLines = 8;
      const shown = lines.slice(0, maxLines);
      for (let i = 0; i < shown.length; i++) {
        const prefix = i < shown.length - 1 && !(i === maxLines - 1 && lines.length > maxLines) ? "\u251C" : "\u2514";
        const line = shown[i].trim();
        console.log(`\x1b[33m  ${prefix} ${line}\x1b[0m`);
      }
      if (lines.length > maxLines) {
        console.log(`\x1b[33m    (+${lines.length - maxLines} more lines)\x1b[0m`);
      }
    }

    db.close();
  } catch {
    console.log("\x1b[35m\u{1F441} Overseer:\x1b[0m \x1b[2munavailable\x1b[0m");
  }
});
