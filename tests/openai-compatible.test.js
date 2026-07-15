import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, createTranslator } from "../src/providers/openai-compatible.js";
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

test("반말 프롬프트는 겸양 1인칭을 금지하고 나 계열을 사용한다", () => {
  const prompt = buildSystemPrompt({ tone: "banmal", glossary: "" });

  assert.match(prompt, /I\/me\/my as 나\/나를\/내/);
  assert.match(prompt, /NEVER use the humble or polite forms 저, 저는, 제가/);
  assert.match(prompt, /NEVER `저는 그것을 구매하였다`/);
});

test("프롬프트는 단어 수와 무관하게 제목과 질문을 번역하도록 지시한다", () => {
  const prompt = buildSystemPrompt({ tone: "banmal", glossary: "" });

  assert.match(prompt, /heading, title, question, caption, label, and UI phrase/);
  assert.match(prompt, /regardless of its length or word count/);
});

test("빈 용어집에는 기본 고유명사 번역을 적용한다", () => {
  const prompt = buildSystemPrompt({ tone: "banmal", glossary: "" });

  assert.match(prompt, /"Sam Altman" => "샘 올트먼"/);
  assert.match(prompt, /"Elon Musk" => "일론 머스크"/);
  assert.match(prompt, /"Gemini" => "제미나이"/);
  assert.match(prompt, /"Palantir" => "팔란티어"/);
});

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
  assert.deepEqual(result.missingIndices, [2, 3]);
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