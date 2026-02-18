---
description: "Use this command to analyze, implement, and test research paper techniques in the haiku-overseer plugin codebase"
---

# Implement Paper Techniques

Analyze the current state of the codebase against research paper formulas, implement missing techniques, and verify they're working correctly through logging and testing.

## Instructions

### Step 1: Audit Current Implementation
Read the key source files (src/rlm.ts, src/embeddings.ts, src/paper-formulas.ts, src/haiku.ts, src/db.ts, src/chunking.ts) and identify:
- Which paper techniques are already implemented
- Which specific mechanisms are NOT yet implemented
- What gaps exist between the research and current code

### Step 2: Implement Missing Techniques
For each missing or incomplete technique:
- Add the formula/logic to the appropriate file
- Update paper-formulas.ts with constants if needed
- Implement in the relevant execution path (fast path or slow path for utilities)
- Ensure append-mode logging captures the execution

### Step 3: Add Logging & Testing
- Implement append-mode file logging to capture private exchanges (system prompts, user→model exchanges, consolidation calls, convergence stats)
- Log to `.haiku-overseer/conversation.log` or appropriate audit file
- Create tests that verify private conversations are happening and being recorded
- Check that all exchanges produce expected output in the log file

### Step 4: Clean Build & Validation
- Perform a clean build
- Verify no compilation errors
- Confirm logging files exist and contain expected data
- Test that reward shaping, memory updates, and convergence tracking work end-to-end

## Output Format

Provide:
1. Summary of implemented techniques with line references
2. List of any remaining gaps
3. Log file excerpts showing successful private exchanges
4. Build status confirmation
5. Test results confirming logging functionality