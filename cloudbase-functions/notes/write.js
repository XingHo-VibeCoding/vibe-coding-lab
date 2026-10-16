/* ============================================================
   write.js —— POST /api/notes：新建一条笔记（F1 的服务端版本）
   ============================================================
   契约见 api-contract.md 第四节。

   ★ Day 19 起本文件**不再有任何 SQL**：写数据库的活全交给了 repository.js。
     这里只做三件事：
       ① parseBody / validateNote —— 来料检查（纯函数，不碰数据库）
       ② newId / isDuplicateToken —— 两个小判断
       ③ insertNote —— 决定"什么时候写、失败了算什么错"，然后调用仓库

   ★ Day 18 那件事（**防"同一次提交被发了两遍"**）还在，只是执行方式换了：
     点了两次提交按钮、或者网络超时后前端自动重试，都不该在库里留下两条一样的笔记。

     做法是幂等键 `clientToken` + 数据库唯一索引（唯一索引在 db/schema.sql）：
       - 前端每次"打开写笔记页"生成一个 token，**重试时复用同一个**
       - 服务端把 token 连同笔记一起写进 notes.client_token（有 UNIQUE）
       - 同一个 token 第二次插入会被数据库拒绝 → 本文件把它翻成 409

     ★ 为什么**不**写成"插入前先 SELECT 查一遍 token 在不在"：
       那样有竞态 —— 两个请求可能同时查到"不存在"，然后双双插进去。
       唯一索引是数据库层面的一次裁决，并发也挡得住。
       所以下面的代码里**故意没有那句预查**，这是设计，不是漏写。

     ★ 为什么"撞了唯一键"这个判断留在本文件、不放进仓库：
       数据库只知道"有个唯一键冲突了"，它不知道那意味着"用户在重复提交"。
       把 1062 翻译成"重复提交、回 409、提示改一个字"是业务判断。
       仓库层只管把原样错误抛上来（见 repository.js 的说明）。

     ⚠️ 这个防法的边界（别把话说满）：
       它防不了"前端每次都生成新 token"。复用 token 是前端的责任。
       它也**不**试图判断"内容是不是重复"—— 两分钟后写一条一模一样的笔记是合法的，
       用"内容 + 时间窗"去猜会把正常操作误判成重复，而误判比漏判更难解释。
   ============================================================ */

const crypto = require('node:crypto');

const { ok, fail } = require('./http');
const repo = require('./repository');

// ---------- 与前端对齐的上限（改这里要一起改 app.js 的 MAX_LENGTH / MAX_TAGS）----------
const MAX_LENGTH = 5000;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 50;   // 对应 note_tags.tag 的 VARCHAR(50)

// ---------- clientToken 的格式要求 ----------
const TOKEN_MIN = 8;
const TOKEN_MAX = 64;        // 对应 notes.client_token 的 VARCHAR(64)
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

// 409 的文案：**前端"出错状态"会原样显示它**，所以写得像界面上的话，别写成调试信息
const DUPLICATE_MESSAGE =
  '这一条刚刚已经提交过了（重复提交已拦下）。如果是想要的新笔记，改一个字再提交。';


/* ------------------------------------------------------------
   请求体：拿到一个对象
   ------------------------------------------------------------
   HTTP 访问服务给的 event.body 是**字符串**（官方文档写明）。
   但控制台"测试云函数"里手填事件时，人往往会直接把 JSON 写成对象 ——
   所以两种都收。少了这一条，用调试工具排查时会先撞一个"请求体不是合法 JSON"，
   白白浪费一轮。
   ------------------------------------------------------------ */
