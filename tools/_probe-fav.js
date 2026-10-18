const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const conf = {
  version:'1.0.0', iconSize:30, alpha:100, barPadding:5, animations:false, shadow:false,
  ocrEnable:true, unifyIcons:false, iconStyle:'auto',
  barList:['百度','|','@ocr','@fav:fmv3lk0nqbht9k'],
  customEngines:[], overrideIcons:{}, urlOverrides:{}, aiSuffixes:{}, sepStyle:'line',
  favorites:[{id:'fmv3lk0nqbht9k',name:'银行卡号',icon:'',items:[{id:'i1',kind:'text',text:'6222 0000 1111 2222',remark:'工行卡'}],children:[]}],
};
const dom=new JSDOM(read('ui/index.html'),{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const w=dom.window;
console.log('body 长度:', (w.document.body&&w.document.body.innerHTML.length)||'(无body)');
console.log('engines 元素:', !!w.document.getElementById('engines'));
w.fetch=()=>Promise.resolve({json:()=>Promise.resolve(JSON.parse(read('ui/data/engines.json')))});
w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
w.__TAURI__={core:{invoke:(c,a)=>{ if(c==='get_config') return Promise.resolve(conf); return Promise.resolve(null); }},
 event:{listen:(n,f)=>{ w.__ls=w.__ls||new Map(); w.__ls.set(n,f); return Promise.resolve(()=>{}); }}};
w.addEventListener('error',e=>console.log('!! window error:',e.message));
w.addEventListener('unhandledrejection',e=>console.log('!! rejection:', e.reason && e.reason.message));
try{ w.eval(read('ui/shared.js')); console.log('shared ok'); }catch(e){ console.log('!! shared 抛异常:', e.message); }
try{ w.eval(read('ui/bar.js')); console.log('bar ok'); }catch(e){ console.log('!! bar 抛异常:', e.message); }
setTimeout(()=>{
  const $=id=>w.document.getElementById(id);
  console.log('CONF.favorites:', !!(w.CONF && w.CONF.favorites));
  const favBtn = w.document.querySelector('.qs-fav-inbar');
  console.log('收藏夹按钮在横条上?', !!favBtn);
  console.log('引擎区文本:', JSON.stringify(($('engines')||{}).textContent||''));
  const more=$('btnMore'); if(more){ more.dispatchEvent(new w.Event('click',{bubbles:true})); }
  setTimeout(()=>{
    console.log('面板隐藏?', ($('panel')||{}).hidden);
  console.log('BODY:', (w.document.body?w.document.body.innerHTML.slice(0,400):'(无)'));
    console.log('面板收藏夹入口数?', w.document.querySelectorAll('.fav-entry').length);
    process.exit(0);
  },150);
},300);
