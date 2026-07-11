// 백그라운드 서비스 워커
// 콘텐츠 스크립트로부터 번역 요청을 받아 LLM 프로바이더를 호출함.
// API 호출을 서비스 워커에서 수행하는 이유:
//  1) 페이지의 CSP(connect-src) 제약을 우회할 수 있음.
//  2) API 키를 페이지 컨텍스트에 노출하지 않고 확장 프로그램 내부에만 유지함.

import { translateSegments } from "./providers/openai.js";

// 프로바이더 레지스트리. 향후 확장 시 이 객체에 항목을 추가함.
// 각 프로바이더는 translateSegments({ apiKey, model, segments }) 시그니처를 따름.
const PROVIDERS = {
  openai: translateSegments,
};

const DEFAULT_PROVIDER = "openai";

/**
 * 저장소에서 사용자 설정(프로바이더/API 키/모델/말투/용어집)을 읽음.
 *
 * @returns {Promise<{provider: string, apiKey: string, model: string, tone: string, glossary: string}>}
 *   저장된 설정값. tone 은 "banmal"(기본) 또는 "jondaenmal", glossary 는 줄 단위 매핑 원문.
 */
async function getSettings() {
  const {
    provider = DEFAULT_PROVIDER,
    apiKey = "",
    model = "",
    tone = "banmal",
    glossary = "",
  } = await chrome.storage.local.get(["provider", "apiKey", "model", "tone", "glossary"]);
  return { provider, apiKey, model, tone, glossary };
}

/**
 * 세그먼트 배열을 번역함. 설정 검증 후 해당 프로바이더로 위임함.
 *
 * @param {string[]} segments - 번역할 원문 배열.
 * @returns {Promise<{translations?: string[], error?: string}>} 번역 결과 또는 오류 메시지.
 */
async function handleTranslate(segments) {
  const { provider, apiKey, model, tone, glossary } = await getSettings();

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

  try {
    const translations = await translate({ apiKey, model, segments, tone, glossary });
    return { translations };
  } catch (err) {
    // [background.js/handleTranslate] 번역 실패 시 콘텐츠 스크립트로 오류 전달
    console.error("[ai_translator] translate failed:", err);
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
  return false;
});
