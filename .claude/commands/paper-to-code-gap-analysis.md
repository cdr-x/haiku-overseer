```markdown
---
description: "Use this command to analyze research papers and extract algorithmic improvements applicable to the MCP/RLM plugin codebase."
---

# Paper-to-Code Gap Analysis

Reads academic papers from the docs/ directory, extracts key algorithms and techniques, performs a comprehensive gap analysis against the current codebase, and identifies specific implementation opportunities.

## Instructions

### Step 1: Locate and Read All Papers
Read all .mhtml and research documents in the user's docs/ directory. Common papers include:
- Recursive Language Models (RLMs)
- MemRL: Self-Evolving Agents via Runtime Reinforcement Learning
- Titans: Learning to Memorize at Test Time
- DAPO and RL survey papers

### Step 2: Extract Key Algorithms
For each paper, extract:
- Core algorithms and mathematical formulas
- Key techniques (e.g., delta thresholds, utility gating, momentum terms)
- Data structures and control flow patterns
- Hyperparameter strategies

### Step 3: Audit Current Codebase
Comprehensively read all source files (rlm.ts, db.ts, embeddings.ts, chunking.ts, hooks/*.cjs, server.ts) to understand the current implementation state.

### Step 4: Perform Gap Analysis
Create a structured comparison identifying:
- Which paper algorithms are already implemented
- Which algorithms are missing or partially implemented
- Priority ranking for missing features (impact vs. complexity)
- Specific code locations where changes would apply

### Step 5: Deliver Recommendations
Provide actionable recommendations with:
- Exact gaps (e.g., "no Phase A delta threshold", "reward signal lacks determinism")
- Implementation difficulty assessment
- Suggested code changes with file/function locations

## Output Format

Deliver a comprehensive gap analysis report including:
1. Summary table of papers vs. implemented features
2. Detailed gap descriptions with code references
3. Prioritized implementation roadmap
4. Code snippets or pseudocode for recommended improvements