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
    text: async () => JSON.stringify({
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

test("캐주얼체 프롬프트는 화자별 격식을 유지하고 과격한 게시판체를 금지한다", () => {
  const prompt = buildSystemPrompt({ tone: "casual", glossary: "" });

  assert.match(prompt, /Do NOT force one speech level across the batch or page/);
  assert.match(prompt, /casual 반말 endings/);
  assert.match(prompt, /conversational polite 해요체/);
  assert.match(prompt, /formal 합니다체 or stronger honorific language/);
  assert.match(prompt, /never normalize different speakers to one uniform tone/);
  assert.match(prompt, /Do not switch speech levels randomly merely to create variety/);
  assert.match(prompt, /응, 나도 그거 해봤어/);
  assert.match(prompt, /공유해 주셔서 감사해요\. 저도 해봤어요/);
  assert.match(prompt, /도움을 주셔서 진심으로 감사드립니다/);
  assert.match(prompt, /hostile or extreme forums such as Ilbe or DC Inside/);
  assert.match(prompt, /preserve its intent without making it harsher/);
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

test("OpenRouter content 배열 오류는 문자열로 폴백하고 실행 제공자별로 기억한다", async (t) => {
  const requests = [];
  const detail = JSON.stringify({ error: {
    message: "Provider returned error",
    code: 400,
    metadata: { raw: JSON.stringify({
      message: "Failed to apply chat template to messages due to error: Unexpected item type in content.",
      code: "wrong_api_format", param: "messages",
    }), provider_name: "Cerebras" },
  } });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const rejected = body.provider?.only[0] === "cerebras/fp16" &&
      Array.isArray(body.messages[0].content);
    return new Response(rejected ? detail : JSON.stringify({
      choices: [{ message: { content: '{"translations":{"0":"홈"}}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }), { status: rejected ? 400 : 200 });
  });
  const params = {
    apiKey: "test-key", model: "test/content-array-fallback",
    providerSlug: " Cerebras/FP16 ", segments: ["Home"],
  };
  const result = await openrouterTranslate(params);
  assert.deepEqual(result, ["홈"]);
  assert.equal(result.usage.outputTokens, 10);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages[0].content, requests[0].messages[0].content[0].text);
  assert.deepEqual(requests[1].messages[1], requests[0].messages[1]);
  assert.deepEqual(requests[1].provider, { only: ["cerebras/fp16"] });
  assert.deepEqual(requests[1].response_format, { type: "json_object" });

  await openrouterTranslate({ ...params, providerSlug: "cerebras/fp16" });
  assert.equal(requests.length, 3);
  assert.equal(typeof requests[2].messages[0].content, "string");
  await openrouterTranslate({ ...params, providerSlug: "another-provider" });
  assert.ok(Array.isArray(requests[3].messages[0].content));
});

test("번역 결과 없는 응답은 지연 후 같은 배치를 한 번 재시도한다", async (t) => {
  const requests = [];
  const times = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options.body);
    times.push(Date.now());
    return new Response(JSON.stringify({ choices: [{ message: {
      content: requests.length === 1 ? "{}" : '{"translations":{"0":"홈"}}',
    } }] }));
  });
  const translate = createTranslator({ endpoint: "https://example.test/retry-empty", label: "Test" });
  const result = await translate({ apiKey: "test-key", model: "test/model", segments: ["Home"] });
  assert.deepEqual(result, ["홈"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.ok(times[1] - times[0] >= 950);
});

test("번역 결과 없는 응답이 반복되면 한 번의 재시도 후 실패한다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  });
  const translate = createTranslator({ endpoint: "https://example.test/retry-empty-limit", label: "Test" });
  await assert.rejects(
    translate({ apiKey: "test-key", model: "test/model", segments: ["Home"] }),
    { code: "no_usable_translations", message: "response has no usable translations (top-level keys: none)" },
  );
  assert.equal(calls, 2);
});

for (const recover of [true, false]) {
  test(`빈 모델 응답은 한 번 재시도 후 ${recover ? "번역을 적용한다" : "배치 건너뛰기 오류 코드를 전달한다"}`, async (t) => {
    let calls = 0;
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      requests.push(options.body);
      return new Response(JSON.stringify({ choices: [{ message: {
        content: recover && calls > 1 ? '{"translations":{"0":"홈"}}' : "",
      } }] }));
    });
    const translate = createTranslator({ endpoint: "https://example.test/empty-content", label: "Test" });
    const pending = translate({ apiKey: "test-key", model: "test/model", segments: ["Home"] });
    if (recover) {
      assert.deepEqual(await pending, ["홈"]);
    } else {
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, "no_usable_translations");
        assert.match(error.message, /failed to parse model response as JSON: \(empty content\)/);
        return true;
      });
    }
    assert.equal(calls, 2);
    assert.equal(requests[0], requests[1]);
  });
}

