// hooks/lib/rlm-retrieve.cjs
// Hook-side retrieval helper: opens DB read-only, embeds prompt via OpenAI, cosine similarity
// Must complete within hook budget (uses OpenAI API call)

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

let openaiClient = null;

function getOpenAIClient() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) return null;
    const OpenAI = require("openai").default || require("openai");
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

async function embedText(text) {
  const client = getOpenAIClient();
  if (!client) return null;
  const response = await client.embeddings.create({
    model: "text-embedding-3-large",
    input: [text],
  });
  return new Float32Array(response.data[0].embedding);
}

function bufferToFloat32(buf) {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}

/**
 * Parse description from YAML frontmatter in a command .md file.
 * @param {string} content - file content
 * @returns {string|null}
 */
function parseCommandDescription(content) {
  const match = content.match(/^---[\s\S]*?description:\s*"?([^"\n]+)"?[\s\S]*?---/);
  return match ? match[1].trim() : null;
}

/**
 * Scan .claude/commands/*.md and match against prompt.
 * @param {string} cwd - project root
 * @param {string} userPrompt - user's prompt
 * @returns {Array<{name: string, confidence: number, description: string}>}
 */
function scanCommands(cwd, userPrompt) {
  const commandsDir = path.join(cwd, ".claude", "commands");
  const results = [];
  try {
    if (!fs.existsSync(commandsDir)) return results;
    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".md"));
    const promptLower = userPrompt.toLowerCase();
    for (const file of files) {
      const cmdName = file.replace(/\.md$/, "");
      try {
        const content = fs.readFileSync(path.join(commandsDir, file), "utf-8");
        const desc = parseCommandDescription(content);
        if (!desc) continue;
        const descWords = desc.toLowerCase().split(/\s+/);
        const matchCount = descWords.filter(w => w.length > 3 && promptLower.includes(w)).length;
        if (matchCount >= 2) {
          results.push({
            name: `/${cmdName}`,
            confidence: Math.min(0.9, 0.4 + matchCount * 0.15),
            description: desc,
          });
        }
      } catch {}
    }
  } catch {}
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

/**
 * Retrieve relevant chunks + matched skills + suggested commands for a user prompt.
 * @param {string} cwd - project root directory
 * @param {string} userPrompt - the user's prompt text
 * @returns {Promise<{chunks: Array, matchedSkill: object|null, suggestedCommands: Array, totalChunks: number}>}
 */
