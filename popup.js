// 팝업 스크립트
// 설정(AI 서비스/API 키/모델)을 저장소와 동기화하고,
// 활성 탭의 번역 상태에 따라 "이 페이지 번역" / "번역 중지" 버튼을 토글함.
// - 번역을 시작하면 팝업을 즉시 닫음.
// - 번역 중인 페이지에서 팝업을 다시 열면 "번역 중지" 버튼이 표시되고, 누르면 세션을 멈춤.
// - API 키/모델은 AI 서비스별로 개별 저장하므로, 서비스를 전환하면 해당
//   서비스에 저장해 둔 값이 폼에 표시됨.

const DEFAULT_PROVIDER = "openai";
const AVAILABLE_PROVIDERS = new Set([
  "openai",
  "openrouter",
  "nanogpt",
  "runware",
  "litellm",
  "laozhang",
  "gemini",
]);

// 프로바이더별 입력 힌트(placeholder). 지원 프로바이더 추가 시 여기에 등록함.
const PROVIDER_META = {
  openai: {
    apiKeyHint: "sk-...",
    modelHint: "예: gpt-5.4-mini",
    modelsEndpoint: "https://api.openai.com/v1/models",
  },
  openrouter: {
    apiKeyHint: "sk-or-...",
    modelHint: "예: deepseek/deepseek-v4-flash",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
  },
  nanogpt: {
    apiKeyHint: "nano-gpt API 키",
    modelHint: "예: openai/gpt-5.2",
    modelsEndpoint: "https://nano-gpt.com/api/v1/models",
  },
  runware: {
    apiKeyHint: "runware API 키",
    modelHint: "예: minimax:m2.7@0",
    modelsEndpoint: "https://api.runware.ai/v1/models",
  },
  litellm: {
    apiKeyHint: "LiteLLM 가상 키 (sk-...)",
    modelHint: "예: ws-gpt",
    modelsEndpoint: "https://llm.drasys.com/v1/models",
  },
  laozhang: {
    apiKeyHint: "LaoZhang AI API 키",
    modelHint: "예: gpt-4o-mini",
    modelsEndpoint: "https://api2.laozhang.ai/v1/models",
  },
  gemini: {
    apiKeyHint: "Google AI Studio API 키",
    modelHint: "예: gemini-3.1-flash-lite",
    modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  },
};

// 저장소 기본값. credentials 는 { [provider]: { apiKey, model } } 구조이며,
// apiKey/model 최상위 키는 과거 단일 형식과의 하위 호환을 위해서만 읽음.
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_MAX_CHARS = 5000;
const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_CONCURRENCY = 3;
const AUTO_SAVE_DELAY_MS = 300;
const DEFAULT_GLOSSARY = [
  "Sam Altman=샘 올트먼",
  "Elon Musk=일론 머스크",
  "Gemini=제미나이",
  "Palantir=팔란티어"
].join("\n");

const STORAGE_DEFAULTS = {
  provider: DEFAULT_PROVIDER,
  credentials: {},
  tone: "banmal",
  glossary: DEFAULT_GLOSSARY,
  reasoningEffort: "none",
  batchSize: DEFAULT_BATCH_SIZE,
  maxChars: DEFAULT_MAX_CHARS,
  concurrency: DEFAULT_CONCURRENCY,
  timeoutSec: DEFAULT_TIMEOUT_SEC,
  debug: false,
  showProgressToast: true,
  apiKey: "",
  model: "",
};

// 프로바이더별 자격증명 메모리 캐시. { [provider]: { apiKey, model } }
let credentials = {};
// 현재 폼에 표시 중인 프로바이더(전환 시 이전 입력값 보존에 사용).
let shownProvider = DEFAULT_PROVIDER;

