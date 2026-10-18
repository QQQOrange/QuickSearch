const koffi = require('koffi');
const u = koffi.load('user32.dll');
const WFP = u.func('void* WindowFromPoint(int x, int y)');
const GCW = u.func('int GetClassNameW(void*h, _Out_ uint16*b, int n)');
const GTW = u.func('int GetWindowThreadProcessId(void*h, _Out_ uint32*p)');
function cls(h){const b=new Uint16Array(256);const n=GCW(h,b,256);let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(b[i]);return s;}
// 沿 WorkBuddy 窗口 rect 网格扫，统计命中窗口类名
const pts = [];
for (let x = 700; x <= 2700; x += 400) for (let y = 220; y <= 1950; y += 300) pts.push([x, y]);
const tally = {};
let nulls = 0;
for (const [x, y] of pts) {
  const h = WFP(x, y);
  if (!h) { nulls++; tally['<null>'] = (tally['<null>']||0)+1; continue; }
  const pid = Buffer.alloc(4); GTW(h, pid);
  const k = cls(h) + ' pid=' + pid.readUInt32LE(0);
  tally[k] = (tally[k]||0)+1;
}
console.log('nulls=' + nulls + '/' + pts.length);
for (const [k, v] of Object.entries(tally).sort((a,b)=>b[1]-a[1])) console.log(v + ' × ' + k);
