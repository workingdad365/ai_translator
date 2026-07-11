// 팝업 스크립트
// 설정(프로바이더/API 키/모델)을 저장소와 동기화하고,
// 활성 탭의 번역 상태에 따라 "이 페이지 번역" / "번역 중지" 버튼을 토글함.
// - 번역을 시작하면 팝업을 즉시 닫음.
// - 번역 중인 페이지에서 팝업을 다시 열면 "번역 중지" 버튼이 표시되고, 누르면 세션을 멈춤.
// - API 키/모델은 프로바이더별로 개별 저장하므로, 프로바이더를 전환하면 해당
//   프로바이더에 저장해 둔 값이 폼에 표시됨.

const DEFAULT_PROVIDER = "openai";

// 프로바이더별 입력 힌트(placeholder). 지원 프로바이더 추가 시 여기에 등록함.
const PROVIDER_META = {
  openai: { apiKeyHint: "sk-...", modelHint: "예: gpt-5.4-mini" },
  openrouter: { apiKeyHint: "sk-or-...", modelHint: "예: deepseek/deepseek-v4-flash" },
};

// 저장소 기본값. credentials 는 { [provider]: { apiKey, model } } 구조이며,
// apiKey/model 최상위 키는 과거 단일 형식과의 하위 호환을 위해서만 읽음.
const DEFAULT_BATCH_SIZE = 40;
const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_TIMEOUT_SEC = 60;

const STORAGE_DEFAULTS = {
  provider: DEFAULT_PROVIDER,
  credentials: {},
  tone: "banmal",
  glossary: "",
  reasoningEffort: "none",
  batchSize: DEFAULT_BATCH_SIZE,
  maxChars: DEFAULT_MAX_CHARS,
  timeoutSec: DEFAULT_TIMEOUT_SEC,
  debug: false,
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
  tone: document.getElementById("tone"),
  reasoningEffort: document.getElementById("reasoning-effort"),
  glossary: document.getElementById("glossary"),
  batchSize: document.getElementById("batch-size"),
  maxChars: document.getElementById("max-chars"),
  timeoutSec: document.getElementById("timeout-sec"),
  debug: document.getElementById("debug"),
  translate: document.getElementById("translate-button"),
  save: document.getElementById("save-button"),
  settings: document.getElementById("settings"),
  notice: document.getElementById("notice"),
  saveNotice: document.getElementById("save-notice"),
};

// 현재 활성 탭의 번역 세션 활성 여부(버튼 표시 상태 결정).
let translating = false;

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

  const meta = PROVIDER_META[provider] || PROVIDER_META[DEFAULT_PROVIDER];
  els.apiKey.placeholder = meta.apiKeyHint;
  els.model.placeholder = meta.modelHint;
}

/** 현재 폼의 API 키/모델 입력값을 표시 중인 프로바이더 자격증명 캐시에 반영함. */
function captureShownCredentials() {
  credentials[shownProvider] = {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
  };
}

/** 저장소의 설정값을 입력 폼에 반영함. */
async function loadSettings() {
  const cfg = await chrome.storage.local.get(STORAGE_DEFAULTS);

  credentials =
    cfg.credentials && typeof cfg.credentials === "object" ? { ...cfg.credentials } : {};

  // 레거시(단일 apiKey/model) 저장 형식을 openai 자격증명으로 이관함.
  if (!credentials.openai && (cfg.apiKey || cfg.model)) {
    credentials.openai = { apiKey: cfg.apiKey, model: cfg.model };
  }

  els.provider.value = cfg.provider;
  els.tone.value = cfg.tone;
  els.reasoningEffort.value = cfg.reasoningEffort;
  els.glossary.value = cfg.glossary;
  els.batchSize.value = normalizeBatchSize(cfg.batchSize);
  els.maxChars.value = normalizeMaxChars(cfg.maxChars);
  els.timeoutSec.value = normalizeTimeoutSec(cfg.timeoutSec);
  els.debug.checked = Boolean(cfg.debug);

  shownProvider = cfg.provider;
  fillCredentialFields(cfg.provider);

  // 선택 프로바이더의 키/모델이 비어 있으면 설정 영역을 펼쳐 입력을 유도함.
  const cred = credentials[cfg.provider] || {};
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
 * @returns {Promise<{provider: string, apiKey: string, model: string}>}
 *   선택된 프로바이더의 검증용 설정값(번역 시작 전 필수값 확인에 사용).
 */
async function saveSettings() {
  captureShownCredentials();
  const provider = els.provider.value;

  // 입력값을 정규화한 뒤 폼에도 되돌려 표시(범위를 벗어난 입력 보정을 사용자에게 반영).
  const batchSize = normalizeBatchSize(els.batchSize.value);
  const maxChars = normalizeMaxChars(els.maxChars.value);
  const timeoutSec = normalizeTimeoutSec(els.timeoutSec.value);
  els.batchSize.value = batchSize;
  els.maxChars.value = maxChars;
  els.timeoutSec.value = timeoutSec;

  await chrome.storage.local.set({
    provider,
    credentials,
    tone: els.tone.value,
    reasoningEffort: els.reasoningEffort.value,
    glossary: els.glossary.value.trim(),
    batchSize,
    maxChars,
    timeoutSec,
    debug: els.debug.checked,
  });

  const cred = credentials[provider] || {};
  return { provider, apiKey: cred.apiKey || "", model: cred.model || "" };
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
});

els.save.addEventListener("click", async () => {
  await saveSettings();
  notify(els.saveNotice, "설정을 저장했습니다.", "success");
});

// 초기화: 설정 로드 후 현재 탭의 번역 상태를 반영함.
loadSettings();
refreshStatus();
