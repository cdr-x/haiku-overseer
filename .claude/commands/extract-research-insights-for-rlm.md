---
description: "Use this command to analyze academic papers and extract algorithmic improvements applicable to the RLM MCP server implementation"
---

# Extract Research Insights for RLM

Analyzes research papers in the docs directory, extracts key algorithms and techniques, performs gap analysis against current codebase implementation, and provides actionable improvement recommendations.

## Instructions

### Step 1: Read and Extract from Research Papers
Access all `.mhtml` files in the docs directory (typically: Recursive Language Models, MemRL, Titans, DAPO, RL survey). Extract:
- Core algorithms and mathematical formulas
- Key techniques and methodologies
- Specific parameters and thresholds mentioned
- Use cases and applicability notes

### Step 2: Analyze Current Codebase Implementation
Review source files (rlm.ts, db.ts, embeddings.ts, chunking.ts, rlm-retrieve.cjs, user-prompt-submit.cjs, server.ts, package.json) to understand:
- Current two-phase retrieval pipeline architecture
- Existing skill creation and reward signal mechanisms
- Memory update and utility calculation methods
- Hook execution flow and timing

### Step 3: Perform Gap Analysis
Identify specific mismatches between paper algorithms and implementation:
- Missing thresholds or gates (e.g., similarity delta, utility gating)
- Reward signal mechanisms (deterministic vs. interpreted)
- Memory update strategies (surprise-gated vs. current approach)
- Optimization techniques not yet implemented (EMA, momentum, temporal decay)

### Step 4: Generate Actionable Recommendations
Provide 5-7 specific improvements with:
- Paper source and relevant equations
- Implementation location in codebase
- Priority/impact assessment
- Code change scope estimate

## Output Format
Structured analysis with three sections: (1) Paper Extraction Summary, (2) Gap Analysis with 4+ identified gaps, (3) Prioritized Recommendations with implementation guidance. Include citations to specific papers and current code locations.