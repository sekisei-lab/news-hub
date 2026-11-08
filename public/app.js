const API = (window.NEWS_API_BASE || "").replace(/\/$/, "");
const POLL_MS = 60 * 1000; // 1分ごとに自動更新
const $ = (id) => document.getElementById(id);

// ---- 保存（このブラウザだけ。他の人には影響しない）----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let prefs = store.get("newshub.prefs", { order: [], hidden: [], custom: [], deleted: [] });
prefs.deleted ||= []; // 削除したジャンル（標準ジャンルも削除できる）
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
function filtered() {
  if (tab === "all") return items;
  if (tab.startsWith("k:")) {
    const kws = keywords(tab);
    return items.filter((i) => {
      const text = `${i.title} ${i.summary || ""}`.toLowerCase();
      return kws.some((k) => text.includes(k));
    });
  }
  return items.filter((i) => i.genres.includes(tab));
}

function renderTabs() {
  const vis = visibleTabs();
  if (tab !== "all" && !vis.some((t) => t.id === tab)) tab = "all";
  $("tabs").innerHTML = [{ id: "all", label: "すべて" }, ...vis]
    .map((t) => `<button data-g="${esc(t.id)}" class="${t.id === tab ? "on" : ""}">${esc(t.label)}</button>`)
    .join("") + `<button class="add" data-add="1">＋ 追加・編集</button>`; // タブ列の末尾からも設定を開ける
}

let shown = []; // いま画面に出している記事（カード番号と対応）
let dirty = false; // カード展開中に更新が来たら、閉じた後に描画する
function renderList() {
  if (document.querySelector(".cell.open")) { dirty = true; return; }
  dirty = false;
  const list = filtered();
  shown = list;
  $("list").innerHTML = list.length
    ? list.map((i, n) => `<div class="cell"><a class="card" data-n="${n}" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">
        ${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <h2>${esc(i.title)}</h2>
        <p>${esc(i.summary || "")}</p>
        <div class="meta"><span class="tag">${esc(genres[i.genre]?.label || "")}</span><span>${esc(i.source)}</span><span>${ago(i.time)}</span></div>
      </a></div>`).join("")
    : `<div class="empty">該当する記事がありません</div>`;
  markOverflow();
}
// 概要が2行を超えるカードだけ「展開できる」印を付ける
function markOverflow() {
  for (const cell of document.querySelectorAll(".cell")) {
    const p = cell.querySelector("p");
    cell.classList.toggle("more", !!p && p.scrollHeight > p.clientHeight + 1);
  }
}
let rz;
window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(markOverflow, 200); });

// 概要の展開: マウスを乗せる（タッチはタップ）と6行まで開く。周りのカードは動かさない
function openCell(cell) {
  if (cell.classList.contains("open") || !cell.classList.contains("more")) return;
  cell.style.height = cell.offsetHeight + "px"; // 場所を確保して、下のカードがずれないようにする
  cell.classList.add("open");
}
function closeCell(cell) {
  cell.classList.remove("open");
  cell.style.height = "";
  if (dirty && !document.querySelector(".cell.open")) renderList();
}
const touchOnly = matchMedia("(hover: none)");
$("list").addEventListener("mouseover", (e) => {
  if (touchOnly.matches) return;
  const cell = e.target.closest?.(".cell");
  if (cell) openCell(cell);
});
$("list").addEventListener("mouseout", (e) => {
  if (touchOnly.matches) return;
  const cell = e.target.closest?.(".cell");
  if (cell && !cell.contains(e.relatedTarget)) closeCell(cell);
});
// カードをクリック/タップすると、新しいタブではなくサイト内の詳細表示を開く（Ctrl/中クリックは従来どおり原文へ）
$("list").addEventListener("click", (e) => {
  const card = e.target.closest?.(".card");
  if (!card || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const item = shown[Number(card.dataset.n)];
  if (item) openReader(item);
});

function render() {
  renderTabs();
  renderList();
  if (updatedAt) $("status").textContent = new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

async function load(fresh = false) {
  try {
    const r = await fetch(`${API}/api/news?genre=all${fresh ? "&fresh=1" : ""}`);
    const d = await r.json();
    genres = d.genres;
    items = d.items;
    updatedAt = d.updatedAt;
    render();
  } catch {
    $("status").textContent = "再試行中";
  }
}

$("tabs").addEventListener("click", (e) => {
  if (e.target.dataset.add) return openSettings();
  const g = e.target.dataset.g;
  if (!g) return;
  tab = g;
  store.set("newshub.tab", g);
  render();
  window.scrollTo({ top: 0 });
});

// ---- 更新ボタン ----
$("refresh").addEventListener("click", async () => {
  const b = $("refresh");
  if (b.classList.contains("busy")) return;
  b.classList.add("busy");
  window.scrollTo({ top: 0, behavior: "smooth" });
  await load(true);
  b.classList.remove("busy");
});

// ---- 設定（タブの表示/並び順/キーワードタブ）----
function renderSettings() {
  $("tabList").innerHTML = allTabs()
    .map((t) => `<li data-id="${esc(t.id)}">
        <span class="grip" title="ドラッグして並び替え" aria-label="ドラッグして並び替え">⠿</span>
        <label><input type="checkbox" ${prefs.hidden.includes(t.id) ? "" : "checked"} data-act="vis"> ${esc(t.label)}${t.custom ? ` <small class="kw">${esc(prefs.custom.find((c) => c.id === t.id).kw)}</small>` : ""}</label>
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

// ドラッグで並び替え（マウス・タッチ両対応）
let dragLi = null;
$("tabList").addEventListener("pointerdown", (e) => {
  const grip = e.target.closest(".grip");
  if (!grip) return;
  dragLi = grip.closest("li");
  dragLi.classList.add("drag");
  $("tabList").setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("tabList").addEventListener("pointermove", (e) => {
  if (!dragLi) return;
  const others = [...$("tabList").children].filter((li) => li !== dragLi);
  const next = others.find((li) => {
    const r = li.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  $("tabList").insertBefore(dragLi, next || null);
});
const endDrag = () => {
  if (!dragLi) return;
  dragLi.classList.remove("drag");
  dragLi = null;
  commitOrder([...$("tabList").children].map((li) => li.dataset.id));
};
$("tabList").addEventListener("pointerup", endDrag);
$("tabList").addEventListener("pointercancel", endDrag);
$("tabList").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "vis") return;
  const id = e.target.closest("li").dataset.id;
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
  prefs = { order: [], hidden: [], custom: [], deleted: [] };
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
setInterval(() => load(), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

// ---- 記事の詳細（戻る / 原文を読む）----
let readerOpen = false;
let readerToken = 0;
function openReader(item) {
  const token = ++readerToken;
  $("rTitle").textContent = item.title;
  $("rMeta").innerHTML = `<span class="tag">${esc(genres[item.genre]?.label || "")}</span><span>${esc(item.source)}</span><span>${ago(item.time)}</span>`;
  for (const id of ["rOrig", "rOrig2"]) $(id).href = item.link;
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
        ? "※本文は冒頭のみ表示しています。続きは「原文を読む」からご覧ください。"
        : "本文を取得できませんでした。「原文を読む」からご覧ください。";
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
  if (dirty) renderList();
}
function backFromReader() { if (readerOpen && history.state?.reader) history.back(); else closeReaderUI(); }
for (const id of ["rBack", "rBack2"]) $(id).addEventListener("click", backFromReader);
$("reader").addEventListener("click", (e) => { if (e.target === $("reader")) backFromReader(); });
window.addEventListener("popstate", closeReaderUI);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && readerOpen && !$("settings").open) backFromReader(); });
