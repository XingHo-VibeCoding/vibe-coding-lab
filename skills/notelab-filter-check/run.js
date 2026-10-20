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
const ERRORS_SOURCE = fs.readFileSync(path.join(ROOT, 'errors.js'), 'utf8');  // Day 23：报错文案
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
    value: '', className: '', type: '',
    /* ★ Day 23：记住每次给 textContent 赋过什么值（textHistory）。
       为什么不能直接读 textContent：
         本沙箱里的 setTimeout 是"立刻执行"的（好让假接口那 700ms 不用真等），
         于是 showHint() 设完文字之后、那个"3000ms 后清空"的定时器**同步**就跑了，
         直接读 textContent 只会读到空串 —— 只看当前值会把"提示过"误判成"没提示"。
       有了历史，就能断言"它确实显示过那句话"。 */
    _text: '',
    textHistory: [],
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.textHistory.push(String(v)); },
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
   boot(search, opts)：起一个干净的"页面"，返回取句柄的入口、以及模拟跳转的方法
     search 传 '?demo=1&state=empty' 之类就进演示模式的某种状态
     opts.failSetItemFor + opts.storageError  Day 23 新增：
       让 localStorage.setItem 在写**指定那个键**时抛出指定错误，
       用来验"存储写满"和"存储被禁用"给出的是两句不同的话。
       （只对指定键生效，是为了让 loadNotes 里那次 notelab.probe 探测照常通过，
         这样才测得到"探测通过、真正保存时写满"这条真实路径。）
   ------------------------------------------------------------ */
