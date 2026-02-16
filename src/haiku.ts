import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export interface HaikuResponse {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
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
