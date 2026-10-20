/* ============================================================
   Day 24｜故障猎手：把"刁钻输入"喂给**原封不动的 index.html**
   ============================================================
   用法：
     node skills/notelab-bug-hunt/hunt.cjs          跑全部用例
     node skills/notelab-bug-hunt/hunt.cjs clean    只跑指定用例

   为什么用 CDP 而不是"看一眼页面"：
     今天要交的截图是「F12 控制台里的报错原文」。页面截图拍不到控制台，
     所以必须把浏览器真实的 console / 未捕获异常**原样取出来**。
     CDP 的 Runtime.consoleAPICalled + Runtime.exceptionThrown 就是 F12 拿到的那两份东西。

   为什么坚持用**没改过的 index.html**：
     为测试而改过的页面，测出来的是"改过之后的页面有没有问题"。
     播种数据靠同源的 seed.html（localStorage 按源隔离），
     UI 操作靠 Runtime.evaluate 调 app.js 里本来就全局可见的函数。
     两件事都不碰 index.html 一个字节。
   ============================================================ */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const ORIGIN = 'http://127.0.0.1:8123';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DBG_PORT = 9333;

/* ------------------------------------------------------------
   用例表
   seed  = 先写进 localStorage 的数据形态（null 表示不播种）
   drive = 页面加载完之后在页面里执行的动作（模拟真人操作）
   ------------------------------------------------------------ */
const CASES = [
  { name: 'clean', seed: 'clean',
    note: '对照组：数据完全正常。这一组**必须**不报错，否则说明是环境问题不是数据问题' },

  /* ---- 排除用的对照组：证明"数据整体坏了"其实**不崩**（有兜底） ----
     如果这两组也崩，那真因就不是"第二层没校验"，而是别的东西。 */
  { name: 'broken-json', seed: 'broken-json',
    note: '整个 JSON 就是坏的：JSON.parse 会抛错，本来就有 try/catch 兜着' },
  { name: 'broken-not-array', seed: 'broken-not-array',
    note: 'JSON 合法但顶层不是数组：有 Array.isArray 兜着' },

  { name: 'missing-content', seed: 'missing-content',
    note: '一条笔记缺 content 字段（手改坏了 / 接口返回字段不齐）' },
  { name: 'null-content', seed: 'null-content',
    note: 'content 字段在，但值是 null' },
  { name: 'string-element', seed: 'string-element',
    note: '数组里混进一个字符串' },
  { name: 'null-element', seed: 'null-element',
    note: '数组里有一个 null' },
  { name: 'bad-time', seed: 'bad-time',
    note: 'createdAt 是乱码：不崩，但看时间会是 NaN（低优先级）' },

  /* ★ 下面三个是"坏数据 + 用户搜一下"。
     为什么一定要补这组：不搜索时，坏数据只是把 "undefined"/"null" 当正文显示出来，
     页面看着还在，其实**已经在说谎**；一搜索才当场崩。
     也就是说同一个 Bug 有两种脸，只测其中一种会以为问题不大。 */
  { name: 'missing-content-search', seed: 'missing-content',
    drive: "var s=document.getElementById('search-input'); s.value='想法'; s.dispatchEvent(new Event('input'))",
    note: '缺 content 的坏数据 + 用户搜一下' },
  { name: 'null-content-search', seed: 'null-content',
    drive: "var s=document.getElementById('search-input'); s.value='完'; s.dispatchEvent(new Event('input'))",
    note: 'content 是 null + 用户搜一下' },
  { name: 'null-element-search', seed: 'null-element',
    drive: "var s=document.getElementById('search-input'); s.value='a'; s.dispatchEvent(new Event('input'))",
    note: '数组里有 null + 用户搜一下（打开时就已崩，这一组看崩完之后还能不能救）' },

  { name: 'ui-empty-save', seed: 'clean',
    drive: "addNote('   ')",
    note: '空输入（只有空格）点保存' },
  { name: 'ui-over-limit', seed: 'clean',
    drive: "el.input.value = 'x'.repeat(6000); addNote(el.input.value)",
    note: '超长文本 6000 字（上限 5000）' },
  { name: 'ui-rapid-double-save', seed: 'clean',
    drive: "addNote('连点第一条'); addNote('连点第一条')",
    note: '快速连点两次保存（同一毫秒内）' },
  { name: 'ui-rapid-random', seed: 'clean',
    drive: "for (let i=0;i<20;i++) pickRandomNote()",
    note: '快速连点「翻一翻」20 次' },
  { name: 'ui-search-nothing', seed: 'clean',
    drive: "var s=document.getElementById('search-input'); s.value='zzz不存在zzz'; s.dispatchEvent(new Event('input'))",
    note: '搜一个不存在的词' }
];

