/* ============================================================
   repository.js —— 数据访问层（Day 19 新建）
   ============================================================
   这个项目的"仓库"：只有它知道数据存在哪张表、哪个列、怎么查、怎么存。

   ★ 一条硬规矩（自检 F 层会守它）：
     全项目只有这一个文件里出现 SQL 语句（SELECT / INSERT / UPDATE / DELETE）
     和 conn.query(…) 这类"跟数据库说话"的调用。
     read.js / write.js 只调用这里的函数，自己一句 SQL 都不写。

   为什么值得单独立一层：
   1. 上层不该知道表结构。read.js 要的是"一列笔记"，不是"notes JOIN note_tags 的
      一堆行"—— 把列名（created_at）、表名（note_tags）挡在这一层里面，
      以后改表结构（比如加一列、把标签挪到单独的表）只改这里，
      校验逻辑和返回形状一行都不用动。
   2. 事务的边界要跟着 SQL 走。哪两句写必须同生共死，是由表结构决定的
      （笔记在 notes、标签在 note_tags），所以事务留在这层。
   3. 想换数据库时（比如改用 CloudBase 的官方 Node SDK），只换这一个文件。

   ---------- 谁调用它 ----------
     read.js  的 listNotes()  → findNotes()
     write.js 的 insertNote() → insertNoteWithTags()
   两个上层各自决定"什么时候调、失败了算什么错"，本层只负责"把事做到"。

   ---------- 本层不管的事（是上层的活）----------
   - 参数合法不合法（read.parseQuery / write.validateNote 管）
   - 重复提交该回 409 还是 500（write.js 管，它才知道 clientToken 的语义）
   - HTTP 长什么样（http.js 管）
   ============================================================ */

const { toDbDateTime, toIsoUtc } = require('./db');


/* ------------------------------------------------------------
   契约里的保留值：tag=none 表示"只要无标签的"
   ------------------------------------------------------------
   ★ 这里刻意**不做"URL 值 → 内部哨兵"的二次换算**：
     一开始写的是把 none 换成 __none__，自检时发现这层换算是白加的 ——
     none 在 URL 层已经是保留值，所以"真有个标签叫 none"本来就筛不到，
     多一个内部记号并不能多保护什么，只是让参数解析和 SQL 组装之间
     多一条看不见的约定（谁先谁后错了就静默筛不到，还不报错）。
     一个概念只有一个名字。
   它跟着 buildWhere 走：谁是唯一用它的人，它就住在谁旁边。
   ------------------------------------------------------------ */
const TAG_NONE = 'none';


/* ------------------------------------------------------------
   SQL 条件片段：条件按需拼，值一律走占位符 ?
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
   查：先筛笔记，再把这批笔记的**全部**标签取回来
   ------------------------------------------------------------
   为什么不合成一句 GROUP_CONCAT：
   一是分隔符没有安全的选法：标签是用户自己起的名，逗号、竖线、'#' 都可能出现；
      用控制字符当分隔符在 MySQL 里又没有可靠的写法
      （MySQL 不认 '\u001f' 这种转义 —— 上一版我就在这儿写错了，
      那串会变成字面量 u001f，把拼接结果污染掉）。
   二是 GROUP_CONCAT 有 group_concat_max_len 上限（默认 1024 字节），
      超了会被**静默截断** —— 这种错不会报，只会悄悄少标签。
   拆成两句之后，两件事都绕开了，而且"一条笔记的标签必须完整"这件事变得显然。

   ★ 关键：标签必须按"已经筛出来的那批笔记"去取，而不是跟着 WHERE 一起 JOIN ——
     否则搜「想法」命中 seed_04 时，跟着过滤走的标签只剩「想法」，
     它本来还有「代码」就丢了（PRD 要求卡片显示该笔记的全部标签）。
   ------------------------------------------------------------ */

/** 取这批笔记的标签，返回 note_id → [标签…]（按 position 排序） */
async function selectTags(conn, ids) {
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
   ★ 软删除的唯一出口（Day 22）
   ------------------------------------------------------------
   "跳过已删除的"这半句只有这一处实现，别处不许自己拼 `is_deleted = 0`。
   否则早晚会出现"某个查询忘了带这一句、已删的笔记又冒出来"——
   而且这类 bug 不报错，只会静默地多显示几条。

   为什么不真删：删除是唯一"错了就找不回来"的操作。
   打标记之后 DELETE 变成可逆的（一句 SQL 就能改回来，见 db/README.md）。
   ------------------------------------------------------------ */
function withNotDeleted(whereSql) {
  return whereSql
    ? whereSql + ' AND n.is_deleted = 0'
    : 'WHERE n.is_deleted = 0';
}

/**
 * 查一列笔记，直接返回上层要的形状：[{ id, content, tags, createdAt }]
 * query 已经过 read.parseQuery 校验（见 index.js 的顺序说明）。
 * ★ 时间在这里就转成 ISO —— 上层拿到的已经是"能直接返回给前端"的东西，
 *   不用再关心库里那一列叫 created_at、长什么样。
 */
async function findNotes(conn, query) {
  const { whereSql, params } = buildWhere(query.keyword, query.tag);

  // 第一句：先筛出要哪几条笔记（筛选条件全在这句）
  const [noteRows] = await conn.query(
    `SELECT n.id, n.content, n.created_at
       FROM notes AS n
       ${withNotDeleted(whereSql)}
      ORDER BY n.created_at DESC
      LIMIT ?`,
    params.concat([query.limit])
  );

  // 第二句：把这些笔记的全部标签取回来（见上面"为什么不合成一句"）
  const tagMap = await selectTags(conn, noteRows.map((r) => r.id));

  return noteRows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: tagMap.get(r.id) || [],
    // 时间转换也归本层：库里存的是 'YYYY-MM-DD HH:mm:ss.SSS'，
    // 上层要的是 ISO 串。转换函数在 db.js，两个方向都只有那一份实现。
    createdAt: toIsoUtc(r.created_at)
  }));
}


