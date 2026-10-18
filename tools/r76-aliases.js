/* ============================================================================
 *  r76：给 engines.json 补「经典别名」
 *
 *  用户原话：「丰富一下很多网站的经典别名，比如说哔哩哔哩它又被叫做 b 站，
 *  那如果我搜 b 站，照理来说也应该能够出现哔哩哔哩的相关内容，其他的一些
 *  搜索引擎也是如此。」
 *
 *  背景：engines.json 里 777 个引擎，`alias` 覆盖率只有三成，而搜索
 *  （ui/bar.js 的 engineMatches）是「name + alias」都比才算命中 —— 于是用户
 *  按自己的叫法（B站 / Bilibili / 小破站）搜哔哩哔哩，一个字都出不来。
 *
 *  做法（为什么用工具而不是手改 JSON）：
 *    ① 引擎表是 777 行的大文件，手改必错且无法回归；
 *    ② 别名是**纯数据**，和引擎的 url/icon 无关，用一个工具按名字批量打标，
 *       跑完用 JSON.parse + 断言验证格式没坏；
 *    ③ 幂等：已有别名的引擎**保留原值**（可能有人工精调过的），只往里**新增**，
 *       重复跑不会翻倍。
 *
 *  ⚠ 数据形状：同一个站常有**两条**——`哔哩哔哩`（search 类）和
 *    `哔哩哔哩（首页）`（open 类）。别名按「核心名」打，两条都会拿到同一组，
 *    用户搜「B站」时搜索类和直达首页都出来，这才叫"搜出来相关内容"。
 *
 *  用法：
 *      node tools/r76-aliases.js           # 写入
 *      node tools/r76-aliases.js --dry     # 只统计，不写
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ui', 'data', 'engines.json');
const DRY = process.argv.includes('--dry');

/* 经典别名表。键 = engines.json 里的**核心名**（不带「（首页）」后缀）。 */
const ALIASES = {
    /* ---------- 搜索引擎 / 门户 ---------- */
    '百度': ['baidu', 'Baidu', '度娘', '百度搜索'],
    '必应': ['bing', 'Bing', '微软搜索'],
    '谷歌': ['Google', 'google', '谷歌搜索'],
    '搜狗': ['sogou', 'Sogou', '搜狗搜索'],
    '360': ['360搜索', '好搜'],
    '360 搜索': ['360搜索', '好搜', '360'],
    'Yandex': ['yandex', '燕基', '俄罗斯搜索'],
    'DuckDuckGo': ['ddg', '鸭鸭走', 'DuckDuckGo搜索'],
    'Yahoo': ['雅虎', '雅虎搜索'],
    'Brave 搜索': ['Brave', '勇敢搜索'],
    'Ecosia': ['ecosia', '生态搜索', '种树搜索'],
    'Qwant': ['qwant', '匡特'],
    'Mojeek': ['mojeek', '摩杰克'],
    'Startpage': ['startpage', '起始页'],
    '神马搜索': ['神马', 'UC搜索'],
    '夸克搜索': ['夸克', 'Quark'],
    '头条搜索': ['今日头条搜索', '字节搜索'],
    '无追搜索': ['无追', '无痕搜索'],
    '中国搜索': ['中国搜索（首页）'],

    /* ---------- AI 工具 ---------- */
    'DeepSeek': ['deepseek', '深度求索', '幻方'],
    '豆包': ['Doubao', '字节AI'],
    'Kimi': ['kimi', '月之暗面', 'Moonshot'],
    '通义': ['通义千问', 'Tongyi', '阿里AI'],
    '通义千问': ['通义', 'Tongyi', '阿里AI'],
    'Qwen Chat': ['Qwen', '千问'],
    '腾讯元宝': ['元宝', '混元', 'Hunyuan'],
    '智谱清言': ['ChatGLM', '智谱', 'GLM'],
    '文心一言': ['ERNIE Bot', '文心', '百度AI'],
    '海螺AI': ['海螺', 'MiniMax'],
    '知乎直答': ['知乎AI', '直答'],
    '秘塔AI搜索': ['秘塔', 'metaso'],
    'ChatGPT': ['chatgpt', 'GPT', '聊天GPT', 'OpenAI聊天'],
    'Claude': ['claude', '克劳德', 'Anthropic'],
    'Gemini': ['gemini', '谷歌AI', '双子座'],
    'Perplexity AI': ['perp', '困惑', 'AI搜索', 'Perplexity'],
    'Perplexity': ['perp', '困惑', 'AI搜索'],
    'Grok': ['grok', '马斯克AI'],
    'Copilot': ['copilot', '副驾', 'Github Copilot'],
    'Mistral': ['mistral', '米斯特拉尔'],
    'Hugging Face': ['HF', 'huggingface', '抱脸'],
    'Poe': ['poe', 'Quora AI'],
    '讯飞星火': ['星火', 'iFlytek', '讯飞AI'],
    'Midjourney': ['MJ', 'midjourney', '弥杰'],

    /* ---------- 知识 / 百科 ---------- */
    '知乎': ['zhihu', 'ZhiHu', '知乎网'],
    'StackOverflow': ['SO', 'stackoverflow', '栈溢出', '程序员问答'],
    'StackOverflow(谷歌)': ['SO', 'stackoverflow', '栈溢出'],
    'Stack Exchange': ['SE', 'stackexchange'],
    'Stack Overflow': ['SO', 'stackoverflow', '栈溢出'],
    '脉脉': ['maimai', 'Maimai', '职场社交'],
    '百度知道': ['知道'],
    '维基百科': ['Wikipedia', 'wikipedia', '维基', 'wiki'],
    '百度百科': ['baike', '百科'],
    '豆瓣读书': ['豆瓣读书', '读书'],
    '微信(搜狗)': ['微信搜索', '搜狗微信'],
    'Quora': ['quora', '夸拉', '美国知乎'],
    '简书': ['jianshu', '简书网'],
    '果壳': ['果壳网', 'guokr'],
    '少数派': ['sspai', '少数派'],
    '萌娘百科': ['萌百', 'Moegirlpedia'],
    '百度文库': ['文库', '百度文档'],
    '百度经验': ['经验'],
    '维基词典': ['Wiktionary', 'wiktionary'],
    'WikiHow': ['wikihow', '怎么做'],
    '维基文库': ['Wikisource', 'wikisource'],
    '搜狗百科': ['搜狗百科（首页）'],
    '360 百科': ['360百科'],
    'MBA 智库百科': ['MBA智库', '智库百科'],

    /* ---------- 开发 ---------- */
    'GitHub': ['gayhub', 'gh', 'GayHub', '全球最大同性交友网站'],
    'GitLab': ['gitlab', 'GL'],
    'Gitee': ['码云', 'gitee', '开源中国'],
    'Bitbucket': ['bitbucket', 'BB'],
    'Codeberg': ['codeberg', 'CB'],
    '掘金': ['juejin', 'Juejin', '稀土掘金'],
    'CSDN': ['csdn', '中国专业IT社区'],
    'SegmentFault': ['SF', 'segmentfault', '思否'],
    '博客园': ['cnblogs', '园子'],
    '开源中国': ['OSChina', 'oschina'],
    'MDN': ['MDN Web Docs', 'mdn', '前端文档'],
    'crates.io': ['crates', 'Rust包', 'Rust注册表'],
    'Go Packages': ['golang包', 'pkg.go.dev'],
    'NuGet': ['nuget', '.NET包'],
    'Packagist': ['packagist', 'PHP包'],
    'RubyGems': ['gems', 'ruby包'],
    'npm': ['npm包', 'Node包管理', 'NPM'],
    'PyPI': ['pip源', 'pypi', 'Python包索引'],
    'PyPI 搜索': ['pypi', 'pip'],
    'Maven': ['maven', '马文', 'Java包'],
    'Docker Hub': ['dockerhub', 'Docker镜像', '码头'],
    'Sourcegraph': ['sg', '代码搜索'],
    'Conda': ['conda', 'Anaconda包'],
    'Arch Wiki': ['archwiki', 'Arch Linux Wiki'],
    'Lobsters': ['lobsters', '龙虾'],
    'DEV': ['dev.to', '开发者社区'],
    'LeetCode': ['力扣', 'leetcode', 'LC', '刷题'],
    'leetcode': ['力扣', 'LC', '刷题'],
    '菜鸟教程': ['runoob', '菜鸟'],
    '腾讯云社区': ['腾讯云', 'cloud.tencent'],
    '阿里云开发者': ['阿里云', 'aliyun'],
    'InfoQ': ['infoq', '信息Q'],
    'V2EX': ['v2ex', 'V站'],
    'V2EX(谷歌)': ['v2ex', 'V站'],
    'Hacker News': ['HN', 'hackernews', '黑客新闻'],
    'Apache Issues': ['apache issues', 'Apache问题'],

    /* ---------- 翻译 ---------- */
    '百度翻译': ['baidu翻译', '百度机翻'],
    '谷歌翻译': ['Google翻译', 'google translate', '机翻'],
    '有道词典': ['有道', 'youdao'],
    '有道翻译': ['有道', 'youdao'],
    '必应翻译': ['Bing翻译', '微软翻译'],
    'DeepL': ['deepl', 'deepL翻译', '德国翻译'],
    '搜狗翻译': ['搜狗机翻'],
    'Yandex 翻译': ['yandex翻译'],
    'Papago': ['papago', '韩国翻译', 'naver翻译'],
    'Linguee': ['灵格', '例句翻译'],
    'Reverso': ['reverso', '上下文翻译'],
    '腾讯翻译君': ['翻译君', '腾讯翻译'],
    '彩云小译': ['彩云', '小译'],

    /* ---------- 地图 ---------- */
    '百度地图': ['baidu地图'],
    '高德地图': ['高德', 'Amap', 'amap'],
    '谷歌地图': ['Google Maps', 'google maps'],
    '谷歌地球': ['Google Earth', 'google earth'],
    '腾讯地图': ['腾讯地图（首页）'],
    '必应地图': ['Bing Maps', 'bing maps'],
    'OpenStreetMap': ['OSM', 'osm', '开放街图'],

    /* ---------- 图片 ---------- */
    '百度图片': ['百度图'],
    '搜狗图片': ['搜狗图'],
    '谷歌图片': ['Google图片', 'google images'],
    '必应图片': ['Bing图片', 'bing images'],
    'pixiv': ['P站', 'p站', 'Pixiv'],
    'flickr': ['Flickr', 'flickr相册', '雅虎相册'],
    '花瓣': ['huaban', '花瓣网', '采集'],
    '花瓣网': ['huaban', '花瓣'],
    'Pexels': ['pexels', '免费图片'],
    'Unsplash': ['unsplash', '无版权图'],
    'Pixabay': ['pixabay', '免费图库'],
    'Freepik': ['freepik', '免费矢量'],
    'iconfont': ['阿里图标库', '阿里巴巴图标库', 'iconfont.cn'],
    'Iconify': ['iconify', '图标库'],
    'Giphy': ['giphy', 'GIF库'],
    '站酷': ['ZCOOL', 'zcool', '设计师社区'],
    'Wallhaven': ['wallhaven', '壁纸'],
    'Yandex 图片': ['yandex图片'],
    'DuckDuckGo 图片': ['ddg图片'],
    /* ⚠ ArtStation **不叫 A站**：那是 AcFun 的民间通称（弹幕视频网站）。
     * 以前这里给 ArtStation 塞过 "A站设计"，结果搜「A站」时两家一起冒出来
     * —— 用户要的是 AcFun。美术圈内部会叫它"A站"，但那与大众口径冲突，
     * 冲突时让位给更广为人知的那个。 */
    'ArtStation': ['artstation', '游戏美术站'],
    'Behance': ['behance', '贝汉'],
    'Dribbble': ['dribbble', '追波'],
    'DeviantArt': ['DA', 'deviantart', '变态艺术'],
    '500px': ['500px', '摄影社区'],
    'Lottiefiles': ['lottie', '动效库'],

    /* ---------- 音乐 ---------- */
    '网易云音乐': ['网易云', 'NetEase Cloud', '云村'],
    'QQ音乐': ['QQ Music', 'qq音乐'],
    'QQ 音乐': ['QQ Music', 'qq音乐'],
    '酷我音乐': ['酷我', 'Kuwo'],
    '咪咕音乐': ['咪咕', 'Migu'],
    '酷狗5sing': ['5SING', '5sing', '酷狗5sing', '古风音乐'],
    '酷狗音乐': ['酷狗', 'Kugou'],
    'Spotify': ['spotify', '声破天', '斯波蒂菲'],
    'YouTube Music': ['YT Music', '油管音乐'],
    'SoundCloud': ['声云', 'soundcloud'],
    '千千音乐': ['千千', '百度音乐'],
    'Bandcamp': ['bandcamp', '营地音乐'],
    'Last.fm': ['lastfm', '最后fm'],
    'Genius': ['genius', '歌词库'],
    'Musixmatch': ['musixmatch', '歌词'],
    'Apple Music': ['苹果音乐', 'AM'],

    /* ---------- 视频 ---------- */
    '哔哩哔哩': ['B站', 'bilibili', 'Bilibili', '小破站', 'B', 'BILI'],
    '豆瓣电影': ['豆瓣', 'douban电影', '豆瓣评分'],
    '爱奇艺': ['iQiyi', 'iqiyi', '奇异果'],
    '腾讯视频': ['Tencent Video', '鹅厂视频'],
    '优酷': ['Youku', 'youku'],
    'YouTube': ['油管', 'YT', 'youtube'],
    'AcFun': ['A站', 'a站', 'AcFun弹幕视频网'],
    'niconico': ['niko', 'N站', 'niconico动画'],
    '抖音': ['Douyin', 'douyin', 'TikTok 国内版'],
    '快手': ['Kuaishou', 'kuaishou', '老铁'],
    '芒果TV': ['芒果台', 'Mango TV', '湖南卫视'],
    '搜狐视频': ['搜狐', 'sohu'],
    '西瓜视频': ['字节视频'],
    '好看视频': ['好看'],
    '央视网': ['CCTV', '央视', '中央电视台'],
    'Vimeo': ['vimeo', 'Vimeo视频'],
    'Twitch': ['twitch', '老鼠台', '直播'],
    'Dailymotion': ['dailymotion', 'DM'],
    'Crunchyroll': ['crunchyroll', 'CR', '动漫'],
    '1905 电影网': ['电影网', '1905'],
    'Netflix': ['netflix', '奈飞', '网飞'],

    /* ---------- 购物 ---------- */
    '淘宝': ['taobao', 'TB', '马云家'],
    '京东': ['JD', 'jd', '狗东', '京东商城'],
    '天猫': ['tmall', 'Tmall', '猫店'],
    '拼多多': ['PDD', 'pdd', '拼夕夕', '砍一刀'],
    '苏宁易购': ['苏宁', 'Suning'],
    '唯品会': ['唯品', 'VIP.com', '名牌特卖'],
    '当当': ['dangdang', '当当书'],
    '亚马逊': ['Amazon', 'amazon', '亚马逊中国'],
    'eBay': ['ebay', '易贝', '电子湾'],
    'AliExpress': ['速卖通', 'aliexpress', '阿里国际'],
    '1688': ['阿里巴巴', '1688批发'],
    '闲鱼': ['闲鱼网', 'Xianyu', '二手'],
    '什么值得买': ['色魔张大妈', 'SMZDM', 'smzdm', '值得买'],
    '网易严选': ['严选', 'yanxuan'],
    'Etsy': ['etsy', '手工艺品'],
    'Temu': ['temu', '拼多多海外'],
    'Shopee': ['虾皮', 'shopee', '东南亚电商'],
    'Walmart': ['沃尔玛', 'walmart'],
    'Ozon': ['ozon', '俄罗斯电商'],
    '乐天市场': ['乐天', 'Rakuten'],
    '宜家': ['IKEA', 'ikea', '宜家家居'],
    '小米商城': ['小米', 'Xiaomi', 'MI'],
    '华为商城': ['华为', 'Huawei'],
    '得物': ['dewu', '毒', '得物App'],

    /* ---------- 应用商店 ---------- */
    'Chrome商店': ['chrome web store', 'crx', 'Chrome扩展'],
    'Edge商店': ['edge addons', 'Edge扩展'],
    'GreasyFork': ['greasyfork', '油猴脚本', 'GF'],
    'F-Droid': ['fdroid', 'F-Droid', '安卓开源'],
    'APKPure': ['apkpure', 'APK下载'],
    'AlternativeTo': ['alternativeto', '替代软件'],
    '腾讯软件中心': ['腾讯软件', '软管'],
    '酷安': ['coolapk', '酷安网'],
    'Microsoft Store': ['微软商店', 'MSStore', 'msstore'],
    '小米应用商店': ['小米应用', 'MIUI商店'],
    'Softpedia': ['softpedia', '软件下载'],
    '华为应用市场': ['华为应用', 'AppGallery'],
    '豌豆荚': ['豌豆荚', 'wandoujia'],
    '应用宝': ['应用宝', 'yingyongbao'],

    /* ---------- 游戏 ---------- */
    'Steam': ['steam', '蒸汽', 'G胖'],
    'TapTap': ['taptap', 'TapTap社区'],
    '游民星空': ['游民', 'gamersky'],
    '3DM': ['3DMGAME', '3dmgame', '三大妈'],
    'IGN': ['ign', '游戏媒体'],
    'itch.io': ['itch', 'itchio', '独立游戏'],
    'Nexus Mods': ['nexusmods', 'N网', 'mod站'],
    'Epic 商店': ['Epic Games', 'epic', 'E宝'],
    'GameFAQs': ['gamefaqs', '游戏问答'],
    'GOG': ['gog', 'GOG游戏'],
    'Metacritic': ['MC', 'metacritic', '媒体评分'],
    'Humble Bundle': ['humble', '慈善包'],
    'IGDB': ['igdb', '游戏数据库'],
    'OpenCritic': ['opencritic', '开放评论'],
    'WeGame': ['wegame', '腾讯游戏平台'],
    '暴雪战网': ['战网', 'Battle.net', '暴雪'],
    '米哈游': ['miHoYo', 'mihoyo'],
    '王者荣耀': ['王者', 'Honor of Kings', 'LOL手游'],
    '英雄联盟': ['LOL', 'lol', '撸啊撸'],

    /* ---------- 网盘 ---------- */
    '百度网盘': ['度盘', 'Baidu Pan', '百度云'],
    'Google Drive': ['谷歌硬盘', 'GD', 'gdrive'],
    'OneDrive': ['onedrive', '微软云盘', 'OD'],
    'Dropbox': ['dropbox', '多宝箱'],
    '阿里云盘': ['阿里盘', 'Aliyun Drive', '云盘'],
    '夸克网盘': ['夸克盘', 'Quark Pan'],
    '115 网盘': ['115', '115云'],
    'MEGA': ['mega', '兆字节网盘'],

    /* ---------- 学术 ---------- */
    '谷歌学术': ['Google Scholar', 'google scholar', '学术搜索'],
    '百度学术': ['百度学术搜索', 'xueshu'],
    '知网': ['CNKI', 'cnki', '中国知网'],
    '万方': ['万方数据', 'wanfang'],
    'EBSCO': ['ebsco', '外文数据库'],
    'WOS': ['web of science', '科瑞唯安', 'SCI'],
    'JSTOR': ['jstor', '过刊库'],
    'Springer': ['springer', '施普林格'],
    'arXiv': ['arxiv', '预印本', '论文预印'],
    'Semantic Scholar': ['语义学者', 'semanticscholar', 'AI论文'],
    'PubMed': ['pubmed', '医学文献', 'NCBI'],
    'ResearchGate': ['RG', 'researchgate', '研究之门'],
    '谷歌专利': ['Google Patents', 'google patents'],
    'Nature': ['nature', '自然杂志'],
    'Science': ['science', '科学杂志'],
    'IEEE Xplore': ['IEEE', 'ieee', '电气电子工程师'],
    'ScienceDirect': ['sciencedirect', 'SD', '爱思唯尔'],
    'Papers with Code': ['paperswithcode', '论文代码'],
    'DBLP': ['dblp', '计算机论文'],
    'CORE': ['core.ac.uk', '开放获取'],
    'BASE': ['base-search', '比勒费尔德'],
    'Wiley': ['wiley', '威利'],
    'Taylor & Francis': ['tandfonline', 'T&F'],
    '维普': ['维普网', 'VIP期刊', 'cqvip'],

    /* ---------- 社交 ---------- */
    '微博': ['weibo', 'Weibo', '新浪微博', '围脖'],
    '贴吧': ['百度贴吧', 'tieba'],
    '百度贴吧': ['贴吧', 'tieba'],
    '豆瓣': ['douban', 'Douban', '豆瓣网'],
    'Twitter': ['推特', '小蓝鸟', 'X', 'X (Twitter)'],
    'X / Twitter': ['推特', '小蓝鸟', 'X', 'Twitter'],
    'Facebook': ['脸书', 'fb', 'FB', '非死不可'],
    '小红书': ['RED', '小红书App', 'xiaohongshu'],
    'Reddit': ['红迪', 'reddit', '美国贴吧'],
    'Bluesky': ['蓝天', 'bluesky'],
    'Threads': ['线程', 'Meta Threads'],
    'LinkedIn': ['领英', 'linkedin', '职场社交'],
    'TikTok': ['抖音国际版', 'tiktok', '国际抖音'],
    '即刻': ['jike', 'Jike'],
    '虎扑': ['hupu', '虎扑步行街'],
    'Pinterest': ['pin', '拼趣', 'Pinterest'],
    'Tumblr': ['汤博乐', 'tumblr'],
    '最右': ['最右App', 'zuiyou'],
    'Instagram': ['IG', 'ig', '照片墙', 'ins'],
    'Telegram': ['电报', 'TG', 'telegram'],
    'WhatsApp': ['瓦次普', 'WA', 'whatsapp'],
    'Discord': ['DC', '迪斯科德', 'discord'],

    /* ---------- 新闻 ---------- */
    '谷歌新闻': ['Google News', 'google news'],
    '百度新闻': ['百度资讯', '百度新闻中心'],
    '今日头条': ['头条', 'Toutiao', '字节新闻'],
    '澎湃新闻': ['澎湃', 'thepaper', 'PaperNews'],
    '新浪新闻': ['新浪', 'sina', '新浪网'],
    '网易新闻': ['网易', 'netease', '网易新闻中心'],
    '凤凰网': ['凤凰', 'ifeng', '凤凰卫视'],
    '中国新闻网': ['中新网', 'chinanews'],
    'IT之家': ['it之家', 'ithome', 'ITHome'],
    '36氪': ['36氪', '36kr'],
    '36 氪': ['36氪', '36kr'],
    '虎嗅': ['huxiu', '虎嗅网'],
    'BBC': ['bbc', '英国广播'],
    'BBC 中文': ['bbc中文', 'BBC Chinese'],
    'CNN': ['cnn', '美国有线电视'],
    '路透社': ['路透', 'reuters'],
    '腾讯新闻': ['腾讯网', '腾讯资讯'],
    '搜狐新闻': ['搜狐', 'sohu'],
    '界面新闻': ['界面', 'jiemian'],
    '观察者网': ['观察者', 'guancha'],
    '环球网': ['环球', 'huanqiu'],
    '人民网': ['人民', 'people.com.cn'],
    '新华网': ['新华', 'xinhuanet', '新华社'],
    '央广网': ['央广', 'cnr'],
    '纽约时报': ['NYT', 'nyt', '纽约时报中文网'],

    /* ---------- 词典 ---------- */
    '汉典': ['汉典网', '汉字典'],
    '百度汉语': ['汉语词典', '百度汉语词典'],
    '金山词霸': ['词霸', 'Kingsoft', 'iciba'],
    '海词': ['海词词典'],
    '剑桥词典': ['剑桥', 'Cambridge'],
    '柯林斯词典': ['柯林斯', 'Collins'],
    '牛津词典': ['牛津', 'Oxford'],
    '韦氏词典': ['韦氏', 'Merriam-Webster'],
    'Vocabulary.com': ['词汇', 'vocabulary'],
    '朗文词典': ['朗文', 'Longman'],
    'Free Dictionary': ['TFD', 'tfd', '免费词典'],

    /* ---------- 财经 ---------- */
    '东方财富': ['东财', 'eastmoney', '东方财富网'],
    '雪球': ['xueqiu', '雪球财经'],
    '财联社': ['cls', '财联社电报'],
    '华尔街见闻': ['华尔街', 'wallstreetcn'],
    '第一财经': ['一财', 'Yicai'],
    '巨潮资讯': ['巨潮', 'cninfo'],
    '新浪财经': ['新浪股票', 'finance.sina'],
    '和讯网': ['和讯', 'hexun'],
    '同花顺': ['ths', '10jqka', '同花顺财经'],
    '证券之星': ['证券之星网', 'stockstar'],
    '中金在线': ['中金', 'cnfol'],
    'Bloomberg': ['彭博', 'bloomberg', '布隆伯格'],
    'CNBC': ['cnbc', '消费者新闻与商业频道'],

    /* ---------- 学习 ---------- */
    '中国大学MOOC': ['慕课', 'MOOC', '中国大学慕课'],
    '学堂在线': ['学堂', 'xuetangx'],
    'Coursera': ['coursera', '可汗', '在线课程'],
    'edX': ['edx', '哈佛MIT公开课'],
    'Khan Academy': ['可汗学院', 'khanacademy'],
    '古诗文网': ['古诗文', 'gushiwen'],
    'Udemy': ['udemy', '优达学城', '在线课堂'],
    'Codecademy': ['codecademy', '代码学院'],
    '慕课网': ['imooc', '慕课'],
    '网易云课堂': ['云课堂', 'study.163'],
    'freeCodeCamp': ['FCC', 'freecodecamp', '自由代码营'],
    'MIT OpenCourseWare': ['MIT公开课', 'MIT OCW', 'ocw'],
    'Skillshare': ['skillshare', '技能分享'],
    'W3Schools': ['w3schools', 'W3C学校'],
    'MDN 文档': ['MDN', 'mdn'],
    '牛客网': ['牛客', 'NowCoder', '笔试面试'],

    /* ---------- 阅读 ---------- */
    '起点中文网': ['起点', 'qidian', '起点读书'],
    '晋江文学城': ['晋江', 'jjwxc', '晋江文学'],
    '微信读书': ['WeRead', 'weread', '微信读书App'],
    '纵横中文网': ['纵横', 'zongheng'],
    '孔夫子旧书网': ['孔夫子', '旧书网', 'kongfz'],
    'Goodreads': ['goodreads', '好读书'],
    'Project Gutenberg': ['古腾堡', 'gutenberg', '公版书'],
    'AO3': ['Archive of Our Own', 'ao3', '同人'],
    '番茄小说': ['番茄', '番茄免费小说'],
    '七猫免费小说': ['七猫', 'qimao'],
    '刺猬猫': ['刺猬猫阅读', 'ciweimao'],
    '息壤中文网': ['息壤', 'xirong'],
    '17K 小说': ['17K', '17k小说'],
    '塔读文学': ['塔读', 'tadu'],
    '鸠摩搜书': ['鸠摩', 'jiumo', '搜书'],
    'Z-Library': ['zlibrary', 'Z lib', '电子书'],

    /* ---------- 汽车 ---------- */
    '汽车之家': ['汽车之家论坛', 'autohome'],
    '懂车帝': ['dongchedi', '懂车'],
    '易车': ['易车网', 'bitauto'],
    '太平洋汽车': ['太平洋汽车网', 'pcauto'],
    '爱卡汽车': ['爱卡', 'xcar'],
    '瓜子二手车': ['瓜子', 'guazi', '二手车'],
    '人人车': ['人人车', 'renrenche'],

    /* ---------- 生活 ---------- */
    '大众点评': ['点评', 'dianping', '美团点评'],
    '下厨房': ['下厨房美食', 'xiachufang', '菜谱'],
    '天气网': ['中国天气网', '天气'],
    '饿了么': ['饿了么外卖', 'eleme'],
    '美食杰': ['美食杰', 'meishi'],
    '丁香医生': ['丁香园', 'dxy', '医疗'],
    '好大夫在线': ['好大夫', 'haodf'],
    '中国天气网': ['天气网', '天气'],
    '快递100': ['快递查询', 'kuaidi100', '查快递'],
    '菜鸟裹裹': ['菜鸟', 'cainiao', '查包裹'],
    '12306': ['中国铁路', '火车票', '铁路12306'],
    '携程': ['携程网', 'ctrip', '订酒店'],
    '去哪儿': ['去哪儿网', 'qunar', '订票'],
    '飞猪': ['飞猪旅行', 'Fliggy', '阿里旅行'],
};

