# -*- coding: utf-8 -*-
"""往 ui/data/engines.json 里批量补搜索引擎 + 调整分组。

只做「合并」这一件事：按名字去重（重名跳过，绝不覆盖已有的），
新增的条目**不带 iconFile** —— 交给 tools/fetch-icons.js --only-missing 去落地图标。
另外会按 RENAME_CATS 改分组名（幂等）。

引擎分三类，各自写进对应的批次：
  · NEW / NEW_R21  搜索类：地址带 %s，拿选中的词跳过去搜；
  · NEW_OPEN       打开类：地址不带 %s，点了直接打开页面；
  · NEW_HOT        快捷键类：没有地址，点了把 hotkey 字段里的组合键
                   模拟发给前台软件（见 win::parse_hotkey 的词汇表）。

⚠ 这个文件是**桌面端的补充层**，不是最终数据源。完整管线：
      extract-engines.js  （从浏览器版用户脚本抽基线 → engines.json）
        → add-engines.py  （补桌面端额外想要的引擎 / 改分组名）
        → fetch-icons.js  （把每个引擎的图标落地成离线文件）
   所以**不要直接手改 ui/data/engines.json** —— 下次重跑 extract 就没了；
   想加的引擎写进这里的 NEW / NEW_R21 / NEW_OPEN / NEW_HOT。

用法: python tools/add-engines.py
"""
import io
import json
import os
import sys
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINES = os.path.join(ROOT, 'ui', 'data', 'engines.json')

# 统一用站点自己的 URL 当 icon：fetch-icons 会按这个域名去取 favicon，
# 比赌 Iconify 里有没有这个牌子稳得多（中文站点基本都不在 Iconify 里）。
# 国际大牌优先给 Iconify 矢量图，线条更干净。
S = 'https://api.iconify.design/simple-icons:%s.svg?color=%%23%s'

