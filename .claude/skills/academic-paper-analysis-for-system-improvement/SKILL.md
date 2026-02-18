---
name: academic-paper-analysis-for-system-improvement
description: "Analyzes academic papers to extract algorithms and techniques applicable to the current codebase, identifies implementation gaps, and recommends actionable improvements"
allowed-tools: "Read,Glob,Grep"
model: "inherit"
version: "1.0.0"
---

# Purpose

Extract key ideas, algorithms, and techniques from academic papers, perform gap analysis against current codebase implementation, and generate actionable improvement recommendations.

## Overview

This skill systematizes the process of learning from research papers and translating that knowledge into concrete improvements for a codebase. It involves three phases: (1) comprehensive paper extraction, (2) codebase state analysis and gap identification, and (3) prioritized actionable recommendations based on research findings.

## Instructions

### Step 1: Comprehensive Paper Extraction
Read all academic papers in the docs/ directory. For each paper, extract:
- Core algorithms and formulas
- Key ideas and techniques
- Problem statements and solutions
- Applicability to the target system (e.g., MCP server, retrieval systems, RL pipelines)

### Step 2: Codebase State Analysis
Read all source files (*.ts, *.js, *.json) to understand:
- Current implementation architecture
- Data flow and pipeline structure
- Existing algorithm implementations
- Parameter configurations and thresholds

### Step 3: Gap Analysis
Compare paper algorithms against codebase implementation and identify:
- Missing algorithmic components
- Unimplemented thresholds or gating mechanisms
- Non-deterministic vs deterministic signal handling
- Optimization opportunities (EMA, momentum, temporal decay)

### Step 4: Prioritized Recommendations
Generate 5-7 actionable improvements ranked by:
- Implementation feasibility
- Expected impact on system performance
- Alignment with paper findings
- Dependencies on other components

## Output Format

Deliver a structured analysis containing:
1. **Gap Analysis Table**: Lists 4+ specific gaps with current vs. recommended approach
2. **Recommendations List**: Numbered improvements with:
   - Description of change
   - Algorithm/technique reference from papers
   - Implementation guidance
   - Expected outcome
3. **Priority Ranking**: Based on feasibility and impact