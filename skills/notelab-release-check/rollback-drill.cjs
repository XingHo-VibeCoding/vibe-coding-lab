/* ============================================================
   notelab-release-check —— 回滚演练（静态托管回退路径）
   ============================================================
   用法：node skills/notelab-release-check/rollback-drill.cjs

   ---------- 为什么要有这个脚本 ----------
   Day 26 的主任务是"正式发布 v1.0 + 完成一次真实回滚演练"。
   发布那一半需要真实云环境（凭据不在本机，阻塞原因记在 ROLLBACK.md）。
   **但"回退路径"本身是可以真练的** —— 它的本质是：
       把静态托管指向的版本目录，换回上一版，再确认页面仍然正常。
   这个脚本在本机起静态服务模拟托管，完整走一遍，并**逐段计时**，
   回答今天要掌握的那句："回滚花了多久？"

   ---------- 三条硬规矩 ----------
   ① 全程用 `git archive` 把指定提交导出到临时目录，**不动工作区一个字节**。
      改工作区再改回来，中途出错就留下脏状态 —— 演练不该制造新的风险。
   ② 回滚基线**不能**直接用 HEAD~1（原因见 findRollbackTarget 的注释）。
   ③ 判定"回滚生效"要比对**发布物整体指纹**，不能只比对首页
      （原因见 probeAll 的注释 —— 这一条是 Day 26 真踩出来的）。
   ============================================================ */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8123;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PYTHON = 'C:\\Users\\岚\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';

/* 真正会被传到静态托管上去的文件 */
const SHIP = ['index.html', 'app.js', 'api.js', 'errors.js', 'mock-data.js', 'styles.css'];

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failures.push(name); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function info(text) { console.log('    · ' + text); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitOut(a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : '';
}

function sha1(x) {
  return crypto.createHash('sha1').update(x).digest('hex').slice(0, 12);
}

function fetchOne(urlPath) {
  return new Promise((resolve) => {
    const req = http.get(ORIGIN + urlPath, { timeout: 4000 }, (r) => {
      let s = '';
      r.on('data', (d) => s += d);
      r.on('end', () => resolve({ code: r.statusCode, body: s }));
    });
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '' }); });
  });
}

/**
 * 探测"线上"到底吐了什么：把 6 个上线文件**全部**取一遍，
 * 再拼成一个整体指纹来代表"当前线上是哪一版"。
 *
 * ★ 为什么不能只探首页（Day 26 真踩的坑）：
 *     本次两版之间改的只有 app.js 和 errors.js，index.html 一字未改。
 *     只比对首页 → 两台服务返回完全一致 → 报"回滚没生效"。
 *     但回滚是**生效了的**，瞎的是断言本身。
 *     这种"断言瞎了"比"被测的坏了"更坑：它会让你去修一个根本没坏的回滚流程。
 *   所以指纹必须覆盖**发布物全集**。
 */
async function probeAll() {
  const files = {};
  for (const n of SHIP) files[n] = await fetchOne('/' + n);
  const missing = SHIP.filter((n) => files[n].code !== 200);
  return {
    ok: missing.length === 0,
    code: files['index.html'].code,
    html: files['index.html'].body,
    fp: SHIP.map((n) => n + ':' + sha1(files[n].body)).join('|'),
    missing,
    files,
  };
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    const p = await probeAll();
    if (p.ok) return true;
    await sleep(150);
  }
  return false;
}

function startServer(cwd) {
  return spawn(PYTHON, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd, stdio: 'ignore' });
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill();
  await sleep(500);
}

/** 发布物整体指纹：与 probeAll().fp 同一套算法，用来比对"线上"与"导出"是否一致 */
function fingerprint(dir) {
  return SHIP.map((f) => {
    const p = path.join(dir, f);
    return f + ':' + (fs.existsSync(p) ? sha1(fs.readFileSync(p)) : 'MISSING');
  }).join('|');
}

