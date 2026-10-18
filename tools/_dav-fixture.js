/* 临时的 WebDAV 夹具：起一个内存文件系统的仿真服务，预置几份备份，
 * 然后就挂着不动 —— 给 `QuickSearch.exe --webdav-list` 这种命令行诊断用。
 *
 * 用法：node tools/_dav-fixture.js [port]
 * 停止：Ctrl+C
 */
const http = require('http');

const PORT = Number(process.argv[2] || 18100);
const USER = 'qsuser', PASS = 'qspass';
const files = new Map();

function seed(name, mtimeSec) {
    files.set(name, { buf: Buffer.from('seed-' + name, 'utf8'), mtime: new Date(mtimeSec * 1000) });
}
seed('config(2026-10-12 10-00-01).QuickSearch', 1760000001);
seed('config(2026-10-12 10-00-02).QuickSearch', 1760000002);
seed('config(2026-10-12 10-00-03).QuickSearch', 1760000003);

const httpDate = (d) => d.toUTCString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const sub = decodeURIComponent(u.pathname.replace(/^\/dav\/?/, ''));
    console.log(req.method, '/' + sub, 'depth=' + (req.headers.depth || '-'));

    const auth = req.headers['authorization'] || '';
    const want = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
    if (auth !== want) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="qs"' });
        return res.end('need auth');
    }

    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
        if (req.method === 'PROPFIND') {
            const parts = [
                '<?xml version="1.0" encoding="utf-8"?>',
                '<D:multistatus xmlns:D="DAV:">',
                '<D:response><D:href>/dav/</D:href><D:propstat><D:prop>',
                '<D:resourcetype><D:collection/></D:resourcetype>',
                '<D:getcontentlength>0</D:getcontentlength>',
                '<D:getlastmodified>' + httpDate(new Date()) + '</D:getlastmodified>',
                '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
            ];
            for (const [name, f] of files) {
                parts.push(
                    '<D:response><D:href>/dav/' + name.replace(/ /g, '%20') + '</D:href>'
                    + '<D:propstat><D:prop><D:resourcetype/>'
                    + '<D:getcontentlength>' + f.buf.length + '</D:getcontentlength>'
                    + '<D:getlastmodified>' + httpDate(f.mtime) + '</D:getlastmodified>'
                    + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>');
            }
            parts.push('</D:multistatus>');
            const xml = parts.join('');
            console.log('  -> 207, body ' + Buffer.byteLength(xml) + ' 字节');
            res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
            return res.end(xml);
        }
        if (req.method === 'GET') {
            const f = files.get(sub);
            if (!f) {
                const links = [...files.keys()]
                    .map((n) => '<a href="' + n.replace(/ /g, '%20') + '">' + esc(n) + '</a>')
                    .join('\n');
                console.log('  -> 200 目录页');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<!doctype html><meta charset="utf-8"><h1>dav</h1>' + links);
            }
            res.writeHead(200, { 'Content-Length': f.buf.length });
            return res.end(f.buf);
        }
        res.writeHead(405);
        res.end();
    });
}).listen(PORT, '127.0.0.1', () => {
    console.log('仿真 WebDAV 在 http://127.0.0.1:' + PORT + '/dav/ （' + files.size + ' 份备份）');
});
