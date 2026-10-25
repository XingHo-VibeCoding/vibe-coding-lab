/* ============================================================
   notelab-release-check —— 发布前检查（总闸）
   ============================================================
   用法：
     node skills/notelab-release-check/check.cjs              跑发布专项 + 密钥红线
     node skills/notelab-release-check/check.cjs --full       再把其余自检全部跑一遍
     node skills/notelab-release-check/check.cjs --url=https://xxx.service.tcloudbase.com
                                                              连真公网地址一起验（会自动 GET /api/notes）

   ---------- 为什么还要一个新 Skill，现有的不够吗 ----------
   现有的五个各管一段，但有几类问题**谁都没管**，而它们恰恰是上线才暴露的：
     · index.html 引用了一个不存在的文件 → 线上 404，本地可能照样能跑
     · Access-Control-Allow-Origin 写成了单一域名 → 别的来源全被挡在门外
     · 接口地址里留着 xxxxx 这种占位符
     · 源码里写死了 localhost
   这些问题在开发机上都不疼，一发布就要命 —— 所以单独收一个"发布前"的检查。

   ---------- 设计上的三条硬规矩 ----------
   ① 查不到就不算通过（表示 ⊘ 跳过并写明原因），绝不用绿色掩盖"没验到"。
     典型：不给 --url 时，公网那几项必须标 ⊘，不能假装通过。
   ② 能用子进程复用就复用：密钥那段直接调 notelab-safety-check/scan.cjs，
     不另写一套规则 —— 两套规则早晚会长得不一样。
   ③ 每项都要能回答"它红了去改哪儿"（写进 SKILL.md 的对照表）。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const urlArg = (args.find((a) => a.startsWith('--url=')) || '').slice(6);
const full = args.includes('--full');

/* ------------------------------------------------------------
   输出小工具：✓ 通过 / ✗ 不通过 / ⊘ 没验到
   ⊘ 是故意设的第三个状态 —— 把"没验到"和"验过了没问题"混为一谈，
   是发布前检查最容易犯、也最致命的错：绿灯一片，其实好几项根本没查。
   ------------------------------------------------------------ */
let pass = 0;
const blockers = [];   /* 阻断级：不许发布 */
const warns = [];      /* 非阻断级：可以发，但必须登记成欠账 */
const skipped = [];

/**
 * level：'BLOCK'（默认）｜ 'WARN'
 *
 * ★ 为什么红项还要分两级（Day 26 发现的第二个设计问题）：
 *   原来那句"有红项就不许发布"看着严，其实是**纸老虎** ——
 *   只要有一项长期红着又没人有空修，人就会养成"忽略这条红字"的习惯，
 *   等真出阻断级问题时，那行红字也没人看了。闸一旦被绕过，比没有闸更糟。
 *
 *   所以按"它红的时候，线上会怎样"分级：
 *     阻断级 —— 线上不可用、数据会丢、密钥外泄、回滚基线说不清
 *     非阻断级 —— 能用，只是体验差或文案缺一步指引 → 记欠账，下个版本修
 */
function check(name, cond, detail, level) {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  const suffix = detail ? '  → ' + detail : '';
  if (level === 'WARN') {
    warns.push(name + suffix);
    console.log('  ✗ ' + name + suffix + '（非阻断）');
  } else {
    blockers.push(name + suffix);
    console.log('  ✗ ' + name + suffix);
  }
}
function skip(name, why) {
  skipped.push(name);
  console.log('  ⊘ ' + name + '（没验到：' + why + '）');
}
function section(t) { console.log('\n' + t); }
function info(t) { console.log('    · ' + t); }

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const exists = (p) => fs.existsSync(p);

/* 源码里剥掉注释再扫 —— 不剥的话，注释里写的"例如 http://localhost:8123"
   会被当成硬编码地址，报一堆假红（Day 23 在 messages.cjs 上栽过一次） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function listFiles(dir, out) {
  out = out || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  entries.forEach((en) => {
    const p = path.join(dir, en.name);
    if (en.isDirectory()) {
      if (['.git', 'node_modules', '.workbuddy', 'day14-shots'].includes(en.name)) return;
      listFiles(p, out);
    } else if (/\.(js|cjs|html|css|md|json|sql)$/.test(en.name)) {
      out.push(p);
    }
  });
  return out;
}

/* git 只读查询：这里只跑 log / status / archive，不写任何东西 */
function gitOut(a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
}

