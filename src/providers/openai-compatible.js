// OpenAI 호환 Chat Completions 공통 번역 로직
// OpenAI 와 OpenRouter 는 요청/응답 스키마가 사실상 동일하므로(엔드포인트 URL 과
// 일부 헤더만 다름), 이 모듈이 실제 번역 로직을 담당하고 각 프로바이더 파일은
// 엔드포인트/추가 헤더만 지정하는 얇은 래퍼로 구성함.

// 번역 지시용 시스템 프롬프트의 공통 기본 규칙.
// 각 세그먼트는 블록 요소(p, li, h1~h6 등)의 innerHTML 조각이며, 문장 중간에
// <a>/<em>/<strong> 등 인라인 태그가 섞여 있을 수 있음. 텍스트만 한국어로
// 번역하고 태그/속성은 그대로 보존하되, 한국어 어순에 맞게 태그 위치를 옮기도록
// 지시함. 이렇게 해야 인라인 태그로 쪼개진 한 문장이 조각나지 않고 자연스럽게 번역됨.
// 세그먼트를 배열이 아닌 "인덱스 키" 객체로 주고받아, 모델이 세그먼트를 병합/분할/
// 누락해도 키 기준으로 원문과 정렬을 유지할 수 있게 함(개수 어긋남으로 인한 배치
// 전체 폐기 방지).
const BASE_RULES = [
  "You are a professional translator specializing in web page content.",
  "Each segment is an HTML fragment (the inner HTML of a single block element). " +
    "It may be plain text, or it may contain inline tags such as <a>, <em>, <strong>, <span>, <code>, <sup>, <br>.",
  "Translate the human-readable text into natural, fluent Korean, treating the WHOLE fragment as one continuous sentence/paragraph. " +
    "Do NOT translate each tag's text in isolation — read across the tags so the result reads naturally.",
  "Preserve every HTML tag and ALL of its attributes (href, class, id, data-*, etc.) EXACTLY as given. " +
    "Never translate, rename, reorder, or drop attributes or their values (especially URLs).",
  "Korean word order differs from English, so you MUST move each inline tag to wrap the Korean words that correspond to the " +
    "SAME content it originally wrapped. Example: `Meta has <a href=\"x\">deactivated</a> the tool` -> " +
    "`메타는 그 도구를 <a href=\"x\">비활성화</a>했다`. Keep the tag balanced (matching open/close) and around the translated equivalent.",
  "Do NOT translate or alter the text inside <code> elements, and leave numbers, URLs, and untranslatable proper nouns unchanged.",
  "Do NOT add any tags, wrappers, code fences, or attributes that were not in the input.",
  'The input is a JSON object of the form {"segments": {"0": "...", "1": "...", ...}} whose keys are string indices.',
  'Return ONLY a JSON object of the form {"translations": {"0": "...", "1": "...", ...}}.',
  "The translations object MUST use EXACTLY the same set of keys as the input segments — one translated HTML fragment per key.",
  "NEVER merge multiple segments into one, split one segment into several, drop a key, add new keys, or leave a value empty.",
  "If a segment is already Korean or should not be translated (e.g. only code or a bare number), return it unchanged under its key.",
  "Do not add any explanation or extra keys.",
];

