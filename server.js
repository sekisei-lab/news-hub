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
  suv: { label: "小型SUV・バン" }, // 特集: 全長4,600mm以下のコンパクトSUV・バン
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
  australia: { label: "Australia", en: true }, // 英語ジャンル（ラベルも記事も英語）
  game: { label: "ゲーム" },
};

// 広告・PR記事は除外
const AD_RE = /［PR］|\[PR\]|【PR】|\bPR\b|PR TIMES|プレスリリース|Sponsored/i;
const { FEEDS, SUV_MODEL_RE } = require("./feeds");
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
const galleryCache = new Map(); // 記事ID -> { at, images }
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
      if (t < cutoff || i.source === "Investing.com") archive.delete(key); // Investing.comはカードにせず、専用の帯だけで見せる
      else lists[i.genre].push({ ...i, time: t });
    }
    { // 同じ出来事の重複記事（配信元違い・見出しの微差）は1件にまとめる
      const auRank = (src) => { const k = ["ABC", "SBS", "The Guardian", "The Conversation", "SMH", "The Sydney", "The Age", "Brisbane", "WAtoday", "The Canberra"].findIndex((p) => src.startsWith(p)); return k < 0 ? 99 : k; };
      const norm = (t) => t.toLowerCase().replace(/[(（【][^)）】]*[)）】]\s*$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
      const grams = (t) => { const set = new Set(); for (let k = 0; k < t.length - 1; k++) set.add(t.slice(k, k + 2)); return set; };
      const sim = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
      for (const g in lists) {
        const kept = [];
        for (const i of lists[g].sort((a, b) => b.time - a.time)) {
          const n = norm(i.title), gr = grams(n);
          const hit = kept.find((k) => k.n === n || (gr.size > 6 && k.gr.size > 6 && sim(gr, k.gr) >= 0.7));
          if (!hit) { kept.push({ i, n, gr }); continue; }
          const better = g === "australia" ? auRank(i.source) < auRank(hit.i.source) : !hit.i.image && i.image;
          if (better) hit.i = i;
        }
        lists[g] = kept.map((k) => k.i);
      }
    }
    for (const g in lists) lists[g] = lists[g].sort((a, b) => b.time - a.time).slice(0, g === "australia" ? 900 : MAX_PER_GENRE);
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
    { // 画像のない記事は、同じ出来事を報じた別の記事（見出しが似ている・36時間以内）の画像を借りる
      const nm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const bg = (t) => { const s = new Set(); for (let k = 0; k < t.length - 1; k++) s.add(t.slice(k, k + 2)); return s; };
      const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
      const pool = { en: [], ja: [] };
      for (const g in store.items) for (const i of store.items[g]) if (i.image) pool[GENRES[g]?.en ? "en" : "ja"].push({ gr: bg(nm(i.title)), image: i.image, time: i.time });
      for (const g in store.items) {
        const cands = pool[GENRES[g]?.en ? "en" : "ja"];
        for (const i of store.items[g]) {
          if (i.image) continue;
          const gr = bg(nm(i.title));
          if (gr.size < 6) continue;
          let best = null, bs = 0.45; // これ以上似ているときだけ借りる
          for (const c of cands) {
            if (Math.abs(c.time - i.time) > 36 * 3600 * 1000) continue;
            const s = jac(gr, c.gr);
            if (s > bs) { bs = s; best = c; }
          }
          if (best) i.image = best.image;
        }
      }
    }
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
const MARKET_SETS = {
  // 金融・経済タブ
  finance: [
    { id: "n225", label: "日経平均", sym: "^N225", dp: 0 },
    { id: "spx", label: "S&P500", sym: "^GSPC", dp: 0 },
    { id: "usdjpy", label: "ドル円", sym: "JPY=X", dp: 2 },
    { id: "btc", label: "ビットコイン", sym: "BTC-JPY", dp: 0, unit: "円" },
    { id: "wti", label: "原油(WTI)", sym: "CL=F", dp: 2, unit: "$" },
  ],
  // 国際タブ: 主要国の株価指数と為替
  world: [
    { id: "dji", label: "NYダウ", sym: "^DJI", dp: 0 },
    { id: "ixic", label: "ナスダック", sym: "^IXIC", dp: 0 },
    { id: "gdaxi", label: "ドイツDAX", sym: "^GDAXI", dp: 0 },
    { id: "ftse", label: "英FTSE100", sym: "^FTSE", dp: 0 },
    { id: "sse", label: "上海総合", sym: "000001.SS", dp: 0 },
    { id: "eurusd", label: "ユーロドル", sym: "EURUSD=X", dp: 4 },
  ],
  // ITタブ: 主要テック企業の株価（ドル）
  it: [
    { id: "nvda", label: "NVIDIA", sym: "NVDA", dp: 2, unit: "$" },
    { id: "aapl", label: "Apple", sym: "AAPL", dp: 2, unit: "$" },
    { id: "msft", label: "Microsoft", sym: "MSFT", dp: 2, unit: "$" },
    { id: "googl", label: "Alphabet", sym: "GOOGL", dp: 2, unit: "$" },
    { id: "amzn", label: "Amazon", sym: "AMZN", dp: 2, unit: "$" },
    { id: "meta", label: "Meta", sym: "META", dp: 2, unit: "$" },
  ],
};
const marketsCaches = new Map(); // セット名 -> { at, data }
async function fetchMarket(m) {
  if (Date.now() < marketsBackoff) throw new Error("backoff");
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.sym)}?interval=1m&range=1d`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 429) marketsBackoff = Date.now() + 60 * 1000;
  if (!r.ok) throw new Error("HTTP " + r.status);
  const meta = (await r.json()).chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  if (!Number.isFinite(price)) throw new Error("no price");
  const has = Number.isFinite(prev) && prev;
  return { id: m.id, label: m.label, dp: m.dp, unit: m.unit || "", price, change: has ? price - prev : null, pct: has ? ((price - prev) / prev) * 100 : null, time: (meta.regularMarketTime || 0) * 1000 };
}
const marketsBusy = new Map();
let marketsBackoff = 0;
async function getMarkets(setName = "finance") {
  const defs = MARKET_SETS[setName] || MARKET_SETS.finance;
  const key = MARKET_SETS[setName] ? setName : "finance";
  const cache = marketsCaches.get(key) || { at: 0, data: [] };
  // 3秒ごとの更新に対応。閲覧者が何人いても、セットごとに取得は3秒に1回だけ。拒否(429)されたら1分間やめて前回値を出す
  if (Date.now() - cache.at < 2500 || Date.now() < marketsBackoff) return cache.data;
  if (!marketsBusy.has(key)) {
    marketsBusy.set(key, Promise.all(defs.map((m) => fetchMarket(m).catch(() => cache.data.find((x) => x.id === m.id) || null)))
      .then((rows) => { marketsCaches.set(key, { at: Date.now(), data: rows.filter(Boolean) }); })
      .finally(() => { marketsBusy.delete(key); }));
  }
  await marketsBusy.get(key);
  return (marketsCaches.get(key) || cache).data;
}

// ---------- 国内タブの天気ヘッダー（東京の天気・気温・台風・寒波/熱波）----------
// 気象庁の公開データを使う。5分キャッシュ。取れない項目は出さない。
let weatherCache = { at: 0, data: null };
let weatherBusy = null;
const jmaJson = async (u) => {
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};
async function buildWeather() {
  const out = { weather: "", temp: null, max: null, min: null, typhoons: [], heat: "", cold: "" };
  const tasks = [];
  tasks.push((async () => {
    const f = await jmaJson("https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json");
    const w = f[0].timeSeries[0].areas[0].weathers[0] || "";
    out.weather = w.replace(/　/g, " ").replace(/ から /g, "→").replace(/ 後 /g, "→").replace(/ ところにより /g, "、所により").trim();
    const temps = f[0].timeSeries[2].areas[0].temps;
    out.max = Number(temps[0]);
    out.min = Number(temps[1]);
    const wk = f[1].timeSeries[1].areas[0];
    const days = f[1].timeSeries[0].timeDefines;
    const md = (i) => { const d = new Date(days[i]); return `${d.getMonth() + 1}/${d.getDate()}`; };
    // 寒波・熱波の目安: 向こう1週間の予報で、最高35℃以上(猛暑日)/最低0℃以下(冬日)
    const hot = [], cold = [];
    wk.tempsMax.forEach((v, i) => { if (v !== "" && Number(v) >= 35) hot.push(md(i)); });
    wk.tempsMin.forEach((v, i) => { if (v !== "" && Number(v) <= 0) cold.push(md(i)); });
    if (Number(temps[0]) >= 35) hot.unshift("今日");
    if (Number(temps[1]) <= 0) cold.unshift("今日");
    out.heat = hot.length ? `猛暑日予報 ${hot[0]}` : "";
    out.cold = cold.length ? `氷点下予報 ${cold[0]}` : "";
  })());
  tasks.push((async () => {
    const lt = (await (await fetch("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })).text()).trim();
    const d = new Date(lt);
    const p2 = (n) => String(n).padStart(2, "0");
    // AMeDAS の時刻は日本時間。サーバーのタイムゾーンに左右されないよう文字列から作る
    const key = lt.replace(/[-:T]/g, "").slice(0, 12) + "00";
    const m = await jmaJson(`https://www.jma.go.jp/bosai/amedas/data/map/${key}.json`);
    const t = m["44132"]?.temp?.[0];
    if (Number.isFinite(t)) out.temp = t;
    void d; void p2;
  })());
  tasks.push((async () => {
    const list = await jmaJson("https://www.jma.go.jp/bosai/typhoon/data/targetTc.json");
    for (const t of list.filter((x) => /^\d{4}$/.test(x.typhoonNumber || "")).slice(0, 3)) {
      let name = "";
      try {
        const sp = await jmaJson(`https://www.jma.go.jp/bosai/typhoon/data/${t.tropicalCyclone}/specifications.json`);
        name = sp[0]?.name?.jp || "";
      } catch {}
      out.typhoons.push({ no: Number(t.typhoonNumber.slice(2)), name });
    }
  })());
  await Promise.allSettled(tasks);
  return out;
}
async function getWeather() {
  if (weatherCache.data && Date.now() - weatherCache.at < 5 * 60 * 1000) return weatherCache.data;
  if (!weatherBusy) {
    weatherBusy = buildWeather()
      .then((d) => { weatherCache = { at: Date.now(), data: d }; })
      .catch(() => {})
      .finally(() => { weatherBusy = null; });
  }
  await weatherBusy;
  return weatherCache.data;
}

