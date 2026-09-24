/* ============================================================
   随手笔记 NoteLab —— 全部逻辑
   技术路线（TECH_DESIGN 第 0 节）：纯前端，不用框架，不联网

   进度：
     第 1 步 ✅ F1 写笔记、F5 本地保存
     第 2 步 ✅ F2 标签归类、F3 关键词搜索
     第 3 步 ✅ F4 随机回顾
     Day 8  ✅ 主视图四态（加载中 / 有数据 / 空 / 出错）+ 可复用卡片组件 + 演示模式
   ============================================================ */

const STORAGE_KEY = 'notelab.notes.v1';  // 存储键，见 TECH_DESIGN 第 6 节
const MAX_LENGTH = 5000;                 // 单条笔记字数上限，见 PRD 验收 1.5
const MAX_TAGS = 5;                      // 每条笔记最多标签数，见 PRD 验收 2.4
const NO_TAG = '__no_tag__';             // 「无标签」分组的内部标记（验收 2.5）

let notes = [];                 // 内存里的全部笔记（打开页面时从存储读一次）
let storageAvailable = true;    // 浏览器是否允许本地存储（验收 5.4）

// 界面状态：当前搜索词 / 当前选中的标签 / 上一次翻到的笔记
const view = {
  keyword: '',
  activeTag: null,
  lastRandomId: null      // 用来避免连着两次翻到同一条（验收 4.2）
};

/* ------------------------------------------------------------
   Day 8：页面地址参数与"页面状态"
   - 网址后加 ?demo=1        → 演示模式，用 mock-data.js 里的假数据渲染
   - 网址后加 &state=xxx     → 强制显示某种状态：loading / success / empty / error
   ------------------------------------------------------------ */
const urlParams = new URLSearchParams(location.search);
const DEMO = urlParams.get('demo') === '1';

// 四种页面状态：loading 加载中 / success 有数据 / empty 空 / error 出错
let pageState = 'success';
let pageError = '';

/* ------------------------------------------------------------
   存储读写：只有这两个函数可以碰 localStorage（TECH_DESIGN 第 7 节约束 4）
   ------------------------------------------------------------ */

function loadNotes() {
  try {
    // 先做一次写入测试：隐私模式下 setItem 会直接抛错
    localStorage.setItem('notelab.probe', '1');
    localStorage.removeItem('notelab.probe');
    storageAvailable = true;

    const raw = localStorage.getItem(STORAGE_KEY);
    notes = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(notes)) notes = [];   // 数据被改坏时兜底
  } catch (err) {
    storageAvailable = false;
    notes = [];
    console.warn('本地存储不可用，本次记录不会被保留：', err);
  }
}

function saveNotes() {
  if (!storageAvailable) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    return true;
  } catch (err) {
    console.warn('保存失败：', err);
    return false;
  }
}

/* ------------------------------------------------------------
   工具函数
   ------------------------------------------------------------ */