function parseBody(event) {
  const e = event || {};
  let raw = e.body;

  // base64 编码的请求体（网关在某些情况下会这么传）
  if (e.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }

  if (raw === undefined || raw === null || raw === '') {
    return { error: '请求体是空的，需要 content 和 clientToken' };
  }

  if (typeof raw === 'object') {
    if (Array.isArray(raw)) return { error: '请求体必须是一个 JSON 对象（不能是数组）' };
    return { body: raw };
  }

  if (typeof raw !== 'string') {
    return { error: '请求体格式不对（应该是 JSON 字符串）' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: '请求体不是合法的 JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '请求体必须是一个 JSON 对象（不能是数组）' };
  }
  return { body: parsed };
}


/* ------------------------------------------------------------
   校验：一次只回一条错误
   ------------------------------------------------------------
   为什么一次只回一条，而不是把所有问题列一遍：
   这些 message 是给用户看的（前端出错状态原样显示）。
   甩五条出来，用户不知道该先改哪个；一条一条来，改完再说下一个。
   ------------------------------------------------------------ */
function validateNote(body) {
  const b = body || {};

  // ---------- content（必填）----------
  if (b.content === undefined || b.content === null) {
    return { error: '缺少 content（笔记正文是必填的）' };
  }
  if (typeof b.content !== 'string') {
    return { error: 'content 必须是字符串（现在收到的是 ' + typeof b.content + '）' };
  }
  const content = b.content.trim();
  if (content === '') {
    return { error: 'content 不能为空（只有空白的正文也不行）' };
  }
  if (content.length > MAX_LENGTH) {
    return { error: 'content 最多 ' + MAX_LENGTH + ' 字，当前 ' + content.length + ' 字' };
  }

  // ---------- clientToken（必填，Day 18 新增）----------
  if (b.clientToken === undefined || b.clientToken === null) {
    return { error: '缺少 clientToken（同一次提交重试时要复用它，用它拦重复提交）' };
  }
  if (typeof b.clientToken !== 'string') {
    return { error: 'clientToken 必须是字符串' };
  }
  const clientToken = b.clientToken.trim();
  if (clientToken.length < TOKEN_MIN || clientToken.length > TOKEN_MAX) {
    return {
      error: 'clientToken 长度要在 ' + TOKEN_MIN + '~' + TOKEN_MAX + ' 之间（当前 ' + clientToken.length + '）'
    };
  }
  if (!TOKEN_PATTERN.test(clientToken)) {
    return { error: 'clientToken 只能包含字母、数字、下划线、短横线' };
  }

  // ---------- tags（可选，但要兜底）----------
  const normalized = normalizeTags(b.tags);
  if (normalized.error) return { error: normalized.error };

  return { value: { content, clientToken, tags: normalized.tags } };
}


/* ------------------------------------------------------------
   标签的兜底规则（Day 22 从 validateNote 里抽出来，因为 PATCH 也要用同一套）
   ------------------------------------------------------------
   前端已经用 parseTags() 处理过一遍，服务端再做一遍不是重复劳动：
   PRD 里写的是"前端拦不住的后端还要拦"—— 接口是公开的，不只有我们的前端会调它。

   ★ 抽成一处是为了让 POST 和 PATCH 对"什么算合法标签"的判断**完全一致**。
     各写一份的话，早晚会出现"新建时 6 个标签被截成 5 个、编辑时却报 400"这种怪事。
   ------------------------------------------------------------ */
function normalizeTags(rawTags) {
  let raw = rawTags;
  if (raw === undefined || raw === null) raw = [];
  if (!Array.isArray(raw)) {
    return { error: 'tags 必须是字符串数组（比如 ["工作","想法"]）' };
  }

  const tags = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { error: 'tags 里的每一项都必须是字符串' };
    }
    const tag = item.trim();
    if (tag === '') continue;                       // 空白项直接丢掉（前端也这么干）
    if (tag.length > MAX_TAG_LENGTH) {
      return { error: '单个标签最多 ' + MAX_TAG_LENGTH + ' 字（"' + tag.slice(0, 10) + '…" 超了）' };
    }
    if (tags.indexOf(tag) === -1) tags.push(tag);   // 同一张笔记里重复的标签只留第一个
  }
  if (tags.length > MAX_TAGS) {
    tags.length = MAX_TAGS;                        // 超了只取前 5 个（与前端 MAX_TAGS 一致）
  }
  return { tags };
}


/* ------------------------------------------------------------
   笔记 ID：沿用前端既有的字符串格式 n_...
   不用自增：老数据（localStorage 里的 n_1727...）可以直接平移过来。
   ------------------------------------------------------------ */
function newId() {
  const t = Date.now().toString(36);                 // ~9 位，按时间递增，排序友好
  const r = crypto.randomBytes(4).toString('hex');   // 8 位随机，同一毫秒内也不会撞
  return 'n_' + t + '_' + r;                         // 总长 20，VARCHAR(32) 装得下
}


/* ------------------------------------------------------------
   是不是"这个 token 已经用过了"
   ------------------------------------------------------------
   MySQL 的唯一键冲突错误码是 1062，mysql2 把它报成 code = 'ER_DUP_ENTRY'。
   两个都看一遍：不同驱动/版本给的字段不完全一样，只认一个容易漏。
   ------------------------------------------------------------ */
