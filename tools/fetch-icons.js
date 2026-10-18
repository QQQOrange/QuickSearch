/*
 * 把 src/engines.json 里每个引擎的图标「落地」成离线文件，写进 src/icons/。
 *
 * 为什么要落地：
 *   1. 浏览器版是按需联网取图标（Iconify CDN）。桌面版没这个必要 —— 图标总共
 *      不到 200KB，全部内置进去，启动零网络请求、永远不会因为 CDN 限流而空白。
 *   2. Iconify 的 api.iconify.design 会限流（实测 429 / error 1015）。这里改走
 *      **jsDelivr 上的 @iconify-json/<集合> 包**（另一条 CDN，不受 Iconify 限流），
 *      自己按图标名把 body 取出来拼成 SVG；着色规则和浏览器版保持一致：
 *        · 单色图标（URL 带 ?color=X）→ 把 body 里的 currentColor 换成 X，
 *          没有 currentColor 就把 fill="X" 挂在 <svg> 根上
 *        · 多色图标集（logos: / thesvg-color: / selfhst:）→ 原样保留自带配色
 *   3. 网站 favicon 类的引擎，按 apple-touch-icon → favicon 的顺序取最大的一张
 *      （apple-touch-icon 普遍 180×180，比 16×16 的 favicon 清楚得多）。
 *
 * 用法: node tools/fetch-icons.js
 *       node tools/fetch-icons.js --only-missing        只补没有图标的
 *       node tools/fetch-icons.js --only 酷安,天气网     只补点名的几个
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const ENGINES = path.join(ROOT, 'ui', 'data', 'engines.json');
const ICON_DIR = path.join(ROOT, 'ui', 'data', 'icons');

const MULTICOLOR = ['logos:', 'thesvg-color:', 'selfhst:'];

/* --only-missing：只补「还没有本地图标文件」的引擎，已有的原样保留。
 *
 * 为什么需要它：全量跑一遍会重新下载所有图标，只要某个 CDN 抽风，
 * 那个引擎就会拿到 iconFile=null，紧接着的「清理没被引用到的旧图标」
 * 会把它原来的图标文件删掉 —— 一次网络抖动就能把已有图标全弄丢。
 * 补新引擎时用这个开关，只动新的，不碰旧的。 */
const ONLY_MISSING = process.argv.indexOf('--only-missing') >= 0;

/* `--only 名字1,名字2`：只处理点名的这几个引擎。
 * 为什么需要：`--only-missing` 会把**所有**缺图标的引擎都重试一遍，其中
 * favicon 那条路在国际站点上要逐个等 25 秒超时，一轮十几分钟。
 * 只想补几个的时候（比如刚给几个引擎换成了矢量图地址），用这个开关几秒钟就跑完。 */
