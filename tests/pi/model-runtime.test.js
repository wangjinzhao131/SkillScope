import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.js";

const { createEphemeralChildModelRuntime } = await import("../../src/pi/pi-backend.ts");

test("parent provider bridge refreshes Pi 0.84.2 child auth snapshot", async () => {
  const providerId = "skillscope-test-provider";
  const selectedModel = model(providerId, "test-model", "https://example.invalid/v1");
  const providerConfig = {
    name: "SkillScope test provider",
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    models: [{
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    }],
  };
  const runtime = await createEphemeralChildModelRuntime({
    model: selectedModel,
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "ephemeral-secret" }),
      getRegisteredProviderConfig: (id) => id === providerId ? providerConfig : undefined,
      getRegisteredNativeProvider: () => undefined,
      getProvider: () => undefined,
    },
  });
  assert.equal(runtime.hasConfiguredAuth(providerId), true);
  assert.equal(runtime.getModel(providerId, "test-model").id, "test-model");
});

test("child bridge rejects missing explicit parent auth even when ambient env contains a key", async (t) => {
  const providerId = "skillscope-ambient-provider";
  const envName = "SKILLSCOPE_AMBIENT_PROVIDER_KEY";
  const prior = process.env[envName];
  process.env[envName] = "ambient-secret-must-not-be-used";
  t.after(() => {
    if (prior === undefined) delete process.env[envName];
    else process.env[envName] = prior;
  });

  await assert.rejects(() => createEphemeralChildModelRuntime({
    model: model(providerId, "ambient-model", "https://ambient.invalid/v1"),
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      getRegisteredProviderConfig: () => ({
        api: "openai-completions",
        baseUrl: "https://ambient.invalid/v1",
        apiKey: envName,
      }),
      getRegisteredNativeProvider: () => undefined,
      getProvider: () => undefined,
    },
  }), /did not provide explicit API-key authentication/);
});

test("models-json-only custom provider is rebuilt from selected model and resolved request auth", async () => {
  const providerId = "skillscope-models-json-only";
  const selectedModel = model(providerId, "custom-model", "https://configured.invalid/v1");
  selectedModel.headers = { Authorization: "must-be-deleted", "X-Model": "kept" };
  const runtime = await createEphemeralChildModelRuntime({
    model: selectedModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "resolved-secret",
        baseUrl: "https://resolved.invalid/v1",
        headers: { authorization: null, "X-Scope-Test": "resolved" },
        env: { SKILLSCOPE_ACCOUNT: "account-1" },
      }),
      isUsingOAuth: () => false,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
      getProvider: () => ({ name: "Models JSON Provider", baseUrl: "https://configured.invalid/v1" }),
    },
  });

  assert.equal(runtime.hasConfiguredAuth(providerId), true);
  const rebuilt = runtime.getModel(providerId, "custom-model");
  assert.equal(rebuilt.baseUrl, "https://resolved.invalid/v1");
  const auth = await runtime.getAuth(rebuilt);
  assert.equal(auth.auth.apiKey, "resolved-secret");
  assert.equal(auth.auth.headers["X-Scope-Test"], "resolved");
  assert.equal(auth.auth.headers["X-Model"], "kept");
  assert.equal(Object.keys(auth.auth.headers).some((name) => name.toLowerCase() === "authorization"), false);
  assert.equal(auth.env.SKILLSCOPE_ACCOUNT, "account-1");
});

test("custom native providers are rejected instead of being misreported as an equivalent bridge", async () => {
  const providerId = "skillscope-native-provider";
  await assert.rejects(() => createEphemeralChildModelRuntime({
    model: model(providerId, "native-model", "https://native.invalid/v1"),
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "resolved-secret" }),
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => ({ id: providerId }),
      getProvider: () => ({ name: "Native Provider" }),
    },
  }), /does not clone custom native stream providers/);
});

function model(provider, id, baseUrl) {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}