/* ------------------------------------------------------------
   极简 CDP 客户端
   ------------------------------------------------------------ */
let ws = null;
let seq = 0;
const waiting = new Map();     // id -> {resolve, reject}
let pendingLoad = null;

function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

function onMessage(raw) {
  const msg = JSON.parse(String(raw));
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
    return;
  }
  if (msg.method === 'Page.loadEventFired' && pendingLoad) {
    const r = pendingLoad; pendingLoad = null; r();
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const e = msg.params;
    const txt = (e.args || []).map((a) => {
      if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      return a.description || a.type || '?';
    }).join(' ');
    consoleBuf.push({ level: e.type, text: txt,
      url: (e.stackTrace && e.stackTrace.callFrames[0] && e.stackTrace.callFrames[0].url) || '' ,
      line: (e.stackTrace && e.stackTrace.callFrames[0] && e.stackTrace.callFrames[0].lineNumber) });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    /* ★ CDP 的坑：完整的报错原文（"TypeError: Cannot read properties of null…"）
       不在 exceptionDetails.description 里，而在 exceptionDetails.exception.description。
       第一版只取了前者，结果控制台里只剩一个孤零零的 "Uncaught" ——
       那种"报错了但看不出报了什么"的输出，跟没抓到是一样的。 */
    const ex = d.exception || {};
    consoleBuf.push({ level: 'error', text: d.text || '',
      desc: d.description || ex.description || ex.value || '',
      url: d.url || '', line: d.lineNumber, column: d.columnNumber,
      stack: ((d.stackTrace && d.stackTrace.callFrames) || []).slice(0, 4)
        .map((f) => '    at ' + (f.functionName || '(anonymous)') +
             ' (' + (f.url || '').replace(ORIGIN, '') + ':' + (f.lineNumber + 1) + ')')
        .join('\n') });
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry || {};
    consoleBuf.push({ level: e.level, text: e.text || '', url: e.url || '', line: e.lineNumber });
  }
}

let consoleBuf = [];

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: p }, (r) => {
      let s = ''; r.on('data', (d) => s += d);
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { await getJSON('/json/version'); return true; } catch (e) { await sleep(250); }
  }
  throw new Error('浏览器调试端口一直没起来');
}