const els = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("api-key"),
  model: document.getElementById("model"),
  openrouterProviderField: document.getElementById("openrouter-provider-field"),
  openrouterProvider: document.getElementById("openrouter-provider"),
  modelList: document.getElementById("model-list"),
  fetchModels: document.getElementById("fetch-models-button"),
  modelNotice: document.getElementById("model-notice"),
  tone: document.getElementById("tone"),
  reasoningEffort: document.getElementById("reasoning-effort"),
  glossary: document.getElementById("glossary"),
  batchSize: document.getElementById("batch-size"),
  maxChars: document.getElementById("max-chars"),
  concurrency: document.getElementById("concurrency"),
  timeoutSec: document.getElementById("timeout-sec"),
  debug: document.getElementById("debug"),
  showProgressToast: document.getElementById("show-progress-toast"),
  translate: document.getElementById("translate-button"),
  save: document.getElementById("save-button"),
  speedTest: document.getElementById("speed-test-button"),
  speedNotice: document.getElementById("speed-notice"),
  settings: document.getElementById("settings"),
  currentSelection: document.getElementById("current-selection"),
  currentProvider: document.getElementById("current-provider"),
  currentModel: document.getElementById("current-model"),
  notice: document.getElementById("notice"),
  saveNotice: document.getElementById("save-notice"),
  appVersion: document.getElementById("app-version"),
};

// 현재 활성 탭의 번역 세션 활성 여부(버튼 표시 상태 결정).
let translating = false;
let autoSaveTimer = null;

/**
 * 배치 크기를 1~100 범위의 정수로 정규화함. 유효하지 않으면 기본값을 반환함.
 *
 * @param {*} value - 검증할 값.
 * @returns {number} 정규화된 배치 크기(1~100).
 */
function normalizeBatchSize(value) {
  // 빈 입력/공백은 기본값으로 처리(실수로 비우고 저장 시 배치=1 폭증 방지).
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_BATCH_SIZE;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(100, Math.max(1, n));
}

/**
 * 문자 수 캡을 500~20000 범위의 정수로 정규화함. 유효하지 않으면 기본값을 반환함.
 *
 * @param {*} value - 검증할 값.
 * @returns {number} 정규화된 문자 수 캡(500~20000).
 */
function normalizeMaxChars(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_MAX_CHARS;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(20000, Math.max(500, n));
}

/**
 * 동시 실행 배치 수를 1~10 범위의 정수로 정규화함. 유효하지 않으면 기본값을 반환함.
 *
 * @param {*} value - 검증할 값.
 * @returns {number} 정규화된 동시 실행 수(1~10).
 */
function normalizeConcurrency(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_CONCURRENCY;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(10, Math.max(1, n));
}

/**
 * 요청 타임아웃(초)을 10~300 범위의 정수로 정규화함. 유효하지 않으면 기본값을 반환함.
 *
 * @param {*} value - 검증할 값.
 * @returns {number} 정규화된 타임아웃(초, 10~300).
 */
function normalizeTimeoutSec(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_TIMEOUT_SEC;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(300, Math.max(10, n));
}

/**
 * 알림 메시지를 표시함.
 *
 * @param {HTMLElement} target - 메시지를 표시할 요소.
 * @param {string} text - 표시할 문구.
 * @param {"info"|"error"|"success"} [kind] - 메시지 종류(색상 구분).
 */
function notify(target, text, kind = "info") {
  target.textContent = text;
  target.dataset.kind = kind;
}

/** 번역 상태에 맞춰 버튼 문구/스타일을 갱신함. */
function renderButton() {
  if (translating) {
    els.translate.textContent = "번역 중지";
    els.translate.dataset.mode = "stop";
  } else {
    els.translate.textContent = "이 페이지 번역";
    els.translate.dataset.mode = "start";
  }
}

/**
 * 현재 선택된 AI 서비스와 모델을 번역 버튼 아래 요약 영역에 표시함.
 * 서비스 이름은 선택 목록의 표기를 그대로 쓰되, 좁은 팝업 폭을 고려해
 * 괄호 설명(예: "(자체 프록시)")은 떼어 냄.
 */
function renderCurrentSelection() {
  const label = els.provider.selectedOptions[0]?.textContent.trim() || els.provider.value;
  const model = els.model.value.trim();

  els.currentProvider.textContent = label.replace(/\s*\([^()]*\)\s*$/, "");
  els.currentModel.textContent = model || "모델 미설정";
  els.currentSelection.dataset.state = model ? "ok" : "empty";
}

