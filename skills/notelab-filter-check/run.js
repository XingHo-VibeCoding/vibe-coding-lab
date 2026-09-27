/* ============================================================
   notelab-filter-check / run.js —— 交互自检脚本
   （Day 12 建立，Day 13 扩到"视图切换"与"四种状态"）

   用法（项目根目录执行）：
     node skills/notelab-filter-check/run.js

   检查什么：
     A 视图切换   三个视图能互相切、导航高亮跟着走、乱写地址不白屏
     B 筛选交互   有结果 / 无结果 / 清空恢复 / 标签点击与取消
     C 四种状态   加载中 / 有数据 / 空 / 出错 各自渲染正确

   怎么做到零依赖：用 DOM 桩在 Node 里执行 app.js，通过 app.js 真实绑定的
   事件监听器与 hashchange 驱动，断言真实渲染结果。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');       // 项目根目录
const MOCK_SOURCE = fs.readFileSync(path.join(ROOT, 'mock-data.js'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const MOCK_NOTE_COUNT = 10;                          // mock-data.js 里的假笔记条数

// 等一轮微任务：演示模式里 fetchMockNotes 是 Promise，要等它 resolve 之后再断言
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------
   DOM 桩：只实现 app.js 真正会用到的方法
   ------------------------------------------------------------ */
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    attributes: {},
    dataset: {},
    value: '', textContent: '', className: '', type: '',
    hidden: false,
    disabled: false,
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(evt, fn) { (el.listeners[evt] = el.listeners[evt] || []).push(fn); },
    trigger(evt) { (el.listeners[evt] || []).forEach((fn) => fn({ preventDefault() {} })); },
    setAttribute(k, v) { el.attributes[k] = v; },
    removeAttribute(k) { delete el.attributes[k]; },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    // app.js 只在"切换视图后把焦点交给标题"时用到 querySelector
    querySelector() { el._queried = el._queried || makeElement('h2'); return el._queried; },
    focus() {},
    classList: (() => {
      const set = new Set();
      return {
        add(c) { set.add(c); },
        remove(c) { set.delete(c); },
        contains(c) { return set.has(c); },
        toggle(c, force) {
          const on = force === undefined ? !set.has(c) : !!force;
          if (on) set.add(c); else set.delete(c);
          return on;
        },
      };
    })(),
  };
  // app.js 里的 innerHTML 赋值只用来清空（= ''），让它顺便清掉子元素
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children = []; },
  });
  return el;
}

const SEED_NOTES = [
  { id: 't1', content: '2+2=4 #知识', tags: ['知识'], createdAt: '2026-09-26T10:00:00.000Z' },
  { id: 't2', content: '复习了一遍进位加法 #知识', tags: ['知识'], createdAt: '2026-09-26T09:00:00.000Z' },
  { id: 't3', content: '傍晚下楼散步，随手记的一条', tags: [], createdAt: '2026-09-25T20:00:00.000Z' },
];

/* ------------------------------------------------------------
   boot(search)：起一个干净的"页面"，返回取句柄的入口、以及模拟跳转的方法
   search 传 '?demo=1&state=empty' 之类就进演示模式的某种状态
   ------------------------------------------------------------ */
