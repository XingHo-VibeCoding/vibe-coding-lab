/* ============================================================
   云函数：GET /api/notes —— 第 3 周的第一个"读真实数据"接口
   ============================================================
   作用：把库里（CloudBase MySQL）的笔记取出来，按契约 api-contract.md 第三节
        的形状返回，形状与 mock-data.js 完全一致 —— 这样前端切真接口时
         只需要改取数那一处，页面和组件都不用动（Day 8 立下的承诺）。

   调用方式：HTTP 访问服务（云接入）把函数映射到
        https://<环境ID>.service.tcloudbase.com/api/notes

   ★ 三件必须知道的事（都来自官方文档，不是猜的）：

   1) 必须配 VPC。
      CloudBase MySQL 只开内网地址，云函数默认不在那个内网里。
      要在「云函数 → 函数配置 → 高级配置/私有网络」里选中**数据库所在的 VPC**。
      ⚠️ 配了 VPC 之后，这个函数**默认不能访问公网**（本函数只连库，不需要公网）。
      文档：https://docs.cloudbase.net/cloud-function/resource-integration/mysql

   2) 连接信息全部走环境变量，不写进代码。
      在云函数「环境变量」里配 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME。
      ⚠️ 密码只填在控制台，不要提交到仓库、不要发在聊天里。
      文档：https://docs.cloudbase.net/cloud-function/function-configuration/env

   3) 云开发 MySQL 是 serverless 的，**连续 10 分钟没人访问会自动暂停**。
      所以"第一次请求特别慢"很可能是冷启动，不是接口写坏了。
      不想被这个影响可以在「MySQL数据库 → 数据库设置」里关掉「自动暂停」。
      文档：https://docs.cloudbase.net/database/configuration/db/tdsql/initialization
   ============================================================ */

const pkg = require('./package.json');

// ---------- 契约里的常量（改这里等于改契约，改完要同步 api-contract.md）----------
const LIMIT_DEFAULT = 50;   // 不传 limit 时返回多少条
const LIMIT_MAX = 200;      // limit 上限，超了按上限算

// 契约规定 tag=none 表示"只要无标签的"（api-contract.md 第三节）。
// ★ 这里刻意**不做"URL 值 → 内部哨兵"的二次换算**：
//   一开始写的是把 none 换成 __none__，自检时发现这层换算是白加的 ——
//   none 在 URL 层已经是保留值，所以"真有个标签叫 none"本来就筛不到，
//   多一个内部记号并不能多保护什么，只是让 parseParams 和 buildWhere
//   之间多一条看不见的约定（谁先谁后错了就静默筛不到，还不报错）。
//   一个概念只有一个名字。
const TAG_NONE = 'none';


/* ------------------------------------------------------------
   连接池：放在模块作用域，不是每次调用都新建
   云函数实例会被复用（warm），模块级变量在多次调用之间是保留的；
   每次调用都 createConnection 的话，冷启动之外还要多付一次握手成本。
   ------------------------------------------------------------ */
let pool;

function getPool() {
  if (!pool) {
    // mysql2 在这里才 require（不在文件顶部）：
    //   一来没连库的场合（比如下面的自检脚本）不需要装着它；
    //   二来它只在第一次调用时才加载，冷启动那一下的模块解析能省一点。
    const mysql = require('mysql2/promise');

    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,        // 个人工具，5 条够；调大反而容易打满数据库连接数
      queueLimit: 0,

      // 连不上时别让请求一直挂着（HTTP 访问服务有超时，挂到那时用户拿到的是网关的错页，
      // 不是我们写的 JSON 错误 —— 那样前端就分不清"服务坏了"还是"接口坏了"）
      connectTimeout: 10000,

      charset: 'utf8mb4',        // 中文标签、emoji 都靠它

      // ★ 时间取回原始字符串，不用 mysql2 自动转 Date。
      //   原因：mysql2 把 DATETIME 转成 Date 时按 **运行环境的时区** 解释，
      //   而这个解释依赖云函数容器的 TZ 设置。库里存的是 UTC，
      //   取字符串 + 自己补 'Z' 就与容器时区无关，结果是确定的。
      dateStrings: true
    });
    // 说明：官方示例里还写了 acquireTimeout / timeout 两个参数。
    //   acquireTimeout 在 mysql2 里已废弃（会被忽略），timeout 不是连接池选项
    //   （它是单条查询的选项），留着只会让人以为"我配了超时"。所以这里只用 connectTimeout。
  }
  return pool;
}


