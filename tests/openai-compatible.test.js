import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "../src/providers/openai-compatible.js";
import { translateSegments as openrouterTranslate } from "../src/providers/openrouter.js";

/**
 * 모델 메시지 내용을 고정한 가짜 응답으로 공통 번역기를 실행함.
 *
 * 네트워크 요청은 수행하지 않으며, 테스트 동안만 전역 fetch를 교체한다. 반환 응답은
 * OpenAI 호환 Chat Completions의 최소 성공 형태를 사용한다.
 *
 * @param {string} content - `choices[0].message.content`에 넣을 문자열.
 * @param {string[]} [segments] - 번역기에 전달할 원문 세그먼트.
 * @returns {Promise<string[]>} 공통 번역기가 파싱한 번역 배열.
 */
async function translateWithContent(content, segments = ["Home"]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ finish_reason: "stop", message: { content } }],
      model: "test/model",
      provider: "test",
    }),
  });

  try {
    const translate = createTranslator({
      endpoint: "https://example.test/chat/completions",
      label: "Test",
    });
    return await translate({
      apiKey: "test-key",
      model: "test/model",
      segments,
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("완전한 JSON 객체 뒤의 불필요한 닫는 중괄호를 무시한다", async () => {
  const translatedHtml = '<span title="{menu}">홈</span>';
  const validJson = JSON.stringify({ translations: { 0: translatedHtml } });

  const result = await translateWithContent(`${validJson}\n}`);

  assert.deepEqual(result, [translatedHtml]);
});

test("완성되지 않은 JSON 객체는 복구하지 않는다", async () => {
  const truncatedJson = '{"translations":{"0":"홈"}';

  await assert.rejects(
    translateWithContent(truncatedJson),
    /failed to parse model response as JSON/,
  );
});

test("객체 내부가 손상되면 앞의 정상 번역만 적용한다", async () => {
  const malformedJson =
    '{"translations":{"0":"홈","1":"모델","2":"활동\\", \\"3": "제공자"}}';
  const segments = ["Home", "Models", "Activity", "Providers"];

  const result = await translateWithContent(malformedJson, segments);

  assert.deepEqual(result, ["홈", "모델", "Activity", "Providers"]);
});

test("OpenRouter JSON 요청에 응답 치유 플러그인을 포함한다", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: '{"translations":{"0":"홈"}}' } }],
        model: "test/model",
        provider: "test",
      }),
    };
  };

  try {
    await openrouterTranslate({
      apiKey: "test-key",
      model: "test/model",
      segments: ["Home"],
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.deepEqual(requestBody.plugins, [{ id: "response-healing" }]);
});