NEW = {
    # ---------------------------- 网页 ----------------------------
    '网页': [
        ('Yandex', 'https://yandex.com/search/?text=%s', S % ('yandex', 'FC3F1D')),
        ('DuckDuckGo', 'https://duckduckgo.com/?q=%s', S % ('duckduckgo', 'DE5833')),
        ('Yahoo', 'https://search.yahoo.com/search?p=%s', S % ('yahoo', '6001D2')),
        ('Brave 搜索', 'https://search.brave.com/search?q=%s', S % ('brave', 'FB542B')),
        ('Ecosia', 'https://www.ecosia.org/search?q=%s', S % ('ecosia', '008009')),
        ('Qwant', 'https://www.qwant.com/?q=%s', S % ('qwant', '5C97FF')),
        ('Mojeek', 'https://www.mojeek.com/search?q=%s', 'https://www.mojeek.com/'),
        ('Startpage', 'https://www.startpage.com/sp/search?query=%s', 'https://www.startpage.com/'),
        ('神马搜索', 'https://m.sm.cn/s?q=%s', 'https://m.sm.cn/'),
        ('夸克搜索', 'https://quark.sm.cn/s?q=%s', 'https://quark.sm.cn/'),
        ('头条搜索', 'https://so.toutiao.com/search?keyword=%s', 'https://so.toutiao.com/'),
        ('无追搜索', 'https://www.wuzhuiso.com/s?q=%s', 'https://www.wuzhuiso.com/'),
    ],
    # ---------------------------- AI ----------------------------
    'AI 工具': [
        ('Grok', 'https://grok.com/?q=%s', 'https://grok.com/'),
        ('Copilot', 'https://copilot.microsoft.com/?q=%s', S % ('microsoftcopilot', '258FFA')),
        ('Qwen Chat', 'https://chat.qwen.ai/?q=%s', 'https://chat.qwen.ai/'),
        ('Mistral', 'https://chat.mistral.ai/chat?q=%s', S % ('mistralai', 'FA520F')),
        ('Hugging Face', 'https://huggingface.co/models?search=%s', S % ('huggingface', 'FFD21E')),
        ('Poe', 'https://poe.com/search?q=%s', 'https://poe.com/'),
    ],
    # ---------------------------- 知识 ----------------------------
    '知识': [
        ('Quora', 'https://www.quora.com/search?q=%s', S % ('quora', 'B92B27')),
        ('简书', 'https://www.jianshu.com/search?q=%s', 'https://www.jianshu.com/'),
        ('果壳', 'https://www.guokr.com/search/?q=%s', 'https://www.guokr.com/'),
        ('少数派', 'https://sspai.com/search/post/%s', 'https://sspai.com/'),
        ('萌娘百科', 'https://zh.moegirl.org.cn/index.php?search=%s', 'https://zh.moegirl.org.cn/'),
        ('百度文库', 'https://wenku.baidu.com/search?word=%s', 'https://wenku.baidu.com/'),
        ('百度经验', 'https://jingyan.baidu.com/search?word=%s', 'https://jingyan.baidu.com/'),
        ('维基词典', 'https://zh.wiktionary.org/w/index.php?search=%s', 'https://zh.wiktionary.org/'),
    ],
    # ---------------------------- 开发 ----------------------------
    '开发': [
        ('SegmentFault', 'https://segmentfault.com/search?q=%s', 'https://segmentfault.com/'),
        ('博客园', 'https://zzk.cnblogs.com/s?w=%s', 'https://www.cnblogs.com/'),
        ('开源中国', 'https://www.oschina.net/search?q=%s', 'https://www.oschina.net/'),
        ('Gitee', 'https://search.gitee.com/?q=%s', 'https://gitee.com/'),
        ('GitLab', 'https://gitlab.com/search?search=%s', S % ('gitlab', 'FC6D26')),
        ('Stack Exchange', 'https://stackexchange.com/search?q=%s', S % ('stackexchange', '1E5397')),
        ('MDN', 'https://developer.mozilla.org/zh-CN/search?q=%s', S % ('mdnwebdocs', '000000')),
        ('crates.io', 'https://crates.io/search?q=%s', S % ('rust', '000000')),
        ('Go Packages', 'https://pkg.go.dev/search?q=%s', S % ('go', '00ADD8')),
        ('NuGet', 'https://www.nuget.org/packages?q=%s', 'https://www.nuget.org/'),
        ('Packagist', 'https://packagist.org/search/?q=%s', 'https://packagist.org/'),
        ('RubyGems', 'https://rubygems.org/search?query=%s', S % ('rubygems', 'E9573F')),
        ('Hacker News', 'https://hn.algolia.com/?q=%s', S % ('ycombinator', 'FF6600')),
        ('DEV', 'https://dev.to/search?q=%s', S % ('devdotto', '0A0A0A')),
        ('LeetCode', 'https://leetcode.cn/search/?q=%s', 'https://leetcode.cn/'),
        ('菜鸟教程', 'https://www.runoob.com/?s=%s', 'https://www.runoob.com/'),
        ('腾讯云社区', 'https://cloud.tencent.com/developer/search/article-%s', 'https://cloud.tencent.com/'),
        ('阿里云开发者', 'https://developer.aliyun.com/search?q=%s', 'https://developer.aliyun.com/'),
        ('InfoQ', 'https://www.infoq.cn/search?q=%s', 'https://www.infoq.cn/'),
        ('V2EX(谷歌)', 'https://www.google.com/search?q=%s+site%3Av2ex.com', S % ('v2ex', '778087')),
        ('PyPI 搜索', 'https://pypi.org/search/?q=%s', S % ('python', '3776AB')),
    ],
    # ---------------------------- 翻译 / 词典 ----------------------------
    '翻译': [
        ('DeepL', 'https://www.deepl.com/translator#zh/en/%s', S % ('deepl', '0F2B46')),
        ('搜狗翻译', 'https://fanyi.sogou.com/text?keyword=%s', 'https://fanyi.sogou.com/'),
        ('彩云小译', 'https://fanyi.caiyunapp.com/#/text', 'https://fanyi.caiyunapp.com/'),
    ],
    '词典': [
        ('汉典', 'https://www.zdic.net/hans/%s', 'https://www.zdic.net/'),
        ('百度汉语', 'https://hanyu.baidu.com/s?wd=%s', 'https://hanyu.baidu.com/'),
        ('金山词霸', 'https://www.iciba.com/word?w=%s', 'https://www.iciba.com/'),
        ('海词', 'https://dict.cn/%s', 'https://dict.cn/'),
        ('剑桥词典', 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/%s',
         'https://dictionary.cambridge.org/'),
        ('柯林斯词典', 'https://www.collinsdictionary.com/dictionary/english/%s',
         'https://www.collinsdictionary.com/'),
        ('牛津词典', 'https://www.oxfordlearnersdictionaries.com/search/english/?q=%s',
         'https://www.oxfordlearnersdictionaries.com/'),
        ('韦氏词典', 'https://www.merriam-webster.com/dictionary/%s', 'https://www.merriam-webster.com/'),
    ],
    # ---------------------------- 地图 ----------------------------
    '地图': [
        ('腾讯地图', 'https://map.qq.com/?what=%s', 'https://map.qq.com/'),
        ('必应地图', 'https://www.bing.com/maps?q=%s', S % ('bing', '258FFA')),
        ('OpenStreetMap', 'https://www.openstreetmap.org/search?query=%s', S % ('openstreetmap', '7EBC6F')),
    ],
    # ---------------------------- 图片 ----------------------------
    '图片': [
        ('Unsplash', 'https://unsplash.com/s/photos/%s', S % ('unsplash', '000000')),
        ('Pixabay', 'https://pixabay.com/zh/images/search/%s/', S % ('pixabay', '2EC66D')),
        ('Freepik', 'https://www.freepik.com/search?query=%s', 'https://www.freepik.com/'),
        ('iconfont', 'https://www.iconfont.cn/search/index?searchType=icon&q=%s', 'https://www.iconfont.cn/'),
        ('Iconify', 'https://icon-sets.iconify.design/?query=%s', 'https://icon-sets.iconify.design/'),
        ('Giphy', 'https://giphy.com/search/%s', S % ('giphy', 'FF6666')),
        ('站酷', 'https://www.zcool.com.cn/search/content?&word=%s', 'https://www.zcool.com.cn/'),
        ('Wallhaven', 'https://wallhaven.cc/search?q=%s', 'https://wallhaven.cc/'),
        ('千图网', 'https://www.58pic.com/search/%s', 'https://www.58pic.com/'),
    ],
    # ---------------------------- 音乐 ----------------------------
    '音乐': [
        ('Spotify', 'https://open.spotify.com/search/%s', S % ('spotify', '1DB954')),
        ('YouTube Music', 'https://music.youtube.com/search?q=%s', S % ('youtubemusic', 'FF0000')),
        ('SoundCloud', 'https://soundcloud.com/search?q=%s', S % ('soundcloud', 'FF5500')),
        ('千千音乐', 'https://music.taihe.com/search?key=%s', 'https://music.taihe.com/'),
    ],
    # ---------------------------- 视频 ----------------------------
    '视频': [
        ('芒果TV', 'https://so.mgtv.com/so?k=%s', 'https://www.mgtv.com/'),
        ('搜狐视频', 'https://so.tv.sohu.com/mts?wd=%s', 'https://tv.sohu.com/'),
        ('西瓜视频', 'https://www.ixigua.com/search/%s', 'https://www.ixigua.com/'),
        ('好看视频', 'https://haokan.baidu.com/web/search/page?query=%s', 'https://haokan.baidu.com/'),
        ('央视网', 'https://search.cctv.com/search.php?qtext=%s', 'https://www.cctv.com/'),
        ('Vimeo', 'https://vimeo.com/search?q=%s', S % ('vimeo', '1AB7EA')),
        ('Twitch', 'https://www.twitch.tv/search?term=%s', S % ('twitch', '9146FF')),
        ('Dailymotion', 'https://www.dailymotion.com/search/%s', S % ('dailymotion', '0E5CBB')),
    ],
    # ---------------------------- 购物 ----------------------------
    '购物': [
        ('拼多多', 'https://mobile.yangkeduo.com/search_result.html?search_key=%s', 'https://www.pinduoduo.com/'),
        ('苏宁易购', 'https://search.suning.com/%s/', 'https://www.suning.com/'),
        ('唯品会', 'https://so.vip.com/search/?keyword=%s', 'https://www.vip.com/'),
        ('当当', 'https://search.dangdang.com/?key=%s', 'https://www.dangdang.com/'),
        ('亚马逊', 'https://www.amazon.cn/s?k=%s', S % ('amazon', 'FF9900')),
        ('eBay', 'https://www.ebay.com/sch/i.html?_nkw=%s', S % ('ebay', 'E53238')),
        ('AliExpress', 'https://www.aliexpress.com/wholesale?SearchText=%s', S % ('aliexpress', 'FF4747')),
        ('1688', 'https://s.1688.com/selloffer/offer_search.htm?keywords=%s', 'https://www.1688.com/'),
        ('闲鱼', 'https://www.goofish.com/search?q=%s', 'https://www.goofish.com/'),
        ('什么值得买', 'https://search.smzdm.com/?c=home&s=%s', 'https://www.smzdm.com/'),
        ('网易严选', 'https://you.163.com/search?keyword=%s', 'https://you.163.com/'),
        ('Etsy', 'https://www.etsy.com/search?q=%s', S % ('etsy', 'F16521')),
        ('Temu', 'https://www.temu.com/search_result.html?search_key=%s', 'https://www.temu.com/'),
    ],
    # ---------------------------- 应用 ----------------------------
    '应用': [
        ('酷安', 'https://www.coolapk.com/search?q=%s', 'https://www.coolapk.com/'),
        ('F-Droid', 'https://search.f-droid.org/?q=%s', S % ('fdroid', '1976D2')),
        ('APKPure', 'https://apkpure.com/search?q=%s', 'https://apkpure.com/'),
        ('AlternativeTo', 'https://alternativeto.net/browse/search/?q=%s', 'https://alternativeto.net/'),
        ('腾讯软件中心', 'https://pc.qq.com/search.html#!keyword=%s', 'https://pc.qq.com/'),
    ],
    # ---------------------------- 游戏 ----------------------------
    '游戏': [
        ('游民星空', 'https://so.gamersky.com/?s=%s', 'https://www.gamersky.com/'),
        ('3DM', 'https://so.3dmgame.com/?keyword=%s', 'https://www.3dmgame.com/'),
        ('IGN', 'https://www.ign.com/search?q=%s', 'https://www.ign.com/'),
        ('itch.io', 'https://itch.io/search?q=%s', S % ('itchdotio', 'FA5C5C')),
        ('Nexus Mods', 'https://www.nexusmods.com/search/?gsearch=%s', 'https://www.nexusmods.com/'),
        ('Epic 商店', 'https://store.epicgames.com/zh-CN/search?q=%s', S % ('epicgames', '313131')),
        ('GameFAQs', 'https://gamefaqs.gamespot.com/search?game=%s', 'https://gamefaqs.gamespot.com/'),
    ],
    # ---------------------------- 学术 ----------------------------
    '学术': [
        ('arXiv', 'https://arxiv.org/search/?query=%s', S % ('arxiv', 'B31B1B')),
        ('Semantic Scholar', 'https://www.semanticscholar.org/search?q=%s', 'https://www.semanticscholar.org/'),
        ('PubMed', 'https://pubmed.ncbi.nlm.nih.gov/?term=%s', 'https://pubmed.ncbi.nlm.nih.gov/'),
        ('ResearchGate', 'https://www.researchgate.net/search?q=%s', 'https://www.researchgate.net/'),
        ('谷歌专利', 'https://patents.google.com/?q=%s', 'https://patents.google.com/'),
        ('Nature', 'https://www.nature.com/search?q=%s', 'https://www.nature.com/'),
        ('Science', 'https://www.science.org/action/doSearch?AllField=%s', 'https://www.science.org/'),
        ('IEEE Xplore', 'https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=%s',
         'https://ieeexplore.ieee.org/'),
        ('ScienceDirect', 'https://www.sciencedirect.com/search?qs=%s', 'https://www.sciencedirect.com/'),
    ],
    # ---------------------------- 社交 ----------------------------
    '社交': [
        ('Bluesky', 'https://bsky.app/search?q=%s', S % ('bluesky', '0285FF')),
        ('Threads', 'https://www.threads.net/search?q=%s', S % ('threads', '000000')),
        ('LinkedIn', 'https://www.linkedin.com/search/results/all/?keywords=%s', S % ('linkedin', '0A66C2')),
        ('TikTok', 'https://www.tiktok.com/search?q=%s', S % ('tiktok', '000000')),
        ('即刻', 'https://web.okjike.com/search?q=%s', 'https://web.okjike.com/'),
        ('虎扑', 'https://search.hupu.com/?q=%s', 'https://www.hupu.com/'),
    ],
    # ---------------------------- 新闻 ----------------------------
    '新闻': [
        ('澎湃新闻', 'https://www.thepaper.cn/searchResult?searchWord=%s', 'https://www.thepaper.cn/'),
        ('新浪新闻', 'https://search.sina.com.cn/?q=%s', 'https://news.sina.com.cn/'),
        ('网易新闻', 'https://www.163.com/search?keyword=%s', 'https://news.163.com/'),
        ('凤凰网', 'https://search.ifeng.com/sofeng/search.action?q=%s', 'https://www.ifeng.com/'),
        ('中国新闻网', 'https://sou.chinanews.com.cn/search.do?q=%s', 'https://www.chinanews.com.cn/'),
        ('IT之家', 'https://s.ithome.com/?keyword=%s', 'https://www.ithome.com/'),
        ('36氪', 'https://36kr.com/search/articles/%s', 'https://36kr.com/'),
        ('虎嗅', 'https://www.huxiu.com/search.html?s=%s', 'https://www.huxiu.com/'),
        ('BBC', 'https://www.bbc.co.uk/search?q=%s', S % ('bbc', '000000')),
        ('CNN', 'https://edition.cnn.com/search?q=%s', S % ('cnn', 'CC0000')),
        ('路透社', 'https://www.reuters.com/site-search/?query=%s', 'https://www.reuters.com/'),
    ],
    # ---------------------------- 财经（新分类） ----------------------------
    '财经': [
        ('东方财富', 'https://so.eastmoney.com/web/s?keyword=%s', 'https://www.eastmoney.com/'),
        ('雪球', 'https://xueqiu.com/k?q=%s', 'https://xueqiu.com/'),
        ('财联社', 'https://www.cls.cn/searchPage?keyword=%s', 'https://www.cls.cn/'),
        ('华尔街见闻', 'https://wallstreetcn.com/search?q=%s', 'https://wallstreetcn.com/'),
        ('第一财经', 'https://www.yicai.com/search?keys=%s', 'https://www.yicai.com/'),
        ('巨潮资讯', 'http://www.cninfo.com.cn/new/fulltextSearch?keyWord=%s', 'http://www.cninfo.com.cn/'),
        ('新浪财经', 'https://search.sina.com.cn/?q=%s&c=finance', 'https://finance.sina.com.cn/'),
    ],
    # ---------------------------- 学习（新分类） ----------------------------
    '学习': [
        ('中国大学MOOC', 'https://www.icourse163.org/search.htm?search=%s', 'https://www.icourse163.org/'),
        ('网易公开课', 'https://open.163.com/search?keyword=%s', 'https://open.163.com/'),
        ('学堂在线', 'https://www.xuetangx.com/search?query=%s', 'https://www.xuetangx.com/'),
        ('Coursera', 'https://www.coursera.org/search?query=%s', S % ('coursera', '0056D2')),
        ('edX', 'https://www.edx.org/search?q=%s', S % ('edx', '02262B')),
        ('Khan Academy', 'https://www.khanacademy.org/search?page_search_query=%s',
         S % ('khanacademy', '14BF96')),
        ('古诗文网', 'https://so.gushiwen.cn/search.aspx?value=%s', 'https://www.gushiwen.cn/'),
    ],
    # ---------------------------- 阅读（新分类） ----------------------------
    '阅读': [
        ('起点中文网', 'https://www.qidian.com/so/%s.html', 'https://www.qidian.com/'),
        ('晋江文学城', 'https://search.jjwxc.net/search.php?kw=%s', 'https://www.jjwxc.net/'),
        ('微信读书', 'https://weread.qq.com/web/search/books?keyword=%s', 'https://weread.qq.com/'),
        ('纵横中文网', 'https://search.zongheng.com/search?keyword=%s', 'https://www.zongheng.com/'),
        ('孔夫子旧书网', 'https://search.kongfz.com/product_result/?key=%s', 'https://www.kongfz.com/'),
        ('Goodreads', 'https://www.goodreads.com/search?q=%s', S % ('goodreads', '372213')),
    ],
    # ---------------------------- 汽车（新分类） ----------------------------
    '汽车': [
        ('汽车之家', 'https://sou.autohome.com.cn/zonghe?q=%s', 'https://www.autohome.com.cn/'),
        ('懂车帝', 'https://www.dongchedi.com/search?keyword=%s', 'https://www.dongchedi.com/'),
        ('易车', 'https://so.yiche.com/?q=%s', 'https://www.yiche.com/'),
    ],
    # ---------------------------- 生活（新分类） ----------------------------
    '生活': [
        ('大众点评', 'https://www.dianping.com/search/keyword/1/0_%s', 'https://www.dianping.com/'),
        ('下厨房', 'https://www.xiachufang.com/search/?keyword=%s', 'https://www.xiachufang.com/'),
        ('豆果美食', 'https://www.douguo.com/search/recipe/%s', 'https://www.douguo.com/'),
        ('天气网', 'https://www.tianqi.com/search/?keyword=%s', 'https://www.tianqi.com/'),
    ],
    # ---------------------------- 工具（新分类） ----------------------------
    '工具': [
        ('天眼查', 'https://www.tianyancha.com/search?key=%s', 'https://www.tianyancha.com/'),
        ('企查查', 'https://www.qcc.com/web/search?key=%s', 'https://www.qcc.com/'),
        ('爱企查', 'https://aiqicha.baidu.com/s?q=%s', 'https://aiqicha.baidu.com/'),
        ('快递100', 'https://www.kuaidi100.com/?nu=%s', 'https://www.kuaidi100.com/'),
        ('站长之家', 'https://tool.chinaz.com/?q=%s', 'https://tool.chinaz.com/'),
        ('IP138', 'https://www.ip138.com/iplookup.asp?ip=%s', 'https://www.ip138.com/'),
    ],
}

