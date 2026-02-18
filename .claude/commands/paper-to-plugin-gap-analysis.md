---
description: "Use this command to analyze research paper implementations, identify gaps between academic algorithms and current codebase, and plan implementation roadmaps."
---

# Paper-to-Plugin Gap Analysis

Performs comprehensive analysis of research paper techniques against current codebase implementation, identifies missing mechanisms, and generates structured implementation plans.

## Instructions
### Step 1: Load and Summarize Research Papers
Read all referenced research papers (MemRL, DAPO, Titans, RLMs, RL surveys) and extract key algorithms, techniques, and mechanisms. Organize by paper with clear mechanism names.

### Step 2: Audit Current Codebase
Perform comprehensive read of all relevant source files (rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts). Document what is already implemented with code references.

### Step 3: Identify Implementation Gaps
Create a gap matrix showing:
- What mechanisms from papers ARE implemented (with file locations)
- What mechanisms are NOT yet implemented (with specific algorithm names)
- Which gaps are blockers vs. enhancements
- Priority scoring for each gap

### Step 4: Generate Implementation Plan
Produce a prioritized roadmap with:
- Quick-win improvements (low effort, high impact)
- Critical gaps (algorithmic correctness)
- Infrastructure needs (logging, monitoring, persistence)
- Dependencies between items

### Step 5: Create Validation Tests
Suggest specific tests to verify each mechanism is working (file logging, convergence checks, reward signal verification, memory persistence).

## Output Format
Deliver structured gap analysis with:
1. **Paper Summary Table** — technique name, key equations, implementation status
2. **Gap List** — ordered by priority with specific code locations
3. **Implementation Roadmap** — 12-item checklist with dependencies
4. **Suggested Test Commands** — how to validate each mechanism