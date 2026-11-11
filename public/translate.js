// 翻訳（日 / 中 / EN）。ブラウザ内蔵の Translator API を使うので、無料・キー不要。
// 画面に出た文字を監視して、その場で訳す。訳せなかった文字は原文のまま残す。
(() => {
  const CAN = typeof self.Translator === "function" && typeof self.Translator.create === "function";
  const box = document.getElementById("langs");
  if (!box) return;
  if (!CAN) { box.hidden = true; return; } // iPhone の Safari など：ボタンを出さず、原文のまま
  const $ = (id) => document.getElementById(id);
  const st = $("langst");
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let lang = get("newshub.lang", null); // null = 原文
  const SRC = ["ja", "en"];
  const TARGET_CODE = { ja: "ja", zh: "zh", en: "en" };
  const KANA = /[぀-ヿ]/, HAN = /[㐀-鿿]/, LATIN = /[A-Za-z]/g;
  const detect = (t) => {
    if (KANA.test(t)) return "ja";
    const lat = (t.match(LATIN) || []).length;
    if (lat > t.length * 0.3) return "en";
    return HAN.test(t) ? "ja" : null; // 漢字のみは日本語扱い（このサイトの記事は日本語が中心）
  };

  const mk = new Map(); // "ja>en" -> Promise<Translator|null>
  function engine(s, t) {
    const key = `${s}>${t}`;
    if (!mk.has(key)) {
      mk.set(key, (async () => {
        try {
          const av = await Promise.race([Translator.availability({ sourceLanguage: s, targetLanguage: t }), new Promise((r) => setTimeout(() => r("unavailable"), 4000))]);
          if (av === "unavailable") return null;
          if (av !== "available" && !navigator.userActivation?.isActive) { mk.delete(key); return null; } // ダウンロードにはボタン操作が必要
          setStatus("翻訳データを準備中…");
          const tr = await Translator.create({
            sourceLanguage: s, targetLanguage: t,
            monitor: (m) => m.addEventListener("downloadprogress", (e) => setStatus(`翻訳データを準備中… ${Math.round(e.loaded * 100)}%`)),
          });
          setStatus("");
          return tr;
        } catch { mk.delete(key); setStatus(""); return null; }
      })());
    }
    return mk.get(key);
  }
  const setStatus = (s) => { if (st) st.textContent = s; };

  const cache = new Map(); // "lang|text" -> 訳文
  async function translate(text, t) {
    const s = detect(text);
    if (!s || s === t) return null;
    const ck = `${t}|${text}`;
    if (cache.has(ck)) return cache.get(ck);
    const e = await engine(s, TARGET_CODE[t]);
    if (!e) return null;
    try {
      const out = (await e.translate(text)).trim();
      const v = out && out !== text ? out : null;
      cache.set(ck, v);
      return v;
    } catch { return null; }
  }

  // 訳す対象（テキストノード）。ノードごとに原文と訳文を覚えておく
  const SEL = ".card h2, .card p, #rTitle, #rText p, .hotbar .hi, .hotbar .ic, .hotbar .ib";
  const info = new WeakMap(); // textNode -> { orig, out }
  const textNodes = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
  const holder = (el) => el.closest(".card, .rcard"); // 「原文」ボタンの単位

  async function apply(el) {
    for (const n of textNodes(el)) {
      let r = info.get(n);
      if (r && n.nodeValue !== r.out && n.nodeValue !== r.orig) r = null; // アプリが書き換えた
      if (!r) { r = { orig: n.nodeValue, out: null }; info.set(n, r); }
      const h = holder(el);
      const wantOrig = !lang || (h && h.dataset.orig === "1");
      if (wantOrig) { if (n.nodeValue !== r.orig) n.nodeValue = r.orig; continue; }
      if (r.out === null) {
        const mylang = lang;
        const v = await translate(r.orig, mylang);
        if (mylang !== lang) return; // 途中で言語が変わった
        r.out = v ?? r.orig;
        r.lang = mylang;
      } else if (r.lang !== lang) {
        const mylang = lang;
        const v = await translate(r.orig, mylang);
        if (mylang !== lang) return;
        r.out = v ?? r.orig; r.lang = mylang;
      }
      if (n.parentNode && n.nodeValue !== r.out) n.nodeValue = r.out;
    }
    markHolder(el);
  }
  // 訳が入ったカード・詳細に「原文」ボタンを付ける
  function markHolder(el) {
    const h = holder(el);
    if (!h || !lang) return;
    const meta = h.querySelector(".meta, .rmeta");
    if (!meta || meta.querySelector(".orig")) return;
    const changed = [...h.querySelectorAll(SEL)].some((e) => textNodes(e).some((n) => { const r = info.get(n); return r && r.out && r.out !== r.orig; }));
    if (!changed) return;
    const b = document.createElement("span");
    b.className = "orig"; b.textContent = "原文";
    meta.appendChild(b);
  }

  // 画面の近くに来たカードだけ訳す（記事が多くても軽く）
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); queue(en.target); }
  }, { rootMargin: "700px 0px" });
  const seen = new WeakSet();
  let chain = Promise.resolve();
  const queue = (el) => { chain = chain.then(() => apply(el)).catch(() => {}); };

  function scan(root) {
    if (!lang && !root.__force) return;
    const list = root.nodeType === 1 ? [...(root.matches?.(SEL) ? [root] : []), ...root.querySelectorAll(SEL)] : [];
    for (const el of list) {
      if (el.closest(".card")) { if (!seen.has(el)) { seen.add(el); } io.observe(el); }
      else queue(el);
    }
  }
  new MutationObserver((muts) => {
    if (!lang) return;
    for (const m of muts) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) scan(n);
          else if (n.nodeType === 3 && n.parentElement?.matches(SEL) && !info.has(n)) scan(n.parentElement);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // 「原文」ボタン：押している間そのカードだけ原文に戻す（カードを開かない）
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.(".orig");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const h = holder(b);
    h.dataset.orig = h.dataset.orig === "1" ? "0" : "1";
    b.textContent = h.dataset.orig === "1" ? "翻訳" : "原文";
    for (const el of h.querySelectorAll(SEL)) queue(el);
  }, true);

  function refreshAll() {
    for (const el of document.querySelectorAll(SEL)) { if (el.closest(".card")) io.observe(el); else queue(el); }
    if (!lang) document.querySelectorAll(".orig").forEach((o) => o.remove());
  }

  function paint() {
    box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === lang));
  }
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    lang = lang === b.dataset.l ? null : b.dataset.l;
    put("newshub.lang", lang);
    paint();
    document.querySelectorAll(".orig").forEach((o) => o.remove());
    document.querySelectorAll("[data-orig]").forEach((h) => delete h.dataset.orig);
    if (lang) { // ボタン操作の直後にだけ、翻訳データのダウンロードを始められる
      for (const s of SRC) if (s !== TARGET_CODE[lang]) engine(s, TARGET_CODE[lang]);
      const got = await Promise.all(SRC.filter((s) => s !== TARGET_CODE[lang]).map((s) => engine(s, TARGET_CODE[lang])));
      if (!got.some(Boolean)) { setStatus("このブラウザでは翻訳できません"); setTimeout(() => setStatus(""), 4000); }
    }
    refreshAll();
  });
  paint();
  if (lang) setTimeout(refreshAll, 300);
})();
