import assert from "node:assert/strict";
import test from "node:test";

test("백그라운드는 Claude 저장 설정으로 배치 번역과 속도 측정을 실행한다", async (t) => {
  const originalChrome = globalThis.chrome;
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  });
  let listener;
  globalThis.chrome = {
    storage: { local: { async get() {
      return {
        provider: "claude",
        credentials: { claude: { apiKey: "claude-key", model: "claude-haiku-4-5" } },
      };
    } } },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(callback) { listener = callback; } },
    },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("chrome-extension://")) return new Response("Home\nModels");
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], "claude-key");
    assert.equal(JSON.parse(options.body).model, "claude-haiku-4-5");
    return new Response(JSON.stringify({
      content: [{ type: "text", text: '{"translations":{"0":"홈","1":"모델"}}' }],
      usage: { input_tokens: 20, output_tokens: 10 },
    }));
  });
  await import("../src/background.js");
  const send = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
  const batch = await send({ type: "translate-batch", segments: ["Home", "Models"] });
  assert.deepEqual(batch, { translations: ["홈", "모델"], missingIndices: [] });
  const speed = await send({ type: "speed-test" });
  assert.equal(speed.provider, "claude");
  assert.equal(speed.segmentCount, 2);
  assert.deepEqual(speed.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
});
