// RLM Debug Logger
// Writes to .haiku-overseer/rlm-debug.log
// Categories: chunk, embed, retrieve, skill, inject, bellman

import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), ".haiku-overseer");
const LOG_PATH = path.join(LOG_DIR, "rlm-debug.log");

let logStream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (!logStream) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  }
  return logStream;
}

export type RlmLogCategory = "chunk" | "embed" | "retrieve" | "skill" | "inject" | "bellman";

export function rlmLog(category: RlmLogCategory, message: string, data?: unknown): void {
  const stream = ensureStream();
  const ts = new Date().toISOString();
  const cat = category.toUpperCase().padEnd(8);
  const extra = data !== undefined ? ` ${JSON.stringify(data)}` : "";
  stream.write(`[${ts}] [${cat}] ${message}${extra}\n`);
}
