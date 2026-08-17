import assert from "node:assert/strict";
import test from "node:test";
import "../pi/register-typescript.js";

const { createEphemeralChildModelRuntime } = await import("../../src/pi/pi-backend.ts");

test("deepseek-v4-flash Zen shape can be rebuilt offline with a placeholder API-key snapshot", async () => {
  const provider = "skillscope-zen-audit";
  const baseUrl = "https://opencode.ai/zen/go/v1";
  const selectedModel = {
    provider,
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const runtime = await createEphemeralChildModelRuntime({
    model: selectedModel,
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "audit-placeholder-not-a-real-secret",
        baseUrl,
      }),
      getRegisteredProviderConfig: () => ({
        name: "Zen audit fixture",
        api: "openai-completions",
        baseUrl,
        models: [{
          id: selectedModel.id,
          name: selectedModel.name,
          api: selectedModel.api,
          baseUrl,
          reasoning: selectedModel.reasoning,
          input: selectedModel.input,
          cost: selectedModel.cost,
          contextWindow: selectedModel.contextWindow,
          maxTokens: selectedModel.maxTokens,
        }],
      }),
      getRegisteredNativeProvider: () => undefined,
      getProvider: () => ({ name: "Zen audit fixture", baseUrl }),
    },
  });

  const childModel = runtime.getModel(provider, selectedModel.id);
  const childAuth = await runtime.getAuth(childModel);
  assert.equal(childModel.api, "openai-completions");
  assert.equal(childModel.baseUrl, baseUrl);
  assert.equal(childAuth.auth.apiKey, "audit-placeholder-not-a-real-secret");
  assert.equal(runtime.hasConfiguredAuth(provider), true);
});
