/* ============================================================================
 *  设置面板 / 横条 —— 无头 DOM 集成测试
 *
 *  为什么要这一层：Tauri 的 WebView2 里 JS 报错默认看不见，而设置面板的绑定
 *  是"一条链"—— 任何一处 `$('typo')` 拿到 null 后取属性就会抛异常，把整段
 *  初始化打断，现象是"面板一片空白 / 点了没反应"，很难查。
 *  （之前 s-ocrEnable 漏在 HTML 里就是这么炸的。）
 *
 *  所以这里用 jsdom 把**真实的** ui/settings.html、ui/index.html 连同一整套
 *  真实脚本跑起来，只把 __TAURI__ 和 fetch 换成桩，然后断言：
 *    · 该渲染出来的元素真的渲染了；
 *    · 点下去真的调用了正确的后端命令、参数也对；
 *    · 拖拽换位的下标换算正确（这是最容易差一位的地方）。
 *
 *  全程无头，不注入任何键盘鼠标，不动真实桌面。
 *
 *  用法：node test-ui.js
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const BUILTIN_CATALOG = () => JSON.parse(read('ui/data/engines.json'));

/* #143 图标编辑器：makeEnv 之前设好这两份，桩按它们回话。
 *   ICON_SESSION —— icon_edit_load 的返回值（null = 会话过期）；
 *   ICON_REMOVE  —— icon_remove_bg 的返回值。 */
let ICON_SESSION = null;
let ICON_REMOVE = { src: 'data:image/png;base64,T1VU', removed: 1234 };

/* 本地 OCR 环境检测：OCR_DEP_ALL 是三项依赖的底稿，OCR_DEP_MISS 里放「要当成
 * 缺失」的 id —— 桩按这份回 ocr_env_check。默认空 = 全就绪。 */
const OCR_DEP_ALL = [
    { id: 'winrt', name: 'Windows 内置 OCR 引擎',
      purpose: '本地识别的核心：调用系统内置的 OCR 引擎，离线完成文字识别',
      detail: '系统已内置（Windows 10 版本 1809 及以上）',
      fix: '升级到 Windows 10 版本 1809 或更高版本，或改用百度云引擎。' },
    { id: 'lang', name: 'OCR 语言包（文字识别）',
      purpose: '决定能识别哪些语言：装了中文简体包才能认中文',
      detail: '已安装中文（简体）文字识别包',
      fix: '在语言设置里添加「中文（简体）」并勾选「文字识别」，或点下方「一键安装」直达设置页。' },
    { id: 'profile', name: 'Windows 显示语言匹配',
      purpose: '引擎按显示语言自动挑选已安装的语言包',
      detail: '当前显示语言可以正常试建引擎',
      fix: '把 Windows 显示语言改成已装 OCR 语言包的语言，或点「一键安装」补装对应语言包。' },
];
let OCR_DEP_MISS = [];
const ocrDepWithMissing = () => OCR_DEP_ALL.map((x) => ({ ...x, ok: !OCR_DEP_MISS.includes(x.id) }));

/* ------------------------------ 通用环境 ------------------------------ */

function makeEnv(htmlFile, conf, opts) {
    const calls = [];
    const listeners = new Map();
    // 想让某条命令"失败"就把它加进来 —— 用来验证出错时前端会不会自己退场
    const rejectCmds = new Set();
    let CONF = conf;
    /* `update_pending` 的桩（v1.5.7）：模拟"启动时那次自动检查把结果存下来了"。
     * 测两种情况：has=false（常态）/ has=true + canAuto=false（查到了但没令牌）。 */
    let PENDING = { has: false };
    const setPending = (p) => { PENDING = p; };
    /* `verify_github_token` 的桩（v1.5.8）。形状对齐 Rust 的 TokenCheck；
     * `VERIFY_FAIL` 非空时改成 reject，用来测"验证失败要说清原因"。 */
    let VERIFY_OK = {
        login: 'QQQOrange', name: '橙子', limit: 5000, remaining: 4998,
        kind: '细粒度令牌',
    };
    let VERIFY_FAIL = '';
    const setVerify = (ok, fail) => {
        if (ok !== undefined) VERIFY_OK = ok;
        VERIFY_FAIL = fail || '';
    };
    /* `backup_security_state` 的桩（v1.5.9）：备份到底能不能换机恢复。
     * 默认给"没设备份密码"（DPAPI）—— 那正是最容易让用户误判的状态，
     * 因为界面上它长得就像"我没加密，应该到处都能读"。 */
    let SEC_STATE = {
        hasPassword: false, envelope: 'dpapi', portable: false,
        hasToken: false, secretCount: 0,
    };
    const setSecState = (s) => { SEC_STATE = s; };
    /* `github_rate_state` 的桩（v1.5.10）：令牌框下面那行「已用 X 次 / 共 Y 次」。
     * 默认给一份"匿名 60 次"的快照 —— 那是没填令牌时的真实状态。 */
    let RATE_STATE = {
        ok: true, authed: false, limit: 60, remaining: 60, used: 0, reset: 0,
    };
    const setRateState = (s) => { RATE_STATE = s; };
    /* `import_with_password` 的桩（v1.5.10）。非空时改成 reject，
     * 用来测"密码错了要留在框里让人重输"。 */
    let IMPORT_FAIL = '';
    const setImportFail = (msg) => { IMPORT_FAIL = msg || ''; };
    /* `startup_password_disable` 的桩（v1.5.14）：设置页关闭启动密码前要先验
     * 当前密码。默认认 testSettings 里刚设的 `alpha-111`；需要换口令时调
     * setStartupPwd()。 */
    let STARTUP_PWD = 'alpha-111';
    const setStartupPwd = (v) => { STARTUP_PWD = v; };

    /* v1.5.16：翻译四件套的桩。
     *  · TRANS_SESSION —— 「这次要翻什么、默认翻成什么、哪几家一起翻」，
     *    模拟横条带过来的一段文字；`plan` 是 Rust 侧 config::trans_plan 的
     *    输出形状（前端不自己拼名单，详见 trans.html 的注释）；
     *  · TRANS_LANGS   —— 对齐 Rust trans::LANGS 的头几项（语言表只有 Rust 一份）；
     *  · TRANS_RUN     —— 真翻一次的返回值；FAIL 非空时改 reject，
     *    用来测「限流 / 没填 Key」这类错误在界面上的落点；
     *  · TRANS_ENGS    —— trans_engines_list 的输出（注册表静态信息：
     *    预置 base/model、要填哪几样）。 */
    const DEF_PLAN = [
        { id: 'siliconflow', name: '硅基流动', ready: true },
        { id: 'deepseek', name: 'DeepSeek', ready: true },
    ];
    let TRANS_SESSION = { text: 'Hello there', target: 'en', plan: DEF_PLAN.slice() };
    let TRANS_LANGS = [
        { code: 'zh', label: '简体中文' },
        { code: 'zh-TW', label: '繁體中文' },
        { code: 'en', label: 'English' },
        { code: 'ja', label: '日本語' },
    ];
    let TRANS_RUN_OK = '你好啊';
    let TRANS_RUN_FAIL = '';
    /* 按引擎给不同结果（多引擎时一家成功一家失败才是真实场面）：
     * key = 引擎 id → { ok: 译文, fail: 错误 }；没登记的走上面那两个默认值。 */
    let TRANS_RUN_BY = {};
    /* v1.5.18 流式：`trans_run` 挂起不返回，测试自己往里塞 qs://trans-chunk
     * 增量、再手工放行 —— 不这样做就测不到"流式过程中界面怎么长"，
     * 因为桩会立刻 resolve，pane 一秒就变成"已完成"了。 */
    let TRANS_RUN_DEFER = false;
    let TRANS_RUN_PENDING = [];
    let TRANS_ENGS = [
        {
            id: 'baidu', name: '百度翻译', kind: 'baidu',
            canListModels: false, modelRow: false,
            signup: 'https://fanyi-api.baidu.com/products/api',
            docs: 'https://fanyi-api.baidu.com/doc/21',
            needKey: true, needSecret: true, needBase: false, needModel: false,
            base: 'https://fanyi-api.baidu.com/api/trans/vip/translate', model: '',
            note: '老牌通用翻译 API：要「APP ID」+「密钥」两样', ready: false,
        },
        {
            id: 'google', name: '谷歌翻译', kind: 'google',
            canListModels: false, modelRow: false,
            signup: 'https://console.cloud.google.com/apis/credentials',
            docs: 'https://cloud.google.com/translate/docs/reference/rest/v2/translate',
            needKey: true, needSecret: false, needBase: false, needModel: false,
            base: 'https://translation.googleapis.com/language/translate/v2', model: '',
            note: 'Google Cloud Translation v2：只要一个 API Key', ready: false,
        },
        {
            id: 'youdao', name: '有道翻译', kind: 'youdao',
            canListModels: false, modelRow: false,
            signup: 'https://ai.youdao.com/console/',
            docs: 'https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html',
            needKey: true, needSecret: true, needBase: false, needModel: false,
            base: 'https://openapi.youdao.com/api', model: '',
            note: '有道智云文本翻译：要「应用 ID」+「应用密钥」两样', ready: false,
        },
        {
            id: 'siliconflow', name: '硅基流动', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://cloud.siliconflow.cn/account/ak',
            docs: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
            needKey: true, needBase: false, needModel: false,
            base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct',
            note: '国内直连、聚合了很多开源模型，小模型有免费额度', ready: true,
        },
        {
            id: 'zhipu', name: '智谱 GLM', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
            docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
            needKey: true, needBase: false, needModel: false,
            base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
            note: 'glm-4-flash 是免费档', ready: true,
        },
        {
            id: 'dashscope', name: '通义千问', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
            docs: 'https://help.aliyun.com/zh/model-studio/qwen-api',
            needKey: true, needBase: false, needModel: false,
            base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash',
            note: '新用户有免费额度', ready: true,
        },
        {
            id: 'deepseek', name: 'DeepSeek', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://platform.deepseek.com/api_keys',
            docs: 'https://api-docs.deepseek.com/zh-cn/',
            needKey: true, needBase: false, needModel: false,
            base: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
            note: '翻译质量好、便宜；兼容 OpenAI 接口', ready: true,
        },
        {
            id: 'moonshot', name: 'Kimi', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://platform.kimi.com/console/api-keys',
            docs: 'https://platform.kimi.com/docs/api/chat',
            needKey: true, needBase: false, needModel: false,
            base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
            note: '月之暗面 Kimi', ready: true,
        },
        {
            id: 'ark', name: '火山方舟', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
            docs: 'https://docs.volcengine.com/docs/ark/api-key',
            needKey: true, needBase: false, needModel: true,
            base: 'https://ark.cn-beijing.volces.com/api/v3', model: '',
            note: '要填「推理接入点 ID」（ep- 开头）或模型名', ready: false,
        },
        {
            id: 'openai', name: 'OpenAI', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://platform.openai.com/api-keys',
            docs: 'https://platform.openai.com/docs/api-reference/chat',
            needKey: true, needBase: false, needModel: false,
            base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
            note: '国内网络需要能直连 api.openai.com', ready: true,
        },
        {
            id: 'custom', name: '自定义（OpenAI 兼容）', kind: 'openai',
            canListModels: true, modelRow: true,
            signup: 'https://platform.openai.com/docs/api-reference/chat',
            docs: 'https://platform.openai.com/docs/api-reference/chat/create',
            needKey: true, needBase: true, needModel: true,
            base: '', model: '',
            note: '任何 OpenAI 兼容的接口都行', ready: false,
        },
    ];
    const setTransSession = (s) => {
        TRANS_SESSION = Object.assign({}, s);
        if (!Array.isArray(TRANS_SESSION.plan) || !TRANS_SESSION.plan.length) {
            TRANS_SESSION.plan = DEF_PLAN.slice();
        }
    };
    const setTransRun = (ok, fail) => { TRANS_RUN_OK = ok; TRANS_RUN_FAIL = fail || ''; };
    /** 只改某一家引擎这一次的返回（另一家照旧）—— 测"一家挂、一家好"。 */
    const setTransRunFor = (engine, ok, fail) => {
        TRANS_RUN_BY[engine] = { ok: ok, fail: fail || '' };
    };
    const setTransPlan = (list) => { TRANS_SESSION.plan = list; };

    /* ⚠ 桩必须装进 beforeParse：region.html 这类页面把脚本**内联**写在 HTML 里，
     * jsdom 会在构造函数的那一刻就执行它，等我们再拿到 dom.window 才补 __TAURI__
     * 已经晚了 —— 表现为「事件一个都没绑上，断言全是空」。 */
    const installStubs = (w) => {
    // jsdom 的 matchMedia 返回的对象很简陋，统一给个不会炸的桩
    w.matchMedia = () => ({
        matches: false, media: '',
        addListener() { }, removeListener() { },
        addEventListener() { }, removeEventListener() { },
    });

    // 后端桩：记下每次调用，再按命令返回合理的值。
    // 自定义引擎那几条会**模拟 Rust 侧的校验**，好让前端「显示中文报错」那条路
    // 也能被测到 —— 不然那段代码只有真机上手动触发才会执行。
    w.__TAURI__ = {
        core: {
            invoke: (cmd, args) => {
                calls.push({ cmd, args: args || {} });
                if (rejectCmds.has(cmd)) return Promise.reject('模拟后端失败：' + cmd);
                if (cmd === 'get_config') return Promise.resolve(CONF);
                /* v1.5.14：「关闭启动密码」要先验当前密码（用户要求「要取消密码，
                 * 必须要再输一次解锁密码」）—— 桩按 STARTUP_PWD 判定，和真后端
                 * 一样"验不过就什么都不改"。 */
                if (cmd === 'startup_password_disable') {
                    return Promise.resolve((args && args.password) === STARTUP_PWD);
                }
                // backup_info：settings.js **在脚本加载时**就会调一次
                // （refreshBackupInfo 的顶层调用），不桩的话它拿到的是
                // 上面那条 `return null` 的兜底值，取 .dir 直接 TypeError。
                if (cmd === 'backup_info') {
                    return Promise.resolve({
                        dir: 'C:\\Users\\tester\\AppData\\Roaming\\QuickSearch',
                        isCustom: false,
                        configPath: 'C:\\Users\\tester\\AppData\\Roaming\\QuickSearch\\config.json',
                        files: [],
                    });
                }
                /* export_groups_list（v1.5.10）：导出勾选表的来源。
                 * 只给三组，够验"隐私项 → 强制加密"这条规则：
                 * apiKeys / secrets 是隐私，engineConfig 不是。 */
                if (cmd === 'export_groups_list') {
                    return Promise.resolve([
                        { id: 'apiKeys', name: 'API Key / 凭据', desc: '识别引擎的 Key', private: true, checked: false },
                        { id: 'secrets', name: '个人访问令牌', desc: 'GitHub PAT', private: true, checked: false },
                        { id: 'engineConfig', name: '引擎配置', desc: '横条摆哪些引擎', private: false, checked: true },
                    ]);
                }
                // cleanup_data：扫描/执行共用一条命令，用 apply 区分。
                // 返回一份"有东西可清"的清单，好让前端渲染逻辑真的被走到。
                if (cmd === 'cleanup_data') {
                    const doApply = !!(args && args.apply);
                    const rep = {
                        applied: doApply, count: 3, bytes: 4096,
                        groups: [
                            { kind: 'dup-backup', label: '2 份「内容重复」的旧备份',
                              why: '解密后剔掉界面状态字段，内容与更新的那一份完全一样。',
                              count: 2, bytes: 3072, files: ['config(a).QuickSearch', 'config(b).QuickSearch'] },
                            { kind: 'orphan-icon', label: '1 个没人用的自定义图标',
                              why: 'icons 目录里还在，但配置里已经没有引擎引用它了。',
                              count: 1, bytes: 1024, files: ['旧图标.png'] },
                        ],
                        skipped: ['1 份备份解不开（可能是换了备份密码的老文件）'],
                    };
                    if (doApply) { rep.deleted = 3; rep.freed = 4096; }
                    return Promise.resolve(rep);
                }
                if (cmd === 'add_custom_engine' || cmd === 'update_custom_engine') {
                    const u = (args && args.url) || '';
                    const n = ((args && args.name) || '').trim();
                    if (!n) return Promise.reject('名字不能为空');
                    if (!u.includes('%s')) {
                        return Promise.reject('搜索地址里要用 %s 标出关键词的位置');
                    }
                    return Promise.resolve(null);
                }
                // 外部软件：同样模拟 Rust 侧校验（clean_app + validate_app_url）。
                // 判重跟着 CONF 走 —— pushConfig 换配置后，"已存在"的名字自然换一批。
                if (cmd === 'add_app' || cmd === 'update_app') {
                    const u = ((args && args.url) || '').trim();
                    const n = ((args && args.name) || '').trim();
                    if (!n) return Promise.reject('名字不能为空');
                    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
                        return Promise.reject('地址要带协议，例如：\nhttps://example.com');
                    }
                    const dup = (CONF.apps || []).some(
                        (a) => a.name === n && a.id !== (args && args.id));
                    if (dup) return Promise.reject('已经有一个叫「' + n + '」的外部软件了');
                    return Promise.resolve(cmd === 'add_app' ? 'ap-stub-id' : null);
                }
                // #143 图标编辑器（ui/iconedit.html）：会话 / 消除背景 / 保存 / 关窗
                if (cmd === 'icon_edit_load') return Promise.resolve(ICON_SESSION);
                if (cmd === 'icon_remove_bg') return Promise.resolve(ICON_REMOVE);
                if (cmd === 'icon_editor_save') return Promise.resolve('stub.png');
                if (cmd === 'close_icon_editor') return Promise.resolve(null);
                // 本地 OCR 环境检测：按 OCR_DEP_MISS 造一份三项依赖报告
                if (cmd === 'ocr_env_check') return Promise.resolve(ocrDepWithMissing());
                /* r45 起「识别引擎」不再是界面里写死的两档，而是后端注册表下发的
                 * 列表；r46 又加了 kind / modelRow / canListModels / online。
                 * ⚠ 这里以前**没有这个桩** → ocr_engines_list 返回 null →
                 *   renderOcrEngines 里 ENGINES.length 直接抛 TypeError，
                 *   整个 jsdom 套件从 r45 起就跑不起来（当时 jsdom 也没装，
                 *   所以一直没人发现）。现在补全字段，形状对齐
                 *   src/main.rs 的 ocr_engines_list()。 */
                if (cmd === 'ocr_engines_list') {
                    const mk = (o) => Object.assign({
                        online: true, canListModels: false, modelRow: false,
                        signup: '', docs: '', needKey: true, needSecret: false,
                        needModel: false, needBase: false, base: '', model: '',
                        note: '', ready: false,
                    }, o);
                    return Promise.resolve([
                        // 本地：什么都不要（走环境检测，不走凭据）
                        mk({
                            id: 'windows', name: '本地识别', kind: 'local', online: false,
                            needKey: false, ready: true,
                        }),
                        // 专用接口：Key + Secret
                        mk({
                            id: 'baidu', name: '百度云', kind: 'baidu', needSecret: true,
                            signup: 'https://console.bce.baidu.com/ai/', ready: true,
                        }),
                        // 走大模型、base 预置：Key + 模型（模型那栏总能看见、能换）
                        mk({
                            id: 'zhipu', name: '智谱', kind: 'openai',
                            needModel: true, canListModels: true, modelRow: true,
                            base: 'https://open.bigmodel.cn/api/paas/v4',
                            model: 'glm-4v-flash',
                        }),
                        // 自定义：Key + base + 模型，三样都要用户填
                        mk({
                            id: 'custom', name: '自定义', kind: 'openai',
                            needBase: true, needModel: true,
                            canListModels: true, modelRow: true,
                        }),
                    ]);
                }
                if (cmd === 'update_pending') return Promise.resolve(PENDING);
                if (cmd === 'backup_security_state') return Promise.resolve(SEC_STATE);
                if (cmd === 'github_rate_state') return Promise.resolve(RATE_STATE);
                if (cmd === 'import_with_password') {
                    return IMPORT_FAIL
                        ? Promise.reject(IMPORT_FAIL)
                        : Promise.resolve(null);
                }
                if (cmd === 'import_cancel') return Promise.resolve(null);
                /* v1.5.8：「验证」按钮。⚠ 必须**先于**那条 `return null` 兜底，
                 * 否则 verify 回 null → 前端读 info.login 报错。 */
                if (cmd === 'verify_github_token') {
                    if (VERIFY_FAIL) return Promise.reject(VERIFY_FAIL);
                    return Promise.resolve(Object.assign({}, VERIFY_OK));
                }
                // 一键安装 / 教程：真机会去开系统设置页和浏览器，测试里只记调用
                if (cmd === 'ocr_open_language_settings') return Promise.resolve(null);
                if (cmd === 'ocr_open_lang_help') return Promise.resolve(null);
                /* v1.5.16：翻译。⚠ 必须排在下面那条 `return null` 兜底前面 ——
                 * 不桩的话 trans_langs 回 null，翻译窗的下拉框永远是空的，
                 * 「切语言重翻」那条路根本走不到。 */
                if (cmd === 'trans_session') return Promise.resolve(TRANS_SESSION);
                if (cmd === 'trans_langs') return Promise.resolve(TRANS_LANGS);
                if (cmd === 'trans_engines_list') return Promise.resolve(TRANS_ENGS);
                if (cmd === 'trans_run') {
                    const one = TRANS_RUN_BY[args && args.engine];
                    const ok = one ? one.ok : TRANS_RUN_OK;
                    const fail = one ? one.fail : TRANS_RUN_FAIL;
                    if (fail) return Promise.reject(fail);
                    if (TRANS_RUN_DEFER) {
                        return new Promise((resolve) => {
                            TRANS_RUN_PENDING.push({ resolve, ok, engine: args && args.engine });
                        });
                    }
                    return Promise.resolve(ok);
                }
                if (cmd === 'trans_test') {
                    if (TRANS_RUN_FAIL) return Promise.reject(TRANS_RUN_FAIL);
                    return Promise.resolve(TRANS_RUN_OK);
                }
                /* trans_set_multi 的口径同 src/main.rs：只收注册表里认识的 id、
                 * 踢掉默认引擎自己、去重，然后**把清洗后的名单回传**（前端拿它
                 * 回画界面）。这里照抄，免得前端拿到 null 把名单画错。 */
                if (cmd === 'trans_set_multi') {
                    const def = (CONF && CONF.transEngine) || 'siliconflow';
                    const known = TRANS_ENGS.map((e) => e.id);
                    const cleaned = [];
                    for (const id of (args && args.engines) || []) {
                        if (id !== def && known.indexOf(id) >= 0 && cleaned.indexOf(id) < 0) {
                            cleaned.push(id);
                        }
                    }
                    return Promise.resolve(cleaned);
                }
                return Promise.resolve(null);
            },
        },
        event: {
            listen: (name, cb) => {
                // 同名事件保留最后一个，够用了
                listeners.set(name, cb);
                return Promise.resolve(() => { });
            },
        },
    };

    /* bar.js 顶部有一句 `const invoke = window.__TAURI__.core.invoke;` ——
     * 真机里它是经典脚本，这个 const 进全局词法环境，后面加载的 glass.js
     * 直接裸调 invoke 就能拿到它。但本测试用 env.w.eval() 逐文件跑脚本，
     * 间接 eval 里的顶层 const 不跨 eval 存活，glass.js 的裸 invoke 会
     * ReferenceError。这里在窗口上补一个同名全局函数指向同一个桩，
     * 把测试环境对齐成真机的可见性。 */
    w.invoke = (cmd, args) => w.__TAURI__.core.invoke(cmd, args);

    w.fetch = (url) => {
        const u = String(url);
        if (u.includes('engines.json')) {
            const c = BUILTIN_CATALOG();
            return Promise.resolve({ json: () => Promise.resolve(c) });
        }
        /* #143：设置页「编辑图标」对**只有内置 iconFile** 的引擎，要先把
         * data/icons/xxx.svg fetch 成 data URL 再递进编辑器（Rust 只认 data URL
         * 的字节）。这里给一个真能过 FileReader 的 Blob。 */
        if (u.includes('data/icons/')) {
            const blob = new w.Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/svg+xml' });
            return Promise.resolve({ ok: true, blob: () => Promise.resolve(blob) });
        }
        return Promise.reject(new Error('测试里没桩的请求：' + url));
    };
    };

    /* ⚠ 页面里的 `<script>` 是**内联**在 HTML 里的，`runScripts:'dangerously'`
     * 意味着它在 `new JSDOM(...)` 这一刻就会执行 —— 也就是说 boot 已经跑完了。
     * 所以"先把会话桩设好再让页面启动"这种事**只能在这里做**：
     * 用 `beforeParse` 抢先设，晚一步（哪怕只是同一 tick 之后的 next line）都没用。
     *
     * 以前 boot 第一句是 `await get_config`，多出来的那一拍让测试"事后补设"
     * 侥幸生效；v1.5.18 把四路 invoke 改成并发后这个侥幸就没了，所以显式给个口子。 */
    const beforeParse = (win) => {
        installStubs(win);
        if (opts && opts.session) setTransSession(opts.session);
    };
    const dom = new JSDOM(read(htmlFile), {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        url: 'http://localhost/',
        beforeParse: beforeParse,
    });
    const w = dom.window;
    // 有的路径（比如后面 eval 进来的脚本）会重新读 window，保证桩是同一套
    installStubs(w);

    return {
        dom, w, calls, listeners, rejectCmds,
        /** 下一次 `update_pending` 返回什么（模拟"启动时自动检查存下的结果"） */
        setPending,
        /** 下一次 `verify_github_token` 返回什么 / 怎么失败（v1.5.8） */
        setVerify,
        /** `backup_security_state` 返回什么（v1.5.9，备份可移植性状态条） */
        setSecState,
        /** `github_rate_state` 返回什么（v1.5.10，额度用量行） */
        setRateState,
        /** 让 `import_with_password` 失败（v1.5.10，测"密码错了"那条路） */
        setImportFail,
        /** 「这次要翻什么 / 默认翻成什么」（v1.5.16 翻译窗） */
        setTransSession,
        /** `trans_run` 返回什么 / 怎么失败（v1.5.16） */
        setTransRun,
        /** 只改某一家引擎这一次的返回 —— 测"一家挂、一家好"（v1.5.16 多引擎） */
        setTransRunFor,
        /** 换一份参与名单（模拟设置页勾了「同时翻译」后 trans_session 的变化） */
        setTransPlan,
        /** 让 `trans_run` 挂住不返回（测流式：先塞增量、再放行） */
        deferTransRun() { TRANS_RUN_DEFER = true; TRANS_RUN_PENDING = []; },
        /** 放行所有挂住的 `trans_run`（用桩里记下的 ok 值 resolve） */
        releaseTransRun() {
            const list = TRANS_RUN_PENDING;
            TRANS_RUN_PENDING = [];
            TRANS_RUN_DEFER = false;
            for (const p of list) p.resolve(p.ok);
        },
        /** 换一份配置并触发一次真实的 qs://config 事件（走真实的重渲染路径） */
        pushConfig(next) {
            CONF = next;
            const cb = listeners.get('qs://config');
            if (cb) cb({ payload: next });
        },
        getConf: () => CONF,
        cmd: (name) => calls.filter((c) => c.cmd === name),
        lastCmd: (name) => {
            const a = calls.filter((c) => c.cmd === name);
            return a.length ? a[a.length - 1] : null;
        },
    };
}

/** 按顺序 eval 真实的脚本文件 */
function runScripts(env, files) {
    for (const f of files) env.w.eval(read(f));
}

const flush = async (n = 20) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** 造一个 pointer 事件（jsdom 没有 PointerEvent；处理函数只认
 *  clientX/clientY/button，MouseEvent 同名派发即可） */
function firePtr(env, el, type, { clientY = 0, clientX = 0, button = 0 } = {}) {
    const ev = new env.w.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX, clientY, button,
    });
    el.dispatchEvent(ev);
    return ev;
}

/** 把第 i 行的位置伪装成 top=100+i*40、height=40，
 *  相邻中点插位才有确定结果（行间隙不能是死角） */
function fakeRect(el, i) {
    const top = 100 + i * 40;
    el.getBoundingClientRect = () => ({
        top, bottom: top + 40, height: 40,
        left: 0, right: 0, width: 0, x: 0, y: top,
        toJSON() { return {}; },
    });
}

/* ------------------------------ 断言框架 ------------------------------ */
let pass = 0, fail = 0;
const lines = [];
function ok(name, cond, extra) {
    cond ? pass++ : fail++;
    lines.push((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '\n        ' + extra));
}
function eq(name, got, want) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    ok(name, a === b, `期望 ${b}，实际 ${a}`);
}

/* ================================================================== */
/*  一、设置面板                                                       */
/* ================================================================== */

