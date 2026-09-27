/* ============================================================
   render-check.js —— 真实渲染核查（Day 13 补）

   为什么需要它（这个文件存在的唯一理由）：
   run.js 用 DOM 桩驱动 app.js，断言的是"JS 把哪个属性设成了什么"。
   它无法回答一个更基本的问题：**用户在浏览器里到底看得见什么？**

   Day 13 真实教训：run.js 报 34/34 全过，但用户在页面上根本看不到
   列表的四种状态 —— 因为四种状态只能靠手打 ?demo=1&state=… 进入，
   页面上没入口。**桩测试给了一个假的安全感。**

   所以这个脚本换一条路：调用本机真实浏览器（Edge / Chrome）的无头模式，
   把页面的**最终 DOM** 抓回来，断言关键元素的 hidden 状态与内容。
   它补的正是桩测试盲区里最危险的那一块：元素的可见性。

   用法：
     node skills/notelab-filter-check/render-check.js            # 自动起服务并检查
     node skills/notelab-filter-check/render-check.js --no-serve  # 用已在跑的 8123 服务

   需要：本机装了 Edge 或 Chrome。没装会打印 SKIP 并退出 0（不算失败）。
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const FILE_BASE = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';

/* ---------- 1. 找一个能用的浏览器 ---------- */
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/* ---------- 2. 无头渲染一个 URL，拿回最终 DOM ---------- */
function renderDom(browser, url) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'notelab-render-'));
  const out = execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-proxy-server',
      '--no-first-run',
      `--user-data-dir=${udd}`,
      // 把页面里的定时器快进掉：mock 接口等 700ms，快进后直接看到最终状态
      '--virtual-time-budget=6000',
      '--dump-dom',
      url
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  return out;
}

/* ---------- 3. 从 DOM 文本里读事实 ---------- */
function makeProbe(html) {
  return {
    // 元素的 hidden 状态 —— 这是桩测试永远看不到的那一层
    vis(id) {
      const m = html.match(new RegExp('id="' + id + '"[^>]*'));
      if (!m) return 'missing';
      return /[ \t]hidden(=|\s|>|$)/.test(m[0]) ? 'hidden' : 'visible';
    },
    // 某个区块里出现的次数
    countIn(startId, endMark, cls) {
      const re = new RegExp('id="' + startId + '"[\\s\\S]*?' + endMark);
      const m = html.match(re);
      if (!m) return -1;
      return (m[0].match(new RegExp(cls, 'g')) || []).length;
    },
    count(cls) {
      return (html.match(new RegExp(cls, 'g')) || []).length;
    },
    // ⚠️ 数卡片**必须限定在 #note-list 里**：视图被 hidden 藏起来时，
    // DOM 里的元素照样存在 —— 「写笔记」视图里的「最近 3 条」也是
    // <li class="note-item">，全局数会把它们一起算进来（13 而不是 10）。
    // 这就是 README 约束第 9 条的同一个坑。
    countList() {
      const m = html.match(/<ul id="note-list"[\s\S]*?<\/ul>/);
      if (!m) return -1;
      return (m[0].match(/class="note-item"/g) || []).length;
    },
    text(id) {
      const m = html.match(new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    }
  };
}

/* ---------- 4. 断言 ---------- */
let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}  → 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ---------- 5. 起本地服务（可选）---------- */
function startServer() {
  const py = process.env.NOTELAB_PYTHON
    || 'C:/Users/岚/.workbuddy/binaries/python/versions/3.13.12/python.exe';
  const proc = spawn(py, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false
  });
  return proc;
}

