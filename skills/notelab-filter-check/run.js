/* ============================================================
   notelab-filter-check / run.js —— 筛选交互自检脚本（Day 12）

   用法（项目根目录执行）：
     node skills/notelab-filter-check/run.js

   它检查什么：搜索框输入关键词后，页面是不是
     情况一  有结果 → 该出结果出结果（条数对、状态栏对、空状态不出现）
     情况二  无结果 → 该说没找到就说没找到（明确提示，不是一片空白）
     情况三  清空   → 能回到全部（列表、状态栏都恢复）
     附加    标签点击筛选、再点一次取消（同属筛选交互）

   怎么做到零依赖：用 DOM 桩在 Node 里直接执行 app.js，
   通过 app.js 真实绑定的事件监听器驱动，断言真实渲染结果。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');       // 项目根目录

/* ------------------------------------------------------------
   第一部分：DOM 桩 —— 骗过 app.js，让它以为自己在浏览器里。
   只实现 app.js 真正会用到的那些方法，多一行都不写。
   ------------------------------------------------------------ */
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],          // appendChild 都记在这里，数它就是"页面上的卡片数"
    listeners: {},
    value: '', textContent: '', className: '', type: '',
    hidden: false,
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(evt, fn) { (el.listeners[evt] = el.listeners[evt] || []).push(fn); },
    trigger(evt) { (el.listeners[evt] || []).forEach((fn) => fn({ preventDefault() {} })); },
    classList: { toggle() {} },
    focus() {},
  };
  // app.js 里的 innerHTML 赋值只用来清空（= ''），让它顺便清掉子元素
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children = []; },
  });
  return el;
}

const byId = {};          // getElementById 的对象缓存（也是我们取句柄的地方）
const fakeDocument = {
  getElementById(id) { return (byId[id] = byId[id] || makeElement('div')); },
  createElement(tag) { return makeElement(tag); },
  createDocumentFragment() { return makeElement('#fragment'); },
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
};

const fakeStorage = new Map();    // localStorage 桩：内存版，跑完即丢
const fakeLocalStorage = {
  setItem(k, v) { fakeStorage.set(k, String(v)); },
  getItem(k) { return fakeStorage.has(k) ? fakeStorage.get(k) : null; },
  removeItem(k) { fakeStorage.delete(k); },
};

/* ------------------------------------------------------------
   第二部分：先造 3 条测试数据，再让 app.js 启动时读到它们。
   （两条带 #知识、一条无标签 —— 刚好能测出"命中/不命中/全量"三种数）
   ------------------------------------------------------------ */
const SEED_NOTES = [
  { id: 't1', content: '2+2=4 #知识', tags: ['知识'], createdAt: '2026-09-26T10:00:00.000Z' },
  { id: 't2', content: '复习了一遍进位加法 #知识', tags: ['知识'], createdAt: '2026-09-26T09:00:00.000Z' },
  { id: 't3', content: '傍晚下楼散步，随手记的一条', tags: [], createdAt: '2026-09-25T20:00:00.000Z' },
];
fakeStorage.set('notelab.notes.v1', JSON.stringify(SEED_NOTES));

/* ------------------------------------------------------------
   第三部分：把 app.js 装进 vm 沙箱跑起来。
   注意 location.search 是空的 → 走"正常模式"分支（和真人打开页面一致）。
   ------------------------------------------------------------ */
const sandbox = {
  document: fakeDocument,
  localStorage: fakeLocalStorage,
  location: { search: '' },
  URLSearchParams,
  console,
  setTimeout() {},        // 提示条自动消失的计时器，测试里用不上
  clearTimeout() {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
// 走到这里 app.js 已执行完 bootstrap()，"页面"渲染完毕

/* ------------------------------------------------------------
   第四部分：三种情况 + 附加用例，逐项断言
   ------------------------------------------------------------ */
const search = byId['search-input'];
const list = byId['note-list'];
const emptyState = byId['empty-state'];
const listStatus = byId['list-status'];
const tagList = byId['tag-list'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '（实际：' + detail + '）' : ''}`);
}
function searchFor(keyword) {
  search.value = keyword;
  search.trigger('input');       // 调的是 app.js 真实绑定的监听器
}
function visibleCount() { return list.children.length; }
function findTagButton(label) {
  for (const li of tagList.children) {
    const btn = li.children[0];
    if (btn && btn.children[0] && btn.children[0].textContent === label) return btn;
  }
  return null;
}

console.log('== 情况一：有结果 ==');
searchFor('知识');
check('一-1 命中 2 条（列表卡片数）', visibleCount() === 2, String(visibleCount()));
check('一-2 状态栏显示命中数', listStatus.textContent.includes('命中 2 条'), listStatus.textContent);
check('一-3 空状态保持隐藏', emptyState.hidden === true);

console.log('== 情况二：无结果 ==');
searchFor('天下绝对没有这个词');
check('二-1 列表清空', visibleCount() === 0, String(visibleCount()));
check('二-2 空状态出现且文案明确', emptyState.hidden === false && emptyState.textContent.includes('没有找到'), emptyState.textContent);
check('二-3 状态栏如实显示命中 0 条', listStatus.textContent.includes('命中 0 条'));

console.log('== 情况三：清空恢复 ==');
searchFor('');
check('三-1 恢复到全部 3 条', visibleCount() === 3, String(visibleCount()));
check('三-2 空状态重新隐藏', emptyState.hidden === true);
check('三-3 状态栏回到「共 3 条」', listStatus.textContent.includes('共 3 条'));

console.log('== 附加：标签点击筛选与取消 ==');
const tagBtn = findTagButton('#知识');
check('附-1 侧栏能找到 #知识 按钮', tagBtn !== null);
if (tagBtn) {
  tagBtn.trigger('click');
  check('附-2 点 #知识 只剩 2 条', visibleCount() === 2, String(visibleCount()));
  check('附-3 状态栏显示 #知识', listStatus.textContent.includes('#知识'));
  tagBtn.trigger('click');
  check('附-4 再点一次取消，恢复 3 条', visibleCount() === 3, String(visibleCount()));
}

/* ------------------------------------------------------------
   第五部分：汇总 + 写调用记录（RUNLOG.md 就是"真实调用过"的证据）
   ------------------------------------------------------------ */
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
  `- ${stamp}（node run.js）${passed}/${total} 项通过 ${passed === total ? '✅' : '❌'}：情况一有结果 / 情况二无结果 / 情况三清空恢复 / 标签点击与取消\n`);

process.exit(passed === total ? 0 : 1);
