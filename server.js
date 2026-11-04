// News Hub server — 依存ライブラリなし (Node 18+)
// RSSを定期取得 → 概要を整形 → /api/news で配信。public/ も同時に配信。
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 3 * 60 * 1000; // フィード再取得間隔
const MAX_PER_GENRE = 40;
const UA = "Mozilla/5.0 (compatible; NewsHub/1.0)";

const GENRES = {
  politics: { label: "政治" },
  economy: { label: "経済" },
  finance: { label: "金融" },
  car: { label: "車" },
  cosme: { label: "コスメ" },
};

// filter: 指定すると、タイトル/概要/カテゴリにキーワードを含む記事だけ採用
const FINANCE_KW = /株価|株式市場|株式相場|日経平均|為替|円安|円高|ドル|日銀|金利|利上げ|利下げ|国債|銀行|証券|金融|投資|FRB|相場|決算|NISA|ビットコイン|暗号資産/;
const COSME_KW = /美容|コスメ|ビューティ|スキンケア|化粧|メイク|メーキャップ|香水|フレグランス|ヘアケア|ネイル|リップ|ファンデ|資生堂|コーセー|カネボウ|ロレアル|ポーラ|シャネル ビューティ|ディオール ビューティ/;

// 広告・PR記事は除外
const AD_RE = /［PR］|\[PR\]|【PR】|\bPR\b|PR TIMES|プレスリリース|Sponsored/i;

const FEEDS = [
  { genre: "politics", source: "NHK", url: "https://www3.nhk.or.jp/rss/news/cat4.xml" },
  { genre: "politics", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/politics.rdf" },
  { genre: "economy", source: "NHK", url: "https://www3.nhk.or.jp/rss/news/cat5.xml" },
  { genre: "economy", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/business.rdf" },
  { genre: "economy", source: "Yahoo!ニュース", url: "https://news.yahoo.co.jp/rss/categories/business.xml" },
  { genre: "economy", source: "東洋経済", url: "https://toyokeizai.net/list/feed/rss" },
  { genre: "finance", source: "Investing.com", url: "https://jp.investing.com/rss/news.rss" },
  { genre: "finance", source: "NHK", url: "https://www3.nhk.or.jp/rss/news/cat5.xml", filter: FINANCE_KW },
  { genre: "finance", source: "Yahoo!ニュース", url: "https://news.yahoo.co.jp/rss/categories/business.xml", filter: FINANCE_KW },
  { genre: "finance", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/business.rdf", filter: FINANCE_KW },
  { genre: "car", source: "レスポンス", url: "https://response.jp/rss/index.rdf" },
  { genre: "car", source: "くるまのニュース", url: "https://kuruma-news.jp/feed" },
  { genre: "car", source: "Motor-Fan", url: "https://motor-fan.jp/feed" },
  { genre: "cosme", source: "WWD JAPAN", url: "https://www.wwdjapan.com/feed", filter: COSME_KW },
  { genre: "cosme", source: "VOGUE JAPAN", url: "https://www.vogue.co.jp/feed/rss", filter: COSME_KW },
  { genre: "cosme", source: "FASHIONSNAP", url: "https://www.fashionsnap.com/rss.xml", filter: COSME_KW },
];

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
      cats,
      time: isNaN(t) ? 0 : t,
    };
  });
}

// ---------- 概要の整形 ----------
const SUMMARY_LEN = 110; // 2行に収まる目安
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
  let v = "";
  try {
    const html = (await fetchText(url, 8000)).slice(0, 200000);
    const m =
      /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*content=["']([^"']*)["']/i.exec(html) ||
      /<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:og:description|description)["']/i.exec(html);
    v = m ? clean(m[1]) : "";
  } catch {}
  if (ogCache.size > 3000) ogCache.delete(ogCache.keys().next().value);
  ogCache.set(url, v);
  return v;
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
let refreshing = null;

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const byGenre = {};
    const errors = {};
    const rawCache = new Map(); // 同じURLを二重取得しない
    await Promise.all(
      FEEDS.map(async (f) => {
        try {
          if (!rawCache.has(f.url)) rawCache.set(f.url, fetchText(f.url).then(parseFeed));
          let items = (await rawCache.get(f.url)).filter((i) => !AD_RE.test(i.title));
          if (f.filter) items = items.filter((i) => f.filter.test(`${i.title} ${i.desc} ${i.cats}`.replace(/株式会社/g, "")));
          (byGenre[f.genre] ||= []).push(...items.map((i) => ({ ...i, source: f.source, genre: f.genre })));
        } catch (e) {
          errors[f.url] = String(e.message || e);
        }
      })
    );
    const out = {};
    for (const g of Object.keys(GENRES)) {
      const seen = new Set();
      const list = (byGenre[g] || [])
        .filter((i) => i.title && i.link && !seen.has(i.link) && seen.add(i.link))
        .sort((a, b) => b.time - a.time)
        .slice(0, MAX_PER_GENRE);
      // 概要が無い/汎用文のものはページから補完
      await pool(list, 6, async (i) => {
        if (!i.desc || GENERIC_DESC.test(i.desc) || i.desc === i.title) i.desc = await fetchOg(i.link);
      });
      out[g] = list.map((i) => ({
        title: i.title,
        link: i.link.replace(/^http:\/\/(www3\.nhk)/, "https://$1"),
        summary: trimSummary(i.desc, i.title),
        source: i.source,
        genre: i.genre,
        time: i.time,
      }));
    }
    store.items = out;
    store.errors = errors;
    store.updatedAt = Date.now();
    console.log(
      new Date().toISOString(),
      "refreshed",
      Object.entries(out).map(([k, v]) => `${k}:${v.length}`).join(" "),
      Object.keys(errors).length ? `errors:${Object.keys(errors).length}` : ""
    );
  })().finally(() => (refreshing = null));
  return refreshing;
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/news") {
    if (!store.updatedAt) await refresh(); // 初回のみ待つ
    else if (Date.now() - store.updatedAt > REFRESH_MS) refresh(); // 古ければ裏で更新
    const genre = url.searchParams.get("genre") || "all";
    const seen = new Set(); // 「すべて」では複数ジャンルに重複する記事を1件にまとめる
    let items =
      genre === "all"
        ? Object.values(store.items).flat().sort((a, b) => b.time - a.time).filter((i) => !seen.has(i.link) && seen.add(i.link))
        : store.items[genre] || [];
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    return res.end(JSON.stringify({ updatedAt: store.updatedAt, genres: GENRES, items }));
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

server.listen(PORT, () => {
  console.log(`News Hub on :${PORT}`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});