/* ============================================================
   零｜可回退历史 —— 发布的前置条件
   ------------------------------------------------------------
   ★ 为什么这一节排在发布**之前**：
     "回滚演练"的全部价值在于出事时退得回去；而"退得回去"这件事，
     只有在发布前才是可验证的 —— 发布之后你只能赌它成立。
     所以顺序必须是：先确认历史可回退 → 再发布 → 再演练回退 → 再恢复。
   ------------------------------------------------------------ */
/* 真正会被传到静态托管上去的文件。
   ★ 它同时也是"回滚基线"的判据 —— 见 Z-4：
     只有**改动了这份清单**的提交，退回去线上才有变化。 */
const REQUIRED = ['index.html', 'app.js', 'api.js', 'errors.js', 'mock-data.js', 'styles.css'];

section('零｜可回退历史（发布的前置条件）');

const dirty = gitOut(['status', '--porcelain']).trim();
check('Z-1 工作区干净（有未提交改动时不能发布，否则回滚基线说不清）',
  dirty === '', dirty.split('\n')[0] || '');

const headSha = gitOut(['rev-parse', 'HEAD']).trim();
const remoteSha = gitOut(['rev-parse', 'origin/main']).trim();
check('Z-2 本地 HEAD 与远端 main 一致（不然回滚基线跟线上不是一回事）',
  headSha !== '' && headSha === remoteSha,
  remoteSha
    ? '本地 ' + headSha.slice(0, 7) + ' / 远端 ' + remoteSha.slice(0, 7) + '（git fetch 后重跑）'
    : '远端引用 origin/main 不存在 —— 先 git fetch origin main；' +
      'fetch 完仍缺的话手动补：mkdir -p .git/refs/remotes/origin && ' +
      'printf "%s\\n" $(cat .git/FETCH_HEAD | awk \'{print $1}\') > .git/refs/remotes/origin/main');

const history = gitOut(['log', '--oneline', '-n', '6']).trim().split('\n').filter(Boolean);
check('Z-3 至少有一个可回退的上一版提交', history.length >= 2, '历史只有 ' + history.length + ' 条');
if (history.length) info('最近几条：' + history.slice(0, 3).join('  |  '));

/**
 * 回滚基线 = 最近一个**改动了发布物**的提交，而不是 HEAD~1。
 * ★ HEAD~1 常常是纯文档/纯工具提交（改 README、加自检脚本），
 *   它的发布物跟当前一字不差 —— 退到它，线上**毫无变化**，
 *   你会以为自己回滚成功了，其实什么都没发生。这种"假回滚"比不回滚更危险。
 */
function findRollbackTarget() {
  const log = gitOut(['log', '--format=%H', '-n', '30']).trim().split('\n').filter(Boolean);
  for (const sha of log) {
    if (sha === headSha) continue;
    const d = spawnSync('git', ['diff', '--quiet', headSha, sha, '--'].concat(REQUIRED),
      { cwd: ROOT });
    if (d.status !== 0) return sha;   /* 发布物有差异 → 这才退得回去 */
  }
  return '';
}

const headPrev = gitOut(['rev-parse', 'HEAD~1']).trim();
const prevIsNoop = !!headPrev &&
  spawnSync('git', ['diff', '--quiet', headSha, headPrev, '--'].concat(REQUIRED),
    { cwd: ROOT }).status === 0;
const rollbackTarget = findRollbackTarget();

check('Z-4 ★ 存在"上一个改动了发布物的提交"作为回滚基线（不是简单的 HEAD~1）',
  rollbackTarget !== '' && rollbackTarget !== headSha,
  rollbackTarget ? rollbackTarget.slice(0, 7) : '30 条历史里没找到第二版发布物');
if (rollbackTarget) {
  const stat = gitOut(['diff', '--stat', rollbackTarget, headSha, '--'].concat(REQUIRED)).trim();
  info('回滚基线：' + rollbackTarget.slice(0, 7) +
    (stat ? '　与当前差异：' + stat.split('\n').slice(-1)[0].trim() : ''));
}
/* ★ 提示而非阻断：HEAD~1 是空回滚不代表不能发布，
   只是提醒"真要回滚时记得往前再退一个"。 */
check('Z-5 HEAD~1 不是"空回滚"（纯文档提交，发布物与当前相同）',
  !prevIsNoop,
  'HEAD~1 的发布物与当前一致 —— 真回滚时要退到 ' +
    (rollbackTarget ? rollbackTarget.slice(0, 7) : '(找不到)') + '，工具已自动往前取',
  'WARN');

