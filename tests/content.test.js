import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const url = "https://get.crackerbox.app/crackerbox/install/";

function createContent() {
  class Element {
    constructor(html) {
      this.tagName = "P";
      this.innerHTML = html;
      this.textContent = `Install ${url}`;
      this.isConnected = true;
      this.parentElement = null;
    }
    getAttribute() { return null; }
    getRootNode() { return {}; }
    closest() { return null; }
  }
  const window = {};
  const context = vm.createContext({
    window, Element,
    location: { hostname: "www.reddit.com" },
    chrome: {
      storage: {
        local: { async get() { return {}; } },
        onChanged: { addListener() {} },
      },
      runtime: { onMessage: { addListener() {} } },
    },
  });
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    let cleared = 0;
    let scans = 0;
    clearTranslationOverlay = () => { cleared++; };
    scheduleScan = () => { scans++; };
    renderProgress = () => {};
    window.test = {
      getBlockSourceKey, matchesPreparedBlock, createAppliedState, handleMutations,
      overlayTranslationCache, appliedBlockStates, translatedBlocks,
      get cleared() { return cleared; },
      get scans() { return scans; },
    };
  })();`), context);
  return { ...window.test, hooks: window.test, Element };
}

test("Reddit 목록의 일반 텍스트 캐시를 링크가 있는 상세 본문에 재사용하지 않는다", () => {
  const api = createContent();
  const summary = new api.Element(`Install ${url}`);
  const detail = new api.Element(`Install <a href="${url}">${url}</a>`);
  api.overlayTranslationCache.set(api.getBlockSourceKey(summary), { text: "설치" });
  assert.equal(api.overlayTranslationCache.get(api.getBlockSourceKey(detail)), undefined);
  const recreated = new api.Element(detail.innerHTML);
  api.overlayTranslationCache.set(api.getBlockSourceKey(detail), { text: "링크 포함" });
  assert.equal(api.overlayTranslationCache.get(api.getBlockSourceKey(recreated)).text, "링크 포함");
});

test("요청 중 같은 텍스트에 링크가 추가되면 이전 번역의 적용을 거부한다", () => {
  const api = createContent();
  const el = new api.Element(`Install ${url}`);
  const block = { sourceText: el.textContent, sourceKey: api.getBlockSourceKey(el), href: null };
  assert.equal(api.matchesPreparedBlock(el, block), true);
  el.innerHTML = `Install <a href="${url}">${url}</a>`;
  assert.equal(api.matchesPreparedBlock(el, block), false);
});

test("오버레이 적용 후 링크가 추가되거나 주소가 바뀌면 원문을 드러내고 재번역한다", () => {
  for (const initialHtml of [`Install ${url}`, `Install <a href="/old">${url}</a>`]) {
    const api = createContent();
    const el = new api.Element(initialHtml);
    api.appliedBlockStates.set(el, api.createAppliedState(el, el.textContent, "설치", "설치", true));
    api.translatedBlocks.add(el);
    api.handleMutations([{ target: el }]);
    assert.equal(api.hooks.cleared, 0);
    el.innerHTML = `Install <a href="${url}">${url}</a>`;
    api.handleMutations([{ target: el }]);
    assert.equal(api.hooks.cleared, 1);
    assert.equal(api.appliedBlockStates.has(el), false);
    assert.equal(api.translatedBlocks.has(el), false);
    assert.ok(api.hooks.scans > 0);
  }
});
