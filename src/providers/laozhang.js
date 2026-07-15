// LaoZhang AI 프로바이더
// LaoZhang AI는 OpenAI 호환 Chat Completions API를 제공하므로, 공식 백업
// 엔드포인트와 토큰 상한 파라미터만 지정하고 공통 번역기 팩토리를 재사용함.

import { createTranslator } from "./openai-compatible.js";

/**
 * LaoZhang AI Chat Completions로 HTML 세그먼트 배열을 한국어로 번역함.
 *
 * 공식 API의 Bearer 인증과 OpenAI 호환 요청·응답 형식을 사용하며, 출력 토큰
 * 상한은 문서화된 `max_tokens` 필드로 전달함. 추론 강도 파라미터는 공식 API
 * 매뉴얼에 명시되어 있지 않으므로 전송하지 않음.
 *
 * @param {object} params - 공통 번역 요청 파라미터.
 * @returns {Promise<string[]>} 입력과 동일한 순서의 번역된 HTML 세그먼트 배열.
 */
export const translateSegments = createTranslator({
  endpoint: "https://api-vip.laozhang.ai/v1/chat/completions",
  label: "LaoZhang AI",
  tokenParam: "max_tokens",
});