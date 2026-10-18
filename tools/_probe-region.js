const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch(e){}
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
function all(){
  const out=[];
  const cb=koffi.register((h)=>{
    const b=new Uint16Array(300); const n=GetWindowTextW(h,b,300);
    let s=''; for(let i=0;i<n;i++) s+=String.fromCharCode(b[i]);
    out.push({t:s, vis:IsWindowVisible(h), h});
    return 1;
  }, ENUMPROC_PTR);
  EnumWindows(cb,0); koffi.unregister(cb); return out;
}
const list=all();
console.log('--- windows containing QS / Region / Picker / 识别 ---');
for(const w of list) if(/QS|Region|Picker|识别|Quick/.test(w.t)) console.log(JSON.stringify({t:w.t, vis:w.vis}));
console.log('total top-level windows seen:', list.length);
