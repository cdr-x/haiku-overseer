// Embedding service: OpenAI text-embedding-3-large (3072D)

import OpenAI from "openai";
import { rlmLog } from "./rlm-debug.js";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is required for embeddings");
    }
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  try {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: "text-embedding-3-large",
      input: texts,
    });

    const results: Float32Array[] = [];
    for (const item of response.data) {
      results.push(new Float32Array(item.embedding));
    }

    rlmLog("embed", `Embedded ${texts.length} texts (3072D)`);
    return results;
  } catch (err) {
    rlmLog("embed", `Embedding failed: ${String(err)}`);
    throw err;
  }
}

export async function embedSingle(text: string): Promise<Float32Array> {
  const [result] = await embedBatch([text]);
  return result;
}

// --- Similarity ---

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return Math.max(0, Math.min(1, dot / denom));
}

// --- Geometric value helpers ---

/** Titans intrinsic reward: 1 - max(cosineSim(newEmb, each existing)) */
export function surpriseScore(newEmb: Float32Array, existingEmbs: Float32Array[]): number {
  if (existingEmbs.length === 0) return 1.0;
  let maxSim = 0;
  for (const emb of existingEmbs) {
    const sim = cosineSimilarity(newEmb, emb);
    if (sim > maxSim) maxSim = sim;
  }
  return 1 - maxSim;
}

/** Average pairwise cosine similarity among a set of embeddings */
export function clusterDensity(embeddings: Float32Array[]): number {
  if (embeddings.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      total += cosineSimilarity(embeddings[i], embeddings[j]);
      count++;
    }
  }
  return total / count;
}

/** Topic shift: 1 - cosineSim(turnCentroid, sessionCentroid) */
export function trajectoryDrift(turnCentroid: Float32Array, sessionCentroid: Float32Array): number {
  return 1 - cosineSimilarity(turnCentroid, sessionCentroid);
}

/** Similarity-weighted Q interpolation over k-NN neighbors */
export function knnQEstimate(
  queryEmb: Float32Array,
  neighbors: Array<{ embedding: Float32Array; utility: number }>
): number {
  if (neighbors.length === 0) return 0.5;
  let weightedSum = 0;
  let simSum = 0;
  for (const n of neighbors) {
    const sim = cosineSimilarity(queryEmb, n.embedding);
    weightedSum += sim * n.utility;
    simSum += sim;
  }
  return simSum > 0 ? weightedSum / simSum : 0.5;
}

/** Element-wise mean of embedding vectors */
export function centroid(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) return new Float32Array(0);
  const dim = embeddings[0].length;
  const result = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }
  return result;
}

// --- Serialization helpers ---

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}