function makeId() {
  return 'n_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------
   F2 标签解析：从正文里拆出 #标签
   - 写法：# 开头，后面不跟空格，例如 #想法 #考研
   - 区分大小写（验收 2.7）、去掉重复、最多 5 个（验收 2.4）
   ------------------------------------------------------------ */
function parseTags(content) {
  const matched = content.match(/#[^\s#]+/g) || [];
  const cleaned = matched.map((t) => t.slice(1));          // 去掉前面的 #
  const unique = [...new Set(cleaned)];                    // 去重
  const limited = unique.slice(0, MAX_TAGS);               // 最多 5 个
  if (unique.length > MAX_TAGS) {
    showHint(`一条笔记最多 ${MAX_TAGS} 个标签，多的已经忽略`, true, 4000);
  }
  return limited;
}

// 页面元素
const el = {
  input: document.getElementById('note-input'),
  saveBtn: document.getElementById('save-btn'),
  hint: document.getElementById('input-hint'),
  counter: document.getElementById('char-count'),
  search: document.getElementById('search-input'),
  randomBtn: document.getElementById('random-btn'),
  tagList: document.getElementById('tag-list'),
  list: document.getElementById('note-list'),
  emptyState: document.getElementById('empty-state'),
  listStatus: document.getElementById('list-status'),
  noteCount: document.getElementById('note-count'),
  randomCard: document.getElementById('random-card'),
  statePanel: document.getElementById('state-panel'),     // 加载中 / 出错 两种状态
  demoBanner: document.getElementById('demo-banner')      // 演示模式提示条
};

function showHint(text, isError = false, duration = 3000) {
  el.hint.textContent = text;
  el.hint.classList.toggle('error', isError);
  if (duration > 0) {
    clearTimeout(showHint._timer);
    showHint._timer = setTimeout(() => { el.hint.textContent = ''; }, duration);
  }
}

/* ------------------------------------------------------------
   F1 写笔记：新增一条
   ------------------------------------------------------------ */
function addNote(rawText) {
  const content = rawText.trim();

  // 演示模式：数据是假的，不允许写入，避免污染真实笔记
  if (DEMO) {
    showHint('演示模式：这里不会真的保存（点提示条上的「退出演示」就能正常记）', true, 5000);
    return false;
  }

  if (!content) {                                   // 验收 1.3
    showHint('先写点什么再保存', true);
    el.input.focus();
    return false;
  }
  if (content.length > MAX_LENGTH) {                // 验收 1.5
    showHint(`一条笔记最多 ${MAX_LENGTH} 字，现在有 ${content.length} 字`, true);
    return false;
  }

  const note = {
    id: makeId(),
    content: content,
    tags: parseTags(content),                       // F2：解析标签
    createdAt: new Date().toISOString()
  };

  notes.unshift(note);                              // 新笔记放最前面（验收 1.2）

  if (!saveNotes()) {                               // 验收 5.4
    showHint('注意：浏览器不允许本地存储，这条记录关掉页面就会丢', true, 6000);
  }

  renderAll();
  el.input.value = '';                              // 验收 1.2
  updateCounter();
  el.input.focus();
  return true;
}

/* ------------------------------------------------------------
   筛选：当前要显示哪些笔记（F2 标签筛选 + F3 搜索）
   ------------------------------------------------------------ */
function getVisibleNotes() {
  const kw = view.keyword.trim().toLowerCase();

  return notes.filter((note) => {
    const tags = note.tags || [];

    // 标签筛选（验收 2.3、2.5）
    if (view.activeTag === NO_TAG) {
      if (tags.length > 0) return false;
    } else if (view.activeTag) {
      if (!tags.includes(view.activeTag)) return false;   // 标签区分大小写
    }

    // 关键词搜索：正文和标签都能命中，不区分大小写（验收 3.1、3.2）
    if (kw) {
      const inContent = note.content.toLowerCase().includes(kw);
      const inTags = tags.some((t) => t.toLowerCase().includes(kw));
      if (!inContent && !inTags) return false;
    }

    return true;
  });
}

/* ------------------------------------------------------------
   渲染：把一段文字里的关键词高亮（F3 验收 3.3）
   返回一个文档片段，不使用 innerHTML，避免注入风险
   ------------------------------------------------------------ */
function highlight(text, keyword) {
  const frag = document.createDocumentFragment();
  if (!keyword) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  let start = 0;
  let idx = lowerText.indexOf(lowerKw);
  while (idx !== -1) {
    if (idx > start) frag.appendChild(document.createTextNode(text.slice(start, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + keyword.length);
    frag.appendChild(mark);
    start = idx + keyword.length;
    idx = lowerText.indexOf(lowerKw, start);
  }
  frag.appendChild(document.createTextNode(text.slice(start)));
  return frag;
}

/* ------------------------------------------------------------
   渲染：标签侧栏（F2 验收 2.2、2.3、2.5）
   ------------------------------------------------------------ */
function renderTagList() {
  // 统计每个标签出现次数
  const counts = new Map();
  let noTagCount = 0;
  notes.forEach((note) => {
    const tags = note.tags || [];
    if (tags.length === 0) noTagCount += 1;
    tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  });

  // 按次数从多到少排序；次数相同按名称排序（验收 2.2）
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  el.tagList.innerHTML = '';

  // 「全部」入口
  const allLi = document.createElement('li');
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'tag-item' + (view.activeTag === null ? ' active' : '');
  allBtn.textContent = '全部';
  const allCount = document.createElement('span');
  allCount.className = 'count';
  allCount.textContent = notes.length;
  allBtn.appendChild(allCount);
  allBtn.addEventListener('click', () => {
    view.activeTag = null;
    renderAll();
  });
  allLi.appendChild(allBtn);
  el.tagList.appendChild(allLi);

  // 每个标签一行
  sorted.forEach(([tag, count]) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-item' + (view.activeTag === tag ? ' active' : '');
    btn.textContent = '#' + tag;
    const cnt = document.createElement('span');
    cnt.className = 'count';
    cnt.textContent = count;
    btn.appendChild(cnt);
    btn.addEventListener('click', () => {
      view.activeTag = (view.activeTag === tag) ? null : tag;   // 再点一次取消筛选（验收 2.3）
      renderAll();
    });
    li.appendChild(btn);
    el.tagList.appendChild(li);
  });

  // 「无标签」分组（验收 2.5）
  if (noTagCount > 0) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-item' + (view.activeTag === NO_TAG ? ' active' : '');
    btn.textContent = '无标签';
    const cnt = document.createElement('span');
    cnt.className = 'count';
    cnt.textContent = noTagCount;
    btn.appendChild(cnt);
    btn.addEventListener('click', () => {
      view.activeTag = (view.activeTag === NO_TAG) ? null : NO_TAG;
      renderAll();
    });
    li.appendChild(btn);
    el.tagList.appendChild(li);
  }
}

/* ------------------------------------------------------------
   可复用组件：一张笔记卡片（Day 8 加练）
   输入：一条笔记 + 当前搜索词 + 想生成的标签名（默认 li）
   输出：一个可以直接塞进页面的元素
   列表、"翻一翻"都在用它 —— 以后改卡片长相只改这一处
   ------------------------------------------------------------ */
function renderNoteCard(note, keyword = '', tagName = 'li') {
  const tags = note.tags || [];
  const card = document.createElement(tagName);
  card.className = 'note-item';

  const text = document.createElement('div');
  text.className = 'note-text';
  text.appendChild(highlight(note.content, keyword));   // 命中关键词就高亮
  card.appendChild(text);

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'note-tag';
    chip.appendChild(highlight('#' + t, keyword));
    meta.appendChild(chip);
  });
  const time = document.createElement('span');
  time.textContent = formatTime(note.createdAt);
  meta.appendChild(time);
  card.appendChild(meta);

  return card;
}

