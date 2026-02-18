---
description: "Use when implementing research paper techniques into the haiku-overseer plugin and need to verify implementation status"
---

# Audit Paper Implementation

Analyze the current codebase to identify which research paper techniques (DAPO, MemRL, Recursive Language Models, Titans) are already implemented versus what still needs to be built.

## Instructions
### Step 1: Scan Core Files
Read through the key implementation files: src/rlm.ts, src/embeddings.ts, src/paper-formulas.ts, src/haiku.ts, src/db.ts, and src/chunking.ts. Document the current state of each.

### Step 2: Map Paper Techniques
Cross-reference implemented code against the research papers' core mechanisms:
- DAPO: Clip-Higher, Dynamic Sampling, Token-Level Loss, Overlong Reward Shaping, z-score normalization
- MemRL: IEU Triplets, Two-Phase Retrieval, Non-Parametric RL, EMA Q-values, Cross-Model Transfer
- Titans: Test-time memorization, memory_weight tracking, surprise scoring
- Recursive Language Models: REPL environment, recursive synthesis

### Step 3: Generate Gap Analysis
Produce a detailed report listing:
- ✅ What IS implemented (with file/function locations)
- ❌ What is NOT yet implemented (with specific mechanism names)
- 🔄 What is partially implemented (with notes on completion percentage)

### Step 4: Prioritize 12-Item Plan
If requested, structure the gap items into a 12-item implementation roadmap covering: bugfixes, quick wins, momentum items, safety mechanisms, reward shaping, and persistent memory.

## Output Format
Structured markdown report with implementation status table, then detailed explanations of each gap, optionally followed by a numbered 12-item implementation plan with estimated complexity and dependencies.