// ---------- 注目ニュース（ジャンルごとに3本）----------
// A: Yahoo!ニュースのアクセスランキング（閲覧が多い順）に載っていて、こちらの一覧にもある記事を優先
// B: 足りない分は「同じ出来事を何社が報じているか」が多い順（こちらの集めたデータだけで決まる）
const RANK_CAT = { national: "domestic", politics: "domestic", world: "world", economy: "business", finance: "business", sports: "sports", entertainment: "entertainment", life: "life", health: "life", gourmet: "life", travel: "life", all: "" };
const rankCache = new Map(); // category -> { at, ids: Map(id -> rank) }
async function getRanking(cat) {
  if (cat === undefined || cat === null || !(cat in { "": 1, domestic: 1, world: 1, business: 1, sports: 1, entertainment: 1, life: 1 })) return new Map();
  const hit = rankCache.get(cat);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ids;
  const ids = new Map();
  try {
    const html = await fetchText(`https://news.yahoo.co.jp/ranking/access/news${cat ? "/" + cat : ""}`, 8000);
    for (const m of html.matchAll(/https:\/\/news\.yahoo\.co\.jp\/articles\/([a-f0-9]{40})/g)) if (!ids.has(m[1])) ids.set(m[1], ids.size + 1);
  } catch {}
  rankCache.set(cat, { at: Date.now(), ids });
  return ids;
}
const yahooId = (link) => /articles\/([a-f0-9]{40})/.exec(link || "")?.[1] || "";
const grams = (t) => {
  const s = t.replace(/[【】\[\]()（）「」『』“”"'、。,.!！?？・\s]|[（(][^）)]*[）)]$/g, "");
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
};
const jaccard = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};
// 似た見出しをまとめて「同じ出来事」とみなす
function clusterItems(items) {
  const gs = items.map((i) => grams(i.title));
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].source === items[j].source) continue;
      if (jaccard(gs[i], gs[j]) >= 0.33) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()];
}
const hotCache = new Map(); // genre -> { at, upd, items }
async function getHot(genre) {
  const hit = hotCache.get(genre);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000) return hit.items;
  const since = Date.now() - 36 * 60 * 60 * 1000;
  let list = mergedList().filter((i) => (genre === "all" ? i.genres.some((g) => !GENRES[g]?.en) : i.genres.includes(genre)) && i.time >= since);
  const out = [];
  const used = new Set();
  const take = (it, reason) => { if (out.length < 3 && !used.has(it.link)) { out.push({ ...it, reason }); used.add(it.link); } };
  // A: アクセスランキング
  const ranks = await getRanking(RANK_CAT[genre]);
  if (ranks.size) {
    list.map((i) => ({ i, r: ranks.get(yahooId(i.link)) })).filter((x) => x.r).sort((a, b) => a.r - b.r).slice(0, 3).forEach((x) => take(x.i, "アクセス上位"));
  }
  // B: 何社が報じているか
  if (out.length < 3) {
    const groups = clusterItems(list.slice(0, 500)).map((g) => {
      const sources = new Set(g.map((x) => x.source));
      const rep = g.slice().sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0) || b.time - a.time)[0];
      return { rep, n: sources.size, t: Math.max(...g.map((x) => x.time)), members: g };
    }).filter((g) => g.n >= 2).sort((a, b) => b.n - a.n || b.t - a.t);
    const chosenGroups = [];
    for (const g of groups) {
      if (out.length >= 3) break;
      // Aで選んだ記事と同じ出来事なら重ねない
      if (g.members.some((m) => used.has(m.link))) continue;
      take(g.rep, `${g.n}社が報道`);
      chosenGroups.push(g);
    }
  }
  // 3本に満たないジャンルは、新着の記事で埋める（画像つきを優先）
  if (out.length < 3) {
    list.filter((i) => i.image).slice(0, 12).forEach((i) => take(i, "新着"));
    list.slice(0, 12).forEach((i) => take(i, "新着"));
  }
  hotCache.set(genre, { at: Date.now(), items: out });
  return out;
}