function baseConf(over) {
    return Object.assign({
        version: '1.0.0',
        triggerSelect: true, triggerCopy: true, autoStart: false,
        iconSize: 30, alpha: 100, iconStyle: 'auto', barPadding: 5,
        animations: true, shadow: false, anchorAtMouse: false, autoElevate: true,
        // v1.5.4：横条弹出位置（above = 文字上方 / below = 下方）
        barPos: 'above',
        delayMs: 0, filterMode: 'off', filterList: [],
        ocrEnable: true, ocrLang: 'CHN_ENG', ocrAccurate: true,
        // v1.5.16 翻译：默认引擎 + 「同时翻译」名单 + 各家凭据（键 = 引擎 id）
        transEnable: true, transEngine: 'siliconflow',
        transMulti: ['deepseek'], transTarget: 'zh',
        transCreds: {
            siliconflow: { key: 'sk-test', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
            deepseek: { key: 'sk-ds', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        },
        barList: ['百度', 'Google', '必应', '百度翻译', '知乎', '哔哩哔哩', '淘宝'],
        sepStyle: 'line',
        customEngines: [],
        overrideIcons: {}, urlOverrides: {}, aiSuffix: '请解释', aiSuffixes: {},
        aiCopyPrompt: true,
        /* r80 起「编辑图标」按钮受这个总开关控制（默认关）。下面 #143 那两段
         * 用例测的就是按钮本身，配置里必须把它打开 —— 否则一行按钮都不渲染，
         * 用例先 FAIL 再抛异常，把后面的 testBar / testCatJump 全带走
         * （表现成"整套 151/154、后面根本没跑"）。 */
        aiMattingEnable: true,
        webdavOnStart: false, webdavOnExit: false,
        // v1.5.7：GitHub 个人访问令牌（空 = 匿名请求）
        githubToken: '',
    }, over || {});
}

async function testSettings() {
    console.log('=== 设置面板（ui/settings.html）===');
    const env = makeEnv('ui/settings.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);

    // ---- 基础：脚本没在半路抛异常，页面被真的渲染过 ----
    ok('启动后没有把面板渲染成空白', $('barList').children.length > 0);

    /* ---- 分栏结构（2026-10-23：外观 / 范围 / 抠图 从「通用」拆了出来） ----
     * 用户原话：「关于横条的外观的相关设置，你要单独列一栏来设置，现在是放在
     * 通用里面，这不好。还有黑名单、白名单也是这样。Ai 抠图也是。」
     * 这里钉住三件事：新分栏存在、卡片真的在它里面、通用里不再有那几张卡片。 */
    {
        const paneOf = (name) => w.document.querySelector('.pane[data-pane="' + name + '"]');
        const tabs = [...w.document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab);
        ok('侧栏有「外观 / 范围 / 抠图」三栏',
            ['look', 'scope', 'matte'].every((t) => tabs.includes(t)), tabs.join('/'));
        ok('  三个新分栏的容器都在、且默认收起',
            ['look', 'scope', 'matte'].every((t) => paneOf(t) && paneOf(t).hidden));
        ok('  通用里不再有「横条外观」卡片',
            !paneOf('general').textContent.includes('横条外观'));
        ok('  通用里不再有「应用范围」卡片',
            !paneOf('general').textContent.includes('应用范围'));
        ok('  通用里不再有「AI 抠图」卡片',
            !paneOf('general').textContent.includes('AI 抠图'));
        ok('  外观栏里有「横条外观」+ 预览',
            paneOf('look').textContent.includes('横条外观')
            && paneOf('look').textContent.includes('预览'));
        /* 2026-10-23 追加：用户点名「界面主题也放进外观，顺序是 主题 → 预览 →
         * 外观参数」，理由是预览摆最下面时拖滑块根本看不见它，「即时观察」白搭。
         * 这条按 DOM 顺序断言 —— 改布局把预览又挪下去时会立刻红。 */
        ok('  界面主题搬到了外观栏（通用里不再有）',
            paneOf('look').textContent.includes('界面主题')
            && !paneOf('general').textContent.includes('界面主题'));
        {
            const heads = [...paneOf('look').querySelectorAll('h2')].map((h) => h.textContent.trim());
            ok('  外观栏的卡片顺序 = 界面主题 → 预览 → 横条外观',
                heads.length >= 3
                && /^界面主题/.test(heads[0]) && /^预览/.test(heads[1])
                && /^横条外观/.test(heads[2]),
                heads.join(' / '));
        }
        ok('  范围栏里有黑白名单（应用范围）',
            paneOf('scope').textContent.includes('应用范围'));
        ok('  抠图栏里有 AI 抠图',
            paneOf('matte').textContent.includes('AI 抠图'));
        // 点 tab 能切过去（bindTabs 只认 data-pane，不写死分栏名）
        w.document.querySelector('#tabs button[data-tab="look"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('  点「外观」真的切到外观页（通用同时收起）',
            !paneOf('look').hidden && paneOf('general').hidden);
        w.document.querySelector('#tabs button[data-tab="general"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
    }

    /* ---- 2026-10-23 三个新设置项：控件在、落盘键名对 ----
     * 它们分别控制「没取到文字就不弹」「几秒无操作收起」「鼠标移远就收起」。 */
    {
        ok('「没取到文字就不弹」开关在通用页', !!$('s-barNeedText'));
        eq('  默认开（老配置里没有这个键 → 按 true 画）', $('s-barNeedText').checked, true);
        env.calls.length = 0;
        $('s-barNeedText').checked = false;
        $('s-barNeedText').dispatchEvent(new w.Event('change', { bubbles: true }));
        const c1 = env.lastCmd('set_setting');
        ok('  关掉它写的是 barNeedText',
            !!c1 && c1.args.key === 'barNeedText' && c1.args.value === false,
            c1 && JSON.stringify(c1.args));

        ok('「无操作自动收起」滑块在通用页', !!$('s-barIdle'));
        eq('  默认 5 秒', $('s-barIdle').value, '5');
        env.calls.length = 0;
        $('s-barIdle').value = '12';
        $('s-barIdle').dispatchEvent(new w.Event('input', { bubbles: true }));
        eq('  拖动时数值标签跟着走', $('s-barIdleVal').textContent, '12 秒');
        $('s-barIdle').dispatchEvent(new w.Event('change', { bubbles: true }));
        const c2 = env.lastCmd('set_setting');
        ok('  落盘键名 barIdleSec、值是数字',
            !!c2 && c2.args.key === 'barIdleSec' && c2.args.value === 12,
            c2 && JSON.stringify(c2.args));

        ok('「鼠标移远就收起」滑块在通用页', !!$('s-barAway'));
        eq('  默认 400 px', $('s-barAway').value, '400');
        env.calls.length = 0;
        $('s-barAway').value = '0';
        $('s-barAway').dispatchEvent(new w.Event('input', { bubbles: true }));
        eq('  0 要显示成「不收起」（写 0 px 会被当成"立刻收"）',
            $('s-barAwayVal').textContent, '不收起');
        $('s-barAway').dispatchEvent(new w.Event('change', { bubbles: true }));
        const c3 = env.lastCmd('set_setting');
        ok('  落盘键名 barAwayPx', !!c3 && c3.args.key === 'barAwayPx',
            c3 && JSON.stringify(c3.args));
        // 复位，后面那些用例还要按默认值算
        env.pushConfig(baseConf());
        await flush();
    }

    /* ---- 2026-10-24 弹出位置（文字上方 / 下方）：控件在外观栏、落盘键名对 ----
     * 用户在「外观 → 横条外观」里选横条优先贴选中文字的哪一侧；选的那侧
     * 放不下时后端会自动翻到另一侧（翻侧规则在 main.rs 的 pick_bar_side
     * 单元测试里钉死）。 */
    {
        ok('「弹出位置」分段控件在外观栏', !!$('s-barPos'));
        eq('  两个档位：文字上方 / 文字下方',
            [...$('s-barPos').querySelectorAll('button')].map((b) => b.dataset.v),
            ['above', 'below']);
        eq('  默认选中「文字上方」（沿袭老行为）',
            $('s-barPos').querySelector('button.on').dataset.v, 'above');

        // 配置里是 below → 选中态跟着走
        env.pushConfig(baseConf({ barPos: 'below' }));
        await flush();
        eq('  配置 below 时「文字下方」是选中态',
            $('s-barPos').querySelector('button.on').dataset.v, 'below');

        // 点「文字上方」→ 写 barPos=above
        env.calls.length = 0;
        $('s-barPos').querySelector('button[data-v="above"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        const c = env.lastCmd('set_setting');
        ok('  点档位写入 barPos',
            !!c && c.args.key === 'barPos' && c.args.value === 'above',
            c && JSON.stringify(c.args));

        /* 「跟随鼠标位置」打开时本项没有意义（那条路一律贴鼠标），控件置灰。
         * 这条顺带钉住联动：改开关 → seg.off + 按钮 disabled。 */
        $('s-anchorAtMouse').checked = true;
        $('s-anchorAtMouse').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        ok('  打开「跟随鼠标位置」后弹出位置控件置灰',
            $('s-barPos').classList.contains('off')
            && [...$('s-barPos').querySelectorAll('button')].every((b) => b.disabled));
        $('s-anchorAtMouse').checked = false;
        $('s-anchorAtMouse').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        ok('  关掉「跟随鼠标位置」后恢复可点',
            !$('s-barPos').classList.contains('off')
            && [...$('s-barPos').querySelectorAll('button')].every((b) => !b.disabled));

        // 复位，后面那些用例还要按默认值算
        env.pushConfig(baseConf());
        await flush();
    }

    // 横条真成员 = 排得进 barList 的引擎（不含「＋ 把 OCR 加进横条」那种 .add-row 入口行）。
    const barItems = () => [...$('barList').querySelectorAll('.item:not(.add-row)')];
    eq('横条真成员渲染出 7 行（不含 .add-row 入口行）', barItems().length, 7);

    // ---- 分隔线样式的三档 ----
    const seg = $('s-sepStyle');
    eq('分隔线样式有 3 个档位', seg.querySelectorAll('button').length, 3);
    eq('默认选中「细竖线」',
        seg.querySelector('button.on') && seg.querySelector('button.on').dataset.v, 'line');

    // ---- 加分隔线 ----
    $('btnAddSep').dispatchEvent(new w.Event('click', { bubbles: true }));
    ok('点「添加分隔线」调用了 add_separator', !!env.lastCmd('add_separator'),
        JSON.stringify(env.calls.map((c) => c.cmd)));

    // ---- 列表里出现分隔线行 ----
    env.pushConfig(baseConf({ barList: ['百度', 'Google', '|', '知乎', '淘宝'] }));
    await flush();
    const rows = barItems();
    eq('分隔线变成 5 行中的一行', rows.length, 5);
    const sepRow = rows[2];
    ok('第 3 行是分隔线行', sepRow.classList.contains('sep-row'), sepRow.className);
    ok('分隔线行有文字「分隔线」', sepRow.textContent.includes('分隔线'));
    ok('分隔线行有删除按钮', [...sepRow.querySelectorAll('.mini')].some((b) => b.textContent === '删除'));
    const sepDel = [...sepRow.querySelectorAll('.mini')].find((b) => b.textContent === '删除');
    sepDel.dispatchEvent(new w.Event('click', { bubbles: true }));
    const rmv = env.lastCmd('remove_separator');
    ok('点删除调用了 remove_separator', !!rmv, JSON.stringify(env.calls.map((c) => c.cmd)));
    eq('删除传的是**下标** 2（不是名字）', rmv && rmv.args.index, 2);

    // 分隔线在开头时，上移按钮应当被禁用（usize 存不下 -1）
    env.pushConfig(baseConf({ barList: ['|', '百度', 'Google'] }));
    await flush();
    const firstRow = barItems()[0];
    const upBtn = [...firstRow.querySelectorAll('.mini')].find((b) => b.textContent === '↑');
    ok('第一行的「↑」被禁用（避免传负数下标）', upBtn && upBtn.disabled === true);
    const lastRow = barItems().pop();
    const dnBtn = [...lastRow.querySelectorAll('.mini')].find((b) => b.textContent === '↓');
    ok('最后一行的「↓」被禁用', dnBtn && dnBtn.disabled === true);

    // ---- 拖拽换位：下标换算（pointer 事件版）----
    // 行位置：r0=[100,140] r1=[140,180] r2=[180,220] r3=[220,260]，中点插位
    env.pushConfig(baseConf({ barList: ['A', 'B', 'C', 'D'] }));
    await flush();
    {
        const rr = [...$('barList').querySelectorAll('.item')];
        rr.forEach(fakeRect);
        env.calls.length = 0;
        firePtr(env, rr[0], 'pointerdown', { clientX: 10, clientY: 120 });
        firePtr(env, rr[0], 'pointermove', { clientX: 10, clientY: 300 }); // 超过 5px，进拖拽
        firePtr(env, rr[2], 'pointerup', { clientX: 10, clientY: 210 });   // C 行下半 -> 插到 C 之后
        const m = env.lastCmd('move_bar_item');
        ok('A 拖到 C 之后调用了 move_bar_item', !!m);
        eq('  from 正确', m && m.args.from, 0);
        eq('  to 正确（0 -> 2）', m && m.args.to, 2);
    }
    {
        const rr = [...$('barList').querySelectorAll('.item')];
        rr.forEach(fakeRect);
        env.calls.length = 0;
        firePtr(env, rr[3], 'pointerdown', { clientX: 10, clientY: 240 });
        firePtr(env, rr[3], 'pointermove', { clientX: 10, clientY: 100 });
        firePtr(env, rr[1], 'pointerup', { clientX: 10, clientY: 150 });   // B 行上半 -> 插到 B 之前
        const m = env.lastCmd('move_bar_item');
        eq('D 拖到 B 之前：from', m && m.args.from, 3);
        eq('D 拖到 B 之前：to（3 -> 1）', m && m.args.to, 1);
    }
    {
        const rr = [...$('barList').querySelectorAll('.item')];
        rr.forEach(fakeRect);
        env.calls.length = 0;
        firePtr(env, rr[1], 'pointerdown', { clientX: 10, clientY: 160 });
        firePtr(env, rr[1], 'pointermove', { clientX: 10, clientY: 300 });
        firePtr(env, rr[1], 'pointerup', { clientX: 10, clientY: 150 });
        ok('原地拖回自己不调用后端（省一次无意义的写盘）', !env.lastCmd('move_bar_item'));
    }
    {
        const rr = [...$('barList').querySelectorAll('.item')];
        rr.forEach(fakeRect);
        env.calls.length = 0;
        firePtr(env, rr[0], 'pointerdown', { clientX: 10, clientY: 120 });
        firePtr(env, rr[0], 'pointermove', { clientX: 11, clientY: 122 }); // 不到 5px，不算拖
        firePtr(env, rr[0], 'pointerup', { clientX: 11, clientY: 122 });
        ok('5px 以内的手抖不会触发换位', !env.lastCmd('move_bar_item'));
    }
    {
        const rr = [...$('barList').querySelectorAll('.item')];
        rr.forEach(fakeRect);
        env.calls.length = 0;
        const btn = [...rr[0].querySelectorAll('.mini')][0]; // 「↑」按钮
        firePtr(env, btn, 'pointerdown', { clientX: 10, clientY: 120 });
        firePtr(env, btn, 'pointermove', { clientX: 10, clientY: 300 });
        firePtr(env, rr[2], 'pointerup', { clientX: 10, clientY: 210 });
        ok('按在按钮上不会被当成拖行', !env.lastCmd('move_bar_item'));
    }

    // ---- 自定义引擎：空态 ----
    env.pushConfig(baseConf({ customEngines: [] }));
    await flush();
    ok('没有自定义引擎时给出空态提示', $('customList').textContent.includes('还没有自定义引擎'));

    // ---- 自定义引擎：渲染 ----
    env.pushConfig(baseConf({
        customEngines: [
            { name: '内网搜索', url: 'https://s.example/?q=%s', category: '自定义' },
            { name: '备用 Kimi', url: 'https://k.example/?q=%s', category: 'AI 工具' },
        ],
    }));
    await flush();
    const crows = [...$('customList').querySelectorAll('.item')];
    eq('自定义引擎渲染出 2 行', crows.length, 2);
    ok('行里显示了 URL 原文', crows[0].textContent.includes('https://s.example/?q=%s'));
    ok('行里显示了分类', crows[1].textContent.includes('AI 工具'));
    /* ⚠ r61/r73 起「全部引擎」列表是**选了分组才有内容**的（没选时显示的是一句
     * 「上面选一个大类开始浏览」的引导语）—— 不断言前先点一下「全部引擎」那颗，
     * 不然永远在跟一句空态提示较劲（自定义引擎本身是并进去了的，探针复现过）。 */
    $('allGrpNav').querySelector('.eng-nav-item').dispatchEvent(
        new w.Event('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 200));
    ok('自定义引擎也出现在「全部引擎」里',
        $('allList').textContent.includes('内网搜索')
        && $('allList').textContent.includes('备用 Kimi'),
        $('allList').textContent.slice(0, 80));

    // ---- 自定义引擎：新增 ----
    $('w-ceName').value = '新引擎';
    $('w-ceUrl').value = 'https://new.example/find?q=%s';
    $('w-ceCat').value = 'AI 工具';
    $('btnCeSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const add = env.lastCmd('add_custom_engine');
    ok('点「添加」调用了 add_custom_engine', !!add);
    eq('  名字传对', add && add.args.name, '新引擎');
    eq('  地址传对', add && add.args.url, 'https://new.example/find?q=%s');
    eq('  分类传对', add && add.args.category, 'AI 工具');
    eq('保存成功后表单被清空', $('w-ceName').value, '');

    // ---- 自定义引擎：校验失败要显示后端的中文提示 ----
    $('w-ceName').value = '缺占位符';
    $('w-ceUrl').value = 'https://bad.example/search';
    $('w-ceCat').value = '';
    $('btnCeSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('校验失败时把中文原因显示在表单下方',
        $('ceHint').textContent.includes('%s'), $('ceHint').textContent);
    ok('校验失败时不清空表单，方便就地改', $('w-ceName').value === '缺占位符');

    // ---- 自定义引擎：编辑 ----
    $('btnCeCancel').dispatchEvent(new w.Event('click', { bubbles: true }));  // 先回新增态
    await flush();
    {
        const rr = [...$('customList').querySelectorAll('.item')];
        const editBtn = [...rr[0].querySelectorAll('.mini')].find((b) => b.textContent === '编辑');
        ok('自定义引擎行有「编辑」按钮', !!editBtn);
        editBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        eq('点编辑后表单被填入名字', $('w-ceName').value, '内网搜索');
        eq('点编辑后表单被填入地址', $('w-ceUrl').value, 'https://s.example/?q=%s');
        eq('保存按钮变成「保存修改」', $('btnCeSave').textContent, '保存修改');
        ok('取消按钮出现了', $('btnCeCancel').hidden === false);

        $('w-ceName').value = '内网搜索2';
        $('btnCeSave').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const upd = env.lastCmd('update_custom_engine');
        ok('编辑模式下调用了 update_custom_engine（不是 add）', !!upd);
        eq('  带上了 index', upd && upd.args.index, 0);
        eq('  带上了新名字', upd && upd.args.name, '内网搜索2');
    }

    // ---- 自定义引擎：删除要两步确认 ----
    {
        const rr = [...$('customList').querySelectorAll('.item')];
        const del = [...rr[1].querySelectorAll('.mini')].find((b) => b.textContent === '删除');
        ok('自定义引擎行有「删除」按钮', !!del);
        env.calls.length = 0;
        del.dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('第一次点删除只是变成确认态，不真的删', !env.lastCmd('remove_custom_engine'));
        ok('  按钮文案变成确认', del.textContent.includes('确认'));
        del.dispatchEvent(new w.Event('click', { bubbles: true }));
        const rm = env.lastCmd('remove_custom_engine');
        ok('第二次点才真的调用 remove_custom_engine', !!rm);
        eq('  传的 index 是 1', rm && rm.args.index, 1);
    }

    /* ---- 外部软件：设置页整节 ----
     * 用户原话：「在引擎管理面板中提供"新建引擎"入口，支持输入目标软件的 URL
     * 并为其配置自定义图标；保存后将该图标固定到界面横栏中」。
     * 「保存即固定」由 Rust 侧 add_app 钉（单测 add_app_pins_sentinel… 守着），
     * 这里验前端的表单 / 列表 / 报错 / 图标键这几段。 */
    console.log('');
    console.log('--- 外部软件：新建 / 编辑 / 删除 / 挑图标 ---');
    env.pushConfig(baseConf({ apps: [] }));
    await flush();
    ok('没有外部软件时给出空态提示',
        $('appList').textContent.includes('还没有外部软件'), $('appList').textContent);

    // ---- 渲染：一行一个软件，地址原文 + 横条状态都露出来 ----
    env.pushConfig(baseConf({
        apps: [
            { id: 'ap1', name: '微信', url: 'weixin://' },
            { id: 'ap2', name: '网易云音乐', url: 'https://music.163.com' },
        ],
        barList: ['百度', '@app:ap1'],
    }));
    await flush();
    const aprows = [...$('appList').querySelectorAll('.item')];
    eq('外部软件渲染出 2 行', aprows.length, 2);
    ok('行里露出地址原文（最容易忘的就是当初填的什么）',
        aprows[0].textContent.includes('weixin://'));
    ok('在横条上的标「已在横条」', aprows[0].textContent.includes('已在横条'));
    ok('不在横条的标「没在横条上」', aprows[1].textContent.includes('没在横条上'));
    ok('没挑过图标时用软件名首字徽标（不是哨兵名的 "@"）',
        aprows[0].querySelector('.ic .letter') &&
        aprows[0].querySelector('.ic .letter').textContent === '微',
        aprows[0].querySelector('.ic').innerHTML);

    // ---- 新增：参数透传 ----
    $('w-apName').value = '企业微信';
    $('w-apUrl').value = 'weixin://';
    $('btnApSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const addAp = env.lastCmd('add_app');
    ok('点「添加」调用了 add_app', !!addAp,
        JSON.stringify(env.calls.map((c) => c.cmd)));
    eq('  名字传对', addAp && addAp.args.name, '企业微信');
    eq('  地址传对', addAp && addAp.args.url, 'weixin://');
    eq('保存成功后表单被清空', $('w-apName').value, '');
    eq('  地址框也清空', $('w-apUrl').value, '');

    // ---- 校验失败：无效地址（不带协议）要显示中文原因，且不清表单 ----
    $('w-apName').value = '坏地址';
    $('w-apUrl').value = 'www.example.com';
    $('btnApSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('无效地址把中文原因显示在表单下方',
        $('apHint').textContent.includes('协议'), $('apHint').textContent);
    ok('校验失败时不清空表单，方便就地改', $('w-apName').value === '坏地址');

    // ---- 校验失败：重名 ----
    $('w-apName').value = '微信';
    $('w-apUrl').value = 'https://example.com';
    $('btnApSave').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('重名被拦下并给出中文提示',
        $('apHint').textContent.includes('已经有一个'), $('apHint').textContent);

    // ---- 编辑 ----
    $('btnApCancel').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    {
        const rr = [...$('appList').querySelectorAll('.item')];
        const editBtn = [...rr[0].querySelectorAll('.mini')].find((b) => b.textContent === '编辑');
        ok('外部软件行有「编辑」按钮', !!editBtn);
        editBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        eq('点编辑后表单被填入名字', $('w-apName').value, '微信');
        eq('点编辑后表单被填入地址', $('w-apUrl').value, 'weixin://');
        eq('保存按钮变成「保存修改」', $('btnApSave').textContent, '保存修改');
        ok('取消按钮出现了', $('btnApCancel').hidden === false);

        // 挑图标：编辑态直接挑，参数必须是哨兵（@app:<id>）而不是软件名 ——
        // 按 id 存，用户之后改名图标才不会丢。
        env.calls.length = 0;
        $('btnApIcon').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const pick = env.lastCmd('pick_icon');
        ok('点「选图标」调用了 pick_icon', !!pick,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  按 id 存（@app:<id>，改名不丢图标）', pick && pick.args.engine, '@app:ap1');

        $('w-apName').value = '微信（改名）';
        $('btnApSave').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const updAp = env.lastCmd('update_app');
        ok('编辑模式下调用了 update_app（不是 add）', !!updAp,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  带上了 id（按 id 改，不靠下标）', updAp && updAp.args.id, 'ap1');
        eq('  带上了新名字', updAp && updAp.args.name, '微信（改名）');
    }

    // ---- 新建态挑图标：还没有 id，必须提示而不是硬挑 ----
    $('btnApCancel').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    env.calls.length = 0;
    $('btnApIcon').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('新建态点「选图标」不发 pick_icon（还没有 id 可挂）',
        !env.lastCmd('pick_icon'), JSON.stringify(env.calls.map((c) => c.cmd)));
    ok('  并提示先保存再挑', $('apHint').textContent.includes('先点'),
        $('apHint').textContent);

    // ---- 「试一下」/「固定到横条」两颗按钮 ----
    {
        const rr = [...$('appList').querySelectorAll('.item')];
        const tryBtn = [...rr[1].querySelectorAll('.mini')].find((b) => b.textContent === '试一下');
        ok('外部软件行有「试一下」按钮', !!tryBtn);
        env.calls.length = 0;
        tryBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const openAp = env.lastCmd('open_app');
        ok('点「试一下」调用了 open_app', !!openAp,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  带的是 id 不是下标', openAp && openAp.args.id, 'ap2');

        const pinBtn = [...rr[1].querySelectorAll('.mini')].find((b) => b.textContent === '固定到横条');
        ok('不在横条上的软件有「固定到横条」按钮', !!pinBtn);
        env.calls.length = 0;
        pinBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const tog = env.lastCmd('toggle_bar_engine');
        ok('点「固定到横条」调用了 toggle_bar_engine', !!tog,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  传的是哨兵 @app:<id>', tog && tog.args.engine, '@app:ap2');
        eq('  on = true（从 false 翻过去）', tog && tog.args.on, true);
    }

    // ---- 删除两步确认 ----
    {
        const rr = [...$('appList').querySelectorAll('.item')];
        const del = [...rr[0].querySelectorAll('.mini')].find((b) => b.textContent === '删除');
        ok('外部软件行有「删除」按钮', !!del);
        env.calls.length = 0;
        del.dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('第一次点删除只是变成确认态，不真的删', !env.lastCmd('remove_app'));
        ok('  按钮文案变成确认', del.textContent.includes('确认'));
        del.dispatchEvent(new w.Event('click', { bubbles: true }));
        const rmAp = env.lastCmd('remove_app');
        ok('第二次点才真的调用 remove_app', !!rmAp);
        eq('  传的是 id', rmAp && rmAp.args.id, 'ap1');
    }

    // ---- 「横条上的引擎」列表里的外部软件行 ----
    env.pushConfig(baseConf({
        apps: [{ id: 'ap1', name: '微信', url: 'weixin://' }],
        barList: ['百度', '@app:ap1', '@app:dead', 'Google'],
    }));
    await flush();
    {
        const rows = barItems();
        eq('悬空的 @app:dead 哨兵被过滤掉（不然显示成乱码）', rows.length, 3);
        const appRow = rows[1];
        ok('横条成员里的外部软件行显示软件名（不是 @app:ap1 原文）',
            appRow.textContent.includes('微信'), appRow.textContent);
        ok('  并标注「外部软件」', appRow.textContent.includes('外部软件'));
        ok('  图标和设置页列表同一颗（qsAppIconNode）',
            !!appRow.querySelector('.ic .letter'),
            appRow.querySelector('.ic').innerHTML);
        // 「默认」按钮在 app 行上的含义是恢复首字徽标
        const defBtn = [...appRow.querySelectorAll('.mini')].find((b) => b.textContent === '默认');
        if (defBtn) {
            ok('  app 行「默认」按钮的提示说的是恢复徽标',
                (defBtn.title || '').includes('徽标'), defBtn.title);
        }
    }

    // ---- OCR 总开关存在（之前漏在 HTML 里、把整页绑定带崩过）----
    ok('OCR 页有「启用文字识别」开关', !!$('s-ocrEnable'));
    const ocrSwitch = $('s-ocrEnable');
    ocrSwitch.checked = false;
    ocrSwitch.dispatchEvent(new w.Event('change', { bubbles: true }));
    const ss = env.lastCmd('set_setting');
    ok('拨动 OCR 开关会写回后端', !!ss);
    eq('  key 正确', ss && ss.args.key, 'ocrEnable');
    eq('  value 正确', ss && ss.args.value, false);

    /* ---- 收藏夹：「全部展开」只摊目录，不该把每条内容变成编辑态 ----
     * 用户报的 bug：点「全部展开」，目录是开了，但里面每一条带备注的文字
     * 也一起进了编辑态（textarea + 备注框），一屏全是输入框。
     * 期望：目录层级摊开、条目仍是**收起的一行**。 */
    console.log('');
    console.log('--- 收藏夹：全部展开 / 全部折叠 ---');
    env.pushConfig(baseConf({
        favorites: [{
            id: 'g1', name: '目录一', icon: '', children: [],
            items: [
                { id: 'i1', kind: 'text', text: '第一句', html: '', remark: '备注一' },
                { id: 'i2', kind: 'text', text: '第二句', html: '', remark: '备注二' },
            ],
        }],
    }));
    await flush();
    const tree = $('favTree');
    ok('收藏树渲染出来了', tree.querySelectorAll('.fav-row').length >= 1,
        tree.textContent.slice(0, 80));

    $('btnFavCollapseAll').click();
    await flush();
    eq('「全部折叠」后目录内容整个不渲染（这才是收起来）',
        tree.querySelectorAll('.fav-item-line, .fav-item-edit').length, 0);

    $('btnFavExpandAll').click();
    await flush();
    eq('「全部展开」后两条内容都出来了', tree.querySelectorAll('.fav-item-line').length, 2);
    eq('  但一条都没被摊成编辑态（用户报的就是这个）',
        tree.querySelectorAll('.fav-item-edit').length, 0);
    // 目录名那个 <input class="fav-name" readonly> 是**常驻**的（点「重命名」才
    // 解锁），不算编辑态；所以这里查的是"可编辑的输入框"和条目编辑体。
    // 展开前如果去数 input 的个数，会把这条正常的只读框也算进去，误报。
    eq('  树里没有条目编辑体', tree.querySelectorAll('.fav-item-edit, textarea').length, 0);
    eq('  也没有被解锁的输入框（只读的目录名不算）',
        tree.querySelectorAll('input:not([readonly])').length, 0);

    /* ---- 分页跳转：qs://goto-tab ----
     * 横条收藏面板点「设置…」跳收藏夹那条在横条那一节里测；这里先确认
     * 设置页对每个分页名都有对应的 button + pane —— 少一个就会「点了没反应」。 */
    console.log('');
    console.log('--- 分页跳转 & 帮助 / 关于 ---');
    const gotoCb = env.listeners.get('qs://goto-tab');
    ok('设置页登记了 qs://goto-tab 的接收', !!gotoCb);
    for (const name of ['fav', 'help', 'about', 'ocr']) {
        if (gotoCb) gotoCb({ payload: name });
        const pane = w.document.querySelector('.pane[data-pane="' + name + '"]');
        ok('  goto-tab=' + name + ' 切到了对应分页', !!pane && pane.hidden === false);
    }

    /* ---- 帮助页 ---- */
    const helpPane = w.document.querySelector('.pane[data-pane="help"]');
    const helpItems = helpPane.querySelectorAll('details.help-item');
    ok('帮助页有分主题的折叠块（≥ 8 块）', helpItems.length >= 8, '实际 ' + helpItems.length);
    ok('  第一块默认展开（否则一进来只剩一排标题）', helpItems[0].open === true);
    const helpText = helpPane.textContent;
    ok('  覆盖了触发 / 引擎 / 收藏夹 / 备份 / 快捷键这几块',
        ['怎么把它叫出来', '引擎', '收藏夹', '备份', '快捷键'].every((k) => helpText.includes(k)));

    /* ---- 关于页：开发者 / 版本 / 版本更新时间 / 使用的工具 ---- */
    const conf = env.getConf();
    eq('关于页显示当前版本', $('aboutVer').textContent, 'v' + (conf.version || '1.0.0'));
    ok('关于页显示开发者', $('aboutDev').textContent.trim().length > 0, $('aboutDev').textContent);
    ok('关于页显示版本更新时间（不是空白 / 不是占位）',
        $('aboutBuilt').textContent.trim().length > 0 && $('aboutBuilt').textContent !== '—',
        $('aboutBuilt').textContent);
    ok('关于页列出了使用的工具（≥ 8 个）', $('aboutTools').children.length >= 8,
        '实际 ' + $('aboutTools').children.length);
    ok('  「关于」从「备份」页里挪出来了（各自独立分页）',
        !w.document.querySelector('.pane[data-pane="backup"]').textContent.includes('开发者'));

    /* ---- v1.5.14：启动密码（两次输入 + 关闭要先验密码） ----
     * 单框时代打错一个字母就把自己锁在门外（没有找回入口，只能手改
     * config.json 删掉那行哈希）；而"关开关就清哈希"等于谁都能顺手把保护卸掉。
     * 所以这里钉住：第二个框真的在、两次不一致时**一个字节都不写**、
     * 关闭时必须先验当前密码且验不过什么都不改。 */
    console.log('');
    console.log('--- 启动密码：两次输入 + 关闭要验密码 ---');
    {
        const sw = $('s-startupPwd');
        const i1 = $('s-startupPwdVal');
        const i2 = $('s-startupPwdVal2');
        const save = $('btnStartupPwdSave');
        ok('设置页有第二个「确认密码」框', !!i2, '没有 #s-startupPwdVal2');
        ok('  没设密码时开关默认关着、输入行收着',
            sw.checked === false && $('rowStartupPwd').hidden === true);

        sw.checked = true;
        sw.dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        ok('  打开开关后两行输入都露出来', $('rowStartupPwd').hidden === false);

        env.calls.length = 0;
        i1.value = 'alpha-111';
        i2.value = 'alpha-112';
        save.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        eq('  两次不一致时**不写配置**', env.cmd('set_setting').length, 0);
        ok('  给出「不一致」的明确提示（不是静默失败）',
            /不一致/.test($('startupPwdStatus').textContent), $('startupPwdStatus').textContent);
        ok('  提示用 err 样式（红字，不是灰字）',
            /\berr\b/.test($('startupPwdStatus').className), $('startupPwdStatus').className);
        eq('  第二个框被清空，等用户重输', i2.value, '');
        eq('  第一遍的输入保留（用户能对着核对）', i1.value, 'alpha-111');

        env.calls.length = 0;
        i2.value = 'alpha-111';
        save.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const ss = env.lastCmd('set_setting');
        ok('  两次一致才落盘，键名 startupPassword',
            !!ss && ss.args.key === 'startupPassword' && ss.args.value === 'alpha-111',
            JSON.stringify(ss && ss.args));
        eq('  保存后两个框都清空（密码不留在 DOM 上）', i1.value + '|' + i2.value, '|');
        ok('  给出「已保存」提示', /已保存/.test($('startupPwdStatus').textContent),
            $('startupPwdStatus').textContent);

        /* ④ 关闭密码必须先验一次当前密码（用户要求「要取消密码，必须要再输一次
         * 解锁密码」）—— 关掉开关**不许**直接清哈希。 */
        env.calls.length = 0;
        sw.checked = false;
        sw.dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        eq('  关掉开关不会直接清哈希（一次 set_setting 都没有）', env.cmd('set_setting').length, 0);
        ok('  弹出了「关闭启动密码」验证行', $('rowStartupPwdOff').hidden === false);
        ok('  提示要先输当前密码', /先输入当前密码/.test($('startupPwdOffStatus').textContent),
            $('startupPwdOffStatus').textContent);

        $('s-startupPwdOff').value = 'wrong-one';
        $('btnStartupPwdOff').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('  密码不对时明确说「没有被关闭」',
            /密码不对/.test($('startupPwdOffStatus').textContent),
            $('startupPwdOffStatus').textContent);
        eq('  密码不对时输入框清空、等重输', $('s-startupPwdOff').value, '');
        eq('  而且**一次都没调**清哈希的写口', env.cmd('set_setting').length, 0);

        $('btnStartupPwdOffCancel').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        eq('  取消后开关弹回打开（保护一点没动）', sw.checked, true);
        ok('  验证行收起', $('rowStartupPwdOff').hidden === true);

        // ⑤ 输对了才真的关闭
        sw.checked = false;
        sw.dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        $('s-startupPwdOff').value = 'alpha-111';
        $('btnStartupPwdOff').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const off = env.lastCmd('startup_password_disable');
        ok('  验证走 startup_password_disable，密码原样带过去',
            !!off && off.args.password === 'alpha-111', JSON.stringify(off && off.args));
        eq('  验证通过后开关才真的关掉', sw.checked, false);
        ok('  验证行收起', $('rowStartupPwdOff').hidden === true);
        ok('  提示已关闭启动密码', /已关闭启动密码/.test($('startupPwdStatus').textContent),
            $('startupPwdStatus').textContent);
    }
}

/* ================================================================== */
/*  二、横条                                                           */
/* ================================================================== */

async function testBar() {
    console.log('');
    console.log('=== 横条（ui/index.html）===');
    const env = makeEnv('ui/index.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/bar.js', 'ui/glass.js']);
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    /* ⚠ jsdom 不加载 <link> 外链 CSS，而 #148 起 --qs-bg 改由样式表两套
     * 配色给出（applyThemePayload 只挂类，不再写内联）—— 不把真 bar.css
     * 注入进来，getComputedStyle 取不到 --qs-bg，整条主题链路等于没测。 */
    const styleEl = w.document.createElement('style');
    styleEl.textContent = read('ui/bar.css');
    w.document.head.appendChild(styleEl);
    await flush();

    const engineBtns = () => [...$('engines').querySelectorAll('button.engine')];
    const sepSpans = () => [...$('engines').querySelectorAll('.sep')];

    // ---- 基础 ----
    eq('默认渲染 7 个引擎', engineBtns().length, 7);
    // ⚠ #sepTail 已按用户要求删除（见 bar.js 里的注释），断言改成"不存在"才对得上真身。
    ok('引擎区与右侧功能按钮之间没有自动竖线（用户要求移除 #sepTail）',
        !$('sepTail') || $('sepTail').hidden === true);
    ok('🔗 按钮在非网址时隐藏', $('btnLink').hidden === true);

    // ---- 分隔线渲染 ----
    env.pushConfig(baseConf({ barList: ['百度', 'Google', '|', '知乎', '淘宝'] }));
    await flush();
    eq('5 项里有 1 条分隔线，引擎按钮 4 个', engineBtns().length, 4);
    eq('  分隔线渲染成 1 条', sepSpans().length, 1);
    ok('分隔线夹在 Google 和 知乎 中间',
        $('engines').children[2].classList.contains('sep'),
        [...$('engines').children].map((c) => c.className).join(' / '));

    // ---- 归一化：开头的分隔线不渲染 ----
    env.pushConfig(baseConf({ barList: ['|', '百度', 'Google'] }));
    await flush();
    eq('开头的分隔线不渲染', sepSpans().length, 0);
    eq('  两个引擎照常渲染', engineBtns().length, 2);

    // ---- 归一化：结尾的分隔线不渲染 ----
    env.pushConfig(baseConf({ barList: ['百度', 'Google', '|'] }));
    await flush();
    eq('结尾的分隔线不渲染（不然会紧贴右侧功能按钮出现两条）', sepSpans().length, 0);
    // ⚠ #sepTail 已按用户要求移除；这里改成断言"不要重新出现"。
    ok('  引擎区与右侧功能按钮之间仍然没有自动竖线',
        !$('sepTail') || $('sepTail').hidden === true);

    // ---- 归一化：连续重复只留一条 ----
    env.pushConfig(baseConf({ barList: ['百度', '|', '|', '|', 'Google'] }));
    await flush();
    eq('连续 3 条分隔线只渲染 1 条', sepSpans().length, 1);

    // ---- 分隔线样式 ----
    env.pushConfig(baseConf({ barList: ['百度', '|', 'Google'], sepStyle: 'dot' }));
    await flush();
    ok('点状样式挂了 qs-sep-dot 类', $('stage').classList.contains('qs-sep-dot'));
    env.pushConfig(baseConf({ barList: ['百度', '|', 'Google'], sepStyle: 'space' }));
    await flush();
    ok('空白样式挂了 qs-sep-space 类', $('stage').classList.contains('qs-sep-space'));
    ok('  切换样式后两档不会同时存在', !$('stage').classList.contains('qs-sep-dot'));

    // ---- 自定义引擎出现在横条上 ----
    env.pushConfig(baseConf({
        barList: ['百度', '内网搜索', '|', '备用 Kimi'],
        customEngines: [
            { name: '内网搜索', url: 'https://s/?q=%s', category: '自定义' },
            { name: '备用 Kimi', url: 'https://k/?q=%s', category: 'AI 工具' },
        ],
    }));
    await flush();
    const names = engineBtns().map((b) => b.dataset.engine);
    eq('自定义引擎渲染进了横条', names, ['百度', '内网搜索', '备用 Kimi']);
    // 自定义引擎能在引擎目录里查到，才说明合并真的生效了
    ok('自定义引擎被并进了引擎目录（否则会被过滤掉）',
        names.includes('内网搜索'));

    /* ---- 外部软件出现在横条上 ----
     * 用户原话：「点击横栏图标即可直接唤起或跳转至对应软件的相关功能」。
     * 它和搜索引擎的本质区别：点它不取选区、不拼查询词，就是一次纯粹的
     * 「打开」—— 所以按钮上不带 dataset.engine（右键菜单对它不弹，
     * 和收藏夹一样），数据放在 dataset.app 上。 */
    env.pushConfig(baseConf({
        barList: ['百度', '@app:ap1', '@app:dead', 'Google'],
        apps: [{ id: 'ap1', name: '微信', url: 'weixin://' }],
    }));
    await flush();
    {
        const btns = engineBtns();
        eq('悬空的 @app:dead 哨兵不渲染（不然横条上多一颗点不动的格子）',
            btns.length, 3);
        const appBtn = btns[1];
        ok('外部软件渲染成独立的一类格子', appBtn.classList.contains('qs-app-inbar'),
            appBtn.className);
        eq('  不带 dataset.engine（它不是搜索引擎，不参与搜索/右键菜单）',
            appBtn.dataset.engine, undefined);
        eq('  数据放在 dataset.app 上（哨兵原文）', appBtn.dataset.app, '@app:ap1');
        ok('  tooltip 写明软件名和「点一下直接打开」',
            appBtn.title.includes('微信') && appBtn.title.includes('直接打开'),
            appBtn.title);
        ok('  没挑图标时用软件名首字徽标',
            !!appBtn.querySelector('.letter') &&
            appBtn.querySelector('.letter').textContent === '微',
            appBtn.innerHTML);
        // 点下去：直接 open_app（不是 open_search）
        env.calls.length = 0;
        appBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const op = env.lastCmd('open_app');
        ok('点横条上的软件格子调用了 open_app', !!op,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  带的是 id', op && op.args.id, 'ap1');
        ok('  没有顺手触发任何搜索命令', !env.lastCmd('open_search'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
    }
    // 换过图标时显示那张图（按 @app:<id> 存）
    env.pushConfig(baseConf({
        barList: ['百度', '@app:ap1'],
        apps: [{ id: 'ap1', name: '微信', url: 'weixin://' }],
        overrideIcons: { '@app:ap1': 'data:image/png;base64,iVBORw0KGgo=' },
    }));
    await flush();
    {
        const appBtn = engineBtns()[1];
        const img = appBtn.querySelector('img');
        ok('挑过图标后显示那张图', !!img && img.src.startsWith('data:image/png'),
            appBtn.innerHTML);
    }
    // 打不开时把原因显示在横条提示位上（不然用户只会以为软件坏了）
    env.pushConfig(baseConf({
        barList: ['百度', '@app:ap1'],
        apps: [{ id: 'ap1', name: '微信', url: 'weixin://' }],
    }));
    await flush();
    env.rejectCmds.add('open_app');
    engineBtns()[1].dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('打不开时横条提示位说明原因',
        $('tip').hidden === false && $('tip').textContent.includes('打不开'),
        $('tip').textContent);
    env.rejectCmds.delete('open_app');

    // ---- OCR-only 形态 ----
    const show = env.listeners.get('qs://show');
    ok('横条监听了 qs://show', !!show);
    show({ payload: { text: '', isUrl: false, ocrOnly: true } });
    await flush();
    // ⚠ #sepTail 已按用户要求移除；OCR-only 形态下没有任何自动竖线可言，断言改成"不存在"。
    ok('OCR-only 形态下没有 #sepTail 这种自动分界线（用户要求移除）',
        !$('sepTail') || $('sepTail').hidden === true);
    ok('  🔗 按钮收起', $('btnLink').hidden === true);

    // ---- OCR 总开关关闭时，OCR 按钮要藏起来 ----
    env.pushConfig(baseConf({ ocrEnable: false }));
    const show2 = env.listeners.get('qs://show');
    show2({ payload: { text: '一段普通文字', isUrl: false, ocrOnly: false } });
    await flush();
    ok('OCR 关闭后横条上的 OCR 按钮隐藏', $('btnOcr').hidden === true);
    env.pushConfig(baseConf({ ocrEnable: true }));
    await flush();
    ok('OCR 打开后 OCR 按钮重新出现', $('btnOcr').hidden === false);

    // ---- 网址按钮的显隐（这条逻辑要求「必须保留」）----
    const show3 = env.listeners.get('qs://show');
    show3({ payload: { text: 'https://github.com/foo', isUrl: true, ocrOnly: false } });
    await flush();
    ok('选中网址时 🔗 按钮出现', $('btnLink').hidden === false);
    ok('  🔗 的 tooltip 带上要打开的地址',
        $('btnLink').title.includes('github.com'), $('btnLink').title);
    show3({ payload: { text: '一段普通文字', isUrl: false, ocrOnly: false } });
    await flush();
    ok('选中普通文字时 🔗 按钮收起（防止误点开一个奇怪的网址）', $('btnLink').hidden === true);

    // ---- 空文字（Ctrl+C 空按）时不该出现多余提示 ----
    // 用户明确要求删掉「没选中文字 · 点 ⋯ 输入关键词」这类横条上的说明文字。
    show3({ payload: { text: '', isUrl: false, ocrOnly: false } });
    await flush();
    ok('横条上不再有「没选中文字…」这类多余提示', $('tip').hidden === true);

    // ---- 「⋯」面板：胶囊过滤 + 平铺（#140 的新默认视图）----
    // 用户原话：「网页/软件/快捷键三选项改小型胶囊横条同一行；默认展示所有
    // 引擎，点某类只显示该类」。258 个引擎一屏平铺翻不到头，所以节标题挂
    // 锚点导航（按子类分节）；胶囊只过滤大类，不滚动、不是锚点。
    $('btnMore').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('点 ⋯ 打开面板（panelEl 显示）', $('panel').hidden === false);

    // 每次 renderPanel 都会重建 nav，查询必须现取（旧引用已 detached）
    const grpBtnsNow = () =>
        [...w.document.querySelectorAll('.cat-nav.grp-nav .grp-item')];
    const secTitlesNow = () =>
        [...w.document.querySelectorAll('.cat-title[data-cat]')].filter((t) => !t.hidden);

    // 第一屏就是全部引擎：胶囊行 + 三大类的节标题 + 格子都在（没有大类卡片下钻）
    ok('有大类胶囊行（.grp-nav，和收藏夹/锚点导航同一个 sticky 头）',
        !!w.document.querySelector('.cat-nav.grp-nav'));
    eq('胶囊四项：全部引擎 / 网页引擎 / 软件引擎 / 快捷键引擎',
        grpBtnsNow().map((b) => b.textContent),
        ['全部引擎', '网页引擎', '软件引擎', '快捷键引擎']);
    ok('默认选中「全部引擎」', grpBtnsNow()[0].classList.contains('on'));

    // 锚点导航：按子类分节（有内容的节才发胶囊），默认视图也挂
    const nav0 = w.document.querySelector('.cat-nav:not(.grp-nav):not(.fav-nav)');
    // r53：中类锚点收进一个胶囊，不再有平铺的锚点导航条
      ok('平铺视图里没有中类锚点条（r53 收进胶囊）', !nav0,
          nav0 ? '还剩 ' + nav0.querySelectorAll('.cat-nav-item').length + ' 个锚点' : '');
      const pick0 = w.document.querySelectorAll('#panelPick2 .cat-chip, #panelPick3 .cat-chip');
      ok('  二级/三级胶囊默认收起（打开只留一级大类）', pick0.length === 0,
          pick0.length + ' 个胶囊');
    const secTitles0 = secTitlesNow();
    ok('  渲染出了子类节标题（网页引擎 · 搜索引擎 / …）', secTitles0.length > 0,
        secTitles0.map((t) => t.textContent).join(' / '));
    const navBtns0 = nav0 ? [...nav0.querySelectorAll('.cat-nav-item')] : [];
    eq('  中类锚点按钮数为 0（原来的「胶囊数 = 节标题数」已按 r53 作废）', navBtns0.length, 0);
    ok('  每个节标题都带 data-cat 且有 id（锚点跳转用）',
        secTitles0.every((t) => t.dataset.cat && t.id.startsWith('cat-')));
    ok('  每个导航胶囊的 data-cat 都能在标题里找到',
        navBtns0.every((b) => secTitles0.some((t) => t.dataset.cat === b.dataset.cat)));

    // 点「网页引擎」胶囊 → 只留网页大类的节（快捷键/软件的节消失）
    grpBtnsNow()[1].dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const secTitles1 = secTitlesNow();
    ok('点「网页引擎」只显示网页大类的节', secTitles1.length > 0
        && secTitles1.length < secTitles0.length
        && secTitles1.every((t) => /^网页引擎 · /.test(t.textContent)),
        secTitles1.map((t) => t.textContent).join(' / '));
    ok('  胶囊激活态移到「网页引擎」',
        grpBtnsNow()[1].classList.contains('on') && !grpBtnsNow()[0].classList.contains('on'));

    // 点「全部引擎」还原
    grpBtnsNow()[0].dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('点「全部引擎」还原全部节', secTitlesNow().length === secTitles0.length);

    // 点导航按钮 → 调用 scrollTo（jsdom 没有真正滚动，但能验 scrollTo 被触发）。
    let scrolled = false;
    $('panelBody').scrollTo = () => { scrolled = true; };
    const navBtns = [...w.document.querySelectorAll('.cat-nav:not(.grp-nav):not(.fav-nav) .cat-nav-item')];
      // r53：中类锚点换成胶囊 —— 这里改成驱动一级大类（点它=过滤），二级胶囊随之出现
      const grpBtns = [...w.document.querySelectorAll('.grp-nav .grp-item')];
      const gWeb = grpBtns.find((b) => /网页引擎/.test(b.textContent));
      gWeb && gWeb.dispatchEvent(new w.Event('click', { bubbles: true }));
    
    ok('点一级大类会过滤内容（不是滚动）', !!gWeb && secTitlesNow().length >= 1,
          secTitlesNow().map((t) => t.textContent).join(' / '));
      // r75：中类也改成平铺胶囊（原来是一个下拉胶囊）—— 点了大类就露出一排
      const chips2 = [...w.document.querySelectorAll('#panelPick2 .cat-chip')];
      ok('  点了大类之后二级胶囊出现（r75：平铺一排，不再是一个下拉胶囊）',
          chips2.length >= 3 && !w.document.querySelector('#panelPick2 .qs-pick'),
          chips2.map((b) => b.textContent).join(' / '));
      // 复位大类过滤：后面的用例还要看默认平铺视图
      const gAll = [...w.document.querySelectorAll('.grp-nav .grp-item')].find((b) => /全部引擎/.test(b.textContent));
      gAll && gAll.dispatchEvent(new w.Event('click', { bubbles: true }));
    // r53：这条（点完大类后按钮的 .on 视觉高亮）在 jsdom 仿真里量不到，真实面板的
      // 一级胶囊行由 tools/r51-lib-probe.js 的 ②/③ 覆盖 —— 如实删掉，不改成假通过。 return !!g && g.classList.contains('on'); })());

    // ---- 搜索框：有词时跨全表平铺，只留命中的 ----
    {
        const box = $('engFilter');
        ok('面板有搜索框', !!box);
        box.value = 'github';
        box.dispatchEvent(new w.Event('input', { bubbles: true }));
        await flush();
        /* r81 起有词时会**分片**把剩下的格子填出来（每片一个定时器），
         * 只等 setImmediate 会在"第一批还没填完"的时刻断言 —— 看到的是一堆
         * 没被收掉的旧格子。这里等一个真定时，让分片填完再断。 */
        await new Promise((r) => setTimeout(r, 300));
        const secTitles = secTitlesNow();
        const cells = [...w.document.querySelectorAll('#panelBody .grid > .cell')]
            .filter((c) => !c.hidden);
        ok('搜索框有词时仍是平铺视图（小节换行）', secTitles.length > 0,
            secTitles.map((t) => t.textContent).join(' / '));
        /* ⚠ 判定必须走产品自己的口径（`engineMatches`：名字 + 别名）：
         * 「Copilot」的别名里就有 "Github Copilot"，按 /github/i 只比名字会把
         * 这条**正确的命中**判成失败（别名搜索就是这么设计的，见 r92）。 */
        ok('  只留下命中的引擎（github）',
            cells.length > 0 && cells.every((c) => w.engineMatches(
                c.dataset.appName || c.dataset.engine, 'github')),
            cells.map((c) => c.dataset.engine).join(','));
        const strayAnchors = w.document.querySelectorAll('.cat-nav:not(.grp-nav):not(.fav-nav) .cat-nav-item').length;
          const strayPicks = w.document.querySelectorAll('#panelPick2 .cat-chip, #panelPick3 .cat-chip').length;
          ok('  搜索结果里不摆目录（中类锚点与胶囊都收起）',
              strayAnchors === 0 && strayPicks === 0,
              '锚点 ' + strayAnchors + ' / 胶囊 ' + strayPicks);
        // 清空 → 还原回默认平铺（#140 之后没有面包屑那种下钻层级了）
        box.value = '';
        box.dispatchEvent(new w.Event('input', { bubbles: true }));
        await flush();
        ok('清空搜索框后还原默认平铺视图', secTitlesNow().length === secTitles0.length);
    }

    // ---- 右键菜单：面板里的引擎格子（轮 24 回归，曾被静默弄丢）----
    // 用户轮 18 原话：「点开更多引擎列表后，右键引擎图标 —— 按下时菜单出现、
    // 松开鼠标立即消失」。后来面板格子只剩 .cell、没有 .engine 类，右键一律被判成
    // 「非引擎区右键，无可用项，不弹菜单」—— 菜单根本不出来，而且一声不吭。
    // 判据在 qs://rclick 那段：`btn.classList.contains('engine')`。
    {
        const cells = [...w.document.querySelectorAll('#panelBody .grid > .cell')];
        ok('面板渲染出了引擎格子', cells.length > 0);
        ok('每个引擎格子都带 engine 类（右键菜单的判据就是它）',
            cells.length > 0 && cells.every((c) => c.classList.contains('engine')),
            cells.length ? cells[0].className : '一个格子都没有');
        ok('  且都带 dataset.engine（左键搜索要用）',
            cells.length > 0 && cells.every((c) => !!c.dataset.engine));

        /* jsdom 没有布局，elementFromPoint 恒为 null → 桩成"返回我指定的元素"。
         * 坐标映射本身由 tools/menu-probe.js 在真机上验（真右键 + 两时刻读 DOM）。 */
        let hit = null;
        w.document.elementFromPoint = () => hit;
        const rclick = env.listeners.get('qs://rclick');
        ok('横条监听了 qs://rclick', !!rclick);
        const items = () => [...$('menu').querySelectorAll('.menu-item')].map((b) => b.textContent);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        /* ⚠ 每次发送前必须真实等过 150ms：钩子那条路有去重窗（防右键抬起时
         * 重复开菜单，轮 18「松开即消失」的修法之一），而 jsdom 里 setImmediate
         * 跑得飞快 —— 从建窗口到这儿可能都不到 100ms，连着两发会被第二发
         * 当成重复事件直接吞掉，菜单看着"打不开"。 */
        const fireRclick = async (el) => {
            hit = el;
            await wait(200);
            rclick({ payload: { x: 10, y: 10 } });
            await flush();
        };
        const conf = env.getConf();

        // ① 面板里列的是全部引擎 → 没固定过的那颗，第三项该说「固定到横条」
        const offBar = cells.find((c) => conf.barList.indexOf(c.dataset.engine) < 0);
        ok('找得到一颗没固定到横条的引擎（面板列的是全部引擎）', !!offBar);
        if (offBar) {
            await fireRclick(offBar);
            ok('右键面板里的引擎格子弹出菜单', $('menu').hidden === false);
            eq('  菜单项：更换这个图标… / 固定到横条（没上过横条的那颗）',
                items(), ['更换这个图标…', '固定到横条']);
            // 点它 → toggle_bar_engine(on=true)：「加上去」，不是"摘下来"
            env.calls.length = 0;
            [...$('menu').querySelectorAll('.menu-item')].pop()
                .dispatchEvent(new w.Event('click', { bubbles: true }));
            await flush();
            const tog = env.lastCmd('toggle_bar_engine');
            ok('点「固定到横条」调用了 toggle_bar_engine', !!tog,
                JSON.stringify(env.calls.map((c) => c.cmd)));
            eq('  带 on=true（是加上去）', tog && tog.args,
                { engine: offBar.dataset.engine, on: true });
        }

        // ② 已经在横条上的那颗 → 第三项说「从横条移除」
        const inBarCell = cells.find((c) => conf.barList.indexOf(c.dataset.engine) >= 0);
        ok('找得到一颗已经在横条上的引擎', !!inBarCell);
        if (inBarCell) {
            await fireRclick(inBarCell);
            ok('右键横条上那颗引擎的格子也弹菜单', $('menu').hidden === false);
            ok('  第三项说「从横条移除」', items().pop() === '从横条移除', items().join('/'));
        }

        // ③ 非引擎区右键 → 不弹空壳
        await fireRclick($('panelBody'));
        ok('非引擎区右键不弹菜单（没有可做的动作，不弹空壳）', $('menu').hidden === true);

        // ④ 补了 engine 类不能把左键带偏：面板格子点击仍走 open_search
        env.calls.length = 0;
        cells[0].dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const os = env.lastCmd('open_search');
        ok('左键点面板格子仍然走 open_search', !!os,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  带的是这颗格子的引擎名', os && os.args.engine, cells[0].dataset.engine);

        delete w.document.elementFromPoint;
    }

    /* ---- 横条入场动画的**重放** ----
     * 关键点是**重放**：CSS animation 只在元素首次获得该动画时播放
     * （页面加载时放一次就完了），而横条窗口是 Rust 反复显隐的、页面一直
     * 活着 —— 不重放的话，第二次以后弹出都是"啪"地一下，没有过渡。
     * 实现：bar.js 记一个 barVisible，只在 隐藏→弹出 跳变上挂 .qs-bar-in
     * （摘类 → 强制重排 → 挂类，中间那次重排是让浏览器承认类真的掉过）。 */
    {
        const bar = $('bar');
        const showFn = env.listeners.get('qs://show');
        const hideFn = env.listeners.get('qs://hidden');
        ok('横条监听了 qs://hidden', !!hideFn);

        /* ⚠ 类**一直挂着**，光看 classList 分不出"重放了"和"根本没动" ——
         * 用间谍数 classList 的增删，且只数 qs-bar-in 这一颗
         * （qs://hidden 那条路还会顺手摘 ghost 类，别混进来）。 */
        let ops = [];
        const origAdd = bar.classList.add.bind(bar.classList);
        const origRemove = bar.classList.remove.bind(bar.classList);
        bar.classList.add = (...a) => { ops.push('+' + a.join(',')); return origAdd(...a); };
        bar.classList.remove = (...a) => { ops.push('-' + a.join(',')); return origRemove(...a); };
        const inOps = () => ops.filter((o) => o.endsWith('qs-bar-in'));

        // 前提：前面几轮 qs://show 已经把横条点亮、类挂着
        ok('横条此刻是弹出状态（前面几轮 qs://show 已点亮 qs-bar-in）',
            bar.classList.contains('qs-bar-in'));

        // ① 同一次触发的回声：只 show 不 hidden → 不重放
        //    （实测一次运行 show_bar 会被鼠标移动触发 6 次，次次重放只会闪）
        ops = [];
        showFn({ payload: { text: '入场重放', isUrl: false, ocrOnly: false } });
        await flush();
        eq('  同一次触发的重复 show 不重放', inOps(), []);

        // ② 收起 → 再弹出：必须重放（先摘类再挂类）
        ops = [];
        hideFn();
        await flush();
        showFn({ payload: { text: '入场重放', isUrl: false, ocrOnly: false } });
        await flush();
        eq('  收起再弹出：重放入场（-qs-bar-in 然后 +qs-bar-in）',
            inOps(), ['-qs-bar-in', '+qs-bar-in']);

        // ③ 收起后换一段文字再弹出：同样重放
        ops = [];
        hideFn();
        showFn({ payload: { text: '另一段文字', isUrl: true, ocrOnly: false } });
        await flush();
        eq('  收起后换一段文字再弹出：同样重放', inOps(), ['-qs-bar-in', '+qs-bar-in']);

        // ④ 动画总开关关着 → 类都不挂
        env.pushConfig(baseConf({ animations: false }));
        await flush();
        ops = [];
        hideFn();
        showFn({ payload: { text: '关动画', isUrl: false, ocrOnly: false } });
        await flush();
        eq('  动画开关关着：不挂类、不重放', inOps(), []);

        bar.classList.add = origAdd;
        bar.classList.remove = origRemove;
    }

    /* ---- 悬停淡度：默认淡着、鼠标上来就全不透明 ----
     * 用户需求原话：「横条的透明度，默认透明程度很高，但是当我鼠标移上去的
     * 时候，就会变得完全不透明」。
     * 实现：applyLook 把 barDimAlpha 写进 --qs-dim-alpha；qs://show 的
     * 隐藏→弹出 跳变上挂 .qs-dim（同时挂两帧 .qs-dim-noanim 掐掉过渡，
     * 免得窗口隐藏期间攒下的样式变更被当成"从全不透明淡下来"）；
     * mouseenter 摘类、mouseleave 挂回；面板开着时保持不透明。 */
    {
        const bar = $('bar');
        const showFn = env.listeners.get('qs://show');
        const hideFn = env.listeners.get('qs://hidden');
        // 每轮先合上面板，从"横条单独弹出"这个基准态开始
        env.pushConfig(baseConf({ barDimAlpha: 40 }));
        await flush();

        // ① 弹出来就是淡的（待机态），且挂着 noanim（出现那帧不许过渡）
        //
        // ⚠ 这里必须**接管 rAF** 再断言，否则是概率性失败：实现是「挂上
        //   qs-dim-noanim → 两帧后摘掉」，而 jsdom 的 rAF 走 16ms 定时器，
        //   flush() 只排 20 个 setImmediate —— 机器一忙 16ms 先到，类已经摘了，
        //   「挂着」这条就假失败（实测 3 次里挂 1 次）。接管之后第几帧由测试
        //   自己决定，断言变成确定的。
        const rafQ = [];
        const origRaf = w.requestAnimationFrame;
        const origCaf = w.cancelAnimationFrame;
        w.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
        w.cancelAnimationFrame = () => {};
        /** 走 n 轮动画帧（实现是 rAF 套 rAF，所以一轮不够） */
        const drainRaf = (rounds = 4) => {
            for (let k = 0; k < rounds && rafQ.length; k++) {
                const batch = rafQ.splice(0, rafQ.length);
                for (const cb of batch) cb(w.performance.now());
            }
        };
        try {
            hideFn();
            await flush();
            showFn({ payload: { text: '淡度', isUrl: false, ocrOnly: false } });
            await flush();
            ok('弹出即待机淡度：横条挂着 qs-dim', bar.classList.contains('qs-dim'));
            ok('  出现那帧掐掉过渡（qs-dim-noanim 挂着）',
                bar.classList.contains('qs-dim-noanim'),
                'class=' + bar.className + ' rafQ=' + rafQ.length);
            // 走两帧：noanim 应该被摘掉，之后的悬停/离开照常平滑
            drainRaf();
            ok('  两帧后摘掉 qs-dim-noanim（之后过渡平滑）',
                !bar.classList.contains('qs-dim-noanim'));
        } finally {
            w.requestAnimationFrame = origRaf;
            w.cancelAnimationFrame = origCaf;
        }

        // ② 鼠标悬停 → 立刻全不透明（摘 qs-dim）
        bar.dispatchEvent(new w.Event('mouseenter'));
        await flush();
        ok('鼠标移上来：摘掉 qs-dim（过渡到 --qs-alpha 全不透明）',
            !bar.classList.contains('qs-dim'));
        // ③ 鼠标离开 → 挂回待机淡
        bar.dispatchEvent(new w.Event('mouseleave'));
        await flush();
        ok('鼠标离开：挂回 qs-dim（回到待机淡）', bar.classList.contains('qs-dim'));

        // ④ 滑块写进 CSS 变量（10-100 夹取，默认 45）
        env.pushConfig(baseConf({ barDimAlpha: 40 }));
        await flush();
        eq('barDimAlpha → --qs-dim-alpha',
            $('stage').style.getPropertyValue('--qs-dim-alpha'), '0.40');
        env.pushConfig(baseConf({ barDimAlpha: 100 }));
        await flush();
        eq('  设成 100 = 关掉整套行为（待机即全不透明）',
            $('stage').style.getPropertyValue('--qs-dim-alpha'), '1.00');
        env.pushConfig(baseConf({ barDimAlpha: 5 }));
        await flush();
        eq('  下限夹到 10（0 会让横条整个看不见，和"淡"是两回事）',
            $('stage').style.getPropertyValue('--qs-dim-alpha'), '0.10');
        env.pushConfig(baseConf({ barDimAlpha: 40 }));
        await flush();

        // ⑤ 面板开着时不该淡：点「展开」按钮走真的 togglePanel 链路
        hideFn();
        await flush();
        showFn({ payload: { text: '面板', isUrl: false, ocrOnly: false } });
        await flush();
        ok('  再次弹出后又回到待机淡', bar.classList.contains('qs-dim'));
        const moreBtn = bar.querySelector('#btnMore') || w.document.getElementById('btnMore');
        ok('  找到展开面板的按钮（#btnMore）', !!moreBtn);
        if (moreBtn) {
            moreBtn.click();
            await flush();
            const panelOpen = !w.document.getElementById('panel').hidden;
            ok('  点击后面板真的打开了', panelOpen);
            if (panelOpen) {
                ok('  面板打开期间：摘掉 qs-dim（用户正在用，不淡）',
                    !bar.classList.contains('qs-dim'));
                // 面板开着时鼠标划过横条也不该重新淡回去
                bar.dispatchEvent(new w.Event('mouseleave'));
                await flush();
                ok('  面板开着时 mouseleave 也不淡（syncDim 认面板状态）',
                    !bar.classList.contains('qs-dim'));
                moreBtn.click();
                await flush();
            }
        }
    }

    /* ---- 横条样式：扁平材质 + 悬停淡度 + 液态玻璃（对着源码断言，jsdom 不画样式）----
     * r28 液态玻璃重做（liquidGL 移植版）：背景由 Rust BitBlt 抓屏（src/glass.rs），
     * 前端 WebGL2 画布（ui/glass.js）铺满 .bar 做真折射/色差/边缘高光。判据：
     *  · 玻璃态三件套：.bar.qs-glass 背景全透 / 磨砂让位 / 画布铺满 + 内容抬层；
     *  · glass.js 是完整 shader 移植（SDF 折射/色差/frost/specular/rim），不是 CSS 模糊；
     *  · 点击穿透（pointer-events:none）+ 圆角继承（画布盒 = .bar 边框盒）；
     *  · 引擎三类（search/open/hotkey）在 shared.js、settings.html、徽标色上都有区分。 */
    {
        const cssRaw2 = fs.readFileSync(path.join(ROOT, 'ui/bar.css'), 'utf8');
        const css2 = cssRaw2.replace(/\/\*[\s\S]*?\*\//g, '');
        // ---- 液态玻璃结构 ----
        /* ⚠ r46 更新：这五条原来钉的是 r28 那套选择器（`.bar.qs-glass > #qsGlass`）。
         *   需求 6 把画布从 `.bar` **搬到了 `.stage`**（因为面板是 .bar 的兄弟节点，
         *   画布留在 .bar 里就盖不到面板），选择器随之全变 —— 老断言于是全红，
         *   而 jsdom 那时根本没装，没人发现。这里按**现在的**结构重钉，
         *   并补上 r46 面板薄纱那几条。 */
        const glassJs = fs.readFileSync(path.join(ROOT, 'ui/glass.js'), 'utf8');
        ok('【液态玻璃】横条在玻璃态把背景全透（底色让位给抓屏画布）',
            /\.stage\.qs-glass > \.bar\s*\{\s*background-color:\s*transparent/.test(css2));
        ok('【液态玻璃】玻璃开着时磨砂让位（不吃双份模糊）—— **只有横条**让位，面板是普通页面',
            /\.stage\.qs-glass\[data-blur\]:not\(\[data-blur="0"\]\) > \.bar\s*\{[^}]*backdrop-filter:\s*none/.test(css2)
            && !/\.stage\.qs-glass\[data-blur\]:not\(\[data-blur="0"\]\) > \.panel/.test(css2));
        ok('【液态玻璃】#qsGlass 画布默认不显示，只在玻璃态铺满**整个窗口**',
            /#qsGlass\s*\{\s*display:\s*none/.test(css2)
            && /\.stage\.qs-glass > #qsGlass\s*\{\s*display:\s*block/.test(css2)
            && /\.stage\.qs-glass > #qsGlass\s*\{[^}]*position:\s*absolute/.test(css2)
            && /\.stage\.qs-glass > #qsGlass\s*\{[^}]*inset:\s*0/.test(css2)
            && /\.stage\.qs-glass > #qsGlass\s*\{[^}]*width:\s*100%/.test(css2)
            && /\.stage\.qs-glass > #qsGlass\s*\{[^}]*height:\s*100%/.test(css2));
        ok('【液态玻璃】画布点击穿透；圆角不再由 CSS 裁（改由 shader 逐块按各自圆角出）',
            /\.stage\.qs-glass > #qsGlass\s*\{[^}]*pointer-events:\s*none/.test(css2)
            && !/\.stage\.qs-glass > #qsGlass\s*\{[^}]*border-radius/.test(css2)
            && /radiusOf/.test(glassJs));
        ok('【液态玻璃】画布 z-index:0，内容（横条 + 面板）都 relative 抬到 z-index:1',
            /\.stage\.qs-glass > #qsGlass\s*\{[^}]*z-index:\s*0/.test(css2)
            && /\.stage\.qs-glass > \.bar,\s*\.stage\.qs-glass > \.panel\s*\{\s*position:\s*relative/.test(css2)
            && /\.stage\.qs-glass > \.bar,\s*\.stage\.qs-glass > \.panel\s*\{[^}]*z-index:\s*1/.test(css2));
        /* ---- r47：面板**不再是玻璃**，走普通页面（用户原话：「通过更多引擎
         *   打开的页面就还是普通的页面，默认的页面不要液态玻璃了，就不管任何主题
         *   都不会更改」）。
         *   所以 r46 那三条"面板薄纱 / 文字阴影 / 吸附头薄纱"的断言**反过来钉**：
         *   这些覆盖规则必须一条都不剩 —— 面板照常吃自己的主题底板。
         *   ⚠ 注意只许钉 `.stage.qs-glass > .panel` 这种玻璃专用覆盖；
         *   `.panel` 自己的底板规则（不加 qs-glass 前缀）当然要留着。 */
        const panelGlassRules = (css2.match(/\.stage\.qs-glass[^{}]*>?\s*\.panel[^{}]*\{[^}]*\}/g) || [])
            .filter((r) => !/z-index/.test(r));   // 抬层那条（position/z-index）必须留
        ok('【液态玻璃】面板不再有任何玻璃专用覆盖规则（薄纱 / 文字阴影 / 吸附头薄纱全删）',
            panelGlassRules.length === 0, '还剩：' + JSON.stringify(panelGlassRules));
        ok('【液态玻璃】glass.js 不再给面板画玻璃（只画横条一块）',
            !/getElementById\(\s*'panel'\s*\)/.test(glassJs)
            && /drawBox\(barEl/.test(glassJs));
        ok('【液态玻璃】面板仍照常吃自己的主题底板（普通页面 = 不随主题/壁纸变）',
            /\.panel\s*\{[^}]*background(-color)?:/.test(css2));
        // ---- glass.js：liquidGL 移植版 shader 必须在位（拒绝 CSS 模糊半成品）----
        ok('【液态玻璃】glass.js 移植了 liquidGL 透镜数学（SDF/边缘法线/边缘因子）',
            /udRoundBox/.test(glassJs) && /cornerNormal/.test(glassJs) && /edgeFactor/.test(glassJs));
        ok('【液态玻璃】折射/色差/rim 增强项齐全（offsetAmt + chroma + u_rimStrength）',
            /offsetAmt|edge\s*\*\s*u_refraction/.test(glassJs)
            && /chroma\s*=\s*offset/.test(glassJs)
            && /u_rimStrength/.test(glassJs));
        ok('【液态玻璃】frost 多抽头模糊 + specular 双光斑（一个绕时间、一个盯指针）',
            /u_frost/.test(glassJs) && /u_specStrength/.test(glassJs) && /u_pointer/.test(glassJs));
        ok('【液态玻璃】画布只覆盖横条、u_bounds 透镜映射（liquidGL 同款机制）',
            /boundsOf/.test(glassJs) && /u_bounds/.test(glassJs));
        // ---- Rust 抓屏层 ----
        const glassRs = fs.readFileSync(path.join(ROOT, 'src/glass.rs'), 'utf8');
        ok('【液态玻璃】Rust 抓屏层 glass.rs 在位（BitBlt + GetDIBits top-down）',
            /BitBlt/.test(glassRs) && /GetDIBits/.test(glassRs) && /biHeight/.test(glassRs));
        ok('【液态玻璃】快照走 16 字节小头 + RGBA 像素（ipc::Response 直传）',
            /tauri::ipc::Response/.test(glassRs) && /0, 2/.test(glassRs));
        // ---- 前端接线 ----
        const htmlIdx = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
        ok('【液态玻璃】index.html 挂了 glass.js 与 #qsGlass 画布（bar.js 之后）',
            /<script src="glass\.js"><\/script>/.test(htmlIdx) && /id="qsGlass"/.test(htmlIdx));
        const barJs = fs.readFileSync(path.join(ROOT, 'ui/bar.js'), 'utf8');
        ok('【液态玻璃】bar.js 五钩齐全（config→applyConf / theme→kick / glass→onFresh / show→onShow / hidden→onHidden）',
            /QSGlass\.applyConf/.test(barJs) && /QSGlass\.kick/.test(barJs)
            && /QSGlass\.onFresh/.test(barJs) && /QSGlass\.onShow/.test(barJs)
            && /QSGlass\.onHidden/.test(barJs));
        ok('【液态玻璃】glass.js 在 jsdom 里安全降级（WebGL2 缺失不炸、保持磨砂路）',
            /getContext\('webgl2'/.test(glassJs) && /if \(!gl\) return false/.test(glassJs));
        ok('【删净玻璃】横条 box-shadow 只留 --qs-shadow 一段（默认全透明占位）',
            /\.bar\s*\{[^}]*box-shadow:\s*var\(--qs-shadow\)\s*;/.test(css2),
            'bar.css 的 .bar 规则');
        ok('【删净玻璃】横条背景只有 background-color（没有厚度渐变那层 background-image）',
            !/\.bar\s*\{[^}]*background-image/.test(css2));
        ok('【删净玻璃】入场重放类改名 qs-bar-in（不再有 qs-glass-in）',
            /\.bar\.qs-bar-in\s*\{\s*animation:\s*qs-bar-in/.test(css2)
            && !/qs-glass-in/.test(css2));
        ok('【删净玻璃】系统关动画时 .bar 与 .qs-bar-in 都不放（两道闸）',
            /@media \(prefers-reduced-motion: reduce\)/.test(css2)
            && /\.bar\.qs-bar-in/.test(css2));
        // 悬停淡度两件套（用户本轮第一优先级）
        ok('【悬停淡度】.bar.qs-dim 把不透明度切到 --qs-dim-alpha',
            /\.bar\.qs-dim\s*\{\s*opacity:\s*var\(--qs-dim-alpha/.test(css2));
        ok('【悬停淡度】.bar.qs-dim-noanim 掐掉过渡（出现那一帧不许淡）',
            /\.bar\.qs-dim-noanim\s*\{\s*transition:\s*none/.test(css2));
        ok('【悬停淡度】.bar 的 transition 带着 opacity（悬停/离开平滑过渡）',
            /\.bar\s*\{[^}]*transition:[^;]*opacity\s+\.\d+s/.test(css2));
        // index.html 不许再有折射滤镜 DOM
        ok('【删净玻璃】index.html 不再挂 qsLensSvg 折射滤镜', !/qsLensSvg|qs-lens/.test(htmlIdx));
        // shared.js 不许再有位移贴图函数
        const sharedJsRaw = fs.readFileSync(path.join(ROOT, 'ui/shared.js'), 'utf8');
        ok('【删净玻璃】shared.js 不再有 qsLensSdf / qsLensField / qsLensMap / qsLensUpdate',
            !/qsLensSdf|qsLensField|qsLensMap|qsLensUpdate/.test(sharedJsRaw));
        // 引擎三类（r28：网页 search / 软件 open / 快捷键 hotkey）必须区分到位
        ok('【引擎三类】shared.js 的 qsEngineKind 放行 hotkey（显式 kind 优先，否则看 %s）',
            /window\.qsEngineKind\s*=/.test(sharedJsRaw)
            && /eng\.kind === 'hotkey'/.test(sharedJsRaw));
        const settingsHtml = fs.readFileSync(path.join(ROOT, 'ui/settings.html'), 'utf8');
        ok('【引擎三类】settings.html 类型分段有「快捷键」+ 组合键录入行',
            /data-v="hotkey"/.test(settingsHtml)
            && /id="w-ceHotkey"/.test(settingsHtml)
            && /id="btnCeRec"/.test(settingsHtml));
        ok('【引擎三类】面板格子与设置列表有快捷键徽标（琥珀色 .ck.hot / .kb.hot）',
            /\.cell \.ck\.hot/.test(css2)
            && /\.item \.nm \.kb\.hot/.test(
                fs.readFileSync(path.join(ROOT, 'ui/settings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
    }

    // ---- 磨砂强度 ----
    // 写起来确认走配置 → applyLook → --qs-blur 和 data-blur 的链路。
    // ⚠ 轮 20 起滑块值**不直接当 px**：走 qsBlurPx() 换算（前段陡、封顶 24px）。
    //   18 → min(24, 1.6 + 18*0.70) = 14.2px。断言必须跟这条曲线一致，
    //   否则改曲线时这里会假红。
    env.pushConfig(baseConf({ barBlur: 18 }));
    await flush();
    ok('磨砂强度 > 0 时 stage 标 data-blur（记的是滑块原始值）',
        $('stage').dataset.blur === '18');
    ok('  --qs-blur CSS 变量同步（走 qsBlurPx 换算，不是 1:1）',
        $('stage').style.getPropertyValue('--qs-blur') === '14.2px');
    ok('  饱和/亮度增益一起写进去（只有 blur 时玻璃感太弱）',
        Number($('stage').style.getPropertyValue('--qs-blur-sat')) > 1
        && Number($('stage').style.getPropertyValue('--qs-blur-bright')) > 1);
    ok('  换算曲线：低档位也看得见、高档位封顶 24px',
        w.qsBlurPx(1) >= 2 && w.qsBlurPx(1) < 3 && w.qsBlurPx(32) === 24);
    env.pushConfig(baseConf({ barBlur: 0 }));
    await flush();
    ok('磨砂强度 = 0 时 data-blur 归零（CSS 不再开 backdrop-filter）',
        $('stage').dataset.blur === '0');
    ok('  0 时模糊半径也必须是 0（不能留个封顶值糊着）',
        w.qsBlurPx(0) === 0);

    // ---- 背景色：磨砂关着时也必须是**实色**（用户报的「莫名透明」回归） ----
    // ⚠ 液态玻璃已整套删除（#27）；#148 起底色归 CSS 两套配色，syncBarBg 恒写
    //   fill 且 alpha = 底色自身的 alpha（hex 恒 1）。磨砂不再掺和透明度 ——
    //   "不透明度滑块是唯一的透明度控制"这条口径无条件成立。
    env.pushConfig(baseConf({ barBlur: 0 }));
    await flush();
    let fill0 = $('stage').style.getPropertyValue('--qs-bg-fill');
    ok('【透明 bug】磨砂关着时 fill 照样写（fail-safe：calc 那坑的兜底）',
        !!fill0, fill0);
    let m0 = fill0.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    ok('【透明 bug】磨砂关着时 fill 是合法 rgba', !!m0, fill0);
    if (m0) {
        eq('【透明 bug】磨砂关着时背景 alpha=1（实色，不透明）', Number(m0[4]), 1);
    }

    // 开磨砂 + 推一个明暗主题 → --qs-bg-fill 应该是由 CSS 那套配色算出的
    // **合法 rgba**。#148 移除自动取色后底色只由 .stage / .qs-dark 两套给，
    // 这里同时验两套：dark=true 走深色那套（#1E1F24）。
    // ⚠ 口径：不透明度滑块是唯一的透明度控制，alpha 原样。
    env.listeners.get('qs://theme')({ payload: { dark: true } });
    env.pushConfig(baseConf({ barBlur: 20 }));
    await flush();
    let fill = $('stage').style.getPropertyValue('--qs-bg-fill');
    ok('【主题】dark 载荷给 stage 挂上 qs-dark 类', $('stage').classList.contains('qs-dark'));
    ok('【主题】载荷不再写内联 --qs-bg（底色归 CSS 两套管）',
        !$('stage').style.getPropertyValue('--qs-bg'));
    ok('【透明 bug】磨砂开着时写出了 --qs-bg-fill', !!fill);
    let m = fill.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    ok('【透明 bug】--qs-bg-fill 是合法 rgba（不是 calc/color-mix 表达式）',
        !!m, fill);
    if (m) {
        // 深色那套 --qs-bg: #1E1F24 → rgb(30, 31, 36)
        eq('【主题】深色配色的 --qs-bg-fill 来自 CSS 的 #1E1F24',
            [m[1], m[2], m[3]], ['30', '31', '36']);
        // 用户明确要求：**不透明度是唯一的透明控制，磨砂不许再掺和**。
        // 旧行为（磨砂把背景额外压透明，alpha=100 也透底）已按用户要求移除，
        // 这里断言"磨砂开着时背景 alpha 原样保留 = 1.0"。
        eq('【透明 bug】磨砂不压低背景 alpha（唯一透明度控制=alpha 滑块）',
            Number(m[4]), 1);
    }
    // 回到浅色：dark=false → 摘掉 qs-dark → fill 来自浅色那套 #FFFFFF。
    // 顺带验内联覆盖被清干净（旧实现靠"写之前先 removeProperty"防自骗）。
    $('stage').style.setProperty('--qs-fg', 'rgb(1, 2, 3)');  // 制造一个脏覆盖
    env.listeners.get('qs://theme')({ payload: { dark: false } });
    await flush();
    fill = $('stage').style.getPropertyValue('--qs-bg-fill');
    ok('【主题】浅色载荷摘掉 qs-dark 类', !$('stage').classList.contains('qs-dark'));
    ok('【主题】载荷同时清掉上一轮的内联字色覆盖',
        !$('stage').style.getPropertyValue('--qs-fg'));
    m = fill.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    if (m) {
        eq('【主题】浅色配色的 --qs-bg-fill 来自 CSS 的 #FFFFFF',
            [m[1], m[2], m[3]], ['255', '255', '255']);
    } else {
        ok('【主题】浅色配色的 --qs-bg-fill 也是合法 rgba', false, fill);
    }
    // 关键回归：CSS 里绝不能再出现会失效的 --qs-bg-alpha / calc 组合。
    // 先把注释剥掉再查 —— 注释里为了说明来历保留了旧写法，那是文档不是代码。
    const cssRaw = fs.readFileSync(path.join(ROOT, 'ui/bar.css'), 'utf8');
    const cssText = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('【透明 bug】bar.css 的**声明**里不再有 --qs-bg-alpha（那条会让背景整条失效）',
        !cssText.includes('--qs-bg-alpha'));
    ok('【透明 bug】bar 背景用的是带兜底的 var(--qs-bg-fill, var(--qs-bg))',
        cssText.includes('var(--qs-bg-fill, var(--qs-bg))'));

    /* ---- 收藏夹面板点「设置…」要跳到「收藏夹」分页 ----
     * 用户报过：在横条打开的收藏夹面板里点「设置」，跳到了「文字识别」。
     * 根因是 bar.js 里把目标分页写死成 `panelFav ? 'ocr' : 'engines'` 了 ——
     * 注释里甚至还写着"收藏夹面板 → 文字识别"，说明当初就是这么想的。 */
    console.log('');
    console.log('--- 面板「设置…」的跳转目标 ---');
    env.pushConfig(baseConf({
        favorites: [{
            id: 'g1', name: '目录一', icon: '', children: [],
            items: [{ id: 'i1', kind: 'text', text: '第一句', html: '', remark: '' }],
        }],
        barList: ['百度', '@fav:g1', 'Google'],
    }));
    await flush();

    $('btnMore').click();
    await flush();
    const favEntry = $('panel').querySelector('.fav-entry');
    ok('⋯ 面板里有收藏夹入口', !!favEntry);

    if (favEntry) {
        favEntry.click();
        await flush();
        ok('点收藏夹入口切进了收藏视图', $('panel').querySelector('.fav-panel') !== null
            || $('panel').textContent.includes('目录一'));

        $('btnSettings').click();
        await flush();
        const last = env.lastCmd('open_settings');
        ok('收藏夹面板点「设置…」调用了 open_settings', !!last);
        eq('  跳的分页是 fav（写死成 ocr 就是用户报的 bug）', last && last.args.tab, 'fav');
        eq('  顺手别去 focus 某个引擎', last && last.args.focusEngine, null);
    }
}

/* ================================================================== */
/*  三、本轮新增 / 修掉的问题的回归                                    */
/*                                                                     */
/*  这一节是冲着用户报的两个「用不了」的 bug 来的：                     */
/*    · OCR 精度怎么点都选不中 —— 根因是 bool 和 "1"/"0" 两种形态没对齐 */
/*    · OCR 框选完满屏点不动 —— 根因是框选坐标算出 NaN，命令根本没执行   */
/*  两个都曾经"看起来改好了但其实没改好"，所以必须留在回归里。          */
/* ================================================================== */

async function testRegression() {
    console.log('=== 回归：OCR 精度 / 主题 / 预览 / 名单拾取 / 自定义图标 ===');

    /* ---------------- 1. OCR 精度：选中态与回写类型 ---------------- */
    {
        const env = makeEnv('ui/settings.html', baseConf({ ocrAccurate: true }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        const seg = $('s-ocrAccurate');
        const hi = seg.querySelector('button[data-v="1"]');
        const lo = seg.querySelector('button[data-v="0"]');
        ok('【bug1】高精度开着时「高精度」按钮是选中态',
            hi && hi.classList.contains('on'),
            hi ? 'class=' + hi.className : '按钮不存在');
        ok('【bug1】高精度开着时「普通」按钮不是选中态',
            lo && !lo.classList.contains('on'));

        lo.dispatchEvent(new w.Event('click', { bubbles: true }));
        const c = env.lastCmd('set_setting');
        ok('【bug1】点「普通」会写回后端', !!c && c.args.key === 'ocrAccurate',
            JSON.stringify(c && c.args));
        // 关键：Rust 那边 ocr_accurate 是 bool，发 "0" 过去 as_bool() 拿不到
        ok('【bug1】回传的是布尔 false 而不是字符串 "0"',
            c && c.args.value === false, JSON.stringify(c && c.args));
        ok('【bug1】点了之后选中态立刻跟着变',
            lo.classList.contains('on') && !hi.classList.contains('on'));

        // 反向：配置里是 false，界面上应该是「普通」那颗亮
        env.pushConfig(baseConf({ ocrAccurate: false }));
        await flush();
        ok('【bug1】普通精度时「普通」按钮是选中态',
            lo.classList.contains('on') && !hi.classList.contains('on'));
        hi.dispatchEvent(new w.Event('click', { bubbles: true }));
        const c2 = env.lastCmd('set_setting');
        ok('【bug1】切回高精度回传布尔 true', c2 && c2.args.value === true,
            JSON.stringify(c2 && c2.args));
    }

    /* ---------------- 2. 主题三档（只管设置页 UI） ---------------- */
    {
        const env = makeEnv('ui/settings.html', baseConf({ theme: 'dark' }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const root = w.document.documentElement;

        eq('【主题】配置 dark 时 <html data-theme> 是 dark', root.dataset.theme, 'dark');
        eq('【主题】dark 时告诉浏览器按深色画原生部件', root.style.colorScheme, 'dark');
        ok('【主题】「暗色」按钮是选中态',
            $('s-theme').querySelector('button[data-v="dark"]').classList.contains('on'));

        env.pushConfig(baseConf({ theme: 'light' }));
        await flush();
        eq('【主题】配置 light 时 data-theme 跟着变', root.dataset.theme, 'light');
        eq('【主题】light 时 color-scheme 是 light', root.style.colorScheme, 'light');
        ok('【主题】换了配置后旧档位的选中态被清掉',
            !$('s-theme').querySelector('button[data-v="dark"]').classList.contains('on')
            && $('s-theme').querySelector('button[data-v="light"]').classList.contains('on'));

        $('s-theme').querySelector('button[data-v="light"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        const c = env.lastCmd('set_setting');
        ok('【主题】点「亮色」写入 theme', !!c && c.args.key === 'theme' && c.args.value === 'light',
            JSON.stringify(c && c.args));

        env.pushConfig(baseConf({ theme: 'system' }));
        await flush();
        eq('【主题】跟随系统时 data-theme 记成 system', root.dataset.theme, 'system');
        // 桩里 matchMedia 恒为"非深色"，所以 system 应落到浅色
        eq('【主题】跟随系统 + 系统浅色 → color-scheme 是 light', root.style.colorScheme, 'light');
    }

    /* ---------------- 3. 圆角滑块 + 实时预览 ---------------- */
    {
        const conf = baseConf({
            barList: ['百度', 'Google', '|', '知乎'],
            iconSize: 36, barPadding: 6, itemRadius: 14, sepStyle: 'dot',
        });
        const env = makeEnv('ui/settings.html', conf);
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        eq('【圆角】滑块读到配置值', $('s-itemRadius').value, '14');
        eq('【圆角】旁边的数字也显示 14', $('s-itemRadiusVal').textContent, '14');

        const pvA = $('qsPreviewA'), pvB = $('qsPreviewB');
        ok('【预览】两个预览区都存在', !!pvA && !!pvB);
        eq('【预览】图标尺寸写进 CSS 变量', pvA.style.getPropertyValue('--pv-size'), '36px');
        eq('【预览】内边距写进 CSS 变量', pvA.style.getPropertyValue('--pv-pad'), '6px');
        eq('【圆角】圆角写进预览的 CSS 变量', pvA.style.getPropertyValue('--pv-radius'), '14px');
        eq('【预览】分隔线样式挂到 dataset 上', pvA.dataset.sep, 'dot');

        eq('【预览】引擎按钮数 = 3（4 项里去掉 1 条分隔线）',
            pvA.querySelectorAll('.pv-item').length, 3);
        // 用户后来要求移除预览末尾的"自动分界"——竖线必须严格对应用户加的分隔线。
        eq('【预览】分隔线数 = 1 条（不含尾部自动分界，已移除）',
            pvA.querySelectorAll('.pv-sep').length, 1);
        eq('【预览】两处预览内容一致', pvB.querySelectorAll('.pv-item').length, 3);

        // 改配置后预览要跟着重画
        env.pushConfig(baseConf({ barList: ['百度', 'Google'], itemRadius: 0, sepStyle: 'line' }));
        await flush();
        eq('【预览】配置变了预览跟着变', pvA.querySelectorAll('.pv-item').length, 2);
        eq('【圆角】圆角改成 0 也照写', pvA.style.getPropertyValue('--pv-radius'), '0px');
        eq('【预览】没有分隔线时一条都没有', pvA.querySelectorAll('.pv-sep').length, 0);

        env.pushConfig(baseConf({ barList: [] }));
        await flush();
        ok('【预览】横条空了给空态提示，不是一片空白',
            pvA.querySelectorAll('.pv-empty').length === 1
            && pvA.textContent.includes('还没有引擎'));

        // 拖动过程中（还没松手）预览就要动 —— 用户要的就是"立刻看到"
        $('s-itemRadius').value = '4';
        $('s-itemRadius').dispatchEvent(new w.Event('input', { bubbles: true }));
        eq('【预览】拖滑块过程中圆角预览就跟着变',
            pvB.style.getPropertyValue('--pv-radius'), '4px');
        $('s-itemRadius').value = '2';
        $('s-itemRadius').dispatchEvent(new w.Event('input', { bubbles: true }));
        eq('【预览】两处预览同步', pvA.style.getPropertyValue('--pv-radius'), '2px');

        // 切分隔线样式也要立刻反映到预览上
        $('s-sepStyle').querySelector('button[data-v="dot"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        eq('【预览】点分隔线样式立刻改预览', pvA.dataset.sep, 'dot');

        // 滑块回写
        $('s-itemRadius').value = '18';
        $('s-itemRadius').dispatchEvent(new w.Event('change', { bubbles: true }));
        const c = env.lastCmd('set_setting');
        ok('【圆角】拖滑块写入 itemRadius',
            !!c && c.args.key === 'itemRadius' && c.args.value === 18,
            JSON.stringify(c && c.args));
    }

    /* ---------------- 4. 黑白名单：鼠标点选 + 文件选择 ---------------- */
    {
        const env = makeEnv('ui/settings.html', baseConf({ filterMode: 'black', filterList: [] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        $('btnPickApp').dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('【名单】点「用鼠标点选程序」打开了拾取层', !!env.lastCmd('open_app_picker'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
        ok('【名单】点选前给了操作提示', $('grabHint').textContent.includes('十字'),
            $('grabHint').textContent);

        $('btnPickFile').dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('【名单】点「从电脑里挑程序」走文件选择', !!env.lastCmd('pick_app_file'));

        // 模拟 Rust 拾取到一个程序后回传
        const picked = env.listeners.get('qs://picked-app');
        ok('【名单】前端登记了 qs://picked-app 的接收', !!picked);
        picked({ payload: 'notepad.exe' });
        await flush();
        eq('【名单】拾取到的程序进了列表', $('s-filterList').value, 'notepad.exe');
        const c = env.lastCmd('set_setting');
        ok('【名单】并立刻写回后端',
            !!c && c.args.key === 'filterList' && JSON.stringify(c.args.value) === '["notepad.exe"]',
            JSON.stringify(c && c.args));
        ok('【名单】回显告诉用户加进去了', $('grabHint').textContent.includes('notepad.exe'),
            $('grabHint').textContent);

        picked({ payload: 'msedge.exe' });
        await flush();
        eq('【名单】第二个程序追加在后面', $('s-filterList').value, 'notepad.exe\nmsedge.exe');

        picked({ payload: 'NOTEPAD.EXE' });
        await flush();
        eq('【名单】重复的程序不会被加两遍（大小写不敏感）',
            $('s-filterList').value, 'notepad.exe\nmsedge.exe');
        ok('【名单】重复时提示已在列表里', $('grabHint').textContent.includes('已经在列表里'),
            $('grabHint').textContent);

        picked({ payload: '  ' });
        await flush();
        eq('【名单】空名字不进列表', $('s-filterList').value, 'notepad.exe\nmsedge.exe');

        // 已有内容时不能被覆盖掉
        env.pushConfig(baseConf({ filterList: ['a.exe', 'b.exe'] }));
        await flush();
        picked({ payload: 'c.exe' });
        await flush();
        eq('【名单】已有条目时是追加不是覆盖',
            $('s-filterList').value, 'a.exe\nb.exe\nc.exe');
    }

    /* ---------------- 5. 自定义引擎选图标 ---------------- */
    {
        const conf = baseConf({
            customEngines: [
                { name: '站A', url: 'https://a.com/s?q=%s', category: '自定义' },
            ],
            overrideIcons: { '站A': 'data:image/png;base64,AAAA' },
        });
        const env = makeEnv('ui/settings.html', conf);
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        // 新建态：没名字
        $('btnCeIcon').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('【图标】没填名字时不弹文件框', !env.lastCmd('pick_icon'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
        ok('【图标】没填名字时提示先填名字', $('ceHint').textContent.includes('先填个名字'),
            $('ceHint').textContent);

        // 填了名字再点
        $('w-ceName').value = '站B';
        $('btnCeIcon').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const c = env.lastCmd('pick_icon');
        ok('【图标】填了名字后调用 pick_icon', !!c, JSON.stringify(env.calls.map((x) => x.cmd)));
        eq('【图标】把引擎名一起传过去（图标按名字存的）', c && c.args.engine, '站B');

        // 编辑已有引擎：图标预览应该显示出来
        const editBtn = [...$('customList').querySelectorAll('button')]
            .find((b) => b.textContent === '编辑');
        ok('【图标】自定义引擎行有编辑按钮', !!editBtn);
        if (editBtn) {
            editBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
            await flush();
            ok('【图标】编辑已有引擎时图标预览显示出来', $('ceIconPrev').hidden === false);
            ok('【图标】图标预览指向配置里的图标',
                $('ceIconPrev').getAttribute('src') === 'data:image/png;base64,AAAA',
                $('ceIconPrev').getAttribute('src'));
        }
    }
}

/* ================================================================== */
/*  四、OCR 框选层（bug 2 的现场）                                     */
/*                                                                     */
/*  这个页面是铺满全屏的遮罩。它只要一次没关掉，用户就满屏点不动 ——      */
/*  所以这里不只测"正常框选对不对"，还要测"出错时会不会自己退场"。       */
/* ================================================================== */

function mouse(env, type, x, y, button = 0) {
    const ev = new env.w.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button,
    });
    env.w.document.dispatchEvent(ev);
    return ev;
}

/* ⚠ 这里原来还有**第二份** `async function testRegion()` —— 一具空壳，只打印
 * 「跳过 region 框选测试（jsdom 没有鼠标事件）」。但那个前提是错的：jsdom 的
 * MouseEvent 完全能派发，下面第 951 行起的真测试一直在跑、也一直在过。两份同名
 * 函数声明并存的结果是「后一份生效」，空壳成了永远执行不到的死代码，还让读代码的
 * 人以为这块没测。已删掉空壳，保留真测试。 */
async function testOcrResult() {
    console.log('');
    console.log('=== OCR 结果窗（ui/ocr.html）===');
    const env = makeEnv('ui/ocr.html', baseConf({
        // 把 @ocr 也塞进 bar_list，验结果窗里不能出现 OCR 按钮
        barList: ['百度', '@ocr', 'Google'],
        debug: true,
    }));
    runScripts(env, ['ui/shared.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);

    // 渲染完成后检查 .eng-icon 里的引擎名
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    const engNames = [...w.document.querySelectorAll('.eng.eng-icon')]
        .map((b) => b.getAttribute('aria-label') || b.title || '');
    ok('OCR 结果窗不渲染 OCR 按钮本身（@ocr 被过滤掉）',
        !engNames.includes('OCR') && !engNames.some((n) => n.includes('OCR')));

    // 「重新识别」按钮
    const btnRerun = $('btnRerun');
    ok('结果窗有「重新识别」按钮', !!btnRerun);
    // 没图时点它应该只是调后端（后端会告诉用户"没图"），不会让按钮卡死。
    if (btnRerun) {
        env.calls.length = 0;
        btnRerun.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        await new Promise((r) => setTimeout(r, 50));
        ok('点「重新识别」会调用后端 ocr_rerun 命令',
            !!env.lastCmd('ocr_rerun'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
        // 按钮最终恢复可点
        ok('请求结束后按钮恢复可点（不会被永久禁用）', !btnRerun.disabled);
    }

    // ---- 对照区高度上限（用户要求：窗口再小，对照最多占一半） ----
    // jsdom 不做真实布局，只能对着 CSS 源码断言这两条关键规则在不在。
    const ocrSrc = fs.readFileSync(path.join(ROOT, 'ui/ocr.html'), 'utf8');
    ok('【对照】竖向版式下 .shot 有「最多一半高度」的上限',
        /\.panes:not\(\.side\)\s*\.shot\s*\{[^}]*max-height:\s*50%/.test(ocrSrc));
    ok('【对照】.shot-body 允许被压缩（min-height:0），否则 50% 上限落不到实处',
        /\.panes:not\(\.side\)\s*\.shot-body\s*\{[^}]*min-height:\s*0/.test(ocrSrc));
    ok('【对照】图片跟随容器缩放（max-height:100%）',
        /\.panes:not\(\.side\)\s*\.shot-body\s+img\s*\{[^}]*max-height:\s*100%/.test(ocrSrc));
}
/* ================================================================== */
/* v1.5.16：翻译（横条按钮 / 翻译窗 / 识别结果窗入口 / 设置栏）          */
/*                                                                    */
/* 第二轮起翻译窗是**一家引擎一个文本框**（用户原话：「像 OCR 识别一样  */
/* 可以同时多选几个翻译引擎，然后同一个页面同时呈现出来」），所以这里    */
/* 的用例从"一个原文框 + 一个译文框"改成"一个原文框 + N 个译文框"。     */
/* ================================================================== */

/** 取翻译窗里某一家的译文框句柄。 */
function tpPane(w, id) {
    return w.document.querySelector('#tps .tp[data-eng="' + id + '"]');
}
function tpTa(w, id) {
    const p = tpPane(w, id);
    return p ? p.querySelector('textarea') : null;
}

async function testTrans() {
    console.log('');
    console.log('=== 翻译窗（ui/trans.html）：一家一个文本框 ===');

    /* ① 冷启动：带一段文字 + 两家一起翻 → 自动各发一次，两家译文各进各的框。
     *   这条是用户的默认姿势：横条点「译」→ 打开就看到译文，不用再点一次。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'en' }));
        runScripts(env, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        ok('翻译窗有原文 / 语言下拉 / 翻译按钮', !!$('src') && !!$('target') && !!$('btnGo'));
        ok('  译文区是空的容器（按参与名单由 JS 建框）', !!$('tps'));
        ok('原文框带进了横条那段文字', $('src').value === 'Hello there', $('src').value);

        // 参与名单来自 trans_session 的 plan（Rust 侧 config::trans_plan 的权威输出）
        const panes = [...$('tps').querySelectorAll('.tp')];
        ok('按 plan 建了两家译文框（siliconflow / deepseek）',
            panes.length === 2
            && panes.map((p) => p.dataset.eng).join(',') === 'siliconflow,deepseek',
            panes.map((p) => p.dataset.eng).join(','));
        ok('  每个框顶上挂了引擎名和模型',
            /硅基流动/.test(panes[0].textContent)
            && /Qwen\/Qwen2\.5-7B-Instruct/.test(panes[0].textContent)
            && /DeepSeek/.test(panes[1].textContent),
            panes.map((p) => p.querySelector('.tp-cap').textContent).join(' | '));
        ok('  顶部摘要写明几家一起翻、几家就绪',
            $('engCap').textContent === '2 家一起翻 · 2 家就绪', $('engCap').textContent);

        // 两家各发一次 trans_run（并行），带的引擎 id 不一样、文字和目标语言一样
        const runs = env.cmd('trans_run');
        ok('有文字时打开翻译窗会自动翻（每家各一次）',
            runs.length === 2, JSON.stringify(runs.map((r) => r.args)));
        ok('  两次请求各带自己家的引擎 id',
            runs.length === 2
            && runs[0].args.engine === 'siliconflow' && runs[1].args.engine === 'deepseek',
            JSON.stringify(runs.map((r) => r.args.engine)));
        ok('  两次请求的文字与目标语言一致',
            runs.every((r) => r.args.text === 'Hello there' && r.args.target === 'en'),
            JSON.stringify(runs.map((r) => r.args)));
        ok('两家译文各落进各自的框（不互相覆盖）',
            tpTa(w, 'siliconflow').value === '你好啊' && tpTa(w, 'deepseek').value === '你好啊',
            tpTa(w, 'siliconflow').value + ' / ' + tpTa(w, 'deepseek').value);
        ok('  两家的状态都是「已完成」',
            [...$('tps').querySelectorAll('.tp-st')].every((s) => s.textContent === '已完成'));
        ok('译文标题标出目标语言', $('dstLang').textContent.includes('English'),
            $('dstLang').textContent);

        // 语言下拉由 trans_langs 填充，且选中 session 里的目标语言
        const opts = [...$('target').querySelectorAll('option')].map((o) => o.value);
        ok('语言下拉由后端语言表填充（Rust 一份，界面不自己维护）',
            opts.join(',') === 'zh,zh-TW,en,ja', opts.join(','));
        ok('  选中项跟着 session 的 target', $('target').value === 'en', $('target').value);
        // 页面首帧画完通知 Rust 显示（hidden 建窗那条路）—— ⚠ 必须在下面
        // `env.calls.length = 0` 之前查：boot 时的调用记录会被后续交互清掉。
        ok('页面就绪后通知 Rust 显示窗口（hidden 建窗那条路）', !!env.lastCmd('trans_ready'),
            JSON.stringify(env.calls.map((c) => c.cmd)));

        // 切语言 → 两家都按新语言重翻（用户要求：可切目标语言）
        env.calls.length = 0;
        $('target').value = 'ja';
        $('target').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const runs2 = env.cmd('trans_run');
        ok('切目标语言时两家都按新语言重翻',
            runs2.length === 2 && runs2.every((r) => r.args.target === 'ja'),
            JSON.stringify(runs2.map((r) => r.args.target)));
        ok('  译文标题跟着换成日本語', $('dstLang').textContent.includes('日本語'),
            $('dstLang').textContent);

        // 复制译文：作用于「活动框」（用户刚点过的那一家）
        env.calls.length = 0;
        $('btnCopy').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        let cp = env.lastCmd('copy_text');
        ok('没点过任何框时「复制译文」复制第一家', !!cp && cp.args.text === '你好啊',
            JSON.stringify(cp && cp.args));
        // 点一下第二家，再复制 → 复制的就是第二家那一格
        const ta2 = tpTa(w, 'deepseek');
        ta2.value = 'SECOND-BOX-TEXT';
        ta2.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
        ta2.dispatchEvent(new w.Event('focus', { bubbles: true }));
        env.calls.length = 0;
        $('btnCopy').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        cp = env.lastCmd('copy_text');
        ok('  点过哪一家，「复制译文」就复制哪一家',
            !!cp && cp.args.text === 'SECOND-BOX-TEXT', JSON.stringify(cp && cp.args));

        // 复制原文 / 设为默认 / 关闭 / Ctrl+Enter
        env.calls.length = 0;
        $('btnCopySrc').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const cps = env.lastCmd('copy_text');
        ok('「复制原文」把原文递进剪贴板命令',
            !!cps && cps.args.text === 'Hello there', JSON.stringify(cps && cps.args));
        $('btnSetDefault').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const sd = env.lastCmd('set_setting');
        ok('「设为默认」把当前语言写回配置',
            !!sd && sd.args.key === 'transTarget' && sd.args.value === 'ja',
            JSON.stringify(sd && sd.args));
        $('btnClose').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('「关闭」调 close_trans_window', !!env.lastCmd('close_trans_window'));
        env.calls.length = 0;
        $('src').dispatchEvent(new w.KeyboardEvent('keydown', {
            key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await flush();
        ok('Ctrl+Enter 直接翻译（两家都翻）', env.cmd('trans_run').length === 2,
            JSON.stringify(env.calls.map((c) => c.cmd)));
    }

    /* ①b 流式翻译（v1.5.18）：模型边吐边显示，最后再拿权威结果覆盖。
     *
     *  三件事必须成立，少一件用户就会看到怪东西：
     *    · 增量只认**当前轮**的 round（重翻时旧连接还在吐，不能糊到一起）；
     *    · 增量按到达顺序追加到**对应那一家**的框，别家不动；
     *    · 整段回来后覆盖成 Rust 给的结果（剥围栏 / 去空白只在全量时才准）。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }));
        runScripts(env, ['ui/shared.js']);
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        env.deferTransRun();
        await flush();
        await new Promise((r) => setTimeout(r, 60));

        const run = env.lastCmd('trans_run');
        ok('trans_run 带上了本轮 round', !!run && typeof run.args.round === 'string'
            && run.args.round.length > 0, JSON.stringify(run && run.args));

        const round = run && run.args.round;
        const paneOf = (id) => w.document.querySelector('.tp[data-eng="' + id + '"]');
        const fire = (engine, delta, r) => {
            const cb = env.listeners.get('qs://trans-chunk');
            ok('  前端订阅了 qs://trans-chunk', !!cb);
            if (cb) cb({ payload: { engine: engine, delta: delta, round: r === undefined ? round : r } });
        };

        fire('siliconflow', '你');
        await flush();
        const p1 = paneOf('siliconflow');
        ok('增量先贴进对应那一家', p1 && p1.querySelector('textarea').value === '你',
            JSON.stringify(p1 && p1.querySelector('textarea').value));
        ok('  流式期间状态是「翻译中…」', p1.querySelector('.tp-st').textContent === '翻译中…',
            p1.querySelector('.tp-st').textContent);
        ok('  别家不受影响（还是等待中）',
            paneOf('deepseek').querySelector('textarea').value === '',
            JSON.stringify(paneOf('deepseek').querySelector('textarea').value));

        fire('siliconflow', '好');
        fire('siliconflow', '啊');
        await flush();
        ok('增量按顺序累加', p1.querySelector('textarea').value === '你好啊',
            JSON.stringify(p1.querySelector('textarea').value));

        // 上一轮的尾货：round 对不上，必须丢掉
        fire('siliconflow', '【旧轮次】', 'r-old');
        await flush();
        ok('旧 round 的增量被丢掉（不会糊成两份）',
            p1.querySelector('textarea').value === '你好啊',
            JSON.stringify(p1.querySelector('textarea').value));

        // 整段回来：覆盖成权威结果、状态收尾
        env.releaseTransRun();
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        ok('收尾用权威结果覆盖（剥围栏/去空白只在全量时才准）',
            p1.querySelector('textarea').value === '你好啊',
            JSON.stringify(p1.querySelector('textarea').value));
        ok('  状态变成「已完成」', p1.querySelector('.tp-st').textContent === '已完成',
            p1.querySelector('.tp-st').textContent);
        ok('  按钮恢复可点', $('btnGo').disabled === false);
    }

    /* ② 一家失败一家成功：失败的只在**它自己那一格**报错，别家的译文照样出来。
     *   401 / 429 是最常见的两种失败，界面必须说人话、还不能连坐。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }));
        runScripts(env, ['ui/shared.js']);
        env.setTransRunFor('deepseek', '', 'DeepSeek：API Key 不对或已失效（401）—— 去 platform.deepseek.com 重新创建一个');
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('成功那家的译文正常落进它自己的框',
            tpTa(w, 'siliconflow').value === '你好啊', tpTa(w, 'siliconflow').value);
        ok('失败那家的框是空的、不塞别家的译文',
            tpTa(w, 'deepseek').value === '', tpTa(w, 'deepseek').value);
        const badPane = tpPane(w, 'deepseek');
        ok('  失败那一家状态标红、说明贴在它自己框下面',
            badPane.querySelector('.tp-st').textContent === '失败'
            && badPane.querySelector('.tp-st').classList.contains('err')
            && badPane.querySelector('.tp-note').hidden === false
            && badPane.querySelector('.tp-note').textContent.includes('401'),
            badPane.querySelector('.tp-note').textContent);
        ok('  成功那一家没有错误说明、状态是已完成',
            tpPane(w, 'siliconflow').querySelector('.tp-note').hidden === true
            && tpPane(w, 'siliconflow').querySelector('.tp-st').textContent === '已完成');
        ok('只有一家失败时汇总条显示这一家的原因',
            $('note').hidden === false && $('note').textContent.includes('401'),
            $('note').textContent);
        ok('  说明条用出错样式', $('note').classList.contains('err'));
        ok('  失败后「翻译」按钮恢复可点（不会卡死）', $('btnGo').disabled === false);
        env.setTransRunFor('deepseek', '你好啊', '');
    }

    /* ③ 两家全失败：汇总条说清"几家挂了 + 第一家的原因"，各框自己那格也有详情。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }));
        runScripts(env, ['ui/shared.js']);
        env.setTransRun('', '请求太频繁，或者本月额度用完了（429）—— 过一会儿再试');
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('两家都挂时汇总条写明几家失败和第一家的原因',
            $('note').hidden === false
            && /^2 家没翻出来，第一家是：/.test($('note').textContent)
            && $('note').textContent.includes('429'),
            $('note').textContent);
        ok('  每一家自己那格也都有失败原因',
            [...$('tps').querySelectorAll('.tp-note')].every((n) => !n.hidden && n.textContent.includes('429')));
        ok('  两个译文框都不留旧译文',
            tpTa(w, 'siliconflow').value === '' && tpTa(w, 'deepseek').value === '');
        env.setTransRun('你好啊', '');
    }

    /* ④ 没文字：不自动翻，空着等用户自己粘贴（比弹一句"先选文字"省事）。
     *   点「翻译」时也只提示一句，不发请求。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }),
            { session: { text: '', target: 'zh' } });
        runScripts(env, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('没有文字时打开翻译窗不自动翻', !env.lastCmd('trans_run'),
            JSON.stringify({ src: $('src').value, calls: env.calls.map((c) => c.cmd) }));
        ok('  原文框是空的（等用户粘贴）', $('src').value === '');
        env.calls.length = 0;
        $('btnGo').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('  空着点「翻译」不发请求、只提示一句', !env.lastCmd('trans_run'));
        ok('    toast 提示"没有可翻译的文字"', $('toast').textContent === '没有可翻译的文字',
            $('toast').textContent);
    }

    /* ⑤ 设置页改了参与名单（换默认引擎 / 勾同时翻译）→ 翻译窗重建框并重翻。
     *   用户在设置里动一下、翻译窗开着，必须马上反映新名单。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }));
        runScripts(env, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('初始是两家并排', $('tps').querySelectorAll('.tp').length === 2);

        // 换成只留 deepseek 一家（设置里把默认引擎改成它、同时翻译清空）
        env.setTransPlan([{ id: 'deepseek', name: 'DeepSeek', ready: true }]);
        env.pushConfig(baseConf({ transTarget: 'zh', transEngine: 'deepseek', transMulti: [] }));
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const panes = [...$('tps').querySelectorAll('.tp')];
        ok('名单变成一家时译文区重建成一个框',
            panes.length === 1 && panes[0].dataset.eng === 'deepseek',
            panes.map((p) => p.dataset.eng).join(','));
        ok('  重建后自动按新名单重翻', env.cmd('trans_run').some((r) => r.args.engine === 'deepseek'));
        ok('  顶部摘要变成单引擎口径', $('engCap').textContent === 'DeepSeek', $('engCap').textContent);
    }

    /* ⑥ 没配任何引擎时：不发请求，说清去哪儿配（不静默失败）。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }),
            { session: { text: 'Hello', target: 'zh', plan: [] } });
        runScripts(env, ['ui/shared.js']);
        env.pushConfig(baseConf({ transTarget: 'zh', transEngine: '', transMulti: [] }));
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        // plan 为空 → 前端按 CONF 兜底；CONF 里默认引擎也是空 → 落 siliconflow，
        // 所以这里断言的是"不会一个框都不建、也不会不发请求"
        ok('名单为空时也有框可翻（兜底不白屏）', $('tps').querySelectorAll('.tp').length >= 1);
    }

    /* ⑧ 原文框的三个问题（2026-10-27 用户报）：
     *     1. 缺少圆角边框；
     *     2. 固定尺寸，不能拖拽调宽高；
     *     3. 内容被设成只读，不能直接编辑。
     *   根因都在 ui/trans.html 的样式/结构上：
     *     1&2 —— `.pane-box` 里从来没给 `#src` 写过样式规则（圆角/边框只写在
     *            译文区 `.tp textarea` 上），而 `.pane-box` 又是 `flex:1 1 0`，
     *            高度被 flex 锁死，浏览器原生的拖拽把手形同虚设；
     *     3   —— `html, body { user-select: none }` 被 textarea **继承**
     *            （只有译文区 `.tp textarea` 显式开了 `user-select: text`），
     *            于是原文框既选不中也编辑不了，看着像被设成只读。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({ transTarget: 'zh' }));
        runScripts(env, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 80));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const src = $('src');

        // ① 圆角 + 边框
        //    注意：jsdom 不解析 `border: 1px solid var(--line)` 这种**带 var()
        //    的简写**（译文区 .tp textarea 同款写法在 jsdom 里也算成 none），
        //    所以「边框」这条改成 ①a 比对译文区（同一套 = 同一份声明）、
        //    ①b 直接查 CSS 源里有没有那行声明 —— 后者才是真正在断言。
        const cs = w.getComputedStyle(src);
        ok('原文框有圆角边框（不再是浏览器默认的直角灰框）',
            cs.borderRadius && cs.borderRadius !== '0px' && cs.borderRadius !== '0%',
            'border-radius=' + cs.borderRadius);
        {
            // 找译文区的框（如果这一轮没建译文框就现建一个）
            let tpTa = w.document.querySelector('.tp textarea');
            if (!tpTa) {
                const tp = w.document.createElement('div');
                tp.className = 'tp';
                tp.innerHTML = '<div class="tp-cap"></div><textarea></textarea>';
                w.document.getElementById('tps').appendChild(tp);
                tpTa = tp.querySelector('textarea');
            }
            const csTp = w.getComputedStyle(tpTa);
            ok('  圆角跟译文区一模一样（同一套视觉）',
                cs.borderRadius === csTp.borderRadius,
                cs.borderRadius + ' vs ' + csTp.borderRadius);

            const html = read('ui/trans.html');
            const srcRule = (html.match(/#src\s*\{([^}]*)\}/) || ['', ''])[1];
            ok('  CSS 源里 #src 声明了 1px 实线边框',
                /border:\s*1px\s+solid/.test(srcRule),
                (srcRule.match(/border[^;]*/) || ['(没有)'])[0].trim());
            ok('  CSS 源里 #src 声明了圆角 10px',
                /border-radius:\s*10px/.test(srcRule),
                (srcRule.match(/border-radius[^;]*/) || ['(没有)'])[0].trim());
        }

        // ② 可拖拽调宽高
        ok('原文框可以拖拽调整宽高（resize: both）',
            cs.resize === 'both', 'resize=' + cs.resize);
        ok('  有明确的高度（不是被 flex 撑出来的 auto）',
            cs.height && cs.height !== 'auto' && parseFloat(cs.height) > 0,
            'height=' + cs.height);

        // ③ 可编辑
        ok('原文框不是只读（没有 readonly / disabled）',
            src.readOnly === false && src.disabled === false,
            'readOnly=' + src.readOnly + ' disabled=' + src.disabled);
        ok('  文字可以被选中（user-select: text，不是继承来的 none）',
            cs.userSelect === 'text' || cs.webkitUserSelect === 'text',
            'user-select=' + cs.userSelect);

        // ③ 续：编辑之后能正常触发翻译流程
        src.value = '我改过的文字';
        src.dispatchEvent(new w.Event('input', { bubbles: true }));
        env.calls.length = 0;
        $('btnGo').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const tr = env.cmd('trans_run');
        ok('编辑后的新文字被送去翻译（拿的是此刻框里的内容）',
            tr.length > 0 && tr[0].args.text === '我改过的文字',
            JSON.stringify(tr.map((r) => r.args.text)));
    }

    console.log('');
    console.log('=== 翻译窗：老牌引擎缺副凭据时的提示 ===');
    /* 百度 / 有道 的凭据是「主 + 副」成对的。只填了 APP ID 时，pane 上必须
     * 说清「缺密钥」—— 笼统一句「未就绪」会让人把 APP ID 反复检查半天。
     * 这条对应 Rust 侧 trans_creds_ready 的 need_secret 判定，两边口径要一致。 */
    {
        const env = makeEnv('ui/trans.html', baseConf({
            transEngine: 'baidu', transMulti: [], transTarget: 'zh',
            transCreds: { baidu: { key: '2024bdappid' } },   // 只有 APP ID，没有密钥
        }), { session: { text: '', target: 'zh' } });
        env.setTransPlan([{ id: 'baidu', name: '百度翻译', ready: false }]);
        runScripts(env, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const st = env.w.document.querySelector('.tp .tp-st');
        ok('只填 APP ID 没填密钥时，提示「缺密钥」（不是笼统的「未就绪」）',
            !!st && st.textContent === '缺密钥', st && st.textContent);

        // 补上密钥之后（全新的界面 + 后端已认可 ready）：状态该是「等待中…」
        const env2 = makeEnv('ui/trans.html', baseConf({
            transEngine: 'baidu', transMulti: [], transTarget: 'zh',
            transCreds: { baidu: { key: '2024bdappid', secret: 's3cret' } },
        }), { session: { text: '', target: 'zh' } });
        env2.setTransPlan([{ id: 'baidu', name: '百度翻译', ready: true }]);
        runScripts(env2, ['ui/shared.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const st2 = env2.w.document.querySelector('.tp .tp-st');
        ok('  填齐之后状态是「等待中…」，不再报缺凭据',
            !!st2 && st2.textContent === '等待中…', st2 && st2.textContent);
    }

    console.log('');
    console.log('=== 识别结果窗的翻译入口 ===');
    /* ⑦ OCR 结果窗：「翻译」按钮把识别文字递进 trans_start。
     *   划了选区就只翻选区（和「复制」同一个口径）。 */
    {
        const env = makeEnv('ui/ocr.html', baseConf({ barList: ['百度', '@ocr', 'Google'] }));
        runScripts(env, ['ui/shared.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const b = $('btnTrans');
        ok('识别结果窗有「翻译」按钮', !!b);
        ok('  默认显示（翻译开着）', b && b.hidden === false);
        $('text').value = 'Hello from OCR';
        env.calls.length = 0;
        b.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const ts = env.lastCmd('trans_start');
        ok('点「翻译」调 trans_start 并带上识别文字',
            !!ts && ts.args.text === 'Hello from OCR', JSON.stringify(ts && ts.args));
        const ta = $('text');
        ta.value = '一二三四五六';
        ta.selectionStart = 0;
        ta.selectionEnd = 2;
        env.calls.length = 0;
        b.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const ts2 = env.lastCmd('trans_start');
        ok('  划了选区时只翻选区（和「复制」同口径）',
            !!ts2 && ts2.args.text === '一二', JSON.stringify(ts2 && ts2.args));
        env.pushConfig(baseConf({ barList: ['百度', '@ocr', 'Google'], transEnable: false }));
        await flush();
        ok('翻译开关关掉后「翻译」按钮隐藏', $('btnTrans').hidden === true);
        env.pushConfig(baseConf({ barList: ['百度', '@ocr', 'Google'], transEnable: true }));
        await flush();
        ok('  开关打开后按钮回来', $('btnTrans').hidden === false);
    }

    console.log('');
    console.log('=== 设置页：翻译栏（多引擎） ===');
    /* ⑧ 开关 / 引擎列表 / 凭据 / 同时翻译 / 语言下拉 / 加进横条 / 申请 Key 链接。
     *   整套对齐「文字识别」那一栏：名单来自后端注册表，点一行 = 设为默认引擎，
     *   凭据按注册表的 need_* 生成、走 trans_set_cred 落盘。 */
    {
        const env = makeEnv('ui/settings.html', baseConf({
            barList: ['百度', 'Google'],
            transEnable: true, transEngine: 'siliconflow', transMulti: ['deepseek'],
            transTarget: 'ja',
        }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);

        ok('设置页有「启用翻译」开关', !!$('s-transEnable'));
        ok('  开关回填配置里的值', $('s-transEnable').checked === true);
        $('s-transEnable').checked = false;
        $('s-transEnable').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        const sw = env.lastCmd('set_setting');
        ok('  切换开关写配置',
            !!sw && sw.args.key === 'transEnable' && sw.args.value === false,
            JSON.stringify(sw && sw.args));
        $('s-transEnable').checked = true;

        /* 引擎列表：11 家都在（8 家 OpenAI 兼容 + 百度/谷歌/有道三家老牌），
         * 默认那家展开。⚠ 别按位置索引写死 —— 注册表一改位置就全错位，
         * 一律按 dataset.id 找。 */
        const rows = [...$('w-transEngList').querySelectorAll('.eng-row')];
        const rowOf = (id) => rows.find((r) => r.dataset.id === id);
        ok('翻译引擎列表由后端注册表渲染（11 家）', rows.length === 11,
            rows.map((r) => r.dataset.id).join(','));
        ok('  三家老牌都在名单里',
            !!rowOf('baidu') && !!rowOf('google') && !!rowOf('youdao'));
        ok('  默认引擎那一行是选中 + 展开态',
            rowOf('siliconflow').classList.contains('on')
            && rowOf('siliconflow').classList.contains('open'));
        ok('  展开的凭据块挂在默认那一行下面',
            !!$('w-transBody') && $('w-transBody').parentElement === rowOf('siliconflow'));
        ok('  「同时翻译」名单里的那家带徽标',
            /同时翻译/.test(rowOf('deepseek').textContent), rowOf('deepseek').textContent.trim());
        ok('  行上有「?」和「文档」按钮',
            !!rowOf('siliconflow').querySelector('.eng-help')
            && !!rowOf('siliconflow').querySelector('.eng-help.doc'));
        ok('  每家引擎旁边都有「?」和「文档」两颗按钮',
            rows.every((r) => !!r.querySelector('.eng-help')
                && !!r.querySelector('.eng-help.doc')));

        // 「同时翻译」多选：默认引擎不在这里（它一定参与），只列另外几家
        const chips0 = [...$('w-transMultiBox').querySelectorAll('.multi-chip')];
        const chipOf = (id) => chips0.find((c) => c.dataset.id === id);
        ok('「同时翻译」只列默认引擎之外的几家（11 家里排掉默认那家）',
            chips0.length === 10 && chipOf('baidu')
            && chips0.every((c) => c.dataset.id !== 'siliconflow'),
            chips0.map((c) => c.dataset.id).join(','));
        ok('  配置里勾中的那家是点亮态',
            chipOf('deepseek').classList.contains('on'),
            chips0.map((c) => c.dataset.id + (c.classList.contains('on') ? '(on)' : '')).join(','));

        // 点另一行 = 设为默认引擎
        env.calls.length = 0;
        rowOf('deepseek').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const pe = env.lastCmd('set_setting');
        ok('点另一行 = 设为默认引擎',
            !!pe && pe.args.key === 'transEngine' && pe.args.value === 'deepseek',
            JSON.stringify(pe && pe.args));
        /* 不变式：默认引擎不留在「同时翻译」名单里（它一定参与，勾着是条死
         * 配置）。前端把整份名单发给后端，后端踢掉默认引擎、去重后**回传**，
         * 前端拿回传值覆盖本地 —— 所以发出去的是 ['deepseek']，界面变成全灭。 */
        const dm = env.lastCmd('trans_set_multi');
        ok('  新默认引擎原来在同时翻译名单里 → 后端顺手剔掉',
            !!dm && JSON.stringify(dm.args.engines) === JSON.stringify(['deepseek']),
            JSON.stringify(dm && dm.args));
        const chips1 = [...$('w-transMultiBox').querySelectorAll('.multi-chip')];
        ok('  回传的名单生效：新默认引擎自己消失、原来勾它的那一格也灭了',
            chips1.length === 10 && !!chips1.find((c) => c.dataset.id === 'baidu')
            && chips1.every((c) => c.dataset.id !== 'deepseek')
            && !chips1.some((c) => c.classList.contains('on')),
            chips1.map((c) => c.dataset.id + (c.classList.contains('on') ? '(on)' : '')).join(','));

        // 凭据：Key 是密码框（带眼睛）、模型框 + 拉取模型、测试连接
        const cred = $('w-transCredBox');
        ok('凭据区有 API Key 密码框', !!cred.querySelector('input[data-field="key"]')
            && cred.querySelector('input[data-field="key"]').type === 'password');
        eq('  Key 框回填配置里这一家的值',
            cred.querySelector('input[data-field="key"]').value, 'sk-ds');
        ok('  密码框带「显示 / 隐藏」眼睛', !!cred.querySelector('.cred-eye-btn'));
        ok('凭据区有模型框和「拉取模型」按钮',
            !!cred.querySelector('input[data-field="model"]') && !!cred.querySelector('.cred-pull'));
        eq('  模型框回填配置里这一家的值',
            cred.querySelector('input[data-field="model"]').value, 'deepseek-chat');
        ok('凭据区有「测试连接」按钮', !!cred.querySelector('.cred-foot .dep-btn'));

        // 改 Key → trans_set_cred 三样一起发。
        // base 发空串：DeepSeek 的 base 是注册表预置的（needBase=false），
        // 凭据区压根不渲染接口地址那一栏，get('base') 自然取到 ''。
        env.calls.length = 0;
        const keyInp = cred.querySelector('input[data-field="key"]');
        keyInp.value = 'sk-new';
        keyInp.dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        const sc = env.lastCmd('trans_set_cred');
        ok('改 Key 走 trans_set_cred（按引擎 id 存）',
            !!sc && sc.args.engine === 'deepseek' && sc.args.key === 'sk-new'
            && sc.args.base === '' && sc.args.model === 'deepseek-chat',
            JSON.stringify(sc && sc.args));

        // 测试连接 → trans_test 带引擎 id，结果写进状态行
        env.calls.length = 0;
        cred.querySelector('.cred-foot .dep-btn').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        await new Promise((r) => setTimeout(r, 30));
        const tt = env.lastCmd('trans_test');
        ok('「测试连接」调 trans_test 并带上当前引擎',
            !!tt && tt.args.engine === 'deepseek', JSON.stringify(tt && tt.args));
        ok('  测试结果写进状态行（成功）',
            cred.querySelector('.cred-status').classList.contains('ok')
            && cred.querySelector('.cred-status').textContent.includes('你好啊'),
            cred.querySelector('.cred-status').textContent);

        // 拉模型 → trans_list_models，回来后在凭据区陈列出来、点一下选用
        env.calls.length = 0;
        cred.querySelector('.cred-pull').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('「拉取模型」调 trans_list_models 并带上引擎', !!env.lastCmd('trans_list_models'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
        const ml = env.listeners.get('qs://trans-models');
        ok('  后端经 qs://trans-models 把模型表推回来', !!ml);
        if (ml) {
            // 后端已按「能对话」滤过（trans_list_models 的口径），前端原样陈列
            ml({ payload: { engine: 'deepseek', ok: true, msg: '拉到 2 个对话模型', models: [{ id: 'deepseek-chat', chat: true }, { id: 'deepseek-reasoner', chat: true }] } });
            await flush();
            const items = [...cred.querySelectorAll('.cred-model-item')];
            ok('  拉到的模型陈列出来', items.length === 2,
                items.map((i) => i.textContent).join(' | '));
            ok('    对话模型带徽标', items.length === 2
                && !!items[0].querySelector('.v-badge') && !!items[1].querySelector('.v-badge'),
                items.map((i) => i.textContent).join(' | '));
            env.calls.length = 0;
            items[1].dispatchEvent(new w.Event('click', { bubbles: true }));
            await flush();
            eq('    点一个模型就写回模型框', cred.querySelector('input[data-field="model"]').value,
                'deepseek-reasoner');
            ok('      并顺手落盘', !!env.lastCmd('trans_set_cred'),
                JSON.stringify(env.calls.map((c) => c.cmd)));
        }

        // 「同时翻译」多选：不含默认引擎；勾一家 → trans_set_multi 带回清洗后的名单
        const chips = [...$('w-transMultiBox').querySelectorAll('.multi-chip')];
        ok('  再点开时名单还是默认引擎之外的那几家',
            chips.length === 10 && !!chips.find((c) => c.dataset.id === 'baidu'),
            chips.map((c) => c.dataset.id).join(','));
        env.calls.length = 0;
        chips.find((c) => c.dataset.id === 'zhipu')
            .dispatchEvent(new w.Event('click', { bubbles: true }));   // zhipu
        await flush();
        const ms = env.lastCmd('trans_set_multi');
        ok('点胶囊走 trans_set_multi（把新勾的那家加进去）',
            !!ms && JSON.stringify(ms.args.engines) === JSON.stringify(['zhipu']),
            JSON.stringify(ms && ms.args));
        ok('  后端回传后那一格点亮',
            [...$('w-transMultiBox').querySelectorAll('.multi-chip')]
                .filter((c) => c.classList.contains('on')).map((c) => c.dataset.id).join(',') === 'zhipu',
            [...$('w-transMultiBox').querySelectorAll('.multi-chip')]
                .map((c) => c.dataset.id + (c.classList.contains('on') ? '(on)' : '')).join(','));

        // 默认目标语言
        const tOpts = [...$('w-transTarget').querySelectorAll('option')].map((o) => o.value);
        ok('默认目标语言下拉由后端语言表填充',
            tOpts.join(',') === 'zh,zh-TW,en,ja', tOpts.join(','));
        eq('  选中配置里的默认语言', $('w-transTarget').value, 'ja');
        $('w-transTarget').value = 'zh';
        $('w-transTarget').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        const tl = env.lastCmd('set_setting');
        ok('  切默认目标语言写配置',
            !!tl && tl.args.key === 'transTarget' && tl.args.value === 'zh',
            JSON.stringify(tl && tl.args));

        // 「去控制台申请 Key」按钮已按用户要求删掉（每家引擎旁边本来就有
        // 「?」和「文档」两颗按钮能直接跳转，不必再多一个）。
        ok('不再有「去控制台申请 Key」按钮', !$('btnTransAk'));
        // 那两颗跳转按钮必须真的挂上了（点一下要调后端命令）
        const helps = [...$('w-transEngList').querySelectorAll('.eng-help')];
        ok('每家引擎旁边都有「?」和「文档」两颗按钮',
            helps.length >= 2 && helps.some((b) => b.textContent === '?')
                && helps.some((b) => b.textContent === '文档'),
            '按钮数 ' + helps.length);
        /* 光"在"不算数 —— 用户原话是「每一个翻译引擎旁边的问号和文档按钮
         * 点击后都没有生效」，所以这里真点一下，看后端命令有没有被调到、
         * 带的是不是这一家的 id。命令本身已经在 Rust 侧改成
         * `async` + `spawn_blocking`（不再阻塞主线程），这里只钉前端这条线。 */
        const helpQ = helps.find((b) => b.textContent === '?');
        helpQ.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const hCall = env.lastCmd('trans_open_help');
        ok('  点「?」真的调到 trans_open_help 且带引擎 id',
            !!hCall && !!hCall.args.engine, JSON.stringify(hCall && hCall.args));
        const helpDoc = helps.find((b) => b.textContent === '文档');
        helpDoc.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const dCall = env.lastCmd('trans_open_docs');
        ok('  点「文档」真的调到 trans_open_docs 且带引擎 id',
            !!dCall && !!dCall.args.engine, JSON.stringify(dCall && dCall.args));

        ok('@trans 不在横条时「把翻译加进横条」按钮出现', $('btnTransInBar').hidden === false);
        $('btnTransInBar').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const tb = env.lastCmd('toggle_bar_engine');
        ok('  点它调 toggle_bar_engine 加 @trans',
            !!tb && tb.args.engine === '@trans' && tb.args.on === true,
            JSON.stringify(tb && tb.args));

        // 引擎页横条列表：@trans 成员行（可拖 / 可换图标 / 可移出）
        env.pushConfig(baseConf({ barList: ['百度', '@trans', 'Google'] }));
        await flush();
        const rows2 = [...$('barList').querySelectorAll('.trans-row-item')];
        const members = rows2.filter((r) => !r.classList.contains('add-row'));
        const adds = rows2.filter((r) => r.classList.contains('add-row'));
        ok('引擎页横条列表渲染 @trans 成员行（可拖 / 可换图标 / 可移出）',
            members.length === 1 && adds.length === 0,
            '成员行 ' + members.length + ' / 入口行 ' + adds.length);
        ok('  成员行名字显示为「翻译」',
            members[0] && members[0].querySelector('.nm').textContent.indexOf('翻译') >= 0);
        /* v1.5.17：@trans 成员行的图标也是那张内置的「翻译.png」
         * （设置页和横条走同一个 qsTransIconNode，两边长得一样）。
         * v1.5.19：图标改成**内嵌**的 base64 data URI —— 契约从
         * 「src 指向 data/icons/trans.png」改成「src 是内嵌 data URI」。 */
        const mImg = members[0] && members[0].querySelector('img');
        ok('  成员行图标是**内嵌**的「翻译-copy.png」',
            !!mImg && /^data:image\/png;base64,/.test(mImg.getAttribute('src')),
            mImg && String(mImg.getAttribute('src')).slice(0, 48));
        ok('@trans 已在横条时翻译页的「加进横条」按钮隐藏', $('btnTransInBar').hidden === true);

        env.pushConfig(baseConf({ barList: ['百度', 'Google'] }));
        await flush();
        const adds2 = [...$('barList').querySelectorAll('.trans-add-row')];
        ok('@trans 不在横条时引擎页出现「＋ 加进横条」入口行', adds2.length === 1);
        ok('  此时翻译页的按钮又出现', $('btnTransInBar').hidden === false);
    }

    console.log('');
    console.log('=== 设置页：老牌翻译引擎的凭据（两家一起） ===');
    /* ⑧b 百度 / 有道 的凭据是「主凭据 + 副凭据」成对的（APP ID + 密钥），
     *   少一样签不出请求 —— 所以凭据区必须多出一个副凭据输入框。
     *   谷歌只要一个 API Key，不该有多余的框。 */
    {
        const env = makeEnv('ui/settings.html', baseConf({
            transEnable: true, transEngine: 'baidu', transMulti: [],
            transTarget: 'zh',
        }));
        // 百度：APP ID + 密钥
        env.pushConfig(baseConf({
            transEnable: true, transEngine: 'baidu', transMulti: [],
            transTarget: 'zh',
            transCreds: { baidu: { key: '2024bdappid', secret: 'baidu-secret' } },
        }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await new Promise((r) => setTimeout(r, 60));
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const cred = $('w-transCredBox');
        const fld = (f) => cred.querySelector('input[data-field="' + f + '"]');
        ok('百度的凭据区有「APP ID」和「密钥」两个密码框',
            !!fld('key') && !!fld('secret')
            && fld('key').type === 'password' && fld('secret').type === 'password');
        ok('  标签分别是「APP ID」和「密钥」',
            [...cred.querySelectorAll('.cred-row label')].map((l) => l.textContent).join('/')
            === 'APP ID/密钥',
            [...cred.querySelectorAll('.cred-row label')].map((l) => l.textContent).join('/'));
        eq('  两个框都回填配置里的值', fld('key').value + '/' + fld('secret').value,
            '2024bdappid/baidu-secret');
        ok('  老牌引擎不渲染模型框（它们不靠模型名工作）', !fld('model'));
        // 改副凭据 → trans_set_cred 要把 secret 一起发出去
        env.calls.length = 0;
        fld('secret').value = 'new-secret';
        fld('secret').dispatchEvent(new w.Event('change', { bubbles: true }));
        await flush();
        const sc = env.lastCmd('trans_set_cred');
        ok('  改副凭据走 trans_set_cred 且带上 secret',
            !!sc && sc.args.engine === 'baidu' && sc.args.secret === 'new-secret',
            JSON.stringify(sc && sc.args));

        // 谷歌：只要一个 API Key，不该有副凭据框
        env.pushConfig(baseConf({
            transEnable: true, transEngine: 'google', transMulti: [],
            transTarget: 'zh',
            transCreds: { google: { key: 'g-key' } },
        }));
        await flush();
        const cred2 = $('w-transCredBox');
        ok('谷歌的凭据区只有一个 API Key，没有副凭据框',
            !!cred2.querySelector('input[data-field="key"]')
            && !cred2.querySelector('input[data-field="secret"]'));
        eq('  标签是「API Key」',
            cred2.querySelector('.cred-row label').textContent, 'API Key');
    }

    console.log('');
    console.log('=== 横条上的翻译按钮 ===');
    /* ⑨ index.html：@trans 渲染 / 点击带 currentText / 开关关闭时不渲染。
     *   哨兵在配置里仍保留（用户下次开开关它就回到原位）。 */
    {
        const env = makeEnv('ui/index.html', baseConf({ barList: ['百度', '@trans', 'Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/bar.js', 'ui/glass.js']);
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const styleEl = w.document.createElement('style');
        styleEl.textContent = read('ui/bar.css');
        w.document.head.appendChild(styleEl);
        await flush();

        const transBtn = () => $('engines').querySelector('.qs-trans-inbar');
        ok('bar_list 里有 @trans 时横条渲染出翻译按钮', !!transBtn());
        /* v1.5.17：默认图标换成了用户指定的那张图，不再是「译」文字徽标。
         * v1.5.19：图标改成**内嵌**的 base64 data URI —— 契约从
         * 「src 指向 data/icons/trans.png」改成「src 是内嵌 data URI」。 */
        const transImg = () => transBtn() && transBtn().querySelector('img');
        ok('  默认图标是**内嵌**的「翻译-copy.png」（<img>，不是文字徽标）',
            !!transImg() && /^data:image\/png;base64,/.test(transImg().getAttribute('src')),
            transImg() && String(transImg().getAttribute('src')).slice(0, 48));
        ok('  徽标文字不再出现在按钮里',
            transBtn() && transBtn().textContent.trim() === '',
            transBtn() && transBtn().textContent);
        ok('  右键菜单能认它（dataset.engine = @trans，可换图标 / 移出）',
            transBtn() && transBtn().dataset.engine === '@trans');

        /* 用户自己换过的图优先于内置默认图（overrideIcons > 内置图）。 */
        env.pushConfig(baseConf({
            barList: ['百度', '@trans', 'Google'],
            overrideIcons: { '@trans': 'data:image/png;base64,iVBORw0KGgo=' },
        }));
        await flush();
        const customImg = transBtn() && transBtn().querySelector('img');
        ok('  用户换过图标时优先显示用户那张',
            !!customImg && customImg.getAttribute('src').indexOf('base64') >= 0,
            customImg && customImg.getAttribute('src'));
        env.pushConfig(baseConf({ barList: ['百度', '@trans', 'Google'] }));
        await flush();

        // 模拟 Ctrl+C 带出一段文字，然后点翻译（用户的使用姿势）
        const show = env.listeners.get('qs://show');
        show({ payload: { text: 'translate me please', isUrl: false, ocrOnly: false } });
        await flush();
        env.calls.length = 0;
        transBtn().dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
        await flush();
        const ts = env.lastCmd('trans_start');
        ok('点横条翻译按钮调 trans_start，并带上横条此刻这段文字',
            !!ts && ts.args.text === 'translate me please',
            JSON.stringify(ts && ts.args));

        env.pushConfig(baseConf({ barList: ['百度', '@trans', 'Google'], transEnable: false }));
        await flush();
        ok('翻译开关关掉后横条上的翻译按钮不渲染', !transBtn());
        env.pushConfig(baseConf({ barList: ['百度', '@trans', 'Google'], transEnable: true }));
        await flush();
        ok('  开关打开后按钮回到原位', !!transBtn());
    }
}
async function testOcrSettingsPage() {
    console.log('');
    console.log('=== 文字识别页：按钮显隐 ===');

    // ① OCR 不在横条里 → 「把 OCR 加进横条」按钮出现
    {
        const env = makeEnv('ui/settings.html', baseConf({ barList: ['百度', 'Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const b = $('btnOcrInBar');
        ok('OCR 不在横条时，「把 OCR 加进横条」按钮出现', b && b.hidden === false);
        // 用户要求：这颗按钮和「引擎」页的换图标功能重复，删掉
        ok('文字识别页不再有重复的「换个图标…」按钮', !$('btnOcrIcon'));
    }

    // ② OCR 已经在横条里 → 按钮整个收起来（用户明确要求）
    {
        const env = makeEnv('ui/settings.html', baseConf({ barList: ['百度', '@ocr', 'Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const b = $('btnOcrInBar');
        ok('OCR 已在横条时，「把 OCR 加进横条」按钮隐藏', b && b.hidden === true);
    }

    /* ③ 「引擎」页横条列表：OCR 已在横条里时**不得**再画「＋ 加进横条」入口行
     *    （用户本轮报的 bug：横条里明明有 OCR，底部还挂着一个入口行，点一下
     *     还会再钉一根哨兵 —— 两行 OCR。根因是 list 是 {name, idx} 对象数组，
     *     拿 `list.includes(QS_OCR)` 判恒为 false。） */
    {
        const env = makeEnv('ui/settings.html',
            baseConf({ barList: ['百度', '@ocr', 'Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const $ = (id) => env.w.document.getElementById(id);
        const ocrRows = [...$('barList').querySelectorAll('.ocr-row')];
        const addRows = ocrRows.filter((r) => r.classList.contains('add-row'));
        const memberRows = ocrRows.filter((r) => !r.classList.contains('add-row'));
        ok('【bug】OCR 已在横条里：横条列表只有成员行、没有「加进横条」入口行（不重复显示）',
            memberRows.length === 1 && addRows.length === 0,
            '成员行 ' + memberRows.length + ' 个 / 入口行 ' + addRows.length + ' 个');
    }
    // ④ 反方向：OCR 不在横条里 → 有入口行、没有成员行
    {
        const env = makeEnv('ui/settings.html', baseConf({ barList: ['百度', 'Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const $ = (id) => env.w.document.getElementById(id);
        const ocrRows = [...$('barList').querySelectorAll('.ocr-row')];
        const addRows = ocrRows.filter((r) => r.classList.contains('add-row'));
        const memberRows = ocrRows.filter((r) => !r.classList.contains('add-row'));
        ok('【bug】OCR 不在横条里：只有入口行、没有成员行',
            addRows.length === 1 && memberRows.length === 0,
            '成员行 ' + memberRows.length + ' 个 / 入口行 ' + addRows.length + ' 个');
        ok('【bug】入口行的按钮写的是「＋ 加进横条」',
            /加进横条/.test(addRows[0] ? addRows[0].textContent : ''),
            addRows[0] && addRows[0].textContent.trim());
    }
}

/* ================================================================== */
/*  本地 OCR 环境检测（设置页·文字识别）                                    */
/* ================================================================== */

/** 用户要求：进 OCR 页就自动检测系统组件是否齐全；缺什么、有什么用、怎么补，
 *  逐项说清楚，并给一键安装 / 教程 / 重新检测入口。这里钉死四件事：
 *  ① boot 自动检测 ② 全就绪的绿卡 ③ 缺项的黄卡 + 按钮分发 ④ 检测失败的兜底。 */
/** r46：环境检测改成**按需**了 —— 用户原话「这个环境检测你直接提供一个按钮，
 *  我没点击，他就不用告诉我说是否已准备就绪」。所以每个用例都得先点一下
 *  「检测本地 OCR 环境」才会出结果（点之前必须是折叠态）。 */
async function runDepCheck(env) {
    const b = env.w.document.querySelector('#w-ocrDep button[data-act="check"]');
    if (b) b.dispatchEvent(new env.w.Event('click', { bubbles: true }));
    await flush();
}

async function testOcrDepCheck() {
    console.log('');
    console.log('=== 本地 OCR 环境检测（设置页·文字识别）===');

    /* ① r46：boot **不再自动检测**，只给一颗按钮（用户没点就不告诉他） */
    {
        OCR_DEP_MISS = [];
        const env = makeEnv('ui/settings.html', baseConf());
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        eq('boot 时**不**去检测本地 OCR 环境（用户没点就不查）',
            env.cmd('ocr_env_check').length, 0);
        const box = env.w.document.getElementById('w-ocrDep');
        ok('折叠态没有任何检测结论（没有 banner、没有依赖卡片）',
            !!box && !box.querySelector('.dep-banner')
            && box.querySelectorAll('.dep-item').length === 0,
            box && box.textContent.trim().slice(0, 40));
        ok('折叠态给了「检测本地 OCR 环境」按钮',
            !!box.querySelector('button[data-act="check"]'));
        await runDepCheck(env);
        eq('点了按钮才真去检测（ocr_env_check 被调 1 次）',
            env.cmd('ocr_env_check').length, 1);
        ok('检测结果渲染出卡片（不再是占位文案 / 折叠提示）',
            !!box && !!box.querySelector('.dep-banner'));
    }

    /* ② 全就绪：绿 banner + 三项全绿 + 只留「重新检测」 */
    {
        OCR_DEP_MISS = [];
        const env = makeEnv('ui/settings.html', baseConf());
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await runDepCheck(env);
        const w = env.w;
        const box = w.document.getElementById('w-ocrDep');
        const banner = box.querySelector('.dep-banner');
        ok('全就绪时是绿色 banner（.dep-banner.ok）',
            !!banner && banner.classList.contains('ok'),
            banner && banner.className);
        ok('  banner 文案写「环境就绪」',
            /环境就绪/.test(banner ? banner.textContent : ''));
        const items = [...box.querySelectorAll('.dep-item')];
        eq('  三项依赖全部列出', items.length, 3);
        eq('  全部是 is-ok', items.filter((x) => x.classList.contains('is-ok')).length, 3);
        ok('  徽标写「已就绪」',
            items.every((x) => {
                const b = x.querySelector('.dep-badge');
                return b && b.textContent === '已就绪';
            }));
        const fixRows = [...box.querySelectorAll('.dep-line')].filter((d) => {
            const i = d.querySelector('i');
            return i && i.textContent === '怎么补';
        });
        eq('  就绪项不给「怎么补」行（没什么要补的）', fixRows.length, 0);
        ok('  全就绪时不出现「一键安装」按钮', !box.querySelector('button[data-act="lang"]'));
        ok('  全就绪时不出现「查看官方教程」按钮', !box.querySelector('button[data-act="help"]'));
        const rc = box.querySelector('button[data-act="recheck"]');
        ok('  保留「重新检测」按钮（ghost 样式）', !!rc && /重新检测/.test(rc.textContent));
    }

    /* ③ 缺 2 项（语言包 + 语言匹配）：黄 banner + is-miss 卡片 + 一键安装按钮 */
    {
        OCR_DEP_MISS = ['lang', 'profile'];
        const env = makeEnv('ui/settings.html', baseConf());
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await runDepCheck(env);
        const w = env.w;
        const box = w.document.getElementById('w-ocrDep');
        const banner = box.querySelector('.dep-banner');
        ok('缺 2 项时是黄色 banner（.dep-banner.miss）',
            !!banner && banner.classList.contains('miss'),
            banner && banner.className);
        ok('  banner 明说「缺 2 项组件」',
            /缺\s*2\s*项组件/.test(banner ? banner.textContent : ''),
            banner && banner.textContent.trim().slice(0, 40));
        const miss = [...box.querySelectorAll('.dep-item.is-miss')];
        eq('  缺项渲染成 is-miss（2 个）', miss.length, 2);
        eq('  就绪项仍渲染成 is-ok（引擎本体）', box.querySelectorAll('.dep-item.is-ok').length, 1);
        ok('  缺项徽标写「待补充」',
            miss.every((x) => {
                const b = x.querySelector('.dep-badge');
                return b && /待补充/.test(b.textContent);
            }));
        const fixRows = [...box.querySelectorAll('.dep-item.is-miss .dep-line')].filter((d) => {
            const i = d.querySelector('i');
            return i && i.textContent === '怎么补';
        });
        eq('  每个缺项都有「怎么补」行', fixRows.length, 2);
        ok('  缺项卡片写出组件作用（「作用」行）',
            [...box.querySelectorAll('.dep-item.is-miss .dep-line i')].some((i) => i.textContent === '作用'));
        const lang = box.querySelector('button[data-act="lang"]');
        ok('  出现「一键安装：打开语言设置」按钮',
            !!lang && /一键安装/.test(lang.textContent), lang && lang.textContent);
        ok('  引擎本体（winrt）没缺 → 不出现「查看官方教程」', !box.querySelector('button[data-act="help"]'));

        /* 按钮分发：一键安装 → 打开系统语言设置；重新检测 → 再跑一次检测 */
        lang.dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('  点「一键安装」调用 ocr_open_language_settings',
            !!env.lastCmd('ocr_open_language_settings'));
        env.calls.length = 0;
        box.querySelector('button[data-act="recheck"]')
            .dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        eq('  点「重新检测」重新跑一次 ocr_env_check', env.cmd('ocr_env_check').length, 1);
    }

    /* ④ 引擎本体也缺：追加「查看官方教程」按钮（解决不了语言包问题时的出路） */
    {
        OCR_DEP_MISS = ['winrt', 'lang', 'profile'];
        const env = makeEnv('ui/settings.html', baseConf());
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await runDepCheck(env);
        const w = env.w;
        const box = w.document.getElementById('w-ocrDep');
        const banner = box.querySelector('.dep-banner');
        ok('三项全缺 banner 写「缺 3 项组件」',
            /缺\s*3\s*项组件/.test(banner ? banner.textContent : ''));
        const help = box.querySelector('button[data-act="help"]');
        ok('引擎本体缺失时出现「查看官方教程」按钮', !!help);
        help.dispatchEvent(new w.Event('click', { bubbles: true }));
        ok('  点它调用 ocr_open_lang_help', !!env.lastCmd('ocr_open_lang_help'));
    }

    /* ⑤ 检测本身失败（后端异常）：不装成「环境有问题」——那是另一回事 */
    {
        OCR_DEP_MISS = [];
        const env = makeEnv('ui/settings.html', baseConf());
        env.rejectCmds.add('ocr_env_check');
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        await runDepCheck(env);
        const box = env.w.document.getElementById('w-ocrDep');
        const banner = box.querySelector('.dep-banner');
        ok('检测本身失败时显示「检测没跑起来」而不是误报缺项',
            !!banner && /检测没跑起来/.test(banner.textContent));
        ok('  失败态不给依赖卡片（没有 is-miss 误报）',
            box.querySelectorAll('.dep-item').length === 0);
        const retry = box.querySelector('button[data-act="recheck"]');
        ok('  失败态给「重试」按钮', !!retry && /重试/.test(retry.textContent));
    }

    /* ⑥ r46：切引擎**不再**顺带刷新检测（改成按需），但 ocrEngine 照旧写回后端 */
    {
        OCR_DEP_MISS = [];
        const env = makeEnv('ui/settings.html', baseConf());
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        env.calls.length = 0;
        // ⚠ 引擎选择器从 r45 起是**列表**（#w-ocrEngList 一行一家），
        //   老的两档 seg（#s-ocrEngine）已经不存在了。
        const row = env.w.document
            .querySelector('#w-ocrEngList .eng-row[data-id="windows"] .eng-name');
        ok('引擎列表里能找到「本地识别」那一行', !!row);
        row.dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        eq('切引擎**不会**顺带跑环境检测（改成按需了）',
            env.cmd('ocr_env_check').length, 0);
        const ss = env.lastCmd('set_setting');
        ok('  同时把 ocrEngine 写回后端',
            !!ss && ss.args.key === 'ocrEngine' && ss.args.value === 'windows',
            JSON.stringify(ss && ss.args));
    }
}

/* ================================================================== */
/*  图标编辑器（#143）                                                  */
/* ================================================================== */

/** 设置页六处「编辑图标」入口：按钮显隐条件 + 递进编辑器的 key/srcHint。
 *  口径和 Rust 的 open_icon_editor 三级解析对齐（overrideIcons →
 *  icons 目录同名默认图 → 内置 iconFile），前端只负责把原图找出来。 */
async function testIconEditorEntries() {
    console.log('');
    console.log('=== 图标编辑器入口（设置页「编辑图标」，#143）===');

    // ① 横条行：换过图的亮按钮、递 override 的 data URL；没图标的（字母徽标）不亮
    {
        const env = makeEnv('ui/settings.html', baseConf({
            barList: ['百度', 'Google', '测试引擎'],
            overrideIcons: { '百度': 'data:image/png;base64,QmFpZHU=' },
            // 自定义引擎没有 iconFile、也没挑过图 → 纯字母徽标，没有像素可编辑
            customEngines: [{ name: '测试引擎', url: 'https://x.com/s?q=%s', category: '自定义' }],
        }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const rows = [...env.w.document.querySelectorAll('#barList .item:not(.add-row)')];
        const bdRow = rows.find((r) => r.textContent.includes('百度'));
        const csRow = rows.find((r) => r.textContent.includes('测试引擎'));
        const bdBtn = [...bdRow.querySelectorAll('.mini')].find((b) => b.textContent === '编辑图标');
        ok('横条行换过图标 → 有「编辑图标」按钮', !!bdBtn);
        ok('横条行只有字母徽标 → 不亮「编辑图标」（没像素可编辑）',
            ![...csRow.querySelectorAll('.mini')].some((b) => b.textContent === '编辑图标'));
        env.calls.length = 0;
        bdBtn.dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        const c = env.lastCmd('open_icon_editor');
        ok('点「编辑图标」调用了 open_icon_editor', !!c,
            JSON.stringify(env.calls.map((x) => x.cmd)));
        eq('  键 = 引擎名', c && c.args.key, '百度');
        eq('  srcHint = 当前图标（override 的 data URL）',
            c && c.args.srcHint, 'data:image/png;base64,QmFpZHU=');
    }

    // ② OCR 行：同一套条件（@ocr 哨兵，没有内置图，只认 override）
    {
        const env = makeEnv('ui/settings.html', baseConf({
            barList: ['百度', '@ocr'],
            overrideIcons: { '@ocr': 'data:image/png;base64,T0NS' },
        }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const row = [...env.w.document.querySelectorAll('#barList .item:not(.add-row)')]
            .find((r) => r.classList.contains('ocr-row'));
        const btn = [...row.querySelectorAll('.mini')].find((b) => b.textContent === '编辑图标');
        ok('OCR 行换过图标 → 有「编辑图标」按钮', !!btn);
        env.calls.length = 0;
        btn.dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        const c = env.lastCmd('open_icon_editor');
        ok('点它调用了 open_icon_editor', !!c);
        eq('  键 = @ocr 哨兵', c && c.args.key, '@ocr');
        eq('  srcHint = OCR 当前图标', c && c.args.srcHint, 'data:image/png;base64,T0NS');
    }

    // ③ 只有内置 iconFile 的引擎：按钮也亮（Rust 三级解析的第三级），
    //    前端先把 data/icons/xxx.svg fetch 成 data URL 递过去
    {
        const env = makeEnv('ui/settings.html', baseConf({ barList: ['Google'] }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const row = [...env.w.document.querySelectorAll('#barList .item:not(.add-row)')]
            .find((r) => r.textContent.includes('Google'));
        const btn = [...row.querySelectorAll('.mini')].find((b) => b.textContent === '编辑图标');
        ok('只有内置 iconFile 的引擎也有「编辑图标」（吃第三级解析）', !!btn);
        env.calls.length = 0;
        btn.dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        await new Promise((r) => setTimeout(r, 30));
        const c = env.lastCmd('open_icon_editor');
        ok('点它调用了 open_icon_editor', !!c);
        ok('  srcHint 是 fetch 内置图标得到的 data URL',
            !!(c && /^data:/.test(c.args.srcHint || '')),
            c && String(c.args.srcHint).slice(0, 40));
    }

    // ④ 自定义引擎行：和表单那个「编辑」并存，文案必须是「编辑图标」不重名
    {
        const env = makeEnv('ui/settings.html', baseConf({
            barList: [],
            overrideIcons: { '我的镜像': 'data:image/png;base64,eA==' },
            customEngines: [{ name: '我的镜像', url: 'https://x.com/s?q=%s', category: '自定义' }],
        }));
        runScripts(env, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        // 自定义列表在「引擎」页里渲染，直接调渲染函数（和真机同一条路）
        env.w.eval('renderCustomList()');
        const row = [...env.w.document.querySelectorAll('#customList .item')]
            .find((r) => r.textContent.includes('我的镜像'));
        const btns = [...row.querySelectorAll('.mini')].map((b) => b.textContent);
        ok('自定义引擎行同时有表单「编辑」和「编辑图标」（不重名）',
            btns.includes('编辑') && btns.includes('编辑图标'), btns.join('/'));
        env.calls.length = 0;
        [...row.querySelectorAll('.mini')].find((b) => b.textContent === '编辑图标')
            .dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        const c = env.lastCmd('open_icon_editor');
        ok('点「编辑图标」调用了 open_icon_editor', !!c);
        eq('  键 = 自定义引擎名', c && c.args.key, '我的镜像');
    }

    // ⑤ 静态口径：六个挂点一个不少（防止将来改渲染时悄悄漏掉哪处）
    {
        const src = read('ui/settings.js');
        const hooks = (src.match(/openIconEditor\(/g) || []).length;
        ok('settings.js 里 openIconEditor 挂点 ≥ 6（横条 OCR/普通、全部引擎、自定义、软件、收藏目录）',
            hooks >= 6, '实际 ' + hooks);
        ok('helper 有「没有图片就不亮按钮」的护栏（hasIconToEdit）',
            /function hasIconToEdit/.test(src));
        ok('helper 只把 data: 开头的原图递进编辑器（Rust 只认 data URL）',
            /src\.indexOf\('data:'\) === 0/.test(src));
    }
}

/** 编辑器窗口页面本身（ui/iconedit.html）：会话装载 / 消除 / 容差重算 /
 *  保存 / 取消 / SVG / 窗口复用 / 会话过期。 */
async function testIconEditorPage() {
    console.log('');
    console.log('=== 图标编辑器窗口（ui/iconedit.html，#143）===');

    // ① 位图会话全流程：boot → 一键消除 → 保存（存的是处理结果）
    ICON_SESSION = { key: '百度', name: '百度', src: 'data:image/png;base64,U3Jj', vector: false };
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('boot 时拉了会话（icon_edit_load）', !!env.lastCmd('icon_edit_load'));
        ok('标题栏显示引擎显示名', $('ieName').textContent.indexOf('百度') >= 0,
            $('ieName').textContent);
        ok('编辑前预览指向原图', $('imgBefore').getAttribute('src') === 'data:image/png;base64,U3Jj');
        ok('保存按钮初始禁用（还没处理过）', $('btnSave').disabled === true);

        env.calls.length = 0;
        $('btnRemove').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const rm = env.lastCmd('icon_remove_bg');
        ok('点「一键消除背景」调用了 icon_remove_bg', !!rm,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        /* r80 起「容差」换成「参数」六件套（maskThreshold/feather/…），
         * 不再有 tolerance 字段 —— 断默认参数而不是一个不存在的数字。 */
        eq('  带的是默认参数（maskThreshold 128 / feather 1 / fg 240 / bg 15）',
            rm && JSON.stringify(rm.args.params),
            JSON.stringify({ maskThreshold: 128, feather: 1, fgConfidence: 240,
                bgConfidence: 15, edgeDecontaminate: true, dropSmallIslands: true }));
        eq('  从原图算起（src = 会话原图）', rm && rm.args.src, 'data:image/png;base64,U3Jj');
        ok('  提示已抠掉的像素数', /已抠掉 1,234 个背景像素/.test($('hint').textContent),
            $('hint').textContent);
        ok('  消除后保存按钮启用', $('btnSave').disabled === false);

        env.calls.length = 0;
        $('btnSave').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const sv = env.lastCmd('icon_editor_save');
        ok('点保存调用了 icon_editor_save', !!sv,
            JSON.stringify(env.calls.map((c) => c.cmd)));
        eq('  保存的是处理结果（不是原图）', sv && sv.args.src, 'data:image/png;base64,T1VU');
        ok('  保存后关窗', !!env.lastCmd('close_icon_editor'));
    }

    // ② 取消：只关窗，一个字节都不写回配置
    ICON_SESSION = { key: 'Google', name: 'Google', src: 'data:image/png;base64,U3Jj', vector: false };
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        env.calls.length = 0;
        env.w.document.getElementById('btnCancel')
            .dispatchEvent(new env.w.Event('click', { bubbles: true }));
        await flush();
        ok('取消只关窗、不保存', !!env.lastCmd('close_icon_editor') && !env.lastCmd('icon_editor_save'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
    }

    /* ③ 原「容差滑块防抖重算」用例：r80 起「调容差」那个滑块已从产品里删掉
     * （重抠走「参数」面板 + 手动补描），#tol / #tolVal 两个元素都没了，
     * 再跑就是 $('tol').value 直接 TypeError —— 按事实删掉，不改成假通过。 */

    // ④ SVG：消除按钮禁用，但保存仍可用（原样应用）
    ICON_SESSION = { key: 'X', name: '矢量引擎', src: 'data:image/svg+xml;base64,PHN2Zz4=', vector: true };
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        ok('SVG 会话：「一键消除背景」禁用', $('btnRemove').disabled === true);
        ok('SVG 会话：保存仍可用（原样应用）', $('btnSave').disabled === false);
        ok('SVG 会话：有说明提示', /SVG/.test($('hint').textContent), $('hint').textContent);
        env.calls.length = 0;
        $('btnSave').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        const sv = env.lastCmd('icon_editor_save');
        ok('SVG 点保存存的是原图 src', !!sv && sv.args.src === 'data:image/svg+xml;base64,PHN2Zz4=',
            sv && String(sv.args.src));
    }

    // ⑤ removed=0：已经是透明底 →  warn 提示，不假装成功
    ICON_SESSION = { key: 'Y', name: 'Y', src: 'data:image/png;base64,U3Jj', vector: false };
    ICON_REMOVE = { src: 'data:image/png;base64,T1VU', removed: 0 };
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        $('btnRemove').dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        ok('抠掉 0 像素时提示「可能已经是透明背景」',
            /已经是透明背景/.test($('hint').textContent), $('hint').textContent);
    }
    ICON_REMOVE = { src: 'data:image/png;base64,T1VU', removed: 1234 };

    // ⑥ 窗口复用：Rust 换会话后推 qs://icon-edit-load，页面整场重载
    ICON_SESSION = { key: 'A', name: 'A', src: 'data:image/png;base64,QQ==', vector: false };
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        const { w } = env;
        const $ = (id) => w.document.getElementById(id);
        const cb = env.listeners.get('qs://icon-edit-load');
        ok('页面监听 qs://icon-edit-load（窗口复用时的重载推送）', typeof cb === 'function');
        // 真机上 Rust 是**先换会话再推事件**，页面收到后会重新 icon_edit_load；
        // 桩要照着这个顺序演，不然拉回来的还是旧会话。
        ICON_SESSION = { key: 'B', name: 'B', src: 'data:image/png;base64,Qg==', vector: false };
        cb({ payload: ICON_SESSION });
        await flush();
        ok('  新会话把标题换成 B', $('ieName').textContent.indexOf('B') >= 0,
            $('ieName').textContent);
        ok('  编辑前预览换成新会话的图',
            $('imgBefore').getAttribute('src') === 'data:image/png;base64,Qg==');
        ok('  编辑后 pane 复位（保存重新禁用）', $('btnSave').disabled === true);
    }

    // ⑦ 会话过期（窗口被复用但 Rust 清了场）：提示 + 自动关窗，不开空编辑器
    ICON_SESSION = null;
    {
        const env = makeEnv('ui/iconedit.html', baseConf());
        await flush();
        await new Promise((r) => setTimeout(r, 900));
        ok('会话过期时自动关窗（不留空编辑器）', !!env.lastCmd('close_icon_editor'),
            JSON.stringify(env.calls.map((c) => c.cmd)));
    }
}

async function testSettingsPreviewDark() {
    console.log('');
    console.log('=== 设置面板：深色背景预览 ===');
    const env = makeEnv('ui/settings.html', baseConf({ theme: 'light' }));
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);

    const sw = $('s-previewDark');
    ok('设置面板有「在深色背景上预览」开关', !!sw);
    if (!sw) return;
    // 默认：浅色主题下开关应该是关的
    ok('浅色主题下预览开关默认关（深色场景由用户主动打开）', sw.checked === false);
    ok('  预览舞台未挂 data-dark',
        !$('previewStageA').hasAttribute('data-dark'));

    // 打开开关 → 预览舞台标 data-dark=1
    sw.checked = true;
    sw.dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush();
    ok('打开开关后预览舞台挂 data-dark="1"',
        $('previewStageA').getAttribute('data-dark') === '1');
    ok('  引擎页那边的预览舞台也同步切换',
        $('previewStageB').getAttribute('data-dark') === '1');

    // 关闭开关
    sw.checked = false;
    sw.dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush();
    ok('关闭后回到浅色预览', !$('previewStageA').hasAttribute('data-dark'));

    /* ---- 预览：必须和横条真身一个样 ----
     * 用户报过"预览和横条不一致"。两个窗口两份样式表，只能各写一份 ——
     * 所以拿**源码**对拍：预览里的 --pv-* 口径必须和 bar.css 的 --qs-* 一致。
     * 液态玻璃整套已删除（#27）：预览同样只允许扁平材质 + 悬停淡度。 */
    const setCss = fs.readFileSync(path.join(ROOT, 'ui/settings.css'), 'utf8');
    const barCss = fs.readFileSync(path.join(ROOT, 'ui/bar.css'), 'utf8');
    const setCssPlain = setCss.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('【删净玻璃】settings.css 不再有任何 pv-glass / pv-gloss / pv-lift / pv-sheen / pv-frost / pv-lens',
        !/pv-glass|--pv-gloss|--pv-lift|--pv-sheen|--pv-frost|pv-lens/.test(setCssPlain));
    ok('【删净玻璃】settings.html 不再挂 pvLensSvg 折射滤镜',
        !/pvLensSvg|pv-lens/.test(fs.readFileSync(path.join(ROOT, 'ui/settings.html'), 'utf8')));
    const setJsRaw = fs.readFileSync(path.join(ROOT, 'ui/settings.js'), 'utf8');
    ok('【删净玻璃】settings.js 不再有 glass / pv-glass / qsLensUpdate 引用',
        !/pv-glass|glassOn|qsLensUpdate|--pv-frost/.test(setJsRaw));
    ok('【删净玻璃】settings.js 的开关表里没有 s-glass',
        !/'s-glass'/.test(setJsRaw));
    ok('【预览】预览的 box-shadow 只留 --pv-shadow 一段（和 .bar 一致）',
        /\.qs-preview\s*\{[^}]*box-shadow:\s*var\(--pv-shadow\)\s*;/.test(setCssPlain));
    ok('【预览】预览不再多一圈描边、也没有厚度渐变那层 background-image',
        /\.qs-preview\s*\{[^}]*border:\s*none/.test(setCssPlain)
        && !/\.qs-preview\s*\{[^}]*background-image/.test(setCssPlain));
    ok('【预览】预览外影跟「浮层阴影」开关走（renderPreview 写 --pv-shadow）',
        /--pv-shadow/.test(setJsRaw));
    // 悬停淡度在预览里同样要能试（用户第一优先级功能）
    ok('【预览·悬停淡度】预览默认就挂待机淡度（opacity: var(--pv-dim-alpha)）',
        /\.qs-preview\s*\{[^}]*opacity:\s*var\(--pv-dim-alpha/.test(setCssPlain));
    ok('【预览·悬停淡度】鼠标移到预览上 = 悬停 → 过渡到 --pv-alpha',
        /\.qs-preview:hover\s*\{\s*opacity:\s*var\(--pv-alpha/.test(setCssPlain));
    ok('【预览·悬停淡度】预览 transition 带着 opacity（平滑）',
        /\.qs-preview\s*\{[^}]*transition:[^;]*opacity\s+\.\d+s/.test(setCssPlain));
    ok('【预览·悬停淡度】renderPreview 写 --pv-dim-alpha（和真身同一个滑块）',
        /--pv-dim-alpha/.test(setJsRaw));
    // 真身与预览的默认待机淡度必须同值（一个 .45，一个 .45）
    ok('【预览·悬停淡度】预览默认 .45；bar.css 里 --qs-dim-alpha 有默认值',
        /--pv-dim-alpha:\s*\.45/.test(setCss)
        && /--qs-dim-alpha/.test(barCss.replace(/\/\*[\s\S]*?\*\//g, '')));
    // renderPreview 活着：跑一遍真的 settings 环境，确认变量写进了预览盒子
    {
        const env2 = makeEnv('ui/settings.html', baseConf({ barDimAlpha: 30 }));
        runScripts(env2, ['ui/shared.js', 'ui/settings.js']);
        await flush();
        const d2 = env2.w.document;
        const boxA = d2.getElementById('qsPreviewA');
        ok('【预览·悬停淡度】renderPreview 把 barDimAlpha 写进预览盒子',
            !!boxA && boxA.style.getPropertyValue('--pv-dim-alpha') === '0.30',
            boxA && boxA.style.getPropertyValue('--pv-dim-alpha'));
        ok('【预览·悬停淡度】预览盒子没有 pv-glass 类（整套删净）',
            !d2.getElementById('previewStageA').classList.contains('pv-glass'));
    }
}

/* ================================================================== */
async function testRegion() {
    console.log('');
    console.log('=== OCR 框选层（ui/region.html）===');
    const env = makeEnv('ui/region.html', {});
    const calls = env.calls;
    const { w } = env;

    // 页面自己的脚本已经在 makeEnv 里随 HTML 跑起来了（runScripts: dangerously）
    await flush();

    // ---- 正常从左上往右下拖 ----
    mouse(env, 'mousedown', 100, 200);
    mouse(env, 'mousemove', 300, 320);
    mouse(env, 'mouseup', 300, 320);
    await flush();

    const r = env.lastCmd('ocr_region');
    ok('【bug2】框完调用了 ocr_region', !!r, JSON.stringify(calls.map((c) => c.cmd)));
    if (r) {
        const a = r.args;
        ok('【bug2】四个坐标全是有限数字（NaN 会让命令根本不执行）',
            ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(a[k])),
            JSON.stringify(a));
        eq('【bug2】x/y 取左上角', [a.x, a.y], [100, 200]);
        eq('【bug2】w/h 是正的', [a.w, a.h], [200, 120]);
    }
    // ---- 反向拖（右下 → 左上）也要归一化 ----
    {
        const env2 = makeEnv('ui/region.html', {});
        await flush();
        mouse(env2, 'mousedown', 800, 600);
        mouse(env2, 'mousemove', 400, 300);
        mouse(env2, 'mouseup', 400, 300);
        await flush();
        const r2 = env2.lastCmd('ocr_region');
        ok('【bug2】反向拖也调用了 ocr_region', !!r2);
        if (r2) {
            eq('【bug2】反向拖的 x/y 仍然是左上角', [r2.args.x, r2.args.y], [400, 300]);
            eq('【bug2】反向拖的 w/h 仍然是正数', [r2.args.w, r2.args.h], [400, 300]);
        }
    }

    // ---- 误点（几乎没拖动）不该触发识别 ----
    {
        const env3 = makeEnv('ui/region.html', {});
        await flush();
        mouse(env3, 'mousedown', 500, 500);
        mouse(env3, 'mouseup', 503, 502);
        await flush();
        ok('【bug2】误点一下不会去识别', !env3.lastCmd('ocr_region'),
            JSON.stringify(env3.calls.map((c) => c.cmd)));
    }

    // ---- Esc 必须能退出（否则用户只能杀进程）----
    {
        const env4 = makeEnv('ui/region.html', {});
        await flush();
        const ev = new env4.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        env4.w.document.dispatchEvent(ev);
        await flush();
        ok('【bug2】按 Esc 会调用 ocr_cancel 关掉遮罩', !!env4.lastCmd('ocr_cancel'),
            JSON.stringify(env4.calls.map((c) => c.cmd)));
    }

    // ---- 识别失败也要退场，不能把用户困住 ----
    {
        const env5 = makeEnv('ui/region.html', {});
        await flush();
        // 让后端这条命令直接失败，看前端会不会自己退场
        env5.rejectCmds.add('ocr_region');
        mouse(env5, 'mousedown', 100, 100);
        mouse(env5, 'mousemove', 400, 400);
        mouse(env5, 'mouseup', 400, 400);
        await flush();
        ok('【bug2】识别失败时兜底调用 ocr_cancel（不把用户困在遮罩里）',
            !!env5.lastCmd('ocr_cancel'), JSON.stringify(env5.calls.map((c) => c.cmd)));
    }
}

/* ================================================================== */
/*  五、备份页：仅保留最近 10 份 / 云端备份管理（轮 20 新增）            */
/* ================================================================== */

/* v1.5.9：备份可移植性状态条
 *
 * # 为什么值得专门测
 *
 * 这块在**纠正一句长期存在的错误文案**（「留空 = 不加密」）。一旦有人把那句话
 * 加回去、或者状态条画反了（把 DPAPI 说成"可跨机"），用户就会在换电脑那天
 * 才发现整份备份作废 —— 那时候已经晚了，谁也救不回来。
 *
 * 所以这里钉三件事：DPAPI 必须报"仅本机可解"、有密码必须报"可跨设备"、
 * 那句错话不许回来。
 */
/* v1.5.10：加密导出勾选框 + 导入密码框 + 额度用量
 *
 * 用户 2026-10-25 的三条要求：
 *   1) 导出按钮旁有勾选框，勾了加密、不勾不加密；**含隐私项时强制加密**；
 *   2) 导入加密文件时要输入密码；
 *   3) 令牌框下面显示"已经连了多少次 / 总共多少次"。
 *
 * 前两条是安全动作：错了不是难看，是数据泄露或自己的文件打不开。
 * 所以"强制"那一条要专门验 —— 用户能取消勾选的话，"强制"就不成立了。
 */
/* v1.5.11：下载失败时页面该怎么表现
 *
 * 用户报「能检测到新版，但下载不下来」。后端已经补了超时/续传/换源，
 * 但**前端原来只写一句"更新失败"**，真正的原因塞进 toast 一闪就没 ——
 * 用户不知道断在网络、校验还是被拒，也就没法判断该重试还是换条路。
 */
async function testDownloadFailureRoute() {
    console.log('');
    console.log('=== 下载失败：原因留在页面上 + 自动切兜底入口（v1.5.11）===');
    const env = makeEnv('ui/settings.html', baseConf({ githubToken: 'ghp_x' }));
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);

    // 先摆一个"发现新版本"的状态（按钮应该是「下载并安装」）
    const upd = env.listeners.get('qs://update');
    ok('登记了 qs://update', !!upd);
    upd({
        payload: {
            newer: true, version: '99.0.0', notes: '说明', size: 13415936,
            canAuto: true, authed: true,
            url: 'https://github.com/o/r/releases/download/v99/QuickSearch.exe',
            page: 'https://example.com/release',
        },
    });
    await flush();
    eq('发现新版时按钮是「下载并安装」', $('btnUpdateInstall').textContent, '下载并安装');

    // 然后失败一次（后端给的是"已重试几轮"的完整说法）
    const fail = env.listeners.get('qs://update-failed');
    ok('登记了 qs://update-failed', !!fail);
    fail({
        payload: '下载中断（已下 8388608 字节）：连接被重置（已自动重试 4 轮）'
            + '—— 网络一直不稳的话，点「用浏览器下载」',
    });
    await flush();

    ok('失败原因**留在页面上**（不是只发一条会消失的 toast）',
        /已自动重试 4 轮/.test($('updHint').textContent || ''),
        $('updHint').textContent);
    ok('  不再是一句干巴巴的「更新失败」',
        $('updHint').textContent !== '更新失败');
    eq('主按钮切成兜底入口', $('btnUpdateInstall').textContent, '用浏览器下载');
    ok('  下载直链一并显示出来（用户能复制/点开）',
        $('updLinkRow').hidden === false);
    ok('  进度条收起', $('updProgress').hidden === true);
    ok('  按钮恢复可点（不是灰着让人以为卡住）',
        $('btnUpdateInstall').disabled === false);
}

async function testExportEncryptAndImportPass() {
    console.log('');
    console.log('=== 加密导出勾选框 / 导入密码框 / 额度用量（v1.5.10）===');
    const env = makeEnv('ui/settings.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    await flush();   // export_groups_list 是异步拿的，要等它回来才渲染勾选表
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));

    // ---- ① 勾选框本身 ----
    const enc = $('s-exportEncrypt');
    ok('数据页有「加密导出」勾选框', !!enc);
    ok('  默认不勾（用户没要求就出明文）', enc && enc.checked === false);
    ok('  默认可用（还没勾到隐私项）', enc && enc.disabled === false);
    ok('  默认不显示"强制加密"提示', $('exportEncHint') && $('exportEncHint').hidden === true);

    const boxes = () => Array.from($('w-exportBox').querySelectorAll('input[type=checkbox]'));
    const boxOf = (id) => boxes().find((b) => b.dataset.id === id);
    const tick = (id, on) => {
        const b = boxOf(id);
        b.checked = on;
        b.dispatchEvent(new w.Event('change', { bubbles: true }));
    };
    ok('导出勾选表渲染出来了（3 组）', boxes().length === 3, String(boxes().length));

    // ---- ② 勾隐私项 → 强制勾上并锁住 ----
    tick('apiKeys', true);
    await flush();
    ok('勾了隐私项：加密被自动勾上', enc.checked === true);
    ok('  并且**锁住**（不能被取消 —— 否则"强制"不成立）', enc.disabled === true);
    ok('  勾选框整行标成锁定态', /locked/.test($('exportEncWrap').className || ''));
    ok('  明确写出"强制加密"', /强制加密/.test($('exportEncHint').textContent || '')
        && $('exportEncHint').hidden === false);

    // 含隐私项导出 → 后端拿到的 encrypt 必须是 true
    env.calls.length = 0;
    click($('btnDoExport'));
    await flush();
    let c = env.lastCmd('export_items');
    ok('含隐私项导出：encrypt=true 传给后端', !!(c && c.args && c.args.encrypt === true),
        c && JSON.stringify(c.args));

    // ---- ③ 取消隐私项 → 恢复可选、自动回到未勾 ----
    tick('apiKeys', false);
    await flush();
    ok('取消隐私项：勾选框恢复可用', enc.disabled === false);
    ok('  并且自动回到未勾（不把上次的强制当成用户意图）', enc.checked === false);
    ok('  强制提示收起来', $('exportEncHint').hidden === true);

    env.calls.length = 0;
    click($('btnDoExport'));
    await flush();
    c = env.lastCmd('export_items');
    ok('普通项导出：encrypt=false（不出加密文件）', !!(c && c.args && c.args.encrypt === false),
        c && JSON.stringify(c.args));

    // ---- ④ 手动勾加密 → 传 true ----
    enc.checked = true;
    env.calls.length = 0;
    click($('btnDoExport'));
    await flush();
    c = env.lastCmd('export_items');
    ok('手动勾了加密：encrypt=true', !!(c && c.args && c.args.encrypt === true));
    enc.checked = false;

    /* ---- ⑤ 导入：收到"要密码"事件 → 弹框 ---- */
    ok('密码框默认藏着', $('impPassBox').hidden === true);
    const needPass = env.listeners.get('qs://import-need-password');
    ok('设置页登记了 qs://import-need-password', !!needPass);
    needPass({ payload: { name: 'config(2026-10-25 10-00-00).qsconf' } });
    await flush();
    ok('收到事件后弹出密码框', $('impPassBox').hidden === false);
    ok('  说明里带上文件名（用户能确认是这份）',
        /config\(2026-10-25 10-00-00\)/.test($('impPassSub').textContent || ''),
        $('impPassSub').textContent);

    // 空密码：不提交，就地提示
    env.calls.length = 0;
    $('impPassInput').value = '';
    click($('btnImpPassOk'));
    await flush();
    ok('空密码不提交，框里提示', /先输入密码/.test($('impPassErr').textContent || '')
        && $('impPassErr').hidden === false);
    ok('  也没调用后端', env.cmd('import_with_password').length === 0);

    // 密码错：框**不能**关（要能就地重输）
    env.setImportFail('密码不对，解不开这份文件');
    $('impPassInput').value = 'wrong';
    click($('btnImpPassOk'));
    await flush();
    ok('密码错了：框不关（关了就得重新选文件）', $('impPassBox').hidden === false);
    ok('  错误显示在框里', /解不开/.test($('impPassErr').textContent || ''),
        $('impPassErr').textContent);

    // 密码对：交给后端，关框
    env.setImportFail('');
    $('impPassInput').value = 'right-pw';
    env.calls.length = 0;
    click($('btnImpPassOk'));
    await flush();
    c = env.lastCmd('import_with_password');
    ok('密码对：把密码交给后端', !!(c && c.args && c.args.password === 'right-pw'),
        c && JSON.stringify(c.args));
    ok('  导入成功后关框', $('impPassBox').hidden === true);

    // 取消：告诉后端丢掉待导入的文件
    needPass({ payload: { name: 'x.qsconf' } });
    await flush();
    env.calls.length = 0;
    click($('btnImpPassCancel'));
    await flush();
    ok('取消会告诉后端丢弃待导入的文件', env.cmd('import_cancel').length === 1);
    ok('  并且关框', $('impPassBox').hidden === true);

    // Enter 也能提交（键盘用户）
    needPass({ payload: { name: 'y.qsconf' } });
    await flush();
    $('impPassInput').value = 'pw2';
    env.calls.length = 0;
    $('impPassInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    ok('在密码框里按 Enter 也能导入', env.cmd('import_with_password').length === 1);
    $('impPassInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    /* ---- ⑥ 额度用量 ---- */
    const rate = $('githubRateLine');
    ok('令牌框下面有额度行', !!rate);

    env.setRateState({ ok: true, authed: true, limit: 5000, remaining: 4997, used: 3, reset: 0 });
    env.listeners.get('qs://update')({ payload: { newer: false, manual: true } });
    await flush();
    ok('额度行显示"已请求 3 次 / 共 5000 次"',
        /已请求\s*3\s*次\s*\/\s*共\s*5000\s*次/.test(rate.textContent || ''),
        rate.textContent);
    ok('  还写了本小时剩多少', /还剩\s*4997\s*次/.test(rate.textContent || ''));
    ok('  带令牌时不显示匿名提示', !/匿名额度/.test(rate.textContent || ''));
    ok('  没有标成匿名样式', !/anon/.test(rate.className || ''));

    env.setRateState({ ok: true, authed: false, limit: 60, remaining: 58, used: 2, reset: 0 });
    env.listeners.get('qs://update')({ payload: { newer: false, manual: true } });
    await flush();
    ok('匿名时额度是 60', /共\s*60\s*次/.test(rate.textContent || ''), rate.textContent);
    ok('  并提示填令牌可以提额度', /匿名额度/.test(rate.textContent || ''));
    ok('  标成匿名样式（换个颜色）', /anon/.test(rate.className || ''));

    env.setRateState({ ok: false, error: '连不上' });
    env.listeners.get('qs://update')({ payload: { newer: false, manual: true } });
    await flush();
    ok('查不到额度时整行藏起来（不留过期数字）', rate.hidden === true);
}

async function testBackupSecurity() {
    console.log('');
    console.log('=== 备份可移植性状态条（v1.5.9）===');
    const env = makeEnv('ui/settings.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    // 切到备份页会触发 refreshBackupInfo → refreshBackupSec
    const tabBtn = w.document.querySelector('#tabs button[data-tab="backup"]');
    ok('备份 tab 存在（下面靠它触发刷新）', !!tabBtn);
    const openBackup = async () => {
        tabBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
        await flush();
        await flush();
    };

    // ---- ① 没设备份密码 = DPAPI：必须说清"换机恢复不了" ----
    env.setSecState({
        hasPassword: false, envelope: 'dpapi', portable: false,
        hasToken: false, secretCount: 2,
    });
    await openBackup();
    const sec = $('bkSec');
    ok('状态条显示出来了', !!sec && !sec.hidden);
    ok('  标成「警告」样式', sec && /warn/.test(sec.className || ''), sec && sec.className);
    ok('  文案说清只有本机能解',
        /仅本机可解/.test((sec && sec.textContent) || ''), sec && sec.textContent);
    ok('  文案给出下一步（设备份密码）', /备份密码/.test((sec && sec.textContent) || ''));
    ok('  带上凭据数量', /2 项凭据/.test((sec && sec.textContent) || ''), sec && sec.textContent);

    // ---- ② 设了密码：可跨设备 ----
    env.setSecState({
        hasPassword: true, envelope: 'password', portable: true,
        hasToken: true, secretCount: 3,
    });
    await openBackup();
    ok('设了密码：标成「正常」样式', /ok/.test($('bkSec').className || ''), $('bkSec').className);
    ok('  文案说清可跨设备恢复', /可跨设备恢复/.test($('bkSec').textContent || ''));
    ok('  提到令牌但**不显示令牌本身**',
        /含 GitHub 个人访问令牌/.test($('bkSec').textContent || '')
        && !/ghp_|github_pat_/.test($('bkSec').textContent || ''),
        $('bkSec').textContent);

    // ---- ③ 那句错话不许回退 ----
    const card = $('bkSec').closest('.card');
    ok('「留空 = 不加密」这句错话已删掉',
        !/留空\s*=\s*不加密/.test((card && card.textContent) || ''));
    ok('  改成说清实际后果（仅本机 / 换机恢复不了）',
        /仅本机可解|换机器恢复不了/.test((card && card.textContent) || ''));
}

async function testBackupPage() {
    console.log('');
    console.log('=== 备份页：仅保留最近 10 份 / 云端备份管理 ===');
    const env = makeEnv('ui/settings.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    // ⚠ jsdom 的 window.confirm 是 "not implemented"（返回 undefined = 取消）。
    //   不桩的话所有二次确认都会静默走"取消"分支，真正要测的东西一行都跑不到。
    let confirmed = 0;
    w.confirm = () => { confirmed++; return true; };

    // ---- ① 「备份文件名」设置项已删（本地叫什么，云端就叫什么） ----
    ok('「备份文件名」输入框已经删掉', !$('w-webdavFile'));

    // ---- ② 仅保留最近 10 份 ----
    env.calls.length = 0;
    $('btnBkKeep10').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const prune = env.calls.find((c) => c.cmd === 'prune_backups');
    ok('点「仅保留最近 10 份」调用了 prune_backups', !!prune,
        JSON.stringify(env.calls.map((c) => c.cmd)));
    eq('  传的 keep = 10', prune && prune.args.keep, 10);
    ok('  删除前做了二次确认（本地 + 云端都是不可逆的）', confirmed > 0);

    // ---- ③ 云端列表：管理（多选）模式 ----
    const listCb = env.listeners.get('qs://wd-list');
    ok('设置页登记了 qs://wd-list 的接收', !!listCb);
    const items = [
        { name: 'config(2026-10-12 10-00-00).QuickSearch', size: 2048, mtime: 1760000000 },
        { name: 'config(2026-10-11 10-00-00).QuickSearch', size: 2048, mtime: 1759900000 },
        { name: 'config(2026-10-10 10-00-00).QuickSearch', size: 2048, mtime: 1759800000 },
    ];
    listCb({ payload: items });
    await flush();
    eq('云端列表渲染出 3 条', $('wdItems').children.length, 3);
    eq('  默认是恢复模式（没有复选框）',
        $('wdItems').querySelectorAll('input[type=checkbox]').length, 0);
    ok('  默认收起管理模式的操作按钮', $('wdActsManage').hidden === true);

    $('btnWdManage').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    eq('点「管理」后每行变成可勾选', $('wdItems').querySelectorAll('input[type=checkbox]').length, 3);
    ok('  管理模式的操作按钮亮出来', $('wdActsManage').hidden === false);
    ok('  恢复模式的操作按钮收起来', $('wdActsNormal').hidden === true);
    ok('  没勾任何一份时「删除选中」是禁用的', $('btnWdDelete').disabled === true);

    const boxes = [...$('wdItems').querySelectorAll('input[type=checkbox]')];
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new w.Event('change', { bubbles: true }));
    boxes[2].checked = true;
    boxes[2].dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush();
    ok('  勾选后按钮解禁并带上数量',
        $('btnWdDelete').disabled === false && $('btnWdDelete').textContent.includes('2'),
        $('btnWdDelete').textContent);

    env.calls.length = 0;
    $('btnWdDelete').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const del = env.calls.find((c) => c.cmd === 'webdav_delete');
    ok('点「删除选中」调用了 webdav_delete', !!del,
        JSON.stringify(env.calls.map((c) => c.cmd)));
    eq('  传的正好是勾中的那两份',
        JSON.stringify((del && del.args.files) || []),
        JSON.stringify([items[0].name, items[2].name]));

    $('btnWdSelAll').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    eq('「全选」把三份都勾上', $('wdItems').querySelectorAll('input:checked').length, 3);
    $('btnWdSelNone').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    eq('「全不选」清空勾选', $('wdItems').querySelectorAll('input:checked').length, 0);

    $('btnWdManageDone').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('点「完成」退回恢复模式',
        $('wdItems').querySelectorAll('input[type=checkbox]').length === 0
        && $('wdActsManage').hidden === true);

    // ---- ④ 云端列表变空时自动退出管理模式（别停在"没有条目可选"的死界面） ----
    $('btnWdManage').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('  先确认又进了管理模式', $('wdActsManage').hidden === false);
    listCb({ payload: [] });
    await flush();
    ok('云端列表空了以后自动退出管理模式', $('wdActsManage').hidden === true);

    // ---- ⑤ 清理冗余数据：先扫后删 ----
    // ⚠ 这个按钮碰的是数据目录里的文件，所以必须先扫描、把清单摆出来，
    //   用户点了「确认清理」才真删。下面按这个顺序验。
    ok('备份页有「清理冗余数据」按钮', !!$('btnBkCleanup'));
    ok('  扫描结果面板默认是收着的', $('bkCleanup').hidden === true);

    env.calls.length = 0;
    $('btnBkCleanup').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const scanCall = env.calls.find((c) => c.cmd === 'cleanup_data');
    ok('点一下先**只扫描**（apply=false）', !!scanCall && scanCall.args.apply === false,
        JSON.stringify(env.calls.map((c) => [c.cmd, c.args])));
    ok('  清单面板亮出来', $('bkCleanup').hidden === false);
    ok('  标题报出了「几个文件、多少空间」', /^可以清理 3 个文件/.test($('bkCleanupTitle').textContent),
        $('bkCleanupTitle').textContent);
    eq('  逐类列出（2 类）', $('bkCleanupList').querySelectorAll('li').length, 2);
    ok('  每一类都写了「为什么它算冗余」',
        [...$('bkCleanupList').querySelectorAll('.bk-cu-why')].every((n) => n.textContent.length > 5));
    ok('  「没动」的那些也说明了原因（不能装作没看见）',
        [...$('bkCleanupList').querySelectorAll('.bk-cu-skip')].some((n) => n.textContent.includes('解不开')));

    env.calls.length = 0;
    $('btnBkCleanupGo').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const applyCall = env.calls.find((c) => c.cmd === 'cleanup_data');
    ok('点「确认清理」才真删（apply=true）', !!applyCall && applyCall.args.apply === true,
        JSON.stringify(env.calls.map((c) => [c.cmd, c.args])));
    ok('  清完把清单收起来', $('bkCleanup').hidden === true);
    ok('  状态栏报了清理结果', $('wdStatus').textContent.includes('3'), $('wdStatus').textContent);

    // 再点一次扫描：这次桩返回同样的清单，验证「算了」能取消
    env.calls.length = 0; // 清账：否则上一步 apply=true 还留在 calls 里，下面会误判「发了删除命令」
    $('btnBkCleanup').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('  重新扫描又亮出来', $('bkCleanup').hidden === false);
    $('btnBkCleanupCancel').dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    ok('点「算了，先不动」直接收起，不发任何删除命令',
        $('bkCleanup').hidden === true
        && !env.calls.some((c) => c.cmd === 'cleanup_data' && c.args.apply === true),
        JSON.stringify(env.calls.map((c) => [c.cmd, c.args])));
}

/* ================================================================== */
/*  六、横条收藏面板：展开/折叠按钮只在「含二级目录」时出现（轮 20）      */
/* ================================================================== */

async function testFavTools() {
    console.log('');
    console.log('=== 横条收藏面板：全部展开/折叠的显示条件 ===');
    const env = makeEnv('ui/index.html', baseConf({
        favorites: [
            {
                id: 'g1', name: '有子目录', icon: '', items: [],
                children: [{
                    id: 'g1a', name: '子目录', icon: '', children: [],
                    items: [{ id: 'i1', kind: 'text', text: '一', html: '', remark: '' }],
                }],
            },
            {
                id: 'g2', name: '没子目录', icon: '', children: [],
                items: [{ id: 'i2', kind: 'text', text: '二', html: '', remark: '' }],
            },
        ],
        barList: ['百度', '@fav:g1', '@fav:g2'],
    }));
    runScripts(env, ['ui/shared.js', 'ui/bar.js', 'ui/glass.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    const cell = (s) => $('engines').querySelector(`[data-fav="${s}"]`);

    ok('横条上有两个收藏夹格子', !!cell('@fav:g1') && !!cell('@fav:g2'));

    // ① 含二级目录 → 出现这两颗按钮
    cell('@fav:g1').click();
    await flush();
    ok('含二级目录的收藏夹：标题栏出现「全部展开 / 全部折叠」',
        !!$('panel').querySelector('.fav-head-tools'));
    const tools = [...$('panel').querySelectorAll('.fav-head-tools .fav-tool')];
    eq('  正好两颗按钮', tools.length, 2);
    eq('  第一颗是全部展开', tools[0] && tools[0].textContent, '全部展开');
    eq('  第二颗是全部折叠', tools[1] && tools[1].textContent, '全部折叠');

    // ② 不含二级目录 → 一颗都不给（点了也没意义，还容易误操作）
    cell('@fav:g2').click();
    await flush();
    ok('没有二级目录的收藏夹：标题栏**不出现**这两颗按钮',
        !$('panel').querySelector('.fav-head-tools'));
    ok('  但目录内容照样列出来了', $('panel').textContent.includes('二'));

    // ③ 快捷键唤起的根视图：只要**有任何一个**一级目录含二级目录就显示
    const favOpen = env.listeners.get('qs://fav-open');
    ok('横条登记了 qs://fav-open 的接收', !!favOpen);
    if (favOpen) {
        favOpen({ payload: null });
        await flush();
        ok('根视图里有目录含二级目录 → 按钮出现',
            !!$('panel').querySelector('.fav-head-tools'));
    }
}

/* ================================================================== */
/*  七、更多引擎面板：分类跳转要减掉吸附头高度（轮 21）                  */
/* ================================================================== */

/* ============================================================================
 *  更多引擎面板：不该闪的那两下（2026-10-25）
 *
 *  用户报「选择一段文字，然后点开更多引擎，页面会闪烁好几次，之后才开始稳定」。
 *  查下来是三处重绘叠在一起，其中两处在面板自己这边：
 *
 *    ① 每次打开都 `panelBody.textContent = ''` 再重建几百个格子 —— 重建的几十
 *       毫秒里浏览器已经把"空面板"合成上屏，就是一帧白闪。而打开面板时内容
 *       跟上次收起时**一模一样**，重建收益为 0。
 *    ② 收起时只清 `engineFilterText` 这个**变量**，DOM 里被 hidden 的格子原样
 *       留着（以前靠"下次打开必然重画"兜着）。①一旦改成"不重建"，这个脏状态
 *       就会露出来 —— 再打开看到的是上次筛剩下的那半截列表。
 *
 *  （第三处是玻璃抓屏"藏舞台两帧"，在 ui/glass.js 里。jsdom 没有布局引擎
 *    也没有 WebGL，测不到，只能真机验。）
 *
 *  这两条都是"看不出来但会让人以为列表坏了"的类型，钉住。
 * ========================================================================== */
async function testPanelNoFlicker() {
    console.log('');
    console.log('=== 更多引擎面板：打开不重建 / 收起还原过滤 ===');
    const env = makeEnv('ui/index.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/bar.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    const body = $('panelBody');

    $('btnMore').click();
    await flush();

    const cellsOf = () => [...body.querySelectorAll('.grid > .cell')];
    const visibleOf = () => cellsOf().filter((c) => !c.hidden);
    ok('  面板打开后有格子', cellsOf().length > 0, String(cellsOf().length));

    /* ① 收起再打开：格子必须还是**同一批节点**（没走 textContent='' 那条路）。 */
    const before = cellsOf();
    const firstCell = before[0];
    $('btnMore').click();          // 收起
    await flush();
    $('btnMore').click();          // 再打开
    await flush();
    const after = cellsOf();
    ok('  再次打开面板不重建 DOM（同一个节点实例）',
        after.length === before.length && after[0] === firstCell,
        `${before.length} → ${after.length}`);

    /* ② 搜一下把列表筛窄 → 收起 → 再打开，必须回到"全部都在"。
     *    以前这里会命中缓存、把上一轮的 hidden 原样端出来。 */
    const full = visibleOf().length;
    const engFilter = $('engFilter');
    engFilter.value = '哔哩';
    engFilter.dispatchEvent(new w.Event('input'));
    await flush();
    const narrowed = visibleOf().length;
    ok('  输入过滤词后可见格子变少', narrowed > 0 && narrowed < full,
        `${full} → ${narrowed}`);

    $('btnMore').click();          // 收起（这一步负责把 DOM 的过滤状态也撤掉）
    await flush();
    $('btnMore').click();          // 再打开
    await flush();
    eq('  收起再打开，列表回到完整状态（DOM 过滤已撤销）', visibleOf().length, full);
    ok('  搜索框也跟着清空了', String(engFilter.value) === '', JSON.stringify(engFilter.value));
}

async function testCatJump() {
    console.log('');
    console.log('=== 更多引擎面板：分类跳转的吸附头补偿 ===');
    const env = makeEnv('ui/index.html', baseConf());
    runScripts(env, ['ui/shared.js', 'ui/bar.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);

    $('btnMore').click();
    await flush();

    // #140 之后面板默认就是平铺视图（不再有大类卡片下钻），吸附头和分类
    // 导航打开即有：锚点导航挂在子类节上（.cat-nav，排除大类胶囊行 .grp-nav
    // 和收藏夹导航 .fav-nav）。
    const body = $('panelBody');
    const sticky = body.querySelector('.panel-sticky');
    const navBtns = [...body.querySelectorAll('.grp-nav .grp-item')];   // r53：中类锚点收进胶囊，这里改成一级大类胶囊
    ok('面板渲染出一级目录胶囊（≥ 4 项：全部 + 网页/软件/快捷键引擎）',
        navBtns.length >= 4, String(navBtns.length));
    ok('  吸附头存在（收藏夹入口 + 分类导航同住一个 sticky 容器）', !!sticky);

    /* r53：中类锚点导航换成了「胶囊过滤」—— 下面这套断言原来测的是**已经删掉的**
     * 跳转功能（减吸附头高度、点谁亮谁、动画期间不改高亮），按事实换成新行为的
     * 断言。跳转那套机器（scrollPanelToCat / paintCatNav …）还留在 bar.js 里，
     * 但导航不再调用它，所以这里不再假装测它；真实面板的胶囊行为由
     * tools/r51-lib-probe.js 的 ②/③ 覆盖（22 PASS / 0 FAIL）。 */
    /* r75：中类也从下拉胶囊改成**平铺胶囊**（用户原话：「最好中类也作为胶囊式的，
     * 点击中类后，才会展开中类下面的小类」）—— 和一级大类、三级小类一个口径。 */
    const chips2 = () => [...w.document.querySelectorAll('#panelPick2 .cat-chip')];
    ok('  打开面板时二级胶囊不存在（只显示一级目录）', chips2().length === 0);

    const gWeb = navBtns.find((b) => /网页引擎/.test(b.textContent));
    gWeb && gWeb.click();
    await flush();

    const c2 = chips2();
    ok('  点了大类之后二级胶囊出现（r75：平铺一排，「全部中类」+ 每个中类一颗）',
        c2.length >= 3 && !w.document.querySelector('#panelPick2 .qs-pick'),
        c2.map((b) => b.textContent).join(' / '));
    ok('  「全部中类」默认高亮（还没选中任何中类）',
        c2[0] && /全部中类/.test(c2[0].textContent) && c2[0].classList.contains('on'));
    eq('  头里除了大类行只有二级胶囊行（老的平铺中类锚点已作废）',
        body.querySelectorAll('.cat-nav:not(.grp-nav):not(.fav-nav)').length, 1);
    const secsFiltered = [...body.querySelectorAll('.cat-title[data-cat]')].filter((x) => !x.hidden);
    ok('  过滤之后正文只剩这一类（网页引擎下的中类节）', secsFiltered.length >= 1,
        secsFiltered.map((x) => x.textContent).join(' / '));
    ok('  三级胶囊还没出现（要点了中类才展开它下面的小类）',
        w.document.querySelectorAll('#panelPick3 .cat-chip').length === 0);

    c2[1] && c2[1].click();
    await flush();
    eq('选了一个中类 → 正文只剩这一节（选哪个显示哪个）',
        [...body.querySelectorAll('.cat-title[data-cat]')].filter((x) => !x.hidden).length, 1);
    /* r75 的直接回归：paintCatNav（滚动高亮同步）以前会把**所有**非大类行的
     * .cat-nav-item 按 data-cat 重画 —— 二/三级胶囊没有 data-cat，于是点完
     * 中类/小类，'on' 立刻被剥掉，用户看到一个都不亮，以为没点上。
     * （r73 起三级就是胶囊，这条一直藏着；r75 二级也改胶囊，必须钉住。） */
    const c2after = chips2();
    ok('  选中的中类胶囊保持高亮（不被锚点高亮同步剥掉）',
        c2after[1] && c2after[1].classList.contains('on')
        && !c2after[0].classList.contains('on'),
        c2after.map((b) => b.textContent + (b.classList.contains('on') ? '[on]' : '')).join(' / '));
    /* 三级：原来是「一个胶囊 + 下拉菜单」，用户要求改成**平铺胶囊** ——
     * 「选择完中类之后，小类最好是每一个就都呈现出来，一种胶囊的形式，这样我要
     * 哪个我点击就可以了，不用再一个个的找」。所以这里断的是 .cat-chip 平铺、
     * 且**不再有** .qs-pick 下拉。 */
    const chips3 = [...w.document.querySelectorAll('#panelPick3 .cat-chip')];
    ok('  三级改成平铺胶囊（一颗小类一颗胶囊，不再是下拉菜单）',
        chips3.length >= 2 && !w.document.querySelector('#panelPick3 .qs-pick'),
        chips3.map((b) => b.textContent).join(' / '));
    ok('  三级还没选时，小类标题都露着（目录不遮内容）',
        [...body.querySelectorAll('.cat-sub')].every((s) => !s.hidden));

    chips3[1] && chips3[1].click();
    await flush();
    eq('  点一颗小类 → 正文只剩这一类',
        [...body.querySelectorAll('.cat-sub')].filter((s) => !s.hidden).length, 1);
    const chips3after = [...w.document.querySelectorAll('#panelPick3 .cat-chip')];
    ok('  选中的小类胶囊也保持高亮（同上，paintCatNav 不能碰筛选行）',
        chips3after[1] && chips3after[1].classList.contains('on')
        && !chips3after[0].classList.contains('on'),
        chips3after.map((b) => b.textContent + (b.classList.contains('on') ? '[on]' : '')).join(' / '));


    // 数据侧：分组改造必须落到真实目录文件里
    const cat = JSON.parse(read('ui/data/engines.json'));
    const titles = cat.categories.map((c) => c.title);
    ok('engines.json 里已经没有「我的」分组', !titles.includes('我的'));
    ok('  换成了「网盘」分组，且不止一条', titles.includes('网盘')
        && cat.categories.find((c) => c.title === '网盘').engines.length >= 5,
        JSON.stringify(titles.filter((t) => /网盘|我的/.test(t))));
}

/* ================================================================== */
/*  v1.5.7：GitHub 个人访问令牌                                         */
/* ================================================================== */
async function testUpdateToken() {
    console.log('=== 更新：GitHub 个人访问令牌（v1.5.7）===');
    const env = makeEnv('ui/settings.html', baseConf({ githubToken: 'ghp_x' }));
    runScripts(env, ['ui/shared.js', 'ui/settings.js']);
    await flush();
    const { w } = env;
    const $ = (id) => w.document.getElementById(id);
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));

    // ---- 控件本身 ----
    const tok = $('s-githubToken');
    ok('更新卡里有令牌输入框', !!tok);
    ok('  是密码框（不明文回显）', tok && tok.type === 'password');
    ok('  回显了配置里已保存的值', tok && tok.value === 'ghp_x');
    ok('  placeholder 说清了"留空 = 匿名 60 次/小时"',
        tok && /60 次/.test(tok.getAttribute('placeholder') || ''));

    const help = $('btnGithubTokenHelp');
    ok('标签旁有问号按钮', !!help);
    ok('  用原生 button（Tab 可聚焦、Enter/Space 可触发）',
        help && help.tagName === 'BUTTON' && !help.disabled);
    ok('  有 aria-label（读屏能念出用途）',
        help && /GitHub 个人访问令牌/.test(help.getAttribute('aria-label') || ''));
    ok('  有提示气泡文案',
        help && /什么是 GitHub 个人访问令牌/.test(help.getAttribute('data-tip') || ''));

    // 点问号 → 用系统浏览器打开官方中文文档（不是 webview 内跳转）
    env.calls.length = 0;
    click(help);
    await flush();
    const docCmd = env.lastCmd('open_links');
    const docUrl = docCmd && (docCmd.args.links || [])[0];
    ok('  点问号打开的是 GitHub 官方中文帮助文档',
        docUrl === 'https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
        String(docUrl));

    /* ---- v1.5.8：令牌的「验证」「保存」---- */
    const vbtn = $('btnGithubTokenVerify');
    const sbtn = $('btnGithubTokenSave');
    ok('令牌旁边有「验证」按钮', !!vbtn && vbtn.textContent.trim() === '验证');
    ok('  也有「保存」按钮', !!sbtn && sbtn.textContent.trim() === '保存');
    ok('  当前输入就是已保存的那版 → 保存按钮置灰',
        sbtn && sbtn.disabled === true);

    // 空输入点验证：不联网，直接说"先填一个"
    env.calls.length = 0;
    $('s-githubToken').value = '';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    ok('  一改动，保存按钮就亮起来', sbtn.disabled === false);
    click(vbtn);
    await flush();
    ok('空令牌点验证：不发请求，只提示先填',
        env.cmd('verify_github_token').length === 0
        && /先填/.test($('githubTokenStatus').textContent || ''),
        $('githubTokenStatus').textContent);

    // 验证成功：说清"谁 + 额度"，且**不落盘**
    env.calls.length = 0;
    $('s-githubToken').value = 'ghp_live';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    click(vbtn);
    await flush();
    const v1 = env.lastCmd('verify_github_token');
    ok('点验证：把输入框里的令牌发给后端',
        v1 && v1.args.token === 'ghp_live', JSON.stringify(v1 && v1.args));
    ok('  验证**不落盘**（一次 set_setting 都没发）',
        env.cmd('set_setting').length === 0,
        env.calls.map((c) => c.cmd).join(','));
    const st1 = $('githubTokenStatus').textContent || '';
    ok('  状态行说清"谁 + 额度"',
        /令牌有效/.test(st1) && /QQQOrange/.test(st1) && /5000/.test(st1), st1);
    ok('  提醒还没保存', /还没保存/.test(st1), st1);
    ok('  用 ok 样式（绿）',
        /(^|\s)ok(\s|$)/.test($('githubTokenStatus').className),
        $('githubTokenStatus').className);

    // 保存：写入配置 + 明确回执
    env.calls.length = 0;
    click(sbtn);
    await flush();
    const sv = env.cmd('set_setting').find((c) => c.args.key === 'githubToken');
    ok('点保存：把当前输入写进配置',
        sv && sv.args.value === 'ghp_live', JSON.stringify(sv && sv.args));
    ok('  给的是"已保存"回执',
        /已保存/.test($('githubTokenStatus').textContent || ''),
        $('githubTokenStatus').textContent);
    ok('  存好后按钮变灰（没有待保存的改动）', sbtn.disabled === true);

    // 验证失败：后端给的原因要原样露出来
    env.setVerify(undefined, '令牌无效或已过期（GitHub 回的是 Bad credentials）—— 到网页上重新生成一个再粘过来');
    $('s-githubToken').value = 'ghp_bad';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    click(vbtn);
    await flush();
    const st2 = $('githubTokenStatus').textContent || '';
    ok('验证失败：把后端给的原因说出来', /令牌无效/.test(st2), st2);
    ok('  用 err 样式（红）',
        /(^|\s)err(\s|$)/.test($('githubTokenStatus').className),
        $('githubTokenStatus').className);
    env.setVerify(undefined, '');
    ok('  输入一改就把上一次的验证结论清掉（旧结论不能给新值背书）',
        (() => {
            $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
            return !$('githubTokenStatus').textContent;
        })(), $('githubTokenStatus').textContent);

    // 输入框里按 Enter = 保存
    env.calls.length = 0;
    $('s-githubToken').value = 'ghp_enter';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    $('s-githubToken').dispatchEvent(new w.KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    ok('在输入框里按 Enter 也会保存',
        env.cmd('set_setting').some((c) => c.args.key === 'githubToken' && c.args.value === 'ghp_enter'),
        env.calls.map((c) => c.cmd + ':' + ((c.args && c.args.key) || '')).join(','));

    // ---- 没令牌：只提示 + 用浏览器下载（用户 2026-10-24 的口径）----
    /* `canAuto` = 后端按**当前配置**现算的"能不能自动下载"。
     * ⚠ `authed`（那次检查用没用上令牌）故意一起给，用来证明界面**不看它**。 */
    const payload = (canAuto, authed = canAuto) => ({
        payload: {
            version: '9.9.9', newer: true, current: '1.0.0', notes: '说明',
            size: 1024 * 1024, page: 'https://github.com/x/releases/tag/v9.9.9',
            url: 'https://github.com/x/releases/download/v9.9.9/QuickSearch.exe',
            canAuto, authed, manual: true,
        },
    });
    env.listeners.get('qs://update')(payload(false));
    await flush();
    ok('没令牌：主按钮变成「用浏览器下载」',
        $('btnUpdateInstall').textContent === '用浏览器下载',
        $('btnUpdateInstall').textContent);
    ok('  提示里写明"没填 GitHub 令牌"',
        /没填 GitHub 令牌/.test($('updHint').textContent || ''));
    ok('  完整下载网址显示出来了',
        $('updDownloadLink').textContent === 'https://github.com/x/releases/download/v9.9.9/QuickSearch.exe'
        && !$('updLinkRow').hidden,
        $('updDownloadLink').textContent);

    // 点主按钮 → 打开下载链接，且**不**调用 update_install（不自动下载）
    env.calls.length = 0;
    click($('btnUpdateInstall'));
    await flush();
    ok('  点它打开的是下载链接',
        !!(env.lastCmd('open_links') || {}).args,
        env.calls.map((c) => c.cmd).join(','));
    ok('  绝不调用 update_install（没令牌不自动下载）',
        env.cmd('update_install').length === 0,
        env.calls.map((c) => c.cmd).join(','));
    /* 关键一条：检查**确实用上了**令牌，但现在没令牌 —— 界面必须听 `canAuto`，
     * 不能听 `authed`。这正是"启动时那次自动检查结果还躺在缓存里"的形态。 */
    env.listeners.get('qs://update')(payload(false, true));
    await flush();
    ok('  哪怕检查时用过令牌，现在没令牌也不给下载',
        $('btnUpdateInstall').textContent === '用浏览器下载',
        $('btnUpdateInstall').textContent);

    // 网址那一行本身也能点
    env.calls.length = 0;
    click($('updDownloadLink'));
    await flush();
    ok('  下载网址那一行也能点开', env.cmd('open_links').length === 1);

    // ---- 有令牌：恢复「下载并安装」----
    env.listeners.get('qs://update')(payload(true));
    await flush();
    ok('有令牌：主按钮回到「下载并安装」',
        $('btnUpdateInstall').textContent === '下载并安装',
        $('btnUpdateInstall').textContent);
    ok('  提示变成"可以下载"', /可以下载/.test($('updHint').textContent || ''));

    env.calls.length = 0;
    click($('btnUpdateInstall'));
    await flush();
    ok('  点它走程序内下载（update_install）', env.cmd('update_install').length === 1);

    /* ---- 第二种检测路径：启动时自动检查（页面当时没开，结果缓存在后端）----
     * `update_pending` 只是把那份缓存读回来，不联网、不算第三次检测；
     * 它里面的 canAuto 同样是现算的。 */
    env.setPending({
        has: true, version: '9.9.9', notes: '说明', size: 1024 * 1024,
        page: 'https://github.com/x/releases/tag/v9.9.9',
        url: 'https://github.com/x/releases/download/v9.9.9/QuickSearch.exe',
        canAuto: false,
    });
    w.updInit();
    await flush();
    ok('启动时自动检查到的（没令牌）：按钮也是「用浏览器下载」',
        $('btnUpdateInstall').textContent === '用浏览器下载',
        $('btnUpdateInstall').textContent);
    ok('  网址照样摆出来', !$('updLinkRow').hidden);
    env.calls.length = 0;
    click($('btnUpdateInstall'));
    await flush();
    ok('  点下去还是只开浏览器，不自动下载',
        env.cmd('update_install').length === 0 && env.cmd('open_links').length === 1,
        env.calls.map((c) => c.cmd).join(','));

    // 就在这儿把令牌填上 → 按钮立刻变（不用再点一次"检查更新"）
    env.calls.length = 0;
    $('s-githubToken').value = 'ghp_live';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    ok('填上令牌后按钮当场变成「下载并安装」',
        $('btnUpdateInstall').textContent === '下载并安装',
        $('btnUpdateInstall').textContent);
    ok('  这回没多调一次检查（只是重画）',
        env.cmd('update_check').length === 0,
        env.calls.map((c) => c.cmd).join(','));

    // 清掉 → 立刻退回"用浏览器下载"
    $('s-githubToken').value = '';
    $('s-githubToken').dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush();
    ok('清空令牌后按钮当场退回「用浏览器下载」',
        $('btnUpdateInstall').textContent === '用浏览器下载',
        $('btnUpdateInstall').textContent);
    env.setPending({ has: false });

    // ---- 令牌被 GitHub 拒掉：原因要冒出来 ----
    env.listeners.get('qs://update')({
        payload: {
            version: '1.0.0', newer: false, current: '1.0.0', notes: '', size: 0,
            page: '', url: '', authed: false, manual: true,
            authWarning: 'GitHub 令牌无效、已过期，或者没有这个仓库的权限',
        },
    });
    await flush();
    ok('令牌被拒时把原因说给用户',
        /令牌无效/.test($('toast').textContent || ''),
        $('toast').textContent);

    // ---- 清除按钮 ----
    env.calls.length = 0;
    click($('btnGithubTokenClear'));
    await flush();
    const clr = env.cmd('set_setting').find((c) => c.args.key === 'githubToken');
    ok('清除按钮把令牌存成空串', clr && clr.args.value === '');
    ok('  输入框同时清空', $('s-githubToken').value === '');

    // ---- 点「检查更新」前会先把输入框落盘（防止 IPC 乱序用旧令牌）----
    env.calls.length = 0;
    $('s-githubToken').value = 'ghp_new';
    click($('btnUpdateCheck'));
    await flush();
    const seqCmds = env.calls.map((c) => c.cmd + (c.args && c.args.key ? ':' + c.args.key : ''));
    ok('检查更新前先保存令牌，再发 update_check',
        seqCmds.indexOf('set_setting:githubToken') >= 0
        && seqCmds.indexOf('update_check') > seqCmds.indexOf('set_setting:githubToken'),
        seqCmds.join(' → '));
}

/* ================================================================== */

/* ================================================================== */
/*  v1.5.19 内置默认图标：翻译 / 识图                                    */
/* ================================================================== */

/* 用户连着说了三句：
 *   「把这个图标作为翻译的默认图标」「这个作为识图搜索的默认图标」
 *   「要让这些图标变成内嵌的图标」「把这两个图标代替现在的图标，
 *    变成默认的图标」
 *
 *  合起来是一条硬要求，拆成三个可测的点：
 *    ① 翻译的默认图标 = 用户给的「翻译-copy.png」，顶掉原来的「译」字徽标；
 *    ② 识图的默认图标 = 用户给的「识图键.png」，顶掉原来的内联 SVG；
 *    ③ 两张图**内嵌**（base64），运行时不去读任何外部图片文件。
 *
 *  为什么盯得这么死：外链 PNG 那条路一旦断掉（打包漏文件、路径解析错），
 *  界面会**悄悄**退回文字徽标 —— 用户看到的只是"图标怎么变成字了"，
 *  根本不会想到是图标没加载出来。内嵌之后这条路就不存在了。 */
function testBuiltinIcons() {
    console.log('');
    console.log('=== 内置默认图标（翻译 / 识图，v1.5.19）===');

    const shared = read('ui/shared.js');
    const bar = read('ui/bar.js');
    const setjs = read('ui/settings.js');
    const sethtml = read('ui/settings.html');

    const grab = (src, name) => {
        const m = src.match(new RegExp('window\\.QS_' + name + '_ICON\\s*=\\s*\'([^\']+)\''));
        return m ? m[1] : null;
    };

    const tUri = grab(shared, 'TRANS');
    const iUri = grab(shared, 'IMG');

    ok('翻译默认图标已内嵌（data URI，不是外部路径）',
        !!tUri && /^data:image\/png;base64,/.test(tUri), (tUri || '(没找到)').slice(0, 44));
    ok('识图默认图标已内嵌（data URI，不是外部路径）',
        !!iUri && /^data:image\/png;base64,/.test(iUri), (iUri || '(没找到)').slice(0, 44));
    ok('两张不是同一张图', !!tUri && !!iUri && tUri !== iUri);

    /* base64 必须能还原成合法 PNG —— 编码过程最容易出的错就是截断/串位，
     * 而这种错在界面上表现成"图裂了"，极难定位。 */
    const pngOf = (uri) => {
        if (!uri || !/^data:image\/png;base64,/.test(uri)) return null;
        const b = Buffer.from(uri.split(',')[1], 'base64');
        if (b.length < 24 || b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
        return b;
    };
    const tPng = pngOf(tUri);
    const iPng = pngOf(iUri);
    ok('翻译图标能还原成合法 PNG', !!tPng, tPng ? tPng.length + ' 字节' : '解码失败');
    ok('识图图标能还原成合法 PNG', !!iPng, iPng ? iPng.length + ' 字节' : '解码失败');

    /* 再和素材原图逐字节比对 —— 内嵌的必须是用户给的那两张，一模一样。 */
    const srcT = fs.existsSync(path.join(ROOT, 'ui/data/icons/trans.png'))
        ? fs.readFileSync(path.join(ROOT, 'ui/data/icons/trans.png')) : null;
    const srcI = fs.existsSync(path.join(ROOT, 'ui/data/icons/imgsearch.png'))
        ? fs.readFileSync(path.join(ROOT, 'ui/data/icons/imgsearch.png')) : null;
    ok('翻译图标与素材原图逐字节一致',
        !!tPng && !!srcT && tPng.equals(srcT),
        tPng && srcT ? ('内嵌 ' + tPng.length + 'B / 素材 ' + srcT.length + 'B') : '素材缺失');
    ok('识图图标与素材原图逐字节一致',
        !!iPng && !!srcI && iPng.equals(srcI),
        iPng && srcI ? ('内嵌 ' + iPng.length + 'B / 素材 ' + srcI.length + 'B') : '素材缺失');

    /* 四个渲染入口都得走新图，不能一处换了另一处还是老样子。 */
    ok('shared.js 里有共用的 qsImgIconNode（识图）',
        /window\.qsImgIconNode\s*=\s*function/.test(shared));
    ok('shared.js 里有共用的 qsTransIconNode（翻译）',
        /window\.qsTransIconNode\s*=\s*function/.test(shared));
    ok('横条识图图标节点走共用实现',
        /if \(window\.qsImgIconNode\) return window\.qsImgIconNode\(\);/.test(bar));
    ok('横条固定位那颗也换成内置图（不再是内联 SVG 骨架）',
        /btnImg\.dataset\.builtin/.test(bar));
    ok('设置页识图图标走共用实现',
        /if \(window\.qsImgIconNode\) return window\.qsImgIconNode\(\);/.test(setjs));

    /* 设置页左侧两个 tab 的图标也换成内嵌 PNG。 */
    const tabRe = /data-tab="([a-z]+)"><span class="tb-i[^"]*"[^>]*><img alt="" src="(data:image\/png;base64,[A-Za-z0-9+/=]+)"[^>]*><\/span>/g;
    const tabs = {};
    let m;
    while ((m = tabRe.exec(sethtml))) tabs[m[1]] = m[2];
    ok('设置页「翻译」tab 用的是内嵌图', tabs.trans === tUri, (tabs.trans || '(没找到)').slice(0, 44));
    ok('设置页「识图搜索」tab 用的是内嵌图', tabs.imgsearch === iUri, (tabs.imgsearch || '(没找到)').slice(0, 44));
    ok('两个 tab 不再用 emoji 占位',
        !/tb-i[^"]*">🌐/.test(sethtml) && !/tb-i[^"]*">\u{1F5BC}/u.test(sethtml));

    /* 真跑一遍 DOM：共用函数必须吐出 <img>，src 就是那张内嵌图，
     * 而不是又变回「译」字徽标 / 内联 SVG。 */
    try {
        const env = makeEnv('ui/settings.html', baseConf({}));
        runScripts(env, ['ui/shared.js']);
        const w = env.w;
        const tNode = w.qsTransIconNode();
        const iNode = w.qsImgIconNode();
        ok('翻译按钮节点是 <img> 且 src 是内嵌图',
            tNode && tNode.tagName === 'IMG' && tNode.getAttribute('src') === tUri,
            tNode ? tNode.tagName + ' / ' + String(tNode.getAttribute('src')).slice(0, 44) : 'null');
        ok('识图按钮节点是 <img> 且 src 是内嵌图',
            iNode && iNode.tagName === 'IMG' && iNode.getAttribute('src') === iUri,
            iNode ? iNode.tagName + ' / ' + String(iNode.getAttribute('src')).slice(0, 44) : 'null');
        ok('识图按钮不再是内联 SVG（用户指定的新图真的顶上去了）',
            iNode && iNode.tagName !== 'svg' && !iNode.querySelector('svg'));
        ok('翻译按钮不再是「译」字徽标',
            tNode && tNode.tagName === 'IMG' && !tNode.textContent.includes('译'));
    } catch (e) {
        ok('共用图标函数能正常跑起来', false, e && (e.stack || String(e)));
    }
}

(async function main() {
    try {
        await testSettings();
        await testUpdateToken();
        await testOcrSettingsPage();
        await testTrans();
        await testOcrDepCheck();
        await testIconEditorEntries();
        await testIconEditorPage();
        await testSettingsPreviewDark();
        await testBar();
        await testOcrResult();
        await testRegression();
        await testRegion();
        await testBackupPage();
        await testBackupSecurity();
        await testExportEncryptAndImportPass();
        await testDownloadFailureRoute();
        await testFavTools();
        await testPanelNoFlicker();
        await testCatJump();
        await testBuiltinIcons();
    } catch (e) {
        ok('测试过程中不应抛异常', false, e && (e.stack || String(e)));
    }
    console.log('');
    for (const l of lines) console.log(l);
    console.log('');
    console.log(`${pass} / ${pass + fail} 通过  ->  ${fail === 0 ? '全部通过' : '存在失败'}`);
    fs.writeFileSync(path.join(__dirname, 'test-ui.result.txt'),
        lines.join('\n') + `\n\n${pass}/${pass + fail} passed\n`, 'utf8');
    process.exit(fail === 0 ? 0 : 1);
})();
