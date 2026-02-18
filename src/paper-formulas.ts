// Paper formula constants — system prompt prefixes for convergent Haiku exchanges
// Sources: MemRL (2601.03192), DAPO (2503.14476), Titans (2501.00663), RLMs (2512.24601)

export const MEMRL_BELLMAN = `## MemRL Bellman Q-Update (§4.3)

Formula: Q_new = Q_old + α·(r - Q_old), α=0.15
Convergence property: E[Q_t] - β = (1-α)^t · (Q_0 - β)
where β is the true value, Q_0 is initial estimate, t is update count.

Variables:
- Q_old: current Q-value of the chunk (0-1 range)
- r: normalized reward signal (clamped to [-1, 1])
- α: learning rate (0.15)
- Q_new: updated Q-value (clamped to [0, 1])

You must output a q_value that reflects your best estimate of the chunk's long-term utility.`;

export const DAPO_GROUP_NORM = `## DAPO Group-Relative Normalization (§3.3)

Formula: advantage_i = (r_i - mean(r_group)) / std(r_group)
where r_group is the recent reward history (last 20 rewards).

Variables:
- r_i: raw reward for the current turn
- r_group: array of recent rewards
- advantage_i: normalized advantage (z-score, clamped to [-1, 1])

This prevents utility drift by keeping rewards calibrated to the local batch.
You must output a normalized_reward that represents the z-score advantage.`;

export const TITANS_SURPRISE = `## Titans Surprise-Gated Memory (§3.2)

Formula: M_t = α·M_{t-1} + (1-α)·surprise·update
Surprise: 1 - max(cosineSim(new_chunk, all_existing_chunks))

Variables:
- M_t: memory weight at time t (clamped to [0.5, 2.0])
- M_{t-1}: previous memory weight
- surprise: novelty score (0 = fully expected, 1 = completely novel)
- α: decay rate (0.95 for failures, 0.05 boost rate for successes)

Higher surprise → larger memory weight update. Chunks that are novel and successful
get strongly reinforced; familiar failures get decayed.
You must output a memory_weight reflecting the chunk's memorization priority.`;

export const COMPOSITE_SKILL = `## Chunk Value Evaluation

You are evaluating stored memory chunks for a coding assistant. Each chunk is a snippet from a prior conversation (user prompt, assistant response, decision, or error pattern).

### Scoring Guide

**q_value** (0-1): Long-term utility of this chunk
- 0.8-1.0: Directly answers the query type, contains reusable patterns or key decisions
- 0.5-0.7: Partially relevant, provides useful background context
- 0.2-0.4: Tangentially related, unlikely to help with this query type
- 0.0-0.2: Irrelevant to the current context

**memory_weight** (0.5-2.0): How strongly to retain this chunk
- >1.5: Novel, high-value — actively boost in future retrieval
- 1.0: Neutral — keep as-is
- <0.8: Stale or redundant — allow to fade

**relevance** (0-1): How well this chunk matches the current user query
- 1.0: Directly addresses the user's question
- 0.5: Related topic but different aspect
- 0.0: No connection to the current query

### Update Rule
Q_new = Q_old + α·(r - Q_old) where r is your assessed relevance, α=0.15
Use this as a guide — your q_value should reflect both the formula update AND your semantic judgment.

### Important
- Evaluate each chunk INDEPENDENTLY based on its text content
- A chunk with high q_old but low relevance to this query should get a LOWER q_value
- A chunk with low q_old but high relevance should get a HIGHER q_value
- Differentiate — do NOT give all chunks the same score`;

// Structured output schema for convergent exchange rounds
export const CONVERGENT_ROUND_SCHEMA = {
  name: "value_assessment",
  description: "Per-chunk value assessment for a convergent exchange round",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      chunk_assessments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chunk_id: { type: "integer", description: "ID of the chunk being assessed" },
            q_value: { type: "number", description: "Updated Q-value (0-1). High = likely useful in future similar queries" },
            memory_weight: { type: "number", description: "Memorization priority (0.5-2.0). High = should be retained and surfaced" },
            relevance: { type: "number", description: "How relevant this chunk was to the user's query (0-1)" },
          },
          required: ["chunk_id", "q_value", "memory_weight", "relevance"] as const,
          additionalProperties: false,
        },
      },
      exchanges_needed: { type: "integer", description: "Remaining rounds to converge (0 = done)" },
      delta: { type: "number", description: "Max change from previous round's values" },
      reasoning: { type: "string", description: "Brief explanation of assessments" },
    },
    required: ["chunk_assessments", "exchanges_needed", "delta", "reasoning"] as const,
    additionalProperties: false,
  },
};
