---
description: "Use this command to implement research paper techniques into the haiku-overseer plugin and verify their integration through logging and testing."
---

# Paper-to-Plugin Implementation

Systematically implement techniques from research papers (DAPO, MemRL, Titans, RLMs) into the haiku-overseer plugin, then verify integration through conversation logging and gap analysis.

## Instructions

### Step 1: Analyze Current Implementation State
Read the core files (src/rlm.ts, src/embeddings.ts, src/paper-formulas.ts, src/haiku.ts, src/db.ts, src/chunking.ts) and produce a detailed gap analysis identifying:
- What paper techniques are already implemented
- What specific mechanisms are NOT yet implemented
- Which formulas or algorithms need integration

### Step 2: Implement Paper Techniques
Based on the gap analysis, implement missing techniques in priority order:
- EMA utility updates (exponential moving average)
- MIN_SIMILARITY thresholds and normalization
- Titans test-time memorization (memory_weight column)
- DAPO reward shaping (z-score normalization, group-relative rewards)
- Two-phase value function retrieval paths
- Dynamic sampling gates and convergence mechanisms

### Step 3: Add Conversation Logging
Integrate append-mode file logging to capture private exchanges:
- Log to `.haiku-overseer/conversation.log`
- Capture system prompts, user↔haiku exchanges, consolidation calls
- Record convergence stats and value function outputs
- Ensure logs are human-readable for verification

### Step 4: Verify Integration with Tests
Create tests that confirm:
- Conversations are being logged correctly
- Value function outputs appear in logs
- Multiple exchange rounds are captured and consolidated
- Reward propagation flows through the system

### Step 5: Cross-Reference with Flow Patterns
Identify useful patterns from @agentic-flow and @claude-flow:
- Multi-agent coordination patterns
- State management approaches
- Exchange architecture best practices

## Output Format

Provide:
1. Summary of implemented techniques with file locations
2. List of remaining gaps with implementation priority
3. Sample conversation.log entries showing successful logging
4. Test results confirming private exchange capture
5. Recommendations for @agentic-flow / @claude-flow pattern integration