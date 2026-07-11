// OpenRouter 프로바이더
// OpenRouter 는 OpenAI 호환 Chat Completions API 를 제공하므로, 엔드포인트만
// 교체하고 공통 팩토리를 재사용함. base_url 은 https://openrouter.ai/api/v1 이며
// Chat Completions 전체 경로는 /api/v1/chat/completions 임.
// X-Title 은 OpenRouter 대시보드/리더보드에서 앱을 식별하기 위한 선택 헤더임.

import { createTranslator } from "./openai-compatible.js";

/**
 * OpenRouter Chat Completions 로 세그먼트 배열을 한국어 번역함.
 * 모델명에는 OpenRouter 슬러그를 사용함(예: "deepseek/deepseek-v4-flash", "anthropic/claude-sonnet-5").
 * 시그니처: translateSegments({ apiKey, model, segments, tone, glossary }) -> Promise<string[]>
 */
export const translateSegments = createTranslator({
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  label: "OpenRouter",
  extraHeaders: { "X-Title": "AI Page Translator" },
  // OpenRouter 는 통합 reasoning 객체를 사용함(최상위 reasoning_effort 는 deprecated,
  // 둘을 동시에 보내면 일부 모델에서 400). exclude:true 로 추론 내용은 응답에서 제외함.
  reasoningParam: (effort) => ({ reasoning: { effort, exclude: true } }),
  // JSON 모드를 사용한 비스트리밍 응답이 손상되면 OpenRouter 공식 플러그인이
  // 누락된 따옴표·괄호 등 일반적인 문법 오류를 우선 복구하도록 함.
  extraBody: ({ useResponseFormat }) =>
    useResponseFormat ? { plugins: [{ id: "response-healing" }] } : {},
});
