// Semantic chunking engine for RLM pipeline
// Splits turns into ~500 token chunks with type tagging and SHA-256 dedup

import crypto from "crypto";

export interface Chunk {
  text: string;
  hash: string;
  type: ChunkType;
  tokenCount: number;
  intent?: string;
}

export type ChunkType = "user_prompt" | "assistant" | "error" | "decision" | "pattern" | "code";

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

function estimateTokens(text: string): number {
  // ~1.3 tokens per word + punctuation
  const words = text.split(/\s+/).filter(Boolean).length;
  const punctuation = (text.match(/[^\w\s]/g) || []).length;
  return Math.ceil(words * 1.3 + punctuation * 0.5);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function detectChunkType(text: string, source: "user" | "assistant" | "error"): ChunkType {
  if (source === "error") return "error";
  if (source === "user") return "user_prompt";

  // Detect code blocks
  if (/```[\s\S]{20,}```/.test(text)) return "code";
  // Detect decisions
  if (/\b(decided|decision|chose|approach|strategy|instead of|rather than)\b/i.test(text)) return "decision";
  // Detect patterns
  if (/\b(pattern|always|convention|standard|rule|best practice)\b/i.test(text)) return "pattern";

  return "assistant";
}

function extractIntent(text: string): string {
  // Extract first sentence or up to 120 chars as intent summary
  const firstSentence = text.match(/^[^.!?\n]+[.!?]?/);
  const raw = firstSentence ? firstSentence[0] : text.slice(0, 120);
  return raw.trim().slice(0, 200);
}

interface SemanticBoundary {
  index: number;
  type: "paragraph" | "header" | "code_block" | "list" | "sentence";
}

function findSemanticBoundaries(text: string): SemanticBoundary[] {
  const boundaries: SemanticBoundary[] = [];

  // Double newlines (paragraph breaks)
  const paraRe = /\n\s*\n/g;
  let match: RegExpExecArray | null;
  while ((match = paraRe.exec(text)) !== null) {
    boundaries.push({ index: match.index + match[0].length, type: "paragraph" });
  }

  // Headers (markdown)
  const headerRe = /^#{1,6}\s/gm;
  while ((match = headerRe.exec(text)) !== null) {
    boundaries.push({ index: match.index, type: "header" });
  }

  // Code block boundaries
  const codeRe = /^```/gm;
  while ((match = codeRe.exec(text)) !== null) {
    boundaries.push({ index: match.index, type: "code_block" });
  }

  // Sort by position
  boundaries.sort((a, b) => a.index - b.index);
  return boundaries;
}

function splitAtBoundaries(text: string, source: "user" | "assistant" | "error"): string[] {
  const boundaries = findSemanticBoundaries(text);
  if (boundaries.length === 0) {
    return splitBySize(text);
  }

  const segments: string[] = [];
  let lastIdx = 0;

  for (const b of boundaries) {
    if (b.index > lastIdx) {
      const segment = text.slice(lastIdx, b.index).trim();
      if (segment) segments.push(segment);
    }
    lastIdx = b.index;
  }
  // Remaining text
  const remaining = text.slice(lastIdx).trim();
  if (remaining) segments.push(remaining);

  // Merge small segments, split large ones
  return mergeAndSplit(segments);
}

function splitBySize(text: string): string[] {
  const tokens = estimateTokens(text);
  if (tokens <= TARGET_TOKENS) return [text];

  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const word of words) {
    const wordTokens = estimateTokens(word);
    if (currentTokens + wordTokens > TARGET_TOKENS && current.length > 0) {
      chunks.push(current.join(" "));
      // Overlap: keep last few words
      const overlapWords = Math.ceil(OVERLAP_TOKENS / 1.3);
      current = current.slice(-overlapWords);
      currentTokens = estimateTokens(current.join(" "));
    }
    current.push(word);
    currentTokens += wordTokens;
  }
  if (current.length > 0) chunks.push(current.join(" "));

  return chunks;
}

function mergeAndSplit(segments: string[]): string[] {
  const result: string[] = [];
  let buffer = "";

  for (const seg of segments) {
    const merged = buffer ? buffer + "\n\n" + seg : seg;
    const tokens = estimateTokens(merged);

    if (tokens <= TARGET_TOKENS) {
      buffer = merged;
    } else if (buffer) {
      result.push(buffer);
      // Check if segment itself needs splitting
      if (estimateTokens(seg) > TARGET_TOKENS) {
        result.push(...splitBySize(seg));
        buffer = "";
      } else {
        buffer = seg;
      }
    } else {
      result.push(...splitBySize(seg));
      buffer = "";
    }
  }
  if (buffer) result.push(buffer);

  return result;
}

export function chunkTurn(
  userPrompt: string,
  assistantResponse: string,
  errors?: string
): Chunk[] {
  const chunks: Chunk[] = [];

  // Chunk user prompt
  if (userPrompt.trim()) {
    const userSegments = splitAtBoundaries(userPrompt, "user");
    for (const seg of userSegments) {
      const text = seg.trim();
      if (!text || text.length < 10) continue;
      chunks.push({
        text,
        hash: sha256(text),
        type: "user_prompt",
        tokenCount: estimateTokens(text),
        intent: extractIntent(text),
      });
    }
  }

  // Chunk assistant response
  if (assistantResponse.trim()) {
    const assistantSegments = splitAtBoundaries(assistantResponse, "assistant");
    for (const seg of assistantSegments) {
      const text = seg.trim();
      if (!text || text.length < 10) continue;
      const type = detectChunkType(text, "assistant");
      chunks.push({
        text,
        hash: sha256(text),
        type,
        tokenCount: estimateTokens(text),
        intent: extractIntent(text),
      });
    }
  }

  // Chunk errors
  if (errors?.trim()) {
    const errorSegments = splitAtBoundaries(errors, "error");
    for (const seg of errorSegments) {
      const text = seg.trim();
      if (!text || text.length < 10) continue;
      chunks.push({
        text,
        hash: sha256(text),
        type: "error",
        tokenCount: estimateTokens(text),
        intent: extractIntent(text),
      });
    }
  }

  return chunks;
}
