---
description: "Use this when you need to analyze a codebase against research papers and identify implementation gaps, then plan concrete improvements."
---

# Analyze & Implement Research Paper Gaps

This command performs a comprehensive audit of your codebase against academic research papers, identifies what's missing, and generates a prioritized implementation plan.

## Instructions

### Step 1: Read All Source Files
Request the user to specify which source files to analyze (e.g., `src/rlm.ts`, `src/haiku.ts`, `src/embeddings.ts`, etc.). Perform a thorough read of each file to understand current implementation state.

### Step 2: Map to Research Papers
For each paper referenced (e.g., DAPO, MemRL, Titans, RLMs, DAPO), create a detailed mapping of:
- Specific techniques/formulas from the paper
- Whether they are implemented, partially implemented, or missing
- Current code locations where they appear

### Step 3: Generate Gap Analysis
Produce a structured gap analysis document listing:
- ✅ What IS implemented (with code locations)
- ❌ What IS NOT implemented (with paper section references)
- 🔶 What IS partially implemented (with completion status)

### Step 4: Prioritize Implementation Plan
Create a numbered action plan (8-12 items) ordered by:
1. Bugfixes and quick wins
2. Momentum items (partially done features)
3. Safety-critical features
4. Performance improvements
5. Advanced features (reward shaping, persistent memory, etc.)

### Step 5: Output Deliverables
Provide the gap analysis and implementation plan in a structured markdown format with clear sections and actionable items.

## Output Format

Return a comprehensive document with:
- **Gap Analysis Table** (paper technique → implementation status → location)
- **Missing Mechanisms** (detailed per paper)
- **12-Item Implementation Roadmap** (numbered, prioritized)
- **Code Locations** (file paths for context)