async function retrieve(cwd, userPrompt) {
  const dbPath = path.join(cwd, ".haiku-overseer", "memory.db");
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { chunks: [], matchedSkill: null, suggestedCommands: [], totalChunks: 0 };
  }

  try {
    // Check if rlm_chunks table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rlm_chunks'"
    ).get();
    if (!tableCheck) {
      db.close();
      return { chunks: [], matchedSkill: null, suggestedCommands: [], totalChunks: 0 };
    }

    const totalChunks = db.prepare("SELECT COUNT(*) as cnt FROM rlm_chunks").get().cnt;
    if (totalChunks === 0) {
      db.close();
      return { chunks: [], matchedSkill: null, suggestedCommands: [], totalChunks: 0 };
    }

    // Load all embeddings (memory_weight may not exist in older DBs)
    let hasMemoryWeight = false;
    try {
      const colInfo = db.prepare("PRAGMA table_info(rlm_chunks)").all();
      hasMemoryWeight = colInfo.some(c => c.name === "memory_weight");
    } catch {}
    const selectSql = hasMemoryWeight
      ? "SELECT id, embedding, utility, COALESCE(memory_weight, 1.0) as memory_weight, chunk_text, chunk_type, intent FROM rlm_chunks WHERE embedding IS NOT NULL"
      : "SELECT id, embedding, utility, 1.0 as memory_weight, chunk_text, chunk_type, intent FROM rlm_chunks WHERE embedding IS NOT NULL";
    const rows = db.prepare(selectSql).all();

    if (rows.length === 0) {
      db.close();
      return { chunks: [], matchedSkill: null, suggestedCommands: scanCommands(cwd, userPrompt), totalChunks };
    }

    // Embed the prompt via OpenAI
    let queryEmb;
    try {
      queryEmb = await embedText(userPrompt);
    } catch {
      db.close();
      return { chunks: [], matchedSkill: null, suggestedCommands: scanCommands(cwd, userPrompt), totalChunks };
    }

    if (!queryEmb) {
      db.close();
      return { chunks: [], matchedSkill: null, suggestedCommands: scanCommands(cwd, userPrompt), totalChunks };
    }

    // Phase 1: Cosine similarity with MIN_SIMILARITY floor → top 20
    // MIN_SIMILARITY enforces the MemRL two-phase structure: semantic gating before value-aware selection.
    const ALPHA = 0.6;
    const MIN_SIMILARITY = 0.25; // drop semantically irrelevant chunks before Phase 2

    const allScored = rows.map(row => {
      const emb = bufferToFloat32(row.embedding);
      const similarity = cosineSimilarity(queryEmb, emb);
      return {
        id: row.id,
        similarity: Math.round(similarity * 100) / 100,
        utility: Math.round(row.utility * 100) / 100,
        memoryWeight: row.memory_weight || 1.0,
        chunkText: row.chunk_text,
        chunkType: row.chunk_type,
        intent: row.intent,
        tokenCount: Math.ceil(row.chunk_text.split(/\s+/).length * 1.3),
      };
    });

    // Phase 1 gate: filter by similarity floor, sort, take top-K1
    const phase1 = allScored
      .filter(s => s.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);

    // Phase 2: Re-rank by combined score (α·sim + (1-α)·utility) × memory_weight, take top-K2
    // memory_weight is the Titans test-time memorization signal
    const scored = phase1.map(s => ({
      ...s,
      combinedScore: Math.round((ALPHA * s.similarity + (1 - ALPHA) * s.utility) * s.memoryWeight * 100) / 100,
    }));

    // Phase 2: Sort by combined score, take top 10
    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    const topChunks = scored.slice(0, 10);

    // Check for matched skills
    let matchedSkill = null;
    try {
      const skillCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rlm_skills'"
      ).get();
      if (skillCheck) {
        const skills = db.prepare("SELECT * FROM rlm_skills ORDER BY confidence DESC").all();
        const promptLower = userPrompt.toLowerCase();
        for (const skill of skills) {
          if (!skill.trigger_patterns || skill.confidence < 0.3) continue;
          try {
            const patterns = JSON.parse(skill.trigger_patterns);
            const matched = patterns.some(p => {
              try {
                return new RegExp(p, "i").test(userPrompt) || promptLower.includes(p.toLowerCase());
              } catch {
                return promptLower.includes(p.toLowerCase());
              }
            });
            if (matched) {
              matchedSkill = {
                name: skill.skill_name,
                confidence: skill.confidence,
                instructions: skill.instruction_template || "",
              };
              break;
            }
          } catch {}
        }
      }
    } catch {}

    db.close();

    // Write retrieved chunk IDs to context var so updateUtilities can find them
    // (hook opens DB readonly, so we use a separate writable connection for this)
    if (topChunks.length > 0) {
      try {
        const { openDb: openCvDb, upsertContextVar } = require("./context-vars.cjs");
        const cvDb = openCvDb(cwd);
        const retrievedIds = topChunks.map(c => c.id);
        upsertContextVar(
          cvDb, "default", "RETRIEVED_CHUNK_IDS",
          JSON.stringify(retrievedIds),
          JSON.stringify({ count: retrievedIds.length, timestamp: new Date().toISOString() })
        );
        // Also increment retrieval_count on retrieved chunks (writable connection)
        const writeDb = new Database(path.join(cwd, ".haiku-overseer", "memory.db"));
        writeDb.pragma("journal_mode = WAL");
        const incrStmt = writeDb.prepare("UPDATE rlm_chunks SET retrieval_count = retrieval_count + 1 WHERE id = ?");
        for (const id of retrievedIds) {
          incrStmt.run(id);
        }
        writeDb.close();
        cvDb.close();
      } catch {
        // Non-critical — don't block retrieval
      }
    }

    // Build suggestedCommands: merge DB skill match + file-based command scan
    const suggestedCommands = scanCommands(cwd, userPrompt);
    if (matchedSkill && !suggestedCommands.some(c => c.name === `/${matchedSkill.name}`)) {
      suggestedCommands.unshift({
        name: `/${matchedSkill.name}`,
        confidence: matchedSkill.confidence,
        description: matchedSkill.instructions ? matchedSkill.instructions.slice(0, 100) : "",
      });
    }
    return { chunks: topChunks, matchedSkill, suggestedCommands, totalChunks };
  } catch (err) {
    try { db.close(); } catch {}
    return { chunks: [], matchedSkill: null, suggestedCommands: [], totalChunks: 0 };
  }
}

module.exports = { retrieve };
