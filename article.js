// 記事ページから本文と画像を取り出す（リーダー表示用）。
// 複数ページの記事（rel=next / 「次のページ」リンク）は最大 MAX_PAGES ページまで辿って全文を集める。
const MAX_CHARS = 40000; // 暴走防止の上限
const MAX_PAGES = 8;
const MIN_P = 20; // これより短い段落は無視（見出し・ボタン類）
const NOISE = /無断転載|著作権|Copyright|©|cookie|Cookie|会員登録|ログイン|購読|続きを読む|関連記事|あわせて読みたい|ランキング|この記事は|シェア|フォロー|コメント|広告|利用規約|プライバシー|個人情報|JavaScript|ブラウザ/;

module.exports = function makeExtractor({ fetchText, clean, absUrl }) {
  const cache = new Map(); // url -> { at, data }
  const TTL = 6 * 60 * 60 * 1000;

  const meta = (html, re) => {
    const m =
      new RegExp(`<meta[^>]+(?:property|name)=["'](?:${re})["'][^>]*content=["']([^"']*)["']`, "i").exec(html) ||
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${re})["']`, "i").exec(html);
    return m ? clean(m[1]) : "";
  };

  function paragraphs(html) {
    let h = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|figcaption|iframe|button)[\s\S]*?<\/\1>/gi, "");
    // <article> があればその中を優先（無ければ全体）
    const art = /<article[\s\S]*?<\/article>/i.exec(h);
    if (art && (art[0].match(/<p[\s>]/gi) || []).length >= 2) h = art[0];
    const out = [];
    const seen = new Set();
    for (const m of h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const t = clean(m[1]);
      // 長い段落はノイズ語を含んでいても本文として残す
      if (t.length < MIN_P || (t.length < 90 && NOISE.test(t)) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  // 「次のページ」のURLを探す（同じサイト内のみ）
  function nextUrl(html, base) {
    const cands = [];
    for (const m of html.matchAll(/<link[^>]+rel=["']next["'][^>]*>/gi)) {
      const h = /href=["']([^"']+)["']/i.exec(m[0]);
      if (h) cands.push(h[1]);
    }
    for (const m of html.matchAll(/<a\s[^>]*>[\s\S]*?<\/a>/gi)) {
      const tag = m[0];
      const h = /href=["']([^"']+)["']/i.exec(tag);
      if (!h) continue;
      const text = clean(tag);
      if (/rel=["'][^"']*next/i.test(tag) || /^(次のページ|次ページ|次へ|Next)/i.test(text)) cands.push(h[1]);
    }
    for (const c of cands) {
      const u = absUrl(c, base);
      try {
        if (u && u !== base && new URL(u).host === new URL(base).host) return u;
      } catch {}
    }
    return "";
  }

  async function extract(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL) return hit.data;
    const data = { paragraphs: [], image: "", description: "", pages: 0 };
    try {
      let cur = url;
      let total = 0;
      const seenPages = new Set();
      const seenP = new Set();
      for (let page = 1; page <= MAX_PAGES && cur && !seenPages.has(cur); page++) {
        seenPages.add(cur);
        const html = (await fetchText(cur, 9000)).slice(0, 1500000);
        if (page === 1) {
          data.image = absUrl(meta(html, "og:image|twitter:image"), url);
          data.description = meta(html, "og:description|description");
        }
        for (const p of paragraphs(html)) {
          if (seenP.has(p)) continue;
          seenP.add(p);
          data.paragraphs.push(p);
          total += p.length;
        }
        data.pages = page;
        if (total >= MAX_CHARS) break;
        cur = nextUrl(html, cur);
      }
    } catch {
      // 取得失敗時は取れた分だけ返す（画面側で要約を表示する）
    }
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), data });
    return data;
  }
  return extract;
};
