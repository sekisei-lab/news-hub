// News Hub server — 依存ライブラリなし (Node 18+)
// RSSを定期取得 → 概要を整形 → /api/news で配信。public/ も同時に配信。
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 3 * 60 * 1000; // フィード再取得間隔
const MAX_PER_GENRE = 400;
const UA = "Mozilla/5.0 (compatible; NewsHub/1.0)";

const GENRES = {
  politics: { label: "政治" },
  economy: { label: "経済" },
  finance: { label: "金融" },
  car: { label: "車" },
  cosme: { label: "コスメ" },
  national: { label: "国内" },
  world: { label: "国際" },
  sports: { label: "スポーツ" },
  entertainment: { label: "エンタメ" },
  it: { label: "IT" },
  science: { label: "科学" },
  life: { label: "ライフ" },
  gourmet: { label: "グルメ" },
  health: { label: "健康" },
  travel: { label: "旅行" },
  game: { label: "ゲーム" },
  watch: { label: "腕時計" },
};

// 広告・PR記事は除外
const AD_RE = /［PR］|\[PR\]|【PR】|\bPR\b|PR TIMES|プレスリリース|Sponsored/i;
const { FEEDS } = require("./feeds");
const makeExtractor = require("./article");

// ---------- 取得・パース ----------
async function fetchText(url, timeout = 15000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 1024));
    charset = /encoding=["']([\w-]+)|charset=["']?([\w-]+)/i.exec(head)?.slice(1).find(Boolean);
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function clean(s = "") {
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = decode(s);
  s = s.replace(/<[^>]*>/g, " "); // HTMLタグ除去
  s = decode(s);
  return s.replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1] : "";
}
function absUrl(u, base) {
  if (!u) return "";
  try {
    const x = new URL(decode(u), base).href;
    return x.startsWith("http") ? x.replace(/^http:\/\//, "https://") : "";
  } catch {
    return "";
  }
}
// RSS内の画像: media:content / media:thumbnail / enclosure / 本文中の<img>
function findImage(block, base) {
  const raw = block.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const cands = [
    /<media:(?:content|thumbnail)[^>]+url=["']([^"']+)/i.exec(raw)?.[1],
    /<enclosure[^>]+type=["']image[^>]+url=["']([^"']+)/i.exec(raw)?.[1],
    /<enclosure[^>]+url=["']([^"']+\.(?:jpe?g|png|webp))/i.exec(raw)?.[1],
    /<img[^>]+src=["']([^"']+)/i.exec(decode(raw))?.[1],
  ];
  for (const c of cands) {
    const u = absUrl(c, base);
    if (u && !/pixel|spacer|\.gif(\?|$)|logo/i.test(u)) return u;
  }
  return "";
}
function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => {
    let link = clean(tag(b, "link"));
    if (!link) link = /<link[^>]*href=["']([^"']+)/i.exec(b)?.[1] || "";
    const cats = [...b.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => clean(m[1])).join(" ");
    const date = clean(tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated"));
    const t = Date.parse(date);
    return {
      title: clean(tag(b, "title")),
      link,
      desc: clean(tag(b, "description") || tag(b, "content:encoded") || tag(b, "summary")),
      image: findImage(b, link),
      cats,
      time: isNaN(t) ? 0 : t,
    };
  });
}

// ---------- 概要の整形 ----------
const SUMMARY_LEN = 260; // 展開時の6行分の目安（通常表示は2行に切り詰め）
function trimSummary(s, title) {
  if (!s) return "";
  s = s.replace(/\s*(続きを読む|Read more|\[…\]|…続きを読む).*$/i, "").trim();
  if (s === title || s.startsWith(title)) s = s.slice(title.length).replace(/^[\s:：\-－―]+/, "");
  if (s.length > SUMMARY_LEN) s = s.slice(0, SUMMARY_LEN).replace(/[、,\s]+$/, "") + "…";
  return s;
}
const GENERIC_DESC = /最新の見出しを提供|最新ニュース|ニュースサイト|NHKニュース$/;

// 概要が空のとき記事ページの og:description を取得（URLごとにキャッシュ）
const ogCache = new Map();
async function fetchOg(url) {
  if (ogCache.has(url)) return ogCache.get(url);
  const v = { desc: "", image: "" };
  try {
    const html = (await fetchText(url, 8000)).slice(0, 200000);
    const meta = (re) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["'](?:${re})["'][^>]*content=["']([^"']*)["']`, "i").exec(html) ||
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${re})["']`, "i").exec(html);
      return m ? clean(m[1]) : "";
    };
    v.desc = meta("og:description|description");
    v.image = absUrl(meta("og:image|twitter:image"), url);
  } catch {}
  if (ogCache.size > 3000) ogCache.delete(ogCache.keys().next().value);
  ogCache.set(url, v);
  return v;
}

const feedCache = new Map(); // url -> { etag, lastMod, items }
async function fetchFeedItems(url) {
  const c = feedCache.get(url);
  const headers = { "User-Agent": UA, Accept: "*/*" };
  if (c?.etag) headers["If-None-Match"] = c.etag;
  if (c?.lastMod) headers["If-Modified-Since"] = c.lastMod;
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (res.status === 304 && c) return c.items;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 1024));
    charset = /encoding=["']([\w-]+)|charset=["']?([\w-]+)/i.exec(head)?.slice(1).find(Boolean);
  }
  let text;
  try { text = new TextDecoder(charset || "utf-8").decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
  const items = parseFeed(text);
  feedCache.set(url, { etag: res.headers.get("etag"), lastMod: res.headers.get("last-modified"), items });
  return items;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

// ---------- 集約 ----------
const store = { updatedAt: 0, items: {}, errors: {} };
const archive = new Map(); // "genre|link" -> 記事（期間内のものを蓄積）
const DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST = 9 * 60 * 60 * 1000;
const jstMidnight = (t) => Math.floor((t + JST) / DAY_MS) * DAY_MS - JST; // その日の日本時間0:00
let refreshing = null;
let stage1 = Promise.resolve();
const ENRICH_MAX = 120; // 1回の更新で記事ページを取りに行く上限（残りは次回以降に少しずつ）
const FORCE_MIN_MS = 30 * 1000; // 手動更新の最短間隔（連打でフィード元に負荷をかけない）

async function refresh() {
  if (refreshing) return refreshing;
  let stage1Done;
  stage1 = new Promise((r) => (stage1Done = r)); // 記事一覧ができた時点で解決
  refreshing = (async () => {
    const byGenre = {};
    const errors = {};
    const rawCache = new Map(); // 同じURLを二重取得しない
    await Promise.all(
      FEEDS.map(async (f) => {
        try {
          if (!rawCache.has(f.url)) rawCache.set(f.url, fetchFeedItems(f.url));
          let items = (await rawCache.get(f.url)).filter((i) => !AD_RE.test(i.title));
          if (f.filter) items = items.filter((i) => f.filter.test(`${i.title} ${i.desc} ${i.cats}`.replace(/株式会社/g, "")));
          (byGenre[f.genre] ||= []).push(...items.map((i) => ({ ...i, source: f.source, genre: f.genre })));
        } catch (e) {
          errors[f.url] = String(e.message || e);
        }
      })
    );
    // 取得期間: 日本時間の0:00基準で「今日を含む3日分」。RSSから消えた記事も期間内は保持する
    const cutoff = jstMidnight(Date.now()) - (DAYS - 1) * DAY_MS;
    for (const g of Object.keys(GENRES)) {
      for (const i of byGenre[g] || []) {
        if (!i.title || !i.link) continue;
        const key = `${g}|${i.link}`;
        const prev = archive.get(key);
        if (prev) Object.assign(prev, { ...i, firstSeen: prev.firstSeen, time: i.time || prev.time });
        else archive.set(key, { ...i, firstSeen: Date.now() });
      }
    }
    const lists = Object.fromEntries(Object.keys(GENRES).map((g) => [g, []]));
    for (const [key, i] of archive) {
      const t = i.time || i.firstSeen; // 日付なしの記事は初回取得時刻で判定
      if (t < cutoff) archive.delete(key);
      else lists[i.genre].push({ ...i, time: t });
    }
    for (const g in lists) lists[g] = lists[g].sort((a, b) => b.time - a.time).slice(0, MAX_PER_GENRE);
    const needsDesc = (i) => !i.desc || GENERIC_DESC.test(i.desc) || i.desc === i.title;
    // キャッシュ済みの og 情報を使って組み立てる
    const build = () => {
      const out = {};
      for (const g in lists) {
        out[g] = lists[g].map((i) => {
          const og = ogCache.get(i.link) || {};
          return {
            title: i.title,
            link: i.link.replace(/^http:\/\/(www3\.nhk)/, "https://$1"),
            summary: trimSummary(needsDesc(i) ? og.desc || "" : i.desc, i.title),
            image: i.image || og.image || "",
            source: i.source,
            genre: i.genre,
            time: i.time,
          };
        });
      }
      return out;
    };
    store.items = build();
    store.errors = errors;
    store.updatedAt = Date.now();
    console.log(new Date().toISOString(), "refreshed", Object.entries(store.items).map(([k, v]) => `${k}:${v.length}`).join(" "), Object.keys(errors).length ? `errors:${Object.keys(errors).length}` : "");
    stage1Done();
    // 概要・画像が足りない記事だけ記事ページから補完（初回表示を待たせないよう後追い）
    const todo = Object.values(lists).flat()
      .filter((i) => (needsDesc(i) || !i.image) && !ogCache.has(i.link))
      .sort((a, b) => b.time - a.time)
      .slice(0, ENRICH_MAX);
    await pool(todo, 4, (i) => fetchOg(i.link));
    if (todo.length) {
      store.items = build();
      console.log(new Date().toISOString(), "enriched", todo.length);
    }
  })().finally(() => {
    stage1Done();
    refreshing = null;
  });
  return refreshing;
}

// 全ジャンルを1本にまとめ（同じ記事は1件、所属ジャンルは genres に全部）、更新ごとに1回だけ作る
let mergedCache = { at: 0, list: [] };
function mergedList() {
  if (mergedCache.at === store.updatedAt) return mergedCache.list;
  const merged = new Map();
  for (const i of Object.values(store.items).flat().sort((x, y) => y.time - x.time)) {
    const m = merged.get(i.link);
    if (m) m.genres.push(i.genre);
    else merged.set(i.link, { ...i, genres: [i.genre] });
  }
  mergedCache = { at: store.updatedAt, list: [...merged.values()] };
  return mergedCache.list;
}

// ---------- HTTP ----------
const extractArticle = makeExtractor({ fetchText, clean, absUrl });
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/news") {
    if (!store.updatedAt) {
      refresh(); // 初回のみ、記事一覧ができるまで待つ（画像補完は後追い）
      while (!store.updatedAt) await new Promise((r) => setTimeout(r, 200));
    }
    else if (url.searchParams.get("fresh") && Date.now() - store.updatedAt > FORCE_MIN_MS) {
      refresh(); // 手動更新: 最新の一覧ができるまで待って返す
      await stage1;
    } else if (Date.now() - store.updatedAt > REFRESH_MS) refresh(); // 古ければ裏で更新
    const genre = url.searchParams.get("genre") || "all";
    const q = (url.searchParams.get("q") || "").toLowerCase().split(/[\s、,，]+/).filter(Boolean);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit")) || 60, 1), 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset")) || 0, 0);
    const etag = `"${store.updatedAt}-${encodeURIComponent(genre)}-${encodeURIComponent(q.join("+"))}-${limit}-${offset}"`; // ヘッダーは ASCII のみ
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); } // 変更なしなら本文を送らない
    let list = mergedList();
    if (genre !== "all") list = list.filter((i) => i.genres.includes(genre));
    if (q.length) list = list.filter((i) => { const t = (i.title + " " + i.summary).toLowerCase(); return q.some((k) => t.includes(k)); });
    const body = Buffer.from(JSON.stringify({ updatedAt: store.updatedAt, genres: GENRES, total: list.length, offset, items: list.slice(offset, offset + limit) }));
    const headers = { ETag: etag, "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" };
    if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(200, headers);
    return res.end(body);
  }
  if (url.pathname === "/api/article") {
    // 一覧にある記事のURLだけ受け付ける（任意のURLを取りに行かせない）
    const link = url.searchParams.get("link") || "";
    const known = Object.values(store.items).some((list) => list.some((i) => i.link === link));
    if (!known) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end("{}"); }
    const data = await extractArticle(link);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" });
    return res.end(JSON.stringify(data));
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  // 静的ファイル
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (!p) p = "index.html";
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// 1件のリクエストのエラーでサーバー全体が止まらないようにする
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

server.listen(PORT, () => {
  console.log(`News Hub on :${PORT}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});
