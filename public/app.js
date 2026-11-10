const API = (window.NEWS_API_BASE || "").replace(/\/$/, "");
const POLL_MS = 60 * 1000; // 1分ごとに自動更新
const $ = (id) => document.getElementById(id);

// ---- 保存（このブラウザだけ。他の人には影響しない）----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const isNewVisitor = localStorage.getItem("newshub.prefs") === null; // 初めての人だけ、最初のタブを絞る
let prefs = store.get("newshub.prefs", { order: [], hidden: [], custom: [], deleted: [], init: false });
if (!isNewVisitor && prefs.init === undefined) prefs.init = true; // 以前から使っている人の設定は変えない
prefs.deleted ||= [];
// 初期表示のタブ（それ以外は設定でONにすると出る）
const DEFAULT_TABS = ["national", "world", "politics", "economy", "finance", "it", "car", "cosme"];
function applyDefaultTabs() {
  if (prefs.init || !Object.keys(genres).length) return;
  prefs.hidden = Object.keys(genres).filter((id) => !DEFAULT_TABS.includes(id));
  prefs.init = true;
  savePrefs();
} // 削除したジャンル（標準ジャンルも削除できる）
let tab = store.get("newshub.tab", "all");
let genres = {};
let items = [];
let updatedAt = 0;
const savePrefs = () => store.set("newshub.prefs", prefs);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function ago(t) {
  if (!t) return "";
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}

// ---- タブ（標準ジャンル + 自分用キーワードタブ）----
function allTabs() {
  const base = Object.entries(genres).filter(([id]) => !prefs.deleted.includes(id)).map(([id, g]) => ({ id, label: g.label }));
  const custom = prefs.custom.map((c) => ({ id: c.id, label: c.label, custom: true }));
  const all = [...base, ...custom];
  const byId = new Map(all.map((t) => [t.id, t]));
  const ordered = prefs.order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const rest = all.filter((t) => !prefs.order.includes(t.id)); // 新しく増えたジャンルは末尾へ
  return [...ordered, ...rest];
}
const visibleTabs = () => allTabs().filter((t) => !prefs.hidden.includes(t.id));

function keywords(id) {
  const c = prefs.custom.find((x) => x.id === id);
  return c ? c.kw.split(/[\s、,，]+/).filter(Boolean).map((k) => k.toLowerCase()) : [];
}
// 表示中のタブに応じた検索条件（絞り込みはサーバー側で行い、必要な分だけ受け取る）
function queryFor() {
  if (tab === "all") return "genre=all";
  if (tab.startsWith("k:")) return `genre=all&q=${encodeURIComponent(keywords(tab).join(" "))}`;
  return `genre=${encodeURIComponent(tab)}`;
}

function renderTabs() {
  const vis = visibleTabs();
  if (tab !== "all" && !vis.some((t) => t.id === tab)) tab = "all";
  $("tabs").innerHTML = [{ id: "all", label: "すべて" }, ...vis]
    .map((t) => `<button data-g="${esc(t.id)}" class="${t.id === tab ? "on" : ""}">${esc(t.label)}</button>`)
    .join("") + `<button class="add" data-add="1">＋ 追加・編集</button>`; // タブ列の末尾からも設定を開ける
}

