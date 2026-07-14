// 콘텐츠 스크립트
// 팝업의 "번역 시작" 신호를 받아 현재 페이지의 텍스트를 한국어로 치환함.
// - 번역 단위는 "leaf 블록 요소"(p, li, h1~h6 등 블록 자식이 없는 블록)이며,
//   해당 요소의 innerHTML 을 번역함. SVG/수식/코드 블록 같은 제외 하위 트리는
//   플레이스홀더로 축약했다가 응답 적용 시 원본 DOM 으로 복원함. 문장 중간에
//   <a>/<em> 같은 인라인 태그가 섞여도 블록 단위 문맥으로 번역함.
// - 뷰포트에 들어오는 블록만 순차적으로 번역함(IntersectionObserver).
// - 스크롤로 새 영역이 나타나거나 DOM 이 동적으로 추가되면 자동으로 이어서 번역함.
// 동일 페이지에 스크립트가 중복 주입되어도 한 번만 초기화되도록 IIFE + 전역 플래그로 보호함.

(() => {
  if (window.__aiTranslatorLoaded) return;
  window.__aiTranslatorLoaded = true;

  // 번역 대상에서 제외할 태그. 이 태그 자체 또는 그 내부 텍스트는 번역하지 않음.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE",
    "KBD", "SAMP", "SVG", "MATH", "INPUT", "SELECT", "OPTION",
  ]);
  const PROTECTED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "PRE", "SVG", "MATH",
    "INPUT", "SELECT", "OPTION",
  ]);
  const PROTECTED_SELECTOR = [...PROTECTED_TAGS].map((tag) => tag.toLowerCase()).join(",");
  const PROTECTED_ATTR = "data-ai-translator-protected";
  let protectedBlockSequence = 0;

  /**
   * 실제 CSS 배치를 보고 인라인 요소인지 판별함.
   * Reddit 등의 커스텀 요소도 display:inline이면 문장 일부로 취급하고,
   * span 등 기본 인라인 태그도 display:block/flex/grid이면 독립 블록으로 취급함.
   *
   * @param {Element} el - 검사할 요소.
   * @returns {boolean} 문장 안에서 부모 블록과 함께 번역할 인라인 요소이면 true.
   */
  function isInlineElement(el) {
    const display = getComputedStyle(el).display;
    return (
      display === "none" ||
      display === "contents" ||
      display.startsWith("inline") ||
      display.startsWith("ruby")
    );
  }

  // 모델 응답 HTML 을 삽입하기 전에 제거할 위험 태그. 프롬프트가 새 태그 추가를
  // 금지하지만, 방어적으로 스크립트성/외부 로드성 요소를 걷어냄(XSS 방지).
  const DANGEROUS_TAGS = "script,style,iframe,object,embed,link,meta,base,form";

  // 한 번의 API 호출에 담을 최대 세그먼트(블록) 수 / 최대 문자 수(둘 다 설정으로 조정 가능).
  // 배치는 두 상한 중 먼저 도달하는 쪽에서 끊김. 문자 수는 블록 innerHTML 길이 기준.
  // 느린 모델은 배치를 작게 하면 배치당 응답이 빨라져 타임아웃 위험이 줄어듦.
  const DEFAULT_BATCH_SIZE = 40;
  const DEFAULT_MAX_CHARS = 3000;
  let maxSegmentsPerBatch = DEFAULT_BATCH_SIZE;
  let maxCharsPerBatch = DEFAULT_MAX_CHARS;

  // 스캔/플러시 디바운스 지연(ms).
  const DEBOUNCE_MS = 250;

  const translatedBlocks = new WeakSet(); // 번역 완료된 블록 요소
  const queuedBlocks = new WeakSet(); // 큐에 이미 담긴 블록 요소(중복 방지)
  let observedEls = new WeakSet(); // IntersectionObserver 로 관찰 중인 블록(세션 중지 시 교체)

  const pendingBlocks = new Set(); // 뷰포트 진입 후 번역 대기 중인 블록 요소

  let active = false; // 번역 세션 활성 여부
  let flushing = false; // 플러시 진행 중 여부(동시 실행 방지)
  let io = null; // IntersectionObserver
  let mo = null; // MutationObserver
  let scanTimer = null;
  let flushTimer = null;

  /**
   * 배치 크기 후보값을 검증해 유효하면 적용함(1~100 범위의 정수).
   *
   * @param {*} value - 저장소에서 읽은 batchSize 값.
   */
  function applyBatchSize(value) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 100) maxSegmentsPerBatch = n;
  }

  /**
   * 문자 수 캡 후보값을 검증해 유효하면 적용함(500~20000 범위의 정수).
   *
   * @param {*} value - 저장소에서 읽은 maxChars 값.
   */
  function applyMaxChars(value) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 500 && n <= 20000) maxCharsPerBatch = n;
  }

  // 디버그 로그 / 배치 크기 / 문자 수 캡. 저장소에서 읽고, 팝업에서 변경되면 실시간 반영함.
  let debug = false;
  chrome.storage.local.get(["debug", "batchSize", "maxChars"]).then(
    ({ debug: d, batchSize, maxChars }) => {
      debug = Boolean(d);
      applyBatchSize(batchSize);
      applyMaxChars(maxChars);
    },
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.debug) debug = Boolean(changes.debug.newValue);
    if (changes.batchSize) applyBatchSize(changes.batchSize.newValue);
    if (changes.maxChars) applyMaxChars(changes.maxChars.newValue);
  });

  /**
   * 디버그 로그를 출력함(debug 가 켜져 있을 때만).
   *
   * @param {string} location - 로그 위치.
   * @param {string} message - 로그 메시지(영문).
   * @param {*} [data] - 부가 데이터(선택).
   */
  function log(location, message, data) {
    if (!debug) return;
    const line = `[ai_translator ${new Date().toISOString()}] [${location}] ${message}`;
    if (data !== undefined) console.debug(line, data);
    else console.debug(line);
  }

  /**
   * 오류 로그를 출력함. 메시지는 항상 출력하고, 부가 데이터는 debug 일 때만 출력함.
   *
   * @param {string} location - 로그 위치.
   * @param {string} message - 오류 메시지(영문).
   * @param {*} [data] - 진단용 부가 데이터(원문/응답 등, debug 시에만 출력).
   */
  function logError(location, message, data) {
    const line = `[ai_translator ${new Date().toISOString()}] [${location}] ${message}`;
    if (debug && data !== undefined) console.error(line, data);
    else console.error(line);
  }

  /**
   * 텍스트 노드에서 조상을 거슬러 올라가 첫 "블록 조상" 요소를 찾음.
   * 인라인 태그(INLINE_TAGS)는 통과하므로, 인라인 요소로 쪼개진 텍스트 노드들이
   * 같은 블록 요소로 수렴함.
   *
   * @param {Text} node - 시작 텍스트 노드.
   * @returns {Element|null} 블록 조상 요소. 없으면 null.
   */
  function blockContainer(node) {
    let el = node.parentElement;
    if (!el) return null;
    while (el.parentElement && el !== document.body && isInlineElement(el)) {
      el = el.parentElement;
    }
    return el;
  }

  /**
   * 요소가 "leaf 블록"인지 판별함. 즉, 자식 요소 중 블록 레벨 요소가 없고
   * 인라인 요소만 포함하는 블록. leaf 블록만 innerHTML 을 통째로 번역함.
   * (블록 자식을 가진 컨테이너는 그 자식 블록들이 각자 번역 단위가 되도록 건너뜀.)
   *
   * @param {Element} el - 검사할 요소.
   * @returns {boolean} leaf 블록이면 true.
   */
  function isLeafBlock(el) {
    for (const child of el.children) {
      if (!isInlineElement(child)) return false;
    }
    return true;
  }

  /**
   * 블록 요소가 번역 대상인지 판별함.
   *
   * @param {Element} el - 검사할 블록 요소.
   * @returns {boolean} 번역 대상이면 true.
   */
  function isTranslatableBlock(el) {
    if (!el || translatedBlocks.has(el) || queuedBlocks.has(el)) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.isContentEditable) return false;
    if (el.closest("[translate=no]")) return false;
    if (!isLeafBlock(el)) return false; // 블록 자식을 가진 컨테이너는 제외
    const text = el.textContent;
    if (!text || !/\p{L}/u.test(text)) return false; // 문자가 없는 블록 제외
    return true;
  }

  /**
   * 문서 전체를 순회하여 번역 대상 leaf 블록을 관찰 등록함.
   * 관찰 중인 블록이 뷰포트에 진입하면 해당 블록이 번역 큐에 추가됨.
   */
  function scanAndObserve() {
    if (!active || !document.body) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // 문자가 있는 텍스트 노드만 후보로 삼음(공백/기호/숫자뿐인 노드 제외).
        return node.nodeValue && /\p{L}/u.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    // 텍스트 노드를 블록 조상 단위로 집계함(중복 블록은 Set 으로 한 번만).
    const blocks = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      // 텍스트의 직접 부모가 제외 태그(code/pre 등)면 건너뜀.
      if (!parent || SKIP_TAGS.has(parent.tagName)) continue;
      const block = blockContainer(node);
      if (block) blocks.add(block);
    }

    for (const el of blocks) {
      if (!isTranslatableBlock(el)) continue;
      if (!observedEls.has(el)) {
        observedEls.add(el);
        io.observe(el);
      }
    }
  }

  /**
   * IntersectionObserver 콜백. 뷰포트에 들어온 블록을 큐에 넣음.
   *
   * @param {IntersectionObserverEntry[]} entries - 교차 상태 변경 항목.
   */
  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      if (!translatedBlocks.has(el) && !queuedBlocks.has(el)) {
        queuedBlocks.add(el);
        pendingBlocks.add(el);
      }
      io.unobserve(el); // 한 번 처리한 블록은 관찰 해제
      observedEls.delete(el);
    }
    scheduleFlush();
  }

  /** 플러시를 디바운스하여 예약함(짧은 시간에 여러 블록이 진입해도 배치로 묶기 위함). */
  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  /** 스캔을 디바운스하여 예약함(DOM 변경이 연속으로 발생할 때 과도한 스캔 방지). */
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAndObserve, DEBOUNCE_MS);
  }

  /**
   * 대기 중인 블록을 배치로 나누어 번역 요청 후 결과로 치환함.
   */
  async function flush() {
    if (flushing || !active || pendingBlocks.size === 0) return;
    flushing = true;

    try {
      const blocks = [...pendingBlocks];
      pendingBlocks.clear();
      const preparedBlocks = blocks.map(prepareBlock).filter(Boolean);

      for (const batch of makeBatches(preparedBlocks)) {
        if (!active) break;
        await translateBatch(batch);
      }
    } finally {
      flushing = false;
      // 플러시 중 새로 쌓인 대기 블록이 있으면 이어서 처리함.
      if (active && pendingBlocks.size > 0) scheduleFlush();
    }
  }

  /**
   * 블록 목록을 세그먼트 수/문자 수 한도에 맞춰 배치로 분할함.
   * 문자 수는 각 블록의 innerHTML 길이(태그 포함)를 기준으로 함.
   *
  * @param {Array<{el: Element, html: string, protectedNodes: Element[], protectedId: string}>} blocks
  *   준비된 번역 블록 배열.
  * @returns {Array<Array<{el: Element, html: string, protectedNodes: Element[], protectedId: string}>>}
  *   배치들의 배열.
   */
  function makeBatches(blocks) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const block of blocks) {
      const len = block.html.length;
      if (
        current.length >= maxSegmentsPerBatch ||
        (current.length > 0 && chars + len > maxCharsPerBatch)
      ) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(block);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /**
   * 제외 태그 하위 트리를 빈 플레이스홀더로 치환한 번역용 HTML을 생성함.
   * 원본 노드는 응답 적용 시 그대로 이동해 이벤트 리스너와 입력 상태를 보존함.
   *
   * @param {Element} el - 번역할 블록 요소.
  * @returns {{el: Element, html: string, protectedNodes: Element[], protectedId: string}|null}
   *   번역 요청 정보. 번역할 일반 텍스트가 없으면 null.
   */
  function prepareBlock(el) {
    const clone = el.cloneNode(true);
    const protectedNodes = [...el.querySelectorAll(PROTECTED_SELECTOR)].filter(
      (node) => !node.parentElement?.closest(PROTECTED_SELECTOR),
    );
    const clonedProtectedNodes = [...clone.querySelectorAll(PROTECTED_SELECTOR)].filter(
      (node) => !node.parentElement?.closest(PROTECTED_SELECTOR),
    );
    const protectedId = `${Date.now().toString(36)}-${++protectedBlockSequence}`;

    clonedProtectedNodes.forEach((node, index) => {
      const placeholder = document.createElement("span");
      placeholder.setAttribute(PROTECTED_ATTR, `${protectedId}-${index}`);
      node.replaceWith(placeholder);
    });

    if (!/\p{L}/u.test(clone.textContent || "")) {
      translatedBlocks.add(el);
      return null;
    }
    return { el, html: clone.innerHTML, protectedNodes, protectedId };
  }

  /**
   * 모델이 반환한 HTML 을 삽입 전에 정화함. 위험 태그(script/iframe 등)와
   * 이벤트 핸들러 속성(on*), javascript: URL 을 제거함. 인라인 서식 태그와
   * href 등 정상 속성은 유지함.
   *
   * @param {string} html - 모델이 반환한 HTML 문자열.
   * @returns {string} 정화된 HTML 문자열.
   */
  function sanitizeHtml(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const frag = tpl.content;

    frag.querySelectorAll(DANGEROUS_TAGS).forEach((n) => n.remove());
    frag.querySelectorAll("*").forEach((n) => {
      for (const attr of [...n.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on")) {
          n.removeAttribute(attr.name);
        } else if (
          (name === "href" || name === "src" || name === "xlink:href") &&
          value.startsWith("javascript:")
        ) {
          n.removeAttribute(attr.name);
        }
      }
    });

    return tpl.innerHTML;
  }

  /**
   * 정화된 번역 HTML의 플레이스홀더를 요청 전 보관한 원본 DOM 노드로 복원함.
   * 플레이스홀더가 누락·중복·변조되면 원본 손상을 막기 위해 적용하지 않음.
   *
   * @param {string} html - 모델이 반환한 번역 HTML.
   * @param {Element[]} protectedNodes - 요청에서 플레이스홀더로 치환한 원본 노드.
   * @param {string} protectedId - 이 블록의 플레이스홀더 식별자.
   * @returns {DocumentFragment|null} 적용할 문서 조각 또는 검증 실패 시 null.
   */
  function restoreProtectedHtml(html, protectedNodes, protectedId) {
    const tpl = document.createElement("template");
    tpl.innerHTML = sanitizeHtml(html);
    const prefix = `${protectedId}-`;
    const placeholders = [...tpl.content.querySelectorAll(`[${PROTECTED_ATTR}]`)].filter(
      (node) => node.getAttribute(PROTECTED_ATTR).startsWith(prefix),
    );

    if (placeholders.length !== protectedNodes.length) return null;
    const seen = new Set();
    for (const placeholder of placeholders) {
      const index = Number(placeholder.getAttribute(PROTECTED_ATTR).slice(prefix.length));
      if (!Number.isInteger(index) || index < 0 || index >= protectedNodes.length || seen.has(index)) {
        return null;
      }
      seen.add(index);
      placeholder.replaceWith(protectedNodes[index]);
    }
    return tpl.content;
  }

  /**
   * 단일 배치를 백그라운드로 보내 번역하고, 응답을 블록 innerHTML 로 반영함.
   *
  * @param {Array<{el: Element, html: string, protectedNodes: Element[], protectedId: string}>} blocks
  *   이 배치에 속한 준비된 번역 블록 배열.
   */
  async function translateBatch(blocks) {
    // 제외 태그 하위 트리가 플레이스홀더로 축약된 HTML을 전송함.
    const segments = blocks.map((block) => block.html);
    log("content/translateBatch", `sending ${segments.length} segments`, segments);

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "translate-batch", segments });
    } catch (err) {
      // 서비스 워커 미응답 등
      logError("content/translateBatch", `sendMessage failed: ${err.message}`);
      showToast(`번역 오류: ${err.message}`, "error");
      return;
    }

    if (!resp || resp.error) {
      const reason = resp?.error ?? "알 수 없는 오류(서비스 워커 무응답)";
      logError("content/translateBatch", `provider error: ${reason}`, { segments });
      showToast(`번역 오류: ${reason}`, "error");
      // 오류가 발생하면 세션을 멈춰 반복 실패/과금을 방지함.
      stopTranslation();
      return;
    }

    const { translations } = resp;
    if (!Array.isArray(translations) || translations.length !== blocks.length) {
      // 개수 불일치는 세션을 멈추지 않고 이 배치만 건너뜀(다음 배치는 정상일 수 있음).
      logError(
        "content/translateBatch",
        `bad response shape: expected ${blocks.length}, got ${
          Array.isArray(translations) ? translations.length : typeof translations
        }`,
        { segments, translations },
      );
      showToast("번역 응답 형식이 올바르지 않습니다(이 부분은 건너뜁니다).", "error");
      return;
    }

    blocks.forEach((block, i) => {
      const html = translations[i];
      // 비어 있거나 문자열이 아닌 응답은 원문 유지(병합/누락 아티팩트 방어).
      if (typeof html === "string" && html.trim() !== "") {
        const restored = restoreProtectedHtml(html, block.protectedNodes, block.protectedId);
        if (restored) {
          block.el.replaceChildren(restored);
        } else {
          logError("content/translateBatch", "protected placeholders were altered; keeping original", {
            segment: block.html,
            translation: html,
          });
        }
      }
      translatedBlocks.add(block.el);
    });

    log("content/translateBatch", `applied ${translations.length} translations`);
    showToast("번역 중…", "info");
  }

  /** 번역 세션을 시작함. 관찰자/스캔을 초기화하고 첫 스캔을 수행함. */
  function startTranslation() {
    if (active) {
      // 이미 활성 상태면 재스캔만 수행(동적으로 추가된 영역 흡수).
      scanAndObserve();
      return;
    }
    active = true;

    io = new IntersectionObserver(onIntersect, { rootMargin: "200px 0px" });

    // 동적 콘텐츠(무한 스크롤 등)로 노드가 추가되면 재스캔.
    // 번역 결과 innerHTML 교체도 childList 변경을 유발하지만, 해당 블록은 이미
    // translatedBlocks 에 있어 재수집되지 않으므로 무한 루프가 생기지 않음.
    mo = new MutationObserver(() => scheduleScan());
    mo.observe(document.body, { childList: true, subtree: true });

    showToast("번역을 시작합니다…", "info");
    scanAndObserve();
  }

  /** 번역 세션을 중지하고 관찰자를 해제함. 이미 치환된 텍스트는 유지됨. */
  function stopTranslation() {
    active = false;
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pendingBlocks.clear();
    // WeakSet 은 clear() 가 없어 참조 교체로 초기화함.
    // 다음 세션에서 io.observe 재등록이 정상 동작하도록 관찰 집합을 비움.
    observedEls = new WeakSet();
  }

  // ── 화면 우하단 상태 토스트 ─────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;

  /**
   * 페이지 우하단에 상태 메시지를 표시함.
   * info 메시지는 잠시 후 자동으로 사라지고, error 메시지는 진단을 놓치지 않도록
   * 자동으로 사라지지 않으며 클릭하면 닫힘.
   *
   * @param {string} text - 표시할 메시지.
   * @param {"info"|"error"} [kind] - 메시지 종류(색상 구분용).
   */
  function showToast(text, kind = "info") {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "__ai-translator-toast";
      toastEl.setAttribute("translate", "no"); // 스캐너가 토스트 자체를 번역 대상으로 잡지 않도록 제외
      Object.assign(toastEl.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        maxWidth: "320px",
        padding: "10px 14px",
        borderRadius: "10px",
        font: "13px/1.4 system-ui, sans-serif",
        color: "#fff",
        boxShadow: "0 4px 16px rgba(0,0,0,.25)",
        pointerEvents: "none",
      });
      // 오류 토스트를 클릭하면 즉시 닫히도록 함.
      toastEl.addEventListener("click", () => {
        toastEl.style.opacity = "0";
      });
      document.documentElement.appendChild(toastEl);
    }

    const isError = kind === "error";
    toastEl.textContent = isError ? `${text} (클릭하여 닫기)` : text;
    toastEl.title = isError ? "클릭하여 닫기" : "";
    toastEl.style.background = isError ? "#b91c1c" : "#1f2937";
    toastEl.style.opacity = "1";
    // 오류일 때만 클릭 가능(닫기)하도록 포인터 이벤트를 켬.
    toastEl.style.pointerEvents = isError ? "auto" : "none";
    toastEl.style.cursor = isError ? "pointer" : "default";

    if (toastTimer) clearTimeout(toastTimer);
    // 오류는 자동으로 숨기지 않음(사용자가 확인/클릭할 때까지 유지).
    if (isError) return;
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 1500);
  }

  // ── 팝업 → 콘텐츠 스크립트 메시지 처리 ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "start-translation") {
      startTranslation();
      sendResponse({ ok: true });
    } else if (msg?.type === "stop-translation") {
      stopTranslation();
      showToast("번역을 중지했습니다.", "info");
      sendResponse({ ok: true });
    } else if (msg?.type === "get-status") {
      // 팝업이 현재 페이지의 번역 세션 활성 여부를 조회함.
      sendResponse({ ok: true, active });
    } else if (msg?.type === "ping") {
      sendResponse({ ok: true });
    }
    return false;
  });
})();
