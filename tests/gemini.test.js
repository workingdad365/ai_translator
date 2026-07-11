import assert from "node:assert/strict";
import test from "node:test";

import { translateSegments } from "../src/providers/gemini.js";

/**
 * 성공한 Interactions API 응답 형태를 생성함.
 *
 * @param {object} translations - 인덱스별 번역 값.
 * @returns {object} 최소 Interaction 리소스 응답.
 */
function interactionResponse(translations) {
  return {
    id: "test-interaction",
    status: "completed",
    model: "gemini-3.1-flash-lite",
    steps: [
      { type: "thought", signature: "test-signature" },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: JSON.stringify({ translations }),
          },
        ],
      },
    ],
    usage: {
      total_tokens: 30,
      total_output_tokens: 10,
      total_thought_tokens: 2,
    },
  };
}

test("Gemini Interactions API 요청을 만들고 model_output 번역을 추출한다", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => interactionResponse({ 0: "홈", 1: "모델" }),
    };
  };

  try {
    const result = await translateSegments({
      apiKey: "gemini-test-key",
      model: "gemini-3.1-flash-lite",
      segments: ["Home", "Models"],
      tone: "banmal",
      glossary: "",
      reasoningEffort: "none",
      timeoutMs: 1000,
    });

    assert.deepEqual(result, ["홈", "모델"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers["x-goog-api-key"], "gemini-test-key");
  assert.equal(requestOptions.headers["Api-Revision"], "2026-05-20");

  const body = JSON.parse(requestOptions.body);
  assert.equal(body.model, "gemini-3.1-flash-lite");
  assert.equal(body.store, false);
  assert.deepEqual(JSON.parse(body.input), {
    segments: { 0: "Home", 1: "Models" },
  });
  assert.match(body.system_instruction, /professional translator/);
  assert.equal(body.generation_config.thinking_level, "minimal");
  assert.equal(typeof body.generation_config.max_output_tokens, "number");
  assert.equal(body.response_format.type, "text");
  assert.equal(body.response_format.mime_type, "application/json");
  assert.deepEqual(
    body.response_format.schema.properties.translations.required,
    ["0", "1"],
  );
  assert.equal(
    body.response_format.schema.properties.translations.additionalProperties,
    false,
  );
});

test("thinking_level을 거부하면 모델 기본값으로 다시 요청한다", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ error: { message: "Unsupported thinking_level: minimal" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => interactionResponse({ 0: "홈" }),
    };
  };

  try {
    const result = await translateSegments({
      apiKey: "gemini-test-key",
      model: "gemini-test-thinking-fallback",
      segments: ["Home"],
      reasoningEffort: "none",
      timeoutMs: 1000,
    });

    assert.deepEqual(result, ["홈"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].generation_config.thinking_level, "minimal");
  assert.equal("thinking_level" in requestBodies[1].generation_config, false);
});