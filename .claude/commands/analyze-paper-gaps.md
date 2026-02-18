---
description: "Use this command to analyze a codebase against research papers and implement missing mechanisms from academic techniques"
---

# /analyze-paper-gaps

Performs a comprehensive gap analysis between academic research implementations and current codebase, then generates a structured implementation plan for missing mechanisms.

## Instructions

### Step 1: Codebase Inventory
Read all relevant source files (typically rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts). Create a detailed inventory of:
- Currently implemented algorithms and techniques
- Data structures and their purposes
- Existing logging and monitoring infrastructure

### Step 2: Paper Technique Mapping
Cross-reference the codebase against the research papers being studied. For each paper, identify:
- Which techniques ARE implemented (with code locations)
- Which techniques are PARTIALLY implemented (incomplete mechanisms)
- Which techniques are NOT implemented at all

### Step 3: Gap Analysis Documentation
Produce a structured report listing:
- Specific missing mechanisms (e.g., "Phase A similarity threshold delta")
- Unmapped paper formulas and algorithms
- Gating conditions that should exist but don't (e.g., utility thresholds, retrieval gates)
- Deterministic vs. interpreted signal flows that deviate from paper specs

### Step 4: Implementation Roadmap
Generate a prioritized 12-item implementation plan covering:
- Critical bugfixes blocking other work
- Quick wins (2-3 hour tasks)
- Momentum features from papers
- Safety guardrails and validation
- Reward shaping refinements
- Persistent memory mechanisms

## Output Format

Deliver a comprehensive gap analysis document with four sections:
1. **Implemented Features** — what's working, with file/line references
2. **Gap List** — specific mechanisms not yet implemented
3. **Architecture Misalignments** — where current design deviates from papers
4. **Prioritized 12-Item Implementation Plan** — ordered by dependency and impact