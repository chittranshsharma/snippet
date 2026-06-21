import { describe, it, expect } from "vitest";
import { maskProfanity, containsProfanity } from "../profanity.js";

describe("profanity", () => {
  it("detects a plain profane word", () => {
    expect(containsProfanity("you are a fuck")).toBe(true);
    expect(containsProfanity("a clean sentence")).toBe(false);
  });

  it("masks profane tokens with same-length asterisks, preserving structure", () => {
    expect(maskProfanity("hello shit heads")).toBe("hello **** heads");
    expect(maskProfanity("clean text")).toBe("clean text");
  });

  it("catches plural / suffixed forms via stemming", () => {
    expect(maskProfanity("hello fuckers and shit")).toBe("hello ******* and ****");
    expect(containsProfanity("bitches")).toBe(true);
  });

  it("normalizes leet-speak and repeated letters", () => {
    expect(containsProfanity("sh1t")).toBe(true);
    expect(containsProfanity("fuuuuck")).toBe(true);
    expect(containsProfanity("f@g")).toBe(true);
  });

  it("does not over-match spaced single letters", () => {
    expect(maskProfanity("f u c k")).toBe("f u c k");
  });

  it("handles empty / nullish input", () => {
    expect(maskProfanity("")).toBe("");
    expect(maskProfanity(null)).toBe("");
    expect(containsProfanity(undefined)).toBe(false);
  });
});