function normList(v) {
    return (Array.isArray(v) ? v : (v ? [v] : [])).map((s) => String(s).trim()).filter(Boolean);
}

const raw = fs.readFileSync(FILE, 'utf8');
const cat = JSON.parse(raw);

let touched = 0, added = 0, skipped = 0;
const missingKeys = [];

for (const c of cat.categories) {
    if (!Array.isArray(c.engines)) continue;
    for (const e of c.engines) {
        if (!e || !e.name) continue;
        const core = String(e.name).replace(/（首页）\s*$/, '').trim();
        const want = ALIASES[core];
        if (!want || !want.length) continue;
        const have = normList(e.alias);
        const before = have.length;
        for (const a of want) if (have.indexOf(a) < 0) have.push(a);
        if (have.length === before) { skipped++; continue; }
        e.alias = have;
        touched++;
        added += have.length - before;
    }
}

// 反查：表里配了别名但核心名不存在（拼错 / 引擎被删）—— 必须报出来，否则白配
const cores = new Set();
for (const c of cat.categories) for (const e of (c.engines || [])) {
    if (e && e.name) cores.add(String(e.name).replace(/（首页）\s*$/, '').trim());
}
for (const k of Object.keys(ALIASES)) {
    if (!ALIASES[k] || !ALIASES[k].length) continue;
    if (!cores.has(k)) missingKeys.push(k);
}

// 统计最终覆盖率
let tot = 0, withAlias = 0;
for (const c of cat.categories) for (const e of (c.engines || [])) {
    tot++;
    if (normList(e.alias).length) withAlias++;
}

console.log('引擎总数        :', tot);
console.log('已有别名的引擎  :', withAlias, `（${((withAlias / tot) * 100).toFixed(1)}%）`);
console.log('本轮打标        :', touched, '个引擎，新增', added, '个别名');
console.log('本来就齐的      :', skipped);
if (missingKeys.length) {
    console.log('⚠ 别名表里这些键在 engines.json 中找不到（拼错或引擎已删）：');
    console.log('  ' + missingKeys.join(' | '));
}
if (DRY) { console.log('（--dry，没有写入）'); process.exit(0); }

fs.writeFileSync(FILE, JSON.stringify(cat, null, 1), 'utf8');
console.log('已写入', FILE);