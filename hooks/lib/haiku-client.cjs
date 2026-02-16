// hooks/lib/haiku-client.cjs
// Lazy Anthropic SDK client for hook AI calls
const Anthropic = require("@anthropic-ai/sdk");

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

async function callHaiku(systemPrompt, userMessage) {
  const client = getClient();
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

module.exports = { callHaiku };
