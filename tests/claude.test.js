import assert from "node:assert/strict";
import test from "node:test";
import { translateSegments } from "../src/providers/claude.js";

const params = {
  apiKey: "test-key", model: "claude-haiku-4-5", segments: ["Home", "Models"],
  reasoningEffort: "none", timeoutMs: 1000,
};

function success(translations = { 1: "모델", 0: "홈" }) {
  return new Response(JSON.stringify({
    content: [
      { type: "thinking", thinking: "not translation" },
      { type: "text", text: JSON.stringify({ translations }) },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 10 },
  }));
}

test("Claude는 공식 인증과 공통 프롬프트로 요청하고 순서와 사용량을 보존한다", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, ...options };
    return success();
  });
  const result = await translateSegments({ ...params, tone: "jondaenmal", glossary: "Home=홈" });
  assert.deepEqual(result, ["홈", "모델"]);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "test-key");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(request.headers.Authorization, undefined);
  const body = JSON.parse(request.body);
  assert.equal(body.model, params.model);
  assert.match(body.system, /polite, formal Korean/);
  assert.match(body.system, /"Home" => "홈"/);
  assert.deepEqual(JSON.parse(body.messages[0].content), { segments: { 0: "Home", 1: "Models" } });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.ok(body.max_tokens > 0);
});

test("Claude 최소·낮음과 모델 기본값을 API에 맞게 변환한다", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return success();
  });
  for (const reasoningEffort of ["minimal", "low", "default"]) {
    await translateSegments({ ...params, reasoningEffort });
  }
  for (const body of bodies.slice(0, 2)) {
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "low" });
  }
  assert.equal(bodies[2].thinking, undefined);
  assert.equal(bodies[2].output_config, undefined);
});

test("Claude 추론 미지원은 폴백하고 이후 배치에서도 기본값을 사용한다", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1
      ? new Response(JSON.stringify({ error: { message: "thinking adaptive is not supported" } }), { status: 400 })
      : success();
  });
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await translateSegments({ ...params, model: "fallback-test", reasoningEffort: "low" }), ["홈", "모델"]);
  }
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].thinking.type, "adaptive");
  for (const body of bodies.slice(1)) {
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
  }
});

test("Claude 누락 번역은 원문과 누락 인덱스를 반환한다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => success({ 1: "모델" }));
  const result = await translateSegments(params);
  assert.deepEqual(result, ["Home", "모델"]);
  assert.deepEqual(result.missingIndices, [0]);
});

test("Claude 429·529는 Retry-After를 적용하고 최대 두 번 재시도한다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
      status: calls === 1 ? 429 : 529, headers: { "retry-after": "0" },
    });
  });
  await assert.rejects(translateSegments(params), /Claude API error \(529\)/);
  assert.equal(calls, 3);
});

test("Claude 인증 실패는 재시도하지 않는다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "invalid API key" } }), { status: 401 });
  });
  await assert.rejects(translateSegments(params), /401.*invalid API key/);
  assert.equal(calls, 1);
});

test("Claude 응답 본문 대기에도 타임아웃을 적용하고 재시도하지 않는다", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    return {
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    };
  });
  await assert.rejects(translateSegments({ ...params, timeoutMs: 5 }), (error) => error.code === "timeout");
  assert.equal(calls, 1);
});
