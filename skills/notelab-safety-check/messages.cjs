/* ============================================================
   messages.cjs —— 三类错误提示的自检（Day 23）
   ============================================================
   检查的不是"有没有提示"，是"提示有没有用"。
   一句"未知错误"也是提示，但它把排查成本整个推给了用户 ——
   用户看到它，不知道是自己操作错了、网断了、还是程序坏了，
   也不知道下一步该干什么。那不叫提示，叫**承认失败**。

   所以每条文案要过三条关（下面逐条断言）：
     M-1 是中文
     M-2 说清"发生了什么"，不许只写"出错了 / 未知错误 / 失败"
     M-3 带一句"下一步看哪 / 做什么"

   另外还查两件事：
     · 存储错误分得对不对（写满 ≠ 被禁用，治法完全不同）
     · 代码里还有没有**裸报错**流到界面上（原始 err.message 直接显示）

   用法：node skills/notelab-safety-check/messages.cjs
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const E = require(path.join(ROOT, 'errors.js'));

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

const hasChinese = (s) => typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s);

/* ★ 只说"出错了"这类词，等于没说 */
const NAKED = /^(出错了|未知错误|错误|失败|Error|error|出错了！|操作失败[。.]?)$/;

/* "有下一步"：提示里必须出现一个**动作**或者一个**去看哪儿**的指引 */
const ACTION = /(F12|重试|再试|删掉|清空|换|复制|对照|检查|看一眼|看那条|去「|还是不行)/;


/* ============================================================
   一、三类错误，逐条过三关
   ============================================================ */
console.log('\n一｜三类错误的文案，逐条过三关（中文 / 说清发生了什么 / 有下一步）');

const CLASSES = [
  { key: 'A 存储类', group: E.ERROR_MESSAGES.storage, where: '存不下 / 读不出本地数据' },
  { key: 'B 网络类', group: E.ERROR_MESSAGES.network, where: '取不到接口的数据' },
  { key: 'C 服务端类', group: E.ERROR_MESSAGES.server, where: '接口明确回了失败' }
];

const FLAT = [];
for (const c of CLASSES) {
  console.log('\n  【' + c.key + '】什么时候出现：' + c.where);
  for (const [name, value] of Object.entries(c.group)) {
    const text = typeof value === 'function' ? value(500) : value;
    FLAT.push({ cls: c.key, name, text });

    const ok = hasChinese(text) && !NAKED.test(text.trim()) && ACTION.test(text);
    check('  ' + c.key + '.' + name + ' 三条关都过', ok, text);
    console.log('      → ' + text);
  }
}

/* ============================================================
   二、存储类要能分清楚"写满"和"不让存"
   ============================================================
   这是今天改动里最实质的一处：
   改之前两种错都显示"浏览器不允许本地存储"。
   用户遇到"空间写满"时收到这句话，只会以为浏览器坏了，
   而真正的解法（删几条旧笔记）他根本想不到 —— 于是数据一直丢。
   ============================================================ */
console.log('\n二｜存储错误分得对不对（写满 ≠ 被禁用）');

const cases = [
  { err: { name: 'QuotaExceededError', message: 'The quota has been exceeded.' }, want: 'quota',
    note: '空间写满（Chrome 的写法）' },
  { err: { name: 'NS_ERROR_DOM_QUOTA_REACHED' }, want: 'quota',
    note: '空间写满（Firefox 的写法，名字不一样）' },
  { err: { name: 'SecurityError', message: 'The operation is insecure.' }, want: 'unavailable',
    note: '隐私模式 / 被禁用' },
  { err: new SyntaxError('Unexpected token } in JSON'), want: 'corrupt',
    note: '存进去的数据读不出来' }
];

for (const c of cases) {
  const got = E.describeStorageError(c.err);
  check('  ' + c.note + ' → 判为 ' + c.want, got === c.want, '实际判成 ' + got);
}

check('  ★ 写满与被禁用给出**不同**的两句话（改前是同一句）',
  E.storageMessage(cases[0].err) !== E.storageMessage(cases[2].err));
console.log('      写满：' + E.storageMessage(cases[0].err));
console.log('      不让存：' + E.storageMessage(cases[2].err));


/* ============================================================
   三、服务端类：有原因用原因，没原因按状态码说人话
   ============================================================ */
console.log('\n三｜服务端类（接口给的中文原因优先，不给才兜底）');

check('S-1 接口给了中文原因 → 原样用它（它比我们的兜底准）',
  E.serverMessage(400, 'content 最多 5000 字，当前 5200 字') === 'content 最多 5000 字，当前 5200 字',
  E.serverMessage(400, 'content 最多 5000 字，当前 5200 字'));

