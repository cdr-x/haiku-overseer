// Core RLM Processor
// Learning pipeline, two-phase MemRL retrieval, Bellman EMA utility updates, skill creation
// Uses OpenAI text-embedding-3-large (3072D) exclusively

import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { chunkTurn } from "./chunking.js";
import {
  embedBatch,
  embedSingle,
  cosineSimilarity,
  float32ToBuffer,
  bufferToFloat32,
  surpriseScore,
  clusterDensity,
  knnQEstimate,
  trajectoryDrift,
  centroid,
} from "./embeddings.js";
import { convergentExchange, setPersistentContext } from "./haiku.js";
import { COMPOSITE_SKILL, CONVERGENT_ROUND_SCHEMA } from "./paper-formulas.js";
import {
  insertChunk,
  getChunkByHash,
  updateChunkEmbedding,
  getAllEmbeddings,
  getChunksByIds,
  updateChunkUtility,
  incrementChunkRetrieval,
  incrementChunkSuccess,
  updateChunkMemoryWeight,
  getTotalChunkCount,
  insertBellmanLog,
  getRecentBellmanRewards,
  insertOrUpdateSkill,
  getAllSkills,
  updateSkillUsage,
  updateSkillConfidence,
  getTopRetrievedIntents,
  getContextVar,
} from "./db.js";
import { rlmLog } from "./rlm-debug.js";

const anthropicClient = new Anthropic();

// --- EMA / Bellman hyperparameters ---
// #9 DAPO: Decoupled update rates — asymmetric EMA for positive/negative rewards
const EMA_ALPHA_UP = 0.18;     // Positive reward learning rate (explore faster)
const EMA_ALPHA_DOWN = 0.12;   // Negative reward learning rate (preserve learned value)
const RAW_REWARD_SUCCESS = 0.3;   // Base positive reward signal
const RAW_REWARD_FAILURE = -0.3;  // Base negative reward signal
const REWARD_NORM_EPSILON = 0.1;  // Floor for std to prevent division explosion

// #7: Time decay on utility during retrieval
const TIME_DECAY_LAMBDA = 0.01;   // Half-life ~70 days

// --- Session state (module-level) ---
// #1: Track last matched skill per session for correct EMA targeting
const lastMatchedSkill = new Map<string, string>();
// #3: Titans surprise momentum per session
const surpriseMomentum = new Map<string, number>();
const SURPRISE_MOMENTUM_DECAY = 0.7; // η: decay rate for surprise momentum

// --- DAPO group-relative reward normalization ---
// Normalizes raw reward as z-score against recent reward history.
// Prevents utility drift by keeping rewards calibrated to the local batch.
function normalizeReward(db: Database.Database, rawReward: number): number {
  const recentRewards = getRecentBellmanRewards(db, 20);
  if (recentRewards.length < 3) return rawReward; // not enough history, use raw

  const mean = recentRewards.reduce((s, r) => s + r, 0) / recentRewards.length;
  const variance = recentRewards.reduce((s, r) => s + (r - mean) ** 2, 0) / recentRewards.length;
  const std = Math.sqrt(variance);

  // z-score normalization with epsilon floor, clamped to [-1, 1]
  const normalized = (rawReward - mean) / (std + REWARD_NORM_EPSILON);
  return Math.max(-1, Math.min(1, normalized));
}

// --- Turn counter for skill creation ---
const sessionTurnCounters = new Map<string, number>();

// --- Learning: called fire-and-forget from observe_turn ---

