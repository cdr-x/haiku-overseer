---
description: "Analyze research papers and academic algorithms to identify gaps in current implementation and recommend improvements"
---

# Research Gap Analysis

Extracts key ideas, techniques, and algorithms from academic papers, performs gap analysis against current codebase implementation, and delivers actionable improvement recommendations.

## Instructions

### Step 1: Locate and Read All Research Documents
Use `Glob` to find all documentation files in the `/docs/` directory (`.mhtml`, `.md`, `.pdf` formats). Read each file completely using `Read`.

### Step 2: Extract Key Algorithms and Formulas
For each paper, identify and document:
- Core algorithms and mathematical formulas
- Key techniques and methodologies
- Specific parameters, thresholds, or gating mechanisms mentioned
- Applicability to the current system context

### Step 3: Analyze Current Implementation
Use `Read` to examine all source files (`rlm.ts`, `db.ts`, `embeddings.ts`, `chunking.ts`, `*.cjs`, `server.ts`). Map current implementation against extracted paper concepts.

### Step 4: Identify Implementation Gaps
Document discrepancies between:
- Paper algorithms vs. current code logic
- Suggested parameters vs. actual implementation
- Missing gating mechanisms or thresholds
- Absent reward signals, decay functions, or update rules

### Step 5: Generate Actionable Recommendations
Provide 5-7 specific, implementation-ready improvements with:
- Paper source and formula reference
- Current gap description
- Concrete code change or architectural adjustment needed
- Expected impact on system behavior

## Output Format

Deliver a structured analysis with:
1. **Extracted Concepts Table** — Papers, key ideas, formulas
2. **Gap Analysis** — 4+ gaps identified with evidence
3. **Recommendations** — Numbered improvements with implementation guidance
4. **Priority Ranking** — High/Medium/Low impact ordering