/* ============================================================
   read.js —— GET /api/notes：取笔记列表（F5 的服务端版本）
   ============================================================
   契约见 api-contract.md 第三节。返回形状与 mock-data.js 完全一致，
   这样前端切真接口时只需要改取数那一处，页面和组件都不用动（Day 8 立下的承诺）。

   本文件只做"读"：解析查询参数 → 组装 SQL → 取数据 → 组装返回。
   HTTP 响应形状见 http.js，连接池见 db.js。
   ============================================================ */

const { ok, fail } = require('./http');
const { toIsoUtc } = require('./db');

// ---------- 契约里的常量（改这里等于改契约，改完要同步 api-contract.md）----------
const LIMIT_DEFAULT = 50;   // 不传 limit 时返回多少条
const LIMIT_MAX = 200;      // limit 上限，超了按上限算

// 契约规定 tag=none 表示"只要无标签的"（api-contract.md 第三节）。
// ★ 这里刻意**不做"URL 值 → 内部哨兵"的二次换算**：
//   一开始写的是把 none 换成 __none__，自检时发现这层换算是白加的 ——
//   none 在 URL 层已经是保留值，所以"真有个标签叫 none"本来就筛不到，
//   多一个内部记号并不能多保护什么，只是让参数解析和 SQL 组装之间
//   多一条看不见的约定（谁先谁后错了就静默筛不到，还不报错）。
//   一个概念只有一个名字。
const TAG_NONE = 'none';


/* ------------------------------------------------------------
   查询参数：只认契约里写明的三个，其余一律忽略
   ------------------------------------------------------------ */
function parseQuery(qs) {
  const raw = qs || {};

  // keyword：空字符串当没传（前端清空搜索框时会传空串，不该因此搜不到任何东西）
  const keyword =
    typeof raw.keyword === 'string' && raw.keyword.trim() !== ''
      ? raw.keyword.trim()
      : null;

  // tag：'none' 是契约里的保留值，表示"只要无标签的"；其余按标签名原样使用
  let tag = null;
  if (typeof raw.tag === 'string' && raw.tag.trim() !== '') {
    tag = raw.tag.trim();
  }

  // limit：不传用默认；传了必须是正整数；超上限按上限算
  let limit = LIMIT_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== '') {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: 'limit 必须是正整数（不传则默认 ' + LIMIT_DEFAULT + ' 条）' };
    }
    limit = Math.min(n, LIMIT_MAX);
  }

  return { keyword, tag, limit };
}


/* ------------------------------------------------------------
   SQL：条件按需拼，值一律走占位符 ?
   为什么不把值直接拼进 SQL 字符串：那是最经典的注入漏洞写法。
   这里拼进 SQL 的只有固定的条件片段，用户给的值全部是参数。
   ------------------------------------------------------------ */
function buildWhere(keyword, tag) {
  const conditions = [];
  const params = [];

  if (keyword !== null) {
    // 正文和标签都参与匹配（PRD 3.1、3.2）
    // ★ 标签那一半必须手写 COLLATE utf8mb4_unicode_ci：
    //   note_tags.tag 列为了"标签区分大小写"用的是 utf8mb4_bin，
    //   直接 LIKE 会变成区分大小写，与 PRD 3.2「搜索不区分大小写」冲突。
    //   这里只在**这次比较**上套 _ci，列本身不动（精确筛选标签时仍区分大小写）。
    conditions.push(
      `(n.content LIKE CONCAT('%', ?, '%')
        OR EXISTS (
             SELECT 1 FROM note_tags AS z
             WHERE z.note_id = n.id
               AND z.tag COLLATE utf8mb4_unicode_ci LIKE CONCAT('%', ?, '%')
           ))`
    );
    params.push(keyword, keyword);
  }

  if (tag !== null) {
    if (tag === TAG_NONE) {
      // 无标签：只要"一条标签行都没有"的笔记（PRD 2.5）
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM note_tags AS x WHERE x.note_id = n.id)`
      );
    } else {
      // 精确筛选标签：这里**故意不套 _ci**，标签区分大小写（PRD 2.3）
      conditions.push(
        `EXISTS (
           SELECT 1 FROM note_tags AS y
           WHERE y.note_id = n.id AND y.tag = ?
         )`
      );
      params.push(tag);
    }
  }

  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { whereSql, params };
}


/* ------------------------------------------------------------
   取标签：为什么不跟上面合成一句 GROUP_CONCAT
   ------------------------------------------------------------
   一是分隔符没有安全的选法：标签是用户自己起的名，逗号、竖线、'#' 都可能出现；
      用控制字符当分隔符在 MySQL 里又没有可靠的写法
      （MySQL 不认 '\u001f' 这种转义 —— 上一个版本我就在这儿写错了，
      那串会变成字面量 u001f，把拼接结果污染掉）。
   二是 GROUP_CONCAT 有 group_concat_max_len 上限（默认 1024 字节），
      超了会被**静默截断** —— 这种错不会报，只会悄悄少标签。
   拆成两句之后，两件事都绕开了，而且"一条笔记的标签必须完整"这件事变得显然。

   ★ 顺序要点：必须按 note_id, position 排 —— position 就是为"标签顺序"存在的。
   ------------------------------------------------------------ */
async function fetchTags(conn, ids) {
  const byNote = new Map();
  if (ids.length === 0) return byNote;

  // 注意用 conn.query 而不是 conn.execute：
  // query 会把数组参数展开成 (?, ?, ?)，execute 不会（execute 走预编译协议，只收标量）
  const [rows] = await conn.query(
    `SELECT note_id, tag
       FROM note_tags
      WHERE note_id IN (?)
      ORDER BY note_id, position`,
    [ids]
  );

  for (const row of rows) {
    if (!byNote.has(row.note_id)) byNote.set(row.note_id, []);
    byNote.get(row.note_id).push(row.tag);
  }
  return byNote;
}


/* ------------------------------------------------------------
   取列表。query 已经过 parseQuery 校验（见 index.js 的顺序说明）
   ------------------------------------------------------------ */
async function listNotes(conn, query) {
  const { whereSql, params } = buildWhere(query.keyword, query.tag);

  // 第一句：先筛出要哪几条笔记（筛选条件全在这句）
  const [noteRows] = await conn.query(
    `SELECT n.id, n.content, n.created_at
       FROM notes AS n
       ${whereSql}
      ORDER BY n.created_at DESC
      LIMIT ?`,
    params.concat([query.limit])
  );

  // 第二句：把这些笔记的**全部**标签取回来。
  // 关键：标签必须按"已经筛出来的那批笔记"去取，而不是跟着 WHERE 一起 JOIN ——
  // 否则搜「想法」命中 seed_04 时，跟着过滤走的标签只剩「想法」，
  // 它本来还有「代码」就丢了（PRD 要求卡片显示该笔记的全部标签）。
  const tagMap = await fetchTags(conn, noteRows.map((r) => r.id));

  const notes = noteRows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: tagMap.get(r.id) || [],
    createdAt: toIsoUtc(r.created_at)
  }));

  // 空结果也是成功（契约第三节：空不是错误，前端有空状态视图）
  return ok({ notes });
}

module.exports = { parseQuery, buildWhere, fetchTags, listNotes, TAG_NONE, LIMIT_DEFAULT, LIMIT_MAX };
