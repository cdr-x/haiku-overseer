---
description: "Use this command when you need to analyze code implementations against research papers and identify gaps between theory and practice."
---

# Paper-to-Code Gap Analysis

Analyzes the current state of implementation across multiple files to identify which research paper techniques are already implemented and which mechanisms are missing.

## Instructions
### Step 1: Identify Target Files
Request a list of source files to analyze (e.g., src/rlm.ts, src/embeddings.ts, src/paper-formulas.ts, src/haiku.ts, src/db.ts, src/chunking.ts).

### Step 2: Read All Files
Perform a comprehensive read of each file to understand current implementations, data structures, and function signatures.

### Step 3: Cross-Reference with Papers
For each research paper technique mentioned (DAPO, MemRL, Titans, Recursive Language Models, etc.), determine:
- Whether it is implemented
- Which file(s) contain the implementation
- Specific mechanism details (e.g., "EMA Q-values", "z-score normalization", "memory_weight column")

### Step 4: Document Gaps
Create a structured list of:
- **Implemented techniques**: With file locations and brief descriptions
- **Missing mechanisms**: Specific gaps between paper algorithms and codebase (e.g., "no Phase A delta threshold", "no utility gating on skill creation")
- **Partially implemented**: Features that exist but lack key components

### Step 5: Recommend Priorities
Suggest which gaps should be addressed first based on dependency order and impact.

## Output Format
Return a detailed gap analysis document that lists:
1. Summary of files analyzed
2. Table of implemented paper techniques by file
3. Numbered list of gaps with severity/priority
4. Recommended implementation order with brief rationales