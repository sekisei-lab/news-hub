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
const WATCH_KW = /腕時計|時計|ウォッチ|ロレックス|ROLEX|オメガ|OMEGA|セイコー|SEIKO|カシオ|G-SHOCK|カルティエ|パテック|タグ・ホイヤー|ブライトリング|グランドセイコー|ウブロ|IWC|シチズン|ハミルトン|ヴァシュロン|オーデマ/;

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
  { genre: "finance", source: "Investing.com", url: "https://jp.investing.com/rss/news.rss" },
  { genre: "finance", source: "Yahoo!ニュース", url: Y("business"), filter: FINANCE_KW },
  { genre: "finance", source: "朝日新聞", url: "https://www.asahi.com/rss/asahi/business.rdf", filter: FINANCE_KW },
  { genre: "finance", source: "朝日新聞", url: asahiAll, filter: FINANCE_KW },
  { genre: "finance", source: "共同通信", url: KYODO, filter: FINANCE_KW },
  { genre: "finance", source: "日テレNEWS", url: NTV, filter: FINANCE_KW },
  { genre: "finance", source: "Forbes JAPAN", url: YM("forbes"), filter: FINANCE_KW },
  // 車
  { genre: "car", source: "レスポンス", url: "https://response.jp/rss/index.rdf" },
  { genre: "car", source: "レスポンス", url: "https://response.jp/rss/index.rdf?page=2" },
  { genre: "car", source: "くるまのニュース", url: "https://kuruma-news.jp/feed" },
  ...pages("car", "くるまのニュース", "https://kuruma-news.jp/feed", 8),
  { genre: "car", source: "Motor-Fan", url: "https://motor-fan.jp/feed" },
  // コスメ
  { genre: "cosme", source: "WWD JAPAN", url: "https://www.wwdjapan.com/feed", filter: COSME_KW },
  ...pages("cosme", "WWD JAPAN", "https://www.wwdjapan.com/feed", 2, "?paged=", COSME_KW),
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
  // 腕時計
  { genre: "watch", source: "WATCHNAVI", url: "https://watchnavi.com/feed" },
  { genre: "watch", source: "GQ JAPAN", url: "https://gqjapan.jp/feed", filter: WATCH_KW },
  { genre: "watch", source: "FASHIONSNAP", url: "https://www.fashionsnap.com/rss.xml", filter: WATCH_KW },
  { genre: "watch", source: "WWD JAPAN", url: "https://www.wwdjapan.com/feed", filter: WATCH_KW },
  { genre: "watch", source: "VOGUE JAPAN", url: "https://www.vogue.co.jp/feed/rss", filter: WATCH_KW },
  { genre: "watch", source: "Forbes JAPAN", url: YM("forbes"), filter: WATCH_KW },
  { genre: "watch", source: "PRESIDENT Online", url: YM("president"), filter: WATCH_KW },
  { genre: "watch", source: "Yahoo!ニュース", url: Y("life"), filter: WATCH_KW },
  { genre: "watch", source: "Yahoo!ニュース", url: Y("business"), filter: WATCH_KW },
  { genre: "watch", source: "Yahoo!ニュース", url: Y("entertainment"), filter: WATCH_KW },
];

module.exports = { FEEDS };