# ============================================================================
#  轮 21：分组改名 + 又一批引擎
# ============================================================================

# 分类改名（在合并之前先做）。
#
# 「我的」是浏览器版用户脚本里的分组原样抽过来的，里头只放了一条「百度网盘」。
# 它搜的是**你自己网盘里的文件**（不是搜全网），可名字叫"我的"、分类里又只有一条，
# 桌面版用户完全看不出这是干嘛的（用户直接问「这我的里面有一个百度网盘，
# 那这是干嘛的呀？」）。改成「网盘」并把这个分组补成真正的一组云盘 ——
# 语义一眼就懂：这一组 = 「在自己的云盘里找文件」。
#
# ⚠ 这个改名放在 add-engines 里而不是直接手改 engines.json：
#    engines.json 是 extract-engines.js 从用户脚本**生成**的，
#    直接手改会在下次重新生成时丢掉。管线固定为
#    extract-engines  →  add-engines  →  fetch-icons，
#    所以这一步是可重放的。
RENAME_CATS = {
    '我的': '网盘',
}

# 统一用站点自己的 URL 当 icon（fetch-icons 会按域名取 favicon），
# 国际大牌优先给 Iconify 矢量图。
NEW_R21 = {
    # ---------------------------- 网盘（原「我的」） ----------------------------
    '网盘': [
        ('Google Drive', 'https://drive.google.com/drive/u/0/search?q=%s',
         S % ('googledrive', '4285F4')),
        ('OneDrive', 'https://onedrive.live.com/?q=%s', S % ('microsoftonedrive', '0078D4')),
        ('Dropbox', 'https://www.dropbox.com/search/personal?query=%s',
         S % ('dropbox', '0061FF')),
        ('阿里云盘', 'https://www.alipan.com/search?q=%s', 'https://www.alipan.com/'),
        ('夸克网盘', 'https://pan.quark.cn/search?q=%s', 'https://pan.quark.cn/'),
        ('115 网盘', 'https://115.com/?mode=search&search_value=%s', 'https://115.com/'),
        ('MEGA', 'https://mega.nz/search?q=%s', 'https://mega.nz/'),
    ],
    # ---------------------------- 工具 ----------------------------
    '工具': [
        ('Wolfram Alpha', 'https://www.wolframalpha.com/input?i=%s', S % ('wolfram', 'DD1100')),
        ('Product Hunt', 'https://www.producthunt.com/search?q=%s', S % ('producthunt', 'DA552F')),
        ('Internet Archive', 'https://archive.org/search?query=%s',
         S % ('internetarchive', '000000')),
        ('Wayback Machine', 'https://web.archive.org/web/*/%s', 'https://web.archive.org/'),
        ('who.is', 'https://who.is/whois/%s', 'https://who.is/'),
        ('VirusTotal', 'https://www.virustotal.com/gui/search/%s', 'https://www.virustotal.com/'),
        ('SimilarWeb', 'https://www.similarweb.com/website/%s/', 'https://www.similarweb.com/'),
        ('IEEE 标准', 'https://standards.ieee.org/search/?q=%s', 'https://standards.ieee.org/'),
    ],
    # ---------------------------- 翻译 ----------------------------
    '翻译': [
        ('Yandex 翻译', 'https://translate.yandex.com/?text=%s', S % ('yandex', 'FC3F1D')),
        ('Papago', 'https://papago.naver.com/?sk=auto&tk=zh-CN&st=%s', 'https://papago.naver.com/'),
        ('Linguee', 'https://www.linguee.com/english-chinese/search?query=%s',
         'https://www.linguee.com/'),
        ('Reverso', 'https://context.reverso.net/translation/english-chinese/%s',
         'https://context.reverso.net/'),
    ],
    # ---------------------------- 词典 ----------------------------
    '词典': [
        ('Vocabulary.com', 'https://www.vocabulary.com/dictionary/%s',
         'https://www.vocabulary.com/'),
        ('朗文词典', 'https://www.ldoceonline.com/dictionary/%s', 'https://www.ldoceonline.com/'),
        ('Free Dictionary', 'https://www.thefreedictionary.com/%s',
         'https://www.thefreedictionary.com/'),
    ],
    # ---------------------------- 图片 ----------------------------
    '图片': [
        ('Yandex 图片', 'https://yandex.com/images/search?text=%s', S % ('yandex', 'FC3F1D')),
        ('DuckDuckGo 图片', 'https://duckduckgo.com/?q=%s&iax=images&ia=images',
         S % ('duckduckgo', 'DE5833')),
        ('ArtStation', 'https://www.artstation.com/search?q=%s', 'https://www.artstation.com/'),
        ('Behance', 'https://www.behance.net/search/projects?search=%s',
         S % ('behance', '1769FF')),
        ('Dribbble', 'https://dribbble.com/search/%s', S % ('dribbble', 'EA4C89')),
        ('DeviantArt', 'https://www.deviantart.com/search?q=%s', 'https://www.deviantart.com/'),
        ('500px', 'https://500px.com/search?q=%s', 'https://500px.com/'),
        ('Lottiefiles', 'https://lottiefiles.com/search?q=%s', 'https://lottiefiles.com/'),
    ],
    # ---------------------------- 音乐 ----------------------------
    '音乐': [
        ('Bandcamp', 'https://bandcamp.com/search?q=%s', S % ('bandcamp', '408294')),
        ('Last.fm', 'https://www.last.fm/search?q=%s', S % ('lastdotfm', 'D51007')),
        ('Genius', 'https://genius.com/search?q=%s', S % ('genius', 'FFFF64')),
        ('Musixmatch', 'https://www.musixmatch.com/search/%s', 'https://www.musixmatch.com/'),
    ],
    # ---------------------------- 视频 ----------------------------
    '视频': [
        ('Crunchyroll', 'https://www.crunchyroll.com/search?q=%s', S % ('crunchyroll', 'F47521')),
        ('1905 电影网', 'https://www.1905.com/search/?q=%s', 'https://www.1905.com/'),
    ],
    # ---------------------------- 购物 ----------------------------
    '购物': [
        ('Shopee', 'https://shopee.sg/search?keyword=%s', 'https://shopee.sg/'),
        ('Walmart', 'https://www.walmart.com/search?q=%s', S % ('walmart', '0071CE')),
        ('Ozon', 'https://www.ozon.ru/search/?text=%s', 'https://www.ozon.ru/'),
        ('乐天市场', 'https://search.rakuten.co.jp/search/mall/%s/', 'https://www.rakuten.co.jp/'),
        ('宜家', 'https://www.ikea.cn/cn/zh/search/?q=%s', 'https://www.ikea.cn/'),
    ],
    # ---------------------------- 应用 ----------------------------
    '应用': [
        ('Microsoft Store', 'https://apps.microsoft.com/search?query=%s',
         S % ('microsoft', '5E5E5E')),
        ('小米应用商店', 'https://app.mi.com/searchAll?keywords=%s', 'https://app.mi.com/'),
        ('Softpedia', 'https://www.softpedia.com/search.php?q=%s', 'https://www.softpedia.com/'),
    ],
    # ---------------------------- 游戏 ----------------------------
    '游戏': [
        ('GOG', 'https://www.gog.com/games?query=%s', 'https://www.gog.com/'),
        ('Metacritic', 'https://www.metacritic.com/search/%s/', S % ('metacritic', 'FFCC34')),
        ('Humble Bundle', 'https://www.humblebundle.com/store/search?search=%s',
         'https://www.humblebundle.com/'),
        ('IGDB', 'https://www.igdb.com/search?type=1&q=%s', 'https://www.igdb.com/'),
        ('OpenCritic', 'https://opencritic.com/search?criteria=%s', 'https://opencritic.com/'),
    ],
    # ---------------------------- 学术 ----------------------------
    '学术': [
        ('Papers with Code', 'https://paperswithcode.com/search?q=%s',
         'https://paperswithcode.com/'),
        ('DBLP', 'https://dblp.org/search?q=%s', 'https://dblp.org/'),
        ('CORE', 'https://core.ac.uk/search?q=%s', 'https://core.ac.uk/'),
        ('BASE', 'https://www.base-search.net/Search/Results?lookfor=%s',
         'https://www.base-search.net/'),
        ('Wiley', 'https://onlinelibrary.wiley.com/action/doSearch?AllField=%s',
         'https://onlinelibrary.wiley.com/'),
        ('Taylor & Francis', 'https://www.tandfonline.com/action/doSearch?AllField=%s',
         'https://www.tandfonline.com/'),
    ],
    # ---------------------------- 社交 ----------------------------
    '社交': [
        ('Pinterest', 'https://www.pinterest.com/search/pins/?q=%s', S % ('pinterest', 'BD081C')),
        ('Tumblr', 'https://www.tumblr.com/search/%s', S % ('tumblr', '36465D')),
    ],
    # ---------------------------- 学习 ----------------------------
    '学习': [
        ('Udemy', 'https://www.udemy.com/courses/search/?q=%s', S % ('udemy', 'A435F0')),
        ('Codecademy', 'https://www.codecademy.com/search?query=%s',
         S % ('codecademy', '1F4056')),
        ('慕课网', 'https://www.imooc.com/search/?words=%s', 'https://www.imooc.com/'),
        ('网易云课堂', 'https://study.163.com/search.htm?keyword=%s', 'https://study.163.com/'),
        ('freeCodeCamp', 'https://www.freecodecamp.org/news/search?query=%s',
         S % ('freecodecamp', '0A0A23')),
        ('MIT OpenCourseWare', 'https://ocw.mit.edu/search/?q=%s', 'https://ocw.mit.edu/'),
    ],
    # ---------------------------- 阅读 ----------------------------
    '阅读': [
        ('Project Gutenberg', 'https://www.gutenberg.org/ebooks/search/?query=%s',
         'https://www.gutenberg.org/'),
        ('AO3', 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=%s',
         'https://archiveofourown.org/'),
    ],
    # ---------------------------- 汽车 ----------------------------
    '汽车': [
        ('太平洋汽车', 'https://so.pcauto.com.cn/cs/s?q=%s', 'https://www.pcauto.com.cn/'),
        ('爱卡汽车', 'https://so.xcar.com.cn/?q=%s', 'https://www.xcar.com.cn/'),
    ],
    # ---------------------------- 知识 ----------------------------
    '知识': [
        ('WikiHow', 'https://zh.wikihow.com/wikiHowTo?search=%s', 'https://zh.wikihow.com/'),
        ('维基文库', 'https://zh.wikisource.org/w/index.php?search=%s',
         S % ('wikisource', '000000')),
    ],
    # ---------------------------- 开发 ----------------------------
    '开发': [
        ('Bitbucket', 'https://bitbucket.org/repo/all?name=%s', S % ('bitbucket', '0052CC')),
        ('Codeberg', 'https://codeberg.org/explore/repos?q=%s', 'https://codeberg.org/'),
        ('Sourcegraph', 'https://sourcegraph.com/search?q=%s', S % ('sourcegraph', 'FF5543')),
        ('Conda', 'https://anaconda.org/search?q=%s', S % ('anaconda', '44A833')),
        ('Arch Wiki', 'https://wiki.archlinux.org/index.php?search=%s',
         S % ('archlinux', '1793D1')),
        ('Lobsters', 'https://lobste.rs/search?q=%s', 'https://lobste.rs/'),
    ],
    # ---------------------------- 生活 ----------------------------
    '生活': [
        ('美团', 'https://www.meituan.com/s/%s/', 'https://www.meituan.com/'),
        ('饿了么', 'https://www.ele.me/search?keyword=%s', 'https://www.ele.me/'),
        ('美食杰', 'https://www.meishij.net/search?keyword=%s', 'https://www.meishij.net/'),
        ('丁香医生', 'https://dxy.com/search?query=%s', 'https://dxy.com/'),
        ('好大夫在线', 'https://www.haodf.com/search/?kw=%s', 'https://www.haodf.com/'),
    ],
}