// 말투(문체) 지침. 페이지 전체가 여러 배치로 나뉘어 번역되므로, 모든 배치에
// 동일한 말투 지침을 적용해야 존댓말/반말이 섞이지 않고 일관성이 유지됨.
const TONE_INSTRUCTIONS = {
  // 반말(해라체): 친구에게 말하는 구어체가 아니라, 한국 신문·통신사 기사에서 쓰는
  // 객관적 문어체 평서형(해라체). 구어체 종결어미(~야, ~해)와 속어를 금지하고,
  // 2인칭 'you'는 반말 호칭(너/네) 대신 '당신' 또는 무주어로 처리하도록 지시함.
  banmal:
    "Write ALL translations in the style of a Korean NEWS ARTICLE — the objective, formal written " +
    "declarative style (문어체 해라체) used by newspapers and news agencies. This is NOT casual speech. " +
    "Use written declarative endings such as ~다, ~이다, ~였다, ~했다, ~한다, ~라고 밝혔다, ~것으로 알려졌다. " +
    "NEVER use colloquial/conversational endings or particles such as ~야, ~해, ~거야, ~네, ~지, ~잖아, " +
    "and NEVER use slang or a chatty, talking-to-a-friend tone. " +
    "Never use polite/formal-speech endings (존댓말) such as ~습니다, ~합니다, ~에요, ~예요, ~이에요, ~세요. " +
    "For the English second person ('you', 'your', 'yourself'), do NOT use 너/네/니; render it as '당신'/'당신의', " +
    "or omit the subject/possessive entirely when that reads more naturally, as Korean news writing commonly does. " +
    "Keep the tone objective and consistent across every segment.",
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

/**
 * 디버그 로그를 출력함. debug 플래그가 켜져 있을 때만 콘솔에 남김.
 * 형식: `[ai_translator <ISO타임스탬프>] [<위치>] <메시지>`.
 *
 * @param {boolean} debug - 디버그 로그 활성 여부.
 * @param {string} location - 로그 발생 위치(파일/함수).
 * @param {string} message - 로그 메시지(영문).
 * @param {*} [data] - 함께 출력할 부가 데이터(선택).
 */
function logDebug(debug, location, message, data) {
  if (!debug) return;
  const line = `[ai_translator ${new Date().toISOString()}] [${location}] ${message}`;
  if (data !== undefined) console.debug(line, data);
  else console.debug(line);
}

// 배치당 요청 타임아웃 기본값(ms). 설정에서 조정 가능하며(초 단위), 미지정 시 이 값을 씀.
// 느린 모델(예: OpenRouter 가 느린 공급자로 라우팅)이 keep-alive 패딩만 흘리며 오래
// 걸릴 때, 무한정 매달리지 않도록 상한을 둠.
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
// 최초 시도 외 추가 재시도 횟수. 일시적 오류(타임아웃/429/5xx/빈 응답)에만 적용함.
const MAX_RETRIES = 2;
// 지수 백오프 기본 지연(ms). 실제 지연 = BASE * 2^(재시도-1) + 지터.
const RETRY_BASE_DELAY_MS = 1000;

// max_completion_tokens 자동 산정 파라미터.
// 이 값에는 (GPT-5 계열의) 추론 토큰까지 포함되므로, 잘림을 막기 위해 넉넉히 잡음.
// 목적은 상한을 "충분히 높게" 보장하는 것(일부 프로바이더의 낮은 기본 상한으로 인한
// 잘림 방지)이지, 출력을 조이는 것이 아님.
const OUTPUT_TOKENS_PER_CHAR = 1.3; // 입력 문자당 예상 출력 토큰(한국어, 보수적)
const MAX_TOKENS_BUFFER = 3000; // 추론/안전 여유분
const MAX_TOKENS_FLOOR = 2000; // 하한(작은 배치도 추론 여유 확보)
const MAX_TOKENS_CEILING = 16000; // 상한(비용/모델 한계 방어)

/**
 * 배치의 총 입력 문자 수로부터 max_completion_tokens 값을 산정함.
 * 추론 토큰까지 포함하는 상한이므로 여유분을 더해 잘림을 방지함.
 *
 * @param {number} totalChars - 배치 내 모든 세그먼트의 문자 수 합.
 * @returns {number} 산정된 max_completion_tokens 값(정수, FLOOR~CEILING 범위).
 */
function computeMaxTokens(totalChars) {
  const estimated = Math.ceil(totalChars * OUTPUT_TOKENS_PER_CHAR) + MAX_TOKENS_BUFFER;
  return Math.min(MAX_TOKENS_CEILING, Math.max(MAX_TOKENS_FLOOR, estimated));
}

// response_format=json_object 를 미지원(400)하는 것으로 확인된 모델 키(`endpoint|model`)
// 캐시. 한 번 확인되면 이후 배치는 처음부터 해당 필드를 생략해 불필요한 400 을 피함.
// 서비스 워커가 재시작되면 비워지고 다시 학습함.
const NO_JSON_OBJECT_MODELS = new Set();

/**
 * 지정 시간만큼 대기함.
 *
 * @param {number} ms - 대기 시간(ms).
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 모델이 거부한 추론 값을 대체할, 확인된 추론 강도(effort|null) 캐시. key=`endpoint|model`.
// null 은 "추론 파라미터를 아예 보내지 않음"을 의미함. 서비스 워커 재시작 시 초기화됨.
const REASONING_EFFORT_OVERRIDE = new Map();

// 추론 강도 우선순위(추론이 적은 순). 폴백 시 이 순서로 지원되는 값을 고름.
const REASONING_PREFERENCE = ["none", "minimal", "low", "medium", "high", "xhigh"];

/**
 * HTTP 400 응답 본문이 response_format(json_object) 미지원 오류인지 판별함.
 * 프로바이더마다 문구가 달라 핵심 키워드로 느슨하게 매칭함.
 *
 * @param {number} status - HTTP 상태 코드.
 * @param {string} detail - 응답 본문 텍스트.
 * @returns {boolean} response_format 미지원 오류로 보이면 true.
 */
function isUnsupportedResponseFormat(status, detail) {
  if (status !== 400 || !detail) return false;
  return /response.?format|json[_\s]?object/i.test(detail);
}

/**
 * HTTP 400 응답 본문이 reasoning(추론 강도) 값 미지원 오류인지 판별함.
 *
 * @param {number} status - HTTP 상태 코드.
 * @param {string} detail - 응답 본문 텍스트.
 * @returns {boolean} 추론 값 미지원 오류로 보이면 true.
 */
function isUnsupportedReasoning(status, detail) {
  if (status !== 400 || !detail) return false;
  return /reasoning/i.test(detail) && /unsupported|not support|invalid/i.test(detail);
}

/**
 * 오류 메시지의 "Supported values are: 'none', 'low', ..." 문구에서 지원 값 목록을 파싱함.
 *
 * @param {string} detail - 응답 본문 텍스트.
 * @returns {string[]} 지원되는 추론 값 소문자 배열(파싱 불가 시 빈 배열).
 */
function parseSupportedReasoning(detail) {
  if (!detail) return [];
  const m = detail.match(/supported values? are[:\s]*([^.]*)/i);
  const scope = m ? m[1] : "";
  const quoted = scope.match(/'([a-z]+)'/gi) || [];
  return quoted.map((v) => v.replace(/'/g, "").toLowerCase());
}

/**
 * 거부된 추론 값을 대체할 폴백 값을 고름. 지원 목록이 있으면 그 안에서 추론이 가장
 * 적은 값을, 없으면 null(추론 파라미터 생략)을 반환함.
 *
 * @param {string[]} supported - 지원되는 추론 값 목록.
 * @param {string|null} rejected - 방금 거부된 값.
 * @returns {string|null} 폴백 추론 값 또는 null(파라미터 생략).
 */
function pickFallbackEffort(supported, rejected) {
  if (supported && supported.length > 0) {
    for (const v of REASONING_PREFERENCE) {
      if (v !== rejected && supported.includes(v)) return v;
    }
  }
  return null;
}

/**
 * 재시도 가능 여부 플래그를 담은 Error 를 생성함.
 *
 * @param {string} message - 오류 메시지.
 * @param {object} [opts] - 옵션.
 * @param {boolean} [opts.retryable] - 일시적 오류로 재시도 가능하면 true.
 * @param {number|null} [opts.retryAfterMs] - 서버가 지정한 재시도 대기(ms), 없으면 null.
 * @returns {Error} retryable/retryAfterMs 속성이 부착된 Error.
 */
function makeError(message, { retryable = false, retryAfterMs = null } = {}) {
  const err = new Error(message);
  err.retryable = retryable;
  err.retryAfterMs = retryAfterMs;
  return err;
}

/**
 * HTTP `Retry-After` 헤더를 ms 로 파싱함. 초 단위 정수 또는 HTTP 날짜를 지원함.
 *
 * @param {string|null} value - Retry-After 헤더 값.
 * @returns {number|null} 대기 시간(ms) 또는 파싱 불가 시 null.
 */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * 재시도 대기 시간을 계산함. 서버가 Retry-After 를 준 경우 이를 우선 사용하고,
 * 아니면 지수 백오프에 지터를 더함.
 *
 * @param {number} attempt - 재시도 회차(1부터 시작).
 * @param {number|null} retryAfterMs - 서버 지정 대기(ms) 또는 null.
 * @returns {number} 대기 시간(ms).
 */
function retryDelayMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

/**
 * 파싱된 응답에서 인덱스→번역 맵을 유연하게 추출함. 소형 모델이 지시한 래퍼
 * 스키마를 매번 지키지 않으므로(래퍼 생략·배열 반환 등) 여러 변형을 허용함.
 *
 * 허용 형태:
 *   {"translations": {"0": "..."}}   (표준: 래퍼 + 인덱스 객체)
 *   {"translations": ["...", ...]}    (래퍼 + 배열)
 *   {"0": "...", "1": "..."}           (래퍼 없는 인덱스 객체)
 *   ["...", ...]                        (래퍼 없는 배열)
 *
 * @param {*} parsed - JSON.parse 결과.
 * @returns {object|Array|null} 인덱스(`map[i]`)로 접근 가능한 맵, 없으면 null.
 */
function resolveTranslationMap(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;

  const t = parsed.translations;
  if (Array.isArray(t)) return t;
  if (t && typeof t === "object") return t;

  // 래퍼 없이 인덱스 키 객체를 직접 반환한 경우(모든 키가 숫자 문자열).
  const keys = Object.keys(parsed);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) return parsed;

  return null;
}

/**
 * 단일 시도로 번역 요청을 수행함(타임아웃 포함). 실패 시 makeError 로 재시도
 * 가능 여부를 표시하여 던짐.
 *
 * @param {object} ctx - 시도 컨텍스트.
 * @param {string} ctx.endpoint - 엔드포인트 URL.
 * @param {Record<string,string>} ctx.headers - 요청 헤더.
 * @param {string} ctx.bodyStr - 직렬화된 요청 본문.
 * @param {string} ctx.label - 프로바이더 이름.
 * @param {boolean} ctx.debug - 디버그 로그 여부.
 * @param {string} ctx.where - 로그 위치 문자열.
 * @param {string[]} ctx.segments - 입력 세그먼트 배열(누락분 원문 대체 및 정렬에 사용).
 * @param {number} ctx.timeoutMs - 요청 타임아웃(ms).
 * @returns {Promise<string[]>} 입력과 동일한 길이/순서의 번역 배열(누락분은 원문 유지).
 * @throws {Error} makeError 로 생성된, retryable 플래그가 부착된 오류.
 */
async function attemptTranslate({ endpoint, headers, bodyStr, label, debug, where, segments, timeoutMs }) {
  const segmentsLen = segments.length;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError = 타임아웃, 그 외 = 네트워크 오류.
    // 타임아웃(설정 시간 내 무응답)은 그 모델이 이 작업을 감당 못 하는 것으로 보고 재시도
    // 없이 즉시 실패시킴. 네트워크 오류는 일시적일 수 있어 재시도함.
    const timedOut = err.name === "AbortError";
    const message = timedOut
      ? `request timed out after ${timeoutMs}ms`
      : `network error: ${err.message}`;
    logDebug(debug, where, `${message} (elapsed ${Date.now() - startedAt}ms)`);
    throw makeError(message, { retryable: !timedOut });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    // 레이트리밋 진단을 위해 관련 헤더를 함께 로깅함(OpenRouter/OpenAI 공통).
    logDebug(debug, where, `HTTP ${res.status} in ${Date.now() - startedAt}ms`, {
      retryAfter: res.headers.get("retry-after"),
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
      body: detail.slice(0, 500),
    });

    // response_format(json_object) 미지원 400 은 상위 루프에서 필드를 빼고 재시도하도록
    // 별도 플래그로 표시함.
    if (isUnsupportedResponseFormat(res.status, detail)) {
      const err = makeError(`${label} API error (${res.status}): ${detail.slice(0, 300)}`, {
        retryable: false,
      });
      err.responseFormatUnsupported = true;
      throw err;
    }

    // 추론 값 미지원 400 은 상위 루프에서 지원되는 값으로 낮춰 재시도하도록 표시함.
    if (isUnsupportedReasoning(res.status, detail)) {
      const err = makeError(`${label} API error (${res.status}): ${detail.slice(0, 300)}`, {
        retryable: false,
      });
      err.reasoningUnsupported = true;
      err.supportedReasoning = parseSupportedReasoning(detail);
      throw err;
    }

    // 429(레이트리밋)와 5xx(서버 오류)만 일시적 오류로 재시도함.
    // 400/401/403 등은 영구 오류이므로 즉시 실패시킴.
    const retryable = res.status === 429 || res.status >= 500;
    throw makeError(`${label} API error (${res.status}): ${detail.slice(0, 300)}`, {
      retryable,
      retryAfterMs,
    });
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  // OpenRouter 는 라우팅한 상위 모델/공급자를 응답에 담을 수 있어 진단에 유용함.
  logDebug(debug, where, `HTTP 200 in ${Date.now() - startedAt}ms, content length=${content.length}`, {
    routedModel: data?.model,
    provider: data?.provider,
    finishReason: data?.choices?.[0]?.finish_reason,
  });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 모델이 JSON 을 지키지 않은 경우를 진단할 수 있도록 응답 원문 일부를 오류에 포함함.
    // 빈 응답은 라우팅 실패/타임아웃 등 일시적 원인일 수 있어 재시도하고,
    // 비어 있지 않은 평문은 모델이 JSON 형식을 미지원하는 것이므로 재시도하지 않음.
    const snippet = content ? content.slice(0, 200) : "(empty content)";
    throw makeError(`failed to parse model response as JSON: ${snippet}`, {
      retryable: !content,
    });
  }

  const map = resolveTranslationMap(parsed);
  if (!map) {
    throw makeError(
      `response has no usable translations (top-level keys: ${Object.keys(parsed || {}).join(", ") || "none"})`,
      { retryable: false },
    );
  }

  // 인덱스 키 기준으로 원문 순서에 맞춰 재구성함. 배열/객체 응답 모두 map[i] 로 접근 가능.
  // 누락되었거나 비어 있는(공백뿐인) 값은 병합/누락 아티팩트로 보고 원문을 유지함.
  let fallbackCount = 0;
  const result = new Array(segmentsLen);
  for (let i = 0; i < segmentsLen; i++) {
    const t = map[i];
    if (typeof t === "string" && t.trim() !== "") {
      result[i] = t;
    } else {
      result[i] = segments[i];
      fallbackCount++;
    }
  }

  if (fallbackCount > 0) {
    // 일부가 누락돼도 배치 전체를 버리지 않고, 번역된 부분은 반영함.
    logDebug(
      debug,
      where,
      `filled ${fallbackCount}/${segmentsLen} segments with original text (missing/empty translation)`,
    );
  }

  return result;
}

/**
 * OpenAI 호환 Chat Completions 엔드포인트에 대한 translateSegments 함수를 생성함.
 *
 * @param {object} config - 프로바이더별 설정.
 * @param {string} config.endpoint - Chat Completions 엔드포인트 전체 URL.
 * @param {string} config.label - 오류 메시지에 표기할 프로바이더 이름(예: "OpenAI").
 * @param {Record<string, string>} [config.extraHeaders] - 프로바이더 고유 추가 헤더.
 * @param {string} [config.tokenParam] - 출력 토큰 상한 파라미터 이름. 기본값은
 *   `max_completion_tokens`(OpenAI GPT-5 계열 및 OpenRouter 모두 지원하는 현행 이름).
 *   구형 `max_tokens`만 받는 프로바이더를 추가할 때만 재정의함.
 * @param {((effort: string) => object)|null} [config.reasoningParam] - 추론 강도를
 *   요청 본문 필드로 변환하는 함수. 프로바이더마다 형식이 달라 주입식으로 받음
 *   (OpenAI: `{reasoning_effort}`, OpenRouter: `{reasoning:{effort,exclude}}`).
 *   null 이면 추론 제어 파라미터를 보내지 않음.
 * @returns {(params: {apiKey: string, model: string, segments: string[], tone?: string, glossary?: string, reasoningEffort?: string, debug?: boolean}) => Promise<string[]>}
 *   입력과 동일한 길이/순서의 한국어 번역 배열을 반환하는 translateSegments 함수.
 */
export function createTranslator({
  endpoint,
  label,
  extraHeaders = {},
  tokenParam = "max_completion_tokens",
  reasoningParam = null,
}) {
  /**
   * 텍스트 세그먼트 배열을 한국어로 번역함.
   *
   * @param {object} params - 번역 요청 파라미터.
   * @param {string} params.apiKey - API 키 (Bearer 토큰).
   * @param {string} params.model - 사용할 모델 이름.
   * @param {string[]} params.segments - 번역할 원문 문자열 배열.
   * @param {string} [params.tone] - 번역 말투 키("banmal"|"jondaenmal"). 미지정 시 기본 반말.
   * @param {string} [params.glossary] - 고정 용어집 원문(줄 단위 `원어=번역어` 매핑).
   * @param {boolean} [params.debug] - 디버그 로그 출력 여부.
   * @returns {Promise<string[]>} 입력과 동일한 길이/순서의 한국어 번역 배열.
   * @throws {Error} API 응답이 실패하거나(HTTP 오류) 응답 형식이 올바르지 않을 때.
   *   오류 메시지에는 진단을 위해 상태 코드/응답 원문 일부를 포함함.
   */
  return async function translateSegments({
    apiKey,
    model,
    segments,
    tone,
    glossary,
    reasoningEffort,
    timeoutMs,
    debug,
  }) {
    const where = `${label}/translateSegments`;
    const totalChars = segments.reduce((n, s) => n + s.length, 0);
    const requestTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;

    // 프롬프트/헤더/본문은 재시도 간 동일하므로 루프 밖에서 한 번만 구성함.
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    };
    // 배치 크기에 비례해 출력 토큰 상한을 산정함(추론 토큰 포함 함정 대비 여유분 포함).
    // GPT-5 계열은 max_tokens 를 거부하고 max_completion_tokens 를 요구하며,
    // OpenRouter 도 이 이름을 지원하므로 프로바이더 공통으로 tokenParam 을 사용함.
    const maxTokens = computeMaxTokens(totalChars);
    // 세그먼트를 인덱스 키 객체로 전송(배열 대신). 응답도 같은 키로 받아 정렬을 보존함.
    const segmentsObj = {};
    segments.forEach((seg, i) => {
      segmentsObj[i] = seg;
    });
    // 요청 본문을 구성함.
    // - useResponseFormat=false 이면 response_format 을 생략함(json_object 미지원 모델 대비).
    //   프롬프트가 이미 JSON 을 강하게 지시하므로 강제 필드가 없어도 대개 유효한 JSON 을 반환함.
    // - effort=null 이면 추론 제어 파라미터를 보내지 않음(모델 기본값). 번역은 추론이
    //   거의 불필요하므로 보통 none/minimal 을 씀.
    const buildBody = (useResponseFormat, effort) => {
      const reasoningExtra =
        effort && typeof reasoningParam === "function" ? reasoningParam(effort) : null;
      return JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemPrompt({ tone, glossary }) },
          { role: "user", content: JSON.stringify({ segments: segmentsObj }) },
        ],
        ...(useResponseFormat ? { response_format: { type: "json_object" } } : {}),
        [tokenParam]: maxTokens,
        ...(reasoningExtra || {}),
      });
    };

    const modelKey = `${endpoint}|${model}`;
    // 이미 json_object 미지원으로 확인된 모델이면 처음부터 필드를 생략함.
    let useResponseFormat = !NO_JSON_OBJECT_MODELS.has(modelKey);
    // 요청 추론 값. "default"/미지정이면 null. 이미 폴백이 확인된 모델이면 그 값을 씀.
    let currentEffort =
      reasoningEffort && reasoningEffort !== "default" ? reasoningEffort : null;
    if (REASONING_EFFORT_OVERRIDE.has(modelKey)) {
      currentEffort = REASONING_EFFORT_OVERRIDE.get(modelKey);
    }
    let reasoningFallbackDone = false;

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = retryDelayMs(attempt, lastError?.retryAfterMs);
        logDebug(
          debug,
          where,
          `retry ${attempt}/${MAX_RETRIES} in ${delay}ms (previous: ${lastError?.message})`,
        );
        await sleep(delay);
      }

      logDebug(
        debug,
        where,
        `request -> model=${model}, segments=${segments.length}, chars=${totalChars}, ${tokenParam}=${maxTokens}, reasoning=${currentEffort || "none-sent"}, response_format=${useResponseFormat ? "json_object" : "none"}, timeout=${requestTimeoutMs}ms, attempt=${attempt + 1}/${MAX_RETRIES + 1}`,
      );

      try {
        return await attemptTranslate({
          endpoint,
          headers,
          bodyStr: buildBody(useResponseFormat, currentEffort),
          label,
          debug,
          where,
          segments,
          timeoutMs: requestTimeoutMs,
        });
      } catch (err) {
        lastError = err;

        // response_format=json_object 미지원(400) → 해당 필드를 빼고 재시도함.
        // 이 폴백은 정상 재시도 횟수를 소진하지 않으며, 모델을 캐시해 이후 배치는
        // 처음부터 필드를 생략하도록 함.
        if (err.responseFormatUnsupported && useResponseFormat) {
          useResponseFormat = false;
          NO_JSON_OBJECT_MODELS.add(modelKey);
          logDebug(
            debug,
            where,
            "provider rejected response_format=json_object; retrying without it",
          );
          attempt--; // 폴백은 재시도 횟수에서 제외
          continue;
        }

        // 추론 값 미지원(400) → 지원 목록에서 가장 낮은 값으로 낮춰(또는 생략) 재시도함.
        // 마찬가지로 재시도 횟수를 소진하지 않고, 확인된 값을 모델별로 캐시함.
        if (err.reasoningUnsupported && !reasoningFallbackDone) {
          reasoningFallbackDone = true;
          const next = pickFallbackEffort(err.supportedReasoning, currentEffort);
          logDebug(
            debug,
            where,
            `provider rejected reasoning='${currentEffort}'; falling back to '${next || "none-sent"}'`,
          );
          currentEffort = next;
          REASONING_EFFORT_OVERRIDE.set(modelKey, next);
          attempt--; // 폴백은 재시도 횟수에서 제외
          continue;
        }

        // 영구 오류이거나 재시도 소진 시 즉시 실패. 내부 플래그를 뗀 순수 Error 로 재던짐.
        if (!err.retryable || attempt === MAX_RETRIES) {
          throw new Error(err.message);
        }
      }
    }

    // 루프 구조상 도달하지 않지만, 방어적으로 마지막 오류를 던짐.
    throw new Error(lastError?.message || "translation failed");
  };
}
