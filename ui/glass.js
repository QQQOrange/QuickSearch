/* ============================================================================
 * 液态玻璃渲染器（WebGL2）
 *
 * 背景来自 Rust：`layout_bar` 在横条首次上屏前抓一块窗口矩形（BitBlt，
 * 见 src/glass.rs），前端 `glass_take` 拿字节上传成纹理。渲染数学从
 * liquidGL（github.com/naughtyduk/liquidGL）的 GLSL 透镜着色器逐函数移植：
 *   · udRoundBox / cornerNormal / edgeFactor  —— 圆角矩形 SDF + 边缘法线
 *   · offsetAmt = edge*refraction + edge^10*bevelDepth —— 真折射（厚玻璃扭曲）
 *   · chroma = offset * aberration            —— 色差（蓝移大于红移）
 *   · frost 16-tap 随机模糊 / 清晰模式 5-tap
 *   · specular 双光斑（一个绕时间、一个死盯指针）
 * 相对原版的增强：上下缘锐利亮线（rim）、指针光斑、明暗主题染色、
 * 桶形放大梯度（中心放大略强，mag = u_magnify + 0.06*(1-edge)，#133）、
 * 折射铺满系数放宽（centreBlend 0.05/0.55，#133「折射差」）。
 *
 * 为什么不用 CSS backdrop-filter：它取样的是**页面内**元素背后的内容，
 * 透明悬浮窗里那后面是空的 —— 只剩底板色，就是"塑料磨砂"的根因。
 * 浏览器安全模型也禁止 JS 读窗口外的桌面像素，所以背景必须 Rust 抓。
 * ==========================================================================*/