/* ============================================================
   A 上线文件与引用：开发机上不疼，一发布就要命
   ============================================================ */
section('一｜上线文件与引用');

const missing = REQUIRED.filter((f) => !exists(path.join(ROOT, f)));
check('A-1 上线必备文件都在（' + REQUIRED.length + ' 个）',
  missing.length === 0, '缺 ' + missing.join(', '));

const html = read(path.join(ROOT, 'index.html')) || '';

// A-2 ★ 这条最有价值：引用了不存在的文件 → 线上 404，而本地可能因为缓存照样能跑
const refs = [];
html.replace(/(?:src|href)\s*=\s*"([^"]+)"/g, (m, v) => { refs.push(v); return m; });
/* ★ 网址参数（?demo=1&state=...#/notes）必须跳过：它是"同一个页面的另一种状态"，
   不是文件。第一版没跳过，5 条假红直接把这条最重要的检查淹没了 ——
   假红一多，真红就没人看了（跟 Day 23 扫描器那次是同一个道理）。
   另外 &amp; 是 HTML 实体，得先还原成 &。 */
const localRefs = [];
refs.forEach((r) => {
  const raw = String(r).replace(/&amp;/g, '&');
  if (!raw || /^(https?:)?\/\//.test(raw) || raw.startsWith('data:')) return;
  const clean = raw.split(/[?#]/)[0];
  if (clean) localRefs.push(clean);
});
const brokenRefs = localRefs.filter((r) => !exists(path.join(ROOT, r)));
check('A-2 ★ index.html 引用的每个本地文件都真实存在（否则线上 404 / 白屏）',
  brokenRefs.length === 0, '引用了不存在的：' + brokenRefs.join(', '));
if (localRefs.length) info('检查了 ' + localRefs.length + ' 个引用：' + localRefs.join(', '));

// A-3 代码里取的 id 必须在 html 里真有，否则 getElementById 拿到 null，后面直接崩
const htmlIds = new Set();
html.replace(/id="([^"]+)"/g, (m, v) => { htmlIds.add(v); return m; });
const wantedIds = new Set();
['app.js', 'api.js'].forEach((f) => {
  const src = stripComments(read(path.join(ROOT, f)) || '');
  src.replace(/getElementById\(\s*'([^']+)'\s*\)/g, (m, v) => { wantedIds.add(v); return m; });
});
const ghostIds = [...wantedIds].filter((id) => !htmlIds.has(id));
check('A-3 代码里取的元素 id 在 index.html 里都存在（拿到 null 会当场崩）',
  ghostIds.length === 0, 'html 里没有：' + ghostIds.join(', '));
info('代码取了 ' + wantedIds.size + ' 个 id，html 里有 ' + htmlIds.size + ' 个');

// A-4 只扫"要上线"的文件：skills/ 是本机工具，里面写 127.0.0.1 很正常，不算问题
const SHIPPABLE = [
  'app.js', 'api.js', 'errors.js', 'mock-data.js',
  'cloudbase-functions/notes/index.js', 'cloudbase-functions/notes/read.js',
  'cloudbase-functions/notes/write.js', 'cloudbase-functions/notes/http.js',
  'cloudbase-functions/notes/db.js', 'cloudbase-functions/notes/repository.js',
  'cloudbase-functions/health/index.js'
];
const localHits = [];
SHIPPABLE.forEach((rel) => {
  const src = stripComments(read(path.join(ROOT, rel)) || '');
  src.split('\n').forEach((line, i) => {
    if (/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(line)) {
      localHits.push(rel + ':' + (i + 1) + ' → ' + line.trim().slice(0, 70));
    }
  });
});
check('A-4 要上线的文件里没有写死 localhost / 127.0.0.1',
  localHits.length === 0, localHits.join(' | '));
if (!localHits.length) info('扫了 ' + SHIPPABLE.length + ' 个上线文件（先剥注释，避免把文档里的示例当问题）');

/* ============================================================
   B 密钥红线：不另写规则，直接用子进程调 scan.cjs
   ============================================================ */
section('二｜密钥红线（直接调用 notelab-safety-check/scan.cjs，不另起一套规则）');

const scan = spawnSync(process.execPath, [path.join(ROOT, 'skills', 'notelab-safety-check', 'scan.cjs')],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const scanOut = (scan.stdout || '') + (scan.stderr || '');
const hitMatch = /密钥排查结果：\s*(\d+)\s*条命中/.exec(scanOut);
const scanRed = /✗\s*S-\d+/.test(scanOut);

if (!hitMatch) {
  skip('B-1 全仓库密钥 0 条命中', 'scan.cjs 没能给出结果（它自己可能坏了）');
  skip('B-2 .env 不进仓库且被忽略', '同上');
} else {
  const hits = Number(hitMatch[1]);
  check('B-1 ★ 全仓库密钥 0 条命中（推上公开仓库就不可撤回）', hits === 0, hits + ' 条命中');
  check('B-2 ★ .env 相关的 9 条断言全绿（含"git 历史里从未出现过 .env"）',
    !scanRed, scanOut.split('\n').filter((l) => /✗\s*S-\d+/.test(l)).map((l) => l.trim()).join(' | '));
  info('scan.cjs 报了 ' + hitMatch[1] + ' 条命中，退出码 ' + scan.status);
}

/* ============================================================
   C 公网与跨域（★ 今天的两项"故意弄坏"都落在这一段）
   ============================================================ */
section('三｜公网与跨域');

const httpSrc = read(path.join(ROOT, 'cloudbase-functions', 'notes', 'http.js')) || '';
const originMatch = /'Access-Control-Allow-Origin'\s*:\s*'([^']*)'/.exec(httpSrc);
const methodsMatch = /'Access-Control-Allow-Methods'\s*:\s*'([^']*)'/.exec(httpSrc);
const apiSrc = read(path.join(ROOT, 'api.js')) || '';
/* ★ 先剥注释再找：api.js 的注释里那句
   `const CONFIGURED_BASE = 'https://cloud1-3g1xxxxx.service.tcloudbase.com';`
   是写给读者看的示例，不是真的配置值。第一版没剥注释，直接报了个假红。 */
