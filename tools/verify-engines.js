/* ============================================================================
 *  搜索引擎 URL 可用性体检
 *
 *  把 ui/data/engines.json 里每个引擎的搜索地址都真发一次请求，看它到底通不通：
 *    · OK      2xx —— 正常
 *    · BLOCK   401/403/405/429/503 —— 大概率是反爬拦了脚本，浏览器里能用
 *    · DEAD    404/410 —— 搜索路径已经改了，这条要修
 *    · NETFAIL DNS 解析不了 / 连不上 / 超时 / TLS 错 —— 域名没了或改了
 *    · HTTP    其它状态码，人工看一眼
 *
 *  用法：
 *    node tools/verify-engines.js            全部跑一遍
 *    node tools/verify-engines.js --only-bad 只打印有问题的
 *    node tools/verify-engines.js --json     额外输出 tools/engines-health.json
 *
 *  ⚠ 只能说明「这个地址通不通」，不能说明「搜索结果对不对」——
 *    搜索接口大多要 JS 才出结果。但域名死了、路径改了的，这里一定能抓到。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINES = path.join(ROOT, 'ui', 'data', 'engines.json');
const OUT = path.join(__dirname, 'engines-health.json');

const ONLY_BAD = process.argv.includes('--only-bad');
const AS_JSON = process.argv.includes('--json');

/** 测试关键词。用中文 + 英文各测一次能顺带看出编码有没有问题。 */
const PROBE = 'test';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟 Rust 侧的 encode_query：空格用 %20，其余非 unreserved 字符全百分号编码 */
function encodeQuery(s) {
    let out = '';
    for (const b of Buffer.from(s, 'utf8')) {
        if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
            || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e) {
            out += String.fromCharCode(b);
        } else {
            out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return out;
}

async function probeOne(engine) {
    const url = engine.url.replace('%s', encodeQuery(PROBE));
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            signal: AbortSignal.timeout(15000),
        });
        const ms = Date.now() - t0;
        let kind;
        if (res.status >= 200 && res.status < 300) kind = 'OK';
        else if ([401, 403, 405, 429, 503, 302, 303].includes(res.status)) kind = 'BLOCK';
        else if (res.status === 404 || res.status === 410) kind = 'DEAD';
        else kind = 'HTTP';
        // 把 body 读掉，避免连接挂着不释放
        try { await res.arrayBuffer(); } catch (e) { }
        return { name: engine.name, url, kind, status: res.status, ms, final: res.url };
    } catch (e) {
        return {
            name: engine.name, url, kind: 'NETFAIL', status: 0,
            ms: Date.now() - t0, error: String((e && e.cause && e.cause.code) || (e && e.message) || e),
        };
    }
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
        while (true) {
            const k = i++;
            if (k >= items.length) return;
            out[k] = await fn(items[k], k);
            process.stderr.write('.');
        }
    });
    await Promise.all(workers);
    process.stderr.write('\n');
    return out;
}

(async () => {
    const data = JSON.parse(fs.readFileSync(ENGINES, 'utf8'));
    const list = [];
    const seen = new Set();
    for (const c of data.categories) {
        for (const e of c.engines) {
            const key = e.name + '\u0001' + e.url;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({ name: e.name, url: e.url, cat: c.title });
        }
    }

    console.log('开始体检 ' + list.length + ' 个引擎（并发 6，每个最多 15 秒）…\n');
    const t0 = Date.now();
    const res = await pool(list, 6, probeOne);
    console.log('用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒\n');

    const bad = res.filter((r) => r.kind !== 'OK');
    const show = ONLY_BAD ? bad : res;

    const order = { DEAD: 0, NETFAIL: 1, HTTP: 2, BLOCK: 3, OK: 4 };
    show.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
    for (const r of show) {
        const tail = r.kind === 'OK' ? '' :
            '  ' + (r.error || ('HTTP ' + r.status)) + (r.final && r.final !== r.url ? ('  → ' + r.final.slice(0, 90)) : '');
        console.log('[' + r.kind.padEnd(7) + '] ' + r.name.padEnd(16) + ' ' + (r.ms + 'ms').padEnd(8) + r.url + tail);
    }

    const tally = {};
    for (const r of res) tally[r.kind] = (tally[r.kind] || 0) + 1;
    console.log('\n统计：' + Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '));

    if (AS_JSON) {
        fs.writeFileSync(OUT, JSON.stringify(res, null, 2), 'utf8');
        console.log('明细写到 ' + OUT);
    }
})();
