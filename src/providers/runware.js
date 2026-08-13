// Runware 프로바이더
// Runware(runware.ai)는 OpenAI 호환 Chat Completions 엔드포인트를 제공하므로,
// 엔드포인트만 교체하고 공통 팩토리를 재사용함. base_url 은
// https://api.runware.ai/v1 이며 전체 경로는 /v1/chat/completions 임.

import { createTranslator } from "./openai-compatible.js";

/**
 * Runware Chat Completions 로 세그먼트 배열을 한국어 번역함.
 * 모델명에는 Runware AIR ID 를 사용함(예: "minimax:m2.7@0", "google:gemini@3.1-pro").
 * 시그니처: translateSegments({ apiKey, model, segments, tone, glossary }) -> Promise<string[]>
 */
export const translateSegments = createTranslator({
  endpoint: "https://api.runware.ai/v1/chat/completions",
  label: "Runware",
  // OpenAI 프로토콜을 그대로 따르는 엔드포인트이므로 표준 reasoning_effort 를 전송함.
  // 모델이 거부하면 공통 팩토리가 지원 값으로 자동 폴백함.
  reasoningParam: (effort) => ({ reasoning_effort: effort }),
  // Runware 는 response_format 을 보내면 스키마를 요구해
  // 400 `Missing required parameter: 'jsonSchema'` 를 반환하므로 필드를 아예 생략함.
  // JSON 출력은 시스템 프롬프트 지시만으로 유도함.
  supportsResponseFormat: false,
});