/* ------------------------------------------------------------
   存：笔记和标签必须一起成功、一起失败
   ------------------------------------------------------------
   用事务的原因：两步写的是两张表。如果笔记插进去了、标签插失败了，
   库里就留下一条"标签丢了"的笔记 —— 而且没有任何报错提示过这件事。
   宁可整条回滚，让用户重试。

   ★ 事务留在这一层，是因为"哪两句必须同生共死"是由表结构定的（notes + note_tags）。
     上层只调用这一个函数，不需要知道里面写了几张表。

   ★ 撞唯一键时**不在这里**决定回什么 —— 本层只管把数据库的原样错误抛上去，
     "这个错意味着重复提交、该回 409"是 write.js 的业务判断
     （它才知道 clientToken 的语义）。分层的一条经验：越靠下的层越不该替上层做决定。
   ------------------------------------------------------------ */
async function insertNoteWithTags(conn, note) {
  await conn.beginTransaction();
  try {
    await conn.query(
      `INSERT INTO notes (id, content, created_at, client_token)
       VALUES (?, ?, ?, ?)`,
      [note.id, note.content, toDbDateTime(note.createdAt), note.clientToken]
    );

    if (note.tags.length > 0) {
      // 一条标签一行，position 从 0 开始 —— 这个顺序就是前端的标签顺序
      const rows = note.tags.map((tag, position) => [note.id, tag, position]);
      await conn.query(`INSERT INTO note_tags (note_id, tag, position) VALUES ?`, [rows]);
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}


/**
 * 按 id 取一条（Day 22 新增：PATCH / DELETE 都要先认出"这条在不在"）
 * 已删除的取不到（返回 null）—— 调用方据此回 404。
 */
async function findNoteById(conn, id) {
  const [rows] = await conn.query(
    `SELECT n.id, n.content, n.created_at
       FROM notes AS n
      WHERE n.id = ? AND n.is_deleted = 0
      LIMIT 1`,
    [id]
  );
  if (rows.length === 0) return null;

  const tagMap = await selectTags(conn, [id]);
  return {
    id: rows[0].id,
    content: rows[0].content,
    tags: tagMap.get(id) || [],
    createdAt: toIsoUtc(rows[0].created_at)
  };
}


/* ------------------------------------------------------------
   改：正文 + 标签，一个事务
   ------------------------------------------------------------
   ★ 标签是**整批替换**（先删旧的后插新的），不是增量。
     理由写在 api-contract.md 第四节之二：增量要额外定义"怎么表示删一个标签"，
     每种写法都容易误用；而前端编辑时本来就是把整条重新提交。

   ★ 注意 `AND is_deleted = 0`：已删除的不许被改。
     （"这条在不在"由调用方先用 findNoteById 判，这里再兜一道 ——
       两层之间理论上有竞态，但个人工具的场景下不值得为它上锁，
       记在这里是因为**知道有，比假装没有强**。）
   ------------------------------------------------------------ */
async function applyNoteUpdate(conn, note) {
  await conn.beginTransaction();
  try {
    await conn.query(
      `UPDATE notes SET content = ? WHERE id = ? AND is_deleted = 0`,
      [note.content, note.id]
    );

    await conn.query(`DELETE FROM note_tags WHERE note_id = ?`, [note.id]);

    if (note.tags.length > 0) {
      const rows = note.tags.map((tag, position) => [note.id, tag, position]);
      await conn.query(`INSERT INTO note_tags (note_id, tag, position) VALUES ?`, [rows]);
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}


/* ------------------------------------------------------------
   删：只打标记，不真删行（Day 22）
   ------------------------------------------------------------
   ★ 不删 note_tags：标签行留着，恢复的时候整条笔记才是完整的。
     也因此 notes 上那个 ON DELETE CASCADE 外键在软删除下永远不触发 ——
     这不是遗漏，是软删除的应有之义（真删的那天才会用到它）。

   返回布尔值：true = 真的改到了一行；false = 没这条 / 已经删过了。
   ------------------------------------------------------------ */
async function markNoteDeleted(conn, note) {
  const [res] = await conn.query(
    `UPDATE notes SET is_deleted = 1, deleted_at = ? WHERE id = ? AND is_deleted = 0`,
    [toDbDateTime(note.at), note.id]
  );
  return !!(res && res.affectedRows === 1);
}


module.exports = {
  buildWhere,
  withNotDeleted,
  findNotes,
  findNoteById,
  insertNoteWithTags,
  applyNoteUpdate,
  markNoteDeleted,
  TAG_NONE
};
