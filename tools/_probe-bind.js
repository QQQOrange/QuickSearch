const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');
const ROOT=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const dom=new JSDOM(read('ui/settings.html'),{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const w=dom.window;const calls=[];
w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
w.__TAURI__={core:{invoke:(c,a)=>{calls.push({c,a});return Promise.resolve(c==='get_config'?{version:'1',barList:['百度'],customEngines:[],overrideIcons:{},aiSuffixes:{},sepStyle:'line'}:null);}},
 event:{listen:()=>Promise.resolve(()=>{})}};
w.fetch=u=>Promise.resolve({json:()=>Promise.resolve(JSON.parse(read('ui/data/engines.json')))});
w.addEventListener('error',e=>console.log('!! window error:',e.message));
try{ w.eval(read('ui/shared.js')); w.eval(read('ui/settings.js')); }catch(e){ console.log('!! eval 抛异常:', e.message); }
setTimeout(()=>{
  const $=id=>w.document.getElementById(id);
  console.log('s-ocrEnable 存在:', !!$('s-ocrEnable'));
  // 逐个检查 SWITCHES/SEGS/SLIDERS/TEXTS 里的元素是否都在
  const probe=['s-triggerSelect','s-triggerCopy','s-anchorAtMouse','s-autoStart','s-autoElevate',
   's-animations','s-shadow','s-aiCopyPrompt','s-ocrEnable','s-webdavOnStart','s-webdavOnExit',
   's-iconSize','s-iconSizeVal','s-barPadding','s-barPaddingVal','s-alpha','s-alphaVal','s-delay','s-delayVal',
   's-filterList','s-filterMode','s-sepStyle','s-ocrLang','s-ocrAccurate','w-aiSuffix','w-webdavUrl','w-webdavUser',
   'w-webdavPass','w-webdavFile','w-ocrKey','w-ocrSecret'];
  const miss=probe.filter(id=>!$(id));
  console.log('缺失的元素:', miss.length?miss:'（无）');
  // 试拨一个开关
  calls.length=0;
  const el=$('s-triggerSelect');
  el.checked=false; el.dispatchEvent(new w.Event('change',{bubbles:true}));
  console.log('拨 s-triggerSelect 后调用:', JSON.stringify(calls));
  calls.length=0;
  const o=$('s-ocrEnable');
  o.checked=false; o.dispatchEvent(new w.Event('change',{bubbles:true}));
  console.log('拨 s-ocrEnable 后调用:', JSON.stringify(calls));
},600);
