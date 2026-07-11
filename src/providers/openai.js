// OpenAI 프로바이더
// Chat Completions API 를 사용해 텍스트 세그먼트 배열을 한국어로 번역함.
// 다른 프로바이더(Anthropic 등)를 추가할 때 이 파일과 동일한 시그니처
// (translateSegments 함수)를 구현하면 background.js 의 프로바이더 레지스트리에
// 그대로 연결할 수 있도록 인터페이스를 통일함.

const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// 번역 지시용 시스템 프롬프트.
// 입력 세그먼트와 동일한 개수/순서의 JSON 배열을 강제하여 매핑 안정성을 확보함.
const SYSTEM_PROMPT = [
  "You are a professional translator.",
  "Translate every text segment in the input JSON into natural, fluent Korean.",
  "Keep the original meaning, tone, numbers, URLs, and any markup-like tokens unchanged.",
  'The input is a JSON object of the form {"segments": ["...", ...]}.',
  'Return ONLY a JSON object of the form {"translations": ["...", ...]}',
  "where the translations array has EXACTLY the same length and order as the input segments array.",
  "If a segment is already Korean or should not be translated (e.g. code, a bare number), return it unchanged.",
  "Do not add any explanation or extra keys.",
].join(" ");

/**
 * 텍스트 세그먼트 배열을 한국어로 번역함.
 *
 * @param {object} params - 번역 요청 파라미터.
 * @param {string} params.apiKey - OpenAI API 키 (Bearer 토큰).
 * @param {string} params.model - 사용할 모델 이름 (예: "gpt-5.4-mini").
 * @param {string[]} params.segments - 번역할 원문 문자열 배열.
 * @returns {Promise<string[]>} 입력과 동일한 길이/순서의 한국어 번역 배열.
 * @throws {Error} API 응답이 실패하거나(HTTP 오류) 응답 형식이 올바르지 않을 때.
 */
export async function translateSegments({ apiKey, model, segments }) {
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ segments }) },
    ],
    response_format: { type: "json_object" },
  };

  let res;
  try {
    res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 네트워크 오류 (연결 실패 등)
    throw new Error(`network error: ${err.message}`);
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    // 인증/요청 한도 오류를 상태 코드와 함께 그대로 노출하여 상위에서 분기 처리 가능하게 함.
    throw new Error(`OpenAI API error (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("failed to parse model response as JSON");
  }

  const translations = parsed?.translations;
  if (!Array.isArray(translations)) {
    throw new Error("response has no 'translations' array");
  }

  return translations;
}

/**
 * 오류 응답 본문을 안전하게 읽음. 본문 파싱 실패 시 빈 문자열을 반환함.
 *
 * @param {Response} res - fetch 응답 객체.
 * @returns {Promise<string>} 응답 본문 텍스트 또는 빈 문자열.
 */
async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
