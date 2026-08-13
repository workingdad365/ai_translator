// LiteLLM 프로바이더
// 직접 운영하는 LiteLLM 프록시(https://llm.drasys.com)를 통해 여러 공급자의 모델을
// 하나의 OpenAI 호환 엔드포인트로 호출함. API 키에는 LiteLLM 가상 키를 사용함.
// 브라우저 직호출을 막는 게이트웨이(WaveSpeed 등)도 이 프록시를 거치면 사용할 수 있음.

import { createTranslator } from "./openai-compatible.js";

/**
 * LiteLLM 프록시의 Chat Completions 로 세그먼트 배열을 한국어 번역함.
 * 모델명에는 LiteLLM 에 등록한 Public Model Name 을 사용함.
 * 시그니처: translateSegments({ apiKey, model, segments, tone, glossary }) -> Promise<string[]>
 */
export const translateSegments = createTranslator({
  endpoint: "https://llm.drasys.com/v1/chat/completions",
  label: "LiteLLM",
  // LiteLLM 은 표준 reasoning_effort 를 받아 공급자별 형식으로 변환해 전달함.
  reasoningParam: (effort) => ({ reasoning_effort: effort }),
});