const baseMatch = /const CONFIGURED_BASE\s*=\s*'([^']*)'/.exec(stripComments(apiSrc));

// C-1 占位符：地址里留着 xxxxx / EXAMPLE / TODO，发布上去必然不通
const base = baseMatch ? baseMatch[1] : '';
const looksPlaceholder = base ? /xxxxx|XXXX|EXAMPLE|example\.com|TODO|your-|\.\.\./.test(base) : false;
if (!base) {
  info('api.js 里没写死地址（用网址参数 ?api= 临时给），跳过占位符检查');
  check('C-1 接口地址不是占位符', true, '未写死地址，视为通过');
} else {
  check('C-1 接口地址不是 xxxxx / EXAMPLE 之类的占位符',
    !looksPlaceholder, '地址看着像占位符：' + base);
}

// C-2 ★ 故意弄坏项之一：单一域名会把其他来源全挡在门外，而开发机上测不出来
const origin = originMatch ? originMatch[1] : null;
if (origin === null) {
  skip('C-2 CORS 允许来源', 'http.js 里没找到 Access-Control-Allow-Origin');
} else {
  const singleOrigin = origin !== '*' && /^https?:\/\//.test(origin);
  check('C-2 ★ Access-Control-Allow-Origin 是 *（写成单一域名会把别的来源全挡在门外）',
    !singleOrigin, '现在是 ' + origin + ' —— 只允许这一个来源，别的都进不来');
  if (!singleOrigin) info('当前值：' + origin);
}

// C-3 方法名不全的后果：PATCH/DELETE 会在"预检"那一步被浏览器拦掉，
//     报的错看起来像接口不通，很难想到是这里少了两个方法名
const methods = methodsMatch ? methodsMatch[1] : '';
const needMethods = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const lackMethods = needMethods.filter((m) => !new RegExp('\\b' + m + '\\b').test(methods));
check('C-3 CORS 允许的 HTTP 方法齐全（' + needMethods.join(' ') + '）',
  lackMethods.length === 0, '少了 ' + lackMethods.join(', '));

