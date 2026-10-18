/* 一次性：列出所有可见顶层窗口（class + title + rect + pid），
 * 用来挑一个「带可选中文字的 WebView2 窗口」给 UIA 探针做目标。 */
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch (e) {}
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const P = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void*h,intptr l)'));
const IsWindowVisible = user32.func('int IsWindowVisible(void*h)');
const GetWindowTextW = user32.func('int GetWindowTextW(void*h,_Out_ uint16*b,int n)');
const GetClassNameW = user32.func('int GetClassNameW(void*h,_Out_ uint16*b,int n)');
const GetWindowRect = user32.func('int GetWindowRect(void*h,void*r)');
const GetWindowThreadProcessId = user32.func('int GetWindowThreadProcessId(void*h,_Out_ int*pid)');

const out = [];
const cb = koffi.register((h) => {
    if (!IsWindowVisible(h)) return 1;
    const buf = new Uint16Array(300), cls = new Uint16Array(128);
    GetWindowTextW(h, buf, 300);
    GetClassNameW(h, cls, 128);
    const rect = Buffer.alloc(16);
    GetWindowRect(h, rect);
    const x = rect.readInt32LE(0), y = rect.readInt32LE(4), r = rect.readInt32LE(8), b = rect.readInt32LE(12);
    if (r - x < 80 || b - y < 40) return 1;
    const pid = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pid);
    let t = ''; for (let i = 0; i < 300; i++) if (buf[i]) t += String.fromCharCode(buf[i]); else break;
    let c = ''; for (let i = 0; i < 128; i++) if (cls[i]) c += String.fromCharCode(cls[i]); else break;
    out.push(`pid=${pid.readUInt32LE(0)} cls=${c} rect=(${x},${y},${r},${b}) title=${JSON.stringify(t)}`);
    return 1;
}, P);
EnumWindows(cb, 0); koffi.unregister(cb);
console.log(out.join('\n'));
