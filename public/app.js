const API = (window.NEWS_API_BASE || "").replace(/\/$/, "");
const POLL_MS = 60 * 1000; // 1分ごとに自動更新
const $ = (id) => document.getElementById(id);
let genre = localStorage.getItem("genre") || "all";
let genres = {};

function ago(t) {
  if (!t) return "";
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderTabs() {
  const all = [["all", "すべて"], ...Object.entries(genres).map(([k, v]) => [k, v.label])];
  $("tabs").innerHTML = all.map(([k, l]) => `<button data-g="${k}" class="${k === genre ? "on" : ""}">${l}</button>`).join("");
}

async function load() {
  try {
    const r = await fetch(`${API}/api/news?genre=${genre}`);
    const d = await r.json();
    genres = d.genres;
    renderTabs();
    $("list").innerHTML = d.items.length
      ? d.items.map((i) => `<a class="card" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">
          <h2>${esc(i.title)}</h2>
          <p>${esc(i.summary || "")}</p>
          <div class="meta"><span class="tag">${esc(genres[i.genre]?.label || "")}</span><span>${esc(i.source)}</span><span>${ago(i.time)}</span></div>
        </a>`).join("")
      : `<div class="empty">記事がありません</div>`;
    $("status").textContent = `更新 ${new Date(d.updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    $("status").textContent = "取得に失敗しました（再試行します）";
  }
}

$("tabs").addEventListener("click", (e) => {
  const g = e.target.dataset.g;
  if (!g) return;
  genre = g;
  localStorage.setItem("genre", g);
  renderTabs();
  load();
});

load();
setInterval(load, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
