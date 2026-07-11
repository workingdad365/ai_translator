// Gemini 프로바이더
// Google Gemini Interactions API를 REST로 직접 호출해 텍스트 세그먼트를 번역함.

import {
  buildSystemPrompt,
  computeMaxTokens,
  parseTranslationResponse,
} from "./openai-compatible.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

// thinking_level을 거부한 모델은 서비스 워커 수명 동안 모델 기본값을 사용함.
const NO_THINKING_LEVEL_MODELS = new Set();

/**
 * 디버그 로그를 출력함.
 *
 * @param {boolean} debug - 디버그 로그 활성 여부.
 * @param {string} message - 영문 로그 메시지.
 * @param {*} [data] - 부가 진단 데이터.
 */
function logDebug(debug, message, data) {
  if (!debug) return;
  const line =
    `[ai_translator ${new Date().toISOString()}] [Gemini/translateSegments] ${message}`;
  if (data !== undefined) console.debug(line, data);
  else console.debug(line);
}

/**
 * 재시도 속성을 포함한 오류를 생성함.
 *
 * @param {string} message - 오류 메시지.
 * @param {object} [options] - 오류 옵션.
 * @param {boolean} [options.retryable] - 일반 재시도 가능 여부.
 * @param {number|null} [options.retryAfterMs] - 서버가 지정한 대기 시간(ms).
 * @returns {Error} 부가 속성이 설정된 오류.
 */
function makeError(message, { retryable = false, retryAfterMs = null } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  error.retryAfterMs = retryAfterMs;
  return error;
}

/**
 * `Retry-After` 값을 밀리초로 변환함.
 *
 * @param {string|null} value - 초 단위 숫자 또는 HTTP 날짜.
 * @returns {number|null} 대기 시간(ms) 또는 null.
 */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * 지수 백오프와 지터를 적용한 재시도 대기 시간을 계산함.
 *
 * @param {number} attempt - 재시도 회차(1부터 시작).
 * @param {number|null} retryAfterMs - 서버 지정 대기 시간.
 * @returns {number} 대기 시간(ms).
 */
function retryDelayMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/**
 * 지정 시간만큼 대기함.
 *
 * @param {number} ms - 대기 시간(ms).
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 오류 응답 본문에서 사람이 읽을 수 있는 메시지를 추출함.
 *
 * @param {string} body - 오류 응답 원문.
 * @returns {string} Google 오류 메시지 또는 원문 일부.
 */
