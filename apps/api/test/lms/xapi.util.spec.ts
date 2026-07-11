// Unit: xAPI verb allow-list + result normalisation (pure).
import { isXapiVerb, normalizeXapiResult } from "../../src/lms/xapi.util";

describe("isXapiVerb", () => {
  it("accepts allow-listed verbs and rejects others", () => {
    expect(isXapiVerb("completed")).toBe(true);
    expect(isXapiVerb("passed")).toBe(true);
    expect(isXapiVerb("hacked")).toBe(false);
    expect(isXapiVerb("")).toBe(false);
    expect(isXapiVerb(null)).toBe(false);
  });
});

describe("normalizeXapiResult", () => {
  it("keeps recognised, well-typed fields and bounds them", () => {
    expect(normalizeXapiResult({ score: 8, max: 10, success: true, completion: true })).toEqual({
      score: 8,
      max: 10,
      success: true,
      completion: true,
    });
  });
  it("drops garbage / wrong-typed / non-positive fields", () => {
    expect(normalizeXapiResult({ score: "x", max: 0, success: "yes", junk: 1 })).toEqual({});
    expect(normalizeXapiResult(null)).toEqual({});
    expect(normalizeXapiResult({ response: "  hi  " })).toEqual({ response: "hi" });
  });
  it("caps an over-long response", () => {
    const r = normalizeXapiResult({ response: "a".repeat(5000) });
    expect((r.response ?? "").length).toBe(1000);
  });
});