async function main() {
  const only = process.argv[2];
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'notelab-hunt-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
    '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + DBG_PORT,
    '--user-data-dir=' + udd,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitReady();

    let targets = [];
    for (let i = 0; i < 40 && !targets.length; i++) {
      targets = (await getJSON('/json/list')).filter((t) => t.type === 'page');
      if (!targets.length) await sleep(250);
    }
    if (!targets.length) throw new Error('没找到页面目标');

    await new Promise((resolve, reject) => {
      ws = new WebSocket(targets[0].webSocketDebuggerUrl);
      ws.onopen = resolve;
      ws.onerror = reject;
      ws.onmessage = (ev) => onMessage(ev.data);
    });

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');

    const results = [];
    for (const c of CASES) {
      if (only && c.name !== only) continue;
      consoleBuf = [];

      await navigate(ORIGIN + '/skills/notelab-bug-hunt/seed.html?case=' + (c.seed || 'clean'));

      await navigate(ORIGIN + '/index.html');
      await sleep(400);   // bootstrap 里还有异步分支，多等一会儿

      let dom = null;
      if (c.drive) {
        const r = await send('Runtime.evaluate',
          { expression: '(() => { try { ' + c.drive + ' ; return "ok"; } catch (e) { return "THROWN: " + e.message; } })()',
            returnByValue: true, awaitPromise: false });
        dom = r.result && r.result.value;
        await sleep(300);
      }

      const dom2 = await send('Runtime.evaluate', {
        expression: JSON.stringify('') && `(() => {
          const q = (s) => document.querySelector(s);
          const list = q('#note-list');
          return {
            listCount: list ? list.children.length : -1,
            firstText: (list && list.children[0]) ? list.children[0].textContent.slice(0, 60) : '',
            hint: (q('#input-hint') || {}).textContent || '',
            noteCount: (q('#note-count') || {}).textContent || '',
            listStatus: (q('#list-status') || {}).textContent || '',
            panelHidden: q('#state-panel') ? q('#state-panel').hidden : null,
            recentCount: q('#recent-list') ? q('#recent-list').children.length : -1
          };
        })()`,
        returnByValue: true
      });

      results.push({ c, console: consoleBuf.slice(), dom: dom2.result && dom2.result.value, driveResult: dom });
    }

    /* ---------- 输出 ---------- */
    console.log('\n================================================================');
    console.log('Day 24 故障猎手：刁钻输入 × 真实 index.html');
    console.log('================================================================');
    for (const r of results) {
      const bad = r.console.filter((e) => e.level === 'error' || e.desc);
      console.log('\n── 用例 ' + r.c.name + ' ──');
      console.log('   ' + r.c.note);
      if (r.c.drive) console.log('   动作：' + r.c.drive + '  → ' + r.driveResult);
      console.log('   页面结果：列表 ' + r.dom.listCount + ' 条 · 计数「' + r.dom.noteCount +
                  '」· 状态「' + r.dom.listStatus + '」· 提示「' + r.dom.hint + '」');
      if (r.dom.firstText) console.log('   第一条：' + r.dom.firstText);
      if (!bad.length) {
        console.log('   控制台：无报错 ✅');
      } else {
        console.log('   控制台：' + bad.length + ' 条报错 ❌');
        bad.forEach((e) => {
          console.log('     [' + e.level + '] ' + (e.text || '').slice(0, 200));
          if (e.desc) console.log('       ' + String(e.desc).split('\n')[0].slice(0, 200));
          if (e.url) console.log('       @ ' + String(e.url).replace(ORIGIN, '') +
                                 (e.line !== undefined ? ':' + (e.line + 1) : ''));
          if (e.stack) console.log(e.stack);
        });
      }
    }

    const crashed = results.filter((r) => r.console.some((e) => e.level === 'error' || e.desc));
    console.log('\n================================================================');
    console.log('复现结果：' + crashed.length + ' / ' + results.length + ' 个用例在控制台留下了报错');
    crashed.forEach((r) => console.log('   ❌ ' + r.c.name));
    console.log('================================================================');

    fs.writeFileSync(path.join(__dirname, 'LASTHUNT.json'),
      JSON.stringify(results, null, 2), 'utf8');
    console.log('\n明细已写入 skills/notelab-bug-hunt/LASTHUNT.json');
  } finally {
    child.kill();
  }
}

function navigate(url) {
  return new Promise((resolve) => {
    pendingLoad = resolve;
    send('Page.navigate', { url }).catch(() => {});
    setTimeout(() => { if (pendingLoad) { const r = pendingLoad; pendingLoad = null; r(); } }, 8000);
  });
}

main().catch((e) => { console.error('猎手自己挂了：', e); process.exitCode = 1; });
