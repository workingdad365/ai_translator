// OpenAI 프로바이더
// Chat Completions API 를 사용해 텍스트 세그먼트 배열을 한국어로 번역함.
// 다른 프로바이더(Anthropic 등)를 추가할 때 이 파일과 동일한 시그니처
// (translateSegments 함수)를 구현하면 background.js 의 프로바이더 레지스트리에
// 그대로 연결할 수 있도록 인터페이스를 통일함.

const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

// 번역 지시용 시스템 프롬프트의 공통 기본 규칙.
// 입력 세그먼트와 동일한 개수/순서의 JSON 배열을 강제하여 매핑 안정성을 확보함.
const BASE_RULES = [
  "You are a professional translator.",
  "Translate every text segment in the input JSON into natural, fluent Korean.",
  "Keep the original meaning, numbers, URLs, and any markup-like tokens unchanged.",
  'The input is a JSON object of the form {"segments": ["...", ...]}.',
  'Return ONLY a JSON object of the form {"translations": ["...", ...]}',
  "where the translations array has EXACTLY the same length and order as the input segments array.",
  "If a segment is already Korean or should not be translated (e.g. code, a bare number), return it unchanged.",
  "Do not add any explanation or extra keys.",
];

// 말투(문체) 지침. 페이지 전체가 여러 배치로 나뉘어 번역되므로, 모든 배치에
// 동일한 말투 지침을 적용해야 존댓말/반말이 섞이지 않고 일관성이 유지됨.
const TONE_INSTRUCTIONS = {
  // 반말(해체/해라체): 신문 기사 문체에 가까운 일관된 평서형.
  banmal:
    "Write ALL translations in casual, informal Korean (반말). " +
    "Use plain declarative endings such as ~다, ~이다, ~였다, ~한다, ~야, ~해. " +
    "Never use polite/formal endings (존댓말) such as ~습니다, ~합니다, ~에요, ~예요, ~이에요, ~세요. " +
    "Keep the tone consistent across every segment.",
  // 존댓말(합쇼체): 정중한 격식체.
  jondaenmal:
    "Write ALL translations in polite, formal Korean (존댓말), " +
    "using endings such as ~습니다, ~합니다, ~입니다. " +
    "Keep the tone consistent across every segment.",
};

const DEFAULT_TONE = "banmal";

/**
 * 용어집 원문(줄 단위 매핑 문자열)을 [원어, 번역어] 쌍 배열로 파싱함.
 *
 * 각 줄은 `원어=번역어` 형식을 사용하며, 구분자로 `=>`, `->`, `→`, `=`, 탭을
 * 지원함. 빈 줄과 `#`로 시작하는 주석 줄은 무시함. 원어/번역어의 앞뒤 공백은
 * 제거함.
 *
 * @param {string} glossary - 사용자가 입력한 용어집 원문. 예: "Sam Altman=샘 올트먼".
 * @returns {Array<[string, string]>} [원어, 번역어] 쌍의 배열. 유효 항목이 없으면 빈 배열.
 */
function parseGlossary(glossary) {
  if (!glossary || typeof glossary !== "string") return [];

  const pairs = [];
  for (const rawLine of glossary.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // 가장 먼저 등장하는 구분자 위치를 찾아 좌/우로 분리함.
    const match = line.match(/\s*(=>|->|→|=|\t)\s*/);
    if (!match) continue;

    const source = line.slice(0, match.index).trim();
    const target = line.slice(match.index + match[0].length).trim();
    if (source && target) pairs.push([source, target]);
  }
  return pairs;
}

/**
 * 말투/용어집 설정을 반영한 시스템 프롬프트 문자열을 생성함.
 *
 * @param {object} params - 프롬프트 구성 옵션.
 * @param {string} [params.tone] - 말투 키("banmal" 또는 "jondaenmal"). 미지정 시 기본 반말.
 * @param {string} [params.glossary] - 용어집 원문(줄 단위 매핑 문자열).
 * @returns {string} 번역 요청에 사용할 시스템 프롬프트.
 */
function buildSystemPrompt({ tone, glossary }) {
  const parts = [BASE_RULES.join(" ")];

  parts.push(TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS[DEFAULT_TONE]);

  const pairs = parseGlossary(glossary);
  if (pairs.length > 0) {
    const lines = [
      "Apply the following fixed terminology mapping. " +
        "Whenever a source term (left) appears in a segment, you MUST render it " +
        "exactly as the given Korean term (right), matching surrounding grammar:",
    ];
    for (const [source, target] of pairs) {
      lines.push(`- "${source}" => "${target}"`);
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * 텍스트 세그먼트 배열을 한국어로 번역함.
 *
 * @param {object} params - 번역 요청 파라미터.
 * @param {string} params.apiKey - OpenAI API 키 (Bearer 토큰).
 * @param {string} params.model - 사용할 모델 이름 (예: "gpt-5.4-mini").
 * @param {string[]} params.segments - 번역할 원문 문자열 배열.
 * @param {string} [params.tone] - 번역 말투 키("banmal"|"jondaenmal"). 미지정 시 기본 반말.
 * @param {string} [params.glossary] - 고정 용어집 원문(줄 단위 `원어=번역어` 매핑).
 * @returns {Promise<string[]>} 입력과 동일한 길이/순서의 한국어 번역 배열.
 * @throws {Error} API 응답이 실패하거나(HTTP 오류) 응답 형식이 올바르지 않을 때.
 */
export async function translateSegments({ apiKey, model, segments, tone, glossary }) {
  const body = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt({ tone, glossary }) },
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
