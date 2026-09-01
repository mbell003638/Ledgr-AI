import { externalIntentPath, parseExternalIntent } from "@/src/utils/externalIntent";

describe("external App Actions intent contract", () => {
  it("accepts navigation targets without granting write access", () => {
    const intent = parseExternalIntent({ target: "voice", source: "assistant" });
    expect(intent).toEqual({ target: "voice", source: "assistant" });
    expect(externalIntentPath(intent!)).toBe("/voice");
  });

  it("normalizes a draft request for review in Ask AI", () => {
    const intent = parseExternalIntent({ target: "draft", action: "payment", text: " Paid $100 to Amit ", amount: 100, source: "assistant" });
    expect(intent).toMatchObject({ target: "draft", action: "payment", text: "Paid $100 to Amit", amount: 100 });
    expect(externalIntentPath(intent!)).toBe("/ask");
  });

  it.each([
    { target: "draft", action: "payment", text: "x", source: "assistant", amount: -1 },
    { target: "draft", action: "payment", text: "x", source: "assistant", amount: 1e12 },
    { target: "draft", action: "payment", text: "", source: "assistant" },
    { target: "draft", action: "delete", text: "x", source: "assistant" },
    { target: "settings", source: "assistant" },
  ])("rejects unsafe or unsupported payloads: %o", (payload) => {
    expect(parseExternalIntent(payload)).toBeNull();
  });
});