/** 导出某个提交里的上线文件，返回 [{name, size}] */
function exportRelease(ref, dest, paths) {
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('git', ['archive', '--format=tar', ref, '--'].concat(paths),
    { cwd: ROOT, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('git archive 失败：' + String(r.stderr || ''));
  const t = spawnSync('tar', ['-x', '-C', dest],
    { input: r.stdout, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (t.status !== 0) throw new Error('tar 解包失败：' + String(t.stderr || ''));
  return paths.map((p) => ({ name: p, size: fs.statSync(path.join(dest, p)).size }));
}

/**
 * 找**真正的**回滚基线：最近一个"发布物内容跟当前不一样"的提交。
 *
 * ★ 为什么不能想当然地用 HEAD~1：
 *     如果最后一个提交是**纯文档 / 纯工具**提交（改 README、加自检脚本），
 *     那 HEAD~1 的发布物跟 HEAD 一字不差 —— 退到它，线上页面**没有任何变化**，
 *     你会以为自己回滚成功了，其实什么都没发生。这种"假回滚"比不回滚更危险。
 *   所以基线必须是"上一个**改动了发布物**的提交"，而不是"上一个提交"。
 */
function findRollbackTarget() {
  const head = gitOut(['rev-parse', 'HEAD']).trim();
  const lines = gitOut(['log', '--format=%H', '-n', '30']).trim().split('\n').filter(Boolean);
  for (const sha of lines) {
    if (sha === head) continue;
    const d = spawnSync('git', ['diff', '--quiet', 'HEAD', sha, '--'].concat(SHIP));
    if (d.status !== 0) return sha;   // 有差异 → 这才是能真正"退回去"的那一版
  }
  return '';
}

async function main() {
  const timing = [];
  const now = () => Date.now();
  const dur = (a, b) => (b - a);

  console.log('\n================================================================');
  console.log('Day 26 回滚演练：静态托管回退路径');
  console.log('================================================================');

  /* ---------- ① 确认可回退历史 ---------- */
  const t0 = now();
  const dirty = gitOut(['status', '--porcelain']).trim();
  const head = gitOut(['rev-parse', 'HEAD']).trim();
  const remote = gitOut(['rev-parse', 'origin/main']).trim();
  const history = gitOut(['log', '--oneline', '-n', '6']).trim().split('\n').filter(Boolean);
  const prev = findRollbackTarget();
  const headPrev = gitOut(['rev-parse', 'HEAD~1']).trim();
  const prevIsNoop = !!headPrev &&
    spawnSync('git', ['diff', '--quiet', 'HEAD', headPrev, '--'].concat(SHIP)).status === 0;
  timing.push(['① 确认可回退历史', dur(t0, now())]);

  console.log('\n① 确认可回退历史（发布的前置条件）');
  check('Z-1 工作区干净 —— 有未提交改动就不该发布，否则回滚基线说不清',
    dirty === '', dirty.split('\n')[0] || '');
  check('Z-2 本地 HEAD 与远端 main 一致 —— 不然回滚基线跟线上不是一回事',
    !!head && head === remote,
    '本地 ' + head.slice(0, 7) + ' / 远端 ' + (remote ? remote.slice(0, 7) : '(缺失)'));
  check('Z-3 至少有 2 条历史提交可退', history.length >= 2, '只有 ' + history.length + ' 条');
  check('Z-4 找到了可解析的回滚基线', !!prev && prev !== head, prev.slice(0, 7));
  /* ★ 陷阱检查：HEAD~1 跟 HEAD 的发布物一模一样时，退它等于白退。 */
  check('Z-5 ★ 基线**没有**停在"空回滚"上（HEAD~1 若与 HEAD 发布物相同，退它线上毫无变化）',
    !prevIsNoop || prev !== headPrev,
    prevIsNoop ? 'HEAD~1 是纯文档/工具提交，发布物与当前一致 —— 已自动往前取到 ' + prev.slice(0, 7) : '');
  info('当前 HEAD：' + head.slice(0, 7) + '　回滚目标：' + prev.slice(0, 7) +
       (prevIsNoop ? '（HEAD~1 与 HEAD 发布物相同，已自动跳过它）' : ''));

  /* ---------- ② 导出发布物 ---------- */
  const t1 = now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notelab-rollback-'));
  const curDir = path.join(tmp, 'current');
  const prevDir = path.join(tmp, 'previous');
  const curFiles = exportRelease('HEAD', curDir, SHIP);
  const prevFiles = exportRelease(prev, prevDir, SHIP);
  timing.push(['② 导出两个版本的发布物', dur(t1, now())]);

  console.log('\n② 发布物');
  check('P-1 上线文件全部导出成功（' + SHIP.length + ' 个）',
    curFiles.length === SHIP.length && prevFiles.length === SHIP.length,
    curFiles.length + '/' + prevFiles.length);

  /* ---------- ③ 回滚演练 ---------- */
  console.log('\n③ 回滚演练（把静态托管指向上一版）');

  let server = startServer(curDir);
  const upCurrent = await waitUp();
  const before = await probeAll();
  await stopServer(server);

  const tRollbackStart = now();        // ← 决定回滚
  server = startServer(prevDir);      // ★ 切版本
  const upPrev = await waitUp();
  const after = await probeAll();
  const rollbackMs = dur(tRollbackStart, now());   // ← 上一版已可访问
  await stopServer(server);
  timing.push(['③ 回滚（决定 → 上一版可访问）', rollbackMs]);

  const changedFiles = SHIP.filter((n) => sha1(before.files[n].body) !== sha1(after.files[n].body));

  check('R-1 回滚前：当前版本 ' + SHIP.length + ' 个上线文件全部可访问',
    upCurrent && before.ok, upCurrent ? '取不到：' + before.missing.join('、') : '服务没起来');
  check('R-2 ★ 回滚后：上一版 ' + SHIP.length + ' 个上线文件**仍然**全部可访问（回滚的意义就在这）',
    upPrev && after.ok, upPrev ? '取不到：' + after.missing.join('、') : '服务没起来');
  check('R-3 ★ 回滚确实换了内容（发布物整体指纹变了，不是原来那份）',
    before.fp !== '' && before.fp !== after.fp,
    '两版发布物指纹完全一致，回滚可能没生效');
  check('R-4 回滚后页面结构完整（标题 / 输入区 / 三个视图）',
    /随手笔记/.test(after.html) && /id="note-input"/.test(after.html) &&
    /id="view-write"/.test(after.html) && /id="view-notes"/.test(after.html) &&
    /id="view-review"/.test(after.html),
    '页面缺少关键节点');
  check('R-5 回滚后每个上线文件都非空（不是只有首页能开）',
    SHIP.every((n) => after.files[n].body.length > 0),
    '空文件：' + SHIP.filter((n) => !after.files[n].body.length).join('、'));

  if (changedFiles.length) {
    info('两版之间有差异的文件：' + changedFiles.join('、'));
  }
  if (changedFiles.length && changedFiles.indexOf('index.html') === -1) {
    info('★ index.html 本次未变 → 只比对首页的断言会误报"回滚没生效"，所以指纹按 6 个文件整体算');
  }

  /* ---------- ④ 恢复 ---------- */
  console.log('\n④ 恢复到 v1.0 并复验');
  const tRestoreStart = now();
  server = startServer(curDir);
  const upBack = await waitUp();
  const back = await probeAll();
  await stopServer(server);
  const restoreMs = dur(tRestoreStart, now());
  timing.push(['④ 恢复并复验', restoreMs]);

  check('B-1 ★ 已恢复到当前版本，发布物指纹与回滚前完全一致',
    upBack && back.ok && back.fp === before.fp,
    '恢复后的页面与发布版不一致');
  check('B-2 恢复后页面结构完整',
    /随手笔记/.test(back.html) && /id="note-input"/.test(back.html), '页面缺少关键节点');

  /* ---------- ⑤ 计时表 ---------- */
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  const total = timing.reduce((a, [, d]) => a + d, 0);
  console.log('\n⑤ 耗时记录（本机静态服务，模拟托管切换）');
  timing.forEach(([label, d], i) => {
    const mark = label.indexOf('③') === 0 ? '★★' : (i + 1) + '.';
    console.log('  · ' + pad(label, 30) + (d / 1000).toFixed(2) + ' 秒' +
      (label.indexOf('③') === 0 ? '   ← 这就是"回滚窗口"' : ''));
    void mark;
  });
  console.log('  ' + '-'.repeat(46));
  console.log('  · ' + pad('合计', 30) + (total / 1000).toFixed(2) + ' 秒');

  /* ---------- ⑥ 清理 ---------- */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录删不掉也不影响结论 */ }
  info('临时目录已清理：' + tmp);

  console.log('\n================================================================');
  console.log('演练结果：' + pass + '/' + (pass + failures.length) + ' 项断言通过' +
    (failures.length ? ' ❌' : ' ✅'));
  console.log('================================================================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('演练脚本自己挂了：', e.message); process.exitCode = 1; });
