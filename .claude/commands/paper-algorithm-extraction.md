---
description: "Analyze research papers and academic documents to extract algorithms applicable to the RLM MCP server codebase"
---

# Paper Algorithm Extraction & Gap Analysis

Systematically read academic papers from the docs directory, extract key algorithms and techniques, compare against current codebase implementation, and identify actionable gaps.

## Instructions

### Step 1: Read and Index All Papers
- Locate all `.mhtml` and `.md` files in the docs directory
- For each paper, extract: title, key algorithms, mathematical formulas, core concepts, and methodologies
- Create a structured index of all discovered techniques

### Step 2: Analyze Current Codebase Implementation
- Read all source files: `rlm.ts`, `db.ts`, `embeddings.ts`, `chunking.ts`, `rlm-retrieve.cjs`, `user-prompt-submit.cjs`, `server.ts`, `package.json`
- Document the current implementation approach for: memory retrieval, skill creation, reward signals, utility tracking, and memory updates
- Map existing code to paper concepts where applicable

### Step 3: Perform Gap Analysis
- Compare each paper's algorithms against current implementation
- Identify specific gaps (e.g., missing thresholds, ungated operations, non-deterministic signals)
- Assess impact and applicability of each gap to system performance

### Step 4: Generate Actionable Recommendations
- Rank gaps by implementation feasibility and potential impact
- Provide concrete improvement suggestions with references to paper sections
- Include code locations where changes would apply

## Output Format

Deliver a structured gap analysis containing:
1. **Paper Index**: List of papers with key algorithms extracted
2. **Implementation Summary**: Current codebase approach for core functions
3. **Gap Table**: Specific gaps with paper references, impact assessment, and recommended fixes
4. **Priority Recommendations**: Ranked list of 5-7 actionable improvements