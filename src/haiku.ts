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

export async function callHaiku(
  systemPrompt: string,
  userMessage: string
): Promise<HaikuResponse> {
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
