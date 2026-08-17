import { setTimeout as delay } from "node:timers/promises";
import { normalizeUsage, redactKnownSecrets } from "./protocol.mjs";

export const DEFAULT_API_BASE = "https://opencode.ai/zen/go/v1";
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const PROVIDER_PROTOCOL = "openai-chat-completions";

export function normalizeApiBase(value) {
  return String(value).replace(/\/+$/, "");
}

export class ModelClientError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ModelClientError";
    this.code = options.code ?? "PROVIDER_ERROR";
    this.status = options.status ?? null;
    this.retriable = Boolean(options.retriable);
    this.providerUnavailable = Boolean(options.providerUnavailable);
    this.harnessFault = Boolean(options.harnessFault);
    this.requestId = options.requestId ?? null;
    this.providerAttempts = options.providerAttempts ?? 0;
    this.retryEvents = options.retryEvents ?? [];
  }
}

export class OpenAIChatClient {
  constructor({
    apiKey,
    apiBase = DEFAULT_API_BASE,
    model = DEFAULT_MODEL,
    timeoutMs = 120_000,
    maxRetries = 3,
    fetchImpl = globalThis.fetch,
    defaultHeaders = {},
  } = {}) {
    if (!apiKey) throw new ModelClientError("EXPERIMENT_KEY is required", { code: "MISSING_API_KEY" });
    if (typeof fetchImpl !== "function") throw new TypeError("A Fetch-compatible implementation is required");
    this.apiKey = apiKey;
    this.apiBase = normalizeApiBase(apiBase);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = defaultHeaders;
  }

  static fromEnv(overrides = {}) {
    return new OpenAIChatClient({
      apiKey: overrides.apiKey ?? process.env.EXPERIMENT_KEY,
      apiBase: overrides.apiBase ?? process.env.API_BASE ?? DEFAULT_API_BASE,
      model: overrides.model ?? process.env.MODEL ?? DEFAULT_MODEL,
      timeoutMs: overrides.timeoutMs,
      maxRetries: overrides.maxRetries,
      fetchImpl: overrides.fetchImpl,
      defaultHeaders: overrides.defaultHeaders,
    });
  }

  publicConfig() {
    return {
      apiBase: this.apiBase,
      model: this.model,
      protocol: PROVIDER_PROTOCOL,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    };
  }