/**
 * 현재 활성 탭을 반환함.
 *
 * @returns {Promise<chrome.tabs.Tab|undefined>} 활성 탭 또는 undefined.
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 선택된 프로바이더의 저장 값을 API 키/모델 입력란과 힌트에 반영함.
 *
 * @param {string} provider - 표시할 프로바이더 키.
 */
function fillCredentialFields(provider) {
  const cred = credentials[provider] || {};
  els.apiKey.value = cred.apiKey || "";
  els.model.value = cred.model || "";
  els.openrouterProvider.value = provider === "openrouter" ? cred.providerSlug || "" : "";
  els.openrouterProviderField.hidden = provider !== "openrouter";

  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER];
  els.apiKey.placeholder = meta.apiKeyHint;
  els.model.placeholder = meta.modelHint;

  renderCurrentSelection();
}

/** 조회된 모델 후보와 조회 상태를 초기화함. */
function clearModelOptions() {
  els.modelList.replaceChildren();
  notify(els.modelNotice, "");
}

/**
 * 모델 항목에서 모델 ID 문자열을 추출함. 프로바이더마다 필드명이 달라 순서대로 탐색함.
 *
 * @param {*} item - 모델 목록 배열의 원소.
 * @returns {string} 모델 ID. 추출 실패 시 빈 문자열.
 */
function toModelId(item) {
  if (typeof item === "string") return item;
  const id = item?.id || item?.model_id || item?.model || item?.name;
  return typeof id === "string" ? id.replace(/^models\//, "") : "";
}

/**
 * 응답 본문에서 모델 목록 배열을 찾아 반환함.
 *
 * 프로바이더마다 목록의 위치가 달라(`data`, `models`, `data.data`, 배열 루트 등)
 * 얕은 깊이까지 재귀 탐색하며, 원소에서 모델 ID를 뽑을 수 있는 배열만 인정함.
 *
 * @param {*} value - 탐색 대상 값(응답 본문 또는 그 하위 값).
 * @param {number} [depth] - 현재 탐색 깊이.
 * @returns {Array|null} 모델 목록 배열. 찾지 못하면 null.
 */
function findModelArray(value, depth = 0) {
  if (Array.isArray(value)) {
    return value.length === 0 || toModelId(value[0]) ? value : null;
  }
  if (!value || typeof value !== "object" || depth >= 3) return null;
  for (const child of Object.values(value)) {
    const found = findModelArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 모델 목록 API를 한 번 호출해 정렬된 모델 ID 배열과 원문 응답을 반환함.
 *
 * @param {string} endpoint - 모델 목록 엔드포인트 URL.
 * @param {Record<string, string>} headers - 요청 헤더.
 * @returns {Promise<{raw: string, models: string[]}>} 원문 응답과 모델 ID 배열.
 */
async function fetchModelList(endpoint, headers) {
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`모델 목록 요청 실패 (HTTP ${response.status})`);
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`모델 목록 응답이 JSON이 아닙니다. (앞부분: ${raw.slice(0, 120)})`);
  }

  const models = [...new Set(
    (findModelArray(data) ?? []).map(toModelId).filter((modelId) => modelId.length > 0),
  )].sort((left, right) => left.localeCompare(right));
  return { raw, models };
}

/**
 * 선택 프로바이더의 모델 목록 API를 호출해 모델 ID 배열을 반환함.
 *
 * @param {string} provider - 조회할 프로바이더 키.
 * @param {string} apiKey - 모델 목록 조회에 사용할 API 키.
 * @returns {Promise<string[]>} 중복을 제거하고 이름순으로 정렬한 모델 ID 배열.
 */