export async function learnFromTurn(
  db: Database.Database,
  sessionId: string,
  userPrompt: string,
  assistantResponse: string,
  errors?: string
): Promise<void> {
  const turnNumber = (sessionTurnCounters.get(sessionId) || 0) + 1;
  sessionTurnCounters.set(sessionId, turnNumber);

  try {
    // 1. Chunk the turn
    const chunks = chunkTurn(userPrompt, assistantResponse, errors);
    rlmLog("chunk", `Turn ${turnNumber}: ${chunks.length} chunks produced`, {
      sessionId,
      types: chunks.map((c) => c.type),
    });

    if (chunks.length === 0) return;

    // 2. Deduplicate and insert new chunks
    const newChunks: Array<{ id: number; text: string; index: number }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const existing = getChunkByHash(db, chunk.hash);
      if (existing) {
        rlmLog("chunk", `Dedup: chunk hash ${chunk.hash.slice(0, 8)} already exists`);
        continue;
      }
      const id = insertChunk(
        db,
        sessionId,
        turnNumber,
        chunk.intent || null,
        chunk.text,
        chunk.hash,
        chunk.type,
        chunk.tokenCount
      );
      if (id > 0) {
        newChunks.push({ id, text: chunk.text, index: i });
      }
    }

    if (newChunks.length === 0) {
      rlmLog("chunk", "All chunks were duplicates, skipping embeddings");
      await createOrUpdateSkill(db, sessionId).catch((e) =>
        rlmLog("skill", `Skill creation failed: ${String(e)}`)
      );
      return;
    }

    rlmLog("embed", `Embedding ${newChunks.length} new chunks via OpenAI`);

    // 3. Embed with OpenAI (batch) and store
    const texts = newChunks.map((c) => c.text);
    try {
      const embeddings = await embedBatch(texts);
      for (let i = 0; i < newChunks.length; i++) {
        updateChunkEmbedding(db, newChunks[i].id, float32ToBuffer(embeddings[i]));
      }
      rlmLog("embed", `Stored ${newChunks.length} embeddings (3072D)`);
    } catch (err) {
      rlmLog("embed", `Embedding failed: ${String(err)}`);
      // Chunks are stored but without embeddings — they won't appear in retrieval
    }

    // 4. Deterministic EMA utility updates (if we have recently-retrieved chunks)
    await updateUtilities(db, sessionId, turnNumber, !!errors, newChunks.length, assistantResponse.length, errors).catch((e) =>
      rlmLog("bellman", `Utility update failed: ${String(e)}`)
    );

    // 5. Skill creation (runs every turn)
    await createOrUpdateSkill(db, sessionId).catch((e) =>
      rlmLog("skill", `Skill creation failed: ${String(e)}`)
    );
  } catch (err) {
    rlmLog("chunk", `learnFromTurn failed: ${String(err)}`);
  }
}

// --- Retrieval: two-phase MemRL-style (uses OpenAI embeddings) ---

const RETRIEVAL_ALPHA = 0.6;    // weight for similarity vs utility in combined score
const MIN_SIMILARITY = 0.25;    // Phase 1 floor: chunks below this are semantically irrelevant

export interface RetrievalResult {
  instructions: string;
  matchedSkill?: string;
  suggestedCommands: Array<{
    name: string;
    confidence: number;
    description: string;
  }>;
  chunks: Array<{
    id: number;
    similarity: number;
    utility: number;
    combinedScore: number;
    chunkText: string;
    chunkType: string | null;
    intent: string | null;
    tokenCount: number;
  }>;
  totalChunks: number;
}

