import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../popup.js", import.meta.url), "utf8");

async function createPopup(stored = {}, items = [], endpointFetch = async () => ({ ok: true, json: async () => ({ data: { endpoints: [] } }) })) {
  const elements = new Map();
  function createElement() {
    return {
      value: "", textContent: "", dataset: {}, options: [], listeners: {},
      selectedOptions: [],
      addEventListener(type, listener) {
        (this.listeners[type] ??= []).push(listener);
      },
      append(option) {
        this.options.push(option);
        option.remove = () => this.options.splice(this.options.indexOf(option), 1);
      },
      replaceChildren(...children) { this.options = children; },
      focus() {},
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    createElement,
  };
  const select = document.getElementById("reasoning-effort");
  for (const value of ["none", "minimal", "low", "default"]) {
    const option = createElement();
    option.value = value;
    select.append(option);
  }
  let selectedValue = "none";
  Object.defineProperty(select, "value", {
    get() { return selectedValue; },
    set(value) {
      selectedValue = this.options.some((option) => option.value === value) ? value : "";
    },
  });
  const storage = structuredClone(stored);
  let pendingSave;
  const context = vm.createContext({
    AbortSignal,
    document,
    window: { addEventListener() {} },
    chrome: {
      storage: { local: {
        async get(defaults) { return { ...defaults, ...storage }; },
        async set(values) { Object.assign(storage, structuredClone(values)); },
      } },
      tabs: { async query() { return []; } },
      runtime: { getManifest() { return { version: "test" }; } },
    },
    setTimeout(callback) { pendingSave = callback; return 1; },
    clearTimeout() { pendingSave = null; },
    fetch: async (url, options) => url.endsWith("/endpoints")
      ? endpointFetch(url, options)
      : { ok: true, text: async () => JSON.stringify({ data: items }) },
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    storage, select,
    element: (id) => document.getElementById(id),
    run: (code) => vm.runInContext(code, context),
    async emit(id, type, value) {
      const element = document.getElementById(id);
      element.value = value;
      for (const listener of element.listeners[type] ?? []) await listener({ type, target: element });
    },
    async flush() { if (pendingSave) await pendingSave(); },
  };
}

const modelReasoning = {
  optional: { mandatory: false, supported_efforts: ["high", "low", "none"] },
  required: { mandatory: true, supported_efforts: ["high", "low", "minimal"] },
  lowOnly: { mandatory: true, supported_efforts: ["high", "low"] },
  highOnly: { mandatory: true, supported_efforts: ["high"] },
  unrestricted: { mandatory: true, supported_efforts: null },
  budgetOnly: { mandatory: true, supports_max_tokens: true },
  plain: null,
};

function settings(overrides = {}) {
  return {
    provider: "openrouter",
    credentials: { openrouter: { apiKey: "test-key", model: "optional" } },
    openrouterModelReasoning: modelReasoning,
    ...overrides,
  };
}

test("OpenRouter 모델 선택 시 없음 또는 지원하는 최저 추론 강도로 자동 저장한다", async () => {
  const popup = await createPopup(settings());
  for (const [model, expected] of [
    ["required", "minimal"], ["lowOnly", "low"], ["highOnly", "high"],
    ["unrestricted", "minimal"], ["budgetOnly", "default"],
    ["unknown", "default"], ["optional", "none"], ["plain", "none"],
  ]) {
    await popup.emit("model", model === "unknown" ? "change" : "input", model);
    assert.equal(popup.select.value, expected, model);
    assert.ok(popup.select.options.some((option) => option.value === expected && !option.disabled));
    await popup.flush();
    assert.equal(popup.storage.reasoningEffort, expected);
    assert.equal(popup.storage.credentials.openrouter.model, model);
  }
});

test("필수 모델은 없음을 비활성화하고 change 이벤트만으로도 설정을 저장한다", async () => {
  const popup = await createPopup(settings());
  await popup.emit("model", "change", "lowOnly");
  assert.equal(popup.select.options.find((option) => option.value === "none").disabled, true);
  assert.equal(popup.select.options.find((option) => option.value === "minimal").disabled, true);
  await popup.flush();
  assert.equal(popup.storage.reasoningEffort, "low");
  await popup.emit("model", "change", "optional");
  assert.equal(popup.select.options.find((option) => option.value === "none").disabled, false);
});

test("모델 가져오기는 추론 정보를 보존하고 현재 모델에도 즉시 적용한다", async () => {
  const popup = await createPopup(settings({
    credentials: { openrouter: { apiKey: "test-key", model: "required" } },
    openrouterModelReasoning: {},
  }), Object.entries(modelReasoning).map(([id, reasoning]) => ({ id, reasoning })));
  await popup.run("fetchModelOptions()");
  assert.deepEqual(popup.storage.openrouterModelReasoning, modelReasoning);
  assert.equal(popup.select.value, "minimal");
  await popup.flush();
  const reopened = await createPopup(popup.storage);
  await reopened.emit("model", "input", "lowOnly");
  assert.equal(reopened.select.value, "low");
});

test("팝업 재실행 시 필수 모델의 없음은 보정하되 유효한 수동 설정은 유지한다", async () => {
  const stored = settings({ credentials: { openrouter: { apiKey: "test-key", model: "required" } } });
  const popup = await createPopup(stored);
  assert.equal(popup.select.value, "minimal");
  await popup.emit("reasoning-effort", "input", "high");
  await popup.emit("model", "change", "required");
  assert.equal(popup.select.value, "high");
  await popup.flush();
  const reopened = await createPopup(popup.storage);
  assert.equal(reopened.select.value, "high");
});

test("다른 서비스는 추론 강도를 자동 변경하지 않고 OpenRouter 복귀 시 다시 적용한다", async () => {
  const popup = await createPopup(settings({
    credentials: {
      openrouter: { apiKey: "test-key", model: "required" },
      openai: { apiKey: "test-key", model: "other" },
    },
  }));
  await popup.emit("provider", "change", "openai");
  assert.equal(popup.select.options.find((option) => option.value === "none").disabled, false);
  await popup.emit("reasoning-effort", "input", "low");
  await popup.emit("model", "input", "another");
  assert.equal(popup.select.value, "low");
  await popup.emit("provider", "change", "openrouter");
  assert.equal(popup.select.value, "minimal");
});

test("모델 조회 도중 서비스를 바꾸면 늦은 응답이 현재 선택을 덮어쓰지 않는다", async () => {
  const popup = await createPopup(settings(), [{ id: "required", reasoning: modelReasoning.required }]);
  const request = popup.run("fetchModelOptions()");
  await popup.emit("provider", "change", "openai");
  await request;
  assert.equal(popup.element("model-list").options.length, 0);
  assert.equal(popup.element("provider").value, "openai");
});

test("부분 검색 중에는 콤보박스를 다시 만들지 않고 모델 선택 시에만 추론을 갱신한다", async () => {
  const popup = await createPopup(settings(), Object.entries(modelReasoning)
    .map(([id, reasoning]) => ({ id, reasoning })));
  await popup.run("fetchModelOptions()");
  const candidates = [...popup.element("model-list").options];
  const reasoningOptions = [...popup.select.options];
  for (const value of ["", "r", "re", "req", "re", "l", "low"]) {
    await popup.emit("model", "input", value);
    await popup.flush();
    assert.equal(popup.select.value, "none");
    assert.deepEqual(popup.select.options, reasoningOptions);
    assert.deepEqual(popup.element("model-list").options, candidates);
    assert.equal(popup.element("model").value, value);
  }
  await popup.emit("model", "input", "lowOnly");
  assert.equal(popup.select.value, "low");
  const selectedOptions = [...popup.select.options];
  await popup.emit("model", "change", "lowOnly");
  assert.deepEqual(popup.select.options, selectedOptions);
});

test("미조회 모델은 입력 확정이나 번역 직전 저장 시 기본값으로 보정한다", async () => {
  const popup = await createPopup(settings());
  await popup.emit("model", "input", "custom-model");
  assert.equal(popup.select.value, "none");
  await popup.run("saveSettings()");
  assert.equal(popup.storage.reasoningEffort, "default");
  await popup.emit("model", "input", "required");
  await popup.emit("model", "change", "another-custom-model");
  assert.equal(popup.select.value, "default");
});

const providerModels = ["test/multi", "test/single", "test/empty"].map((id) => ({
  id, reasoning: { mandatory: false },
}));
const providerEndpoints = {
  multi: [
    { tag: "deepinfra/turbo", provider_name: "DeepInfra", status: 0 },
    { tag: "groq", provider_name: "Groq", status: 0 },
    { tag: "groq", provider_name: "Groq", status: 0 },
    { tag: "offline", provider_name: "Offline", status: -1 },
    { provider_name: "Missing tag", status: 0 },
  ],
  single: [{ tag: "groq", provider_name: "Groq", status: 0 }],
  empty: [],
};

function endpointResponse(endpoints) {
  return { ok: true, json: async () => ({ data: { endpoints } }) };
}

async function createProviderPopup(endpointFetch, stored = {}) {
  return createPopup(settings({
    credentials: { openrouter: { apiKey: "test-key", model: "" } },
    openrouterModelReasoning: Object.fromEntries(providerModels.map((model) => [model.id, model.reasoning])),
    ...stored,
  }), providerModels, endpointFetch || (async (url) => endpointResponse(
    providerEndpoints[url.split("/").at(-2)] ?? [],
  )));
}

test("모델별 정상 실행 제공자를 식별자로 중복 제거하고 검색 후보에 표시한다", async () => {
  const popup = await createProviderPopup();
  await popup.emit("model", "input", "test/multi");
  const list = popup.element("openrouter-provider-list");
  assert.deepEqual(Array.from(list.options, (option) => [option.value, option.label]), [
    ["deepinfra/turbo", "DeepInfra"], ["groq", "Groq"],
  ]);
  const options = [...list.options];
  for (const value of ["d", "deep", "deepinfra/turbo"]) {
    await popup.emit("openrouter-provider", "input", value);
    assert.equal(popup.element("openrouter-provider").value, value);
    assert.deepEqual(list.options, options);
  }
  await popup.flush();
  assert.equal(popup.storage.credentials.openrouter.providerSlug, "deepinfra/turbo");
  assert.equal(popup.element("openrouter-provider").disabled, false);
});

test("단일 실행 제공자는 자동 저장하고 제공자 입력만 잠그며 모델 전환 시 해제한다", async () => {
  const popup = await createProviderPopup();
  await popup.emit("model", "input", "test/single");
  assert.equal(popup.element("openrouter-provider").value, "groq");
  assert.equal(popup.element("openrouter-provider").disabled, true);
  assert.notEqual(popup.element("model").disabled, true);
  await popup.flush();
  assert.equal(popup.storage.credentials.openrouter.providerSlug, "groq");
  await popup.emit("model", "input", "test/multi");
  assert.equal(popup.element("openrouter-provider").value, "");
  assert.equal(popup.element("openrouter-provider").disabled, false);
  await popup.emit("model", "input", "test/single");
  await popup.emit("model", "input", "test/empty");
  assert.equal(popup.element("openrouter-provider").value, "");
  assert.equal(popup.element("openrouter-provider").disabled, false);
  assert.equal(popup.element("openrouter-provider-list").options.length, 0);
});

test("모델 목록 새로고침과 팝업 재실행 시 실행 제공자를 조회하고 유효한 선택을 유지한다", async () => {
  let calls = 0;
  const popup = await createProviderPopup(async () => {
    calls += 1;
    return endpointResponse(providerEndpoints.multi);
  }, { credentials: { openrouter: { apiKey: "test-key", model: "test/multi", providerSlug: "deepinfra" } } });
  assert.equal(calls, 1);
  assert.equal(popup.element("openrouter-provider").value, "deepinfra");
  await popup.run("fetchModelOptions()");
  assert.equal(calls, 2);
  assert.equal(popup.element("model-list").options.length, 3);
  await popup.emit("model", "change", "test/multi");
  assert.equal(calls, 2);
});

test("부분 모델 검색은 요청하지 않으며 늦은 엔드포인트 응답을 무시한다", async () => {
  let resolveFirst;
  let calls = 0;
  const popup = await createProviderPopup(async () => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : endpointResponse(providerEndpoints.multi);
  });
  const first = popup.emit("model", "input", "test/single");
  await popup.emit("model", "input", "test/m");
  assert.equal(calls, 1);
  await popup.emit("model", "input", "test/multi");
  resolveFirst(endpointResponse(providerEndpoints.single));
  await first;
  assert.equal(popup.element("openrouter-provider").disabled, false);
  assert.equal(popup.element("openrouter-provider-list").options.length, 2);
  await popup.emit("provider", "change", "openai");
  assert.equal(popup.element("openrouter-provider-list").options.length, 0);
});

test("실행 제공자 조회 실패 시 기존 수동 입력을 보존하며 다음 조회로 복구한다", async () => {
  let fail = true;
  const popup = await createProviderPopup(async () => fail
    ? { ok: false, status: 503 }
    : endpointResponse(providerEndpoints.single), {
    credentials: { openrouter: { apiKey: "test-key", model: "test/single", providerSlug: "manual" } },
  });
  assert.equal(popup.element("openrouter-provider").value, "manual");
  assert.equal(popup.element("openrouter-provider").disabled, false);
  assert.match(popup.element("openrouter-provider-notice").textContent, /503/);
  fail = false;
  await popup.run("updateProviderOptions()");
  assert.equal(popup.element("openrouter-provider").value, "groq");
  assert.equal(popup.element("openrouter-provider").disabled, true);
});

test("번역 직전 저장은 진행 중인 엔드포인트 조회와 단일 제공자 선택을 기다린다", async () => {
  let complete;
  const popup = await createProviderPopup(() => new Promise((resolve) => { complete = resolve; }));
  const selection = popup.emit("model", "input", "test/single");
  const save = popup.run("saveSettings()");
  complete(endpointResponse(providerEndpoints.single));
  await selection;
  await save;
  assert.equal(popup.storage.credentials.openrouter.providerSlug, "groq");
});