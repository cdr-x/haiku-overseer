---
description: "Analyze research papers and academic documents, extract algorithms and key ideas, then identify gaps between theory and current codebase implementation"
---

# Paper Analysis & Gap Detection

Reads academic papers from a docs directory, extracts key algorithms and techniques, performs gap analysis against current codebase implementation, and generates actionable improvement recommendations.

## Instructions

### Step 1: Locate and Read Source Documents
Search the docs/ directory for academic papers (typically .mhtml or .pdf files). Read ALL papers completely, extracting:
- Core algorithms and mathematical formulas
- Key techniques and methodologies
- System architecture patterns
- Claims and experimental results

### Step 2: Analyze Current Codebase
Read all source files in the project (*.ts, *.cjs, package.json) to understand:
- Current implementation details
- Existing algorithms and data structures
- Hook execution flow and timing
- Configuration and thresholds

### Step 3: Identify Implementation Gaps
Compare paper algorithms against codebase systematically. Document gaps as:
- Missing threshold parameters (e.g., similarity delta, utility floors)
- Unimplemented algorithmic components (e.g., surprise-gated updates, momentum terms)
- Architectural mismatches (e.g., non-deterministic vs deterministic reward signals)
- Optimization opportunities (e.g., EMA, temporal decay)

### Step 4: Generate Recommendations
Provide 5-7 prioritized, actionable improvements based on:
- Direct applicability to the MCP server architecture
- Implementation complexity assessment
- Expected impact on system performance
- Required code modifications

## Output Format

Deliver a comprehensive gap analysis containing:
1. Summary of papers analyzed and their core contributions
2. Detailed list of 4+ gaps with specific citations
3. 7 actionable improvements with implementation guidance
4. Priority ranking and effort estimates