async function requestModels(provider, apiKey) {
  const meta = PROVIDER_META[provider];
  if (!meta?.modelsEndpoint) throw new Error("이 프로바이더는 모델 조회를 지원하지 않습니다.");

  const headers = provider === "gemini"
    ? { "x-goog-api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
  const { models } = await fetchModelList(meta.modelsEndpoint, headers);
  return models;
}

/** 모델 목록을 조회해 직접 입력란에 연결된 후보 목록으로 표시함. */
async function fetchModelOptions() {
  const provider = els.provider.value;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    notify(els.modelNotice, "API 키를 먼저 입력하세요.", "error");
    els.apiKey.focus();
    return;
  }

  els.fetchModels.disabled = true;
  els.fetchModels.textContent = "가져오는 중...";
  notify(els.modelNotice, "모델 목록을 조회하고 있습니다.");

  try {
    const models = await requestModels(provider, apiKey);
    els.modelList.replaceChildren(
      ...models.map((modelId) => {
        const option = document.createElement("option");
        option.value = modelId;
        return option;
      }),
    );
    notify(
      els.modelNotice,
      models.length > 0
        ? `${models.length}개 모델을 가져왔습니다. 입력란에서 선택하세요.`
        : "사용 가능한 모델이 없습니다.",
      models.length > 0 ? "success" : "error",
    );
    if (models.length > 0) els.model.focus();
  } catch (error) {
    notify(els.modelNotice, error.message || "모델 목록을 가져오지 못했습니다.", "error");
  } finally {
    els.fetchModels.disabled = false;
    els.fetchModels.textContent = "모델 가져오기";
  }
}

/** 현재 폼의 API 키/모델 입력값을 표시 중인 프로바이더 자격증명 캐시에 반영함. */
function captureShownCredentials() {
  credentials[shownProvider] = {
    ...(credentials[shownProvider] || {}),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    ...(shownProvider === "openrouter"
      ? { providerSlug: els.openrouterProvider.value.trim() }
      : {}),
  };
}

/** 저장소의 설정값을 입력 폼에 반영함. */
async function loadSettings() {
  const cfg = await chrome.storage.local.get(STORAGE_DEFAULTS);
  const provider = AVAILABLE_PROVIDERS.has(cfg.provider) ? cfg.provider : DEFAULT_PROVIDER;

  credentials =
    cfg.credentials && typeof cfg.credentials === "object" ? { ...cfg.credentials } : {};

  // 레거시(단일 apiKey/model) 저장 형식을 openai 자격증명으로 이관함.
  if (!credentials.openai && (cfg.apiKey || cfg.model)) {
    credentials.openai = { apiKey: cfg.apiKey, model: cfg.model };
  }

  els.provider.value = provider;
  els.tone.value = cfg.tone;
  els.reasoningEffort.value = cfg.reasoningEffort;
  els.glossary.value = cfg.glossary?.trim() || DEFAULT_GLOSSARY;
  els.batchSize.value = normalizeBatchSize(cfg.batchSize);
  els.maxChars.value = normalizeMaxChars(cfg.maxChars);
  els.concurrency.value = normalizeConcurrency(cfg.concurrency);
  els.timeoutSec.value = normalizeTimeoutSec(cfg.timeoutSec);
  els.debug.checked = Boolean(cfg.debug);
  els.showProgressToast.checked = cfg.showProgressToast !== false;

  shownProvider = provider;
  fillCredentialFields(provider);

  // 선택 프로바이더의 키/모델이 비어 있으면 설정 영역을 펼쳐 입력을 유도함.
  const cred = credentials[provider] || {};
  if (!cred.apiKey || !cred.model) {
    els.settings.open = true;
  }
}

/**
 * 활성 탭의 콘텐츠 스크립트에 번역 상태를 조회하여 버튼을 갱신함.
 * 콘텐츠 스크립트가 없는 페이지(chrome:// 등)에서는 비활성으로 간주함.
 */
async function refreshStatus() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    translating = false;
    renderButton();
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "get-status" });
    translating = Boolean(resp?.active);
  } catch {
    translating = false;
  }
  renderButton();
}

/**
 * 현재 폼 값을 저장소에 저장함. API 키/모델은 선택된 프로바이더별로 저장함.
 *
 * @param {boolean} [updateForm] - 정규화한 값을 입력 폼에도 반영할지 여부.
 * @returns {Promise<{provider: string, apiKey: string, model: string}>}
 *   선택된 프로바이더의 검증용 설정값(번역 시작 전 필수값 확인에 사용).
 */