check('S-2 原因只有空白 → 不当成"有原因"，走兜底',
  E.serverMessage(400, '   ').indexOf('HTTP 400') !== -1, E.serverMessage(400, '   '));

check('S-3 5xx 的兜底指向"重试"（这是服务端的问题，用户只能重试）',
  E.serverMessage(500, '').indexOf('重试') !== -1, E.serverMessage(500, ''));

check('S-4 4xx 的兜底指向"检查请求"（这是请求本身的问题）',
  E.serverMessage(400, '').indexOf('检查') !== -1, E.serverMessage(400, ''));

check('S-5 连状态码都没有 → 最后兜底，且不是"未知错误"',
  hasChinese(E.serverMessage(null, '')) && !NAKED.test(E.serverMessage(null, '')),
  E.serverMessage(null, ''));

check('S-6 兜底里点名了 F12（把排查入口告诉用户）',
  E.serverMessage(null, '').indexOf('F12') !== -1);


/* ============================================================
   四、全仓库再扫一遍：还有没有"裸报错"能流到界面上
   ============================================================
   上面验的是"该有的地方写好了"；这一段反过来查"不该有的地方还有没有"。
   只查会显示给用户的那两个文件（app.js / api.js）。
   ============================================================ */
console.log('\n四｜反向扫描：界面上还有没有裸报错');

