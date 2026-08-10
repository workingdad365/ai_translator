// NanoGPT 프로바이더
// NanoGPT(nano-gpt.com)는 OpenAI 호환 Chat Completions API 를 제공하므로,
// 엔드포인트만 교체하고 공통 팩토리를 재사용함. base_url 은
// https://nano-gpt.com/api/v1 이며 전체 경로는 /api/v1/chat/completions 임.

import { createTranslator } from "./openai-compatible.js";

/**
 * NanoGPT Chat Completions 로 세그먼트 배열을 한국어 번역함.
 * 모델명에는 NanoGPT 모델 ID 를 사용함(예: "openai/gpt-5.2", "moonshotai/kimi-k2.6").
 * 시그니처: translateSegments({ apiKey, model, segments, tone, glossary }) -> Promise<string[]>
 */
export const translateSegments = createTranslator({
  endpoint: "https://nano-gpt.com/api/v1/chat/completions",
  label: "NanoGPT",
  // NanoGPT 는 reasoning_effort 와 reasoning.effort 를 모두 받으며, exclude:true 로
  // 추론 내용을 응답에서 제외함. effort="none" 은 추론 자체를 끄는 신호로 처리됨.
  reasoningParam: (effort) => ({ reasoning: { effort, exclude: true } }),
  // 시스템 프롬프트(말투·용어집 규칙)는 배치마다 동일하므로 cache_control 브레이크포인트로
  // 캐싱함. NanoGPT 는 명시적 캐싱 프로바이더(Anthropic 등)에는 그대로 전달하고,
  // 암묵적 캐싱 또는 미지원 경로로 라우팅되면 무시함.
  cacheSystemPrompt: true,
});