/* ------------------------------------------------------------
   响应工具：统一成契约第五节的形状
   ------------------------------------------------------------ */
function respond(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 前端是网页，早晚要跨域调这个接口（契约第六节第 1 条）。
      // 先放开：这是个人工具，本来就没有鉴权（风险记录在 PRD 第 9 节）。
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}

const ok = (payload) => respond(200, Object.assign({ ok: true }, payload));
const fail = (statusCode, message) => respond(statusCode, { ok: false, message });


/* ------------------------------------------------------------
   参数解析：只认契约里写明的三个，其余一律忽略
   ------------------------------------------------------------ */
function parseParams(qs) {
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
   时间：'2026-09-24 09:12:00.000'（库里存 UTC）→ ISO 字符串
   前端拿到的格式要和 localStorage 里既有的完全一致，否则前端一排序就乱。
   ------------------------------------------------------------ */
function toIsoUtc(value) {
  if (!value) return null;
  // dateStrings 模式下是 'YYYY-MM-DD HH:mm:ss[.SSS]'
  const s = String(value).replace(' ', 'T');
  return /Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
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
   云函数入口
   ------------------------------------------------------------ */
exports.main = async (event) => {
  const e = event || {};

  // HTTP 访问服务会把请求信息放进 event（官方文档给的结构）。
  // 只支持 GET：POST 是另一个接口（契约第四节，本期没实现）——
  // 明确回 405，比让它落到 GET 分支返回一份"看起来成功但没写入"的数据强。
  // 大写化是防御性的：值来自网关，真跑之前没法确认它一定给大写；
  // 万一给的是 'get'，不做这一步就会把一个正常的 GET 判成 405。
  const method = String(e.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET') {
    return fail(405, '本接口目前只支持 GET');
  }

  const parsed = parseParams(e.queryStringParameters);
  if (parsed.error) {
    return fail(400, parsed.error);
  }

  const { keyword, tag, limit } = parsed;
  const { whereSql, params } = buildWhere(keyword, tag);

  let conn;
  try {
    conn = await getPool().getConnection();

    // 第一句：先筛出要哪几条笔记（筛选条件全在这句）
    const [noteRows] = await conn.query(
      `SELECT n.id, n.content, n.created_at
         FROM notes AS n
         ${whereSql}
        ORDER BY n.created_at DESC
        LIMIT ?`,
      params.concat([limit])
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
  } catch (error) {
    // 真实的错误只进日志（控制台 → 云函数 → 日志），不回给前端：
    // 数据库报错里常带着主机名、库名这类信息，没必要公网可见。
    console.error('[notelab/notes] 取笔记失败', {
      version: pkg.version,
      error: error && error.message,
      code: error && error.code
    });
    // 前端展示"出错状态"时要的是一句人话 + 重试按钮（契约第五节 500）
    return fail(500, '服务器开小差了');
  } finally {
    // 只还连接，不销毁连接池：池是跨调用复用的（见 getPool 注释）
    if (conn) conn.release();
  }
};


/* ------------------------------------------------------------
   挂出几个纯函数供自检脚本使用
   ------------------------------------------------------------
   这些函数不碰数据库、不碰网络，是最容易写错、也最该被断言的部分
   （参数边界、占位符个数和参数个数是否对得上、时间格式转换）。
   挂在 exports 上，自检脚本就能直接跑**这份文件里的真代码**，
   而不是另写一套"看起来一样"的仿制品 —— 仿制品全绿但真代码有 bug 是最糟的情况。
   云函数运行时不会用到它，留着无害。
   ------------------------------------------------------------ */
exports.__test__ = { parseParams, buildWhere, toIsoUtc, TAG_NONE, LIMIT_DEFAULT, LIMIT_MAX };
