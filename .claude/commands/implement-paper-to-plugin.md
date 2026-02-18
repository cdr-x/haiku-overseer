---
description: "Implement architectural patterns from research papers into the haiku-overseer plugin system"
---

# Implement Paper-to-Plugin Architecture

Synthesizes research paper concepts, algorithms, and techniques into concrete plugin implementations with multi-exchange inference, reward shaping, and persistent logging.

## Instructions

### Step 1: Extract Paper Concepts
Read and analyze the referenced research documents (Recursive Language Models, MemRL, Titans, etc.) in @docs/. Identify key algorithms, formulas, and architectural patterns that are NOT yet implemented in the codebase.

### Step 2: Gap Analysis
Compare extracted concepts against current implementation in haiku.ts, rlm.ts, embeddings.ts, and paper-formulas.ts. Document missing components:
- Missing delta thresholds or gating mechanisms
- Reward signal implementation gaps
- Momentum terms or convergence strategies
- Persistent memory/logging infrastructure

### Step 3: Implement Core Components
Build or update 4-file architecture:
- **embeddings.ts**: Geometric helpers and vector operations
- **paper-formulas.ts**: Formula constants and schema definitions
- **haiku.ts**: Multi-exchange convergence with logging to `.haiku-overseer/conversation.log`
- **rlm.ts**: Fast/slow utility paths with reward propagation

### Step 4: Add Observability
Implement append-mode file logging for private exchanges. Log system prompts, each round's user↔haiku exchanges, consolidation calls, and convergence statistics.

### Step 5: Hook Integration
Update capture-turn.cjs, user-prompt-submit.cjs, and post-tool-use.cjs to enforce stop-hook blocking and soft nudging based on command confidence thresholds.

### Step 6: Test & Validate
Verify private conversations are logged. Test convergence behavior and reward propagation. Confirm no build errors.

## Output Format

Command completes with:
1. Clean build confirmation
2. Summary of implemented components (files modified, functions added)
3. Logging verification (conversation.log entries present)
4. Any convergence statistics or utility metrics from multi-exchange runs