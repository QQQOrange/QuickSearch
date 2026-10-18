const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
try { user32.func('int SetProcessDpiAwarenessContext(intptr ctx)')(-4); } catch(e){}
const RECT = koffi.struct('RECT',{left:'long',top:'long',right:'long',bottom:'long'});
const EnumWindows = user32.func('int EnumWindows(void *cb, intptr lp)');
const ENUMPROC_PTR = koffi.pointer(koffi.proto('int __stdcall ENUMPROC(void *hwnd, intptr lparam)'));
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16 *b, int n)');
const GetWindowRect = user32.func('int GetWindowRect(void *h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const out=[];
const cb=koffi.register((h)=>{
  const b=new Uint16Array(300); const n=GetWindowTextW(h,b,300);
  let s=''; for(let i=0;i<n;i++) s+=String.fromCharCode(b[i]);
  if(IsWindowVisible(h) && /Quick|设置|QS/.test(s)){ const r={}; GetWindowRect(h,r); out.push({t:s,l:r.left,tp:r.top,r:r.right,b:r.bottom}); }
  return 1;
}, ENUMPROC_PTR);
EnumWindows(cb,0); koffi.unregister(cb);
for(const w of out) console.log(w.t, `[${w.l},${w.tp} - ${w.r},${w.b}]`, `w=${w.r-w.l} h=${w.b-w.tp}`);
if(!out.length) console.log('(no matching window)');
