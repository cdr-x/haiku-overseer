---
description: "Use this command when you need to analyze research paper implementations, identify gaps between theory and code, and generate a structured implementation plan."
---

# Paper-to-Plugin Gap Analysis

Analyzes current codebase against research paper specifications, identifies unimplemented mechanisms, and generates a prioritized implementation roadmap.

## Instructions

### Step 1: Read and Inventory Current Implementation
Request the user provide or allow reading of all source files (typically: rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts). Create a comprehensive inventory of what paper techniques ARE currently implemented with specific code locations and what mechanisms are NOT yet implemented.

### Step 2: Map Paper Techniques to Code
For each research paper cited (DAPO, MemRL, Recursive Language Models, Titans, etc.), document:
- Which techniques are implemented (with file paths and line references)
- Which techniques are partially implemented (what's missing)
- Which techniques are completely absent
- Any unauthorized or divergent implementations

### Step 3: Identify Critical Gaps
List specific gaps that block the next phase of development:
- Missing Bellman operations or EMA utilities
- Absent reward shaping mechanisms
- Unimplemented memory persistence layers
- Safety or convergence checks that don't exist

### Step 4: Generate Prioritized Implementation Plan
Produce a numbered plan organizing work into:
- Bugfixes (correctness issues in existing code)
- Quick wins (single-file, low-risk implementations)
- Core momentum items (multi-file systems that unlock other features)
- Safety/validation additions

## Output Format

Deliver a structured gap analysis including:
1. Implementation inventory table (technique name | implemented | file location | status)
2. Critical gaps list with priority levels
3. 12-item (or appropriate length) paper-to-plugin implementation plan
4. Specific code locations and formulas needed for each gap
5. Build verification confirmation