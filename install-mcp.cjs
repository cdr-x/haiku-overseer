#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function fail(msg) {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(1);
}

// 1. Check for ANTHROPIC_API_KEY
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "[setup] WARNING: ANTHROPIC_API_KEY is not set. The server needs it to call Haiku.\n" +
      "  Set it before running Claude Code:\n" +
      "    export ANTHROPIC_API_KEY=sk-ant-...\n"
  );
}

// 2. Install npm dependencies
log("Installing dependencies...");
try {
  execSync("npm install", { cwd: ROOT, stdio: "inherit" });
} catch {
  fail("npm install failed. Make sure Node.js and npm are installed.");
}

// 3. Build TypeScript
log("Building TypeScript...");
try {
  execSync("npx tsc", { cwd: ROOT, stdio: "inherit" });
} catch {
  fail("TypeScript build failed.");
}

// 4. Verify dist output
const serverJs = path.join(ROOT, "dist", "server.js");
if (!fs.existsSync(serverJs)) {
  fail("Missing build output: dist/server.js");
}
log("Build verified.");

// 5. Try to register MCP server with Claude Code
const serverPath = path.resolve(serverJs);
const addCmd = `claude mcp add haiku-overseer -- node "${serverPath}"`;

log("Attempting to register MCP server...");
try {
  execSync(addCmd, { stdio: "inherit" });
  log("MCP server registered successfully!");
} catch {
  log("Could not auto-register (claude CLI may not be on PATH).");
  log("Run this command manually to register:");
  console.log(`\n  ${addCmd}\n`);
}

// 6. Summary
console.log(`
============================================
  Haiku Overseer MCP Server — Setup Complete
============================================

  Server:   ${serverPath}
  Database: .haiku-overseer/memory.db (project-local)

  To register manually:
    ${addCmd}

  Make sure ANTHROPIC_API_KEY is set:
    export ANTHROPIC_API_KEY=sk-ant-...

============================================
`);