const UI_FILES = ['app.js', 'api.js'];
const RAW_LEAK = [
  { re: /\berr\.message\b|\berror\.message\b/g, why: '把原始 err.message 拼进显示给用户的文案' },
  { re: /['"](出错了|未知错误|操作失败|Error)['"]/g, why: '一句没有信息量的裸报错' },
  { re: /QuotaExceededError|SyntaxError|TypeError/g, why: '把代码里的错误类型名直接给用户看' },
  { re: /String\(err\)|String\(error\)|String\(e\)/g, why: '把整个错误对象转成字符串显示' }
];

/* ★ 扫源码前要做的两件准备工作 —— 少了它们，这条断言全是假红
   （第一版跑出来 4 处"命中"，一看全是注释里的字样和 console 输出）：

   ① 剥掉注释，但**保留行号**（把注释换成等长空格，不改行数）。
      注释里写"不要写成『出错了』这种裸报错"是教材，不是违规 ——
      这和 Day 22 修 F-07 是同一个坑：扫源码不剥注释，等于在扫自己的注释。

   ② 抹掉 `console.*` 那些行。原始错误记录到 console 是**对的**
      （排查时需要它），它只是不能显示到界面上。 */
function preprocess(src) {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))          // 块注释 → 空格
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length)); // 行注释 → 空格
  return noComments
    .split('\n')
    .map((line) => (/^\s*console\./.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

/** 抽成函数，好让自检也能喂合成代码进来（否则没法证明这条断言不是空转） */
function findLeaks(source) {
  const src = preprocess(source);
  const found = [];
  for (const r of RAW_LEAK) {
    r.re.lastIndex = 0;
    const m = r.re.exec(src);
    if (m) {
      found.push({
        why: r.why,
        line: src.slice(0, m.index).split('\n').length,
        raw: m[0]
      });
    }
  }
  return found;
}

let leaks = 0;
for (const f of UI_FILES) {
  const found = findLeaks(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const h of found) {
    leaks++;
    console.log('  ✗ ' + f + ':' + h.line + ' 还有 ' + h.why + '（原文：' + h.raw + '）');
  }
}
check('L-1 ★ 界面代码里没有裸报错（原始 err.message / 「未知错误」/ 错误类型名）',
  leaks === 0, leaks + ' 处');

/* 正向：确认 errors.js 真的被用上了（不然上面全是自娱自乐） */
const uses = UI_FILES.filter((f) =>
  /window\.NoteLabErrors|NoteLabErrors/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
check('L-2 ★ app.js 与 api.js 都真的用了 errors.js（否则这张文案表是死的）',
  uses.length === UI_FILES.length, '只有 ' + uses.join(',') + ' 用了');

/* ★ L-4：前端几个脚本之间不许有**同名的顶层 const / let**
   为什么要有这条：
     经典脚本（不带 type="module"）的顶层 const / let 会进**同一个全局词法作用域**，
     两个文件都写 `const ERRORS = …` 的结果是 SyntaxError：
     "Identifier 'ERRORS' has already been declared" —— 后加载的那个脚本**整个不执行**。
     Day 23 第一版就是这么写的，表现是"DOM 桩测试 41/41 全绿、真实浏览器整个白屏"，
     因为 vm 沙箱里每个脚本作用域是分开的，撞不出这个错。
     这类问题靠"看代码"极难发现（两个文件各自看都完全正常），只能靠扫。 */
const FRONTEND = ['errors.js', 'mock-data.js', 'api.js', 'app.js'];

/** 抽成函数，好让自检能喂合成代码（证明这条断言不是空转） */
function topLevelNames(source) {
  const src = preprocess(source);
  const found = [];
  for (const line of src.split('\n')) {
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

const decls = new Map();
for (const f of FRONTEND) {
  for (const name of topLevelNames(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push(f);
  }
}
const dupNames = [];
for (const [name, owners] of decls) {
  if (new Set(owners).size > 1) dupNames.push(name + '（' + owners.join(' / ') + '）');
}
check('L-4 ★ 前端脚本之间没有同名的顶层 const / let（重名会让浏览器整段不执行）',
  dupNames.length === 0, dupNames.join('；'));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const iErr = html.indexOf('errors.js');
const iApi = html.indexOf('api.js');
const iApp = html.indexOf('app.js');
check('L-3 ★ index.html 里 errors.js 排在 api.js / app.js **之前**（顺序错了页面会炸）',
  iErr !== -1 && iErr < iApi && iErr < iApp,
  'errors=' + iErr + ' api=' + iApi + ' app=' + iApp);


/* ============================================================
   --selftest：给 L-1 自己上保险
   ============================================================
   L-1 是"不该有什么"的断言。这类断言的老毛病是**空转**：
   正则写窄一点，界面上就算全是裸报错它也照样绿。
   所以喂几段合成代码进来，确认"该抓的抓得到、不该抓的不抓"。
   ============================================================ */
if (process.argv.includes('--selftest')) {
  console.log('\n五｜自检：证明 L-1 不是空转（喂合成代码进去看它抓不抓）');

  const shouldCatch = [
    { code: 'showHint(err.message);', why: '原始 err.message 直接显示' },
    { code: 'el.hint.textContent = "出错了";', why: '写死一句「出错了」' },
    { code: 'msg.textContent = String(err);', why: '把整个错误对象转成字符串显示' }
  ];
  for (const c of shouldCatch) {
    check('  ✓ 能抓到：' + c.why, findLeaks(c.code).length > 0,
      '没抓到 → ' + c.code);
  }

  const shouldNotCatch = [
    { code: '// 这里**不要**写成 "出错了" 这种裸报错', why: '注释里的字样（教材，不是违规）' },
    { code: "console.warn('保存失败：', err);", why: 'console 里的原始错误（排查需要它）' },
    { code: '/* err.message 只在日志里出现 */', why: '块注释里的字样' }
  ];
  for (const c of shouldNotCatch) {
    check('  ✓ 不误报：' + c.why, findLeaks(c.code).length === 0,
      '误报了 → ' + JSON.stringify(findLeaks(c.code)));
  }

  console.log('\n  （L-4 的自检：重名扫描）');
  check('  ✓ 能认出顶层声明 const ERRORS = …',
    topLevelNames('const ERRORS = window.NoteLabErrors;').includes('ERRORS'),
    JSON.stringify(topLevelNames('const ERRORS = window.NoteLabErrors;')));
  check('  ✓ 不把**缩进**里的 const 当顶层（函数里的声明不算）',
    !topLevelNames('  const inner = 1;').includes('inner'));
  check('  ✓ 不把注释里的 const 当声明',
    !topLevelNames('// const FAKE = 1;').includes('FAKE'));

  const dupOf = (sources) => {
    const m = new Map();
    for (const s of sources) {
      for (const n of topLevelNames(s.code)) {
        if (!m.has(n)) m.set(n, []);
        m.get(n).push(s.file);
      }
    }
    return [...m].filter(([, owners]) => new Set(owners).size > 1).map(([n]) => n);
  };
  check('  ✓ 能抓到跨文件重名（api.js 和 app.js 都写了 const ERRORS）',
    dupOf([{ file: 'api.js', code: 'const ERRORS = 1;' },
           { file: 'app.js', code: 'const ERRORS = 2;' }]).length === 1);
  check('  ✓ 同名但只在同一个文件里出现 → 不报（同一个文件里重名是另一回事）',
    dupOf([{ file: 'app.js', code: 'const A = 1;\nconst B = 2;' }]).length === 0);
}

console.log('\n' + '='.repeat(64));
console.log('错误提示自检：' + pass + '/' + (pass + failures.length) + ' 通过');
console.log('三类共 ' + FLAT.length + ' 条文案，全部为中文且带下一步指引');
console.log('='.repeat(64));

if (failures.length) {
  console.log('\n未通过项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
}
