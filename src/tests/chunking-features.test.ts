import { describe, it, expect, afterEach } from "vitest";
import { setTargetTokens, getTargetTokens, chunkTurn } from "../chunking.js";

afterEach(() => {
  // Reset to default after each test
  setTargetTokens(500);
});

describe("setTargetTokens / getTargetTokens", () => {
  it("round-trips the target token value", () => {
    setTargetTokens(250);
    expect(getTargetTokens()).toBe(250);

    setTargetTokens(1000);
    expect(getTargetTokens()).toBe(1000);
  });
});

describe("chunkTurn at different target sizes", () => {
  // Generate a long text that will definitely exceed 250 tokens
  const longText = Array.from({ length: 200 }, (_, i) => `This is sentence number ${i + 1} with some extra words to pad it out.`).join(" ");

  it("produces more chunks at 250 tokens than at 1000 tokens", () => {
    setTargetTokens(250);
    const chunksSmall = chunkTurn(longText, "Short response.");

    setTargetTokens(1000);
    const chunksLarge = chunkTurn(longText, "Short response.");

    expect(chunksSmall.length).toBeGreaterThan(chunksLarge.length);
  });
});

describe("reset after set", () => {
  it("set to 250 then reset to 500 produces expected value", () => {
    setTargetTokens(250);
    expect(getTargetTokens()).toBe(250);

    setTargetTokens(500);
    expect(getTargetTokens()).toBe(500);
  });
});