test("OpenRouter 문자열 content도 거부되면 재시도를 중단한다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("Unexpected item type in content.", { status: 400 });
  });
  await assert.rejects(openrouterTranslate({
    apiKey: "test-key", model: "test/content-always-rejected", segments: ["Home"],
  }), /OpenRouter API error \(400\)/);
  assert.equal(calls, 2);
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
      text: async () => JSON.stringify({
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

test("OpenRouter 실행 제공자 slug를 소문자로 정규화해 provider.only로 제한한다", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"translations":{"0":"홈"}}' } }],
        model: "openai/gpt-oss-20b",
        provider: "groq",
      }),
    };
  };

  try {
    await openrouterTranslate({
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
      providerSlug: " GroQ ",
      segments: ["Home"],
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestBody.provider, { only: ["groq"] });
});

test("OpenRouter 요청은 시스템 프롬프트에 프롬프트 캐싱 브레이크포인트를 붙인다", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"translations":{"0":"홈"}}' } }],
        model: "anthropic/claude-sonnet-5",
        provider: "anthropic",
      }),
    };
  };

  try {
    await openrouterTranslate({
      apiKey: "test-key",
      model: "anthropic/claude-sonnet-5",
      segments: ["Home"],
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const systemMessage = requestBody.messages[0];
  assert.equal(systemMessage.role, "system");
  assert.ok(Array.isArray(systemMessage.content));
  assert.equal(systemMessage.content.at(-1).type, "text");
  assert.deepEqual(systemMessage.content.at(-1).cache_control, { type: "ephemeral" });
});

test("캐싱을 켜지 않은 프로바이더는 시스템 프롬프트를 문자열로 전송한다", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"translations":{"0":"홈"}}' } }],
        model: "test/model",
      }),
    };
  };

  const translate = createTranslator({
    endpoint: "https://example.test/chat/completions",
    label: "Test",
  });

  try {
    await translate({
      apiKey: "test-key",
      model: "test/model",
      segments: ["Home"],
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(typeof requestBody.messages[0].content, "string");
});

test("jsonSchema 를 요구하는 400 응답은 response_format 을 빼고 재시도한다", async () => {
  const originalFetch = globalThis.fetch;
  const sentBodies = [];
  globalThis.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    if (sentBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { message: "Missing required parameter: 'jsonSchema'.", code: "invalid_value" },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"translations":{"0":"홈"}}' } }],
        model: "test/schema-model",
      }),
    };
  };

  const translate = createTranslator({
    endpoint: "https://example.test/chat/completions",
    label: "Test",
  });

  let result;
  try {
    result = await translate({
      apiKey: "test-key",
      model: "test/schema-model",
      segments: ["Home"],
      reasoningEffort: "default",
      timeoutMs: 1000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(result, ["홈"]);
  assert.deepEqual(sentBodies[0].response_format, { type: "json_object" });
  assert.equal("response_format" in sentBodies[1], false);
});

test("성공 상태의 HTML 응답은 본문을 포함한 API 오류로 처리한다", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null) },
      text: async () => "<!-- * blocked by gateway --><html><body>Access denied</body></html>",
    };
  };

  const translate = createTranslator({
    endpoint: "https://example.test/chat/completions",
    label: "Test",
  });

  try {
    await assert.rejects(
      translate({
        apiKey: "test-key",
        model: "test/model",
        segments: ["Home"],
        reasoningEffort: "default",
        timeoutMs: 1000,
      }),
      /Test API returned HTML instead of JSON \(HTTP 200, content-type=text\/html; charset=utf-8\): <!-- \* blocked by gateway/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestCount, 1);
});

test("JSON 코드 블록을 제거하고 번역 내부의 백틱과 HTML은 보존한다", async () => {
  const html = '<a href="https://example.test">문서</a>와 ```json 예시';
  const json = JSON.stringify({ translations: { 0: html } });
  for (const language of ["json", "JSON", ""]) {
    assert.deepEqual(await translateWithContent(` \n\`\`\`${language}\r\n${json}\r\n\`\`\`\n `), [html]);
  }
});

test("임의 설명문이나 다른 언어 코드 블록에서는 JSON을 추출하지 않는다", async () => {
  const json = '{"translations":{"0":"홈"}}';
  for (const text of [`Here is JSON:\n${json}`, `\`\`\`javascript\n${json}\n\`\`\``]) {
    await assert.rejects(translateWithContent(text), /failed to parse model response as JSON/);
  }
});