function boot(search, opts) {
  const o = opts || {};
  const byId = {};
  const hashListeners = [];
  const storage = new Map();
  storage.set('notelab.notes.v1', JSON.stringify(SEED_NOTES));
  /* Day 24：允许直接塞一段**原始**存储内容（而不是塞一个现成的数组），
     用来复现"数据半好半坏"的现场 —— 数组里混进 null、某条缺 content。
     ★ 必须传字符串：真实 localStorage 里存的就是字符串，
       传数组的话 JSON.parse 那一步就被绕过去了，测不到真东西。 */
  if (o.rawStorage !== undefined) storage.set('notelab.notes.v1', o.rawStorage);

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
    setItem(k, v) {
      if (o.failSetItemFor && k === o.failSetItemFor) throw o.storageError;
      storage.set(k, String(v));
    },
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
  // 顺序必须和 index.html 里一致（Day 23 起多了一个 errors.js，它排在最前）：
  //   errors.js（提供报错文案）→ mock-data.js（提供 fetchMockNotes）→ app.js
  // ★ 顺序错了的表现是 app.js 读不到 window.NoteLabErrors 而报错，
  //   看起来像"app.js 有 bug"，其实是这个测试环境没跟上真实页面。
  vm.runInContext(ERRORS_SOURCE, sandbox, { filename: 'errors.js' });
  vm.runInContext(MOCK_SOURCE, sandbox, { filename: 'mock-data.js' });
  vm.runInContext(APP_SOURCE, sandbox, { filename: 'app.js' });

  return {
    byId,
    navLinks,
    location,
    // Day 24：把沙箱也放出来，好在断言里直接调 sanitizeNotes 之类的纯函数
    // （比"页面没崩"更硬 —— 崩不崩还可能被别的因素掩盖）
    sandbox,
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

  /* ---------- D 存储错误：写满 ≠ 被禁用（Day 23）---------- */
  section('D 存储错误：写满和被禁用要说两句不同的话');

  // ① 探测能过、真正保存时写满 —— 改前这条会被误报成"浏览器不允许本地存储"，
  //    而它的解法（删几条旧笔记）和"不允许存储"（换窗口）完全不同。
  const quotaPage = boot('', {
    failSetItemFor: 'notelab.notes.v1',
    storageError: { name: 'QuotaExceededError', message: 'The quota has been exceeded.' }
  });
  quotaPage.byId['note-input'].value = '这条写不进去 #测试';
  quotaPage.byId['save-btn'].trigger('click');
  const quotaHint = quotaPage.byId['input-hint'].textHistory.filter((t) => t !== '');

  check('D-1 ★ 空间写满 → 提示里说"写满"（改前一律说"不允许本地存储"）',
    quotaHint.some((t) => t.includes('写满')), JSON.stringify(quotaHint));
  check('D-2 ★ 空间写满 → 提示里**不**说"不允许"（说了就是把人往错路上引）',
    !quotaHint.some((t) => t.includes('不允许')), JSON.stringify(quotaHint));
  check('D-3 空间写满 → 给了能做的一步（删掉一些旧笔记）',
    quotaHint.some((t) => t.includes('删掉')), JSON.stringify(quotaHint));

  // ② 隐私模式：连"探测写一下"都过不去，存储根本不能用
  const blockedPage = boot('', {
    failSetItemFor: 'notelab.probe',
    storageError: { name: 'SecurityError', message: 'The operation is insecure.' }
  });
  const blockedHint = blockedPage.byId['input-hint'].textHistory.filter((t) => t !== '');

  check('D-4 ★ 存储被禁用 → 提示说"不允许"（隐私模式）',
    blockedHint.some((t) => t.includes('不允许')), JSON.stringify(blockedHint));
  check('D-5 ★ 两句提示确实**不是同一句**（否则分类等于白分）',
    !blockedHint.some((t) => t.includes('写满')) &&
    !quotaHint.some((t) => t.includes('不允许')),
    JSON.stringify(blockedHint));
  check('D-6 存储被禁用 → 也给了出路（换窗口 / 先复制走）',
    blockedHint.some((t) => t.includes('换') || t.includes('复制')),
    JSON.stringify(blockedHint));

  // ③ 正常情况不该被上面的改动误伤：能存的时候要回一句"已保存"
  const normalPage = boot('');
  normalPage.byId['note-input'].value = '能存进去的一条 #正常';
  normalPage.byId['save-btn'].trigger('click');
  check('D-7 正常保存 → 提示"已保存"，没有被错误分支抢走',
    normalPage.byId['input-hint'].textHistory.includes('已保存'),
    JSON.stringify(normalPage.byId['input-hint'].textHistory));

  /* ---------- E 数据坏一半：不能崩，也不能闷声丢（Day 24）---------- */
  section('E 数据坏一半：坏的跳过、好的留下，而且得吭声');

  /* 为什么要有这一段：
     改前 loadNotes 只验"是不是数组"，数组里混进 null 或缺 content 的条目照样往下走，
     最后炸在 renderTagList（null.tags）和 getVisibleNotes（undefined.toLowerCase）。
     而且这两处的触发条件**不一样**：不搜索时只是把 undefined 当正文显示出来（页面看着还在，
     其实在说谎），一搜索才当场崩。所以下面两个都要测，只测一个会以为问题不大。 */
  const HALF_BAD = JSON.stringify([
    null,
    { id: 'ok1', content: '这条是完整的 #想法', tags: ['想法'], createdAt: '2026-10-02T10:00:00.000Z' },
    { id: 'bad', tags: ['想法'], createdAt: '2026-10-01T10:00:00.000Z' }   // 缺 content
  ]);

  let halfPage = null;
  let bootThrew = null;
  try { halfPage = boot('', { rawStorage: HALF_BAD }); }
  catch (e) { bootThrew = e; }

  check('E-1 ★ 数组里混了 null / 缺字段的笔记，页面**不崩**（改前 TypeError 崩在 renderTagList）',
    bootThrew === null, bootThrew && bootThrew.message);
  check('E-2 合格的笔记照常显示（坏一条不该连坐全部消失）',
    !!halfPage && halfPage.byId['note-count'].textContent === '共 1 条',
    halfPage && halfPage.byId['note-count'].textContent);
  check('E-3 ★ 丢掉的那几条**有提示**，不是闷声丢（改前一句都不说）',
    !!halfPage && halfPage.byId['input-hint'].textHistory.some((t) => t.includes('跳过')),
    halfPage && JSON.stringify(halfPage.byId['input-hint'].textHistory.filter((t) => t !== '')));

  // 搜索时崩的是另一处（getVisibleNotes 里的 content.toLowerCase），单独盯住
  let searchThrew = null;
  try {
    const s = halfPage.byId['search-input'];
    s.value = '想法';
    s.trigger('input');
  } catch (e) { searchThrew = e; }
  check('E-4 ★ 坏数据 + 搜索也**不崩**（改前 TypeError 崩在 getVisibleNotes）',
    searchThrew === null, searchThrew && searchThrew.message);

  /* 整块坏掉 vs 坏一半：这是两种病，得说两句不同的话。
     整块坏掉（JSON 整个不合法）改前就有人兜着 → 说"已按空列表继续"；
     坏一半才是我今天补的 → 说"已经跳过，其余照常显示"。 */
  const wholeBadPage = boot('', { rawStorage: '这不是合法的 JSON' });
  const wholeBadHints = wholeBadPage.byId['input-hint'].textHistory.filter((t) => t !== '');
  check('E-5 ★ 整块坏掉说"空列表"、坏一半说"跳过"，两种坏法不是同一句话',
    wholeBadHints.some((t) => t.includes('空列表')) && !wholeBadHints.some((t) => t.includes('其余')),
    JSON.stringify(wholeBadHints));

  // 直接验函数本身：比"页面没崩"更硬
  const sb = halfPage.sandbox;
  const s1 = sb.sanitizeNotes([{ content: 'x' }, null]);
  check('E-6 sanitizeNotes：不合格的丢掉、合格的留下，并记录丢了哪几条（不是只报个数字）',
    s1.dropped === 1 && s1.notes.length === 1 && s1.droppedItems.length === 1,
    JSON.stringify({ dropped: s1.dropped, kept: s1.notes.length }));
  check('E-7 ★ sanitizeNotes：压根没存过东西（null）**不算坏**，不能误报"数据坏了"',
    sb.sanitizeNotes(null).dropped === 0);
  check('E-8 ★ sanitizeNotes：顶层不是数组也算坏（不能睁眼放过）',
    sb.sanitizeNotes('我是字符串').dropped === 1 &&
    sb.sanitizeNotes('我是字符串').notes.length === 0);

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
    'A 视图切换 / B 筛选交互 / C 四种页面状态 / D 存储错误的两类提示（Day 23 起）' +
    ' / E 数据坏一半不崩且会吭声（Day 24 起）\n');

  process.exit(passed === total ? 0 : 1);
})();
