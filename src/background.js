// 백그라운드 서비스 워커
// 콘텐츠 스크립트로부터 번역 요청을 받아 LLM 프로바이더를 호출함.
// API 호출을 서비스 워커에서 수행하는 이유:
//  1) 페이지의 CSP(connect-src) 제약을 우회할 수 있음.
//  2) API 키를 페이지 컨텍스트에 노출하지 않고 확장 프로그램 내부에만 유지함.

import { translateSegments as openaiTranslate } from "./providers/openai.js";
import { translateSegments as openrouterTranslate } from "./providers/openrouter.js";
import { translateSegments as nanogptTranslate } from "./providers/nanogpt.js";
import { translateSegments as runwareTranslate } from "./providers/runware.js";
import { translateSegments as litellmTranslate } from "./providers/litellm.js";
import { translateSegments as laozhangTranslate } from "./providers/laozhang.js";
import { translateSegments as geminiTranslate } from "./providers/gemini.js";

// 프로바이더 레지스트리. 향후 확장 시 이 객체에 항목을 추가함.
// 각 프로바이더는 translateSegments({ apiKey, model, segments, tone, glossary })
// 시그니처를 따름.
const PROVIDERS = {
  openai: openaiTranslate,
  openrouter: openrouterTranslate,
  nanogpt: nanogptTranslate,
  // runware 는 팝업 목록에서 숨겼지만, 기존에 선택해 둔 사용자를 위해 레지스트리에는 유지함.
  runware: runwareTranslate,
  litellm: litellmTranslate,
  // laozhang 도 팝업 목록에서 숨겼지만 동일한 이유로 레지스트리에는 유지함.
  laozhang: laozhangTranslate,
  gemini: geminiTranslate,
};

const DEFAULT_PROVIDER = "openai";

/**
 * 저장소에서 사용자 설정(프로바이더/자격증명/말투/용어집)을 읽음.
 *
 * API 키와 모델은 프로바이더별로 `credentials[provider] = { apiKey, model }`
 * 형태로 저장함. 과거 단일 형식(최상위 `apiKey`/`model`)으로 저장된 값은
 * openai 자격증명으로 간주하여 하위 호환함.
 *
 * @returns {Promise<{provider: string, apiKey: string, model: string, providerSlug: string, tone: string, glossary: string, reasoningEffort: string, timeoutMs: number, debug: boolean}>}
 *   선택된 프로바이더의 설정값. tone 은 "banmal"(기본), "jondaenmal", "casual",
 *   reasoningEffort 는 추론 강도("none" 기본 / "minimal" / "low" / "default"),
 *   timeoutMs 는 요청 타임아웃(ms, 기본 60000), debug 는 상세 로그 여부.
 */
async function getSettings() {
  const stored = await chrome.storage.local.get([
    "provider",
    "credentials",
    "tone",
    "glossary",
    "reasoningEffort",
    "timeoutSec",
    "debug",
    "apiKey", // 레거시 호환용 최상위 키
    "model",
  ]);

  const provider = stored.provider || DEFAULT_PROVIDER;
  const credentials = stored.credentials || {};
  const cred = credentials[provider] || {};

  let apiKey = cred.apiKey || "";
  let model = cred.model || "";
  // 레거시(단일 apiKey/model) 저장 형식 호환: 선택 프로바이더가 openai 이고
  // 신규 형식 값이 비어 있으면 과거 최상위 키를 사용함.
  if (provider === "openai") {
    if (!apiKey) apiKey = stored.apiKey || "";
    if (!model) model = stored.model || "";
  }

  return {
    provider,
    apiKey,
    model,
    providerSlug: provider === "openrouter" ? String(cred.providerSlug || "").trim() : "",
    tone: stored.tone || "banmal",
    glossary: stored.glossary || "",
    reasoningEffort: stored.reasoningEffort || "none",
    // 저장은 초 단위(timeoutSec). 프로바이더에는 ms 로 전달함. 기본 60초.
    timeoutMs: (Number(stored.timeoutSec) || 60) * 1000,
    debug: Boolean(stored.debug),
  };
}

/**
 * 세그먼트 배열을 번역함. 설정 검증 후 해당 프로바이더로 위임함.
 *
 * @param {string[]} segments - 번역할 원문 배열.
 * @returns {Promise<{translations?: string[], missingIndices?: number[], error?: string, errorCode?: string|null, requestStats?: {segmentCount: number, charCount: number, timeoutMs: number}}>} 번역 결과 또는 오류 정보.
 */