async function saveSettings(updateForm = true) {
  captureShownCredentials();
  const provider = els.provider.value;

  // 수동 저장과 번역 시작 시에는 보정된 값을 폼에도 표시하되,
  // 자동 저장 중에는 사용자가 작성 중인 입력값을 덮어쓰지 않음.
  const batchSize = normalizeBatchSize(els.batchSize.value);
  const maxChars = normalizeMaxChars(els.maxChars.value);
  const concurrency = normalizeConcurrency(els.concurrency.value);
  const timeoutSec = normalizeTimeoutSec(els.timeoutSec.value);
  const glossary = els.glossary.value.trim() || DEFAULT_GLOSSARY;
  if (updateForm) {
    els.batchSize.value = batchSize;
    els.maxChars.value = maxChars;
    els.concurrency.value = concurrency;
    els.timeoutSec.value = timeoutSec;
    els.glossary.value = glossary;
  }

  await chrome.storage.local.set({
    provider,
    credentials,
    tone: els.tone.value,
    reasoningEffort: els.reasoningEffort.value,
    glossary,
    batchSize,
    maxChars,
    concurrency,
    timeoutSec,
    debug: els.debug.checked,
    showProgressToast: els.showProgressToast.checked,
  });

  const cred = credentials[provider] || {};
  return { provider, apiKey: cred.apiKey || "", model: cred.model || "" };
}

/** 변경된 설정을 짧게 모아 저장함. 연속 입력 시 불필요한 저장 요청을 줄임. */
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    autoSaveTimer = null;
    try {
      await saveSettings(false);
      notify(els.saveNotice, "변경사항이 자동 저장되었습니다.", "success");
    } catch {
      notify(els.saveNotice, "설정을 자동 저장하지 못했습니다.", "error");
    }
  }, AUTO_SAVE_DELAY_MS);
}

/** 팝업이 닫히기 전에 대기 중인 변경사항을 즉시 저장함. */
function flushAutoSave() {
  if (!autoSaveTimer) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  void saveSettings(false).catch(() => {});
}

/**
 * 번역을 시작함. 설정 검증 통과 시 콘텐츠 스크립트에 시작 신호를 보내고 팝업을 닫음.
 */
async function startTranslation() {
  const cfg = await saveSettings();
  if (!cfg.apiKey) {
    els.settings.open = true;
    notify(els.notice, "API 키를 먼저 입력하세요.", "error");
    return;
  }
  if (!cfg.model) {
    els.settings.open = true;
    notify(els.notice, "모델명을 먼저 입력하세요.", "error");
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    notify(els.notice, "활성 탭을 찾을 수 없습니다.", "error");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "start-translation" });
    window.close(); // 시작 후 팝업을 닫음
  } catch {
    // 콘텐츠 스크립트 미주입(예: chrome:// 페이지, 확장 스토어)
    notify(
      els.notice,
      "이 페이지에서는 번역을 실행할 수 없습니다. 일반 웹 페이지에서 시도하세요.",
      "error",
    );
  }
}

/** 번역을 중지함. 콘텐츠 스크립트에 중지 신호를 보내고 버튼을 시작 상태로 되돌림. */
async function stopTranslation() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "stop-translation" });
  } catch {
    // 콘텐츠 스크립트가 없으면 무시함.
  }
  translating = false;
  renderButton();
  notify(els.notice, "번역을 중지했습니다. 더 이상 번역하지 않습니다.", "success");
}

/**
 * 속도 측정 결과를 사람이 읽을 수 있는 문구로 변환함.
 *
 * tps 는 프로바이더가 usage 로 알려준 실측 출력 토큰 수에서만 계산함.
 * usage 를 주지 않는 프로바이더에서는 추정치를 만들지 않고, 대신 초당 처리한
 * 문자 수를 표시함.
 *
 * @param {{elapsedMs: number, segmentCount: number, inputChars: number, outputChars: number, model: string, usage: {inputTokens: number|null, outputTokens: number|null, totalTokens: number|null}|null}} result
 *   백그라운드가 반환한 측정 결과.
 * @returns {string} 표시할 결과 문구(줄바꿈 포함).
 */