  async complete({
    messages,
    tools,
    toolChoice = tools?.length ? "auto" : undefined,
    temperature,
    maxTokens,
    seed,
    signal,
    metadata,
  }) {
    const body = {
      model: this.model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    const response = await this.#request("/chat/completions", body, signal);
    const choice = response.body?.choices?.[0];
    if (!choice?.message) {
      throw new ModelClientError("Provider response did not contain choices[0].message", {
        code: "INVALID_PROVIDER_RESPONSE",
        harnessFault: true,
        requestId: response.requestId,
      });
    }
    const usage = normalizeUsage(response.body.usage);
    usage.apiCalls = response.providerAttempts;
    return {
      message: normalizeAssistantMessage(choice.message),
      finishReason: choice.finish_reason ?? null,
      usage,
      requestId: response.requestId,
      providerModel: response.body.model ?? this.model,
      providerId: response.body.id ?? null,
      created: response.body.created ?? null,
      providerAttempts: response.providerAttempts,
      retryEvents: response.retryEvents,
    };
  }

  async #request(path, body, callerSignal) {
    let lastError;
    const retryEvents = [];
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
        const response = await this.fetchImpl(`${this.apiBase}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "user-agent": "skillscope-access-frontier/0.1",
            ...this.defaultHeaders,
          },
          body: JSON.stringify(body),
          signal,
        });
        const requestId = redactKnownSecrets(
          response.headers.get("x-request-id") ?? response.headers.get("request-id"),
          [this.apiKey],
        );
        const text = await response.text();
        let responseBody;
        try {
          responseBody = redactKnownSecrets(text ? JSON.parse(text) : {}, [this.apiKey]);
        } catch {
          responseBody = { raw: redactKnownSecrets(text.slice(0, 2_000), [this.apiKey]) };
        }
        if (response.ok) return { body: responseBody, requestId, providerAttempts: attempt + 1, retryEvents };

        const classified = classifyHttpError(response.status, responseBody, requestId);
        classified.providerAttempts = attempt + 1;
        classified.retryEvents = retryEvents;
        lastError = classified;
        if (!classified.retriable || attempt === this.maxRetries) throw classified;
        retryEvents.push({ attempt: attempt + 1, code: classified.code, status: classified.status, requestId });
        await retryDelay(attempt, response.headers.get("retry-after"), callerSignal);
      } catch (error) {
        if (error instanceof ModelClientError) {
          error.message = redactKnownSecrets(error.message, [this.apiKey]);
          error.requestId = redactKnownSecrets(error.requestId, [this.apiKey]);
          error.retryEvents = redactKnownSecrets(error.retryEvents, [this.apiKey]);
          lastError = error;
          if (!error.retriable || attempt === this.maxRetries) throw error;
          await retryDelay(attempt, null, callerSignal);
          continue;
        }
        if (callerSignal?.aborted) {
          throw new ModelClientError("Experiment run was cancelled", {
            code: "CANCELLED",
            cause: callerSignal.reason ?? error,
          });
        }
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          lastError = new ModelClientError(`Provider request timed out after ${this.timeoutMs} ms`, {
            code: "PROVIDER_TIMEOUT",
            retriable: true,
            cause: error,
          });
        } else {
          lastError = new ModelClientError(`Provider request failed: ${redactKnownSecrets(String(error?.message ?? error), [this.apiKey])}`, {
            code: "PROVIDER_NETWORK_ERROR",
            retriable: true,
            cause: error,
          });
        }
        lastError.providerAttempts = attempt + 1;
        lastError.retryEvents = retryEvents;
        if (attempt === this.maxRetries) throw lastError;
        retryEvents.push({ attempt: attempt + 1, code: lastError.code, status: lastError.status, requestId: lastError.requestId });
        await retryDelay(attempt, null, callerSignal);
      }
    }
    throw lastError;
  }
}

function normalizeAssistantMessage(message) {
  return {
    role: "assistant",
    content: message.content ?? null,
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(Array.isArray(message.tool_calls)
      ? {
          tool_calls: message.tool_calls.map((call, index) => ({
            id: call.id ?? `call_${index}`,
            type: "function",
            function: {
              name: call.function?.name ?? "",
              arguments: typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
            },
          })),
        }
      : {}),
  };
}

function classifyHttpError(status, body, requestId) {
  const providerMessage = body?.error?.message ?? body?.message ?? body?.error ?? `HTTP ${status}`;
  const safeMessage = String(providerMessage).slice(0, 1_000);
  const normalized = safeMessage.toLowerCase();
  if (status === 401) {
    return new ModelClientError(`Provider authentication failed: ${safeMessage}`, {
      code: "PROVIDER_AUTH_ERROR",
      status,
      requestId,
    });
  }
  if (status === 403) {
    const unavailable = /region|not available|unsupported|access|permission/.test(normalized);
    return new ModelClientError(`Provider rejected the selected model: ${safeMessage}`, {
      code: unavailable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_FORBIDDEN",
      status,
      providerUnavailable: unavailable,
      requestId,
    });
  }
  if (status === 404 || /model.*not.*found|unknown model/.test(normalized)) {
    return new ModelClientError(`Provider endpoint or model is unavailable: ${safeMessage}`, {
      code: "PROVIDER_UNAVAILABLE",
      status,
      providerUnavailable: true,
      requestId,
    });
  }
  if (status === 400 || status === 422) {
    return new ModelClientError(`Provider rejected the frozen request contract (${status}): ${safeMessage}`, {
      code: "HARNESS_REQUEST_REJECTED",
      status,
      harnessFault: true,
      requestId,
    });
  }
  const retriable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new ModelClientError(`Provider returned ${status}: ${safeMessage}`, {
    code: status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_HTTP_ERROR",
    status,
    retriable,
    requestId,
  });
}

async function retryDelay(attempt, retryAfter, signal) {
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter))
    ? Number(retryAfter) * 1_000
    : 0;
  const exponentialMs = Math.min(8_000, 500 * (2 ** attempt));
  const jitterMs = Math.floor(Math.random() * 250);
  try {
    await delay(Math.max(retryAfterMs, exponentialMs + jitterMs), undefined, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw new ModelClientError("Experiment run was cancelled during provider backoff", {
        code: "CANCELLED",
        cause: signal.reason ?? error,
      });
    }
    throw error;
  }
}
