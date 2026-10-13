/* ============================================================
   read.js —— GET /api/notes：取笔记列表（F5 的服务端版本）
   ============================================================
   契约见 api-contract.md 第三节。返回形状与 mock-data.js 完全一致，
   这样前端切真接口时只需要改取数那一处，页面和组件都不用动（Day 8 立下的承诺）。

   ★ Day 19 起本文件**不再有任何 SQL**：查数据库的活全交给了 repository.js。
     这里只做两件事：
       ① parseQuery —— 把 URL 上的参数理干净（纯函数，不碰数据库）
       ② listNotes  —— 决定"要查什么"，然后调用仓库
     "怎么查"（表名、列名、JOIN、排序）是仓库的事，本层不知道也不用知道。

   文件地图见 index.js 顶部。
   ============================================================ */

const { ok } = require('./http');
const repo = require('./repository');

// ---------- 契约里的常量（改这里等于改契约，改完要同步 api-contract.md）----------
const LIMIT_DEFAULT = 50;   // 不传 limit 时返回多少条
const LIMIT_MAX = 200;      // limit 上限，超了按上限算


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

  // tag：'none' 是契约里的保留值（表示"只要无标签的"），但这里**不做任何换算** ——
  //   保留值原样往下传，由仓库那一层认（原因写在 repository.js 的 TAG_NONE 注释里）
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
   取列表：本层只说"要什么"，怎么做是仓库的事
   ------------------------------------------------------------
   query 已经过 parseQuery 校验（见 index.js 的顺序说明）。
   ★ 空结果也是成功（契约第三节：空不是错误，前端有空状态视图）——
     所以这里直接 ok()，不做"查不到就报错"的判断。
   ------------------------------------------------------------ */
async function listNotes(conn, query) {
  const notes = await repo.findNotes(conn, query);
  return ok({ notes });
}

module.exports = { parseQuery, listNotes, LIMIT_DEFAULT, LIMIT_MAX };
