import { describe, it, expect } from "vitest";
import { CONVERGENT_ROUND_SCHEMA, COMPOSITE_SKILL } from "../paper-formulas.js";

describe("CONVERGENT_ROUND_SCHEMA", () => {
  const chunkProps = CONVERGENT_ROUND_SCHEMA.input_schema.properties.chunk_assessments.items.properties;

  it("has contribution field with type integer", () => {
    expect(chunkProps).toHaveProperty("contribution");
    expect(chunkProps.contribution.type).toBe("integer");
  });

  it("has process_quality field with type number", () => {
    expect(chunkProps).toHaveProperty("process_quality");
    expect(chunkProps.process_quality.type).toBe("number");
  });

  it("includes contribution and process_quality in required array", () => {
    const required = CONVERGENT_ROUND_SCHEMA.input_schema.properties.chunk_assessments.items.required;
    expect(required).toContain("contribution");
    expect(required).toContain("process_quality");
  });
});

describe("COMPOSITE_SKILL prompt", () => {
  it("contains contribution guidance", () => {
    expect(COMPOSITE_SKILL).toContain("contribution");
  });

  it("contains process_quality guidance", () => {
    expect(COMPOSITE_SKILL).toContain("process_quality");
  });

  it("describes contribution values (-1, 0, +1)", () => {
    expect(COMPOSITE_SKILL).toContain("+1");
    expect(COMPOSITE_SKILL).toContain("-1");
  });
});