/* ------------------------------------------------------------
   渲染：笔记列表
   ------------------------------------------------------------ */
function renderNotes() {
  const kw = view.keyword.trim();
  const visible = getVisibleNotes();

  el.list.innerHTML = '';

  // 【状态一：加载中】【状态四：出错】—— 这两种状态不渲染列表，交给状态面板
  if (pageState === 'loading' || pageState === 'error') {
    el.listStatus.textContent = '';
    el.emptyState.hidden = true;
    el.noteCount.textContent = '';
    renderStatePanel();
    return;
  }

  renderStatePanel();   // 其他状态下让面板收起

  // 【状态二：有数据】把每一条交给卡片组件渲染
  visible.forEach((note) => {
    el.list.appendChild(renderNoteCard(note, kw));
  });

  // 【状态三：空】空状态（验收 3.4：搜不到要有明确提示，不能一片空白）
  if (visible.length === 0) {
    el.emptyState.hidden = false;
    if (notes.length === 0) {
      el.emptyState.textContent = DEMO
        ? '演示模式：这就是"一条笔记都还没有"时的样子（空状态）'
        : '还没有笔记。在上面写下第一条吧。';
    } else if (kw) {
      el.emptyState.textContent = `没有找到和「${kw}」相关的笔记`;
    } else {
      el.emptyState.textContent = '这个标签下还没有笔记';
    }
  } else {
    el.emptyState.hidden = true;
  }

  // 顶部状态栏
  const parts = [];
  if (kw) parts.push(`搜索「${kw}」`);
  if (view.activeTag === NO_TAG) parts.push('无标签');
  if (view.activeTag && view.activeTag !== NO_TAG) parts.push('#' + view.activeTag);
  el.listStatus.textContent = parts.length
    ? `${parts.join(' · ')}，命中 ${visible.length} 条`
    : `按时间倒序，共 ${visible.length} 条`;
  el.noteCount.textContent = notes.length > 0 ? `共 ${notes.length} 条` : '';
}

/* ------------------------------------------------------------
   状态面板：加载中显示骨架卡片，出错显示原因和一个"重试"按钮
   （出错状态一定要给用户一条出路，否则页面就死了）
   ------------------------------------------------------------ */
