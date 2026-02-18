---
description: "Use this command to analyze academic research papers and identify implementation gaps in the RLM system, then propose actionable improvements."
---

# RLM Gap Analysis & Research Integration

Analyzes academic papers in the docs/ directory, extracts key algorithms and techniques, compares them against the current codebase implementation, identifies gaps, and recommends improvements for the MCP server.

## Instructions

### Step 1: Read and Extract Research Papers
Read all academic papers in C:\Users\sekt\Documents\GitHub\new-plugin\docs\ (including RLMs, MemRL, Titans, DAPO, RL survey papers). Extract key ideas, techniques, algorithms, and mathematical formulas from each paper.

### Step 2: Audit Current Implementation
Perform a comprehensive read of all source files (rlm.ts, db.ts, embeddings.ts, chunking.ts, rlm-retrieve.cjs, user-prompt-submit.cjs, capture-turn.cjs, post-tool-use.cjs, server.ts, package.json). Document the current implementation state and architecture.

### Step 3: Perform Gap Analysis
Create a detailed gap analysis comparing the algorithms/techniques from papers against what exists in the codebase. Identify specific missing implementations such as:
- Similarity threshold deltas and floor values
- Utility-gated skill creation
- Deterministic vs. interpreted reward signals
- Momentum/EMA terms
- Surprise-gated memory updates
- Temporal decay mechanisms

### Step 4: Generate Actionable Recommendations
Propose 5-7 concrete, implementable improvements ranked by impact and feasibility. Each recommendation should cite which paper(s) it derives from and how it applies to the MCP system.

## Output Format

Deliver a structured gap analysis document containing:
1. **Papers Summary**: One-paragraph overview of each paper's core contribution
2. **Current State Assessment**: Architecture and key features of existing implementation
3. **Gap Inventory**: Numbered list of missing features with severity levels
4. **Improvement Recommendations**: Actionable items with paper citations, implementation notes, and estimated effort