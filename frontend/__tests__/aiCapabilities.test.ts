import { getAICapabilities } from "@/src/db/aiCapabilities";
describe("AI capability configuration", () => {
 it("reports Gemini voice configured from chat key", () => { expect(getAICapabilities({provider:"gemini",apiKey:"k"}).transcription.configured).toBe(true); });
 it("does not claim Anthropic voice without endpoint", () => { expect(getAICapabilities({provider:"anthropic",apiKey:"k"}).transcription).toMatchObject({supported:false,configured:false}); });
 it("reports OpenAI missing without key", () => { expect(getAICapabilities({provider:"openai",apiKey:""}).transcription.configured).toBe(false); });
});
