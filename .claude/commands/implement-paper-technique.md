```markdown
---
description: "Use when implementing research paper techniques into the haiku-overseer plugin codebase"
---

# Implement Paper Technique

Systematically implement academic research algorithms (from papers like DAPO, MemRL, Titans, RLMs) into the haiku-overseer plugin by reading current state, identifying gaps, and executing implementation with file logging.

## Instructions
### Step 1: Analyze Current Implementation
Read the relevant source files (rlm.ts, embeddings.ts, paper-formulas.ts, haiku.ts, db.ts, chunking.ts) to understand what paper techniques are already implemented and identify specific gaps or missing mechanisms.

### Step 2: Perform Gap Analysis
Document the differences between the academic paper algorithms and current codebase implementation. List what IS implemented and what is NOT yet implemented, with specific technical details (thresholds, formulas, gating conditions).

### Step 3: Implement the Feature
Modify the necessary files to close identified gaps. Focus on: value functions, reward shaping, memory mechanisms, convergence logic, or utility-based gating. Ensure append-mode logging is added to track private exchanges and conversational state.

### Step 4: Add Logging/Observability
Implement file logging to .haiku-overseer/conversation.log to capture: system prompts, user↔model exchanges, consolidation calls, and convergence statistics. This enables verification that private conversations are happening.

### Step 5: Verify and Report
Perform clean build, confirm no errors, and deliver summary of what was implemented with before/after state.

## Output Format
- Summary of gap analysis findings
- List of modified files with specific changes
- Build status confirmation
- Location of conversation/execution logs for verification
```