// C-4 / C-5 要真联网：不给 --url 就必须标 ⊘，绝不假装通过
if (urlArg) {
  const res = spawnSync(process.execPath, [
    '-e',
    `fetch(${JSON.stringify(urlArg.replace(/\/+$/, '') + '/api/notes')},` +
    `{headers:{Accept:'application/json'}}).then(async r=>{` +
    `const t=await r.text();console.log('STATUS '+r.status);` +
    `console.log('ORIGIN '+String(r.headers.get('access-control-allow-origin')));` +
    `console.log('BODY '+t.slice(0,300));}).catch(e=>console.log('ERR '+e.message))`
  ], { encoding: 'utf8', timeout: 30000 });
  const out = res.stdout || '';
  const status = /STATUS (\d+)/.exec(out);
  const originGot = /ORIGIN (\S+)/.exec(out);
  const body = /BODY ([\s\S]*)/.exec(out);
  if (!status) {
    skip('C-4 公网 /api/notes 返回 200', '连不上（' + (out.trim() || '无输出') + '）');
    skip('C-5 公网返回形状是 { ok:true, notes:[...] }', '同上');
  } else {
    check('C-4 公网 /api/notes 返回 200', status[1] === '200', '实际 ' + status[1]);
    const raw = (body && body[1]) || '';
    /* 详情里要去换行：静态托管常见的失败是返回整页 html，
       带着换行打出来会把汇总表冲成一坨，反而看不清结论 */
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    let shapeOk = false;
    let shapeWhy = '返回的不是 JSON —— 实际是「' + preview + '」';
    try {
      const j = JSON.parse(raw);
      shapeOk = j.ok === true && Array.isArray(j.notes);
      if (!shapeOk) shapeWhy = '缺 ok 或 notes 字段 —— 实际是「' + preview + '」';
    } catch (e) { /* JSON.parse 失败说明根本不是 JSON，shapeWhy 保持原值 */ }
    check('C-5 公网返回形状是 { ok:true, notes:[...] }', shapeOk, shapeWhy);
    check('C-6 公网响应头带了 CORS 允许来源',
      !!originGot && originGot[1] !== 'null', '响应头里的值是 ' + (originGot ? originGot[1] : '无'));
  }
} else {
  skip('C-4 公网 /api/notes 返回 200', '没给 --url，本机连不上就不假装验过');
  skip('C-5 公网返回形状是 { ok:true, notes:[...] }', '同上');
  skip('C-6 公网响应头带了 CORS 允许来源', '同上');
}

/* ============================================================
   D 契约与脱敏
   ============================================================ */
section('四｜契约与脱敏');

const entrySrc = read(path.join(ROOT, 'cloudbase-functions', 'notes', 'index.js')) || '';
const logsContent = /logRequest[\s\S]{0,400}?\{([\s\S]{0,300}?)\}/.exec(entrySrc);
const logFields = logsContent ? logsContent[1] : '';
check('D-1 请求日志只记时间/方法/路径/状态码，不记请求体',
  !!logFields && !/\b(body|content)\b/i.test(logFields),
  '日志字段里有：' + (logFields || '(没找到 logRequest)'));
if (logFields) info('日志字段：' + logFields.replace(/\s+/g, ' ').trim().slice(0, 90));

