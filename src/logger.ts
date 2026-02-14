// Logger with LOG_STATE and LOG_VERBOSITY_LEVEL env var control
// LOG_STATE=true to enable logging, LOG_VERBOSITY_LEVEL=1 or 2 (2 = most verbose)

const logEnabled = process.env.LOG_STATE === "true";
const verbosity = parseInt(process.env.LOG_VERBOSITY_LEVEL || "1", 10) as 1 | 2;

function timestamp(): string {
  return new Date().toISOString();
}

export function log(level: 1 | 2, ...args: unknown[]): void {
  if (!logEnabled || level > verbosity) return;
  const prefix = level === 1 ? "[INFO]" : "[DEBUG]";
  console.error(`${timestamp()} ${prefix}`, ...args);
}

export function log1(...args: unknown[]): void {
  log(1, ...args);
}

export function log2(...args: unknown[]): void {
  log(2, ...args);
}