# ============================================================================
#  轮 27：URL 两类之分 —— 「打开类」（直达终点，不搜索）
# ============================================================================
#
#  背景：用户要求「明确区分两类 URL：一类跳转到目标软件并触发搜索，另一类
#  直接打开目标软件的指定页面」。搜索类上面的 NEW / NEW_R21 已经有一大批，
#  这里补**打开类**：点一下直接开到那个站点/软件的首页，不带关键词。
#
#  ⚠ 打开类的硬规则（Rust 的 clean_custom_engine 同款校验）：
#    · url 里**不许有 %s**（有就变成搜索模板了，打开类严禁）；
#    · 名字带「（首页）」后缀，和同分类的搜索条目一一配对，一眼能看出
#      「这个站既能搜、也能直接开」。
#    · icon 在 main() 里按**同站复用**处理：能找到同域名的搜索条目就照抄
#      它的 icon / iconFile / inset（顺带把已经落地过的图标文件也用上），
#      找不到的回退成站点首页 URL（fetch-icons 会去取 favicon）。
#
#  ⚠ 数据是 (name, url) 两元组 —— icon 不在这里写，见 main() 的复用逻辑。

NEW_OPEN = {
    # ---------------------------- 网页 ----------------------------
    '网页': [
        ('百度（首页）', 'https://www.baidu.com/'),
        ('必应（首页）', 'https://www.bing.com/'),
        ('谷歌（首页）', 'https://www.google.com/'),
        ('搜狗（首页）', 'https://www.sogou.com/'),
        ('360 搜索（首页）', 'https://www.so.com/'),
        ('Yandex（首页）', 'https://yandex.com/'),
        ('DuckDuckGo（首页）', 'https://duckduckgo.com/'),
        ('Yahoo（首页）', 'https://www.yahoo.com/'),
        ('Brave 搜索（首页）', 'https://search.brave.com/'),
        ('Ecosia（首页）', 'https://www.ecosia.org/'),
        ('Qwant（首页）', 'https://www.qwant.com/'),
        ('Mojeek（首页）', 'https://www.mojeek.com/'),
        ('Startpage（首页）', 'https://www.startpage.com/'),
        ('神马搜索（首页）', 'https://m.sm.cn/'),
        ('夸克搜索（首页）', 'https://quark.sm.cn/'),
        ('头条搜索（首页）', 'https://so.toutiao.com/'),
        ('无追搜索（首页）', 'https://www.wuzhuiso.com/'),
        ('中国搜索（首页）', 'http://www.chinaso.com/'),
    ],
    # ---------------------------- AI 工具 ----------------------------
    'AI 工具': [
        ('ChatGPT（首页）', 'https://chatgpt.com/'),
        ('Claude（首页）', 'https://claude.ai/'),
        ('Gemini（首页）', 'https://gemini.google.com/'),
        ('文心一言（首页）', 'https://yiyan.baidu.com/'),
        ('通义千问（首页）', 'https://tongyi.aliyun.com/'),
        ('Kimi（首页）', 'https://kimi.moonshot.cn/'),
        ('智谱清言（首页）', 'https://chatglm.cn/'),
        ('讯飞星火（首页）', 'https://xinghuo.xfyun.cn/'),
        ('豆包（首页）', 'https://www.doubao.com/'),
        ('DeepSeek（首页）', 'https://chat.deepseek.com/'),
        ('Grok（首页）', 'https://grok.com/'),
        ('Copilot（首页）', 'https://copilot.microsoft.com/'),
        ('Qwen Chat（首页）', 'https://chat.qwen.ai/'),
        ('Mistral（首页）', 'https://chat.mistral.ai/'),
        ('Hugging Face（首页）', 'https://huggingface.co/'),
        ('Poe（首页）', 'https://poe.com/'),
        ('Midjourney（首页）', 'https://www.midjourney.com/'),
        ('Perplexity（首页）', 'https://www.perplexity.ai/'),
    ],
    # ---------------------------- 知识 ----------------------------
    '知识': [
        ('维基百科（首页）', 'https://zh.wikipedia.org/'),
        ('百度百科（首页）', 'https://baike.baidu.com/'),
        ('搜狗百科（首页）', 'https://baike.sogou.com/'),
        ('360 百科（首页）', 'https://baike.so.com/'),
        ('MBA 智库百科（首页）', 'https://wiki.mbalib.com/'),
        ('知乎（首页）', 'https://www.zhihu.com/'),
        ('Quora（首页）', 'https://www.quora.com/'),
        ('简书（首页）', 'https://www.jianshu.com/'),
        ('果壳（首页）', 'https://www.guokr.com/'),
        ('少数派（首页）', 'https://sspai.com/'),
        ('萌娘百科（首页）', 'https://zh.moegirl.org.cn/'),
        ('百度文库（首页）', 'https://wenku.baidu.com/'),
        ('百度经验（首页）', 'https://jingyan.baidu.com/'),
        ('维基词典（首页）', 'https://zh.wiktionary.org/'),
        ('WikiHow（首页）', 'https://zh.wikihow.com/'),
        ('维基文库（首页）', 'https://zh.wikisource.org/'),
    ],
    # ---------------------------- 开发 ----------------------------
    '开发': [
        ('GitHub（首页）', 'https://github.com/'),
        ('Gitee（首页）', 'https://gitee.com/'),
        ('GitLab（首页）', 'https://gitlab.com/'),
        ('Bitbucket（首页）', 'https://bitbucket.org/'),
        ('Codeberg（首页）', 'https://codeberg.org/'),
        ('Stack Overflow（首页）', 'https://stackoverflow.com/'),
        ('Stack Exchange（首页）', 'https://stackexchange.com/'),
        ('SegmentFault（首页）', 'https://segmentfault.com/'),
        ('博客园（首页）', 'https://www.cnblogs.com/'),
        ('开源中国（首页）', 'https://www.oschina.net/'),
        ('CSDN（首页）', 'https://www.csdn.net/'),
        ('掘金（首页）', 'https://juejin.cn/'),
        ('V2EX（首页）', 'https://www.v2ex.com/'),
        ('MDN（首页）', 'https://developer.mozilla.org/zh-CN/'),
        ('crates.io（首页）', 'https://crates.io/'),
        ('Go Packages（首页）', 'https://pkg.go.dev/'),
        ('npm（首页）', 'https://www.npmjs.com/'),
        ('NuGet（首页）', 'https://www.nuget.org/'),
        ('Packagist（首页）', 'https://packagist.org/'),
        ('RubyGems（首页）', 'https://rubygems.org/'),
        ('PyPI（首页）', 'https://pypi.org/'),
        ('Hacker News（首页）', 'https://news.ycombinator.com/'),
        ('DEV（首页）', 'https://dev.to/'),
        ('Lobsters（首页）', 'https://lobste.rs/'),
        ('Sourcegraph（首页）', 'https://sourcegraph.com/'),
        ('LeetCode（首页）', 'https://leetcode.cn/'),
        ('菜鸟教程（首页）', 'https://www.runoob.com/'),
        ('腾讯云社区（首页）', 'https://cloud.tencent.com/developer'),
        ('阿里云开发者（首页）', 'https://developer.aliyun.com/'),
        ('InfoQ（首页）', 'https://www.infoq.cn/'),
        ('Docker Hub（首页）', 'https://hub.docker.com/'),
        ('Arch Wiki（首页）', 'https://wiki.archlinux.org/'),
    ],
    # ---------------------------- 翻译 ----------------------------
    '翻译': [
        ('DeepL（首页）', 'https://www.deepl.com/translator'),
        ('百度翻译（首页）', 'https://fanyi.baidu.com/'),
        ('谷歌翻译（首页）', 'https://translate.google.com/'),
        ('搜狗翻译（首页）', 'https://fanyi.sogou.com/'),
        ('有道翻译（首页）', 'https://fanyi.youdao.com/'),
        ('腾讯翻译君（首页）', 'https://fanyi.qq.com/'),
        ('彩云小译（首页）', 'https://fanyi.caiyunapp.com/'),
        ('Yandex 翻译（首页）', 'https://translate.yandex.com/'),
        ('Papago（首页）', 'https://papago.naver.com/'),
        ('Linguee（首页）', 'https://www.linguee.com/'),
        ('Reverso（首页）', 'https://context.reverso.net/'),
    ],
    # ---------------------------- 词典 ----------------------------
    '词典': [
        ('汉典（首页）', 'https://www.zdic.net/'),
        ('百度汉语（首页）', 'https://hanyu.baidu.com/'),
        ('有道词典（首页）', 'https://www.youdao.com/'),
        ('金山词霸（首页）', 'https://www.iciba.com/'),
        ('海词（首页）', 'https://dict.cn/'),
        ('剑桥词典（首页）', 'https://dictionary.cambridge.org/'),
        ('柯林斯词典（首页）', 'https://www.collinsdictionary.com/'),
        ('牛津词典（首页）', 'https://www.oxfordlearnersdictionaries.com/'),
        ('韦氏词典（首页）', 'https://www.merriam-webster.com/'),
        ('Vocabulary.com（首页）', 'https://www.vocabulary.com/'),
        ('朗文词典（首页）', 'https://www.ldoceonline.com/'),
        ('Free Dictionary（首页）', 'https://www.thefreedictionary.com/'),
    ],
    # ---------------------------- 地图 ----------------------------
    '地图': [
        ('高德地图（首页）', 'https://www.amap.com/'),
        ('百度地图（首页）', 'https://map.baidu.com/'),
        ('腾讯地图（首页）', 'https://map.qq.com/'),
        ('谷歌地图（首页）', 'https://www.google.com/maps'),
        ('必应地图（首页）', 'https://www.bing.com/maps'),
        ('OpenStreetMap（首页）', 'https://www.openstreetmap.org/'),
    ],
    # ---------------------------- 图片 ----------------------------
    '图片': [
        ('百度图片（首页）', 'https://image.baidu.com/'),
        ('必应图片（首页）', 'https://www.bing.com/images'),
        ('谷歌图片（首页）', 'https://www.google.com/imghp'),
        ('Unsplash（首页）', 'https://unsplash.com/'),
        ('Pixabay（首页）', 'https://pixabay.com/'),
        ('Pexels（首页）', 'https://www.pexels.com/'),
        ('Freepik（首页）', 'https://www.freepik.com/'),
        ('iconfont（首页）', 'https://www.iconfont.cn/'),
        ('Iconify（首页）', 'https://icon-sets.iconify.design/'),
        ('Giphy（首页）', 'https://giphy.com/'),
        ('站酷（首页）', 'https://www.zcool.com.cn/'),
        ('花瓣网（首页）', 'https://huaban.com/'),
        ('Wallhaven（首页）', 'https://wallhaven.cc/'),
        ('Yandex 图片（首页）', 'https://yandex.com/images/'),
        ('DuckDuckGo 图片（首页）', 'https://duckduckgo.com/?iax=images&ia=images'),
        ('ArtStation（首页）', 'https://www.artstation.com/'),
        ('Behance（首页）', 'https://www.behance.net/'),
        ('Dribbble（首页）', 'https://dribbble.com/'),
        ('DeviantArt（首页）', 'https://www.deviantart.com/'),
        ('500px（首页）', 'https://500px.com/'),
        ('Lottiefiles（首页）', 'https://lottiefiles.com/'),
    ],
    # ---------------------------- 音乐 ----------------------------
    '音乐': [
        ('QQ 音乐（首页）', 'https://y.qq.com/'),
        ('网易云音乐（首页）', 'https://music.163.com/'),
        ('酷狗音乐（首页）', 'https://www.kugou.com/'),
        ('酷我音乐（首页）', 'https://www.kuwo.cn/'),
        ('咪咕音乐（首页）', 'https://music.migu.cn/'),
        ('千千音乐（首页）', 'https://music.taihe.com/'),
        ('Spotify（首页）', 'https://open.spotify.com/'),
        ('Apple Music（首页）', 'https://music.apple.com/'),
        ('YouTube Music（首页）', 'https://music.youtube.com/'),
        ('SoundCloud（首页）', 'https://soundcloud.com/'),
        ('Bandcamp（首页）', 'https://bandcamp.com/'),
        ('Last.fm（首页）', 'https://www.last.fm/'),
        ('Genius（首页）', 'https://genius.com/'),
        ('Musixmatch（首页）', 'https://www.musixmatch.com/'),
    ],
    # ---------------------------- 视频 ----------------------------
    '视频': [
        ('哔哩哔哩（首页）', 'https://www.bilibili.com/'),
        ('爱奇艺（首页）', 'https://www.iqiyi.com/'),
        ('腾讯视频（首页）', 'https://v.qq.com/'),
        ('优酷（首页）', 'https://www.youku.com/'),
        ('芒果TV（首页）', 'https://www.mgtv.com/'),
        ('搜狐视频（首页）', 'https://tv.sohu.com/'),
        ('西瓜视频（首页）', 'https://www.ixigua.com/'),
        ('好看视频（首页）', 'https://haokan.baidu.com/'),
        ('央视网（首页）', 'https://www.cctv.com/'),
        ('抖音（首页）', 'https://www.douyin.com/'),
        ('快手（首页）', 'https://www.kuaishou.com/'),
        ('YouTube（首页）', 'https://www.youtube.com/'),
        ('Vimeo（首页）', 'https://vimeo.com/'),
        ('Twitch（首页）', 'https://www.twitch.tv/'),
        ('Dailymotion（首页）', 'https://www.dailymotion.com/'),
        ('Netflix（首页）', 'https://www.netflix.com/'),
        ('Crunchyroll（首页）', 'https://www.crunchyroll.com/'),
        ('1905 电影网（首页）', 'https://www.1905.com/'),
        ('豆瓣电影（首页）', 'https://movie.douban.com/'),
    ],
    # ---------------------------- 购物 ----------------------------
    '购物': [
        ('淘宝（首页）', 'https://www.taobao.com/'),
        ('天猫（首页）', 'https://www.tmall.com/'),
        ('京东（首页）', 'https://www.jd.com/'),
        ('拼多多（首页）', 'https://www.pinduoduo.com/'),
        ('苏宁易购（首页）', 'https://www.suning.com/'),
        ('唯品会（首页）', 'https://www.vip.com/'),
        ('当当（首页）', 'https://www.dangdang.com/'),
        ('亚马逊（首页）', 'https://www.amazon.cn/'),
        ('eBay（首页）', 'https://www.ebay.com/'),
        ('AliExpress（首页）', 'https://www.aliexpress.com/'),
        ('1688（首页）', 'https://www.1688.com/'),
        ('闲鱼（首页）', 'https://www.goofish.com/'),
        ('什么值得买（首页）', 'https://www.smzdm.com/'),
        ('网易严选（首页）', 'https://you.163.com/'),
        ('Etsy（首页）', 'https://www.etsy.com/'),
        ('Temu（首页）', 'https://www.temu.com/'),
        ('Shopee（首页）', 'https://shopee.sg/'),
        ('Walmart（首页）', 'https://www.walmart.com/'),
        ('Ozon（首页）', 'https://www.ozon.ru/'),
        ('乐天市场（首页）', 'https://www.rakuten.co.jp/'),
        ('宜家（首页）', 'https://www.ikea.cn/cn/zh/'),
        ('小米商城（首页）', 'https://www.mi.com/'),
        ('华为商城（首页）', 'https://www.vmall.com/'),
        ('得物（首页）', 'https://www.dewu.com/'),
    ],
    # ---------------------------- 应用 ----------------------------
    '应用': [
        ('酷安（首页）', 'https://www.coolapk.com/'),
        ('F-Droid（首页）', 'https://f-droid.org/'),
        ('APKPure（首页）', 'https://apkpure.com/'),
        ('AlternativeTo（首页）', 'https://alternativeto.net/'),
        ('腾讯软件中心（首页）', 'https://pc.qq.com/'),
        ('Microsoft Store（首页）', 'https://apps.microsoft.com/'),
        ('小米应用商店（首页）', 'https://app.mi.com/'),
        ('华为应用市场（首页）', 'https://appgallery.huawei.com/'),
        ('Softpedia（首页）', 'https://www.softpedia.com/'),
        ('豌豆荚（首页）', 'https://www.wandoujia.com/'),
        ('应用宝（首页）', 'https://android.myapp.com/'),
    ],
    # ---------------------------- 游戏 ----------------------------
    '游戏': [
        ('Steam（首页）', 'https://store.steampowered.com/'),
        ('Epic 商店（首页）', 'https://store.epicgames.com/zh-CN/'),
        ('WeGame（首页）', 'https://www.wegame.com.cn/'),
        ('暴雪战网（首页）', 'https://www.blizzard.cn/'),
        ('米哈游（首页）', 'https://www.mihoyo.com/'),
        ('王者荣耀（首页）', 'https://pvp.qq.com/'),
        ('英雄联盟（首页）', 'https://lol.qq.com/'),
        ('游民星空（首页）', 'https://www.gamersky.com/'),
        ('3DM（首页）', 'https://www.3dmgame.com/'),
        ('IGN（首页）', 'https://www.ign.com/'),
        ('itch.io（首页）', 'https://itch.io/'),
        ('Nexus Mods（首页）', 'https://www.nexusmods.com/'),
        ('GameFAQs（首页）', 'https://gamefaqs.gamespot.com/'),
        ('GOG（首页）', 'https://www.gog.com/'),
        ('Metacritic（首页）', 'https://www.metacritic.com/'),
        ('Humble Bundle（首页）', 'https://www.humblebundle.com/'),
        ('IGDB（首页）', 'https://www.igdb.com/'),
        ('OpenCritic（首页）', 'https://opencritic.com/'),
    ],
    # ---------------------------- 学术 ----------------------------
    '学术': [
        ('知网（首页）', 'https://www.cnki.net/'),
        ('万方（首页）', 'https://www.wanfangdata.com.cn/'),
        ('维普（首页）', 'http://www.cqvip.com/'),
        ('arXiv（首页）', 'https://arxiv.org/'),
        ('Semantic Scholar（首页）', 'https://www.semanticscholar.org/'),
        ('PubMed（首页）', 'https://pubmed.ncbi.nlm.nih.gov/'),
        ('ResearchGate（首页）', 'https://www.researchgate.net/'),
        ('谷歌专利（首页）', 'https://patents.google.com/'),
        ('Nature（首页）', 'https://www.nature.com/'),
        ('Science（首页）', 'https://www.science.org/'),
        ('IEEE Xplore（首页）', 'https://ieeexplore.ieee.org/'),
        ('ScienceDirect（首页）', 'https://www.sciencedirect.com/'),
        ('Papers with Code（首页）', 'https://paperswithcode.com/'),
        ('DBLP（首页）', 'https://dblp.org/'),
        ('CORE（首页）', 'https://core.ac.uk/'),
        ('BASE（首页）', 'https://www.base-search.net/'),
        ('Wiley（首页）', 'https://onlinelibrary.wiley.com/'),
        ('Taylor & Francis（首页）', 'https://www.tandfonline.com/'),
    ],
    # ---------------------------- 社交 ----------------------------
    '社交': [
        ('微博（首页）', 'https://weibo.com/'),
        ('豆瓣（首页）', 'https://www.douban.com/'),
        ('小红书（首页）', 'https://www.xiaohongshu.com/'),
        ('百度贴吧（首页）', 'https://tieba.baidu.com/'),
        ('即刻（首页）', 'https://web.okjike.com/'),
        ('虎扑（首页）', 'https://www.hupu.com/'),
        ('脉脉（首页）', 'https://maimai.cn/'),
        ('最右（首页）', 'https://www.zuiyou.com/'),
        ('X / Twitter（首页）', 'https://x.com/'),
        ('Facebook（首页）', 'https://www.facebook.com/'),
        ('Instagram（首页）', 'https://www.instagram.com/'),
        ('Threads（首页）', 'https://www.threads.net/'),
        ('Reddit（首页）', 'https://www.reddit.com/'),
        ('LinkedIn（首页）', 'https://www.linkedin.com/'),
        ('Telegram（首页）', 'https://web.telegram.org/'),
        ('WhatsApp（首页）', 'https://web.whatsapp.com/'),
        ('Discord（首页）', 'https://discord.com/'),
        ('TikTok（首页）', 'https://www.tiktok.com/'),
    ],
    # ---------------------------- 新闻 ----------------------------
    '新闻': [
        ('新浪新闻（首页）', 'https://news.sina.com.cn/'),
        ('腾讯新闻（首页）', 'https://news.qq.com/'),
        ('网易新闻（首页）', 'https://news.163.com/'),
        ('搜狐新闻（首页）', 'https://news.sohu.com/'),
        ('澎湃新闻（首页）', 'https://www.thepaper.cn/'),
        ('界面新闻（首页）', 'https://www.jiemian.com/'),
        ('观察者网（首页）', 'https://www.guancha.cn/'),
        ('环球网（首页）', 'https://www.huanqiu.com/'),
        ('中国新闻网（首页）', 'https://www.chinanews.com/'),
        ('人民网（首页）', 'http://www.people.com.cn/'),
        ('新华网（首页）', 'http://www.xinhuanet.com/'),
        ('央广网（首页）', 'https://www.cnr.cn/'),
        ('36 氪（首页）', 'https://36kr.com/'),
        ('虎嗅（首页）', 'https://www.huxiu.com/'),
        ('BBC 中文（首页）', 'https://www.bbc.com/zhongwen/simp'),
        ('路透社（首页）', 'https://www.reuters.com/'),
        ('CNN（首页）', 'https://edition.cnn.com/'),
        ('纽约时报（首页）', 'https://www.nytimes.com/'),
    ],
    # ---------------------------- 财经 ----------------------------
    '财经': [
        ('东方财富（首页）', 'https://www.eastmoney.com/'),
        ('雪球（首页）', 'https://xueqiu.com/'),
        ('财联社（首页）', 'https://www.cls.cn/'),
        ('华尔街见闻（首页）', 'https://wallstreetcn.com/'),
        ('第一财经（首页）', 'https://www.yicai.com/'),
        ('新浪财经（首页）', 'https://finance.sina.com.cn/'),
        ('和讯网（首页）', 'https://www.hexun.com/'),
        ('同花顺（首页）', 'https://www.10jqka.com.cn/'),
        ('证券之星（首页）', 'https://www.stockstar.com/'),
        ('中金在线（首页）', 'https://www.cnfol.com/'),
        ('Bloomberg（首页）', 'https://www.bloomberg.com/'),
        ('CNBC（首页）', 'https://www.cnbc.com/'),
    ],
    # ---------------------------- 学习 ----------------------------
    '学习': [
        ('中国大学MOOC（首页）', 'https://www.icourse163.org/'),
        ('学堂在线（首页）', 'https://www.xuetangx.com/'),
        ('Coursera（首页）', 'https://www.coursera.org/'),
        ('edX（首页）', 'https://www.edx.org/'),
        ('Khan Academy（首页）', 'https://www.khanacademy.org/'),
        ('Udemy（首页）', 'https://www.udemy.com/'),
        ('Skillshare（首页）', 'https://www.skillshare.com/'),
        ('Codecademy（首页）', 'https://www.codecademy.com/'),
        ('慕课网（首页）', 'https://www.imooc.com/'),
        ('网易云课堂（首页）', 'https://study.163.com/'),
        ('W3Schools（首页）', 'https://www.w3schools.com/'),
        ('MDN 文档（首页）', 'https://developer.mozilla.org/'),
        ('leetcode（首页）', 'https://leetcode.cn/'),
        ('牛客网（首页）', 'https://www.nowcoder.com/'),
    ],
    # ---------------------------- 阅读 ----------------------------
    '阅读': [
        ('起点中文网（首页）', 'https://www.qidian.com/'),
        ('晋江文学城（首页）', 'https://www.jjwxc.net/'),
        ('微信读书（首页）', 'https://weread.qq.com/'),
        ('纵横中文网（首页）', 'https://www.zongheng.com/'),
        ('番茄小说（首页）', 'https://fanqienovel.com/'),
        ('七猫免费小说（首页）', 'https://www.qimao.com/'),
        ('刺猬猫（首页）', 'https://www.ciweimao.com/'),
        ('息壤中文网（首页）', 'https://www.xrzww.com/'),
        ('17K 小说（首页）', 'https://www.17k.com/'),
        ('塔读文学（首页）', 'https://www.tadu.com/'),
        ('鸠摩搜书（首页）', 'https://www.jiumodiary.com/'),
        ('Z-Library（首页）', 'https://z-lib.gs/'),
        ('Goodreads（首页）', 'https://www.goodreads.com/'),
    ],
    # ---------------------------- 汽车 ----------------------------
    '汽车': [
        ('汽车之家（首页）', 'https://www.autohome.com.cn/'),
        ('懂车帝（首页）', 'https://www.dongchedi.com/'),
        ('易车（首页）', 'https://www.yiche.com/'),
        ('太平洋汽车（首页）', 'https://www.pcauto.com.cn/'),
        ('爱卡汽车（首页）', 'https://www.xcar.com.cn/'),
        ('瓜子二手车（首页）', 'https://www.guazi.com/'),
        ('人人车（首页）', 'https://www.renrenche.com/'),
    ],
    # ---------------------------- 生活 ----------------------------
    '生活': [
        ('大众点评（首页）', 'https://www.dianping.com/'),
        ('下厨房（首页）', 'https://www.xiachufang.com/'),
        ('美食杰（首页）', 'https://www.meishij.net/'),
        ('天气网（首页）', 'https://www.tianqi.com/'),
        ('中国天气网（首页）', 'https://www.weather.com.cn/'),
        ('快递100（首页）', 'https://www.kuaidi100.com/'),
        ('菜鸟裹裹（首页）', 'https://www.cainiao.com/'),
        ('12306（首页）', 'https://www.12306.cn/'),
        ('携程（首页）', 'https://www.ctrip.com/'),
        ('去哪儿（首页）', 'https://www.qunar.com/'),
        ('飞猪（首页）', 'https://www.fliggy.com/'),
        ('马蜂窝（首页）', 'https://www.mafengwo.cn/'),
        ('途牛（首页）', 'https://www.tuniu.com/'),
        ('58 同城（首页）', 'https://www.58.com/'),
        ('赶集网（首页）', 'https://www.ganji.com/'),
    ],
    # ---------------------------- 工具 ----------------------------
    '工具': [
        ('天眼查（首页）', 'https://www.tianyancha.com/'),
        ('企查查（首页）', 'https://www.qcc.com/'),
        ('爱企查（首页）', 'https://aiqicha.baidu.com/'),
        ('Wolfram Alpha（首页）', 'https://www.wolframalpha.com/'),
        ('Internet Archive（首页）', 'https://archive.org/'),
        ('Wayback Machine（首页）', 'https://web.archive.org/'),
        ('VirusTotal（首页）', 'https://www.virustotal.com/'),
        ('石墨文档（首页）', 'https://shimo.im/'),
        ('腾讯文档（首页）', 'https://docs.qq.com/'),
        ('金山文档（首页）', 'https://www.kdocs.cn/'),
        ('ProcessOn（首页）', 'https://www.processon.com/'),
        ('draw.io（首页）', 'https://app.diagrams.net/'),
        ('Excalidraw（首页）', 'https://excalidraw.com/'),
        ('稿定设计（首页）', 'https://www.gaoding.com/'),
        ('Canva（首页）', 'https://www.canva.cn/'),
        ('TinyPNG（首页）', 'https://tinypng.com/'),
        ('草料二维码（首页）', 'https://cli.im/'),
    ],
    # ---------------------------- 邮箱 ----------------------------
    '邮箱': [
        ('QQ 邮箱（首页）', 'https://mail.qq.com/'),
        ('163 邮箱（首页）', 'https://mail.163.com/'),
        ('126 邮箱（首页）', 'https://mail.126.com/'),
        ('新浪邮箱（首页）', 'https://mail.sina.com.cn/'),
        ('Outlook（首页）', 'https://outlook.live.com/'),
        ('Gmail（首页）', 'https://mail.google.com/'),
        ('阿里邮箱（首页）', 'https://mail.aliyun.com/'),
        ('189 邮箱（首页）', 'https://mail.189.cn/'),
        ('139 邮箱（首页）', 'https://mail.10086.cn/'),
        ('搜狐邮箱（首页）', 'https://mail.sohu.com/'),
        ('ProtonMail（首页）', 'https://proton.me/'),
        ('Zoho Mail（首页）', 'https://www.zoho.com/mail/'),
    ],
    # ---------------------------- 常用软件（新分类） ----------------------------
    '常用软件': [
        # 办公 / 沟通
        ('微信（首页）', 'https://weixin.qq.com/'),
        ('QQ（首页）', 'https://im.qq.com/'),
        ('钉钉（首页）', 'https://www.dingtalk.com/'),
        ('飞书（首页）', 'https://www.feishu.cn/'),
        ('企业微信（首页）', 'https://work.weixin.qq.com/'),
        ('腾讯会议（首页）', 'https://meeting.tencent.com/'),
        ('Zoom（首页）', 'https://zoom.us/'),
        ('Microsoft Teams（首页）', 'https://www.microsoft.com/microsoft-teams'),
        ('腾讯 TIM（首页）', 'https://tim.qq.com/'),
        # 视频 / 直播
        ('芒果 TV（首页）', 'https://www.mgtv.com/'),
        ('斗鱼直播（首页）', 'https://www.douyu.com/'),
        ('虎牙直播（首页）', 'https://www.huya.com/'),
        # 音乐 / 电台
        ('喜马拉雅（首页）', 'https://www.ximalaya.com/'),
        ('蜻蜓 FM（首页）', 'https://www.qtfm.cn/'),
        # 动漫 / 漫画
        ('腾讯动漫（首页）', 'https://ac.qq.com/'),
        ('快看漫画（首页）', 'https://www.kuaikanmanhua.com/'),
        ('哔哩哔哩漫画（首页）', 'https://manga.bilibili.com/'),
        # 游戏平台 / 官网
        ('原神（首页）', 'https://ys.mihoyo.com/'),
        ('崩坏：星穹铁道（首页）', 'https://sr.mihoyo.com/'),
        ('明日方舟（首页）', 'https://ak.hypergryph.com/'),
        ('和平精英（首页）', 'https://gp.qq.com/'),
        ('永劫无间（首页）', 'https://www.yjwujian.cn/'),
        ('Valorant（首页）', 'https://val.qq.com/'),
        ('Epic 商城（首页）', 'https://store.epicgames.com/'),
        # 社交 / 情感
        ('Soul（首页）', 'https://www.soulapp.cn/'),
        ('探探（首页）', 'https://tantanapp.com/'),
    ],
}


