// OpenAI 프로바이더
// Chat Completions API 를 사용해 텍스트 세그먼트 배열을 한국어로 번역함.
// 실제 요청/프롬프트 로직은 openai-compatible.js 의 공통 팩토리에 위임하고,
// 여기서는 OpenAI 엔드포인트만 지정함.

import { createTranslator } from "./openai-compatible.js";

/**
 * OpenAI Chat Completions 로 세그먼트 배열을 한국어 번역함.
 * 시그니처: translateSegments({ apiKey, model, segments, tone, glossary }) -> Promise<string[]>
 */
export const translateSegments = createTranslator({
  endpoint: "https://api.openai.com/v1/chat/completions",
  label: "OpenAI",
  // Chat Completions 는 최상위 reasoning_effort 를 사용함(GPT-5 계열).
  reasoningParam: (effort) => ({ reasoning_effort: effort }),
});