function isDuplicateToken(error) {
  if (!error) return false;
  return error.code === 'ER_DUP_ENTRY' || error.errno === 1062;
}


/* ------------------------------------------------------------
   写入：本层只负责"组装一条笔记 → 交给仓库 → 翻译结果"
   ------------------------------------------------------------
   ★ 事务已经挪到 repository.insertNoteWithTags 里（"哪两句必须同生共死"
     是由表结构定的，属于数据访问层的事）。
     本层拿到的结果是两种：成功，或者一个从仓库抛上来的原样错误 ——
     它再把"唯一键冲突"翻译成 409。

   ★ 日志（Day 18 余力加练）留在这里，不留进仓库：
     仓库只懂"数据"，不懂"这是哪个接口在处理、花了多久、该不该记"。
   ------------------------------------------------------------ */
async function insertNote(conn, value) {
  const { content, clientToken, tags } = value;
  const startedAt = Date.now();

  // 同一个时刻，两种写法：库里要 'YYYY-MM-DD HH:mm:ss.SSS'，返回给前端要 ISO。
  // 一次算出来，避免出现"返回的时间和存进去的时间差一点"。
  // （转成库里的格式是仓库的事，它拿到 ISO 自己转 —— 见 repository.js）
  const iso = new Date().toISOString();
  const id = newId();

  try {
    await repo.insertNoteWithTags(conn, { id, content, createdAt: iso, clientToken, tags });
  } catch (error) {
    if (isDuplicateToken(error)) {
      // 走到这里说明"这个 token 已经写过了" —— 这就是核心保护生效了。
      // 注意：截住它靠的是唯一索引，不是预查（见文件头的说明）。
      // 理论上 id 主键撞车也会报 1062，概率约 40 亿分之一，不值得为它单独加分支，
      // 但写在注释里，免得以后看到这行以为不可能。
      console.log('[notelab/notes] 拦下一次重复提交', {
        id,
        clientToken,
        tags: tags.length
      });
      return fail(409, DUPLICATE_MESSAGE);
    }

    throw error;   // 交给 index.js 统一回 500，并记真实错误
  }

  // ---------- 服务端日志 ----------
  // 记进日志的东西要能回答"这条写进来了没有、花了多久"。
  // ★ 故意**不记 content**：笔记正文是用户自己的内容，
  //   日志的可见范围比数据库宽，没必要把用户写的东西搬进去。
  //   要排查内容相关的问题，用返回的 id 去库里查。
  console.log('[notelab/notes] 写入成功', {
    id,
    clientToken,
    tags: tags.length,
    ms: Date.now() - startedAt
  });

  return ok({
    note: { id, content, tags, createdAt: iso }
  });
}

/* ============================================================
   以下两个是 Day 22 新增：PATCH（改）与 DELETE（删）
   ============================================================
   ★ 为什么它们比 POST 更该小心（今天要掌握的那件事）：
     POST 错了是"多一条"，删掉就行；DELETE 错了是"少一条"，而少掉的找不回来。
     所以删除这里加了三层确认，从下往上：
       ① 数据层：软删除 —— 只打标记不真删，删错能用一句 SQL 改回来（真正的后悔药）
       ② 接口层：必须显式给 id，缺了 400、查不到 404，**绝不静默成功**；不做批量删除
       ③ UI 层：未实现（撤销窗口属 CANDIDATES.md 的 C2，未批准就不开工）
   ============================================================ */

// 这两句都会被前端"出错状态"原样显示，所以写成人话
const NOT_FOUND_MESSAGE = '这条笔记不存在（可能已经被删掉了）';
const MISSING_ID_MESSAGE = '缺少 id（要删哪一条笔记？用 ?id= 指名）';

/** PATCH 要的是"改哪条"，id 可以来自查询参数，也可以来自请求体 */
function pickId(queryParams, body) {
  const fromQuery = queryParams && queryParams.id;
  if (typeof fromQuery === 'string' && fromQuery.trim() !== '') return fromQuery.trim();

  const fromBody = body && body.id;
  if (typeof fromBody === 'string' && fromBody.trim() !== '') return fromBody.trim();

  return null;
}


