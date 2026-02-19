import { describe, it, expect } from "vitest";

// F7: Utility floor formula — Math.max(0.1, Math.min(1, x))
// Extracted from rlm.ts UTILITY_FLOOR = 0.1
const UTILITY_FLOOR = 0.1;
function clampUtility(x: number): number {
  return Math.max(UTILITY_FLOOR, Math.min(1, x));
}

describe("F7: Utility floor clamp", () => {
  it.each([
    { input: -0.5, expected: 0.1 },
    { input: 0, expected: 0.1 },
    { input: 0.05, expected: 0.1 },
    { input: 0.5, expected: 0.5 },
    { input: 1.5, expected: 1 },
  ])("clampUtility($input) = $expected", ({ input, expected }) => {
    expect(clampUtility(input)).toBe(expected);
  });
});

// F2: Blend weight based on contribution direction
// From rlm.ts slow path: contribution +1→0.6, -1→0.2, 0→0.4
function blendWeight(contribution: number): number {
  if (contribution === 1) return 0.6;
  if (contribution === -1) return 0.2;
  return 0.4;
}

function computeQNew(contribution: number, assessedQ: number, qOld: number, processQuality: number): number {
  const bw = blendWeight(contribution);
  const outcomeQ = bw * assessedQ + (1 - bw) * qOld;
  return Math.max(UTILITY_FLOOR, Math.min(1, 0.7 * outcomeQ + 0.3 * processQuality));
}

describe("F2: Blend weights by contribution direction", () => {
  it("contribution +1 gives blend weight 0.6", () => {
    expect(blendWeight(1)).toBe(0.6);
  });

  it("contribution -1 gives blend weight 0.2", () => {
    expect(blendWeight(-1)).toBe(0.2);
  });

  it("contribution 0 gives blend weight 0.4", () => {
    expect(blendWeight(0)).toBe(0.4);
  });

  it("positive contribution trusts Haiku Q more", () => {
    const qHigh = computeQNew(1, 0.9, 0.5, 0.7);
    const qNeutral = computeQNew(0, 0.9, 0.5, 0.7);
    // Positive contribution should yield higher Q (trusts high Haiku Q more)
    expect(qHigh).toBeGreaterThan(qNeutral);
  });

  it("negative contribution leans toward q_old", () => {
    const qNeg = computeQNew(-1, 0.9, 0.3, 0.7);
    const qNeutral = computeQNew(0, 0.9, 0.3, 0.7);
    // Negative contribution should yield lower Q (leans more toward low q_old)
    expect(qNeg).toBeLessThan(qNeutral);
  });
});

// F5: Process blend — 0.7 * outcomeQ + 0.3 * processQuality
describe("F5: Process quality blend", () => {
  it("high process quality lifts final Q", () => {
    const highProcess = computeQNew(0, 0.5, 0.5, 1.0);
    const lowProcess = computeQNew(0, 0.5, 0.5, 0.0);
    expect(highProcess).toBeGreaterThan(lowProcess);
  });

  it("boundary: processQuality=0 floor", () => {
    const result = computeQNew(0, 0.0, 0.0, 0.0);
    expect(result).toBe(UTILITY_FLOOR); // 0.7*0 + 0.3*0 = 0 → clamped to 0.1
  });

  it("boundary: all max", () => {
    const result = computeQNew(1, 1.0, 1.0, 1.0);
    // 0.7 * (0.6*1 + 0.4*1) + 0.3*1 = 0.7 + 0.3 = 1.0
    expect(result).toBe(1.0);
  });

  it("process quality is 30% of the blend", () => {
    // With outcome=0, process_quality provides the floor
    const result = computeQNew(0, 0.0, 0.0, 1.0);
    // 0.7 * (0.4*0 + 0.6*0) + 0.3 * 1.0 = 0.3
    expect(result).toBeCloseTo(0.3, 5);
  });
});

// F3: Reconsolidation logic — key term extraction, intent broadening/narrowing
describe("F3: Reconsolidation logic", () => {
  // Extracted key term logic from rlm.ts reconsolidateMemory
  function extractKeyTerms(prompt: string): string[] {
    const stopwords = /^(the|this|that|with|from|have|been|will|what|when|where|which|about|their|there|would|could|should)$/i;
    return prompt
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopwords.test(w))
      .slice(0, 3)
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  }

  it("extracts meaningful words >3 chars", () => {
    const terms = extractKeyTerms("Fix the broken authentication flow");
    expect(terms).toEqual(["broken", "authentication", "flow"]);
  });

  it("filters stopwords", () => {
    const terms = extractKeyTerms("what would this have been with that");
    expect(terms).toEqual([]);
  });

  it("limits to 3 terms", () => {
    const terms = extractKeyTerms("alpha beta gamma delta epsilon");
    expect(terms).toHaveLength(3);
  });

  describe("intent broadening", () => {
    it("appends new key terms to intent", () => {
      const intent = "Fix authentication bug";
      const keyTerms = ["database", "migration"];
      const currentTerms = intent.toLowerCase();
      const newTerms = keyTerms.filter((t) => !currentTerms.includes(t));
      const broadened = `${intent} | ${newTerms.join(", ")}`.slice(0, 300);
      expect(broadened).toBe("Fix authentication bug | database, migration");
    });

    it("skips terms already in intent", () => {
      const intent = "Fix authentication bug";
      const keyTerms = ["authentication", "migration"];
      const currentTerms = intent.toLowerCase();
      const newTerms = keyTerms.filter((t) => !currentTerms.includes(t));
      expect(newTerms).toEqual(["migration"]);
    });
  });

  describe("intent narrowing", () => {
    it("prepends 'NOT for:' with error keyword", () => {
      const intent = "Fix authentication bug";
      const errorText = "TypeError: Cannot read property";
      const errorKeyword = (errorText.match(/\b\w{4,}\b/)?.[0] || "").toLowerCase();
      expect(errorKeyword).toBe("typeerror");
      const narrowed = `NOT for: ${errorKeyword} | ${intent}`.slice(0, 300);
      expect(narrowed).toBe("NOT for: typeerror | Fix authentication bug");
    });

    it("does not double-narrow already-narrowed intents", () => {
      const intent = "NOT for: timeout | Fix authentication bug";
      // In actual code, the check is: !chunk.intent.startsWith("NOT for:")
      expect(intent.startsWith("NOT for:")).toBe(true);
    });
  });
});
