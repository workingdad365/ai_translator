// 콘텐츠 스크립트
// 팝업의 "번역 시작" 신호를 받아 현재 페이지의 텍스트를 한국어로 치환함.
// - 뷰포트에 들어오는 텍스트만 순차적으로 번역함(IntersectionObserver).
// - 스크롤로 새 영역이 나타나거나 DOM 이 동적으로 추가되면 자동으로 이어서 번역함.
// 동일 페이지에 스크립트가 중복 주입되어도 한 번만 초기화되도록 IIFE + 전역 플래그로 보호함.

(() => {
  if (window.__aiTranslatorLoaded) return;
  window.__aiTranslatorLoaded = true;

  // 번역 대상에서 제외할 태그.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE",
    "KBD", "SAMP", "SVG", "MATH", "INPUT", "SELECT", "OPTION",
  ]);

  // 한 번의 API 호출에 담을 최대 세그먼트 수 / 최대 문자 수.
  const MAX_SEGMENTS_PER_BATCH = 40;
  const MAX_CHARS_PER_BATCH = 3000;

  // 스캔/플러시 디바운스 지연(ms).
  const DEBOUNCE_MS = 250;

  const translated = new WeakSet(); // 번역 완료된 텍스트 노드
  const queued = new WeakSet(); // 큐에 이미 담긴 텍스트 노드(중복 방지)
  let observedEls = new WeakSet(); // IntersectionObserver 로 관찰 중인 요소(세션 중지 시 교체)

  const pendingNodes = new Set(); // 뷰포트 진입 후 번역 대기 중인 텍스트 노드

  let active = false; // 번역 세션 활성 여부
  let flushing = false; // 플러시 진행 중 여부(동시 실행 방지)
  let io = null; // IntersectionObserver
  let mo = null; // MutationObserver
  let scanTimer = null;
  let flushTimer = null;

  /**
   * 텍스트 노드가 번역 대상인지 판별함.
   *
   * @param {Text} node - 검사할 텍스트 노드.
   * @returns {boolean} 번역 대상이면 true.
   */
  function isTranslatable(node) {
    if (translated.has(node) || queued.has(node)) return false;
    const text = node.nodeValue;
    if (!text || !/\p{L}/u.test(text)) return false; // 문자가 없는(공백/기호/숫자) 노드 제외
    const parent = node.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS.has(parent.tagName)) return false;
    if (parent.isContentEditable) return false;
    if (parent.closest("[translate=no]")) return false;
    return true;
  }

  /**
   * 문서 전체를 순회하여 번역 대상 텍스트 노드를 요소 단위로 관찰 등록함.
   * 관찰 중인 요소가 뷰포트에 진입하면 해당 요소의 텍스트가 번역 큐에 추가됨.
   */
  function scanAndObserve() {
    if (!active || !document.body) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isTranslatable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    // 텍스트 노드를 부모 요소 단위로 묶음(IntersectionObserver 는 요소만 관찰 가능).
    const byElement = new Map();
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!byElement.has(el)) byElement.set(el, []);
      byElement.get(el).push(node);
    }

    for (const [el, nodes] of byElement) {
      // 요소에 자신이 보유한 대상 텍스트 노드 목록을 부착해 둠.
      el.__aiTextNodes = nodes;
      if (!observedEls.has(el)) {
        observedEls.add(el);
        io.observe(el);
      }
    }
  }

  /**
   * IntersectionObserver 콜백. 뷰포트에 들어온 요소의 텍스트 노드를 큐에 넣음.
   *
   * @param {IntersectionObserverEntry[]} entries - 교차 상태 변경 항목.
   */
  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const nodes = el.__aiTextNodes || [];
      for (const n of nodes) {
        if (!translated.has(n) && !queued.has(n)) {
          queued.add(n);
          pendingNodes.add(n);
        }
      }
      io.unobserve(el); // 한 번 처리한 요소는 관찰 해제
      observedEls.delete(el);
    }
    scheduleFlush();
  }

  /** 플러시를 디바운스하여 예약함(짧은 시간에 여러 요소가 진입해도 배치로 묶기 위함). */
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
   * 대기 중인 텍스트 노드를 배치로 나누어 번역 요청 후 결과로 치환함.
   */
  async function flush() {
    if (flushing || !active || pendingNodes.size === 0) return;
    flushing = true;

    try {
      const nodes = [...pendingNodes];
      pendingNodes.clear();

      for (const batch of makeBatches(nodes)) {
        if (!active) break;
        await translateBatch(batch);
      }
    } finally {
      flushing = false;
      // 플러시 중 새로 쌓인 대기 노드가 있으면 이어서 처리함.
      if (active && pendingNodes.size > 0) scheduleFlush();
    }
  }

  /**
   * 텍스트 노드 목록을 세그먼트 수/문자 수 한도에 맞춰 배치로 분할함.
   *
   * @param {Text[]} nodes - 대상 텍스트 노드 배열.
   * @returns {Text[][]} 배치(노드 배열)들의 배열.
   */
  function makeBatches(nodes) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const n of nodes) {
      const len = n.nodeValue.trim().length;
      if (
        current.length >= MAX_SEGMENTS_PER_BATCH ||
        (current.length > 0 && chars + len > MAX_CHARS_PER_BATCH)
      ) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(n);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /**
   * 단일 배치를 백그라운드로 보내 번역하고, 응답을 텍스트 노드에 반영함.
   *
   * @param {Text[]} nodes - 이 배치에 속한 텍스트 노드 배열.
   */
  async function translateBatch(nodes) {
    // 앞뒤 공백을 보존하기 위해 트림된 원문만 전송하고, 치환 시 다시 붙임.
    const segments = nodes.map((n) => n.nodeValue.trim());

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "translate-batch", segments });
    } catch (err) {
      // 서비스 워커 미응답 등
      showToast(`번역 오류: ${err.message}`, "error");
      return;
    }

    if (!resp || resp.error) {
      showToast(`번역 오류: ${resp?.error ?? "알 수 없는 오류"}`, "error");
      // 오류가 발생하면 세션을 멈춰 반복 실패/과금을 방지함.
      stopTranslation();
      return;
    }

    const { translations } = resp;
    if (!Array.isArray(translations) || translations.length !== nodes.length) {
      showToast("번역 응답 형식이 올바르지 않습니다.", "error");
      return;
    }

    nodes.forEach((n, i) => {
      const raw = n.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      n.nodeValue = lead + translations[i] + trail;
      translated.add(n);
    });

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
    pendingNodes.clear();
    // WeakSet 은 clear() 가 없어 참조 교체로 초기화함.
    // 다음 세션에서 io.observe 재등록이 정상 동작하도록 관찰 집합을 비움.
    observedEls = new WeakSet();
  }

  // ── 화면 우하단 상태 토스트 ─────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;

  /**
   * 페이지 우하단에 상태 메시지를 잠시 표시함.
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
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = kind === "error" ? "#b91c1c" : "#1f2937";
    toastEl.style.opacity = "1";

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, kind === "error" ? 6000 : 1500);
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
