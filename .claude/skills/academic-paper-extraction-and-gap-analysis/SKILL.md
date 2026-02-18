---
name: academic-paper-extraction-and-gap-analysis
description: "Extract key ideas, algorithms, and techniques from academic papers, then analyze implementation gaps against existing codebase"
allowed-tools: "Read,Glob,Grep"
model: "inherit"
version: "1.0.0"
---

# Purpose

Systematically extract algorithms and concepts from academic papers, then perform gap analysis between paper specifications and current codebase implementation.

## Overview

This skill enables comprehensive analysis of academic research by reading multiple papers, extracting key algorithms and formulas, and comparing them against an existing codebase to identify missing implementations or incomplete features. It's particularly useful for reinforcement learning, language model, and memory-based system research.

## Instructions

### Step 1: Locate and Read All Target Papers
Use Glob to find all paper files in the specified directory (typically .mhtml or .pdf formats). Read each file completely to extract content.

### Step 2: Extract Key Ideas and Algorithms
For each paper, identify and document:
- Core algorithms (pseudocode/formulas)
- Key techniques and methodologies
- Data structures used
- Performance characteristics
- Applicability to the target system

### Step 3: Perform Codebase Review
Read all relevant source files in the target repository to understand:
- Current implementation architecture
- Data flow and pipeline stages
- Existing algorithm implementations
- Configuration and threshold mechanisms

### Step 4: Identify Implementation Gaps
Compare extracted algorithms against codebase to document:
- Missing algorithm phases or steps
- Unimplemented thresholds or gating mechanisms
- Simplified implementations vs. paper specifications
- Missing reward signals or feedback mechanisms

### Step 5: Deliver Gap Analysis Report
Synthesize findings into structured report listing:
- Paper name and key contribution
- Expected implementation vs. actual implementation
- Specific gaps with line-by-line code references
- Priority recommendations for implementation

## Output Format

Structured gap analysis document containing:
- Summary of papers analyzed
- Implementation gaps (numbered list)
- Gap descriptions with paper references
- Current codebase limitations
- Recommendations for closing each gap