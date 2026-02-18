---
description: "Use when analyzing research papers against a codebase to identify implementation gaps and missing techniques"
---

# Paper-to-Implementation Gap Analysis

Analyzes academic papers in docs/ against the current codebase to identify what techniques are implemented, what's missing, and what specific mechanisms need to be added.

## Instructions
### Step 1: Comprehensive File Review
Read all source files in the codebase (rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts, server.ts, and any hooks/). Create a detailed inventory of what's currently implemented.

### Step 2: Paper Extraction
Read all research paper files referenced (DAPO, MemRL, Titans, Recursive Language Models, RL survey). Extract key algorithms, techniques, and formulas from each paper.

### Step 3: Gap Analysis
For each paper, systematically compare implemented features against paper algorithms. Document:
- What IS implemented (cite specific functions/files)
- What is NOT implemented (list missing mechanisms)
- Which specific paper techniques lack code equivalents

### Step 4: Prioritized Recommendations
Rank gaps by impact. Suggest which gaps are critical blockers vs. nice-to-have optimizations. Note dependencies between missing features.

## Output Format
Deliver structured gap analysis covering:
1. Summary table: Paper name | Techniques Implemented | Gaps Identified | Priority
2. Detailed per-paper breakdown with code citations
3. Specific mechanism gaps (e.g., "Phase A delta threshold missing", "utility gating not enforced on skill creation")
4. Recommended implementation order