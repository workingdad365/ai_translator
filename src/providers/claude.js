// Claude Messages API 프로바이더. 번역 프롬프트와 응답 정렬은 공통 로직을 사용함.
import {
  attachUsage,
  buildSystemPrompt,
  computeMaxTokens,
  parseTranslationResponse,
} from "./openai-compatible.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
// 추론 옵션을 거부한 모델은 서비스 워커 수명 동안 모델 기본값을 사용함.
const DEFAULT_THINKING_MODELS = new Set();

/** 공통 추론 강도를 Claude의 사고 설정으로 변환함. 최소와 낮음은 low로 매핑함. */
function thinkingOptions(effort) {
  if (effort === "none") return { thinking: { type: "disabled" } };
  if (effort === "minimal" || effort === "low") {
    return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
  }
  return {};
}

/** Retry-After 헤더의 초 또는 HTTP 날짜를 대기 시간(ms)으로 변환함. */
function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** 디버그 활성 시 요청 진단을 출력함. */
function logDebug(debug, message) {
  if (debug) {
    console.debug(`[ai_translator ${new Date().toISOString()}] [Claude/translateSegments] ${message}`);
  }
}

/** Claude API 요청과 본문 읽기 전체에 타임아웃을 적용함. */
async function attemptTranslate({ apiKey, body, segments, timeoutMs, debug }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    let response;
    let raw;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (cause) {
      const timedOut = controller.signal.aborted || cause.name === "AbortError";
      throw Object.assign(new Error(timedOut
        ? `request timed out after ${timeoutMs}ms`
        : `Claude network error: ${cause.message}`), {
        retryable: !timedOut,
        code: timedOut ? "timeout" : null,
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // 비 JSON 오류 응답도 HTTP 상태 기준으로 처리함.
    }
    if (!response.ok) {
      const detail = data?.error?.message || raw.slice(0, 500) || "empty error response";
      throw Object.assign(new Error(`Claude API error (${response.status}): ${detail}`), {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        thinkingUnsupported: response.status === 400 && /thinking|effort|output_config/i.test(detail),
      });
    }
    if (!data) {
      throw Object.assign(new Error("failed to parse Claude API response"), { retryable: true });
    }
    const content = Array.isArray(data.content)
      ? data.content.filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text).join("")
      : "";
    logDebug(debug, `HTTP ${response.status} in ${Date.now() - startedAt}ms, stop_reason=${data.stop_reason}, content length=${content.length}`);
    if (data.stop_reason === "refusal") {
      throw new Error("Claude가 번역 요청을 거부했습니다.");
    }
    return attachUsage(
      parseTranslationResponse(content, segments, { debug, where: "Claude/translateSegments" }),
      data.usage,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claude Messages API로 HTML 세그먼트 배열을 한국어로 번역함.
 * 일시 오류는 최대 두 번 재시도하며, 추론 옵션 미지원 시 모델 기본값으로 폴백함.
 *
 * @param {object} params - 공통 번역 설정(API 키, 모델, 세그먼트, 말투, 용어집, 추론, 타임아웃, 디버그).
 * @returns {Promise<string[]>} 입력과 동일한 순서의 번역 배열과 토큰 사용량.
 */
export async function translateSegments({
  apiKey, model, segments, tone, glossary, reasoningEffort, timeoutMs, debug,
}) {
  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const body = {
    model,
    max_tokens: computeMaxTokens(totalChars),
    system: buildSystemPrompt({ tone, glossary }),
    messages: [{
      role: "user",
      content: JSON.stringify({ segments: Object.fromEntries(
        segments.map((segment, index) => [String(index), segment]),
      ) }),
    }],
    ...(DEFAULT_THINKING_MODELS.has(model) ? {} : thinkingOptions(reasoningEffort)),
  };

  let retries = 0;
  while (true) {
    logDebug(debug, `request -> model=${model}, segments=${segments.length}, chars=${totalChars}, max_tokens=${body.max_tokens}, thinking=${body.thinking?.type || "default"}, timeout=${requestTimeoutMs}ms, attempt=${retries + 1}`);
    try {
      return await attemptTranslate({ apiKey, body, segments, timeoutMs: requestTimeoutMs, debug });
    } catch (error) {
      if (error.thinkingUnsupported && body.thinking) {
        delete body.thinking;
        delete body.output_config;
        DEFAULT_THINKING_MODELS.add(model);
        logDebug(debug, "model rejected thinking options; retrying with model default");
        continue;
      }
      if (!error.retryable || retries >= MAX_RETRIES) throw error;
      const delay = error.retryAfterMs ?? (1000 * 2 ** retries + Math.floor(Math.random() * 250));
      retries++;
      logDebug(debug, `retry ${retries}/${MAX_RETRIES} in ${delay}ms (previous: ${error.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