const readSet = new Set(store.get("newshub.read", []));
function markRead(link) {
  if (readSet.has(link)) return;
  readSet.add(link);
  store.set("newshub.read", [...readSet].slice(-800)); // 古いものから忘れる
}
let shown = []; // いま画面に出している記事（カード番号と対応）
let total = 0; // 条件に合う記事の総数
// 画像が表示できなかったら、サーバーに記事ページから取り直してもらう（1枚につき1回だけ）
window.retryImg = (img) => {
  const card = img.closest(".card");
  if (!card || img.dataset.r) return img.remove();
  img.dataset.r = "1";
  fetch(`${API}/api/image-retry?link=${encodeURIComponent(card.href)}&bad=${encodeURIComponent(img.src)}`)
    .then((r) => r.json())
    .then((d) => { if (d.image) img.src = d.image; else img.remove(); })
    .catch(() => img.remove());
};
const cardHtml = (i, n) => `<div class="cell"><a class="card${readSet.has(i.link) ? " read" : ""}" data-n="${n}" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">
        ${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="this.classList.add('ld')" onerror="retryImg(this)">` : ""}
        <h2>${esc(i.title)}</h2>
        <p>${esc(i.summary || "")}</p>
        <div class="meta"><span class="tag">${esc(genres[i.genre]?.label || "")}</span><span>${esc(i.source)}</span><span>${ago(i.time)}</span></div>
      </a></div>`;
// 段組み（カードを一番低い列へ積む。順番は上から下へおおむね新しい順）
let colCount = 0;
const calcCols = () => Math.max(1, Math.min(4, Math.floor($("list").clientWidth / 270)));
function makeCols() {
  colCount = calcCols();
  $("list").innerHTML = Array.from({ length: colCount }, () => '<div class="col"></div>').join("");
}
function place(newItems, start) {
  const cols = [...$("list").children];
  newItems.forEach((i, k) => {
    let low = cols[0];
    for (const c of cols) if (c.offsetHeight < low.offsetHeight) low = c;
    low.insertAdjacentHTML("beforeend", cardHtml(i, start + k));
  });
}
function renderList() {
  shown = items;
  if (!items.length) { colCount = 0; $("list").innerHTML = '<div class="empty">該当する記事がありません</div>'; return; }
  makeCols();
  place(items, 0);
}
// 続きを後ろに足す（既に出しているカードは作り直さない）
function appendList(newItems) {
  const start = shown.length;
  shown = items;
  if (!colCount) return renderList();
  place(newItems, start);
}
let rz;
window.addEventListener("resize", () => {
  clearTimeout(rz);
  rz = setTimeout(() => { if (items.length && calcCols() !== colCount) renderList(); }, 200);
});
// カードをクリック/タップすると、新しいタブではなくサイト内の詳細表示を開く（Ctrl/中クリックは従来どおり原文へ）
const NO_READER = new Set(); // 本文を取得できないサイトを入れると、詳細画面を挟まず原文を直接開く
$("list").addEventListener("click", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  const item = shown[Number(card.dataset.n)];
  // 本文を取得できないサイト（ボット対策で拒否される）は、空の詳細画面を挟まず原文を直接開く
  if (item && NO_READER.has(item.source)) { markRead(item.link); card.classList.add("read"); return; }
  e.preventDefault();
  if (item) { markRead(item.link); card.classList.add("read"); openReader(item); }
});

const PAGE = 48; // 1回に取得・描画するカード数
const setStatus = () => { if (updatedAt) $("status").textContent = new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }); };
let loadedTab = null; // いま一覧に出しているタブ
let loading = false;
let reqId = 0;

function render() {
  renderTabs();
  setStatus();
  if (tab !== loadedTab) load(); // 設定変更などで表示中のタブが変わったら読み直す
}

// ---- 市況（金融タブの上に表示）----
async function loadMarkets() {
  const box = $("markets");
  if (box.dataset.for !== tab) { box.hidden = true; box.innerHTML = ""; box.dataset.for = tab; } // タブが変わったら前の内容を消す
  if (tab !== "finance") { if (tab !== "national") box.hidden = true; return; }
  try {
    const d = await (await fetch(`${API}/api/markets`)).json();
    if (tab !== "finance" || !d.items?.length) { box.hidden = true; return; }
    const fmt = (n, dp) => n.toLocaleString("ja-JP", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    box.innerHTML = d.items.map((m) => {
      const cls = m.change > 0 ? "up" : m.change < 0 ? "down" : "";
      const arrow = m.change > 0 ? "▲" : m.change < 0 ? "▼" : "";
      const ch = m.pct == null ? "" : `<span class="chg ${cls}">${arrow}${Math.abs(m.pct).toFixed(2)}%</span>`;
      return `<span class="mk"><span class="mn">${esc(m.label)}</span><span class="mp">${m.unit === "$" ? "$" : ""}${fmt(m.price, m.dp)}${m.unit === "円" ? "円" : ""}</span>${ch}</span>`;
    }).join("");
    box.hidden = false;
  } catch { box.hidden = true; }
}

// 金融タブを見ていて、画面が表示されている間だけ、3秒ごとに更新する
setInterval(() => { if (tab === "finance" && !document.hidden) loadMarkets(); }, 3000);

// ---- 国内タブの天気ヘッダー（東京の天気・気温、台風、寒波・熱波）----
async function loadWeather() {
  const box = $("markets");
  if (box.dataset.for !== tab) { box.hidden = true; box.innerHTML = ""; box.dataset.for = tab; } // タブが変わったら前の内容を消す
  if (tab !== "national") return;
  try {
    const w = await (await fetch(`${API}/api/weather`)).json();
    if (tab !== "national" || !(w.weather || w.temp != null)) { box.hidden = true; return; }
    const temp = w.temp != null ? `${w.temp.toFixed(1)}℃` : "";
    const range = w.max != null && !Number.isNaN(w.max) ? ` (最高${w.max}℃/最低${w.min}℃)` : "";
    const ty = w.typhoons?.length ? w.typhoons.map((t) => `${t.no}号${t.name ? " " + esc(t.name) : ""}`).join("、") : "なし";
    const warn = [w.heat && `<span class="chg up">${esc(w.heat)}</span>`, w.cold && `<span class="chg down">${esc(w.cold)}</span>`].filter(Boolean).join(" ") || "なし";
    box.innerHTML =
      `<span class="mk"><span class="mn">東京</span><span class="mp">${esc(w.weather || "")}</span><span>${temp}${range}</span></span>` +
      `<span class="mk"><span class="mn">台風</span><span class="mp">${ty}</span></span>` +
      `<span class="mk"><span class="mn">寒波・熱波</span><span class="mp">${warn}</span></span>`;
    box.hidden = false;
  } catch { box.hidden = true; }
}
setInterval(() => { if (tab === "national" && !document.hidden) loadWeather(); }, 60000);

// 先頭から読み直す（タブ切り替え・更新ボタン・自動更新）
async function load({ fresh = false, poll = false } = {}) {
  const id = ++reqId;
  loadMarkets();
  loadWeather();
  try {
    const r = await fetch(`${API}/api/news?${queryFor()}&limit=${PAGE}&offset=0${fresh ? "&fresh=1" : ""}`);
    const d = await r.json();
    if (id !== reqId) return; // 途中でタブが変わった等、古い応答は捨てる
    genres = d.genres;
    applyDefaultTabs();
    const changed = d.updatedAt !== updatedAt || loadedTab !== tab;
    updatedAt = d.updatedAt;
    setStatus();
    // 自動更新で中身が変わっていない、またはスクロールして読んでいる最中は、描画し直さない
    if (poll && (!changed || window.scrollY > 300 || readerOpen)) { renderTabs(); return; }
    items = d.items;
    total = d.total;
    loadedTab = tab;
    renderTabs();
    renderList();
    watchMore();
  } catch {
    $("status").textContent = "再試行中";
  }
}

// 続きの読み込み（下までスクロールしたら次の48件）
async function loadMore() {
  if (loading || items.length >= total) return;
  loading = true;
  const id = reqId;
  try {
    const r = await fetch(`${API}/api/news?${queryFor()}&limit=${PAGE}&offset=${items.length}`);
    const d = await r.json();
    if (id !== reqId) return;
    const add = d.items.filter((i) => !items.some((x) => x.link === i.link)); // 更新で記事がずれても重複させない
    items = items.concat(add);
    total = d.total;
    appendList(add);
  } catch {} finally {
    loading = false;
    watchMore();
  }
}
const sentinel = document.createElement("div");
sentinel.id = "sentinel";
$("list").after(sentinel);
const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "800px" });
io.observe(sentinel);
// IntersectionObserver が使えない環境向けの保険（スクロール位置でも判定）
let sc;
window.addEventListener("scroll", () => {
  if (sc) return;
  sc = setTimeout(() => {
    sc = null;
    if (sentinel.getBoundingClientRect().top < innerHeight + 800) loadMore();
  }, 150);
}, { passive: true });
function watchMore() { // 画面が空いたままなら続きを読む
  io.unobserve(sentinel);
  io.observe(sentinel);
}

$("tabs").addEventListener("click", (e) => {
  if (e.target.dataset.add) return openSettings();
  const g = e.target.dataset.g;
  if (!g || g === tab) return;
  tab = g;
  store.set("newshub.tab", g);
  renderTabs();
  window.scrollTo({ top: 0 });
  load();
});

// ---- 更新ボタン ----
$("refresh").addEventListener("click", async () => {
  const b = $("refresh");
  if (b.classList.contains("busy")) return;
  b.classList.add("busy");
  window.scrollTo({ top: 0, behavior: "smooth" });
  await load({ fresh: true });
  b.classList.remove("busy");
});

// ---- 設定（タブの表示/並び順/キーワードタブ）----
function renderSettings() {
  $("tabList").innerHTML = allTabs()
    .map((t) => `<li data-id="${esc(t.id)}" class="${prefs.hidden.includes(t.id) ? "off" : "on"}">
        <label title="クリックで表示/非表示"><input type="checkbox" ${prefs.hidden.includes(t.id) ? "" : "checked"} data-act="vis"> ${esc(t.label)}${t.custom && prefs.custom.find((c) => c.id === t.id).kw !== t.label ? ` <small class="kw">${esc(prefs.custom.find((c) => c.id === t.id).kw)}</small>` : ""}</label>
        <button data-act="del" aria-label="削除">✕</button>
      </li>`)
    .join("");
}
function commitOrder(ids) { prefs.order = ids; savePrefs(); renderSettings(); render(); }

$("tabList").addEventListener("click", (e) => {
  if (e.target.dataset.act !== "del") return;
  const id = e.target.closest("li").dataset.id;
  if (id.startsWith("k:")) prefs.custom = prefs.custom.filter((c) => c.id !== id);
  else prefs.deleted = [...prefs.deleted, id]; // 標準ジャンルは「初期化」で元に戻せる
  prefs.order = prefs.order.filter((x) => x !== id);
  prefs.hidden = prefs.hidden.filter((x) => x !== id);
  savePrefs(); renderSettings(); render();
});

// ドラッグで並び替え（行のどこでも押したまま動かせる。マウス・タッチ両対応）
let dragLi = null, pend = null, moved = false;
$("tabList").addEventListener("pointerdown", (e) => {
  if (e.button > 0 || e.target.closest("button")) return;
  const li = e.target.closest("li");
  if (!li) return;
  pend = { li, y: e.clientY, id: e.pointerId };
  moved = false;
});
$("tabList").addEventListener("pointermove", (e) => {
  if (pend && !dragLi && Math.abs(e.clientY - pend.y) > 5) {
    dragLi = pend.li;
    dragLi.classList.add("drag");
    $("tabList").setPointerCapture(pend.id);
  }
  if (!dragLi) return;
  moved = true;
  const others = [...$("tabList").children].filter((li) => li !== dragLi);
  const next = others.find((li) => {
    const r = li.getBoundingClientRect();
    // 2列の並びなので、行を上から・同じ行は左から数えて、ポインタより後ろの最初の項目の前に入れる
    return e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
  });
  $("tabList").insertBefore(dragLi, next || null);
});
const endDrag = () => {
  pend = null;
  if (!dragLi) return;
  dragLi.classList.remove("drag");
  dragLi = null;
  commitOrder([...$("tabList").children].map((li) => li.dataset.id));
};
$("tabList").addEventListener("pointerup", endDrag);
$("tabList").addEventListener("pointercancel", endDrag);
// ドラッグ直後のクリックでON/OFFが切り替わらないようにする
$("tabList").addEventListener("click", (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
$("tabList").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "vis") return;
  const li = e.target.closest("li");
  const id = li.dataset.id;
  li.classList.toggle("on", e.target.checked);
  li.classList.toggle("off", !e.target.checked);
  prefs.hidden = e.target.checked ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id];
  savePrefs(); render();
});

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const kw = $("kwInput").value.trim();
  if (!kw) return;
  const label = kw.split(/[\s、,，]+/)[0]; // タブ名は先頭のキーワード
  const id = "k:" + Date.now().toString(36);
  prefs.custom.push({ id, label, kw });
  prefs.order = [...allTabs().map((t) => t.id)]; // 末尾に追加された状態で順序を確定
  savePrefs();
  $("kwInput").value = "";
  renderSettings(); render();
});
$("resetBtn").addEventListener("click", () => {
  if (!confirm("タブの設定を初期状態に戻します。よろしいですか？")) return;
  prefs = { order: [], hidden: [], custom: [], deleted: [], init: false };
  applyDefaultTabs();
  savePrefs(); tab = "all"; renderSettings(); render();
});
let snapshot = null; // 開いた時点の設定（キャンセルで戻す）
function openSettings() {
  snapshot = { prefs: JSON.parse(JSON.stringify(prefs)), tab };
  renderSettings();
  $("settings").showModal();
}
$("closeBtn").addEventListener("click", () => { snapshot = null; $("settings").close(); });
$("cancelBtn").addEventListener("click", () => {
  if (snapshot) { prefs = snapshot.prefs; tab = snapshot.tab; savePrefs(); store.set("newshub.tab", tab); render(); }
  snapshot = null;
  $("settings").close();
});
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });

load();
setInterval(() => load({ poll: true }), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ poll: true }); });

// ---- 記事の詳細（戻る / 原文を読む）----
let readerOpen = false;
let readerToken = 0;
function openReader(item) {
  const token = ++readerToken;
  $("rTitle").textContent = item.title;
  $("rMeta").innerHTML = `<span class="tag">${esc(genres[item.genre]?.label || "")}</span><span>${esc(item.source)}</span><span>${ago(item.time)}</span>`;
  $("rOrig2").href = item.link;
  const img = $("rImg");
  img.hidden = !item.image;
  img.src = item.image || "";
  img.onerror = () => { img.hidden = true; };
  $("rText").innerHTML = item.summary ? `<p>${esc(item.summary)}</p><p class="loading">本文を読み込み中…</p>` : `<p class="loading">本文を読み込み中…</p>`;
  $("rNote").textContent = "";
  $("reader").hidden = false;
  $("reader").scrollTop = 0;
  document.body.classList.add("noscroll");
  if (!readerOpen) history.pushState({ reader: 1 }, ""); // ブラウザの「戻る」でも閉じられる
  readerOpen = true;
  fetch(`${API}/api/article?link=${encodeURIComponent(item.link)}`)
    .then((r) => r.json())
    .then((d) => {
      if (token !== readerToken) return; // 別の記事に切り替わっていたら無視
      if (d.image && !item.image) { img.src = d.image; img.hidden = false; }
      const paras = d.paragraphs?.length ? d.paragraphs : [item.summary || d.description].filter(Boolean);
      $("rText").innerHTML = paras.length ? paras.map((p) => `<p>${esc(p)}</p>`).join("") : "";
      $("rNote").textContent = d.paragraphs?.length
        ? ""
        :"本文を取得できませんでした。「原文を読む」からご覧ください。";
    })
    .catch(() => {
      if (token !== readerToken) return;
      $("rText").innerHTML = item.summary ? `<p>${esc(item.summary)}</p>` : "";
      $("rNote").textContent = "本文を取得できませんでした。「原文を読む」からご覧ください。";
    });
}
function closeReaderUI() {
  if (!readerOpen) return;
  readerOpen = false;
  $("reader").hidden = true;
  document.body.classList.remove("noscroll");
}
function backFromReader() { if (readerOpen && history.state?.reader) history.back(); else closeReaderUI(); }
$("rBack2").addEventListener("click", backFromReader);
$("reader").addEventListener("click", (e) => { if (e.target === $("reader")) backFromReader(); });
window.addEventListener("popstate", closeReaderUI);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && readerOpen && !$("settings").open) backFromReader(); });