function boot(search) {
  const byId = {};
  const hashListeners = [];
  const storage = new Map();
  storage.set('notelab.notes.v1', JSON.stringify(SEED_NOTES));

  // 三个导航链接（app.js 靠 dataset.view 认视图），必须先于 document 建好
  const navLinks = ['write', 'notes', 'review'].map((id) => {
    const a = makeElement('a');
    a.dataset = { view: id };
    return a;
  });

  const document = {
    getElementById(id) { return (byId[id] = byId[id] || makeElement('div')); },
    createElement(tag) { return makeElement(tag); },
    createDocumentFragment() { return makeElement('#fragment'); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    querySelectorAll(sel) { return sel === '.view-link' ? navLinks : []; },
  };

  const localStorage = {
    setItem(k, v) { storage.set(k, String(v)); },
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    removeItem(k) { storage.delete(k); },
  };

  const location = { search: search || '', hash: '' };

  const sandbox = {
    document,
    localStorage,
    location,
    URLSearchParams,
    console,
    // 假 window：只用来接收 hashchange（浏览器点导航链接、按前进/后退都走这条路）
    window: { addEventListener(evt, fn) { if (evt === 'hashchange') hashListeners.push(fn); } },
    // 定时器立刻执行：把"假接口"的 700ms 变成同步返回，测试不必真的等
    setTimeout(fn) { fn(); },
    clearTimeout() {},
  };

  vm.createContext(sandbox);
  // 顺序必须和 index.html 里一致：先 mock-data.js（提供 fetchMockNotes），再 app.js
  vm.runInContext(MOCK_SOURCE, sandbox, { filename: 'mock-data.js' });
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  return {
    byId,
    navLinks,
    location,
    // 模拟地址变化：改 hash 再通知监听器
    goto(hash) {
      location.hash = hash;
      hashListeners.forEach((fn) => fn());
    },
  };
}

/* ------------------------------------------------------------
   断言小工具
   ------------------------------------------------------------ */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '（实际：' + detail + '）' : ''}`);
}
function section(title) { console.log(`== ${title} ==`); }

(async function main() {
  /* ---------- A 视图切换 ---------- */
  section('A 视图切换');
  const w = boot('');                       // 正常模式，地址里没有 hash

  check('A-1 默认进「写笔记」视图',
    w.byId['view-write'].hidden === false && w.byId['view-notes'].hidden === true,
    `notes.hidden=${w.byId['view-notes'].hidden}`);
  check('A-2 默认时导航第一项高亮 + aria-current',
    w.navLinks[0].classList.contains('active') && w.navLinks[0].getAttribute('aria-current') === 'page');

  w.goto('#/notes');
  check('A-3 跳到 #/notes 后只剩「全部笔记」可见',
    w.byId['view-notes'].hidden === false && w.byId['view-write'].hidden === true);
  check('A-4 导航高亮跟着移动，旧项摘掉 aria-current',
    w.navLinks[1].classList.contains('active') &&
    w.navLinks[1].getAttribute('aria-current') === 'page' &&
    w.navLinks[0].getAttribute('aria-current') === null);

  w.goto('#/review');
  check('A-5 跳到 #/review 后只剩「回顾」可见',
    w.byId['view-review'].hidden === false && w.byId['view-notes'].hidden === true);

  w.goto('#/nonsense-view');                // 乱写的地址
  check('A-6 地址写错时回默认视图，不白屏不报错',
    w.byId['view-write'].hidden === false);

  w.goto('#/notes');                        // 模拟浏览器"后退/前进"触发的 hashchange
  check('A-7 回到 #/notes（浏览器前进/后退走的就是这条路径）',
    w.byId['view-notes'].hidden === false);

  /* ---------- B 筛选交互（Day 12 原有，保持不变） ---------- */
  section('B 筛选交互');
  const search = w.byId['search-input'];
  const list = w.byId['note-list'];
  const emptyState = w.byId['empty-state'];
  const listStatus = w.byId['list-status'];
  const searchFor = (kw) => { search.value = kw; search.trigger('input'); };

  searchFor('知识');
  check('B-1 有结果：命中 2 条', list.children.length === 2, String(list.children.length));
  check('B-2 有结果：状态栏显示命中数', listStatus.textContent.includes('命中 2 条'), listStatus.textContent);
  check('B-3 有结果：空状态不出现', emptyState.hidden === true);

  searchFor('天下绝对没有这个词');
  check('B-4 无结果：列表清空', list.children.length === 0, String(list.children.length));
  check('B-5 无结果：出现明确的"没有找到"文案',
    emptyState.hidden === false && emptyState.textContent.includes('没有找到'), emptyState.textContent);
  check('B-6 无结果：状态栏如实显示 0 条', listStatus.textContent.includes('命中 0 条'));

  searchFor('');
  check('B-7 清空恢复：回到全部 3 条', list.children.length === 3, String(list.children.length));
  check('B-8 清空恢复：空状态重新隐藏', emptyState.hidden === true);
  check('B-9 清空恢复：状态栏回到「共 3 条」', listStatus.textContent.includes('共 3 条'));

  const tagBtn = (() => {
    for (const li of w.byId['tag-list'].children) {
      const btn = li.children[0];
      if (btn && btn.children[0] && btn.children[0].textContent === '#知识') return btn;
    }
    return null;
  })();
  check('B-10 侧栏能找到 #知识 按钮', tagBtn !== null);
  if (tagBtn) {
    tagBtn.trigger('click');
    check('B-11 标签筛选：只剩 2 条', list.children.length === 2, String(list.children.length));
    check('B-12 标签筛选：状态栏显示 #知识', listStatus.textContent.includes('#知识'));
    tagBtn.trigger('click');
    check('B-13 再点一次取消，恢复 3 条', list.children.length === 3, String(list.children.length));
  }

  /* ---------- C 四种页面状态（用演示模式强制出来） ---------- */
  section('C 四种页面状态');

  const loadingPage = boot('?demo=1&state=loading');
  await tick();
  const loadingPanel = loadingPage.byId['state-panel'];
  const skeletons = loadingPanel.children.filter((c) => c.className === 'skeleton-card');
  check('C-1 加载中：状态面板出现，含 3 张骨架卡',
    loadingPanel.hidden === false && skeletons.length === 3,
    `骨架卡 ${skeletons.length} 张 / 面板子元素 ${loadingPanel.children.length} 个`);
  check('C-1b 加载中：面板顶部有一句"正在取数据…"',
    loadingPanel.children[0].className === 'state-tip' && loadingPanel.children[0].textContent.includes('正在取数据'),
    loadingPanel.children[0] && loadingPanel.children[0].textContent);
  check('C-2 加载中：列表是空的（不拿旧数据充数）',
    loadingPage.byId['note-list'].children.length === 0);
  check('C-3 加载中：「回顾」的按钮被禁用并说明原因',
    loadingPage.byId['random-btn'].disabled === true &&
    loadingPage.byId['review-status'].textContent.includes('正在取数据'),
    loadingPage.byId['review-status'].textContent);
  check('C-4 加载中：「写笔记」的最近 3 条也如实显示加载中',
    loadingPage.byId['recent-tip'].hidden === false &&
    loadingPage.byId['recent-tip'].textContent.includes('正在取数据'));

  const successPage = boot('?demo=1&state=success');
  await tick();
  check('C-5 有数据：列表渲染出 10 条假笔记',
    successPage.byId['note-list'].children.length === MOCK_NOTE_COUNT,
    String(successPage.byId['note-list'].children.length));
  check('C-6 有数据：状态面板收起、空状态不出现',
    successPage.byId['state-panel'].hidden === true && successPage.byId['empty-state'].hidden === true);

  const emptyPage = boot('?demo=1&state=empty');
  await tick();
  check('C-7 空：列表 0 条且空状态可见',
    emptyPage.byId['note-list'].children.length === 0 && emptyPage.byId['empty-state'].hidden === false);
  check('C-8 空：空状态文案说明"现在就是空的样子"',
    emptyPage.byId['empty-state'].textContent.includes('空状态'),
    emptyPage.byId['empty-state'].textContent);
  check('C-9 空：状态面板不出现', emptyPage.byId['state-panel'].hidden === true);

  const errorPage = boot('?demo=1&state=error');
  await tick();
  const errorBox = errorPage.byId['state-panel'].children[0];
  check('C-10 出错：状态面板里出现 error-box',
    errorPage.byId['state-panel'].hidden === false && !!errorBox && errorBox.className === 'error-box',
    errorBox && errorBox.className);
  check('C-11 出错：说明了失败原因',
    !!errorBox && errorBox.children[1].textContent.includes('取数据失败'),
    errorBox && errorBox.children[1].textContent);
  check('C-12 出错：给了"重试"按钮这条出路',
    !!errorBox && errorBox.children[2].textContent === '重试' && errorBox.children[2].className === 'btn-primary');
  check('C-13 出错：「回顾」按钮禁用并指路',
    errorPage.byId['random-btn'].disabled === true &&
    errorPage.byId['review-status'].textContent.includes('全部笔记'),
    errorPage.byId['review-status'].textContent);

  /* ---------- 汇总 + 写调用记录 ---------- */
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`结果：${passed}/${total} 项断言通过 ${passed === total ? '✅' : '❌'}`);

  const logPath = path.join(__dirname, 'RUNLOG.md');
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '# RUNLOG｜notelab-filter-check 调用记录\n\n（由 run.js 自动追加，不要手改）\n');
  }
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(logPath,
    `- ${stamp}（node run.js）${passed}/${total} 项通过 ${passed === total ? '✅' : '❌'}：` +
    'A 视图切换 / B 筛选交互 / C 四种页面状态\n');

  process.exit(passed === total ? 0 : 1);
})();
