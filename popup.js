// 팝업 스크립트
// 설정(프로바이더/API 키/모델)을 저장소와 동기화하고,
// 활성 탭의 번역 상태에 따라 "이 페이지 번역" / "번역 중지" 버튼을 토글함.
// - 번역을 시작하면 팝업을 즉시 닫음.
// - 번역 중인 페이지에서 팝업을 다시 열면 "번역 중지" 버튼이 표시되고, 누르면 세션을 멈춤.

const DEFAULTS = { provider: "openai", apiKey: "", model: "" };

const els = {
  provider: document.getElementById("provider"),
  apiKey: document.getElementById("api-key"),
  model: document.getElementById("model"),
  translate: document.getElementById("translate-button"),
  save: document.getElementById("save-button"),
  settings: document.getElementById("settings"),
  notice: document.getElementById("notice"),
  saveNotice: document.getElementById("save-notice"),
};

// 현재 활성 탭의 번역 세션 활성 여부(버튼 표시 상태 결정).
let translating = false;

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

/** 저장소의 설정값을 입력 폼에 반영함. */
async function loadSettings() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  els.provider.value = cfg.provider;
  els.apiKey.value = cfg.apiKey;
  els.model.value = cfg.model;

  // 키/모델이 비어 있으면 설정 영역을 펼쳐 입력을 유도함.
  if (!cfg.apiKey || !cfg.model) {
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
 * 현재 폼 값을 저장소에 저장함.
 *
 * @returns {Promise<{provider: string, apiKey: string, model: string}>} 저장된 설정값.
 */
async function saveSettings() {
  const cfg = {
    provider: els.provider.value,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
  };
  await chrome.storage.local.set(cfg);
  return cfg;
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

els.save.addEventListener("click", async () => {
  await saveSettings();
  notify(els.saveNotice, "설정을 저장했습니다.", "success");
});

// 초기화: 설정 로드 후 현재 탭의 번역 상태를 반영함.
loadSettings();
refreshStatus();
