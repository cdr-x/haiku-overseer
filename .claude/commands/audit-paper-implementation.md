---
description: "Use this when implementing research paper techniques into the haiku-overseer plugin and need to verify what's already implemented vs. what's missing."
---

# Audit Paper Implementation

Analyze the current codebase state to identify which research paper techniques are implemented, partially implemented, or missing entirely.

## Instructions
### Step 1: Comprehensive File Review
Read all core implementation files (rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts) and document the current state of each.

### Step 2: Cross-Reference Against Papers
Map existing code implementations against the five papers' key techniques:
- DAPO: Clip-Higher, Dynamic Sampling, Token-Level Loss, Overlong Reward Shaping, z-score normalization
- MemRL: IEU Triplets, Two-Phase Retrieval, Non-Parametric RL, EMA Q-values, Cross-Model Transfer
- Titans: Surprise-based scoring, memory_weight, test-time memorization
- RLMs: Recursive REPL environment, long-context inference
- Other: Convergent exchange patterns, value function approaches

### Step 3: Create Gap Analysis
Produce a structured report listing:
- **Fully Implemented**: Specific code locations and how they work
- **Partially Implemented**: What exists and what's missing
- **Not Yet Implemented**: Specific mechanisms and formulas needed

### Step 4: Identify Quick Wins vs. Major Work
Categorize missing items by implementation complexity and impact priority.

## Output Format
Structured gap analysis document with:
- Implementation status matrix (technique × status)
- Code location references
- Detailed descriptions of implementation gaps
- Prioritized todo list for next implementation phase