function renderStatePanel() {
  const panel = el.statePanel;
  panel.innerHTML = '';

  if (pageState === 'loading') {
    panel.hidden = false;
    const tip = document.createElement('div');
    tip.className = 'state-tip';
    tip.textContent = '正在取数据…';
    panel.appendChild(tip);

    // 三条灰色骨架卡片，让用户知道"内容马上就来"
    for (let i = 0; i < 3; i += 1) {
      const sk = document.createElement('div');
      sk.className = 'skeleton-card';
      const l1 = document.createElement('span');
      l1.className = 'sk-line sk-1';
      const l2 = document.createElement('span');
      l2.className = 'sk-line sk-2';
      sk.appendChild(l1);
      sk.appendChild(l2);
      panel.appendChild(sk);
    }
    return;
  }

  if (pageState === 'error') {
    panel.hidden = false;
    const box = document.createElement('div');
    box.className = 'error-box';

    const title = document.createElement('div');
    title.className = 'error-title';
    title.textContent = '没能取到笔记';

    const msg = document.createElement('div');
    msg.className = 'error-msg';
    msg.textContent = pageError || '未知错误';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.textContent = '重试';
    btn.addEventListener('click', bootstrap);

    box.appendChild(title);
    box.appendChild(msg);
    box.appendChild(btn);
    panel.appendChild(box);
    return;
  }

  panel.hidden = true;
}

function renderAll() {
  renderTagList();
  renderNotes();
}

function updateCounter() {
  el.counter.textContent = `${el.input.value.length} / ${MAX_LENGTH}`;
}

/* ------------------------------------------------------------
   F4 随机回顾：从已有笔记里随机翻出一条
   ------------------------------------------------------------ */
function pickRandomNote() {
  // 验收 4.3：笔记太少时不开抽奖，先提示
  if (notes.length < 3) {
    el.randomCard.hidden = true;
    showHint('再多记几条，翻起来才有意思', true, 3000);
    return;
  }

  // 候选：正常情况下排除上一条翻过的（验收 4.2）
  let pool = notes.filter((n) => n.id !== view.lastRandomId);
  if (pool.length === 0) pool = notes;          // 兜底：只有一条时也不报错

  const picked = pool[Math.floor(Math.random() * pool.length)];
  view.lastRandomId = picked.id;

  // 渲染回顾卡片（验收 4.1）—— 直接复用列表用的卡片组件，样式永远一致
  el.randomCard.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'random-title';
  title.textContent = '翻到一条旧笔记 · ' + formatTime(picked.createdAt);
  el.randomCard.appendChild(title);

  el.randomCard.appendChild(renderNoteCard(picked, '', 'div'));

  el.randomCard.hidden = false;
}

/* ------------------------------------------------------------
   绑定事件
   ------------------------------------------------------------ */
el.saveBtn.addEventListener('click', () => addNote(el.input.value));

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {   // 验收 1.2
    e.preventDefault();
    addNote(el.input.value);
  }
});

el.input.addEventListener('input', () => {
  if (el.input.value.length > MAX_LENGTH) {              // 验收 1.5
    el.input.value = el.input.value.slice(0, MAX_LENGTH);
    showHint(`已经到 ${MAX_LENGTH} 字上限了`, true);
  }
  updateCounter();
});

// F3 搜索：输入即筛选（验收 3.1、3.5）
el.search.addEventListener('input', () => {
  view.keyword = el.search.value;
  renderNotes();
});

// F4 翻一翻
el.randomBtn.addEventListener('click', pickRandomNote);

/* ------------------------------------------------------------
   页面状态切换（Day 8）
   ------------------------------------------------------------ */
function setPageState(next, errorMsg = '') {
  pageState = next;
  pageError = errorMsg;
  renderAll();
}

/* ------------------------------------------------------------
   启动：两种数据来源
   - 演示模式（网址带 ?demo=1）：用 mock-data.js 的假数据，可预览四种状态
   - 正常模式：用浏览器本地存储里的真实笔记（Day 7 的逻辑不变）
   ------------------------------------------------------------ */
function bootstrap() {
  updateCounter();
  el.input.focus();                                      // 验收 1.1

  if (DEMO) {
    el.demoBanner.hidden = false;
    const forced = urlParams.get('state') || 'success';

    setPageState('loading');                             // 先让用户看到"加载中"
    fetchMockNotes(forced).then((res) => {
      if (!res.ok) {
        setPageState('error', res.message);              // 出错：说明原因 + 给"重试"
        return;
      }
      notes = res.notes;
      setPageState(notes.length > 0 ? 'success' : 'empty');
    });
    return;
  }

  // 正常模式：数据在本地，同步就能取到，所以不存在"加载中"这一态
  loadNotes();
  setPageState(notes.length > 0 ? 'success' : 'empty');

  if (!storageAvailable) {
    showHint('当前浏览器不允许本地存储（可能是隐私模式），记录不会被保留', true, 0);
  }
}

bootstrap();
