/*
 * 生成应用图标：圆角蓝底 + 白色放大镜，输出多尺寸 .ico（PNG 帧格式）
 * 用法: node tools/gen-icon.js
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('C:/Users/64381/.workbuddy/binaries/node/workspace/node_modules/@resvg/resvg-js');

const OUT_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6E8BFF"/>
      <stop offset="1" stop-color="#3652D9"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="96" height="96" rx="22" fill="url(#g)"/>
  <circle cx="43" cy="43" r="21" fill="none" stroke="#FFFFFF" stroke-width="9"/>
  <path d="M58.5 58.5 L76 76" fill="none" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round"/>
</svg>`;

const png = (size) => {
    const r = new Resvg(SVG, { fitTo: { mode: 'width', value: size } });
    return r.render().asPng();
};

const sizes = [256, 128, 64, 48, 32, 16];
const frames = sizes.map((s) => ({ size: s, data: png(s) }));

// 写 .ico —— 用 Vista+ 的「PNG 帧」格式（每帧就是一张完整 PNG，不需要 BMP 调色板）
const count = frames.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = icon
header.writeUInt16LE(count, 4);  // 帧数

const dir = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
frames.forEach((f, i) => {
    const o = i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o + 0);      // 宽（256 记 0）
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o + 1);      // 高
    dir.writeUInt8(0, o + 2);                               // 调色板数
    dir.writeUInt8(0, o + 3);                               // reserved
    dir.writeUInt16LE(1, o + 4);                            // planes
    dir.writeUInt16LE(32, o + 6);                           // bpp
    dir.writeUInt32LE(f.data.length, o + 8);                // 数据长度
    dir.writeUInt32LE(offset, o + 12);                      // 数据偏移
    offset += f.data.length;
});

const ico = Buffer.concat([header, dir, ...frames.map((f) => f.data)]);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
console.log('已生成 icons/icon.ico  ' + ico.length + ' 字节，含 ' + sizes.join('/') + ' 六种尺寸');

// Tauri 打包偶尔也要 png 版本，顺手给几个
for (const s of [32, 128, 256]) {
    fs.writeFileSync(path.join(OUT_DIR, s + 'x' + s + '.png'), png(s));
}
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png(256));
console.log('已生成 icons/32x32.png / 128x128.png / 256x256.png / icon.png');