function waitForServer(http) {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/index.html' }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        tries += 1;
        if (tries > 40) return resolve(false);
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

/* ---------- 主流程 ---------- */
(async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIP：本机没找到 Edge / Chrome，无法做真实渲染核查。');
    console.log('（这不是失败，但意味着"用户看得见什么"这一层没有被验证过）');
    process.exit(0);
  }
  console.log(`浏览器：${browser}`);
  console.log(`项目目录：${ROOT}\n`);

  const useExisting = process.argv.includes('--no-serve');
  let server = null;
  const http = require('http');

  if (!useExisting) {
    server = startServer();
    const ok = await waitForServer(http);
    if (!ok) {
      console.log('服务没起来，直接退出。');
      if (server) server.kill();
      process.exit(1);
    }
  }

  try {
    /* ===== R1 正常模式：「全部笔记」视图，以及那个入口真的在页面上 ===== */
    console.log('== R 真实渲染：正常模式 ==');
    {
      const p = makeProbe(renderDom(browser, `${BASE}/#/notes`));
      check('R-1 正常模式 #/notes：只有「全部笔记」视图可见',
        [p.vis('view-write'), p.vis('view-notes'), p.vis('view-review')].join(','),
        'hidden,visible,hidden');
      check('R-2 正常模式：演示提示条不出现', p.vis('demo-banner'), 'hidden');
      // ↓↓↓ 这一条就是 Day 13 用户报的问题：入口在页面上必须真的看得见 ↓↓↓
      check('R-3 正常模式：页面上有进演示模式的入口（用户能走得到）',
        p.vis('demo-entry'), 'visible');
      check('R-4 正常模式：四种状态的面板收起', p.vis('state-panel'), 'hidden');
    }

    /* ===== R2-R5 演示模式下的四种状态 ===== */
    console.log('\n== R 真实渲染：四种状态（演示模式）==');
    {
      const p = makeProbe(renderDom(browser, `${BASE}/?demo=1&state=success#/notes`));
      check('R-5 有数据：列表渲染出 10 张卡片', p.countList(), 10);
      check('R-6 有数据：状态面板收起', p.vis('state-panel'), 'hidden');
      check('R-7 有数据：入口已收起（提示条接管切换）', p.vis('demo-entry'), 'hidden');
      check('R-8 有数据：演示提示条可见', p.vis('demo-banner'), 'visible');
    }
    {
      const p = makeProbe(renderDom(browser, `${BASE}/?demo=1&state=loading#/notes`));
      check('R-9 加载中：状态面板可见', p.vis('state-panel'), 'visible');
      check('R-10 加载中：有 3 张骨架卡',
        p.countIn('state-panel', '<ul id="note-list"', 'class="skeleton-card"'), 3);
      check('R-11 加载中：列表是空的（不拿旧数据充数）', p.countList(), 0);
    }
    {
      const p = makeProbe(renderDom(browser, `${BASE}/?demo=1&state=empty#/notes`));
      check('R-12 空：空状态可见', p.vis('empty-state'), 'visible');
      check('R-13 空：列表 0 张卡片', p.countList(), 0);
      check('R-14 空：状态面板不出现', p.vis('state-panel'), 'hidden');
    }
    {
      const p = makeProbe(renderDom(browser, `${BASE}/?demo=1&state=error#/notes`));
      check('R-15 出错：状态面板可见', p.vis('state-panel'), 'visible');
      check('R-16 出错：有 error-box',
        p.countIn('state-panel', '<ul id="note-list"', 'class="error-box"'), 1);
      check('R-17 出错：给了「重试」这条出路',
        p.countIn('state-panel', '<ul id="note-list"', '重试') > 0, true);
      check('R-18 出错：列表 0 张卡片', p.countList(), 0);
    }

    /* ===== R6-R7 双击打开（file://）也要能用 =====
       这一组验证"入口链接写成相对路径 ?demo=… 在 file:// 下也能正确解析" */
    console.log('\n== R 真实渲染：双击打开（file://）==');
    {
      const p = makeProbe(renderDom(browser, `${FILE_BASE}#/write`));
      check('R-19 file:// 正常模式：默认落在「写笔记」', p.vis('view-write'), 'visible');
      check('R-20 file:// 正常模式：不是演示模式', p.vis('demo-banner'), 'hidden');
    }
    {
      const p = makeProbe(renderDom(browser, `${FILE_BASE}?demo=1&state=error#/notes`));
      check('R-21 file:// 演示模式：网址参数被正确解析（提示条出现）',
        p.vis('demo-banner'), 'visible');
      check('R-22 file:// 演示模式：出错状态真的渲染出来', p.vis('state-panel'), 'visible');
      check('R-23 file:// 演示模式：error-box 在',
        p.countIn('state-panel', '<ul id="note-list"', 'class="error-box"'), 1);
    }
  } finally {
    if (server) server.kill();
  }

  /* ---------- 结果 ---------- */
  const total = pass + failures.length;
  console.log(`\n结果：${pass}/${total} 项断言通过 ${failures.length === 0 ? '✅' : '❌'}`);
  if (failures.length) failures.forEach((f) => console.log(`   未通过：${f}`));

  // RUNLOG 留痕（和 run.js 一个规矩：真实跑过就要有记录）
  try {
    const log = path.join(__dirname, 'RUNLOG.md');
    const line = `| ${new Date().toISOString().replace('T', ' ').slice(0, 19)} | 真实渲染核查（无头浏览器） | `
      + `${pass}/${total} ${failures.length === 0 ? 'PASS' : 'FAIL'} | render-check.js |\n`;
    if (!fs.existsSync(log)) {
      fs.writeFileSync(log, '# RUNLOG｜自检脚本调用记录\n\n| 时间 | 方式 | 结果 | 脚本 |\n|---|---|---|---|\n');
    }
    fs.appendFileSync(log, line);
  } catch (e) { /* 记不上不影响结论 */ }

  process.exit(failures.length === 0 ? 0 : 1);
})();
