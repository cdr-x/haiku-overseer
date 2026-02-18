import Anthropic from "@anthropic-ai/sdk";
import type { Tool, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import fs from "fs";
import path from "path";

const client = new Anthropic();

// #11 Titans: Persistent memory — task-level knowledge that persists across exchanges
let persistentContext: string = "";

export function setPersistentContext(context: string): void {
  persistentContext = context;
}

export function getPersistentContext(): string {
  return persistentContext;
}

export interface HaikuResponse {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export interface HaikuUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ConversationTranscript {
  rounds: Array<{
    round: number;
    userMessage: string;
    assistantResult: Record<string, unknown>;
  }>;
  totalUsage: HaikuUsage;
  convergedAtRound: number;
  finalDelta: number;
}

export interface CallHaikuOptions {
  onChunk?: (snapshot: string) => void;
}

export async function callHaiku(
  systemPrompt: string,
  userMessage: string,
  options?: CallHaikuOptions
): Promise<HaikuResponse> {
  const onChunk = options?.onChunk;

  if (!onChunk) {
    // Non-streaming path (micro-summaries, session summaries, etc.)
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    const text = block.type === "text" ? block.text : "";
    return {
      text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: (response.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (response.usage as any).cache_read_input_tokens ?? 0,
      },
    };
  }

  // Streaming path with throttled onChunk callbacks
  const stream = client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  let accumulated = "";
  let lastCallbackTime = 0;
  const THROTTLE_MS = 150;

  stream.on("text", (text) => {
    accumulated += text;
    const now = Date.now();
    if (now - lastCallbackTime >= THROTTLE_MS) {
      lastCallbackTime = now;
      onChunk(accumulated);
    }
  });

  const finalMessage = await stream.finalMessage();

  // Fire one last callback with the complete text
  onChunk(accumulated);

  const block = finalMessage.content[0];
  const fullText = block.type === "text" ? block.text : "";
  return {
    text: fullText,
    usage: {
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      cache_creation_input_tokens: (finalMessage.usage as any).cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: (finalMessage.usage as any).cache_read_input_tokens ?? 0,
    },
  };
}

// --- Conversation log ---

const CONV_LOG_DIR = path.join(process.cwd(), ".haiku-overseer");
const CONV_LOG_PATH = path.join(CONV_LOG_DIR, "conversation.log");

let convLogStream: fs.WriteStream | null = null;

function getConvLogStream(): fs.WriteStream {
  if (!convLogStream) {
    if (!fs.existsSync(CONV_LOG_DIR)) fs.mkdirSync(CONV_LOG_DIR, { recursive: true });
    convLogStream = fs.createWriteStream(CONV_LOG_PATH, { flags: "a" });
  }
  return convLogStream;
}

function logConversation(entry: string): void {
  const stream = getConvLogStream();
  const ts = new Date().toISOString();
  stream.write(`[${ts}] ${entry}\n`);
}

// --- Structured output via tool_use ---

export async function callHaikuStructured<T extends Record<string, unknown>>(
  systemPrompt: string,
  messages: MessageParam[],
  responseSchema: Tool
): Promise<{ result: T; usage: HaikuUsage }> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: systemPrompt,
    messages,
    tools: [responseSchema],
    tool_choice: { type: "tool", name: responseSchema.name },
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Haiku did not return a tool_use block for structured output");
  }

  return {
    result: toolBlock.input as T,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

// --- Convergent exchange loop ---

export interface ConvergentExchangeOpts {
  formulaPrefix: string;
  initialData: Record<string, unknown>;
  refinementData?: (round: number, prevResult: Record<string, unknown>) => Record<string, unknown>;
  responseSchema: Tool;
  maxRounds?: number;
}

export interface ConvergentExchangeResult {
  transcript: ConversationTranscript;
  finalResponse: string;
}

export async function convergentExchange(
  opts: ConvergentExchangeOpts
): Promise<ConvergentExchangeResult> {
  const { formulaPrefix, initialData, refinementData, responseSchema, maxRounds = 6 } = opts;

  // #11 Titans: Prepend persistent memory context (top-retrieved chunk intents)
  const persistCtx = persistentContext
    ? `## Persistent Memory (task-level knowledge)\n${persistentContext}\n\n`
    : "";
  const systemPrompt = `${persistCtx}${formulaPrefix}\n\nYou are a value function evaluator. Assess the data using the formulas above. Use the provided tool to output your structured assessment. Set exchanges_needed to 0 and delta near 0 when you are confident in your values.`;

  const messages: MessageParam[] = [];
  const rounds: ConversationTranscript["rounds"] = [];
  let totalUsage: HaikuUsage = { input_tokens: 0, output_tokens: 0 };
  let lastResult: Record<string, unknown> = {};
  let convergedAtRound = 1;
  let finalDelta = 1.0;

  logConversation(`=== CONVERGENT EXCHANGE START (maxRounds=${maxRounds}) ===`);
  logConversation(`SYSTEM: ${systemPrompt}`);

  // Round 1: initial data
  const round1Msg = JSON.stringify(initialData, null, 2);
  messages.push({ role: "user", content: round1Msg });
  logConversation(`ROUND 1 → USER: ${round1Msg}`);

  const r1 = await callHaikuStructured<Record<string, unknown>>(
    systemPrompt,
    messages,
    responseSchema
  );
  lastResult = r1.result;
  totalUsage.input_tokens += r1.usage.input_tokens;
  totalUsage.output_tokens += r1.usage.output_tokens;
  rounds.push({ round: 1, userMessage: round1Msg, assistantResult: lastResult });
  logConversation(`ROUND 1 ← HAIKU: ${JSON.stringify(lastResult)}`);

  // Append assistant response as tool_result so conversation continues
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: "round_1", name: responseSchema.name, input: lastResult }],
  });
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "round_1", content: "Received. Continue refining." }],
  });

  finalDelta = (lastResult.delta as number) ?? 1.0;
  const threshold = 0.05; // fixed convergence threshold
  convergedAtRound = 1;

  // #10 RLMs: Track previous chunk assessments for external delta verification
  let prevAssessments: Array<{chunk_id: number; q_value: number}> =
    ((lastResult.chunk_assessments as any[]) || []).map((a: any) => ({ chunk_id: a.chunk_id, q_value: a.q_value }));

  // Subsequent rounds
  for (let round = 2; round <= maxRounds; round++) {
    const exchangesNeeded = (lastResult.exchanges_needed as number) ?? 0;
    if (exchangesNeeded === 0 || finalDelta < threshold) break;

    const refData = refinementData
      ? refinementData(round, lastResult)
      : { instruction: "Refine your previous assessment. Reduce delta toward convergence." };

    const refinementMsg = JSON.stringify(refData, null, 2);
    logConversation(`ROUND ${round} → USER: ${refinementMsg}`);
    // Replace the last tool_result with refinement data
    messages[messages.length - 1] = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `round_${round - 1}`, content: refinementMsg }],
    };

    const rN = await callHaikuStructured<Record<string, unknown>>(
      systemPrompt,
      messages,
      responseSchema
    );
    lastResult = rN.result;
    totalUsage.input_tokens += rN.usage.input_tokens;
    totalUsage.output_tokens += rN.usage.output_tokens;
    rounds.push({ round, userMessage: refinementMsg, assistantResult: lastResult });
    logConversation(`ROUND ${round} ← HAIKU: ${JSON.stringify(lastResult)}`);

    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `round_${round}`, name: responseSchema.name, input: lastResult }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `round_${round}`, content: "Received. Continue refining." }],
    });

    // #10 RLMs: External delta verification — cross-check self-reported delta against per-chunk Q changes
    const selfReportedDelta = (lastResult.delta as number) ?? 0;
    const currentAssessments: Array<{chunk_id: number; q_value: number}> =
      ((lastResult.chunk_assessments as any[]) || []).map((a: any) => ({ chunk_id: a.chunk_id, q_value: a.q_value }));
    let externalDelta = selfReportedDelta;
    if (prevAssessments.length > 0 && currentAssessments.length > 0) {
      const prevMap = new Map(prevAssessments.map(a => [a.chunk_id, a.q_value]));
      const maxChunkDelta = currentAssessments.reduce((max, a) => {
        const prev = prevMap.get(a.chunk_id);
        return prev !== undefined ? Math.max(max, Math.abs(a.q_value - prev)) : max;
      }, 0);
      externalDelta = maxChunkDelta;
    }
    // Use the max of self-reported and external — only trust convergence when both agree
    finalDelta = Math.max(selfReportedDelta, externalDelta);
    prevAssessments = currentAssessments;
    convergedAtRound = round;
  }

  // Final consolidation call — normal text response
  const transcriptText = rounds
    .map((r) => `Round ${r.round}:\nInput: ${r.userMessage}\nOutput: ${JSON.stringify(r.assistantResult)}`)
    .join("\n\n");

  logConversation(`CONSOLIDATION → USER: ${transcriptText}`);

  const consolidation = await callHaiku(
    "You are producing the final value assessment. Here is the complete deliberation transcript. Summarize the final converged values concisely.",
    transcriptText
  );
  totalUsage.input_tokens += consolidation.usage.input_tokens;
  totalUsage.output_tokens += consolidation.usage.output_tokens;

  logConversation(`CONSOLIDATION ← HAIKU: ${consolidation.text}`);
  logConversation(`=== CONVERGENT EXCHANGE END (converged at round ${convergedAtRound}, delta=${finalDelta}, tokens=${JSON.stringify(totalUsage)}) ===\n`);

  return {
    transcript: { rounds, totalUsage, convergedAtRound, finalDelta },
    finalResponse: consolidation.text,
  };
}