(function () {
    'use strict';

    var CVS_ID = 'qsGlass';
    var BAR_ID = 'bar';
    /** 瓶口（bevel）基准宽度：占**矮边**的比例。liquidGL 默认 0.15，
     *  横条矮，取 0.18 观感更"厚玻璃"。（r47 起只画横条一块，不再逐块校正。） */
    var BEVEL_W = 0.18;

    var canvas = null;
    var gl = null;
    var prog = null;
    var uni = {};
    var tex = null;
    var texW = 0, texH = 0;
    var conf = null;
    var raf = 0;
    var liveRaf = 0;              // （保留字段：旧代码里 stopLive 会清它，见下）
    /** 抓屏帧率上限（r86 重构）。
     *
     *  # 背景：用户报"滚动网页时玻璃不跟随，像卡住了"
     *
     *  根因是我在 r84 把**抓屏**这一路限到 15fps（66ms 一轮）。滚动时背景
     *  每 66ms 才更新一次，肉眼就是"滞后/卡住"。
     *
     *  # r84 那个判断错在哪（值得记下来）
     *
     *  r84 的理由是"抓屏要 BitBlt + 传 600KB，开销比重画一帧大一个量级，
     *  15fps 看不出滞后"。这段话**有两处错**：
     *    · 实测开销：主进程（Rust 抓屏 + 编码）只占 **0.2%**；真正烧 26% 的
     *      是 **WebView2 的着色器重绘**。抓屏根本不是瓶颈。
     *    · "看不出滞后"是坐在静止页面上得出的一一**滚动网页**时，66ms 的
     *      滞后一眼就看出来了（用户就是这么发现的）。
     *
     *  # 现在的原则：省在**没用的重绘**上，花在**跟手的抓屏**上
     *
     *  用户的原话是"能够接受为了美观而增加的合理开销，但一定要合理"。
     *  所以：
     *    · **抓屏**默认跟显示器刷新率走（`barGlassFps = 0`），跟手优先；
     *    · **重绘**只在"画面真的会变"的那些帧跑 —— 静止时一次都不跑。
     *  这才是"合理"：花的钱换到了体验，没花在空转上。
     *
     *  用户可以在设置里把上限降到 30/60/120（省电），见 `barGlassFps`。 */
    var liveIntervalMs = 0;       // 0 = 不限（跟随显示器）
    var lastLiveAt = 0;
    /** "有内容变了、下一帧必须画一次"（r86）。
     *
     *  这是合并循环之后**省 CPU 的关键**：抓屏是异步的，多数帧并没有新纹理
     *  落地；每帧都无脑画一遍相同的纹理，就是 r84 里那 26% CPU 的来处。
     *  所以只有真实变化（新纹理 / 主题切换 / 面板尺寸变了 / 淡入）才置上它，
     *  `frame()` 里画完即清。静止横条在没有它时一次都不画。 */
    var dirty = false;
    /** 由配置（`barGlassFps`）换算抓屏间隔。0/非法值 → 0（不限速）。 */
    function setLiveFps(fps) {
        liveIntervalMs = (fps && fps > 0) ? (1000 / fps) : 0;
    }
    /** 这一帧该不该抓屏（按用户设的上限节流）。 */
    function liveTooSoon(now) {
        if (liveIntervalMs <= 0) return false;      // 跟随显示器：每帧都抓
        if (now - lastLiveAt < liveIntervalMs) return true;
        return false;
    }
    var liveStarting = false;     // 正在异步开启（等 glass_exclude 回执）
    var excluded = false;         // 横条已对抓屏隐身（WDA_EXCLUDEFROMCAPTURE 生效中）
    var captureBusy = false;      // 一次抓屏在途（去重，杜绝叠加隐藏）
    /** 抓屏代次：每次 captureOnce 自增，用来作废"上一轮迟到的回调"。 */
    var captureBusyGen = 0;
    /** **是谁把 stage 藏起来的**（那一代的代次；0 = 没藏着）。
     *  只有它自己回来时才有资格恢复可见 —— 见 captureOnce 里的两目标说明。 */
    var stageHideOwner = 0;
    var liveThrottle = 0;         // 兜底路径的帧计数（每 4 帧抓一次）
    var exclChain = Promise.resolve();  // 抓屏隐身状态变更的串行队列（乱序免疫）
    var shown = false;
    /** WebGL 上下文丢失/恢复的监听是不是已经挂过（只在第一次 initGL 时挂一次）。 */
    var contextHooksInstalled = false;
    /** 外部可注册的两个回调（见 initGL 里挂监听那段的注释）。
     *  bar.js 会挂上：丢失时清状态、恢复时让下一次 show 重新抓背景。 */
    var onContextLost = null;
    var onContextRestored = null;
/* r49：横条被"钉住"时藏起来了（bar.js 给 .bar 挂 .ghost = visibility:hidden）。
 *
 * ⚠ 为什么玻璃层必须知道这件事：`.ghost` 只藏了 **DOM** 那一层，而玻璃是画在
 *   `<canvas>` 上的（`drawBox(barEl, …)` 按 `getBoundingClientRect()` 出玻璃，
 *   visibility:hidden **不改变盒子**）。于是画布上还端端正正留着一整条玻璃 —— 
 *   用户看到的就是「横条里的图标全不见了，可横条还在」（2026-10-16 用户报的 bug）。
 *   所以隐身的这段时间要**清画布 + 不画**，一帧都不能留。 */
var barGhost = false;
    var pointer = [-1, -1];        // 横条内归一化坐标（左上原点）；[-1,-1] = 不在条上
    var reveal = 0;                // 0→1 淡入
    var revealT0 = 0;
    var stats = { takes: 0, captures: 0, draws: 0, passes: 0, lastRect: '', ghostClears: 0 };

    /* ---------------------------------------------------------------- */
    /* 着色器（liquidGL 移植版，GLSL ES 3.00）                            */
    /* ---------------------------------------------------------------- */

    var VS = [
        '#version 300 es',
        'in vec2 a_position;',
        'out vec2 v_uv;',
        'void main(){',
        '  v_uv = (a_position + 1.0) * 0.5;',   // 顶部 → v=1
        '  gl_Position = vec4(a_position, 0.0, 1.0);',
        '}',
    ].join('\n');

    var FS = [
        '#version 300 es',
        'precision highp float;',
        'in vec2 v_uv;',
        'out vec4 fragColor;',
        'uniform sampler2D u_tex;',             // Rust 抓的窗口矩形（物理像素，top-down）
        'uniform vec2 u_resolution;',           // 画布物理像素
        'uniform vec2 u_boxSize;',              // 同 resolution（画布铺满自身）
        'uniform vec2 u_textureResolution;',    // 纹理尺寸
        'uniform vec2 u_subpixel;',             // 恒 0（1:1 摆放）
        'uniform vec4 u_bounds;',               // 画布在窗口里的子矩形（xy=原点, zw=尺寸）
        'uniform float u_refraction, u_aberration, u_bevelDepth, u_bevelWidth,',
        '              u_frost, u_radius, u_magnify, u_time, u_specStrength,',
        '              u_rimStrength, u_reveal;',
        'uniform vec4 u_tint;',                 // rgb=染色, a=强度
        'uniform bool u_specular;',
        'uniform vec2 u_pointer;',              // 归一化指针（左上原点），(-1,-1)=不在条上

        'vec4 sampleSource(vec2 uv){ return texture(u_tex, uv); }',

        'float udRoundBox(vec2 p, vec2 b, float r){ return length(max(abs(p)-b+r,0.0))-r; }',

        // 圆角边缘的法线：直边段用 SDF 梯度（下方 fallback），圆角段用圆心方向
        'vec2 cornerNormal(vec2 p, vec2 b, float r, vec2 fb){',
        '  vec2 q=abs(p)-b+r; vec2 m=max(q,0.0); float l=length(m);',
        '  if(l<=0.0) return fb;',
        '  float w=smoothstep(0.0,max(r*0.5,1.0),min(m.x,m.y)); if(w<=0.0) return fb;',
        '  vec2 s=vec2(p.x<0.0?-1.0:1.0, p.y<0.0?-1.0:1.0);',
        '  return normalize(mix(fb, s*(m/l), w));',
        '}',

        'float random(vec2 st){ return fract(sin(dot(st,vec2(12.9898,78.233)))*43758.5453123); }',

        // 距边缘多近：1 = 贴着边，0 = 深入内部。倒角折射全靠它驱动
        'float edgeFactor(vec2 p_px, vec2 b_px, float r_px){',
        '  float d=-udRoundBox(p_px,b_px,r_px);',
        '  float bevel=u_bevelWidth*min(u_boxSize.x,u_boxSize.y);',
        '  return 1.0-smoothstep(0.0,bevel,d);',
        '}',

        'void main(){',
        '  vec2 lensUV=(v_uv*u_resolution-u_subpixel)/u_boxSize;',
        '  vec2 p_px=(lensUV-0.5)*u_boxSize;',
        '  vec2 b_px=0.5*u_boxSize;',
        '  float dmask=udRoundBox(p_px,b_px,u_radius);',
        '  float inShape=1.0-smoothstep(-0.5,0.5,dmask);',
        '  if(inShape<=0.0){ fragColor=vec4(0.0); return; }',   // 圆角外全透明，露出桌面

        // ① 真折射：边缘法线 × (基础折射 + 倒角深度)，中心区平滑收手
        '  float edge=edgeFactor(p_px,b_px,u_radius);',
        '  float offsetAmt=edge*u_refraction+pow(edge,10.0)*u_bevelDepth;',
        // centreBlend 决定折射能伸到离中心多近（#133 质感重调：「折射差」）。
        // 原来是 smoothstep(0.15,0.45,...) —— 横条只有 40px 高，0.15 意味着
        // 中心 30% 的区域位移恒 0，折射只在贴边一圈看得见，整条横条大部分
        // 面积是"平板"。放宽到 (0.05,0.55)：折射几乎铺满整个面，
        // 玻璃感从"贴边一条"变成"整块都在轻微扭曲"。
        '  float centreBlend=smoothstep(0.05,0.55,length(p_px/u_boxSize.y));',
        '  vec2 refractDir=cornerNormal(p_px,b_px,u_radius,normalize(p_px/u_boxSize.y+0.000001));',
        '  vec2 offset=refractDir*offsetAmt*centreBlend;',

        // 放大 + 窗口子矩形映射（bounds 之外的部分让桌面透出来）
        // 桶形放大梯度（#133）：中心比边缘多放大 6% —— 真厚玻璃就是这样，
        // 中心透镜效应最明显；恒定的 u_magnify 会让放大看起来像"整体缩放"
        // 而不是"一块有厚度的玻璃"。
        '  float mag=u_magnify+0.06*(1.0-edge);',
        '  vec2 localUV=(lensUV-0.5)/mag+0.5;',
        '  vec2 flippedUV=vec2(localUV.x,1.0-localUV.y);',
        '  vec2 mapped=u_bounds.xy+flippedUV*u_bounds.zw;',
        '  vec2 refracted=mapped+offset;',
        '  float oob=max(max(-refracted.x,refracted.x-1.0),max(-refracted.y,refracted.y-1.0));',
        // 越界时钳到纹理内而不是裁回 mapped：折射拉满（60‰+倒角 30‰）时极缘
        // 偏移会越过画布在纹理里的安全边距，硬裁回 mapped 会留下一段"位移恒 0"
        // 的死区（边缘一条可见的硬切）。钳制保留折射方向，只是幅度截到纹理边缘 ——
        // 纹理边缘就是窗口边框那一圈桌面，视觉上与"继续取样"无缝衔接。
        '  vec2 sampleUV=mix(clamp(refracted,vec2(0.0),vec2(1.0)),refracted,1.0-smoothstep(0.0,0.01,oob));',

        '  vec4 baseCol=sampleSource(mapped);',
        '  vec2 texel=1.0/u_textureResolution; vec2 chroma=offset*u_aberration;',
        '  vec4 refrCol;',
        '  if(u_frost>0.0){',                      // 磨砂：16-tap 随机模糊
        '    vec4 sum=vec4(0.0); float radius=u_frost*3.0;',
        '    for(int i=0;i<16;i++){',
        '      float ang=random(v_uv+float(i))*6.283185;',
        '      float dist=sqrt(random(v_uv-float(i)))*radius;',
        '      vec2 foff=vec2(cos(ang),sin(ang))*texel*dist;',
        '      if(u_aberration>0.0){',
        '        sum.r+=sampleSource(sampleUV+foff-chroma).r;',
        '        sum.g+=sampleSource(sampleUV+foff).g;',
        '        sum.b+=sampleSource(sampleUV+foff+chroma).b;',
        '        sum.a+=sampleSource(sampleUV+foff).a;',
        '      } else sum+=sampleSource(sampleUV+foff);',
        '    }',
        '    if(u_aberration>0.0) refrCol=vec4(sum.r/16.0,sum.g/16.0,sum.b/16.0,1.0);',
        '    else refrCol=sum/16.0;',
        '  } else {',                              // 清晰：5-tap 去锯齿 + 色差
        '    refrCol=sampleSource(sampleUV)',
        '      +sampleSource(sampleUV+vec2(texel.x,0.0))+sampleSource(sampleUV-vec2(texel.x,0.0))',
        '      +sampleSource(sampleUV+vec2(0.0,texel.y))+sampleSource(sampleUV-vec2(0.0,texel.y));',
        '    refrCol/=5.0;',
        '    if(u_aberration>0.0){',
        '      refrCol.r=sampleSource(sampleUV-chroma).r;',
        '      refrCol.b=sampleSource(sampleUV+chroma).b;',
        '    }',
        '  }',
        '  if(refrCol.a<0.1) refrCol=baseCol;',

        '  vec4 finalCol=refrCol;',
        '  finalCol.rgb=mix(finalCol.rgb, finalCol.rgb*u_tint.rgb, u_tint.a);',

        // ② 动态光影：lp1 绕时间漂移，lp2 死盯指针（不在条上时也绕时间）
        '  if(u_specular){',
        '    vec2 lp1=vec2(sin(u_time*0.2),cos(u_time*0.3))*0.6+0.5;',
        '    vec2 lp2=u_pointer.x>=0.0?vec2(u_pointer.x,1.0-u_pointer.y)',
        '            :vec2(sin(u_time*-0.4+1.5),cos(u_time*0.25-0.5))*0.6+0.5;',
        '    float h=smoothstep(0.4,0.0,distance(lensUV,lp1))*0.10*u_specStrength',
        '           +smoothstep(0.5,0.0,distance(lensUV,lp2))*0.08*u_specStrength;',
        '    finalCol.rgb+=h;',
        '  }',

        // ③ 上下缘锐利亮线（相对 liquidGL 的增强项）：edge^3 沿整圈提亮，
        //    再按垂直位置加权 —— 上下缘最亮，左右缘收敛，出"玻璃厚度"的感觉
        '  float ny=abs(p_px.y/b_px.y);',
        '  float vw_=smoothstep(0.30,0.90,ny);',
        '  finalCol.rgb+=pow(edge,3.0)*u_rimStrength*(0.30+0.70*vw_);',

        '  finalCol*=u_reveal;',
        '  finalCol.rgb*=inShape; finalCol.a=inShape;',
        '  fragColor=finalCol;',
        '}',
    ].join('\n');

    function compile(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('glass: shader 编译失败', gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    function initGL() {
        if (gl) return true;
        canvas = document.getElementById(CVS_ID);
        if (!canvas) return false;
        gl = canvas.getContext('webgl2', {
            alpha: true,               // 必须：画布之外要透出桌面
            premultipliedAlpha: true,
            antialias: false,          // SDF 自己出平滑边缘，MSAA 纯浪费
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: 'low-power',
        });
        if (!gl) return false;
        var vs = compile(gl.VERTEX_SHADER, VS);
        var fs = compile(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) { gl = null; return false; }
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('glass: program 链接失败', gl.getProgramInfoLog(prog));
            gl = null;
            return false;
        }
        gl.useProgram(prog);
        ['u_tex', 'u_resolution', 'u_boxSize', 'u_textureResolution', 'u_subpixel', 'u_bounds',
            'u_refraction', 'u_aberration', 'u_bevelDepth', 'u_bevelWidth', 'u_frost', 'u_radius',
            'u_magnify', 'u_time', 'u_specStrength', 'u_rimStrength', 'u_reveal', 'u_tint',
            'u_specular', 'u_pointer'].forEach(function (n) {
                uni[n] = gl.getUniformLocation(prog, n);
            });
        // 全屏四边形（两个三角形）
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
            gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, 'a_position');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        // 纹理：线性过滤 + 边缘钳取（折射采样会探到窗口外，钳取比环绕正确）
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(uni.u_tex, 0);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // 预乘 Alpha，同 liquidGL
        /* ⚠ GPU 重置 / 驱动更新 / 显卡休眠唤醒之后，上下文会**静默失效**：
         *   不监听的话 `gl` 字段非空、`ready` 仍然是 true，但所有绘制都画不出
         *   东西 —— 落到用户眼里就是"玻璃突然变成一块空白，重启才好"。
         *   这里在第一次建上下文时装一次监听；`restored` 时把 gl 置空，下一次
         *   initGL() 会重新编译着色器、重建纹理（重建后需要重新喂一张背景，
         *   交给 onShow 那条正常路径）。 */
        if (!contextHooksInstalled) {
            contextHooksInstalled = true;
            canvas.addEventListener('webglcontextlost', function (e) {
                // preventDefault 才能让浏览器有机会发 restored
                e.preventDefault();
                console.warn('glass: WebGL 上下文丢失，等恢复');
                gl = null;
                prog = null;
                tex = null;
                uni = {};
                if (typeof onContextLost === 'function') {
                    try { onContextLost(); } catch (_) { }
                }
            }, false);
            canvas.addEventListener('webglcontextrestored', function () {
                console.warn('glass: WebGL 上下文已恢复，重建渲染器');
                // gl 已经在 lost 里置空，这里等下一次 draw/ensure 自己重建
                if (typeof onContextRestored === 'function') {
                    try { onContextRestored(); } catch (_) { }
                }
            }, false);
        }
        return true;
    }

    /* ---------------------------------------------------------------- */
    /* 尺寸 / 参数                                                        */
    /* ---------------------------------------------------------------- */

    function dpr() {
        return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    }

    /** 画布后备缓冲对齐横条的物理像素；返回是否有变化。 */
    function syncSize() {
        if (!canvas) return false;
        var w = Math.max(1, Math.round(canvas.clientWidth * dpr()));
        var h = Math.max(1, Math.round(canvas.clientHeight * dpr()));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            return true;
        }
        return false;
    }

    /** 画布在窗口里的子矩形（shader 的 u_bounds）：CSS 比 → 纹理比。
     *  canvas 还没建（onShow 之前 / WebGL2 不可用）时返回全零，别抛 ——
     *  debugInfo() 会被探针在任意时刻调，抛异常会把整段诊断带崩。 */
    function boundsOf() {
        if (!canvas) return [0, 0, 0, 0];
        var r = canvas.getBoundingClientRect();
        var vw = Math.max(1, window.innerWidth);
        var vh = Math.max(1, window.innerHeight);
        return [r.left / vw, r.top / vh, r.width / vw, r.height / vh];
    }

    function glassOn(c) {
        return !!c && c.barGlass !== false;
    }

    /** 明暗判定：复用横条自己的 qs-dark（WCAG 那套，applyThemePayload 挂的）。 */
    function isDark() {
        var st = document.getElementById('stage');
        return !!st && st.classList.contains('qs-dark');
    }

    function tintOf(c) {
        // 亮色下微微提亮（mix 到 >1 的乘数），暗色下压一层深蓝。
        // #133 质感重调（「不够透」）：亮色乘子上调到 1.06/1.07/1.11 且权重
        // 0.45→0.55 —— 原来那组太弱，玻璃本体看起来像蒙了一层塑料膜而不是
        // 透光的玻璃；暗色那边收敛一点（0.72→0.78），别把桌面压成一团黑。
        var a = Math.max(0, Math.min(100, Number(c && c.barGlassTint) || 0)) / 100;
        if (isDark()) return [0.78, 0.82, 0.97, a * 0.50];
        return [1.06, 1.07, 1.11, a * 0.55];
    }

    /* ---------------------------------------------------------------- */
    /* 纹理上传 / 绘制                                                    */
    /* ---------------------------------------------------------------- */

    function upload(bytes) {
        if (!gl || bytes.byteLength < 20) return false;
        var dv = new DataView(bytes);
        var x = dv.getInt32(0, true), y = dv.getInt32(4, true);
        var w = dv.getInt32(8, true), h = dv.getInt32(12, true);
        if (w <= 0 || h <= 0 || 16 + w * h * 4 > bytes.byteLength) {
            console.error('glass: 快照头不对劲', w, h, bytes.byteLength);
            return false;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array(bytes, 16, w * h * 4));
        texW = w;
        texH = h;
        stats.lastRect = w + 'x' + h + '@' + x + ',' + y;
        return true;
    }

    function draw(now) {
        if (!gl || !texW) return;
        /* r49：横条隐身（钉住面板）期间——把画布擦成全透明并跳过绘制。
         * gl.clear 是必要的：只"不画"的话，上一帧的玻璃会一直留在画布上。 */
        if (barGhost) {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            stats.ghostClears++;
            return;
        }
        syncSize();
        var c = conf || {};
        gl.uniform2f(uni.u_textureResolution, texW, texH);
        gl.uniform2f(uni.u_subpixel, 0, 0);
        gl.uniform1f(uni.u_refraction, (Number(c.barGlassRefraction) || 0) / 1000);
        gl.uniform1f(uni.u_aberration, (Number(c.barGlassAberration) || 0) / 100);
        // 倒角深度：和折射强度一样是 ‰（设置页两个滑块都标 ‰，量程 0..30）——
        // 曾经写成 /100，默认 12 被放大 10 倍成 0.12 UV（≈92px）：极缘处
        // 位移直接越过纹理边界被 oob 整段裁掉（边缘一条死区），而色差
        // chroma=offset*aberration 不吃那套裁剪，于是同一位置爆出 75px 的
        // 红蓝分离 —— 又假又脏。改回 ‰ 后默认 0.012 UV（≈9px），边缘是一条
        // 平滑衰减的厚玻璃折射。
        gl.uniform1f(uni.u_bevelDepth, (Number(c.barGlassBevel) || 0) / 1000);
        gl.uniform1f(uni.u_bevelWidth, BEVEL_W);           // 逐块再按矮边校正，见 bevelWidthFor
        gl.uniform1f(uni.u_frost, Number(c.barGlassFrost) || 0);
        gl.uniform1f(uni.u_magnify, 1.05);
        var spec = Math.max(0, (Number(c.barGlassSpec) === undefined ? 100 : c.barGlassSpec)) / 100;
        gl.uniform1f(uni.u_specStrength, spec);
        gl.uniform1f(uni.u_rimStrength, spec * 0.09);
        gl.uniform1f(uni.u_reveal, reveal);
        var t = tintOf(c);
        gl.uniform4f(uni.u_tint, t[0], t[1], t[2], t[3]);
        gl.uniform1i(uni.u_specular, spec > 0.01 ? 1 : 0);
        stats.draws++;

        /* 只画**横条胶囊**这一块。
         *
         * ⚠ 2026-10-16 r47（用户原话）：「通过更多引擎打开的页面就还是普通的
         *   页面，默认的页面不要液态玻璃了，就不管任何主题都不会更改」。
         *   需求 6 时这里会连面板一起画（"更多引擎页 / 收藏夹页也要玻璃"），
         *   现在**明确撤回**：面板照常吃自己的主题底板 = 普通页面。
         *   理由：面板里是密排正文（引擎列表、收藏夹条目），玻璃的折射让每行
         *   都在动、小字发虚；而且用户要求"不管什么主题都一个样"，
         *   玻璃恰恰是最随主题/壁纸变的那一层。
         *   画布仍铺满窗口（CSS 没动，老选择器/老探针照旧），面板区域画布是
         *   全透明 —— 面板自己那层实色底板把它盖得严严实实。 */
        var barEl = document.getElementById(BAR_ID);
        if (barEl) {
            var br = barEl.getBoundingClientRect();
            if (br.width >= 1 && br.height >= 1) {
                drawBox(barEl, br, c, now);
            }
        }
    }

    /** 画一块玻璃（横条 / 面板）。
     *
     *  ⚠ 为什么不用动 shader：`v_uv` 来自顶点属性（`(a_position+1.0)*0.5`），
     *    **不是** gl_FragCoord —— viewport 一变，v_uv 自动就是"这一块内部 0..1"，
     *    SDF、折射、边缘法线、放大全跟着这一块走。于是"多一块玻璃" = 改 uniform
     *    + 改 viewport + 再来一次 drawArrays。
     *  ⚠ 混合是预乘 Alpha（ONE, ONE_MINUS_SRC_ALPHA）：某块在自己形状之外输出
     *    alpha=0，**不会**擦掉上一块 —— 两块各画各的、互不干扰。
     *  ⚠ u_bounds 必须是"这一块在**窗口**里的子矩形"：纹理就是整个窗口矩形
     *    （Rust 按窗口矩形抓，见 layout_bar 里的 glass::store_rect_only）。 */
    function drawBox(el, r, c, now) {
        var d = dpr();
        var bx = Math.round(r.left * d);
        var by = Math.round(r.top * d);
        var bw = Math.max(1, Math.round(r.width * d));
        var bh = Math.max(1, Math.round(r.height * d));
        var vw = Math.max(1, window.innerWidth);
        var vh = Math.max(1, window.innerHeight);
        // ⚠ GL 的视口原点在**左下角**，屏幕坐标是左上角 —— 这里要翻一次 y。
        gl.viewport(bx, Math.max(0, canvas.height - by - bh), bw, bh);
        // u_resolution 与 u_boxSize 都给"这一块"的尺寸：shader 里
        // lensUV=(v_uv*u_resolution-u_subpixel)/u_boxSize，两者相等时 lensUV=v_uv
        // （块内归一化）—— 正是画布==块时的老样子，所以渲染结果与搬画布前一致。
        gl.uniform2f(uni.u_resolution, bw, bh);
        gl.uniform2f(uni.u_boxSize, bw, bh);
        gl.uniform4f(uni.u_bounds, r.left / vw, r.top / vh, r.width / vw, r.height / vh);
        gl.uniform1f(uni.u_radius, radiusOf(el, Number(c.itemRadius) || 0) * d);
        // 瓶口宽度：r47 起只画横条一块，直接用 BEVEL_W。
        // （r46 曾按矮边逐块校正，好让"横条 + 面板"两块观感一致；面板不再是
        //  玻璃之后，那个校正只剩一个分支，删掉。）
        gl.uniform1f(uni.u_bevelWidth, BEVEL_W);
        gl.uniform1f(uni.u_time, (now || performance.now()) / 1000);
        var p = pointerFor(r);
        gl.uniform2f(uni.u_pointer, p[0], p[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        stats.passes++;
    }

    /** 一块玻璃的圆角（CSS px）。读**计算值**而不是配置项：面板的 14px 来自 CSS、
     *  横条的来自「圆角」滑块（--qs-radius）—— 读计算值两边都对得上，
     *  也免得 CSS 改了这里忘了改。 */
    function radiusOf(el, fb) {
        try {
            var v = parseFloat(getComputedStyle(el).borderTopLeftRadius);
            return isFinite(v) ? v : fb;
        } catch (e) {
            return fb;
        }
    }

    /** 把公开的"横条归一化"指针位置换算成某一块内部（不压在这一块上就给 -1）。
     *
     *  `setPointer()` 的契约是**横条归一化**（老探针按这个调，别改），而光斑得
     *  落在鼠标真正压着的那块玻璃上 —— 所以经窗口 CSS 坐标中转一次。 */
    function pointerFor(r) {
        if (pointer[0] < 0 || pointer[1] < 0) return [-1, -1];
        var barEl = document.getElementById(BAR_ID);
        if (!barEl) return pointer.slice();
        var b = barEl.getBoundingClientRect();
        var cx = b.left + pointer[0] * b.width;      // 窗口 CSS 坐标
        var cy = b.top + pointer[1] * b.height;
        var nx = (cx - r.left) / Math.max(1, r.width);
        var ny = (cy - r.top) / Math.max(1, r.height);
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return [-1, -1];
        return [nx, ny];
    }

    /* ---------------------------------------------------------------- */
    /* 统一的 rAF 循环：一帧里同时做「重绘」和「抓屏」（r86 合并）            */
    /*                                                                  */
    /* # 为什么要合并（r84 的 182 次/秒就是这么来的）                        */
    /*                                                                  */
    /* r84 时 `raf`（重绘）与 `liveRaf`（抓屏）是**两条独立的 rAF 循环**，   */
    /* 各自按刷新率跑 → 探针数出 180+ 次/秒的调用。两条链做的是同一件事    */
    /* 的两个阶段（先抓背景、再拿新纹理重绘），分开跑等于互相催、谁也不知   */
    /* 道对方的状态。                                                      */
    /*                                                                  */
    /* 现在合成一条：每帧按顺序做「该抓就抓 → 该画就画」，一个 `busy` 状态   */
    /* 管住整条链。好处是三件：                                            */
    /*   · 调用次数从 180+/秒 降到刷新率本身（60/120/144）；                 */
    /*   · 抓屏频率可以独立调到"跟显示器"而不影响重绘次数；                  */
    /*   · 抓屏与重绘的先后关系确定了（抓到新纹理的那一帧就画出来），        */
    /*     不会再出现"纹理换了但这一帧没画"的错拍。                          */
    /*                                                                  */
    /* ⚠ 停止条件仍是"画面还会不会变"：静止的横条（不在淡入、鼠标不在上面、  */
    /*   没开实时模式）时循环**必须停**，否则就是白烧 CPU。这条是 r84 修     */
    /*   那个 27% 的关键，不能丢。                                          */
    /* ---------------------------------------------------------------- */

    function frame(now) {
        raf = 0;
        if (!shown) return;                       // 收起后链条到此为止

        // 淡入动画：约 180ms
        if (reveal < 1) {
            reveal = Math.min(1, (now - revealT0) / 180);
        }

        var liveOn = !!(conf && conf.barGlassLive) && glassOn(conf) && !!gl;
        /* 这一帧要不要继续跑下去？
         *   · 淡入中 → 要（那 180ms 是用户唯一盯着的动画）
         *   · 鼠标在条上 → 要（光斑跟着动）
         *   · 开了实时模式 → 要（背景要跟桌面走）
         *  三者都不成立就停 —— 这是静止横条的零开销档。 */
        var keepGoing = reveal < 1 || pointer[0] >= 0 || liveOn;

        /* ---- 阶段①：该抓屏就抓（按用户设的帧率上限节流）---- */
        if (liveOn && !captureBusy && !liveTooSoon(now)) {
            lastLiveAt = now;
            if (excluded) {
                captureOnce(false);               // 主路：横条对抓屏隐身，直抓
            } else if ((++liveThrottle & 3) === 0) {
                captureOnce(true);                // 兜底（旧系统）：每 4 帧隐藏抓一次
            }
        }

        /* ---- 阶段②：重绘 ----
         * ⚠ 决定"要不要真的画"：
         *   · 淡入中 → 画（每帧都要，否则动画顿）；
         *   · 鼠标在条上 → 画；
         *   · 实时模式 → **只有抓到新纹理时才画**（`dirty`）。
         *     抓屏是异步的，多数帧并没有新纹理；每帧都画一遍相同的纹理
         *     就是 r84 里那 26% CPU 的来源。 */
        var want = reveal < 1 || pointer[0] >= 0 || (liveOn && dirty);
        if (want) {
            draw(now);
            dirty = false;
        }

        if (keepGoing) raf = requestAnimationFrame(frame);
    }

    function kick() {
        /* 唤醒统一循环。`dirty` 表示"有内容变了、下一帧必须画一次"——
         * 它只在有真实变化时被置上（新纹理落地、主题切换、面板尺寸变了…），
         * 所以静止时循环根本不会因为 kick 而常驻。 */
        dirty = true;
        if (!raf && shown) {
            // ⚠ revealT0 只在淡入还没走完时才重置：曾经无条件置现值，
            // 而 frame() 里 reveal = min(1, (now-revealT0)/180) —— 已淡入完成
            // （reveal=1）时再 kick 会把 reveal 打回 ~0，整条横条无端端
            // 闪一下暗再淡入回来。拖动面板后的 refresh、实时模式的每次
            // 抓取完成都会 kick，这个闪在旧版里是高频出现的。
            if (reveal < 1) revealT0 = performance.now();
            raf = requestAnimationFrame(frame);
        }
    }

    /* ---------------------------------------------------------------- */
    /* 实时抓屏：起停 + 单次抓取                                            */
    /* ---------------------------------------------------------------- */

    /** 起实时循环（只在「配置要实时 + 横条在屏上」时被调）。
     *
     *  ⚠ r86 起抓屏和重绘共用同一个 `frame()` 循环，所以这里不再自己起一条
     *  rAF，只需要"把循环叫起来"（kick 会置 dirty 并排帧）。
     *  `liveRaf` 字段保留为 **0**：旧代码/旧探针会读它判断"实时在不在跑"，
     *  现在那个语义改由 `frame()` 里的 `liveOn` 决定，字段恒为 0 表示
     *  "没有独立的抓屏循环"——这正是 r86 之后的事实。 */
    function startLiveLoop() {
        liveRaf = 0;
        kick();
    }

    /** 旧的独立抓屏 tick —— r86 已并入 `frame()`。
     *
     *  ⚠ **不留死代码**：直接删掉它，下面 `captureOnce` 里那段"在途去重"
     *  的说明仍然有效（去重逻辑本身没变）。 */

    /** 抓一次屏并上传。`hideStage` = 先把舞台整体隐藏（ BitBlt 抓的是合成后
     *  屏幕，舞台要真的消失一帧才抓得到纯桌面）。
     *
     *  · 在途去重（captureBusy）：实时循环每帧都会问一次，不加去重的话
     *    兜底路径的「隐藏 → 等两帧 → 抓」会被下一轮刷新叠加，横条一藏
     *    就是好几帧 —— 旧版 setInterval(100) 不等上一轮抓完就再发一轮，
     *    隐藏时间层层叠加，肉眼就是持续频闪；
     *  · 上传后只 kick 不重置 reveal：淡入是「横条弹出」那一下的仪式感，
     *    实时模式下每次抓取都重放一遍就是亮度脉动。 */
    function captureOnce(hideStage) {
        if (captureBusy) return null;
        captureBusy = true;
        /* ⚠ 给这一次抓屏打一个"代次"，并记住**是谁把 stage 藏起来的**。
         *
         * 两个必须同时成立的目标（我第一版只做了前者，把后者做坏了）：
         *
         *  ① 上一轮迟到的回调不能把**新一轮刚藏好的** stage 提前显示出来
         *     —— 那会让新一轮抓到"自己还没隐藏"的那一帧（文件里 528~533 行
         *     描述的「纹理自拍」）。
         *  ② 但如果**没有**新一轮（只被 stopLive 打断），迟到的回调仍必须
         *     把 stage 恢复可见 —— 否则舞台**永久隐藏**，横条整个消失。
         *
         * 判据用 `stageHideOwner`（藏 stage 那一代的代次）而不是"当前代次"：
         *   · A 藏（owner=A），stopLive 增代但 owner 不变 → A 回来时 owner 仍是 A
         *     → **恢复**（目标 ②）；
         *   · A 藏（owner=A），B 又藏（owner=B）→ A 回来时 owner 已是 B
         *     → **不恢复**（目标 ①，交给 B 自己收尾）。
         */
        captureBusyGen += 1;
        var myGen = captureBusyGen;
        var stage = null;
        if (hideStage) {
            stage = document.getElementById('stage');
            if (stage) {
                stage.style.visibility = 'hidden';
                stageHideOwner = myGen;      // 这一代负责把它恢复回来
            }
        }
        // 为什么必须等帧：BitBlt 抓的是**合成后的屏幕**。stage 置 hidden
        // 只是改 DOM，WebView2 要到本帧合成才把"全透明"呈现给 DWM；
        // 不等这一帧就抓，抓到的就是横条自己的上一帧玻璃渲染（旧纹理
        // 自拍）。实测坏状态整条横条变暗、全宽剖面残留 ~80px 周期正弦纹
        // （A2 阶段测试背景）、玻璃内亮度 56.3 vs 干净 129.8，约 3:1 概率
        // 抖 —— 抓比显示快一步，根因就在这。
        var chain = hideStage ? window.QSGlass.afterFrames(2).then(function () {
            return invoke('glass_capture');
        }) : invoke('glass_capture');
        // 返回整条链：调用方（refresh / 探针）能 await「这一次抓取真的落完」。
        return chain.then(function (r) {
            if (stage && stageHideOwner === myGen) {
                stage.style.visibility = '';
                stageHideOwner = 0;
            }
            if (r instanceof ArrayBuffer && upload(r)) {
                stats.captures++;
                kick();
            }
        }).catch(function (e) {
            if (stage && stageHideOwner === myGen) {
                stage.style.visibility = '';
                stageHideOwner = 0;
            }
            console.error('glass: 抓屏失败', e);
        }).then(function () {
            // 只有最新一代才有资格清"在途"标志（旧代清掉会让新一轮的
            // 去重失效，出现两路抓屏叠着跑）
            if (myGen === captureBusyGen) captureBusy = false;
        });
    }

    /* ---------------------------------------------------------------- */
    /* 对外 API                                                           */
    /* ---------------------------------------------------------------- */

    window.QSGlass = {
        /** WebGL2 上下文是否就绪（false → 调用方保持 CSS 磨砂那条路） */
        ready: false,

        /** 打开/刷新配置；返回是否该进入玻璃模式。
         *  ⚠ 空载荷不接：主题事件可能比配置广播先到，拿 null 覆盖 conf 会
         *    把已经开着的玻璃当场关掉。
         *  ⚠ merge 而非整体替换：探针会传部分配置（只改折射等），整体替换
         *    会把 itemRadius 等未传字段抹掉 → u_radius=0 → 圆角变方角。 */
        applyConf: function (c) {
            if (c) conf = Object.assign({}, conf || {}, c);
            var on = glassOn(conf);
            /* 抓屏帧率上限跟着配置走（r86）。
             * 用户在设置里把上限从"跟随显示器"改成 30/60/120，要**立刻**生效，
             * 不能等到下次重开横条。`setLiveFps(0)` = 不限速。 */
            setLiveFps(conf && conf.barGlassFps);
            var bar = document.getElementById(BAR_ID);
            if (bar) bar.classList.toggle('qs-glass', on && this.ready);
            // ⚠ 类也要挂到 stage 上：画布 2026-10-16 搬到了 stage（需求 6，
            //   面板也得是玻璃），CSS 选择器写的是 `.stage.qs-glass > ...`。
            //   `.bar` 上那一份留着，老探针/老选择器不用改。
            var st = document.getElementById('stage');
            if (st) st.classList.toggle('qs-glass', on && this.ready);
            // 实时模式的起停跟着配置走（配置可能在横条开着时被改）
            if (on && this.ready && conf.barGlassLive === true) this.startLive();
            else this.stopLive();
            return on && this.ready;
        },

        /** 重画一帧（主题切换后染色要跟着变，由外部 kick） */
        kick: function () { kick(); },

        /** 横条弹出：建上下文（首次）/ 请求一次 take。 */
        onShow: function () {
            shown = true;
            if (!glassOn(conf)) return;
            if (!this.ready && !initGL()) return;   // WebGL2 不可用 → 保持磨砂那条路
            this.ready = true;
            this.applyConf(conf);                   // 上下文就绪后才该挂 qs-glass
            syncSize();
            kick();
        },

        /** Rust 说背景抓好了（qs://glass）：取字节 → 上传 → 画。 */
        onFresh: function () {
            if (!shown || !glassOn(conf) || !this.ready) return;
            invoke('glass_take').then(function (r) {
                if (!(r instanceof ArrayBuffer) || !upload(r)) return;
                stats.takes++;
                reveal = 0;
                kick();
            }).catch(function (e) { console.error('glass: glass_take 失败', e); });
        },

        /** 横条收起：停渲染循环与实时抓屏，解除抓屏隐身。
         *  Rust 侧 dismiss_bar 也会兜底解除，双保险。 */
        onHidden: function () {
            shown = false;
            pointer = [-1, -1];
            this.stopLive();
        },

        /** 指针位置（横条内归一化，左上原点）。离开传 null。 */
        setPointer: function (x, y) {
            pointer = (x === null || x === undefined) ? [-1, -1] : [x, y];
            if (shown && conf && conf.barGlassLive !== true) kick();   // 实时模式常驻循环
        },

        /** r49：横条隐身（钉住收藏面板时挂 .bar.ghost）。
         *
         *  开 = 立刻清掉画布上那层玻璃并停止实时抓屏；关 = 恢复（该抓屏就抓屏）。
         *  ⚠ 必须在挂/摘 `.ghost` 的**同一处**调用 —— 只改 class 就会留下
         *   「图标没了、横条还在」的空壳（用户报的 bug）。 */
        setBarGhost: function (on) {
            barGhost = !!on;
            if (barGhost) {
                this.stopLive();                 // 隐身期间不必再抓屏
                if (this.ready) kick();          // 出一帧，把画布擦干净
            } else if (shown && this.ready) {
                if (conf && conf.barGlassLive === true) this.startLive();
                kick();
            }
        },

        /** 横条当前是不是隐身状态（探针用） */
        isBarGhost: function () { return barGhost; },

        /** 等 n 个 rAF 帧合成上屏（rAF 跑在合成前，套 n 层覆盖 n 帧）。 */
        afterFrames: function (n) {
            return new Promise(function (res) {
                function step() { if (--n <= 0) res(); else requestAnimationFrame(step); }
                requestAnimationFrame(step);
            });
        },

        /** 抓屏隐身的串行变更队列。
         *
         * 为什么要排队：开关实时模式时 startLive/stopLive 可能连着来
         * （设置页连点、qs://config 广播与用户操作交错），两路
         * glass_exclude 的 invoke 若乱序落地，会留下「前端以为已隐身、
         * Rust 侧其实没有」的空档 —— 那时直抓到的就是横条自己的上一帧
         * 玻璃渲染（纹理自拍：正弦纹残留、亮度差 3 倍）。串成一条链，
         * `excluded` 永远等于 Rust 侧最后一次完成的状态。 */
        exclSet: function (on) {
            exclChain = exclChain.then(function () {
                return invoke('glass_exclude', { on: on }).then(function (ok) {
                    excluded = !!ok;
                }, function (e) {
                    console.error('glass: glass_exclude(' + on + ') 失败', e);
                    excluded = false;
                });
            });
            return exclChain;
        },

        /** 重抓背景（一次性的：拖动面板结束、主题切换后）。
         *  返回 Promise（探针 await 它）。已隐身时无需隐藏舞台；
         *  否则走「隐藏 → 等两帧 → 抓 → 恢复」。
         *  ⚠ captureOnce 在上一次抓屏还在途时返回 null（去重）——
         *    这时也要给回一个 resolve 掉的 Promise，调用方的 .then 链
         *    不能炸（round28 A4 就在这里踩过：refresh() 返回 undefined）。 */
        refresh: function () {
            if (!shown || !glassOn(conf) || !this.ready) return Promise.resolve();
            if (excluded) {
                captureOnce(false);
                return Promise.resolve();
            }
            return captureOnce(true) || Promise.resolve();
        },

        /** 实时模式：跟着系统帧率跑，每帧能抓就抓（有在途抓屏则跳过本帧）。
         *  · 主路（横条已对抓屏隐身）：直抓 BitBlt，不隐藏舞台 —— 零闪烁；
         *  · 兜底（旧系统没有 WDA_EXCLUDEFROMCAPTURE）：隐藏抓取，每 4 帧
         *    一次，把「横条不可见」的时间占比压到约 1/6。 */
        startLive: function () {
            if (liveStarting) return;
            liveStarting = true;
            this.exclSet(true).then(function () {
                liveStarting = false;
                if (shown && glassOn(conf) && conf.barGlassLive === true) startLiveLoop();
            });
        },
        stopLive: function () {
            /* r86：抓屏已并入统一的 `frame()` 循环，这里**不再有独立的 rAF
             * 要取消**。`frame()` 自己会在 `liveOn` 为 false 时停止抓屏、
             * 并在"画面不会再变"时退出循环 —— 那才是停的正主。
             * 这里只做两件事：清"在途"占位、解除抓屏隐身。 */
            liveStarting = false;
            /* 只放开"在途占位"，**不碰代次、不碰 stageHideOwner**。
             *
             * 放开的理由：循环停了，新的抓屏应当能立刻开始。
             * 不碰代次的理由：在途那次抓屏的 `.then` 还要靠 `stageHideOwner`
             * 判断"stage 是不是我藏的还是别人（新一轮）藏的" —— 我在 stopLive
             * 里自增代次的话，它会被判成"别人藏的"而**不去恢复 visibility**，
             * 舞台就永久隐藏、横条整个消失（这是我自己第一版引入的漏洞）。
             * 现在把所有权交给 `stageHideOwner`，两种情形都对：
             *   · 没有新一轮 → 它恢复（横条正常）；
             *   · 有新一轮 → 新一轮自己收尾（避免纹理自拍）。 */
            captureBusy = false;
            this.exclSet(false);
        },

        /** 注册 WebGL 上下文丢失/恢复的回调（可选）。
         *
         *  为什么会需要：GPU 重置之后上下文作废，玻璃层自己只能把 gl 置空、
         *  等下一次 initGL 重建；但"下一次"要有人触发 —— bar.js 在这里
         *  重新走一次 show 流程（重新抓背景 + 重新上传纹理）最省事。 */
        onContextEvents: function (lost, restored) {
            onContextLost = lost || null;
            onContextRestored = restored || null;
        },

        /** 探针 / 调试用 */
        debugInfo: function () {
            return {
                ready: this.ready, on: glassOn(conf), shown: shown,
                texW: texW, texH: texH, bounds: boundsOf(),
                params: {
                    refraction: conf && conf.barGlassRefraction,
                    aberration: conf && conf.barGlassAberration,
                    bevel: conf && conf.barGlassBevel,
                    frost: conf && conf.barGlassFrost,
                    spec: conf && conf.barGlassSpec,
                    tint: conf && conf.barGlassTint,
                    live: conf && conf.barGlassLive,
                    radius: conf && conf.itemRadius,
                },
                live: {
                    /* ⚠ `loop` 字段的语义在 r86 变了：抓屏已并入统一的
                     *   `frame()` 循环，**没有独立的抓屏 rAF 了**，所以这里
                     *   报的是"重绘循环在不在跑"（`raf !== 0`）。
                     *   旧探针按 `loop` 判断"实时模式在不在工作"会误读 ——
                     *   现在要判断实时是否生效请看 `liveOn` 与 `fps`。 */
                    loop: !!raf, starting: liveStarting, excluded: excluded,
                    busy: captureBusy,
                    /* r86 新增：实时抓屏的当前状态，供探针验证"跟手" */
                    liveOn: !!(conf && conf.barGlassLive) && glassOn(conf) && !!gl,
                    fps: conf && conf.barGlassFps,          // 0 = 跟随显示器
                    intervalMs: liveIntervalMs,             // 0 = 不限速
                    dirty: dirty,
                },
                stats: stats,
                pointer: pointer.slice(),
            };
        },
    };

    /* 指针追踪：横条上移动才更新。
     * 用 pointermove 而不是 mousemove：触屏/笔也能驱动光斑。
     * ⚠ 需求 6 起面板也是一块玻璃，所以面板上的移动也要喂进来 —— 但
     *   `setPointer()` 的公开契约是**横条归一化**（老探针按这个调，不改），
     *   所以这里把面板内的位置换算成横条坐标再传（drawBox 那边再换回去）。 */
    document.addEventListener('DOMContentLoaded', function () {
        var bar = document.getElementById(BAR_ID);
        if (!bar) return;
        bar.addEventListener('pointermove', function (e) {
            var r = bar.getBoundingClientRect();
            window.QSGlass.setPointer(
                (e.clientX - r.left) / Math.max(1, r.width),
                (e.clientY - r.top) / Math.max(1, r.height));
        });
        bar.addEventListener('pointerleave', function () {
            window.QSGlass.setPointer(null);
        });
        // ⚠ r47：面板**不再**接管指针 —— 它是普通页面，不是玻璃。以前在面板上
        //   滑动会去改横条玻璃的高光位置（两块被当成"一套玻璃"），现在面板里
        //   密排正文上划过时横条乱闪，纯属干扰。
    });
})();
