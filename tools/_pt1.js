const koffi = require('koffi');
const u = koffi.load('user32.dll');
const WFP = u.func('void* WindowFromPoint(int x, int y)');
const WFPp = u.func('void* WindowFromPhysicalPoint(int x, int y)');
const GCW = u.func('int GetClassNameW(void*h, _Out_ uint16*b, int n)');
const GR = u.func('int GetWindowRect(void*h, _Out_ void*r)');
function cls(h){const b=new Uint16Array(256);const n=GCW(h,b,256);let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(b[i]);return s;}
function rect(h){const buf=Buffer.alloc(16);GR(h,buf);return `(${buf.readInt32LE(0)},${buf.readInt32LE(4)},${buf.readInt32LE(8)},${buf.readInt32LE(12)})`;}
for (const [x,y] of [[1650,1200],[2475,1800],[1100,800]]) {
  const a = WFP(x,y);
  const b = WFPp(x,y);
  console.log(`WFP(${x},${y})=0x${a.toString(16)} ${a?cls(a):''} ${a?rect(a):''} | phys=${b?'0x'+b.toString(16)+' '+cls(b):'null'}`);
}