async function handleTranslate(segments) {
  const {
    provider,
    apiKey,
    model,
    providerSlug,
    tone,
    glossary,
    reasoningEffort,
    timeoutMs,
    debug,
  } = await getSettings();

  if (!apiKey) {
    return { error: "API 키가 설정되지 않았습니다. 확장 팝업에서 키를 입력하세요." };
  }
  if (!model) {
    return { error: "모델이 설정되지 않았습니다. 확장 팝업에서 모델명을 입력하세요." };
  }

  const translate = PROVIDERS[provider];
  if (!translate) {
    return { error: `지원하지 않는 프로바이더입니다: ${provider}` };
  }

  const startedAt = Date.now();
  if (debug) {
    console.debug(
      `[ai_translator ${new Date().toISOString()}] [background/handleTranslate] ` +
        `dispatch provider=${provider} model=${model} segments=${segments.length}`,
    );
  }

  try {
    const translations = await translate({
      apiKey,
      model,
      providerSlug,
      segments,
      tone,
      glossary,
      reasoningEffort,
      timeoutMs,
      debug,
    });
    if (debug) {
      console.debug(
        `[ai_translator ${new Date().toISOString()}] [background/handleTranslate] ` +
          `done in ${Date.now() - startedAt}ms, translations=${translations.length}`,
      );
    }
    return { translations, missingIndices: translations.missingIndices || [] };
  } catch (err) {
    // [background.js/handleTranslate] 번역 실패 시 콘텐츠 스크립트로 오류 전달.
    // 콘솔 오류 로그는 debug 일 때만 남기며, 프로바이더/모델/소요시간을 함께 남겨
    // 간헐적 실패의 원인 추적을 도움.
    if (debug) {
      console.error(
        `[ai_translator ${new Date().toISOString()}] [background/handleTranslate] ` +
          `translate failed (provider=${provider}, model=${model}, ${Date.now() - startedAt}ms):`,
        err,
      );
    }
    return {
      error: err.message,
      errorCode: err.code || null,
      requestStats: {
        segmentCount: segments.length,
        charCount: segments.reduce((total, segment) => total + segment.length, 0),
        timeoutMs,
      },
    };
  }
}

// 속도 측정용 예문 파일(확장 패키지에 동봉). 팝업의 "속도 측정" 버튼이 사용함.
const SPEED_TEST_FILE = "speed_test.txt";
// 속도 측정은 예문 전체를 한 번의 요청으로 보내므로 일반 배치보다 오래 걸림.
// 사용자의 타임아웃 설정이 짧아 측정 자체가 실패하는 것을 막기 위한 하한.
const SPEED_TEST_MIN_TIMEOUT_MS = 180000;

/**
 * 속도 측정용 예문을 읽어 줄 단위 세그먼트 배열로 변환함.
 *
 * 실제 번역과 동일하게 블록 단위(문단/제목)로 나눠 보내기 위해 빈 줄을 제외한
 * 각 줄을 하나의 세그먼트로 취급함.
 *
 * @returns {Promise<string[]>} 번역할 세그먼트 배열.
 * @throws {Error} 예문 파일을 읽지 못했을 때.
 */
async function loadSpeedTestSegments() {
  const response = await fetch(chrome.runtime.getURL(SPEED_TEST_FILE));
  if (!response.ok) {
    throw new Error(`속도 측정용 예문을 읽지 못했습니다. (HTTP ${response.status})`);
  }
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 동봉된 예문을 한 번의 요청으로 번역해 처리 속도를 측정함.
 *
 * 측정의 일관성을 위해 배치 분할과 동시 실행을 쓰지 않고 단일 요청으로 보냄.
 * 토큰 수는 프로바이더가 반환한 usage 값을 그대로 사용하며, usage 를 제공하지
 * 않는 프로바이더에서는 null 로 반환해 팝업이 tps 대신 다른 지표를 표시하게 함.
 *
 * @returns {Promise<{provider?: string, model?: string, elapsedMs?: number, segmentCount?: number, inputChars?: number, outputChars?: number, usage?: object|null, error?: string}>}
 *   측정 결과 또는 오류 정보.
 */
async function handleSpeedTest() {
  const {
    provider,
    apiKey,
    model,
    providerSlug,
    tone,
    glossary,
    reasoningEffort,
    timeoutMs,
    debug,
  } = await getSettings();

  if (!apiKey) return { error: "API 키가 설정되지 않았습니다." };
  if (!model) return { error: "모델이 설정되지 않았습니다." };

  const translate = PROVIDERS[provider];
  if (!translate) return { error: `지원하지 않는 프로바이더입니다: ${provider}` };

  let segments;
  try {
    segments = await loadSpeedTestSegments();
  } catch (err) {
    return { error: err.message };
  }
  if (segments.length === 0) return { error: "속도 측정용 예문이 비어 있습니다." };

  const inputChars = segments.reduce((total, segment) => total + segment.length, 0);
  const startedAt = Date.now();

  try {
    const translations = await translate({
      apiKey,
      model,
      providerSlug,
      segments,
      tone,
      glossary,
      reasoningEffort,
      timeoutMs: Math.max(timeoutMs, SPEED_TEST_MIN_TIMEOUT_MS),
      debug,
    });
    return {
      provider,
      model,
      elapsedMs: Date.now() - startedAt,
      segmentCount: segments.length,
      inputChars,
      outputChars: translations.reduce((total, text) => total + (text?.length || 0), 0),
      usage: translations.usage || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// 콘텐츠 스크립트로부터의 메시지 처리.
// sendResponse 를 비동기로 호출하므로 리스너에서 true 를 반환해야 함.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate-batch") {
    handleTranslate(message.segments).then(sendResponse);
    return true;
  }
  if (message?.type === "speed-test") {
    handleSpeedTest().then(sendResponse);
    return true;
  }
  return false;
});