# ============================================================================
#  体检修正：tools/verify-engines.js 报出来的问题，在这里收口
# ============================================================================
#
# ⚠ 体检用的关键词是英文 'test'，**中文站点会因此误判**：像汉典（`/hans/中国` 才有
#   条目）、纵横中文网，英文关键词查不到东西会回 404。所以自动报出来的 DEAD
#   必须用中文关键词人工复检一次再动手 —— 下面这几条都是复检过的结论。

# 搜索路径已经改掉的，改成实测可用的新地址。
FIX_URLS = {
    # 酷安换了搜索页：老的 `/search?q=` 已经 404，新的聚合搜索页是 /algo。
    '酷安': 'https://www.coolapk.com/algo?keyword=%s',
    # 天气网：so.tianqi.com 会 301 到 www.tianqi.com/so/，直接写终址省一跳。
    '天气网': 'https://www.tianqi.com/so/?keyword=%s',
    # ⚠ 下面三条是**本轮自己加错的**，被体检（verify-engines.js）当场抓出来 ——
    #   加引擎时凭印象写地址很容易翻车，这就是为什么加完必须跑一次体检。
    # 丁香医生：`?query=` 是 404，`?keyword=` 会 301 到健康搜索页。
    '丁香医生': 'https://dxy.com/search?keyword=%s',
    # 宜家：`/search/?q=` 是 404，商品搜索在 /search/products/ 下。
    '宜家': 'https://www.ikea.cn/cn/zh/search/products/?q=%s',
}