function errorDetail(body) {
  if (!body) return "empty error response";
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

/**
 * 공통 추론 설정을 Gemini `thinking_level`로 변환함.
 *
 * Gemini에는 사고 완전 비활성 값이 없으므로 `none`은 최저 단계인 `minimal`로
 * 매핑한다. `default` 또는 미지정 값은 필드를 보내지 않는다.
 *
 * @param {string|undefined} effort - 공통 추론 강도.
 * @returns {string|null} Gemini thinking_level 또는 null.
 */
function toThinkingLevel(effort) {
  if (!effort || effort === "default") return null;
  if (effort === "none") return "minimal";
  if (effort === "minimal" || effort === "low") return effort;
  return null;
}

/**
 * 배치 키를 모두 필수 문자열로 고정한 Interactions 구조화 출력 스키마를 생성함.
 *
 * @param {number} segmentCount - 입력 세그먼트 수.
 * @returns {object} Interactions API의 response_format 객체.
 */
function buildResponseFormat(segmentCount) {
  const keys = Array.from({ length: segmentCount }, (_, index) => String(index));
  const properties = Object.fromEntries(
    keys.map((key) => [key, { type: "string", description: `Translated HTML segment ${key}` }]),
  );

  return {
    type: "text",
    mime_type: "application/json",
    schema: {
      type: "object",
      properties: {
        translations: {
          type: "object",
          properties,
          required: keys,
          additionalProperties: false,
        },
      },
      required: ["translations"],
      additionalProperties: false,
    },
  };
}

/**
 * Interactions 응답의 마지막 model_output 단계에서 텍스트를 추출함.
 *
 * @param {*} data - Interaction 리소스 응답.
 * @returns {string} 연속된 텍스트 블록을 결합한 문자열 또는 빈 문자열.
 */
function extractOutputText(data) {
  const modelOutputs = Array.isArray(data?.steps)
    ? data.steps.filter((step) => step?.type === "model_output")
    : [];
  const output = modelOutputs.at(-1);
  if (!Array.isArray(output?.content)) return "";

  return output.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * Gemini Interactions API를 한 번 호출함.
 *
 * @param {object} context - 요청 컨텍스트.
 * @returns {Promise<string[]>} 번역 배열.
 * @throws {Error} HTTP, 네트워크, 타임아웃 또는 응답 파싱 오류.
 */
async function attemptTranslate({
  apiKey,
  model,
  segments,
  systemInstruction,
  maxOutputTokens,
  thinkingLevel,
  timeoutMs,
  debug,
}) {
  const segmentsObject = Object.fromEntries(
    segments.map((segment, index) => [String(index), segment]),
  );
  const generationConfig = {
    max_output_tokens: maxOutputTokens,
    ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
  };
  const body = {
    model,
    input: JSON.stringify({ segments: segmentsObject }),
    system_instruction: systemInstruction,
    generation_config: generationConfig,
    response_format: buildResponseFormat(segments.length),
    store: false,
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": API_REVISION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error.name === "AbortError";
    const message = timedOut
      ? `request timed out after ${timeoutMs}ms`
      : `network error: ${error.message}`;
    logDebug(debug, `${message} (elapsed ${Date.now() - startedAt}ms)`);
    throw makeError(message, { retryable: !timedOut });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let rawBody = "";
    try {
      rawBody = await response.text();
    } catch {
      // 본문을 읽지 못해도 상태 코드로 오류를 전달함.
    }
    const detail = errorDetail(rawBody);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    logDebug(debug, `HTTP ${response.status} in ${Date.now() - startedAt}ms`, {
      retryAfter: response.headers.get("retry-after"),
      body: detail,
    });

    const error = makeError(`Gemini API error (${response.status}): ${detail}`, {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs,
    });
    if (
      response.status === 400 &&
      /thinking[_\s-]?level/i.test(`${detail} ${rawBody}`)
    ) {
      error.thinkingLevelUnsupported = true;
    }
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw makeError(`failed to parse Gemini API response: ${error.message}`, {
      retryable: true,
    });
  }

  const content = extractOutputText(data);
  logDebug(
    debug,
    `HTTP 200 in ${Date.now() - startedAt}ms, status=${data?.status || "unknown"}, content length=${content.length}`,
    {
      model: data?.model,
      totalTokens: data?.usage?.total_tokens,
      outputTokens: data?.usage?.total_output_tokens,
      thoughtTokens: data?.usage?.total_thought_tokens,
    },
  );

  return parseTranslationResponse(content, segments, {
    debug,
    where: "Gemini/translateSegments",
  });
}

/**
 * Gemini Interactions API로 HTML 세그먼트 배열을 한국어로 번역함.
 *
 * 요청은 상태 비저장(`store:false`)으로 실행하며, 입력 키를 고정한 JSON Schema로
 * 구조화된 출력을 강제한다. 네트워크 오류, 429, 5xx, 빈 응답은 지수 백오프로 최대
 * 두 번 재시도하고 타임아웃과 영구 오류는 즉시 실패한다.
 *
 * @param {object} params - 번역 요청 파라미터.
 * @param {string} params.apiKey - Google AI Studio Gemini API 키.
 * @param {string} params.model - Interactions API 모델명.
 * @param {string[]} params.segments - 번역할 HTML 세그먼트 배열.
 * @param {string} [params.tone] - 말투 키.
 * @param {string} [params.glossary] - 고정 용어집 원문.
 * @param {string} [params.reasoningEffort] - 공통 추론 강도.
 * @param {number} [params.timeoutMs] - 요청 타임아웃(ms).
 * @param {boolean} [params.debug] - 디버그 로그 활성 여부.
 * @returns {Promise<string[]>} 입력과 동일한 길이·순서의 번역 배열.
 */
export async function translateSegments({
  apiKey,
  model,
  segments,
  tone,
  glossary,
  reasoningEffort,
  timeoutMs,
  debug,
}) {
  const requestTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const maxOutputTokens = computeMaxTokens(totalChars);
  const systemInstruction = buildSystemPrompt({ tone, glossary });
  let thinkingLevel = NO_THINKING_LEVEL_MODELS.has(model)
    ? null
    : toThinkingLevel(reasoningEffort);
  let thinkingFallbackDone = false;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs(attempt, lastError?.retryAfterMs);
      logDebug(
        debug,
        `retry ${attempt}/${MAX_RETRIES} in ${delay}ms (previous: ${lastError?.message})`,
      );
      await sleep(delay);
    }

    logDebug(
      debug,
      `request -> model=${model}, segments=${segments.length}, chars=${totalChars}, max_output_tokens=${maxOutputTokens}, thinking_level=${thinkingLevel || "default"}, timeout=${requestTimeoutMs}ms, attempt=${attempt + 1}/${MAX_RETRIES + 1}`,
    );

    try {
      return await attemptTranslate({
        apiKey,
        model,
        segments,
        systemInstruction,
        maxOutputTokens,
        thinkingLevel,
        timeoutMs: requestTimeoutMs,
        debug,
      });
    } catch (error) {
      lastError = error;

      if (error.thinkingLevelUnsupported && thinkingLevel && !thinkingFallbackDone) {
        thinkingFallbackDone = true;
        thinkingLevel = null;
        NO_THINKING_LEVEL_MODELS.add(model);
        logDebug(debug, "model rejected thinking_level; retrying with model default");
        attempt--;
        continue;
      }

      if (!error.retryable || attempt === MAX_RETRIES) {
        throw new Error(error.message);
      }
    }
  }

  throw new Error(lastError?.message || "Gemini translation failed");
}