const scriptOrder = (html.match(/<script src="([^"]+)"/g) || []).map((s) => /src="([^"]+)"/.exec(s)[1]);
const iErrors = scriptOrder.indexOf('errors.js');
const iApi = scriptOrder.indexOf('api.js');
const iApp = scriptOrder.indexOf('app.js');
check('D-2 errors.js 排在 api.js / app.js 之前（顺序反了页面会炸）',
  iErrors >= 0 && iErrors < iApi && iErrors < iApp,
  '顺序是 ' + scriptOrder.join(' → '));

const bareErrors = [];
['app.js', 'api.js', 'errors.js', 'cloudbase-functions/notes/index.js'].forEach((rel) => {
  const src = stripComments(read(path.join(ROOT, rel)) || '');
  src.split('\n').forEach((line, i) => {
    if (/['"](未知错误|出错了|操作失败|服务器开小差了)['"]/.test(line)) {
      bareErrors.push(rel + ':' + (i + 1));
    }
  });
});
/* D-3 定级**非阻断**，理由是"它红的时候线上会怎样"：
   `fail(500, '服务器开小差了')` 是中文人话、也没泄露内部信息，
   缺的只是"重试一次通常就好"这一步指引 —— 出错时页面照样能开、数据不会丢。
   修它要让云函数引用 root 的 errors.js，得先解决部署打包
   （云函数目录会不会把它一起带上），那属于打包改造，不是改一行字。
   已登记 CANDIDATES.md 的 C11，下个版本处理。 */
check('D-3 源码里没有残留的裸报错文案（"未知错误"之类）',
  bareErrors.length === 0, bareErrors.join(', '), 'WARN');

/* ============================================================
   E 数据兜底（Day 24 修的那条，别让它悄悄退化）
   ============================================================ */
section('五｜数据兜底');

const appSrc = read(path.join(ROOT, 'app.js')) || '';
check('E-1 笔记数据的第二层校验还在（sanitizeNotes）',
  /function sanitizeNotes/.test(appSrc));
const callCount = (appSrc.match(/sanitizeNotes\(/g) || []).length;
check('E-2 三个入口（本地存储 / 演示 / 接口）都过了这一层',
  callCount >= 4, 'sanitizeNotes 出现 ' + callCount + ' 次（定义 1 + 调用 3 才够）');

/* ============================================================
   F 体积：超 500 行的必须在 README 欠账清单里登记过
   ============================================================ */
section('六｜单文件体积（约束 5）');

const readme = read(path.join(ROOT, 'README.md')) || '';
const debtBlock = (/已知欠账[\s\S]{0,1500}/.exec(readme) || [''])[0];
/* 只管**代码**文件：约束 5 说的"500 行就拆开"指的是代码，
   DEPLOY.md 那种长文档不在此列（文档长不等于该拆）。
   另外要按**文件名**而不是全路径去欠账清单里找 —— 清单里写的是 `check.cjs`，
   按全路径 `skills/notelab-api-check/check.cjs` 去匹配永远匹配不上，
   那样这条检查看着在跑，其实是一条永远为真的空断言。 */
const bigFiles = [];
listFiles(ROOT).forEach((p) => {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  if (!/\.(js|cjs|html|css)$/.test(rel)) return;
  if (rel.startsWith('skills/notelab-release-check/')) return;   // 不扫自己
  const src = read(p);
  if (src === null) return;
  const n = src.split('\n').length;
  if (n > 500) bigFiles.push({ rel, name: path.basename(rel), n });
});
const unregistered = bigFiles.filter((f) => debtBlock.indexOf(f.name) < 0);
check('F-1 超过 500 行的文件都已在 README 欠账清单里登记',
  unregistered.length === 0,
  '没登记：' + unregistered.map((f) => f.rel + '（' + f.n + ' 行）').join(', '));
if (bigFiles.length) info('当前超标的：' + bigFiles.map((f) => f.rel + ' ' + f.n + ' 行').join('，'));

/* ============================================================
   --full：把其余自检一并跑一遍（读退出码，不重复解析输出）
   ============================================================ */
if (full) {
  section('七｜其余自检（--full）');
  const others = [
    ['文案自检', 'skills/notelab-safety-check/messages.cjs', []],
    ['行为层（DOM 桩）', 'skills/notelab-filter-check/run.js', []],
    ['可见层（真实浏览器）', 'skills/notelab-filter-check/render-check.js', []],
    ['云函数自检', 'skills/notelab-api-check/check.cjs', []],
    ['接线自检', 'skills/notelab-api-wiring/check.cjs', []]
  ];
  others.forEach(([name, rel, a]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel), ...a],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 300000 });
    const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' ');
    check(name + ' 通过', r.status === 0, tail.slice(0, 120));
  });
}

/* ============================================================
   汇总
   ============================================================ */
const total = pass + blockers.length + warns.length;
console.log('\n' + '='.repeat(64));
console.log('发布前检查：' + pass + '/' + total + ' 项通过' +
  (skipped.length ? '，另有 ' + skipped.length + ' 项没验到（⊘）' : ''));
console.log('='.repeat(64));

if (skipped.length) {
  console.log('\n没验到的项（这些**不算**通过，别把它们当绿灯）：');
  skipped.forEach((s) => console.log('  ⊘ ' + s));
}
if (warns.length) {
  console.log('\n非阻断项（允许带病发布，但**必须**已登记成欠账）：');
  warns.forEach((f) => console.log('  ✗ ' + f));
}
if (blockers.length) {
  console.log('\n阻断项：');
  blockers.forEach((f) => console.log('  ✗ ' + f));
}

/* ★ 判定顺序很重要：阻断 > 没验到 > 只剩非阻断 > 全绿。
   把"没验到"排在"非阻断"前面，是因为**没验过 ≠ 没问题**；
   而"非阻断"是**验过了、确认只是体验问题**，两者不能混。 */
if (blockers.length) {
  console.log('\n★ 有阻断项，不许发布。改完重跑。');
  process.exitCode = 1;
} else if (skipped.length) {
  console.log('\n★ 没有阻断项，但有 ' + skipped.length + ' 项**没验到** —— 没验过的东西不许发布。');
  console.log('  补齐验证再发（公网那三项给 --url 就能从 ⊘ 变成真验过）。');
  process.exitCode = 1;
} else if (warns.length) {
  console.log('\n★ 可以发布：无阻断项、无未验项，只剩已登记的非阻断欠账。');
} else {
  console.log('\n全部通过 ✅');
}