# 搜索接口整个没了、又找不到替代的：直接移除。
# 留着只会让用户点一次失败一次，而同分类里已经有能用的替代品。
DROP_NAMES = {
    '千图网',      # 图片：/search、/so、/tupian 全部 404，同类还有花瓣 / 站酷 / Unsplash
    '网易公开课',  # 学习：搜索页忽略关键词（302 到固定页），同类已补「网易云课堂」
    '豆果美食',    # 生活：/search/recipe、/search 全部 404，同类已补「美食杰」
    # 翻译：地址是 `#/text`（纯前端路由），**URL 里没有 %s**，选中的文字根本传不过去
    # —— 在横条上点它等于只打开一个空翻译页。设置页给自定义引擎的校验就是
    # 「地址里必须有 %s」，内置的更不该例外。
    '彩云小译',
    # 生活：美团所有能试的搜索地址都 404 或跳反爬校验页（/s/xxx → /error/404），
    # 没有可用的 URL 搜索入口，同类已经有大众点评 / 饿了么。
    '美团',
}

# ============================================================================
# 软件直达本地唤起链（#154）
# ============================================================================
#
# 「常用软件」分组原来全都是网页首页：用户点「微信」弹的是浏览器里的
# weixin.qq.com，而不是本机的微信。现在给它们配 `app` 字段 —— 运行时的
# 唤起顺序（Rust `launch_app_chain`）：
#     ① 带 `://` 的按 URI 协议直接 ShellExecute（协议本身可以带页面地址，
#        钉钉的 `/page/link?url=` 就是在客户端里开指定页，"启动软件 +
#        打开指定页面"一步完成）；
#     ② 其余按开始菜单 .lnk 名字精确匹配（大小写不敏感）；
#     ③ 全失败回落网页 url（这个字段本来就是首页地址，行为零回归）。
#
# 协议注册情况（2026-10-15 本机实查）：
#   HKCU/HKLM\Software\Classes 里有 URL Protocol 的：weixin / tencent /
#   steam / steamlink / wegame；本机开始菜单实锤：微信、QQ、WeGame、Steam
#   的 .lnk（QQ 在 `腾讯软件\QQ\QQ.lnk`，所以"递归扫子目录"是必须的）。
#   官方文档/多方证实的协议：dingtalk、feishu、wxwork、zoommtg、msteams、
#   com.epicgames.launcher —— 本机没装，没注册时 ① 会失败并落到 ②③，
#   装了软件的机器上直接用。
#   tim 注释：QQ 与 TIM 都注册 tencent://，谁后装谁占位 —— 本机它指向
#   TIM。QQ 只配 .lnk（名字「QQ」），TIM 才用 tencent://，避免点 QQ
#   拉起 TIM。
APP_LAUNCH = {
    # —— 有 URI 协议的：协议优先，没注册再找 .lnk ——
    '微信（首页）': ['weixin://', '微信'],
    '钉钉（首页）': ['dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fwww.dingtalk.com%2F', '钉钉'],
    '飞书（首页）': ['feishu://', '飞书'],
    '企业微信（首页）': ['wxwork://', '企业微信'],
    '腾讯 TIM（首页）': ['tencent://', 'TIM'],
    '腾讯会议（首页）': ['tencentmeeting://', '腾讯会议'],
    'Zoom（首页）': ['zoommtg://', 'Zoom'],
    'Microsoft Teams（首页）': ['msteams://', 'Microsoft Teams'],
    'Epic 商城（首页）': ['com.epicgames.launcher://', 'Epic Games Launcher'],
    # —— 没有公开协议的：只按开始菜单名字找，找不到照旧开网页 ——
    'QQ（首页）': ['QQ'],
    '喜马拉雅（首页）': ['喜马拉雅'],
    '斗鱼直播（首页）': ['斗鱼直播'],
    '虎牙直播（首页）': ['虎牙直播'],
    '快看漫画（首页）': ['快看漫画'],
    '原神（首页）': ['原神'],
    '崩坏：星穹铁道（首页）': ['崩坏：星穹铁道'],
    '明日方舟（首页）': ['明日方舟'],
    '和平精英（首页）': ['和平精英'],
    '永劫无间（首页）': ['永劫无间'],
    'Valorant（首页）': ['Valorant', 'VALORANT'],
}

