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

export const COMPOSITE_SKILL = `${MEMRL_BELLMAN}

${DAPO_GROUP_NORM}

${TITANS_SURPRISE}

## Combined Value Assessment

Using all three frameworks together, assess the chunk's value holistically:
1. Q-value via Bellman update with learning rate convergence
2. Normalized reward via group-relative advantage
3. Memory weight via surprise-gated memorization

Your assessment should integrate all three signals into a coherent value judgment.`;

// Structured output schema for convergent exchange rounds
export const CONVERGENT_ROUND_SCHEMA = {
  name: "value_assessment",
  description: "Structured value assessment for a convergent exchange round",
  input_schema: {
    type: "object" as const,
    properties: {
      q_value: {
        type: "number",
        description: "Updated Q-value estimate (0-1 range)",
      },
      normalized_reward: {
        type: "number",
        description: "Group-relative normalized reward (-1 to 1)",
      },
      memory_weight: {
        type: "number",
        description: "Surprise-gated memory weight (0.5-2.0)",
      },
      exchanges_needed: {
        type: "number",
        description: "How many MORE rounds needed to converge (0 = done)",
      },
      threshold: {
        type: "number",
        description: "Convergence threshold — stop when delta < this",
      },
      delta: {
        type: "number",
        description: "Change magnitude from previous round's values",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of this round's assessment",
      },
    },
    required: [
      "q_value",
      "normalized_reward",
      "memory_weight",
      "exchanges_needed",
      "threshold",
      "delta",
      "reasoning",
    ],
  },
};
