// 記事ページから「本文の冒頭」と画像を取り出す（リーダー表示用）。
// 著作権・負荷に配慮し、本文は冒頭の約 MAX_CHARS 文字までに留め、全文は原文リンクで読んでもらう。
const MAX_CHARS = 900;
const MIN_P = 25; // これより短い段落は無視（見出し・ボタン類）
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
      if (t.length < MIN_P || NOISE.test(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  async function extract(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL) return hit.data;
    const data = { paragraphs: [], image: "", description: "" };
    try {
      const html = (await fetchText(url, 9000)).slice(0, 800000);
      data.image = absUrl(meta(html, "og:image|twitter:image"), url);
      data.description = meta(html, "og:description|description");
      let total = 0;
      for (const p of paragraphs(html)) {
        if (total >= MAX_CHARS) break;
        const room = MAX_CHARS - total;
        data.paragraphs.push(p.length > room ? p.slice(0, room).replace(/[、,\s]+$/, "") + "…" : p);
        total += p.length;
      }
    } catch {
      // 取得失敗時は空のまま（画面側で要約を表示する）
    }
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), data });
    return data;
  }
  return extract;
};
