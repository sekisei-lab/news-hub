const API = (window.NEWS_API_BASE || "").replace(/\/$/, "");
const POLL_MS = 60 * 1000; // 1分ごとに自動更新
const $ = (id) => document.getElementById(id);

// ---- 保存（このブラウザだけ。他の人には影響しない）----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let prefs = store.get("newshub.prefs", { order: [], hidden: [], custom: [] });
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
  const base = Object.entries(genres).map(([id, g]) => ({ id, label: g.label }));
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
    .join("");
}

function renderList() {
  const list = filtered();
  $("list").innerHTML = list.length
    ? list.map((i) => `<a class="card" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">
        ${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <h2>${esc(i.title)}</h2>
        <p>${esc(i.summary || "")}</p>
        <div class="meta"><span class="tag">${esc(genres[i.genre]?.label || "")}</span><span>${esc(i.source)}</span><span>${ago(i.time)}</span></div>
      </a>`).join("")
    : `<div class="empty">該当する記事がありません</div>`;
}
function render() {
  renderTabs();
  renderList();
  if (updatedAt) $("status").textContent = `更新 ${new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
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
    $("status").textContent = "取得に失敗しました（再試行します）";
  }
}

$("tabs").addEventListener("click", (e) => {
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
  const tabs = allTabs();
  $("tabList").innerHTML = tabs
    .map((t, idx) => `<li data-id="${esc(t.id)}">
        <label><input type="checkbox" ${prefs.hidden.includes(t.id) ? "" : "checked"} data-act="vis"> ${esc(t.label)}${t.custom ? ` <small class="kw">${esc(prefs.custom.find((c) => c.id === t.id).kw)}</small>` : ""}</label>
        <span class="ops">
          <button data-act="up" ${idx === 0 ? "disabled" : ""} aria-label="上へ">▲</button>
          <button data-act="down" ${idx === tabs.length - 1 ? "disabled" : ""} aria-label="下へ">▼</button>
          ${t.custom ? `<button data-act="del" aria-label="削除">✕</button>` : ""}
        </span>
      </li>`)
    .join("");
}
function commitOrder(ids) { prefs.order = ids; savePrefs(); renderSettings(); render(); }

$("tabList").addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  const li = e.target.closest("li");
  if (!act || !li) return;
  const id = li.dataset.id;
  const ids = allTabs().map((t) => t.id);
  const i = ids.indexOf(id);
  if (act === "up" && i > 0) { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; commitOrder(ids); }
  if (act === "down" && i < ids.length - 1) { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; commitOrder(ids); }
  if (act === "del") {
    prefs.custom = prefs.custom.filter((c) => c.id !== id);
    prefs.order = prefs.order.filter((x) => x !== id);
    prefs.hidden = prefs.hidden.filter((x) => x !== id);
    savePrefs(); renderSettings(); render();
  }
});
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
  const label = $("labelInput").value.trim() || kw.split(/[\s、,，]+/)[0];
  const id = "k:" + Date.now().toString(36);
  prefs.custom.push({ id, label, kw });
  prefs.order = [...allTabs().map((t) => t.id)]; // 末尾に追加された状態で順序を確定
  savePrefs();
  $("kwInput").value = "";
  $("labelInput").value = "";
  renderSettings(); render();
});
$("resetBtn").addEventListener("click", () => {
  if (!confirm("タブの設定を初期状態に戻します。よろしいですか？")) return;
  prefs = { order: [], hidden: [], custom: [] };
  savePrefs(); tab = "all"; renderSettings(); render();
});
$("settingsBtn").addEventListener("click", () => { renderSettings(); $("settings").showModal(); });
$("closeBtn").addEventListener("click", () => $("settings").close());
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });

load();
setInterval(() => load(), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