/* ------------------------------------------------------------
   PATCH 的校验：与 POST 的两处不同
   ------------------------------------------------------------
   1) 没有 clientToken —— 幂等键是防"重复新建"的，改一条已有的笔记
      本来就是可重复的操作（内容一样改两次，结果一样），不需要它
   2) content 和 tags **都可以不给**，但不能两个都不给：
      什么都不改却回 200，就是"看起来成功但什么都没做"
   ------------------------------------------------------------ */
function validatePatch(queryParams, body) {
  const b = body || {};

  const id = pickId(queryParams, b);
  if (id === null) {
    return { error: '缺少 id（要改哪一条笔记？用 ?id= 指名）' };
  }

  const hasContent = b.content !== undefined && b.content !== null;
  const hasTags = b.tags !== undefined && b.tags !== null;
  if (!hasContent && !hasTags) {
    return { error: 'content 和 tags 至少要给一个（不然这次改动什么都不会变）' };
  }

  const value = { id, content: undefined, tags: undefined };

  if (hasContent) {
    if (typeof b.content !== 'string') {
      return { error: 'content 必须是字符串（现在收到的是 ' + typeof b.content + '）' };
    }
    const content = b.content.trim();
    if (content === '') {
      return { error: 'content 不能为空（只有空白的正文也不行）' };
    }
    if (content.length > MAX_LENGTH) {
      return { error: 'content 最多 ' + MAX_LENGTH + ' 字，当前 ' + content.length + ' 字' };
    }
    value.content = content;
  }

  if (hasTags) {
    const normalized = normalizeTags(b.tags);
    if (normalized.error) return { error: normalized.error };
    value.tags = normalized.tags;
  }

  return { value };
}


/* ------------------------------------------------------------
   改一条：先认出"这条在不在"，再改
   ------------------------------------------------------------
   ★ 先 SELECT 再 UPDATE 的顺序在这里是**有意的**，和 POST 那里相反：
     - POST 用唯一索引兜底，因为"先查再插"有竞态（会插重）
     - PATCH 这里的后果轻得多：竞态只可能导致"改了一条刚被删掉的"
       （而软删除让这条还在库里，可恢复）。换来的是**能给出准确的 404**，
       以及"没改到的字段保持原样"这件事变得简单可靠。
     - 另外一个实际原因：UPDATE 的 affectedRows 在 MySQL 里是"**发生变化的行数**"，
       把 content 改成和原来一样会返回 0 —— 拿它判存在性会误报 404。
   ------------------------------------------------------------ */
async function updateNote(conn, value) {
  const existing = await repo.findNoteById(conn, value.id);
  if (!existing) return fail(404, NOT_FOUND_MESSAGE);

  // 只覆盖"这次给了的"字段，没给的保持原样 —— 这才是 PATCH
  const content = value.content === undefined ? existing.content : value.content;
  const tags = value.tags === undefined ? existing.tags : value.tags;

  await repo.applyNoteUpdate(conn, { id: value.id, content: content, tags: tags });

  console.log('[notelab/notes] 改了一条', {
    id: value.id,
    changedContent: value.content !== undefined,
    changedTags: value.tags !== undefined,
    tags: tags.length
  });

  // createdAt 用原来的：**创建时间不该因为编辑而改变**
  return ok({
    note: {
      id: existing.id,
      content: content,
      tags: tags,
      createdAt: existing.createdAt
    }
  });
}


/* ------------------------------------------------------------
   删一条：软删除
   ------------------------------------------------------------
   返回里带 `at`（删除时刻），是为了让日志和界面都能回答"什么时候删的"。
   ★ 行还在库里 —— 这是故意的，也是"删错了还能找回"的全部依靠。
   ------------------------------------------------------------ */
async function deleteNote(conn, id) {
  const existing = await repo.findNoteById(conn, id);
  if (!existing) return fail(404, NOT_FOUND_MESSAGE);

  const at = new Date().toISOString();
  await repo.markNoteDeleted(conn, { id: id, at: at });

  console.log('[notelab/notes] 删了一条（软删除，行还在库里）', { id: id });

  return ok({ deleted: { id: id, at: at } });
}


module.exports = {
  parseBody,
  validateNote,
  insertNote,
  newId,
  isDuplicateToken,
  validatePatch,
  updateNote,
  deleteNote,
  pickId,
  normalizeTags,
  NOT_FOUND_MESSAGE,
  MISSING_ID_MESSAGE,
  MAX_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  TOKEN_MIN,
  TOKEN_MAX,
  DUPLICATE_MESSAGE
};