# 图标补强：这些引擎的 `icon` 指向站点 favicon，但从这台机器上取不到
# （国际站点连不上 / 站点反爬）。它们在国际图标集 simple-icons 里有现成的矢量图，
# 换成矢量图既清楚又不受网络影响。
# `slug` 都是先问过 Iconify 的 JSON API、确认存在的（别凭印象写）。
# 剩下确实没有矢量图的（36氪 / 财联社 / 饿了么 / 美食杰 / 学堂在线 …）
# 就保留 app 的字母兜底徽标 —— 那是本来就有的设计，不难看。
ICON_FIX = {
    # 引擎名: (simple-icons 的 slug, 品牌色)
    'ArtStation': ('artstation', '13AFF0'),
    'DeviantArt': ('deviantart', '05CC47'),
    '500px': ('500px', '0099E5'),
    'Lottiefiles': ('lottiefiles', '00DDB3'),
    '乐天市场': ('rakuten', 'BF0000'),
    '小米应用商店': ('xiaomi', 'FF6900'),
    'Softpedia': ('softpedia', '1E5FA8'),
    'Humble Bundle': ('humblebundle', 'CB272C'),
    'IGDB': ('igdb', '9147FF'),
    'OpenCritic': ('opencritic', '1B1B1B'),
    'MEGA': ('mega', 'D9272E'),
    'Papers with Code': ('paperswithcode', '21CBCE'),
    '百度汉语': ('baidu', '2932E1'),
    'AO3': ('archiveofourown', '900000'),
    'IEEE 标准': ('ieee', '00629B'),
    # ---- 轮 27：打开类补的图标（这些站 favicon 这台机器取不到，
    #      slug 同样先问过 Iconify JSON API 确认存在）----
    # 打开类和同域搜索条目会复用图标（见 main() 第 4 步），所以给搜索条目
    # 换上矢量图，它的「（首页）」兄弟会自动跟上；不同域的才各写一份。
    'Wayback Machine': ('internetarchive', '000000'),
    'Yahoo': ('yahoo', '6001D2'),
    'BBC 中文（首页）': ('bbc', 'FF0000'),
    'Yahoo（首页）': ('yahoo', '6001D2'),
    'Wayback Machine（首页）': ('internetarchive', '000000'),
    'Gmail（首页）': ('gmail', 'EA4335'),
    'ProtonMail（首页）': ('protonmail', '6D4AFF'),
    '微信（首页）': ('wechat', '07C160'),
    '哔哩哔哩漫画（首页）': ('bilibili', 'FB7299'),
    'Netflix（首页）': ('netflix', 'E50914'),
    'V2EX（首页）': ('v2ex', '0E83CD'),
    'X / Twitter（首页）': ('x', '000000'),
    'Instagram（首页）': ('instagram', 'E4405F'),
    '华为应用市场（首页）': ('huawei', 'CF0A2C'),
    '天猫（首页）': ('taobao', 'FF4200'),
    '阿里邮箱（首页）': ('alibabacloud', 'FF6A00'),
    'Telegram（首页）': ('telegram', '26A5E4'),
    'WhatsApp（首页）': ('whatsapp', '25D366'),
    'Discord（首页）': ('discord', '5865F2'),
    'Zoom（首页）': ('zoom', '2D8CFF'),
}