function formatSpeedResult(result) {
  const seconds = result.elapsedMs / 1000;
  const lines = [];
  const usage = result.usage;

  if (usage?.outputTokens > 0) {
    lines.push(`출력 ${(usage.outputTokens / seconds).toFixed(1)} tok/s (생성 토큰 기준)`);
  }
  if (usage?.totalTokens > 0) {
    lines.push(`전체 ${(usage.totalTokens / seconds).toFixed(1)} tok/s (입력+출력 토큰 기준)`);
  }
  if (!usage || (!usage.outputTokens && !usage.totalTokens)) {
    lines.push("이 프로바이더는 토큰 사용량을 반환하지 않아 tok/s 를 계산할 수 없습니다.");
    lines.push(`출력 ${(result.outputChars / seconds).toFixed(0)} 자/s`);
  }

  lines.push(`소요 ${seconds.toFixed(1)}초 · 모델 ${result.model}`);
  lines.push(
    `예문 ${result.segmentCount}줄 / ${result.inputChars.toLocaleString()}자 → 번역 ${result.outputChars.toLocaleString()}자`,
  );
  if (usage) {
    lines.push(
      `토큰 입력 ${usage.inputTokens ?? "?"} / 출력 ${usage.outputTokens ?? "?"} / 합계 ${usage.totalTokens ?? "?"}`,
    );
  }
  return lines.join("\n");
}

/**
 * 동봉된 예문을 한 번 번역시켜 처리 속도를 측정하고 결과를 표시함.
 * 측정 중 팝업을 닫으면 응답을 받지 못하므로 안내 문구로 알림.
 */
async function runSpeedTest() {
  const cfg = await saveSettings();
  if (!cfg.apiKey) {
    notify(els.speedNotice, "API 키를 먼저 입력하세요.", "error");
    return;
  }
  if (!cfg.model) {
    notify(els.speedNotice, "모델명을 먼저 입력하세요.", "error");
    return;
  }

  els.speedTest.disabled = true;
  els.speedTest.textContent = "측정 중...";
  notify(els.speedNotice, "예문을 번역하며 측정 중입니다. 팝업을 닫지 마세요.");

  try {
    const result = await chrome.runtime.sendMessage({ type: "speed-test" });
    if (!result) throw new Error("백그라운드에서 응답이 없습니다.");
    if (result.error) {
      notify(els.speedNotice, result.error, "error");
      return;
    }
    notify(els.speedNotice, formatSpeedResult(result), "success");
  } catch (error) {
    notify(els.speedNotice, error.message || "속도 측정에 실패했습니다.", "error");
  } finally {
    els.speedTest.disabled = false;
    els.speedTest.textContent = "속도 측정";
  }
}

// 버튼은 현재 모드에 따라 시작 또는 중지로 동작함.
els.translate.addEventListener("click", () => {
  if (translating) {
    stopTranslation();
  } else {
    startTranslation();
  }
});

// 프로바이더 전환: 현재 입력값을 이전 프로바이더에 보존하고, 새 프로바이더의
// 저장 값을 폼에 표시함.
els.provider.addEventListener("change", () => {
  captureShownCredentials();
  shownProvider = els.provider.value;
  fillCredentialFields(shownProvider);
  clearModelOptions();
  scheduleAutoSave();
});

// 모델을 직접 입력/선택하면 요약 표시도 즉시 갱신함.
els.model.addEventListener("input", renderCurrentSelection);
els.model.addEventListener("change", renderCurrentSelection);

els.fetchModels.addEventListener("click", fetchModelOptions);

els.openrouterProvider.addEventListener("input", () => {
  els.openrouterProvider.value = els.openrouterProvider.value.toLowerCase();
});

for (const el of [
  els.apiKey,
  els.model,
  els.openrouterProvider,
  els.glossary,
  els.tone,
  els.reasoningEffort,
  els.batchSize,
  els.maxChars,
  els.concurrency,
  els.timeoutSec,
  els.debug,
  els.showProgressToast,
]) {
  el.addEventListener("input", scheduleAutoSave);
}

els.save.addEventListener("click", async () => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await saveSettings();
  notify(els.saveNotice, "설정을 저장했습니다.", "success");
});

els.speedTest.addEventListener("click", runSpeedTest);

window.addEventListener("pagehide", flushAutoSave);

// 초기화: 설정 로드 후 현재 탭의 번역 상태를 반영함.
els.appVersion.textContent = `v${chrome.runtime.getManifest().version}`;
loadSettings();
refreshStatus();
