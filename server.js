// News Hub server — 依存ライブラリなし (Node 18+)
// RSSを定期取得 → 概要を整形 → /api/news で配信。public/ も同時に配信。
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const REFRESH_MS = (Number(process.env.REFRESH_SEC) || 180) * 1000; // フィード再取得間隔
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
async function fetchText(url, timeout = 15000, maxBytes = 0) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf;
  if (maxBytes && res.body) {
    // 先頭だけ読んで接続を閉じる（og情報は <head> にあるので、ページ全体を取り込まずメモリを節約）
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    reader.cancel().catch(() => {});
    buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
  } else buf = new Uint8Array(await res.arrayBuffer());
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
const DEFAULT_IMG = /amd-img\/default\.jpg|no[-_]?image|dummy|placeholder/i; // 汎用のダミー画像は「画像なし」として扱う
const RETRY_MS = 30 * 60 * 1000; // 取得に失敗した記事は30分後にもう一度試す
const badImg = new Map(); // link -> 表示できなかった画像URL（次回から使わない）
const retryAt = new Map(); // link -> 最後に取り直した時刻（連続リクエスト防止）
const ogDone = (url) => { const v = ogCache.get(url); return !!v && (v.image || v.desc || Date.now() - v.at < RETRY_MS); };
async function fetchOg(url) {
  if (ogDone(url)) return ogCache.get(url);
  const v = { desc: "", image: "", at: Date.now() };
  try {
    const html = await fetchText(url, 8000, 150000);
    const meta = (re) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["'](?:${re})["'][^>]*content=["']([^"']*)["']`, "i").exec(html) ||
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${re})["']`, "i").exec(html);
      return m ? clean(m[1]) : "";
    };
    // 取り出した文字列は新しいコピーにする（ページ全文の一部のままだと、ページごとメモリに残り続ける）
    v.desc = flat(meta("og:description|description"));
    v.image = flat(absUrl(meta("og:image|twitter:image"), url));
    if (DEFAULT_IMG.test(v.image)) v.image = "";
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
const flat = (v) => (typeof v === "string" ? Buffer.from(v, "utf8").toString("utf8") : v);
const flatItem = (i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, flat(v)]));
const archive = new Map(); // "genre|link" -> 記事（期間内のものを蓄積）
// 再起動しても記事を失わないよう、ファイルに保存して起動時に読み戻す。
// DATA_DIR をディスク（Render の有料プランなど）に向けると再デプロイ後も残る。無料プランでは再起動で消える。
const PERSIST = !!process.env.DATA_DIR; // ディスクを指定したときだけ保存する（無料プランでは意味がなく、CPUとI/Oの無駄になる）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SNAP = path.join(DATA_DIR, "archive.json");
const OGSNAP = path.join(DATA_DIR, "og.json");
function loadSnapshot() {
  if (!PERSIST) return;
  try {
    for (const [k, v] of JSON.parse(fs.readFileSync(SNAP, "utf8"))) archive.set(k, v);
    for (const [k, v] of JSON.parse(fs.readFileSync(OGSNAP, "utf8"))) ogCache.set(k, v);
    console.log("snapshot loaded:", archive.size);
  } catch {}
}
let savePending = false;
function saveSnapshot() {
  if (!PERSIST || savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAP + ".tmp", JSON.stringify([...archive]));
      fs.renameSync(SNAP + ".tmp", SNAP);
      fs.writeFileSync(OGSNAP, JSON.stringify([...ogCache].filter(([, v]) => v.image || v.desc)));
    } catch {}
  }, 1000);
}
const DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST = 9 * 60 * 60 * 1000;
const jstMidnight = (t) => Math.floor((t + JST) / DAY_MS) * DAY_MS - JST; // その日の日本時間0:00
let refreshing = null;
let stage1 = Promise.resolve();
const ENRICH_MAX = 400; // 1回の更新で記事ページを取りに行く上限（残りは次回以降に少しずつ）
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
        // 文字列は新しいコピーにして保存する。そのままだと、フィード全文の一部（スライス）として
        // 取得のたびの巨大なXML全体をメモリに残し続けてしまい、数十分でメモリ切れになる。
        const own = flatItem(i);
        if (prev) Object.assign(prev, { ...own, firstSeen: prev.firstSeen, time: i.time || prev.time });
        else archive.set(key, { ...own, firstSeen: Date.now() });
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
            image: [i.image, og.image].find((u) => u && !DEFAULT_IMG.test(u) && u !== badImg.get(i.link)) || "",
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
    if (global.gc) global.gc();
    const mu = process.memoryUsage();
    console.log(new Date().toISOString(), `mem rss=${Math.round(mu.rss / 1048576)}MB heap=${Math.round(mu.heapUsed / 1048576)}MB`);
    console.log(new Date().toISOString(), "refreshed", Object.entries(store.items).map(([k, v]) => `${k}:${v.length}`).join(" "), Object.keys(errors).length ? `errors:${Object.keys(errors).length}` : "");
    stage1Done();
    saveSnapshot();
    // 概要・画像が足りない記事だけ記事ページから補完（初回表示を待たせないよう後追い）
    // 残りが無くなるまで続けて補完する（再起動直後でも数十秒で画像が揃うように、次の周期を待たない）。
    // 新しい記事から順に取り、1回ごとに画面へ反映する。暴走防止で最大8ラウンド。
    for (let round = 0; round < 8; round++) {
      const todo = Object.values(lists).flat()
        .filter((i) => (needsDesc(i) || !i.image || DEFAULT_IMG.test(i.image)) && !ogDone(i.link))
        .sort((a, b) => b.time - a.time)
        .slice(0, ENRICH_MAX);
      if (!todo.length) break;
      await pool(todo, 5, (i) => fetchOg(i.link));
      store.items = build();
      store.updatedAt = Date.now(); // 画面側の自動更新が気づけるように
      console.log(new Date().toISOString(), "enriched", todo.length, "round", round + 1);
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
const staticCache = new Map();
const assetVer = (f) => { try { return Math.floor(fs.statSync(path.join(PUBLIC, f)).mtimeMs / 1000).toString(36); } catch { return "0"; } };

// /api/news の応答は、更新ごとに1回だけ作って使い回す（同じ条件のリクエストで毎回JSON化・圧縮しない）
const apiCache = new Map();
let apiCacheAt = 0;
function sendApi(req, res, entry, etag) {
  const headers = { ETag: etag, "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=20", Vary: "Accept-Encoding" };
  if (/gzip/.test(req.headers["accept-encoding"] || "")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
    return res.end(entry.gz);
  }
  res.writeHead(200, headers);
  return res.end(entry.body);
}

// ---------- 市況（日経平均・S&P500・ドル円・ビットコイン・原油）----------
// Yahoo Finance の公開チャートから取得。数分の遅れがありうる。取れない指標は出さない。
const MARKETS = [
  { id: "n225", label: "日経平均", sym: "^N225", dp: 0 },
  { id: "spx", label: "S&P500", sym: "^GSPC", dp: 0 },
  { id: "usdjpy", label: "ドル円", sym: "JPY=X", dp: 2 },
  { id: "btc", label: "ビットコイン", sym: "BTC-JPY", dp: 0, unit: "円" },
  { id: "wti", label: "原油(WTI)", sym: "CL=F", dp: 2, unit: "$" },
];
let marketsCache = { at: 0, data: [] };
async function fetchMarket(m) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.sym)}?interval=1m&range=1d`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const meta = (await r.json()).chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  if (!Number.isFinite(price)) throw new Error("no price");
  const has = Number.isFinite(prev) && prev;
  return { id: m.id, label: m.label, dp: m.dp, unit: m.unit || "", price, change: has ? price - prev : null, pct: has ? ((price - prev) / prev) * 100 : null, time: (meta.regularMarketTime || 0) * 1000 };
}
let marketsBusy = null;
async function getMarkets() {
  if (Date.now() - marketsCache.at < 45 * 1000) return marketsCache.data;
  if (!marketsBusy) {
    marketsBusy = Promise.all(MARKETS.map((m) => fetchMarket(m).catch(() => marketsCache.data.find((x) => x.id === m.id) || null)))
      .then((rows) => { marketsCache = { at: Date.now(), data: rows.filter(Boolean) }; })
      .finally(() => { marketsBusy = null; });
  }
  await marketsBusy;
  return marketsCache.data;
}

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
    const cached = apiCache.get(etag);
    if (cached) return sendApi(req, res, cached, etag);
    let list = mergedList();
    if (genre !== "all") list = list.filter((i) => i.genres.includes(genre));
    if (q.length) list = list.filter((i) => { const t = (i.title + " " + i.summary).toLowerCase(); return q.some((k) => t.includes(k)); });
    const body = Buffer.from(JSON.stringify({ updatedAt: store.updatedAt, genres: GENRES, total: list.length, offset, items: list.slice(offset, offset + limit) }));
    if (apiCacheAt !== store.updatedAt) { apiCache.clear(); apiCacheAt = store.updatedAt; } // 更新されたら作り直す
    if (apiCache.size > 300) apiCache.delete(apiCache.keys().next().value);
    const entry = { body, gz: zlib.gzipSync(body) };
    apiCache.set(etag, entry);
    return sendApi(req, res, entry, etag);
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
  if (url.pathname === "/api/image-retry") {
    // 画像が表示できなかったとき、記事ページから画像を取り直す（一覧にある記事のみ・10分に1回まで）
    const link = url.searchParams.get("link") || "";
    const bad = url.searchParams.get("bad") || "";
    const known = Object.values(store.items).some((list) => list.some((i) => i.link === link));
    const out = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (!known || Date.now() - (retryAt.get(link) || 0) < 10 * 60 * 1000) { res.writeHead(200, out); return res.end('{"image":""}'); }
    retryAt.set(link, Date.now());
    if (retryAt.size > 2000) retryAt.delete(retryAt.keys().next().value);
    if (bad) badImg.set(link, bad);
    ogCache.delete(link);
    const v = await fetchOg(link);
    const image = v.image && v.image !== bad ? v.image : "";
    res.writeHead(200, out);
    return res.end(JSON.stringify({ image }));
  }
  if (url.pathname === "/api/markets") {
    const data = await getMarkets().catch(() => []);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ items: data }));
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
  const hit = staticCache.get(p);
  const reply = (e) => {
    const gz = /gzip/.test(req.headers["accept-encoding"] || "") && e.gz;
    const headers = { ...e.headers, Vary: "Accept-Encoding" };
    if (p !== "index.html" && url.searchParams.get("v")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    if (gz) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(gz ? e.gz : e.raw);
  };
  if (hit) return reply(hit);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const headers = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" };
    if (p === "index.html") {
      // JS/CSS のURLに版（ファイルの更新時刻）を付ける。中身が変わらない限りブラウザが使い回せる
      data = Buffer.from(data.toString("utf8").replace(/(href|src)="(style\.css|app\.js|config\.js)"/g, (m, a, f) => `${a}="${f}?v=${assetVer(f)}"`));
    }
    const compressible = /^(text\/|application\/(json|javascript))|svg/.test(headers["Content-Type"]);
    // ファイルはデプロイ中は変わらないので、読み込みと圧縮は1回だけ
    const e = { headers, raw: data, gz: compressible ? zlib.gzipSync(data) : null };
    staticCache.set(p, e);
    reply(e);
  });
});

// 1件のリクエストのエラーでサーバー全体が止まらないようにする
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

loadSnapshot();
server.listen(PORT, () => {
  console.log(`News Hub on :${PORT}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});
