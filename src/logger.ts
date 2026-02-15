// Logger with LOG_STATE and LOG_VERBOSITY_LEVEL env var control
// LOG_STATE=true to enable logging, LOG_VERBOSITY_LEVEL=1 or 2 (2 = most verbose)
// Writes to .haiku-overseer/debug.log

import fs from "fs";
import path from "path";

const logEnabled = process.env.LOG_STATE === "true";
const verbosity = parseInt(process.env.LOG_VERBOSITY_LEVEL || "1", 10) as 1 | 2;

let logStream: fs.WriteStream | null = null;

if (logEnabled) {
  const logDir = path.join(process.cwd(), ".haiku-overseer");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "debug.log");
  logStream = fs.createWriteStream(logPath, { flags: "a" });
}

function timestamp(): string {
  return new Date().toISOString();
}

export function log(level: 1 | 2, ...args: unknown[]): void {
  if (!logEnabled || level > verbosity || !logStream) return;
  const prefix = level === 1 ? "[INFO]" : "[DEBUG]";
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logStream.write(`${timestamp()} ${prefix} ${msg}\n`);
}

export function log1(...args: unknown[]): void {
  log(1, ...args);
}

export function log2(...args: unknown[]): void {
  log(2, ...args);
}
