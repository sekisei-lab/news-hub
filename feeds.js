// ニュース取得元の定義。媒体・ジャンルを増やすときはここを編集する。
// filter: 指定すると、タイトル/概要/カテゴリにキーワードを含む記事だけ採用

const FINANCE_KW = /株価|株式市場|株式相場|日経平均|為替|円安|円高|ドル|日銀|金利|利上げ|利下げ|国債|銀行|証券|金融|投資|FRB|相場|決算|NISA|ビットコイン|暗号資産/;
const COSME_KW = /美容|コスメ|ビューティ|スキンケア|化粧|メイク|メーキャップ|香水|フレグランス|ヘアケア|ネイル|リップ|ファンデ|資生堂|コーセー|カネボウ|ロレアル|ポーラ|シャネル ビューティ|ディオール ビューティ/;
const POLITICS_KW = /首相|政府|与党|野党|国会|衆院|参院|大臣|官房長官|自民|立憲|公明|維新|国民民主|選挙|知事選|外交|首脳会談|内閣|議員|法案|条約/;
const ECON_KW = /経済|景気|物価|賃上げ|賃金|消費|関税|貿易|企業|業績|市場|価格|値上げ|需要|輸出|輸入|雇用|GDP|税/;
const WORLD_KW = /米国|アメリカ|中国|ロシア|ウクライナ|欧州|EU|韓国|北朝鮮|台湾|大統領|イスラエル|ガザ|イラン|インド|英国|フランス|ドイツ|トランプ|国連|NATO/;
const SPORTS_KW = /野球|サッカー|五輪|オリンピック|Jリーグ|大相撲|ゴルフ|テニス|バスケ|ラグビー|バレー|陸上|マラソン|競馬|ボクシング|MLB|大谷|プロ野球|W杯|ワールドカップ|選手権/;
const GOURMET_KW = /グルメ|ラーメン|カフェ|レストラン|スイーツ|ランチ|ディナー|居酒屋|寿司|コンビニ|新商品|料理|レシピ|食べ|ビール|ワイン|ケーキ|チョコ|パン屋|ファミレス|フード/;
const HEALTH_KW = /健康|医療|病気|がん|ダイエット|睡眠|ワクチン|感染|症状|認知症|医師|病院|薬|うつ|糖尿|血圧|筋トレ|ストレス|インフル|栄養/;
const TRAVEL_KW = /旅行|観光|温泉|ホテル|旅館|空港|航空|新幹線|ツアー|訪日|インバウンド|絶景|旅/;
const GAME_KW = /ゲーム|Switch|PS5|PlayStation|任天堂|ポケモン|eスポーツ|Steam/;

const asahiAll = "https://www.asahi.com/rss/asahi/newsheadlines.rdf";
const Y = (c) => `https://news.yahoo.co.jp/rss/categories/${c}.xml`;
const YM = (m) => `https://news.yahoo.co.jp/rss/media/${m}/all.xml`;
const KYODO = YM("kyodonews");
const NTV = "https://news.ntv.co.jp/rss/index.rdf";
const TXBIZ = "https://txbiz.tv-tokyo.co.jp/rss.xml"; // テレ東BIZ（モーサテ等）
const LIFEHACK = "https://www.lifehacker.jp/feed/index.xml";

// 古い記事も拾えるよう、ページ送りできるフィードは複数ページ取得する
const pages = (genre, source, base, n, sep = "?paged=", filter) =>
  Array.from({ length: n - 1 }, (_, k) => ({ genre, source, url: base + sep + (k + 2), filter }));

