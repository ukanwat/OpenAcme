import { describe, expect, it } from "vitest";
import {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessNote,
} from "../src/freshness.js";

const ONE_DAY_MS = 86_400_000;

describe("memoryAgeDays", () => {
  it("returns 0 for now", () => {
    expect(memoryAgeDays(Date.now())).toBe(0);
  });
  it("returns 1 for ~1 day ago", () => {
    expect(memoryAgeDays(Date.now() - ONE_DAY_MS - 1000)).toBe(1);
  });
  it("returns 47 for 47 days ago", () => {
    expect(memoryAgeDays(Date.now() - 47 * ONE_DAY_MS - 1000)).toBe(47);
  });
  it("clamps negative inputs (future mtime / clock skew) to 0", () => {
    expect(memoryAgeDays(Date.now() + 10 * ONE_DAY_MS)).toBe(0);
  });
});

describe("memoryAge", () => {
  it("formats today / yesterday / N days ago", () => {
    expect(memoryAge(Date.now())).toBe("today");
    expect(memoryAge(Date.now() - ONE_DAY_MS - 1000)).toBe("yesterday");
    expect(memoryAge(Date.now() - 47 * ONE_DAY_MS - 1000)).toBe("47 days ago");
  });
});

describe("memoryFreshnessNote", () => {
  it("is empty for today and yesterday (warning would be noise)", () => {
    expect(memoryFreshnessNote(Date.now())).toBe("");
    expect(memoryFreshnessNote(Date.now() - ONE_DAY_MS - 1000)).toBe("");
  });

  it("emits the verbatim wrapper for ≥2 days old", () => {
    const note = memoryFreshnessNote(Date.now() - 2 * ONE_DAY_MS - 1000);
    expect(note).toContain("<system-reminder>");
    expect(note).toContain("This memory is 2 days old");
    expect(note).toContain("point-in-time observations, not live state");
    expect(note).toContain("Verify against current code before asserting as fact");
    expect(note).toContain("</system-reminder>");
    expect(note.endsWith("\n")).toBe(true);
  });

  it("uses the actual day count in the wrapper", () => {
    const note = memoryFreshnessNote(Date.now() - 47 * ONE_DAY_MS - 1000);
    expect(note).toContain("This memory is 47 days old");
  });
});