def site_icon(url):
    """打开类的兜底图标：站点自己的根（fetch-icons 会按域名取 favicon）。

    打开类的 url 就是站点首页，直接拿 scheme://host/ 当 icon 最稳 ——
    不赌 Iconify 里有没有这个牌子（中文站点基本都没有）。
    """
    p = urlsplit(url)
    return '%s://%s/' % (p.scheme, p.netloc)


# 快捷键类（轮 28 新增的第三类引擎）。
#
# 和另两批的形状完全不同，单独放：
#   · 没有 url —— 点了不打开任何页面；
#   · 没有 icon —— 没有站点可抓 favicon，前端走首字母徽标兜底
#     （和 77 个取不到图标的国内站同一套设计，不是遗漏）；
#   · 多一个 hotkey 字段 —— 按键序列，词汇表见 win::parse_hotkey
#     （ctrl/alt/shift/win + 字母数字/F1~F24/命名键/标点，单键也合法）。
#
# 按键序列全部经过 win::parse_hotkey 的口径核对：能解析、主键唯一。
# 命名避开内置引擎重名（合并时 have 集合也会兜底去重）。
NEW_HOT = {
    '快捷键': [
        # ---- Windows 系统功能 ----
        ('截图', 'win+shift+s'),            # Snip & Sketch 区域截图
        ('全屏截图', 'prtsc'),              # 整屏复制进剪贴板
        ('剪贴板历史', 'win+v'),
        ('显示桌面', 'win+d'),
        ('文件资源管理器', 'win+e'),
        ('锁定屏幕', 'win+l'),
        ('任务视图', 'win+tab'),
        ('任务管理器', 'ctrl+shift+esc'),
        ('表情面板', 'win+.'),
        ('Xbox 游戏栏', 'win+g'),
        ('放大镜', 'win+plus'),             # plus = VK_OEM_PLUS（主键盘 +）
        ('屏幕键盘', 'ctrl+win+o'),
        ('系统设置', 'win+i'),
        ('运行对话框', 'win+r'),
        ('系统搜索', 'win+s'),
        ('快速设置', 'win+a'),
        ('投影面板', 'win+p'),
        ('通知中心', 'win+n'),
        # ---- 浏览器 / 通用软件 ----
        ('恢复关闭的标签页', 'ctrl+shift+t'),
        ('浏览器历史', 'ctrl+h'),
        ('下载内容', 'ctrl+j'),
        ('收藏本页', 'ctrl+d'),
        ('全屏模式', 'f11'),
        ('无痕窗口', 'ctrl+shift+n'),
        ('新标签页', 'ctrl+t'),
        ('关闭标签页', 'ctrl+w'),
    ],
}


def main():
    with io.open(ENGINES, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # ---- 0. 分组改名（幂等：改过就跳过） ----
    renamed = []
    for c in data.get('categories', []):
        new_t = RENAME_CATS.get(c['title'])
        if new_t:
            renamed.append('%s → %s' % (c['title'], new_t))
            c['title'] = new_t
    if renamed:
        print('分组改名：' + '；'.join(renamed))

    have = set()
    for e in data.get('toolbar', []):
        have.add(e['name'])
    for c in data.get('categories', []):
        for e in c.get('engines', []):
            have.add(e['name'])

    # 三批合并（同名分类的列表要**接起来**，不能互相覆盖）。
    # NEW / NEW_R21 是搜索类（地址带 %s），NEW_OPEN 是打开类（地址不带 %s，
    # 名字带「（首页」后缀）—— 合并时就把 kind 一起盖章，别等读的时候再猜。
    merged = {}
    for src, kind in ((NEW, 'search'), (NEW_R21, 'search')):
        for title, items in src.items():
            merged.setdefault(title, []).extend(
                (name, url, icon, kind) for name, url, icon in items)
    for title, items in NEW_OPEN.items():
        merged.setdefault(title, []).extend(
            (name, url, site_icon(url), 'open') for name, url in items)
    print('待合并引擎条目：%d 条 / %d 个分组' % (sum(len(v) for v in merged.values()), len(merged)))

    # 快捷键类单独一轮并：形状不一样（无 url 无 icon、多一个 hotkey 字段），
    # 塞不进上面那个四元组队列。同样走 have 去重 + DROP_NAMES 体检。
    hot_added = 0
    for title, items in NEW_HOT.items():
        cat = None
        for c in data['categories']:
            if c['title'] == title:
                cat = c
                break
        if cat is None:
            cat = {'title': title, 'engines': []}
            data['categories'].append(cat)
        for name, spec in items:
            if name in have or name in DROP_NAMES:
                continue
            cat['engines'].append({'name': name, 'url': '', 'hotkey': spec,
                                   'inset': 1, 'kind': 'hotkey'})
            have.add(name)
            hot_added += 1
    if hot_added:
        print('快捷键类条目：%d 条' % hot_added)

    by_title = {c['title']: c for c in data['categories']}
    added, skipped = [], []
    for title, items in merged.items():
        cat = by_title.get(title)
        if cat is None:
            cat = {'title': title, 'engines': []}
            data['categories'].append(cat)
            by_title[title] = cat
        for name, url, icon, kind in items:
            if name in have:
                skipped.append(name)
                continue
            # 已经被体检判死的就别再从批次里加回来（否则每次跑都"新增"一次，
            # 数字看着像真加了，其实下面第 2 步马上又删掉）。
            if name in DROP_NAMES:
                continue
            cat['engines'].append({'name': name, 'url': url, 'icon': icon,
                                   'inset': 1, 'kind': kind})
            have.add(name)
            added.append('%s/%s' % (title, name))

    # ---- 2. 体检修正（放在合并之后，否则会被 NEW 里的老地址重新加回来） ----
    fixed, dropped, app_fixed = [], [], []
    for c in data.get('categories', []):
        keep = []
        for e in c.get('engines', []):
            if e['name'] in DROP_NAMES:
                dropped.append(e['name'])
                continue
            nu = FIX_URLS.get(e['name'])
            if nu and e['url'] != nu:
                fixed.append('%s: %s → %s' % (e['name'], e['url'], nu))
                e['url'] = nu
            # #154 软件直达：补本地唤起链。已配过的保持原样（用户手改也能留住），
            # 没配的按 APP_LAUNCH 表盖章。删掉某个软件的本地链 = 从表里移除该项
            # 并在这里补一句 `e.pop('app', None)`。
            chain = APP_LAUNCH.get(e['name'])
            if chain and e.get('app') != chain:
                e['app'] = list(chain)
                app_fixed.append(e['name'])
            keep.append(e)
        c['engines'] = keep
    if fixed:
        print('修正地址：' + '；'.join(fixed))
    if dropped:
        print('移除失效引擎：' + ', '.join(dropped))
    if app_fixed:
        print('软件直达本地唤起链：%d 条（%s）' % (len(app_fixed), '、'.join(app_fixed)))

    # ---- 2.5 全量 kind 盖章 ----
    # Rust 读 engines.json 时：条目里显式写了 kind 就听它的；没写才按 URL 里
    # 有没有 %s 推断。为了让 json 自描述（人肉审的时候一眼能分出三类），
    # 这里给**每一条**都补上 kind。老条目地址全带 %s，只会被盖成 search；
    # 打开/快捷键类在合并时已经显式写了 kind，不会被改。
    stamped = 0
    for e in data.get('toolbar', []):
        if e.get('kind') not in ('search', 'open', 'hotkey'):
            e['kind'] = 'search' if '%s' in e['url'] else 'open'
            stamped += 1
    for c in data.get('categories', []):
        for e in c.get('engines', []):
            if e.get('kind') not in ('search', 'open', 'hotkey'):
                e['kind'] = 'search' if '%s' in e['url'] else 'open'
                stamped += 1
    if stamped:
        print('kind 盖章：%d 条' % stamped)

    # ---- 3. 图标补强：favicon 取不到的换成 Iconify 矢量图 ----
    # 只在还没落地图标时改（已经有 iconFile 的不动，免得白拉一次还得删旧文件）。
    icon_fixed = []
    for c in data.get('categories', []):
        for e in c.get('engines', []):
            hit = ICON_FIX.get(e['name'])
            if hit and not e.get('iconFile'):
                slug, color = hit
                e['icon'] = ('https://api.iconify.design/simple-icons:%s.svg?color=%%23%s'
                             % (slug, color))
                icon_fixed.append(e['name'])
    if icon_fixed:
        print('图标改用矢量图：' + ', '.join(icon_fixed))

    # ---- 4. 打开类图标同域复用 ----
    # 打开类和同域名的搜索条目本来就是同一个站，图标直接抄搜索条目的 ——
    # 连已经落地过的 iconFile 一起抄：fetch-icons 见到 iconFile 就跳过，
    # 网上少拉一次，icons/ 目录里也不会多躺一份字节相同的重复文件。
    # 找不到同域搜索条目的，保留合并时兜底写的站点根 URL（fetch-icons 会去取 favicon）。
    def _dom(url):
        host = urlsplit(url).netloc.lower()
        return host[4:] if host.startswith('www.') else host

    dom2search = {}
    for c in data.get('categories', []):
        for e in c.get('engines', []):
            if e.get('kind') != 'search':
                continue
            d = _dom(e['url'])
            if d and d not in dom2search:
                dom2search[d] = e
    reused = 0
    for c in data.get('categories', []):
        for e in c.get('engines', []):
            if e.get('kind') != 'open' or e.get('iconFile'):
                continue
            sib = dom2search.get(_dom(e['url']))
            if sib:
                e['icon'] = sib['icon']
                if sib.get('iconFile'):
                    e['iconFile'] = sib['iconFile']
                e['inset'] = sib.get('inset', 1)
                reused += 1
    if reused:
        print('打开类复用同站图标：%d 条' % reused)

    data['generatedAt'] = '2026-10-14'
    with io.open(ENGINES, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')

    total = sum(len(c['engines']) for c in data['categories'])
    print('新增 %d 个引擎，跳过重名 %d 个' % (len(added), len(skipped)))
    if skipped:
        print('  跳过：' + ', '.join(skipped))
    print('现在共 %d 个分类 / %d 个引擎条目' % (len(data['categories']), total))
    # 只报「原本不在 engines.json 基线里的分组」，用来一眼看出这一批开了哪些新分类
    known = set(('网页', 'AI 工具', '知识', '开发', '翻译', '地图', '图片', '音乐',
                 '视频', '购物', '应用', '游戏', '学术', '社交', '新闻',
                 '词典', '财经', '学习', '阅读', '汽车', '生活', '工具', '网盘',
                 '邮箱', '常用软件'))
    fresh = [t for t in merged if t not in known]
    if fresh:
        print('新开分类：' + ', '.join(fresh))
    return 0


if __name__ == '__main__':
    sys.exit(main())
