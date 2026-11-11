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
const DEFAULT_TABS = ["national", "world", "politics", "economy", "finance", "it", "car", "suv", "cosme", "flow"];
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
  if (Object.keys(genres).length && !prefs.deleted.includes("flow")) base.push({ id: "flow", label: "ニュース🌐" }); // カードなしの全画面ニュースバー（車ジャンルの内容）
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
// 市況の帯を出すタブと、そのデータの種類（金融=主要市況、IT=主要テック株）
const MARKET_SET = { finance: "finance", it: "it" };
async function loadMarkets() {
  const box = $("markets");
  if (box.dataset.for !== tab) { box.hidden = true; box.innerHTML = ""; box.dataset.for = tab; box.classList.remove("wrap"); } // タブが変わったら前の内容を消す
  const set = MARKET_SET[tab];
  if (!set) { if (tab !== "national") box.hidden = true; return; }
  try {
    const d = await (await fetch(`${API}/api/markets?set=${set}`)).json();
    if (MARKET_SET[tab] !== set || !d.items?.length) { box.hidden = true; return; }
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
setInterval(() => { if (MARKET_SET[tab] && !document.hidden) loadMarkets(); }, 3000);

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

// ---- 横に流れる黒い帯（注目ニュース・新車情報）。マウスを乗せると止まる ----
const tickers = { hot: [], newcar: [] };
let hotFor = "", hotAt = 0;
function renderTicker(id, label, items) {
  const box = $(id);
  tickers[id] = items;
  if (!items.length) { box.hidden = true; return; }
  const one = items.map((it, i) => `<button type="button" class="hi" data-i="${i}"><span class="hr">${esc(it.reason)}</span>${esc(it.title)}</button>`).join('<span class="hs">◆</span>');
  // 同じ並びを2回つなげて、端が切れ目なくループするようにする
  box.innerHTML = `<span class="hl">${esc(label)}</span><div class="hview"><div class="htrack">${one}<span class="hs">◆</span>${one}<span class="hs">◆</span></div></div>`;
  box.hidden = false;
  const track = box.querySelector(".htrack");
  requestAnimationFrame(() => track.style.setProperty("--dur", `${Math.max(20, Math.round(track.scrollWidth / 2 / 55))}s`)); // 速さは毎秒約55px
}
async function loadHot() {
  // キーワードタブと車タブでは出さない（車は新車情報の帯が同じ役目をするので、重ならないようにする）
  if (tab.startsWith("k:") || tab === "car") { renderTicker("hot", "注目", []); hotFor = tab; return; }
  if (hotFor === tab && Date.now() - hotAt < 5 * 60 * 1000) return;
  hotFor = tab;
  hotAt = Date.now();
  try {
    const d = await (await fetch(`${API}/api/hot?genre=${encodeURIComponent(tab)}`)).json();
    if (hotFor !== tab) return;
    if (!(d.items || []).length) hotAt = 0; // まだ用意できていないときは、次の更新でまた取りに行く
    renderTicker("hot", "注目", d.items || []);
  } catch { hotAt = 0; }
}
// ---- 特集タブ（小型SUV）: 中古車の人気ランキングのうち、全長4,600mm以下のSUVだけを一行で見せる ----
let suvAt = 0, suvList = [];
const szf = (z) => `${z.len.toFixed(2)}m×${z.wid.toFixed(2)}m×${z.hei.toFixed(2)}m`; // 全長×全幅×全高（m）
async function loadSuv() {
  const box = $("suvpanel");
  if (tab !== "suv") { box.hidden = true; return; }
  if (box.innerHTML && Date.now() - suvAt < 5 * 60 * 1000) { box.hidden = false; return; }
  suvAt = Date.now();
  try {
    const d = await (await fetch(`${API}/api/suv`)).json();
    if (tab !== "suv") return;
    suvList = d.used || [];
    if (!suvList.length) { box.hidden = true; suvAt = 0; return; }
    const chip = (c) => { const m = makerOf(c.name); return `<button type="button" class="sc" data-i="${suvList.indexOf(c)}" title="${esc(c.name)}"><span class="sr">${c.rank}位</span><span class="scn">${makerMark(m)}<span class="sn">${esc(m ? c.name.slice(m.jp.length).trim() : c.name)}</span></span><b class="pr">${c.avg ? `平均${c.avg}万円` : "相場なし"}</b>${c.size ? `<span class="ssz">${szf(c.size)}</span>` : ""}</button>`; };
    const grp = (label, list) => list.length ? `<div class="sg"><span class="sl">${label}</span><div class="sgrid">${list.map(chip).join("")}</div></div>` : "";
    box.innerHTML = `<div class="st">全長4.60m以下・現行型の中古平均価格</div>${grp("国産", suvList.filter((c) => !c.imp))}${grp("外車", suvList.filter((c) => c.imp))}`;
    box.hidden = false;
  } catch { suvAt = 0; }
}
// メーカー名 → ロゴ（Simple Icons のSVGを logos/ に置いて配信）。ロゴがないメーカーは、短い文字のバッジにする
const MAKERS = [
  ["トヨタ", "toyota", "EB0A1E"], ["ホンダ", "honda", "E40521"], ["スズキ", "suzuki", "E30613"], ["マツダ", "mazda", "101010"], ["三菱", "mitsubishi", "E60012"], ["日産", "nissan", "C3002F"], ["スバル", "subaru", "013C74"], ["ダイハツ", "daihatsu", "E60012", "wide"], ["レクサス", "", ""],
  ["ミニ", "mini", "000000"], ["ボルボ", "volvo", "003057"], ["ジープ", "jeep", "000000"], ["メルセデス・ベンツ", "mercedes", "242424"], ["メルセデス", "mercedes", "242424"], ["フォルクスワーゲン", "volkswagen", "151F5D"], ["BMW", "bmw", "0066B1"], ["ＢＭＷ", "bmw", "0066B1"], ["アウディ", "audi", "BB0A30"],
  ["プジョー", "peugeot", "000000"], ["ルノー", "renault", "FFCC33"], ["フィアット", "fiat", "941711"], ["アバルト", "", ""], ["ヒョンデ", "hyundai", "002C5E"], ["ランドローバー", "landrover", "005A2B"], ["シトロエン", "citroen", "DA291C"], ["アルファロメオ", "alfaromeo", "981E32"], ["BYD", "", ""],
].map(([jp, slug, hex, wide]) => ({ jp, slug, hex, wide }));
const makerOf = (name) => MAKERS.find((m) => name.startsWith(m.jp));
// ロゴはSVGを型紙にして、メーカーの色で塗る。黒に近い色は、暗い画面では明るい灰色にする
const lumOf = (hex) => { const n = parseInt(hex, 16); return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const makerMark = (m) => !m ? "" : m.slug
  ? `<span class="lg${lumOf(m.hex) < 0.3 ? " dk" : ""}${m.wide ? " wide" : ""}" role="img" aria-label="${esc(m.jp)}" style="--c:#${m.hex};--m:url(logos/${m.slug}.svg)"></span>`
  : `<span class="lgt">${esc(m.jp)}</span>`;
function openSuv(c) {
  const v = $("suvview");
  v.innerHTML = `<div class="svc"><button type="button" class="svx" aria-label="閉じる">✕</button>${c.img ? `<img class="svi" src="${esc(c.img)}" alt="${esc(c.name)}" referrerpolicy="no-referrer">` : '<div class="svi none">画像がありません</div>'}<h3>${makerMark(makerOf(c.name))}${esc(c.name)}</h3><p class="svp">${c.avg ? `現行型の中古車平均価格 <b>${c.avg}万円</b>` : "相場の情報がありません"}</p>${c.size ? `<p class="svg">サイズ ${szf(c.size)}　（全長×全幅×全高）</p>` : ""}<p class="svg">${esc(c.gen || "")}${c.gen ? "　／　" : ""}人気ランキング ${c.rank}位</p>${c.link ? `<a class="svl" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">カーセンサーで相場を見る ↗</a>` : ""}</div>`;
  v.hidden = false;
}
$("suvpanel").addEventListener("click", (e) => {
  const b = e.target.closest(".sc");
  if (b) { const c = suvList[Number(b.dataset.i)]; if (c) openSuv(c); }
});
$("suvview").addEventListener("click", (e) => { if (e.target === $("suvview") || e.target.closest(".svx")) $("suvview").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("suvview").hidden) $("suvview").hidden = true; });
// ---- 車タブ: 中古車の人気ランキング（国産／外車）と、新車情報の流れる帯 ----
let carAt = 0, carNews = [];
async function loadCar() {
  const box = $("markets");
  if (tab !== "car") { renderTicker("newcar", "新車", []); return; }
  if (box.dataset.for !== tab) { box.hidden = true; box.innerHTML = ""; box.dataset.for = tab; }
  if (carNews.length && !tickers.newcar.length) renderTicker("newcar", "新車", carNews);
  if (Date.now() - carAt < 60 * 1000) return;
  carAt = Date.now();
  try {
    const d = await (await fetch(`${API}/api/car`)).json();
    if (!(d.news || []).length) { carAt = 0; return; }
    const same = JSON.stringify(d.news.map((n) => n.link)) === JSON.stringify(carNews.map((n) => n.link));
    carNews = d.news;
    if (tab !== "car") return;
    box.hidden = true;
    if (same && tickers.newcar.length) return; // 変わっていなければ、流れている帯をやり直さない
    renderTicker("newcar", "新車", carNews);
  } catch { carAt = 0; }
}
// ---- 金融タブ: Investing.com のインサイダー取引記事を、1本ずつ自動で切り替えて見せる専用枠 ----
let insiderItems = [], insiderIdx = 0, insiderTimer = null, insiderAt = 0, insiderHover = false;
function showInsider() {
  const box = $("insider");
  const it = insiderItems[insiderIdx];
  if (!it) return;
  const b = box.querySelector(".ib");
  b.classList.remove("fade"); void b.offsetWidth; b.classList.add("fade");
  b.textContent = it.title;
  box.querySelector(".ic").textContent = `${insiderIdx + 1}/${insiderItems.length}`;
}
async function loadInsider() {
  const box = $("insider");
  if (tab !== "finance") { box.hidden = true; clearInterval(insiderTimer); insiderTimer = null; return; }
  if (insiderItems.length && Date.now() - insiderAt < 3 * 60 * 1000) {
    box.hidden = false;
    if (!insiderTimer) insiderTimer = setInterval(() => { if (!insiderHover && !document.hidden && tab === "finance") { insiderIdx = (insiderIdx + 1) % insiderItems.length; showInsider(); } }, 5000);
    return;
  }
  insiderAt = Date.now();
  try {
    const d = await (await fetch(`${API}/api/insider`)).json();
    if (tab !== "finance") return;
    insiderItems = d.items || [];
    if (!insiderItems.length) { box.hidden = true; insiderAt = 0; return; }
    insiderIdx = 0;
    box.innerHTML = '<span class="hs2">Investing.com</span><button type="button" class="ib"></button><span class="ic"></span>';
    box.hidden = false;
    showInsider();
    clearInterval(insiderTimer);
    insiderTimer = setInterval(() => { if (!insiderHover && !document.hidden && tab === "finance") { insiderIdx = (insiderIdx + 1) % insiderItems.length; showInsider(); } }, 5000);
  } catch { insiderAt = 0; }
}
$("insider").addEventListener("mouseenter", () => { insiderHover = true; });
$("insider").addEventListener("mouseleave", () => { insiderHover = false; });
$("insider").addEventListener("click", (e) => {
  if (!e.target.closest(".ib")) return;
  const it = insiderItems[insiderIdx];
  if (it) { markRead(it.link); openReader(it); }
});
for (const id of ["hot", "newcar"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(".hi");
    if (!b) return;
    const it = tickers[id][Number(b.dataset.i)];
    if (it) { markRead(it.link); openReader(it); }
  });
}
setInterval(() => { if (tab === "car" && !document.hidden) loadCar(); }, 60000);

// ---- ニュース🌐: カードなし・ヘッダーなしの全画面。全ジャンルの記事から無作為に選んだタイトルが、光る地球の表面に並んでゆっくり回る ----
// 手前の半球のタイトルだけが見え、正面に来たものは画像つきのカードになる。ドラッグ（指でも）で好きな向きに回せる。時計つき（待機画面用）
let flowItems = [], flowPool = [], flowAt = 0, flowEls = [], flowPts = [], flowRaf = 0, flowW = [], flowOp = [], flowRep = [], flowMaxc = 24;
let flowFeat = -1, flowBad = new Set(), flowStars = [], flowShoot = null, flowShootAt = 0, flowClockKey = "";
const flowShuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// 全ジャンルから無作為に56件。正面でカードになれるよう、画像つきの記事を半分ほど入れる
const flowPick = () => { const sh = flowShuffle(flowPool); const withImg = sh.filter((x) => x.image), no = sh.filter((x) => !x.image); return flowShuffle([...withImg.slice(0, 28), ...no.slice(0, 28), ...withImg.slice(28), ...no.slice(28)].slice(0, 56)); };
const flowRot = { ax: 0.4, ay: 0, vx: 0, vy: 0, drag: false };
const FLOW_AUTO = 0.11; // ふだんの回転（ラジアン/秒）。約57秒で一周
// ジャンルごとのネオンの色（色相）
const GENRE_HUE = { politics: 215, economy: 45, finance: 50, car: 20, suv: 20, cosme: 330, national: 190, world: 170, sports: 130, entertainment: 320, it: 195, science: 260, life: 90, gourmet: 25, health: 150, travel: 175, game: 275, watch: 40 };
const flowHue = (it) => GENRE_HUE[it.genre] ?? 200;
function flowStyle(el, it) {
  const h = flowHue(it);
  el.style.color = `hsl(${h},100%,80%)`;
  el.style.textShadow = `0 0 5px hsla(${h},100%,60%,.95), 0 0 14px hsla(${h},100%,55%,.55)`;
}
async function startFlow() {
  const box = $("flow");
  box.hidden = false;
  document.body.classList.add("flowing");
  if (flowEls.length && Date.now() - flowAt < 3 * 60 * 1000) { runFlow(); return; }
  if (flowPool.length && Date.now() - flowAt < 3 * 60 * 1000) { flowItems = flowPick(); buildFlow(); runFlow(); return; } // 戻ってくるたびに、選び直す
  flowAt = Date.now();
  try {
    const d = await (await fetch(`${API}/api/news?genre=all&limit=150&offset=0`)).json();
    if (tab !== "flow") return;
    flowPool = d.items || [];
    flowItems = flowPick();
    buildFlow();
    runFlow();
  } catch { flowAt = 0; }
}
function stopFlow() { flowEls = []; $("flow").hidden = true; document.body.classList.remove("flowing"); cancelAnimationFrame(flowRaf); flowRaf = 0; }
function buildFlow() {
  const sp = $("flowsp");
  const n = flowItems.length;
  let html = "";
  flowPts = []; flowW = []; flowOp = []; flowRep = []; flowFeat = -1;
  $("flowfeat").hidden = true;
  const maxc = flowMaxc = $("flow").clientWidth < 600 ? 14 : 24; // 狭い画面では短く切る
  flowItems.forEach((it, i) => {
    // 球面にほぼ均等に並べる（フィボナッチ螺旋）
    const y = n > 1 ? 1 - (2 * (i + 0.5)) / n : 0;
    const r = Math.sqrt(1 - y * y), th = i * 2.399963;
    flowPts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    const t = it.title.length > maxc ? it.title.slice(0, maxc - 1) + "…" : it.title;
    html += `<button type="button" class="sp" data-i="${i}">${esc(t)}</button>`;
  });
  sp.innerHTML = html;
  flowEls = [...sp.querySelectorAll(".sp")];
  flowEls.forEach((el, i) => flowStyle(el, flowItems[i]));
}
// 後ろに回って見えなくなったタイトルを、いま出ていない別のニュースに差し替える
function flowSwap(i) {
  const shown = new Set(flowItems.map((x) => x.link));
  let cand = flowPool.filter((x) => !shown.has(x.link));
  if (!cand.length) return;
  const ci = cand.filter((x) => x.image);
  if (ci.length && Math.random() < 0.5) cand = ci; // 半分は画像つき
  const it = cand[Math.floor(Math.random() * cand.length)];
  flowItems[i] = it;
  const el = flowEls[i];
  el.textContent = it.title.length > flowMaxc ? it.title.slice(0, flowMaxc - 1) + "…" : it.title;
  flowStyle(el, it);
  flowW[i] = 0; // 幅を測り直す
  if (flowFeat === i) flowFeat = -1;
}
// 時計（待機画面用）。秒が変わるたびに更新
function flowClock() {
  const d = new Date();
  const key = `${d.getHours()}:${d.getMinutes()}`;
  if (key === flowClockKey) return;
  flowClockKey = key;
  const w = "日月火水木金土"[d.getDay()];
  $("flowclock").innerHTML = `<b>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</b><span>${d.getMonth() + 1}月${d.getDate()}日（${w}）</span>`;
}
// 背景: 星空・地球の大気の光・緯線と経線・ときどき流れ星
function flowDraw(cv, W, H, Rx, Ry, ca, sa, cb, sb, t) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); flowStars = []; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!flowStars.length) for (let i = 0; i < 150; i++) flowStars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + 0.3, p: Math.random() * 6.28, s: 0.6 + Math.random() * 1.8 });
  for (const s of flowStars) {
    g.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(t * s.s + s.p));
    g.fillStyle = "#dbe8ff";
    g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.2832); g.fill();
  }
  g.globalAlpha = 1;
  // 流れ星
  if (!flowShoot && t > flowShootAt) { flowShoot = { x: Math.random() * W * 0.7, y: Math.random() * H * 0.4, t0: t }; flowShootAt = t + 5 + Math.random() * 7; }
  if (flowShoot) {
    const k = (t - flowShoot.t0) / 0.9;
    if (k >= 1) flowShoot = null;
    else {
      const x = flowShoot.x + k * W * 0.3, y = flowShoot.y + k * H * 0.22;
      const gr = g.createLinearGradient(x, y, x - W * 0.09, y - H * 0.066);
      gr.addColorStop(0, `rgba(255,255,255,${1 - k})`); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.strokeStyle = gr; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - W * 0.09, y - H * 0.066); g.stroke();
    }
  }
  // 大気の光
  g.save();
  g.translate(W / 2, H / 2); g.scale(Rx, Ry);
  const atm = g.createRadialGradient(0, 0, 0.7, 0, 0, 1.3);
  atm.addColorStop(0, "rgba(40,110,255,0.10)"); atm.addColorStop(0.62, "rgba(70,150,255,0.28)"); atm.addColorStop(0.78, "rgba(120,200,255,0.12)"); atm.addColorStop(1, "rgba(80,160,255,0)");
  g.fillStyle = atm; g.beginPath(); g.arc(0, 0, 1.3, 0, 6.2832); g.fill();
  g.restore();
  // 緯線・経線（手前の半球だけ）
  const proj = (x, y, z) => { const y1 = y * ca - z * sa, z1 = y * sa + z * ca; return [x * cb + z1 * sb, -y1, -x * sb + z1 * cb]; };
  g.lineWidth = 1;
  const seg = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a[2] <= 0 || b[2] <= 0) continue;
      g.globalAlpha = 0.07 + 0.3 * ((a[2] + b[2]) / 2);
      g.strokeStyle = "#7fc3ff";
      g.beginPath(); g.moveTo(W / 2 + a[0] * Rx, H / 2 + a[1] * Ry); g.lineTo(W / 2 + b[0] * Rx, H / 2 + b[1] * Ry); g.stroke();
    }
  };
  for (let lat = -60; lat <= 60; lat += 30) {
    const f = lat * 0.017453, pts = [];
    for (let lon = 0; lon <= 360; lon += 6) { const l = lon * 0.017453; pts.push(proj(Math.cos(f) * Math.cos(l), Math.sin(f), Math.cos(f) * Math.sin(l))); }
    seg(pts);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const l = lon * 0.017453, pts = [];
    for (let lat = -90; lat <= 90; lat += 6) { const f = lat * 0.017453; pts.push(proj(Math.cos(f) * Math.cos(l), Math.sin(f), Math.cos(f) * Math.sin(l))); }
    seg(pts);
  }
  // 輪郭の光
  g.globalAlpha = 0.55;
  g.strokeStyle = "#9fd4ff"; g.lineWidth = 1.5; g.shadowColor = "#4aa8ff"; g.shadowBlur = 18;
  g.beginPath(); g.ellipse(W / 2, H / 2, Rx, Ry, 0, 0, 6.2832); g.stroke();
  g.shadowBlur = 0; g.globalAlpha = 1;
}
function runFlow() {
  if (flowRaf || tab !== "flow") return;
  let last = performance.now();
  const frame = (now) => {
    flowRaf = 0;
    if (tab !== "flow" || document.hidden) { if (tab === "flow") flowRaf = requestAnimationFrame((t) => { last = t; frame(t); }); return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const R = flowRot;
    if (!R.drag) {
      R.vx += (FLOW_AUTO - R.vx) * Math.min(1, dt * 2); // 手を離したら、勢いが静まってゆっくりの回転に戻る
      R.vy += (0 - R.vy) * Math.min(1, dt * 2);
      R.ax += R.vx * dt;
      R.ay += R.vy * dt;
    }
    const box = $("flow"), W = box.clientWidth, H = box.clientHeight;
    const Rx = W * 0.3, Ry = H * 0.36, base = Math.max(13, Math.min(20, H * 0.026));
    const ca = Math.cos(R.ax), sa = Math.sin(R.ax), cb = Math.cos(R.ay), sb = Math.sin(R.ay);
    flowDraw($("flowcv"), W, H, Rx, Ry, ca, sa, cb, sb, now / 1000);
    flowClock();
    // 1) 各タイトルの位置を計算
    const pr = [];
    for (let i = 0; i < flowEls.length; i++) {
      const p = flowPts[i];
      const y1 = p[1] * ca - p[2] * sa, z1 = p[1] * sa + p[2] * ca; // 横軸まわり（正面が上から下へ動く）
      const x2 = p[0] * cb + z1 * sb, z2 = -p[0] * sb + z1 * cb; // 縦軸まわり（ドラッグの左右）
      const d = (z2 + 1) / 2; // 0=奥 1=手前
      const sy = -y1; // 画面では下が正
      // 後ろ半球に回ったタイトルは、見えないうちに別のニュースへ差し替える（背面から同じ記事が回ってこない）
      if (z2 < -0.2 && !flowRep[i]) { flowSwap(i); flowRep[i] = true; flowOp[i] = 0; }
      else if (z2 > 0.2) flowRep[i] = false;
      let op = Math.max(0, Math.min(1, (z2 - 0.05) / 0.35)); // 手前の半球（z>0）だけ見せる。奥の半球は完全に消す（マウスと逆向きに動いて見えるのを防ぐ）
      if (sy > 0.35) op *= Math.max(0, 1 - (sy - 0.35) / 0.45); // 下に回ったら消える
      pr.push({ i, z: z2, x: x2 * Rx + W / 2, y: sy * Ry + H / 2, d, op, sc: 0.42 + 1.2 * d * d });
    }
    // 2) 正面（球の中心に近い手前）の、画像つきの記事を1本選んで、カードにする
    const dist = (q) => Math.hypot((q.x - W / 2) / Rx, (q.y - H / 2) / Ry);
    const okFeat = (q) => q.z > 0.5 && (flowOp[q.i] ?? 0) > 0.5 && flowItems[q.i].image && !flowBad.has(flowItems[q.i].image);
    let best = null;
    for (const q of pr) if (okFeat(q) && (!best || q.z - 0.7 * dist(q) > best.z - 0.7 * dist(best))) best = q;
    const curQ = flowFeat >= 0 ? pr[flowFeat] : null;
    if (best && (!curQ || !okFeat(curQ) || (best.i !== flowFeat && best.z - 0.7 * dist(best) > curQ.z - 0.7 * dist(curQ) + 0.2))) flowFeat = best.i;
    else if (curQ && !okFeat(curQ)) flowFeat = -1;
    const ff = $("flowfeat");
    const fq = flowFeat >= 0 ? pr[flowFeat] : null;
    if (fq) {
      const it = flowItems[flowFeat];
      if (ff.dataset.link !== it.link) {
        ff.dataset.link = it.link; ff.dataset.i = String(flowFeat);
        const h = flowHue(it);
        ff.style.setProperty("--h", String(h));
        ff.innerHTML = `<img src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="flowBad.add(this.src);this.closest('.ff').hidden=true"><span class="fg">${esc(genres[it.genre]?.label || "")}</span><b>${esc(it.title)}</b>`;
        ff.classList.remove("in"); void ff.offsetWidth; ff.classList.add("in");
      }
      ff.dataset.i = String(flowFeat);
      ff.hidden = false;
      ff.style.transform = `translate(-50%,-50%) translate(${fq.x.toFixed(1)}px,${fq.y.toFixed(1)}px) scale(${Math.min(fq.sc * 0.95, 1.2).toFixed(3)})`; // 大きくなりすぎてスマホの画面からはみ出さないように上限
      ff.style.opacity = Math.min(1, (flowOp[flowFeat] ?? 0) + 0.2).toFixed(3);
    } else { ff.hidden = true; ff.dataset.link = ""; }
    // 3) 手前のものから順に、すでに出ているタイトルと大きく重なるものは薄くして消す（ぎゅっと重ならないように）
    const order = pr.slice().sort((p, q) => q.d - p.d);
    const placed = [];
    if (fq) { const fk = Math.min(fq.sc * 0.95, 1.2), w = 230 * fk, h = 170 * fk; placed.push({ x0: fq.x - w / 2, x1: fq.x + w / 2, y0: fq.y - h / 2, y1: fq.y + h / 2, a: w * h }); }
    for (const q of order) {
      const el = flowEls[q.i];
      if (!flowW[q.i]) flowW[q.i] = el.offsetWidth || 200;
      const w = flowW[q.i] * q.sc, h = base * 1.5 * q.sc;
      let target = q.op;
      if (fq && q.i === flowFeat) target = 0; // カードになったものは、元のタイトルを消す
      else if (target > 0.25) {
        const bx0 = q.x - w / 2, bx1 = q.x + w / 2, by0 = q.y - h / 2, by1 = q.y + h / 2;
        for (const o of placed) {
          const ox = Math.min(bx1, o.x1) - Math.max(bx0, o.x0), oy = Math.min(by1, o.y1) - Math.max(by0, o.y0);
          if (ox > 0 && oy > 0 && (ox * oy) / Math.min(w * h, o.a) > 0.12) { target = 0; break; }
        }
        if (target > 0) placed.push({ x0: bx0, x1: bx1, y0: by0, y1: by1, a: w * h });
      }
      const cur = flowOp[q.i] ?? 0;
      let next = cur + (target - cur) * Math.min(1, dt * 7); // 出たり消えたりをなめらかに
      if (q.z <= 0.02) next = 0; // 後ろの半球に入ったら、その場で消す
      flowOp[q.i] = next;
      el.style.opacity = next.toFixed(3);
      el.style.visibility = next < 0.02 ? "hidden" : "visible";
      el.style.zIndex = String(Math.round(q.d * 100));
      el.style.fontSize = base + "px";
      el.style.transform = `translate(-50%,-50%) translate(${q.x.toFixed(1)}px,${q.y.toFixed(1)}px) scale(${q.sc.toFixed(3)})`;
    }
    flowRaf = requestAnimationFrame(frame);
  };
  flowRaf = requestAnimationFrame((t) => { last = t; frame(t); });
}
{
  const box = $("flow");
  let sx = 0, sy = 0, lx = 0, ly = 0, lt = 0, moved = 0, downEl = null;
  box.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".fclose")) return;
    flowRot.drag = true; moved = 0; downEl = e.target.closest(".sp, .ff");
    sx = lx = e.clientX; sy = ly = e.clientY; lt = performance.now();
    try { box.setPointerCapture(e.pointerId); } catch {}
  });
  box.addEventListener("pointermove", (e) => {
    if (!flowRot.drag) return;
    const now = performance.now(), dt = Math.max(0.001, (now - lt) / 1000);
    const dx = e.clientX - lx, dy = e.clientY - ly;
    moved = Math.max(moved, Math.hypot(e.clientX - sx, e.clientY - sy));
    // 球の大きさに合わせて回す: つかんだ場所の面が、マウスにぴったりついてくる（球の上でも、タイトルの上でも、背景でも同じ）
    const kx = 1 / (box.clientWidth * 0.3), ky = 1 / (box.clientHeight * 0.36);
    flowRot.ay += dx * kx; flowRot.ax += dy * ky;
    flowRot.vy = Math.max(-4, Math.min(4, (dx * kx) / dt)); flowRot.vx = Math.max(-4, Math.min(4, (dy * ky) / dt));
    lx = e.clientX; ly = e.clientY; lt = now;
  });
  const up = () => {
    if (!flowRot.drag) return;
    flowRot.drag = false;
    if (performance.now() - lt > 120) { flowRot.vx = FLOW_AUTO; flowRot.vy = 0; } // 止めてから離したときは勢いなし
    if (moved < 6 && downEl) { const it = flowItems[Number(downEl.dataset.i)]; if (it) { markRead(it.link); openReader(it); } }
    downEl = null;
  };
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", () => { flowRot.drag = false; downEl = null; });
  box.addEventListener("wheel", (e) => { e.preventDefault(); flowRot.ax -= e.deltaY * 0.002; }, { passive: false });
  box.addEventListener("click", (e) => {
    if (e.target.closest(".fclose")) { tab = "all"; store.set("newshub.tab", "all"); renderTabs(); load(); }
  });
}

// 先頭から読み直す（タブ切り替え・更新ボタン・自動更新）
async function load({ fresh = false, poll = false } = {}) {
  const id = ++reqId;
  if (tab === "flow") { startFlow(); return; }
  stopFlow();
  loadMarkets();
  loadWeather();
  loadHot();
  loadCar();
  loadSuv();
  loadInsider();
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