// ---------- 金融タブ: Investing.com のインサイダー（内部者）取引記事 ----------
let insiderCache = { at: 0, items: [] };
const insiderStore = new Map(); // link -> 記事。RSSは最新10件しか返さないので、取得のたびに貯めて上位20件を出す
async function getInsider() {
  if (Date.now() - insiderCache.at < 3 * 60 * 1000) return insiderCache.items;
  try {
    for (const i of await fetchFeedItems("https://jp.investing.com/rss/news_357.rss")) {
      if (i.title && i.link && !insiderStore.has(i.link)) insiderStore.set(i.link, flatItem({ title: i.title, link: i.link, summary: "", image: i.image || "", source: "Investing.com", time: i.time || 0 }));
    }
    const items = [...insiderStore.values()].sort((x, y) => y.time - x.time).slice(0, 20);
    for (const k of [...insiderStore.keys()]) if (!items.some((x) => x.link === k)) insiderStore.delete(k);
    insiderCache = { at: Date.now(), items };
  } catch { insiderCache.at = Date.now() - 2.5 * 60 * 1000; } // 失敗時は前回分を出し、30秒後に再挑戦
  return insiderCache.items;
}

// ---------- 車タブ: 中古車の人気ランキング（国産／外車）と新車情報 ----------
// 中古車: カーセンサーの「人気車種ランキング」（問い合わせデータにもとづく。販売台数ではない）。6時間キャッシュ。
const JP_MAKERS = ["トヨタ", "日産", "ホンダ", "マツダ", "スバル", "スズキ", "ダイハツ", "三菱", "レクサス", "いすゞ", "光岡", "日野", "ミツオカ"];
let usedCarCache = { at: 0, data: null };
async function fetchUsedCarRanking() {
  const pages = ["https://www.carsensor.net/ranking/index.html", ...Array.from({ length: 44 }, (_, i) => `https://www.carsensor.net/ranking/pop/index${i + 2}.html`)];
  const rows = [];
  for (const u of pages) {
    try {
      let html = await fetchText(u, 10000);
      // ページには「人気車種」と「1年以内に発売されたモデル」の2つのランキングがある。最初のもの（人気車種）だけを読む
      const st = html.indexOf('class="ranking is-active"');
      if (st >= 0) { const nx = html.indexOf('<ul class="ranking', st + 20); html = html.slice(st, nx > 0 ? nx : undefined); }
      for (const blk of html.split('<li class="rankingItem">').slice(1)) {
        const rank = Number((/rankingItem__rank[^"]*">(\d+)</.exec(blk) || [])[1]);
        const name = ((/class="rankingItem__name">\s*([^<]+?)\s*</.exec(blk) || [])[1] || "").replace(/\s+/g, " ").trim();
        const code = (/CSphoto\/cat\/([A-Z]{2})\/(S\d+)\//.exec(blk) || []).slice(1).join("_");
        if (rank && name) rows.push({ rank, name, code });
      }
    } catch {}
  }
  const seen = new Set();
  const list = rows.filter((r) => (seen.has(r.name) ? false : seen.add(r.name))).sort((a, b) => a.rank - b.rank);
  const isJp = (n) => JP_MAKERS.some((m) => n.startsWith(m));
  const fmt = (r) => ({ rank: r.rank, name: r.name });
  return { all: list, domestic: list.filter((r) => isJp(r.name)).slice(0, 3).map(fmt), imported: list.filter((r) => !isJp(r.name)).slice(0, 3).map(fmt), source: "カーセンサー 人気車種（問い合わせ数）" };
}
async function getUsedCar() {
  if (usedCarCache.data && Date.now() - usedCarCache.at < 6 * 60 * 60 * 1000) return usedCarCache.data;
  try {
    const d = await fetchUsedCarRanking();
    if (d.domestic.length || d.imported.length) usedCarCache = { at: Date.now(), data: d };
  } catch {}
  return usedCarCache.data;
}
// 小型SUV: 人気ランキングにある対象車種ごとに、相場ページから「現行型」の中古車平均価格を読む。
// 読み込みに1分以上かかるので、画面には「前回の結果」をすぐ返し、最新の取得は裏で行う。
// サーバーの再起動直後は、リポジトリに入れた保存データ（suv-snapshot.json）をそのまま使う。
const SUV_SNAP = path.join(__dirname, "suv-snapshot.json");
let suvUsedCache = { at: 0, data: [] }, suvBusy = null;
try { const snap = JSON.parse(fs.readFileSync(SUV_SNAP, "utf8")); if (Array.isArray(snap.data) && snap.data.length) suvUsedCache = { at: 0, data: snap.data }; } catch {} // at:0 = 古いが使える
function refreshSuvUsed() {
  if (!suvBusy) suvBusy = computeSuvUsed().then((d) => { if (d.length) suvUsedCache = { at: Date.now(), data: d }; }).catch(() => {}).finally(() => { suvBusy = null; });
  return suvBusy;
}
async function getSuvUsed() {
  const c = suvUsedCache;
  if (c.data.length) { if (Date.now() - c.at > 6 * 60 * 60 * 1000) refreshSuvUsed(); return c.data; } // すぐ返す。古ければ裏で更新
  await refreshSuvUsed(); // 保存データもないときだけ、取得を待つ
  return suvUsedCache.data;
}
async function computeSuvUsed() {
  const used = await getUsedCar().catch(() => null);
  const all = ((used && used.all) || []).filter((r) => SUV_MODEL_RE.test(r.name));
  const isJp = (n) => JP_MAKERS.some((mk) => n.startsWith(mk));
  const targets = [...all.filter((r) => isJp(r.name)).slice(0, 18), ...all.filter((r) => !isJp(r.name)).slice(0, 12)]; // 国産18・外車12（6枠×3段と6枠×2段）
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < targets.length) {
      const r = targets[next++];
      let avg = null, gen = "", img = "", size = null;
      if (/^[A-Z]{2}_S\d+$/.test(r.code || "")) {
        try {
          const html = await fetchText(`https://www.carsensor.net/usedcar/souba/${r.code}/`, 12000);
          // 世代ごとのブロックのうち「現行」のもの（なければ先頭＝最新の世代）から、世代・画像・平均価格を読む
          const blocks = html.split('<div class="media"').slice(1);
          const blk = blocks.find((b) => b.includes("<span>現行</span>")) || blocks[0] || "";
          const m = /中古車平均価格<span>([\d.]+)<\/span>万円/.exec(blk);
          if (m) {
            avg = Number(m[1]);
            gen = ((/<p><a [^>]*>([^<]*)<\/a><\/p>/.exec(blk) || [])[1] || "").trim();
            const im = (/data-original="([^"]+)"/.exec(blk) || [])[1] || "";
            img = im.startsWith("//") ? "https:" + im : im;
            // 同じ世代のカタログページから、全長・全幅・全高（m）を読む
            const cat = (/location\.href='(\/catalog\/[^']+)'/.exec(blk) || [])[1];
            if (cat) {
              try {
                const text = (await fetchText(`https://www.carsensor.net${cat}`, 12000)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
                const pick = (k) => { const x = new RegExp(k + "\\s*([\\d.]+)\\s*m").exec(text); if (!x) return null; const v = Number(x[1]); return v > 100 ? Math.round(v) / 1000 : v; }; // mm表記が混ざるものはmに直す
                size = { len: pick("全長"), wid: pick("全幅"), hei: pick("全高") };
                if (!size.len || !size.wid || !size.hei) size = null;
              } catch {}
            }
          }
        } catch {}
      }
      out.push({ rank: r.rank, name: r.name, avg, gen, img, size, link: r.code ? `https://www.carsensor.net/usedcar/souba/${r.code}/` : "", imp: !JP_MAKERS.some((mk) => r.name.startsWith(mk)) });
    }
  }));
  out.sort((a, b) => a.rank - b.rank);
  return out;
}
const NEWCAR_RE = /新型|新車|発売|発表|フルモデルチェンジ|マイナーチェンジ|一部改良|ワールドプレミア|世界初公開|初公開|予約開始|受注開始|価格|登場|デビュー|ティザー|公開/;
function getNewCarNews() {
  const since = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return mergedList()
    .filter((i) => i.genres.includes("car") && i.time >= since && NEWCAR_RE.test(i.title))
    .sort((a, b) => b.time - a.time)
    .slice(0, 14)
    .map((i) => ({ ...i, reason: i.source }));
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
    list = genre === "all" ? list.filter((i) => i.genres.some((g) => !GENRES[g]?.en)) : list.filter((i) => i.genres.includes(genre));
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
    if (data.image && (DEFAULT_IMG.test(data.image) || /default\.(?:jpe?g|png|webp)/i.test(data.image))) data.image = ""; // 汎用のダミー画像は「画像なし」
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" });
    return res.end(JSON.stringify(data));
  }
  if (url.pathname === "/api/gallery") {
    // 写真つき記事（くるまのニュース・レスポンス）は、広告を除いた写真だけを一覧にして返す（一覧にある記事のみ・1時間キャッシュ）
    const link = url.searchParams.get("link") || "";
    const km = /^https:\/\/kuruma-news\.jp\/post\/(\d+)/.exec(link);
    const rm = /^https:\/\/response\.jp\/article\/(\d{4}\/\d{2}\/\d{2}\/\d+)\.html/.exec(link);
    const known = Object.values(store.items).some((list) => list.some((i) => i.link === link));
    const out = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=600" };
    if ((!km && !rm) || !known) { res.writeHead(200, out); return res.end('{"images":[]}'); }
    try {
      const key = km ? "k" + km[1] : "r" + rm[1];
      const hit = galleryCache.get(key);
      let images = hit && Date.now() - hit.at < 3600000 ? hit.images : null;
      if (!images) {
        images = [];
        if (km) {
          const html = await fetchText(`https://kuruma-news.jp/photo/${km[1]}`, 12000);
          for (const part of html.split(/<div class="swiper-slide" data-history="/).slice(1)) {
            if (!/^photo\d+"/.test(part)) continue; // photo_extra は広告枠
            const src = /<img[^>]+src="([^"]+)"/.exec(part)?.[1];
            const cap = /<figcaption>([^<]*)<\/figcaption>/.exec(part)?.[1] || "";
            if (src && /^https:\/\/kuruma-news\.jp\//.test(src)) images.push({ src: src.replace(/\?v=\d+$/, ""), caption: clean(cap) });
          }
        } else {
          // レスポンス：記事ページの「写真ページ」リンクから写真番号を集めて、大きい画像の場所を組み立てる
          const html = await fetchText(link.split("?")[0], 12000);
          const alt = new Map();
          for (const m of html.matchAll(/<img[^>]+src="\/imgs\/[^"]*\/(\d+)\.(?:jpg|webp)"[^>]*alt="([^"]*)"/g)) if (!alt.has(m[1])) alt.set(m[1], clean(m[2]));
          const seen = new Set();
          for (const m of html.matchAll(/href="\/article\/img\/\d{4}\/\d{2}\/\d{2}\/\d+\/(\d+)\.html"/g)) {
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            images.push({ src: `https://response.jp/imgs/zoom/${m[1]}.jpg`, caption: alt.get(m[1]) || "" });
          }
        }
        galleryCache.set(key, { at: Date.now(), images });
        if (galleryCache.size > 300) galleryCache.delete(galleryCache.keys().next().value);
      }
      res.writeHead(200, out);
      return res.end(JSON.stringify({ images }));
    } catch {
      res.writeHead(200, out);
      return res.end('{"images":[]}');
    }
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
    const data = await getMarkets(url.searchParams.get("set") || "finance").catch(() => []);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ items: data }));
  }
  if (url.pathname === "/api/weather") {
    const data = await getWeather().catch(() => null);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify(data || {}));
  }
  if (url.pathname === "/api/hot") {
    if (!store.updatedAt) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"items":[]}'); }
    const genre = url.searchParams.get("genre") || "all";
    const items = genre === "all" || genre in GENRES ? await getHot(genre).catch(() => []) : [];
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ items }));
  }
  if (url.pathname === "/api/insider") {
    const items = await getInsider();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ items }));
  }
  if (url.pathname === "/api/suv") {
    const list = await getSuvUsed().catch(() => []);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ used: list, source: "カーセンサー 人気車種（問い合わせ数）・相場" }));
  }
  if (url.pathname === "/api/car") {
    const news = store.updatedAt ? getNewCarNews() : [];
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ news }));
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
      data = Buffer.from(data.toString("utf8").replace(/(href|src)="(style\.css|app\.js|config\.js|translate\.js)"/g, (m, a, f) => `${a}="${f}?v=${assetVer(f)}"`));
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
  setTimeout(refreshSuvUsed, 8000); // 小型SUVの中古車相場は、起動の少しあとに、裏で最新にする
  setInterval(refreshSuvUsed, 6 * 60 * 60 * 1000);
});