export async function classifyAndRetrieve(
  db: Database.Database,
  userPrompt: string
): Promise<RetrievalResult> {
  const totalChunks = getTotalChunkCount(db);
  if (totalChunks === 0) {
    return { instructions: "", suggestedCommands: [], chunks: [], totalChunks: 0 };
  }

  // Phase 1: Semantic filtering with OpenAI embeddings
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedSingle(userPrompt);
  } catch (err) {
    rlmLog("retrieve", `Embedding failed for query: ${String(err)}`);
    return { instructions: "", suggestedCommands: [], chunks: [], totalChunks };
  }

  const allEmbeddings = getAllEmbeddings(db);
  if (allEmbeddings.length === 0) {
    return { instructions: "", suggestedCommands: [], chunks: [], totalChunks };
  }

  // Phase 1: Compute similarity, apply MIN_SIMILARITY floor, take top-20
  // The floor enforces the MemRL two-phase structure: semantic gating before value-aware selection.
  const scored = allEmbeddings
    .map((row) => {
      const emb = bufferToFloat32(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, emb);
      return { ...row, similarity };
    })
    .filter((s) => s.similarity >= MIN_SIMILARITY) // Phase 1 gate: drop semantically irrelevant chunks
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 20); // Top-K1=20

  // Phase 2: Re-rank by combined score with surprise novelty bonus (#5) and time decay (#7)
  // Compute all embeddings for surprise calculation
  const allEmbs = scored.map((s) => bufferToFloat32(s.embedding));
  const now = Date.now();

  const reranked = scored
    .map((s) => {
      const emb = bufferToFloat32(s.embedding);
      // #5 Titans: surprise at retrieval — novel chunks get a small informational bonus
      const novelty = surpriseScore(emb, allEmbs);
      const noveltyBonus = 0.05 * novelty; // small boost for surprising/novel chunks

      // #7 MemRL: time decay — stale chunks with historically high Q fade
      const ageMs = now - new Date(s.created_at).getTime();
      const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
      const timeDecay = Math.exp(-TIME_DECAY_LAMBDA * ageDays);

      const baseScore = RETRIEVAL_ALPHA * s.similarity + (1 - RETRIEVAL_ALPHA) * (s.utility * timeDecay);
      return {
        ...s,
        combinedScore: (baseScore + noveltyBonus) * s.memory_weight,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, 10); // Top-K2=10

  // Mark as retrieved
  for (const r of reranked) {
    incrementChunkRetrieval(db, r.id);
  }

  // Match skills from DB (trigger_patterns)
  const skills = getAllSkills(db);
  let matchedSkill: string | undefined;
  const suggestedCommands: Array<{ name: string; confidence: number; description: string }> = [];

  for (const skill of skills) {
    if (!skill.trigger_patterns) continue;
    try {
      const patterns: string[] = JSON.parse(skill.trigger_patterns);
      const promptLower = userPrompt.toLowerCase();
      const matched = patterns.some((p) => {
        try {
          return new RegExp(p, "i").test(userPrompt) || promptLower.includes(p.toLowerCase());
        } catch {
          return promptLower.includes(p.toLowerCase());
        }
      });
      if (matched && skill.confidence > 0.3) {
        matchedSkill = skill.skill_name;
        // #1: Store matched skill for correct EMA targeting in updateSkillConfidenceEMA
        lastMatchedSkill.set("global", skill.skill_name);
        updateSkillUsage(db, skill.skill_name);
        suggestedCommands.push({
          name: `/${skill.skill_name}`,
          confidence: skill.confidence,
          description: skill.description || "",
        });
        break;
      }
    } catch {}
  }

  // Scan .claude/commands/*.md for description matches
  const commandsDir = path.join(process.cwd(), ".claude", "commands");
  if (fs.existsSync(commandsDir)) {
    try {
      const files = fs.readdirSync(commandsDir).filter((f: string) => f.endsWith(".md"));
      const promptLower = userPrompt.toLowerCase();
      for (const file of files) {
        const cmdName = file.replace(/\.md$/, "");
        // Skip if already matched via DB
        if (suggestedCommands.some((s) => s.name === `/${cmdName}`)) continue;
        try {
          const content = fs.readFileSync(path.join(commandsDir, file), "utf-8");
          const descMatch = content.match(/^---[\s\S]*?description:\s*"?([^"\n]+)"?[\s\S]*?---/);
          if (descMatch) {
            const desc = descMatch[1].trim();
            const descWords = desc.toLowerCase().split(/\s+/);
            const matchCount = descWords.filter((w: string) => w.length > 3 && promptLower.includes(w)).length;
            if (matchCount >= 2) {
              suggestedCommands.push({
                name: `/${cmdName}`,
                confidence: Math.min(0.9, 0.4 + matchCount * 0.15),
                description: desc,
              });
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Sort suggestions by confidence descending
  suggestedCommands.sort((a, b) => b.confidence - a.confidence);

  // Assemble instructions
  const chunkResults = reranked.map((r) => ({
    id: r.id,
    similarity: Math.round(r.similarity * 100) / 100,
    utility: Math.round(r.utility * 100) / 100,
    combinedScore: Math.round(r.combinedScore * 100) / 100,
    chunkText: r.chunk_text,
    chunkType: r.chunk_type,
    intent: r.intent,
    tokenCount: r.chunk_text.length,
  }));

  const contextParts = chunkResults
    .filter((c) => c.combinedScore > 0.3)
    .map((c) => `[${c.chunkType || "unknown"}] (relevance: ${c.combinedScore}): ${c.intent || c.chunkText.slice(0, 100)}`)
    .join("\n");

  let instructions = "";
  if (contextParts) {
    instructions = `Based on ${chunkResults.length} relevant prior interactions:\n${contextParts}`;
  }

  rlmLog("retrieve", `Retrieved ${chunkResults.length} chunks, matched skill: ${matchedSkill || "none"}, commands: ${suggestedCommands.length}`, {
    topScore: chunkResults[0]?.combinedScore,
    totalChunks,
    suggestedCommands: suggestedCommands.map((c) => c.name),
  });

  return {
    instructions,
    matchedSkill,
    suggestedCommands,
    chunks: chunkResults,
    totalChunks,
  };
}

// --- Two-path value system: fast (embedding geometry) + slow (convergent Haiku exchange) ---
// Fast path: k-NN Q-estimate, surprise, cluster density — handles ~70-80% of turns
// Slow path: convergent multi-exchange Haiku loop — fires on high surprise, errors, sparse clusters

// Thresholds for fast/slow path decision
const SURPRISE_THRESHOLD = 0.3;
const DENSITY_THRESHOLD = 0.7;
const REWARD_PROPAGATION_DECAY = 0.3;

async function updateUtilities(
  db: Database.Database,
  sessionId: string,
  turnNumber: number,
  hadErrors: boolean,
  newChunkCount: number,
  responseLength: number = 0,
  errorText?: string
): Promise<void> {
  const allEmbeddings = getAllEmbeddings(db);
  let recentlyRetrieved = allEmbeddings.filter((r) => {
    const chunks = getChunksByIds(db, [r.id]);
    return chunks.length > 0 && chunks[0].retrieval_count > 0;
  });

  // Fallback: if no chunks have retrieval_count > 0, check RETRIEVED_CHUNK_IDS context var
  // (set by the hook's readonly retrieval path)
  if (recentlyRetrieved.length === 0) {
    try {
      const retrievedVar = getContextVar(db, sessionId, "RETRIEVED_CHUNK_IDS");
      if (retrievedVar) {
        const ids: number[] = JSON.parse(retrievedVar.var_value);
        recentlyRetrieved = allEmbeddings.filter((r) => ids.includes(r.id));
        if (recentlyRetrieved.length > 0) {
          rlmLog("bellman", `Recovered ${recentlyRetrieved.length} retrieved chunks from RETRIEVED_CHUNK_IDS context var`);
        }
      }
    } catch {}
  }

  // Dynamic sampling gate: skip when no learning signal
  const hasHighUtilityRetrieval = recentlyRetrieved.some((r) => r.utility > 0.7);
  if (!hadErrors && !hasHighUtilityRetrieval && newChunkCount === 0) {
    rlmLog("bellman", `Turn ${turnNumber}: neutral, no signal — skipping utility update`);
    return;
  }

  if (recentlyRetrieved.length === 0) {
    await updateSkillConfidenceEMA(db, sessionId, turnNumber, hadErrors);
    return;
  }

  // --- Fast-path computation: embedding geometry ---
  const retrievedEmbs = recentlyRetrieved
    .filter((r) => r.embedding)
    .map((r) => bufferToFloat32(r.embedding));
  const allEmbs = allEmbeddings
    .filter((r) => r.embedding)
    .map((r) => bufferToFloat32(r.embedding));

  // Compute geometric signals
  const turnCent = centroid(retrievedEmbs);
  const sessionCent = centroid(allEmbs);
  const instantSurprise = retrievedEmbs.length > 0
    ? retrievedEmbs.reduce((s, e) => s + surpriseScore(e, allEmbs), 0) / retrievedEmbs.length
    : 0;

  // #3 Titans: Surprise momentum — S_t = η·S_{t-1} + (1-η)·currentSurprise
  const prevMomentum = surpriseMomentum.get(sessionId) ?? 0;
  const avgSurprise = SURPRISE_MOMENTUM_DECAY * prevMomentum + (1 - SURPRISE_MOMENTUM_DECAY) * instantSurprise;
  surpriseMomentum.set(sessionId, avgSurprise);
  rlmLog("bellman", `Surprise momentum: instant=${Math.round(instantSurprise * 1000) / 1000}, momentum=${Math.round(avgSurprise * 1000) / 1000}`);

  const density = clusterDensity(retrievedEmbs);
  const drift = turnCent.length > 0 && sessionCent.length > 0
    ? trajectoryDrift(turnCent, sessionCent)
    : 0;

  // k-NN Q-estimates for each retrieved chunk
  const neighbors = allEmbeddings
    .filter((r) => r.embedding)
    .map((r) => ({ embedding: bufferToFloat32(r.embedding), utility: r.utility }));

  const knnEstimates = recentlyRetrieved.slice(0, 20).map((chunk) => {
    const emb = chunk.embedding ? bufferToFloat32(chunk.embedding) : null;
    return {
      chunk_id: chunk.id,
      q_old: chunk.utility,
      knn_q: emb ? knnQEstimate(emb, neighbors) : chunk.utility,
      memory_weight_old: chunk.memory_weight ?? 1.0,
    };
  });

  // #6 MemRL: Variance bound check — Var(Q) ≤ α·σ²/(2-α)
  // When reward variance exceeds theoretical bound, force slow path for reliability
  const recentRewardsForVariance = getRecentBellmanRewards(db, 20);
  let varianceExceeded = false;
  if (recentRewardsForVariance.length >= 5) {
    const rMean = recentRewardsForVariance.reduce((s, r) => s + r, 0) / recentRewardsForVariance.length;
    const rewardVariance = recentRewardsForVariance.reduce((s, r) => s + (r - rMean) ** 2, 0) / recentRewardsForVariance.length;
    const alpha = EMA_ALPHA_UP; // use the faster rate as upper bound
    const theoreticalBound = alpha * rewardVariance / (2 - alpha);
    // Check per-chunk Q variance against the bound
    if (knnEstimates.length >= 3) {
      const qMean = knnEstimates.reduce((s, e) => s + e.q_old, 0) / knnEstimates.length;
      const qVariance = knnEstimates.reduce((s, e) => s + (e.q_old - qMean) ** 2, 0) / knnEstimates.length;
      varianceExceeded = qVariance > theoreticalBound && theoreticalBound > 0;
      if (varianceExceeded) {
        rlmLog("bellman", `Variance bound exceeded: Q_var=${Math.round(qVariance * 1000) / 1000} > bound=${Math.round(theoreticalBound * 1000) / 1000}`);
      }
    }
  }

  // #8 DAPO: Overlong reward shaping — penalize verbose responses
  let overlongPenalty = 1.0;
  if (responseLength > 4000) {
    overlongPenalty = Math.max(0.5, 1 - (responseLength - 4000) / 8000);
    rlmLog("bellman", `Overlong penalty: ${Math.round(overlongPenalty * 100) / 100} (response ${responseLength} chars)`);
  }

  // #12: Process reward — parse intermediate signals for richer reward
  let processRewardDelta = 0;
  if (errorText) {
    const errorCount = (errorText.match(/error/gi) || []).length;
    processRewardDelta -= 0.05 * Math.min(errorCount, 3); // cap at -0.15
  }

  // --- Decision gate: fast or slow path? ---
  // #6: variance bound exceeded → force slow path for reliability
  const useFastPath = avgSurprise < SURPRISE_THRESHOLD && density > DENSITY_THRESHOLD && !hadErrors && !varianceExceeded;

  if (useFastPath) {
    // --- FAST PATH: apply k-NN Q-estimates + surprise-based memory weight ---
    // #8: Apply overlong penalty to raw reward; #12: add process reward delta
    const rawReward = (RAW_REWARD_SUCCESS + processRewardDelta) * overlongPenalty;
    const reward = normalizeReward(db, rawReward);
    // #9 DAPO: use decoupled alpha based on reward direction
    const emaAlpha = reward >= 0 ? EMA_ALPHA_UP : EMA_ALPHA_DOWN;
    const updates: Array<{ chunk_id: number; q_old: number; q_new: number; delta: number }> = [];

    for (const est of knnEstimates) {
      // Blend k-NN estimate with EMA update (using decoupled alpha)
      const emaQ = Math.max(0, Math.min(1, est.q_old + emaAlpha * reward));
      const q_new = Math.max(0, Math.min(1, 0.6 * est.knn_q + 0.4 * emaQ));
      updates.push({ chunk_id: est.chunk_id, q_old: est.q_old, q_new, delta: q_new - est.q_old });
      updateChunkUtility(db, est.chunk_id, q_new);
      incrementChunkSuccess(db, est.chunk_id);

      // #4 Titans: Data-dependent forget gate — surprise modulates boost rate
      const chunkEmb = recentlyRetrieved.find((r) => r.id === est.chunk_id)?.embedding;
      const chunkSurprise = chunkEmb ? surpriseScore(bufferToFloat32(chunkEmb), allEmbs) : 0;
      // High surprise → stronger boost (0.9→1.0 range), low surprise → gentle
      const boostRate = 0.9 + 0.1 * (1 - chunkSurprise); // adaptive: high surprise = 0.9x, low = 1.0x
      const newMw = Math.min(2.0, est.memory_weight_old * boostRate * (1 + 0.05 * (1 + chunkSurprise)));
      updateChunkMemoryWeight(db, est.chunk_id, Math.round(newMw * 1000) / 1000);
    }

    // Reward propagation to embedding neighbors
    propagateRewards(db, allEmbeddings, knnEstimates, updates);

    const bellmanRecord = {
      method: "fast_path_knn",
      alpha: emaAlpha,
      rawReward,
      reward,
      overlongPenalty: Math.round(overlongPenalty * 100) / 100,
      processRewardDelta: Math.round(processRewardDelta * 100) / 100,
      hadErrors: false,
      avgSurprise: Math.round(avgSurprise * 1000) / 1000,
      clusterDensity: Math.round(density * 1000) / 1000,
      trajectoryDrift: Math.round(drift * 1000) / 1000,
      chunks_updated: updates.length,
      avg_delta: updates.length > 0
        ? Math.round((updates.reduce((s, u) => s + u.delta, 0) / updates.length) * 1000) / 1000
        : 0,
      updates: updates.map((u) => ({
        chunk_id: u.chunk_id,
        q_old: Math.round(u.q_old * 100) / 100,
        q_new: Math.round(u.q_new * 100) / 100,
        delta: Math.round(u.delta * 100) / 100,
      })),
    };
    insertBellmanLog(db, sessionId, turnNumber, 1, "Fast Path k-NN Update", JSON.stringify(bellmanRecord));
    rlmLog("bellman", `Fast path: reward=${reward}, ${updates.length} chunks, surprise=${bellmanRecord.avgSurprise}, density=${bellmanRecord.clusterDensity}`);
  } else {
    // --- SLOW PATH: convergent Haiku exchange ---
    // #8: Apply overlong penalty; #12: add process reward delta
    const baseReward = hadErrors ? RAW_REWARD_FAILURE : RAW_REWARD_SUCCESS;
    const rawReward = (baseReward + processRewardDelta) * overlongPenalty;
    const reward = normalizeReward(db, rawReward);
    const recentRewards = getRecentBellmanRewards(db, 20);

    // #11 Titans: Build persistent memory context from top-retrieved chunk intents
    const topIntents = getTopRetrievedIntents(db, 5);
    if (topIntents.length > 0) {
      const persistCtx = topIntents.map((t) => `- ${t.intent} (retrieved ${t.retrieval_count}x)`).join("\n");
      setPersistentContext(persistCtx);
    }

    try {
      const exchangeResult = await convergentExchange({
        formulaPrefix: COMPOSITE_SKILL,
        responseSchema: CONVERGENT_ROUND_SCHEMA,
        initialData: {
          chunks: knnEstimates.map((e) => ({
            chunk_id: e.chunk_id,
            q_old: e.q_old,
            knn_q_estimate: Math.round(e.knn_q * 1000) / 1000,
            memory_weight_old: e.memory_weight_old,
          })),
          surprise_avg: Math.round(avgSurprise * 1000) / 1000,
          cluster_density: Math.round(density * 1000) / 1000,
          trajectory_drift: Math.round(drift * 1000) / 1000,
          raw_reward: rawReward,
          normalized_reward: reward,
          had_errors: hadErrors,
          recent_rewards: recentRewards.slice(0, 10),
        },
        refinementData: (round, prevResult) => ({
          instruction: "Refine your value assessment. Consider the embedding geometry signals more carefully.",
          round,
          previous_q_value: prevResult.q_value,
          previous_memory_weight: prevResult.memory_weight,
          neighbor_q_values: knnEstimates.map((e) => ({
            chunk_id: e.chunk_id,
            knn_q: Math.round(e.knn_q * 1000) / 1000,
          })),
          cluster_density: Math.round(density * 1000) / 1000,
          trajectory_drift: Math.round(drift * 1000) / 1000,
        }),
        maxRounds: 6,
      });

      // Apply Haiku's converged values
      const lastRound = exchangeResult.transcript.rounds[exchangeResult.transcript.rounds.length - 1];
      const convergedQ = (lastRound.assistantResult.q_value as number) ?? 0.5;
      const convergedMw = (lastRound.assistantResult.memory_weight as number) ?? 1.0;
      const updates: Array<{ chunk_id: number; q_old: number; q_new: number; delta: number }> = [];

      for (const est of knnEstimates) {
        // #2: Blend convergedQ with per-chunk knn_q instead of uniform assignment
        const q_new = Math.max(0, Math.min(1, 0.5 * convergedQ + 0.5 * est.knn_q));
        updates.push({ chunk_id: est.chunk_id, q_old: est.q_old, q_new, delta: q_new - est.q_old });
        updateChunkUtility(db, est.chunk_id, q_new);
        // #4 Titans: Data-dependent memory weight — surprise modulates the converged weight
        const chunkEmb = recentlyRetrieved.find((r) => r.id === est.chunk_id)?.embedding;
        const chunkSurprise = chunkEmb ? surpriseScore(bufferToFloat32(chunkEmb), allEmbs) : 0;
        const decayRate = 0.9 + 0.1 * (1 - chunkSurprise); // high surprise → stronger update
        const adaptedMw = convergedMw * decayRate;
        const clampedMw = Math.max(0.5, Math.min(2.0, adaptedMw));
        updateChunkMemoryWeight(db, est.chunk_id, Math.round(clampedMw * 1000) / 1000);
        if (!hadErrors) incrementChunkSuccess(db, est.chunk_id);
      }

      // Reward propagation
      propagateRewards(db, allEmbeddings, knnEstimates, updates);

      const bellmanRecord = {
        method: "convergent_exchange",
        rawReward,
        reward,
        hadErrors,
        avgSurprise: Math.round(avgSurprise * 1000) / 1000,
        clusterDensity: Math.round(density * 1000) / 1000,
        trajectoryDrift: Math.round(drift * 1000) / 1000,
        rounds: exchangeResult.transcript.convergedAtRound,
        final_delta: exchangeResult.transcript.finalDelta,
        total_tokens: exchangeResult.transcript.totalUsage,
        chunks_updated: updates.length,
        avg_delta: updates.length > 0
          ? Math.round((updates.reduce((s, u) => s + u.delta, 0) / updates.length) * 1000) / 1000
          : 0,
        transcript: exchangeResult.transcript.rounds,
        consolidation: exchangeResult.finalResponse,
      };
      insertBellmanLog(db, sessionId, turnNumber, 1, "Convergent Exchange", JSON.stringify(bellmanRecord));
      rlmLog("bellman", `Slow path: ${exchangeResult.transcript.convergedAtRound} rounds, final_delta=${exchangeResult.transcript.finalDelta}, ${updates.length} chunks`);
    } catch (err) {
      // Fallback to fast-path EMA on Haiku failure
      rlmLog("bellman", `Convergent exchange failed, falling back to EMA: ${String(err)}`);
      // #9: Use decoupled alpha
      const fallbackAlpha = reward >= 0 ? EMA_ALPHA_UP : EMA_ALPHA_DOWN;
      for (const est of knnEstimates) {
        const q_new = Math.max(0, Math.min(1, est.q_old + fallbackAlpha * reward));
        updateChunkUtility(db, est.chunk_id, q_new);
        // #4 Titans: Data-dependent forget gate in fallback too
        const chunkEmb = recentlyRetrieved.find((r) => r.id === est.chunk_id)?.embedding;
        const chunkSurprise = chunkEmb ? surpriseScore(bufferToFloat32(chunkEmb), allEmbs) : 0;
        const decayRate = 0.9 + 0.1 * (1 - chunkSurprise);
        const mw = est.memory_weight_old;
        const newMw = hadErrors ? Math.max(0.5, mw * decayRate) : Math.min(2.0, mw * (1 + 0.05 * (1 + chunkSurprise)));
        updateChunkMemoryWeight(db, est.chunk_id, Math.round(newMw * 1000) / 1000);
        if (!hadErrors) incrementChunkSuccess(db, est.chunk_id);
      }
    }
  }

  // Skill confidence EMA (both paths)
  await updateSkillConfidenceEMA(db, sessionId, turnNumber, hadErrors);
}

// --- Reward propagation: decay Haiku Q-update to embedding neighbors ---
function propagateRewards(
  db: Database.Database,
  allEmbeddings: Array<{ id: number; embedding: Buffer; utility: number; memory_weight: number; chunk_text: string; chunk_type: string | null; intent: string | null }>,
  sourceChunks: Array<{ chunk_id: number; q_old: number; knn_q: number }>,
  updates: Array<{ chunk_id: number; q_old: number; q_new: number; delta: number }>
): void {
  const updatedIds = new Set(updates.map((u) => u.chunk_id));
  for (const update of updates) {
    if (Math.abs(update.delta) < 0.01) continue; // skip tiny deltas
    const sourceEmb = allEmbeddings.find((e) => e.id === update.chunk_id);
    if (!sourceEmb?.embedding) continue;
    const srcFloat = bufferToFloat32(sourceEmb.embedding);

    for (const neighbor of allEmbeddings) {
      if (updatedIds.has(neighbor.id)) continue;
      if (!neighbor.embedding) continue;
      const sim = cosineSimilarity(srcFloat, bufferToFloat32(neighbor.embedding));
      if (sim < 0.4) continue; // only propagate to reasonably similar chunks
      const propagatedDelta = REWARD_PROPAGATION_DECAY * sim * update.delta;
      const newQ = Math.max(0, Math.min(1, neighbor.utility + propagatedDelta));
      if (Math.abs(newQ - neighbor.utility) > 0.005) {
        updateChunkUtility(db, neighbor.id, newQ);
      }
    }
  }
}

// --- Priority 4: Deterministic EMA skill confidence update ---
// Replaces the Haiku Exchange 3 call entirely.
// confidence_new = β * confidence_old + (1 - β) * outcome_signal
// outcome_signal: 1.0 on success, 0.0 on error
const SKILL_CONF_BETA = 0.85; // slow EMA — skill confidence is conservative

async function updateSkillConfidenceEMA(
  db: Database.Database,
  sessionId: string,
  turnNumber: number,
  hadErrors: boolean
): Promise<void> {
  const skills = getAllSkills(db);
  // #1: Use the last matched skill from retrieval, not just any skill with usage_count > 0
  const matchedName = lastMatchedSkill.get("global");
  const recentlyUsedSkill = matchedName
    ? skills.find((s) => s.skill_name === matchedName)
    : skills.find((s) => s.usage_count > 0);
  if (!recentlyUsedSkill) return;

  const outcomeSignal = hadErrors ? 0.0 : 1.0;
  const newConf = SKILL_CONF_BETA * recentlyUsedSkill.confidence + (1 - SKILL_CONF_BETA) * outcomeSignal;
  const clampedConf = Math.max(0.1, Math.min(1.0, newConf));

  updateSkillConfidence(db, recentlyUsedSkill.skill_name, clampedConf);

  const confRecord = {
    method: "deterministic_ema",
    skill_name: recentlyUsedSkill.skill_name,
    beta: SKILL_CONF_BETA,
    outcome_signal: outcomeSignal,
    confidence_old: Math.round(recentlyUsedSkill.confidence * 100) / 100,
    confidence_new: Math.round(clampedConf * 100) / 100,
  };
  insertBellmanLog(db, sessionId, turnNumber, 2, "Skill Confidence EMA", JSON.stringify(confRecord));
  rlmLog("bellman", `Skill EMA: ${recentlyUsedSkill.skill_name} ${confRecord.confidence_old} → ${confRecord.confidence_new}`);
}

// --- Skill creation ---

async function createOrUpdateSkill(
  db: Database.Database,
  sessionId: string
): Promise<void> {
  const totalChunks = getTotalChunkCount(db);
  if (totalChunks < 3) {
    rlmLog("skill", `Only ${totalChunks} chunks, need at least 3 for skill creation`);
    return;
  }

  // Get chunks with embeddings for clustering
  const allEmbeddings = getAllEmbeddings(db);
  if (allEmbeddings.length < 3) return;

  // Simple clustering: take top chunks by utility
  const topChunks = allEmbeddings
    .sort((a, b) => b.utility - a.utility)
    .slice(0, 15);

  const chunkSummaries = topChunks.map((c) => ({
    id: c.id,
    type: c.chunk_type,
    intent: c.intent,
    utility: c.utility,
    text: c.chunk_text.slice(0, 300),
  }));

  const prompt = `You are a Claude Code slash command generator. Analyze these conversation chunks and generate a command .md file.

Chunks from coding session:
${JSON.stringify(chunkSummaries, null, 2)}

Generate a command that captures the most common pattern or workflow from these chunks.

Output EXACTLY this format (no extra text before or after).
The ONLY valid frontmatter property is "description". Do NOT include allowed-tools, model, or version.

---
description: "When to use this command — one clear sentence"
---

# Command Name

Brief description of what this command does.

## Instructions
### Step 1: ...
Detailed instructions for Claude to follow when this command is invoked.

### Step 2: ...
Continue with steps.

## Output Format
What the command produces or how it responds.

Also output a separate JSON block at the very end:
\`\`\`json
{"trigger_patterns": ["keyword1", "keyword2"], "command_name": "command-name-here", "description": "description here"}
\`\`\``;

  try {
    const response = await anthropicClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    if (!text) return;

    // Extract the JSON metadata block
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    let metadata: { trigger_patterns: string[]; command_name: string; description: string } | null = null;
    if (jsonMatch) {
      try {
        metadata = JSON.parse(jsonMatch[1].trim());
      } catch {}
    }

    if (!metadata?.command_name) {
      // Fallback: extract from frontmatter heading
      const headingMatch = text.match(/^#\s+(.+)/m);
      const descMatch = text.match(/description:\s*"?([^"\n]+)"?/);
      if (headingMatch) {
        metadata = {
          command_name: headingMatch[1].trim().toLowerCase().replace(/\s+/g, "-"),
          description: descMatch?.[1]?.trim() || "",
          trigger_patterns: [],
        };
      }
    }

    if (!metadata?.command_name) {
      rlmLog("skill", "Could not extract command metadata from Haiku response");
      return;
    }

    // Sanitize command name
    const commandName = metadata.command_name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

    // Extract the command content (everything before the JSON block)
    let commandContent = text;
    if (jsonMatch) {
      commandContent = text.slice(0, jsonMatch.index).trim();
    }

    // Write .claude/commands/{name}.md (flat file, no subdirectory)
    const commandsDir = path.join(process.cwd(), ".claude", "commands");
    if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, `${commandName}.md`);
    fs.writeFileSync(commandPath, commandContent, "utf-8");

    // Store in DB for fast retrieval matching (reuse rlm_skills table)
    insertOrUpdateSkill(
      db,
      commandName,
      metadata.description,
      JSON.stringify(metadata.trigger_patterns),
      commandContent,
      JSON.stringify(topChunks.map((c) => c.id)),
      0.5
    );

    rlmLog("skill", `Created/updated command: /${commandName}`, {
      path: commandPath,
      triggerPatterns: metadata.trigger_patterns,
      sourceChunks: topChunks.length,
    });
  } catch (err) {
    rlmLog("skill", `Skill creation error: ${String(err)}`);
  }
}