const ONLY_ARG = (() => {
    const i = process.argv.indexOf('--only');
    if (i < 0) return null;
    const raw = (process.argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return raw.length ? new Set(raw) : null;
})();

const slug = (name) => String(name)
    .replace(/[\/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);

function get(url, binary, depth = 0) {
    if (depth > 5) return Promise.resolve(null);
    return new Promise((resolve) => {
        let mod = https;
        try { if (new URL(url).protocol === 'http:') mod = http; } catch (e) { resolve(null); return; }
        const req = mod.get(url, {
            timeout: 25000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(get(new URL(res.headers.location, url).href, binary, depth + 1));
                return;
            }
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve(binary ? { buf: buf, type: res.headers['content-type'] || '' }
                    : buf.toString('utf8'));
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- @iconify-json 集合缓存（每个集合只下载一次） ----
const collectionCache = new Map();
async function loadCollection(prefix) {
    if (collectionCache.has(prefix)) return collectionCache.get(prefix);
    const url = 'https://cdn.jsdelivr.net/npm/@iconify-json/' + prefix + '@latest/icons.json';
    let json = null;
    for (let i = 0; i < 3 && !json; i++) {
        if (i) await sleep(800 * i);
        const txt = await get(url, false);
        if (txt) { try { json = JSON.parse(txt); } catch (e) { json = null; } }
    }
    collectionCache.set(prefix, json);
    return json;
}

// 从集合里按名字拿图标定义（含 alias 解析）
function lookupIcon(col, name) {
    if (!col || !col.icons) return null;
    let def = col.icons[name];
    let depth = 0;
    while (def && def.parent && depth++ < 8) {
        const p = col.icons[def.parent];
        if (!p) break;
        def = Object.assign({}, p, def, { parent: undefined });
    }
    if (!def || !def.body) return null;
    return def;
}

// 把 Iconify 的 body 拼成一张独立 SVG
function buildSvg(col, def, color) {
    const w = def.width || col.width || 24;
    const h = def.height || col.height || 24;
    const isLeft = def.left !== undefined ? def.left : col.left;
    const isTop = def.top !== undefined ? def.top : col.top;
    let vb = '0 0 ' + w + ' ' + h;
    if (isLeft !== undefined || isTop !== undefined) {
        vb = (isLeft || 0) + ' ' + (isTop || 0) + ' ' + w + ' ' + h;
    }
    let body = def.body;
    let rootFill = '';
    if (color) {
        if (body.indexOf('currentColor') >= 0) {
            body = body.split('currentColor').join(color);
        } else {
            rootFill = ' fill="' + color + '"';
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '"' + rootFill + '>'
        + body + '</svg>';
}

// ---- favicon 链：挑最大的一张 ----
async function fetchBestFavicon(host, originalUrl) {
    const candidates = [
        'https://' + host + '/apple-touch-icon.png',
        'https://' + host + '/apple-touch-icon-precomposed.png',
        originalUrl,
        'https://' + host + '/favicon.ico',
    ];
    let best = null;
    for (const u of candidates) {
        const r = await get(u, true);
        if (!r || !r.buf || r.buf.length < 200) continue;
        const isImg = /image\//.test(r.type)
            || r.buf.slice(0, 4).toString('hex') === '89504e47'
            || r.buf.slice(0, 4).toString('hex') === '00000100'
            || r.buf.slice(0, 3).toString('ascii') === 'GIF'
            || r.buf.slice(0, 2).toString('ascii') === '<s';
        if (!isImg) continue;
        const score = r.buf.length;
        if (!best || score > best.buf.length) {
            best = { buf: r.buf, url: u, type: r.type };
        }
        // apple-touch-icon 命中就够了，不用再往下试
        if (/apple-touch-icon/.test(u)) break;
    }
    return best;
}

const extOf = (buf, type, url) => {
    const hex4 = buf.slice(0, 4).toString('hex');
    if (hex4 === '89504e47') return '.png';
    if (hex4 === '00000100') return '.ico';
    if (hex4 === '47494638') return '.gif';
    if (buf.slice(0, 5).toString('ascii') === '<?xml' || buf.slice(0, 4).toString('ascii') === '<svg') return '.svg';
    if (/svg/.test(type)) return '.svg';
    if (/png/.test(type)) return '.png';
    return '.png';
};

(async () => {
    const data = JSON.parse(fs.readFileSync(ENGINES, 'utf8'));
    fs.mkdirSync(ICON_DIR, { recursive: true });

    // 同一个图标地址只下载一次（引擎重名/同图标很常见）
    const byRemote = new Map();
    const stats = { builtin: 0, iconify: 0, favicon: 0, reuse: 0, fail: 0 };
    const failures = [];

    const handle = async (engine) => {
        // 点名模式：没被点到的直接当"已处理"，既不下载也不统计失败
        if (ONLY_ARG && !ONLY_ARG.has(engine.name)) { stats.reuse++; return; }
        const src = engine.icon || '';

        // 已有本地图标：--only-missing 模式下直接跳过，不重新下载也不覆盖。
        if (ONLY_MISSING && engine.iconFile
            && fs.existsSync(path.join(ICON_DIR, engine.iconFile))) {
            stats.reuse++;
            byRemote.set(src, engine.iconFile);
            return;
        }

        const key = src;
        if (byRemote.has(key)) {
            stats.reuse++;
            engine.iconFile = byRemote.get(key);
            return;
        }

        const fileBase = slug(engine.name);

        // ① 内置矢量（data URI）
        if (src.indexOf('data:image/svg+xml') === 0) {
            const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
            const f = fileBase + '.svg';
            fs.writeFileSync(path.join(ICON_DIR, f), svg, 'utf8');
            byRemote.set(key, f); engine.iconFile = f; stats.builtin++;
            return;
        }

        // ② Iconify 矢量
        const mi = src.match(/^https:\/\/api\.(?:iconify\.design|simplesvg\.com)\/([a-z0-9-]+):([^.?]+)\.svg(?:\?color=(%23[0-9A-Fa-f]{6}|[^&]*))?/);
        if (mi) {
            const prefix = mi[1];
            const name = mi[2];
            const color = mi[3] ? decodeURIComponent(mi[3]) : null;
            const col = await loadCollection(prefix);
            const def = lookupIcon(col, name);
            if (def) {
                let body = def.body;
                // 多色集不带 color 参数：若它仍然用了 currentColor，说明这枚图标
                // 靠外部着色，给它一个安全的深灰，避免在 <img> 里变成纯黑一坨
                let useColor = color;
                if (!color && MULTICOLOR.indexOf(prefix + ':') < 0) useColor = '#808080';
                const svg = buildSvg(col, { body: body, width: def.width, height: def.height, left: def.left, top: def.top }, useColor);
                const f = fileBase + '.svg';
                fs.writeFileSync(path.join(ICON_DIR, f), svg, 'utf8');
                byRemote.set(key, f); engine.iconFile = f; stats.iconify++;
                await sleep(120);
                return;
            }
            failures.push(engine.name + '（Iconify ' + prefix + ':' + name + ' 在集合里找不到）');
        }

        // ③ 网站图标
        //
        // ⚠ 域名要取**引擎自己 URL 的域名**，不能拿图标地址的域名。
        //   图标地址常常是 Iconify 的 CDN，拿 api.iconify.design 去取 favicon
        //   只会取到 CDN 自己的图标，牛头不对马嘴。
        //   （踩过：新引擎的 Iconify 图标名写错了 → 回退取到 CDN 图标。）
        let host = null;
        try {
            const h = new URL(src).hostname;
            if (!/iconify\.design|simplesvg\.com|jsdelivr\.net/.test(h)) host = h;
        } catch (e) { host = null; }
        if (!host) {
            try { host = new URL(engine.url).hostname; } catch (e) { host = null; }
        }
        if (host) {
            const best = await fetchBestFavicon(host, 'https://' + host + '/');
            if (best) {
                const f = fileBase + extOf(best.buf, best.type, best.url);
                fs.writeFileSync(path.join(ICON_DIR, f), best.buf);
                byRemote.set(key, f); engine.iconFile = f; stats.favicon++;
                await sleep(150);
                return;
            }
            failures.push(engine.name + '（' + host + ' 取不到图标）');
        }

        stats.fail++;
        engine.iconFile = null;
    };

    const list = [].concat(data.toolbar || [],
        ...(data.categories || []).map((c) => c.engines));

    let n = 0;
    for (const e of list) {
        n++;
        await handle(e);
        if (n % 20 === 0) console.log('  …已处理 ' + n + '/' + list.length);
    }

    // 清理没被任何引擎引用到的旧图标。
    // --only-missing / --only 模式下**不做**这件事：这两趟都只处理一部分引擎，
    // 没被处理到的那些 iconFile 在写盘前还可能是"待定"状态 —— 判成"没被引用"
    // 直接删掉就是灾难。
    const used = new Set(list.map((e) => e.iconFile).filter(Boolean));
    let removed = 0;
    if (!ONLY_MISSING && !ONLY_ARG) {
        for (const f of fs.readdirSync(ICON_DIR)) {
            if (!used.has(f)) { fs.unlinkSync(path.join(ICON_DIR, f)); removed++; }
        }
    }

    data.schema = 1;
    data.iconDir = 'icons';
    fs.writeFileSync(ENGINES, JSON.stringify(data, null, 2), 'utf8');

    console.log('\n内置矢量   : ' + stats.builtin);
    console.log('Iconify    : ' + stats.iconify);
    console.log('网站图标   : ' + stats.favicon);
    console.log('复用同图   : ' + stats.reuse);
    console.log('失败       : ' + stats.fail);
    if (removed) console.log('清理旧文件 : ' + removed);
    const total = fs.readdirSync(ICON_DIR).length;
    const bytes = fs.readdirSync(ICON_DIR)
        .reduce((a, f) => a + fs.statSync(path.join(ICON_DIR, f)).size, 0);
    console.log('图标文件   : ' + total + ' 个 / ' + (bytes / 1024).toFixed(0) + ' KB');
    if (failures.length) console.log('\n以下引擎没有本地图标（会退到字母徽标）:\n  - ' + failures.join('\n  - '));
})();
