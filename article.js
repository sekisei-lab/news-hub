// 記事ページから本文と画像を取り出す（リーダー表示用）。
// 複数ページの記事（rel=next / 「次のページ」リンク）は最大 MAX_PAGES ページまで辿って全文を集める。
const MAX_CHARS = 40000; // 暴走防止の上限
const MAX_PAGES = 8;
const MIN_P = 20; // これより短い段落は無視（見出し・ボタン類）
const NOISE = /無断転載|著作権|Copyright|©|cookie|Cookie|会員登録|ログイン|購読|続きを読む|関連記事|あわせて読みたい|ランキング|この記事は|シェア|フォロー|コメント|広告|利用規約|プライバシー|個人情報|JavaScript|ブラウザ/;

module.exports = function makeExtractor({ fetchText, clean, absUrl }) {
  const cache = new Map(); // url -> { at, data }
  const VER = 4; // 抽出ロジックを変えたら上げる（古いキャッシュを使わない）
  const TTL = 6 * 60 * 60 * 1000;

  const meta = (html, re) => {
    const m =
      new RegExp(`<meta[^>]+(?:property|name)=["'](?:${re})["'][^>]*content=["']([^"']*)["']`, "i").exec(html) ||
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${re})["']`, "i").exec(html);
    return m ? clean(m[1]) : "";
  };

  // <p> ではなく <div> + <br> で本文を書くサイト向け。本文用のクラス名を持つ div を探し、<br> で段落に分ける。
  const BODY_CLASS = /class=["'][^"']*(cXenseParse|player-text|article-text|article-body|article_body|entry-body|post-body|story-body|news-body|honbun)/i;
  function divBodies(h) {
    const out = [];
    const re = /<div[^>]*>/gi;
    let m;
    while ((m = re.exec(h))) {
      if (!BODY_CLASS.test(m[0])) continue;
      // 対応する </div> までを取り出す（入れ子を数える）
      let depth = 1, pos = re.lastIndex;
      const tag = /<(\/?)div[\s>]/gi;
      tag.lastIndex = pos;
      let t;
      while ((t = tag.exec(h))) {
        depth += t[1] ? -1 : 1;
        if (!depth) break;
      }
      const inner = h.slice(pos, t ? t.index : pos);
      if (/<p[\s>]/i.test(inner)) continue; // <p> で書かれているなら通常の抽出に任せる
      const text = inner.replace(/<br\s*\/?>/gi, "\n");
      for (const line of text.split("\n")) {
        const c = clean(line);
        if (c.length >= 12) out.push(c);
      }
    }
    return out;
  }

  function paragraphs(html) {
    let h = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|figcaption|iframe|button)[\s\S]*?<\/\1>/gi, "");
    // <article> があればその中を優先（無ければ全体）
    const art = /<article[\s\S]*?<\/article>/i.exec(h);
    if (art && (art[0].match(/<p[\s>]/gi) || []).length >= 2) h = art[0];
    const out = [];
    const seen = new Set();
    for (const t of divBodies(h)) if (!seen.has(t)) { seen.add(t); out.push(t); }
    for (const m of h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      // リンクの中にある段落・見出し/ランキング/関連用のクラスの段落は本文ではない
      const before = h.slice(Math.max(0, m.index - 3000), m.index);
      if (before.lastIndexOf("<a ") > before.lastIndexOf("</a>")) continue;
      if (/class=["'][^"']*(title|ranking|related|recommend|news-list|caption|credit|tag|breadcrumb)/i.test(m[0].slice(0, m[0].indexOf(">") + 1))) continue;
      const t = clean(m[1]);
      // 段落がほぼリンクだけ＝関連記事・ライブ情報などの誘導なので本文から外す
      let linkLen = 0;
      for (const a of m[1].matchAll(/<a[\s>][\s\S]*?<\/a>/gi)) linkLen += clean(a[0]).length;
      if (t && linkLen / t.length >= 0.8) continue;
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
    if (hit && hit.v === VER && Date.now() - hit.at < TTL) return hit.data;
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
    cache.set(url, { at: Date.now(), v: VER, data });
    return data;
  }
  return extract;
};