const FEEDS = [
  // 政治
  { genre: "politics", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/politics.rdf" },
  { genre: "politics", source: "朝日新聞", url: asahiAll, filter: POLITICS_KW },
  { genre: "politics", source: "Yahoo!ニュース", url: Y("domestic"), filter: POLITICS_KW },
  { genre: "politics", source: "共同通信", url: KYODO, filter: POLITICS_KW },
  { genre: "politics", source: "日テレNEWS", url: NTV, filter: POLITICS_KW },
  // 経済
  { genre: "economy", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/business.rdf" },
  { genre: "economy", source: "朝日新聞", url: asahiAll, filter: ECON_KW },
  { genre: "economy", source: "Yahoo!ニュース", url: Y("business") },
  { genre: "economy", source: "テレ東BIZ", url: TXBIZ },
  { genre: "economy", source: "東洋経済", url: "https://toyokeizai.net/list/feed/rss" },
  ...pages("economy", "東洋経済", "https://toyokeizai.net/list/feed/rss", 3, "?page="),
  { genre: "economy", source: "PRESIDENT Online", url: "https://president.jp/list/rss" },
  { genre: "economy", source: "Forbes JAPAN", url: YM("forbes") },
  { genre: "economy", source: "Business Insider", url: "https://www.businessinsider.jp/feed/index.xml" },
  { genre: "economy", source: "共同通信", url: KYODO, filter: ECON_KW },
  { genre: "economy", source: "日テレNEWS", url: NTV, filter: ECON_KW },
  // 金融
  { genre: "finance", source: "テレ東BIZ", url: TXBIZ },
  { genre: "finance", source: "Yahoo!ニュース", url: Y("business"), filter: FINANCE_KW },
  { genre: "finance", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/business.rdf", filter: FINANCE_KW },
  { genre: "finance", source: "朝日新聞", url: asahiAll, filter: FINANCE_KW },
  { genre: "finance", source: "共同通信", url: KYODO, filter: FINANCE_KW },
  { genre: "finance", source: "日テレNEWS", url: NTV, filter: FINANCE_KW },
  { genre: "finance", source: "Forbes JAPAN", url: YM("forbes"), filter: FINANCE_KW },
  // Yahoo!ニュース経由の経済・マネー系メディア（本文を詳細画面で読める）
  { genre: "finance", source: "みんかぶ", url: YM("minkabu") },
  { genre: "finance", source: "MONEY PLUS", url: YM("moneyplus") },
  { genre: "finance", source: "マネーポストWEB", url: YM("moneypost"), filter: FINANCE_KW },
  { genre: "finance", source: "ダイヤモンド・オンライン", url: YM("diamond"), filter: FINANCE_KW },
  { genre: "finance", source: "東洋経済", url: YM("toyo"), filter: FINANCE_KW },
  // 車
  { genre: "car", source: "レスポンス", url: "https://response.jp/rss/index.rdf" },
  { genre: "car", source: "レスポンス", url: "https://response.jp/rss/index.rdf?page=2" },
  { genre: "car", source: "くるまのニュース", url: "https://kuruma-news.jp/feed" },
  ...pages("car", "くるまのニュース", "https://kuruma-news.jp/feed", 8),
  { genre: "car", source: "Motor-Fan", url: "https://motor-fan.jp/feed" },
  // コスメ
  // WWD JAPAN は本体サイトが自動取得を拒否するため、本文を読める Yahoo!ニュース経由のフィードを使う
  { genre: "cosme", source: "WWD JAPAN", url: YM("wwdjapan"), filter: COSME_KW },
  { genre: "cosme", source: "VOGUE JAPAN", url: "https://www.vogue.co.jp/feed/rss", filter: COSME_KW },
  { genre: "cosme", source: "FASHIONSNAP", url: "https://www.fashionsnap.com/rss.xml", filter: COSME_KW },
  // 国内
  { genre: "national", source: "Yahoo!ニュース", url: Y("domestic") },
  { genre: "national", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/national.rdf" },
  { genre: "national", source: "共同通信", url: KYODO },
  { genre: "national", source: "日テレNEWS", url: NTV },
  { genre: "national", source: "時事通信", url: "https://www.jiji.com/rss/ranking.rdf" },
  { genre: "national", source: "現代ビジネス", url: "https://gendai.media/list/feed/rss" },
  // 国際
  { genre: "world", source: "Yahoo!ニュース", url: Y("world") },
  { genre: "world", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/international.rdf" },
  { genre: "world", source: "共同通信", url: KYODO, filter: WORLD_KW },
  { genre: "world", source: "日テレNEWS", url: NTV, filter: WORLD_KW },
  // スポーツ
  { genre: "sports", source: "Yahoo!ニュース", url: Y("sports") },
  { genre: "sports", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/sports.rdf" },
  { genre: "sports", source: "日刊スポーツ", url: "https://www.nikkansports.com/baseball/atom.xml" },
  { genre: "sports", source: "共同通信", url: KYODO, filter: SPORTS_KW },
  { genre: "sports", source: "日テレNEWS", url: NTV, filter: SPORTS_KW },
  // エンタメ
  { genre: "entertainment", source: "Yahoo!ニュース", url: Y("entertainment") },
  { genre: "entertainment", source: "livedoorニュース", url: "https://news.livedoor.com/topics/rss/ent.xml" },
  { genre: "entertainment", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/culture.rdf" },
  { genre: "entertainment", source: "文春オンライン", url: "https://bunshun.jp/list/feed/rss" },
  { genre: "entertainment", source: "CINRA", url: "https://www.cinra.net/feed" },
  // IT
  { genre: "it", source: "Yahoo!ニュース", url: Y("it") },
  { genre: "it", source: "Impress Watch", url: "https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf" },
  { genre: "it", source: "GIGAZINE", url: "https://gigazine.net/news/rss_2.0/" },
  { genre: "it", source: "Gizmodo Japan", url: "https://www.gizmodo.jp/index.xml" },
  { genre: "it", source: "ITmedia", url: "https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml" },
  { genre: "it", source: "ASCII.jp", url: "https://ascii.jp/rss.xml" },
  { genre: "it", source: "日経xTECH", url: "https://xtech.nikkei.com/rss/index.rdf" },
  { genre: "it", source: "マイナビニュース", url: "https://news.mynavi.jp/rss/index" },
  // 科学
  { genre: "science", source: "Yahoo!ニュース", url: Y("science") },
  { genre: "science", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/science.rdf" },
  // ライフ
  { genre: "life", source: "Yahoo!ニュース", url: Y("life") },
  { genre: "life", source: "ライフハッカー", url: LIFEHACK },
  { genre: "life", source: "GQ JAPAN", url: "https://gqjapan.jp/feed" },
  // グルメ・健康・旅行（各媒体からキーワードで抽出）
  { genre: "gourmet", source: "Yahoo!ニュース", url: Y("life"), filter: GOURMET_KW },
  { genre: "gourmet", source: "Yahoo!ニュース", url: Y("entertainment"), filter: GOURMET_KW },
  { genre: "gourmet", source: "Yahoo!ニュース", url: Y("local"), filter: GOURMET_KW },
  { genre: "gourmet", source: "ライフハッカー", url: LIFEHACK, filter: GOURMET_KW },
  { genre: "gourmet", source: "日テレNEWS", url: NTV, filter: GOURMET_KW },
  { genre: "health", source: "Yahoo!ニュース", url: Y("life"), filter: HEALTH_KW },
  { genre: "health", source: "Yahoo!ニュース", url: Y("science"), filter: HEALTH_KW },
  { genre: "health", source: "Yahoo!ニュース", url: Y("domestic"), filter: HEALTH_KW },
  { genre: "health", source: "共同通信", url: KYODO, filter: HEALTH_KW },
  { genre: "health", source: "ライフハッカー", url: LIFEHACK, filter: HEALTH_KW },
  { genre: "travel", source: "Travel Voice", url: "https://www.travelvoice.jp/feed" },
  { genre: "travel", source: "Yahoo!ニュース", url: Y("life"), filter: TRAVEL_KW },
  { genre: "travel", source: "Yahoo!ニュース", url: Y("local"), filter: TRAVEL_KW },
  { genre: "travel", source: "日テレNEWS", url: NTV, filter: TRAVEL_KW },
  // ゲーム
  { genre: "game", source: "4Gamer", url: "https://www.4gamer.net/rss/index.xml" },
  { genre: "game", source: "Yahoo!ニュース", url: Y("it"), filter: GAME_KW },
];

// ---- 特集: 全長4,600mm以下のコンパクトSUV（新車情報・中古情報）----
// 車ジャンルの記事のうち、全長4.6m以下の代表的なSUVの車名、または「小型/コンパクトのSUV」とある記事だけを集める
const KANA = "[ァ-ヶー]";
const SUV_MODELS = [
  "ヤリス ?クロス", `(?<!${KANA})ライズ(?!${KANA})`, `(?<!${KANA})ロッキー(?!${KANA})`, "ヴェゼル", "ZR-V", "ＺＲ-Ｖ", "WR-V", "HR-V", "CX-3(?!\d)", "CX-30", "MX-30",
  "キックス", "クロストレック", "ジムニー", "クロスビー", "ハスラー", "カローラ ?クロス", "C-HR", "エクリプス ?クロス", "デリカミニ", "ジューク", "LBX", "フロンクス",
  "アーバンクルーザー", "ビターラ", "エスクード", "T-?Cross", "Tクロス", "T-?Roc", "ティグアン", "プジョー ?(?:2008|3008)", "キャプチャー", "アルカナ", "(?:MINI|ミニ) ?(?:クロスオーバー|カントリーマン)",
  "フィアット ?600", "アバルト ?600", "アベンジャー", "レネゲード", "EX30", "XC40", "アウディ ?Q[23](?!\d)", "[BＢ][MＭ][WＷ] ?(?:i?X[12])(?!\d)", "メルセデス.{0,6}GLA", "ヒョンデ ?コナ", "KONA", "ATTO ?3", "e:Ny1",
].join("|");
const SUV_GENERIC = "(?=.*(?:SUV|ＳＵＶ))(?=.*(?:コンパクト|小型|全長4[,.]?[0-5]\d{2}|全長4\.[0-5]|4[0-5]\d{2}mm))";
const SUV_MODEL_RE = new RegExp(SUV_MODELS, "i");
// コンパクトバン（全長4,600mm以下の商用バン・軽バン）。ニュースカード用
const VAN_MODELS = [
  "プロボックス", "サクシード", "タウンエース", "ライトエース", "NV150 ?AD", "ADバン", "N-VAN", "ハイゼット ?カーゴ", "エブリイ", "エブリィ", "(?<!${KANA})クリッパー(?!${KANA})", "ミニキャブ", "サンバー", "カングー", "ベルランゴ",
  "プジョー ?(?:リフター|パートナー)", "(?:VW|フォルクスワーゲン) ?キャディ", "コンパクトバン", "小型バン", "軽バン", "軽商用", "商用バン",
].join("|");
const VAN_GENERIC = "(?=.*(?<!${KANA})バン(?!${KANA}))(?=.*(?:コンパクト|小型|全長4[,.]?[0-5]\d{2}|全長4\.[0-5]))";
const SUV_RE = new RegExp(`(?:${SUV_MODELS})|(?:${SUV_GENERIC})|(?:${VAN_MODELS})|(?:${VAN_GENERIC})`, "is");
FEEDS.push(...FEEDS.filter((f) => f.genre === "car").map((f) => ({ ...f, genre: "suv", filter: SUV_RE })));
// 中古車の情報（グーネット）や、他のクルマ専門メディアからも、同じ条件で集める
FEEDS.push(
  { genre: "suv", source: "グーネット", url: "https://www.goo-net.com/magazine/feed/", filter: SUV_RE },
  { genre: "suv", source: "WebCG", url: "https://www.webcg.net/list/feed/rss", filter: SUV_RE },
  { genre: "suv", source: "ベストカーWeb", url: "https://bestcarweb.jp/feed", filter: SUV_RE },
);


// ---- 情報量の底上げ: ジャンルに合う専門媒体（Yahoo!ニュース経由。1媒体あたり約50件）と、全国・地方のテレビ局の記事から、キーワードで拾う ----
const SCIENCE_KW = /宇宙|ロケット|探査機|惑星|天文|彗星|流星群|月面|小惑星|JAXA|NASA|研究チーム|研究グループ|化石|恐竜|ノーベル賞|量子|iPS|ゲノム|気候変動|温暖化|地震|火山|噴火|絶滅|論文|素粒子|ブラックホール|核融合|発見され|新種/;
const MORE = (genre, source, media, filter) => ({ genre, source, url: YM(media), filter });
// 全国・地方のテレビ局、通信社（どのジャンルにも、キーワードで該当記事を拾う）
const BROADCASTERS = [["ANN", "ann"], ["FNNプライム", "fnnprimev"], ["CNN", "cnn"], ["BBC", "bbc"], ["中京テレビ", "nbn"], ["MBS", "mbsnews"], ["MBC南日本放送", "mbcnews"], ["Tokai", "tokai"], ["KYT", "kyt"], ["withnews", "withnews"]];
const GENRE_KW = { politics: POLITICS_KW, health: HEALTH_KW, travel: TRAVEL_KW, gourmet: GOURMET_KW, science: SCIENCE_KW };
for (const [g, kw] of Object.entries(GENRE_KW)) for (const [src, m] of BROADCASTERS) FEEDS.push(MORE(g, src, m, kw));
FEEDS.push(
  // 政治
  MORE("politics", "選挙ドットコム", "senkyocom"), MORE("politics", "Yahoo!ニュース世論調査", "yjyoron"), MORE("politics", "野村総研", "nrin", POLITICS_KW),
  // 健康（専門媒体）
  MORE("health", "メディカルドック", "medicald"), MORE("health", "Medical DOC", "medical"), MORE("health", "健康産業速報", "kenkosoku"), MORE("health", "健康産業新聞", "kenkoshin"), MORE("health", "日経Goody", "gooday"),
  MORE("health", "FITNESS LOVE", "fitlove"), MORE("health", "ヨガジャーナル", "yogajol"), MORE("health", "Tarzan", "tarzanweb", HEALTH_KW), MORE("health", "Women's Health", "womensh", HEALTH_KW), MORE("health", "kosodate", "kosodate", HEALTH_KW),
  // 旅行
  MORE("travel", "トラベル Watch", "travelv"), MORE("travel", "旅行読売", "ryokoyom"), MORE("travel", "日経スタイル", "nikkeisty", TRAVEL_KW), MORE("travel", "Hanako", "hanako", TRAVEL_KW), MORE("travel", "Lmaga", "lmaga", TRAVEL_KW),
  MORE("travel", "共同通信", "kyodonews", TRAVEL_KW), { genre: "travel", source: "朝日新聞", url: asahiAll, filter: TRAVEL_KW },
  // コスメ・美容
  MORE("cosme", "MAQUIA", "maquia"), MORE("cosme", "VOCE", "voce"), MORE("cosme", "美的", "biteki"),
  ...[["mimollet", "mimollet"], ["cancam", "CanCam"], ["ellegirl", "ELLE girl"], ["elleonline", "ELLE"], ["spur", "SPUR"], ["baila", "BAILA"], ["eclat", "éclat"], ["withonline", "with"], ["ananweb", "anan"], ["bazaar", "Harper's BAZAAR"], ["gisele", "GISELe"], ["nonno", "non-no"], ["lee", "LEE"], ["gingerweb", "GINGER"]].map(([m, n]) => MORE("cosme", n, m, COSME_KW)),
  // グルメ
  MORE("gourmet", "食べログマガジン", "tabelog"), MORE("gourmet", "食楽web", "syokuraku"), MORE("gourmet", "食品新聞", "shokuhin"), MORE("gourmet", "グルメ Watch", "impgrw"), MORE("gourmet", "dancyu", "dancyu"),
  MORE("gourmet", "Hanako", "hanako", GOURMET_KW), MORE("gourmet", "Goethe", "goethe", GOURMET_KW), MORE("gourmet", "Lmaga", "lmaga", GOURMET_KW), MORE("gourmet", "共同通信", "kyodonews", GOURMET_KW),
  // 科学
  MORE("science", "sorae", "sorae_jp"), MORE("science", "ナショジオ", "nknatiogeo"), MORE("science", "共同通信", "kyodonews", SCIENCE_KW), { genre: "science", source: "朝日新聞", url: asahiAll, filter: SCIENCE_KW },
);

// ---------- Australia（英語ジャンル。全ジャンル横断の「すべて」には混ぜない）----------
const ABC = (id) => `https://www.abc.net.au/news/feed/${id}/rss.xml`;
[
  ["ABC News", ABC(51120)], ["ABC News", ABC(1534)], ["ABC News", ABC(45910)], ["ABC News", ABC(51892)], ["ABC News", ABC(45924)],
  ["SBS News", "https://www.sbs.com.au/news/feed"], ["SBS News", "https://www.sbs.com.au/news/topic/australia/feed"],
  ["The Guardian Australia", "https://www.theguardian.com/australia-news/rss"],
  ["The Guardian Australia", "https://www.theguardian.com/australia-news/australian-politics/rss"],
  ["The Sydney Morning Herald", "https://www.smh.com.au/rss/feed.xml"],
  ["The Age", "https://www.theage.com.au/rss/feed.xml"],
  ["Brisbane Times", "https://www.brisbanetimes.com.au/rss/feed.xml"],
  ["WAtoday", "https://www.watoday.com.au/rss/feed.xml"],
  ["The Canberra Times", "https://www.canberratimes.com.au/rss.xml"],
].forEach(([source, url]) => FEEDS.push({ genre: "australia", source, url }));

module.exports = { FEEDS, SUV_MODEL_RE };
