/* ============================================================
   云函数：/api/notes —— 笔记的读与写
   ============================================================
   这个函数同时处理两个接口：
     GET  /api/notes   取列表（契约第三节）
     POST /api/notes   新建一条（契约第四节）
   为什么挤在一个函数里：HTTP 访问服务是**一个路径绑一个函数**，
   而这两个接口的路径完全相同 —— 想分开也分不了。
   （这也是两个接口的字段名必须互相协调的原因。）

   调用地址（部署后）：
     https://<环境ID>.service.tcloudbase.com/api/notes

   ---------- 文件地图（Day 19 起）----------
     index.js       本文件：只做"分发 + 兜底"，业务逻辑不写这里
     http.js        响应的形状（成功/失败/预检长什么样，只定义一次）
     db.js          连接池 + 时间格式转换（只在这里建连接池）
     repository.js  数据访问层（Day 19 新建）：**唯一**出现 SQL 与 conn.query 的文件
     read.js        GET  的业务逻辑：解析参数 → 交给仓库
     write.js       写操作的业务逻辑：POST 校验 + 409；PATCH 改一条；DELETE 软删除
   ---------- 为什么这么拆 ----------
   拆文件的直接原因是 README 约束 5（单个文件超过 500 行就拆开）。
   但拆的**依据**是职责，不是行数：
     - "读"和"写"分开：它们的校验、错误码、失败后果都不一样
     - "数据怎么存取"再单独一层（repository.js）：上层不该知道表名和列名，
       以后换数据库、或者改表结构（加列、把标签挪走），只动那一处。
       自检 F 层会守住"SQL 不许漏回上层"这条规矩。
   ---------- 请求从哪进、到哪出 ----------
     event → index.js 分发 → （校验）→ 取连接 → read/write 调 repository
           → repository 执行 SQL → write/read 组装结果 → http.js 包成响应

   ---------- 部署的三个前提 ----------
   见 db.js 文件头（VPC / 环境变量 / 自动暂停），那三条都在那一处写明了。
   ============================================================ */

const pkg = require('./package.json');

const { ok, fail, preflight, toResponse } = require('./http');
const { getPool, toIsoUtc, toDbDateTime } = require('./db');
const repo = require('./repository');
const read = require('./read');
const write = require('./write');


/* ------------------------------------------------------------
   入口
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   请求日志（Day 23 余力加练）
   ------------------------------------------------------------
   只记四样：**什么时候、哪个方法、哪条路径、结果是什么**（外加花了多久）。
   为什么是这四样：排查"接口是不是挂了"时，你要回答的其实就是
   "刚才那一下到底有没有进来、进来之后是成功还是失败"。
   多了没用还占日志额度；少了就只能靠猜。

   ★ **不记**请求体和正文（和 write.js 里那条日志同一个规矩）：
     笔记内容是用户自己的东西，日志的可见范围比数据库宽。

   ★ 用一行 console.log 而不是"日志框架"：
     今天明确不做复杂异常处理框架。云函数的日志在控制台里能直接看、能检索，
     一行就够了 —— 等真出现"查不动"的那天再说。
   ------------------------------------------------------------ */
function logRequest(startedAt, method, path, status) {
  console.log('[notelab/notes] 请求', {
    at: new Date().toISOString(),
    method,
    path,
    status,
    ms: Date.now() - startedAt
  });
}

/** 真正的处理逻辑（入口 main 只负责"计时 + 记一行"） */
async function handle(event, method) {
  const e = event || {};

  // 浏览器的"预检"（JSON 格式的 POST 之前，浏览器会先问一句"我能发吗"）。
  // 不答它，前端将来的 POST 会在浏览器控制台报跨域错 —— 而且报的错
  // 看起来像"接口挂了"，实际是预检没答。所以单独接住它。
  if (method === 'OPTIONS') {
    return toResponse(preflight());
  }

  // Day 22 起支持四个方法。PUT 仍然不支持（PUT 语义是"整体替换"，
  // 我们只要"改其中几个字段"= PATCH，多一个 PUT 只会多一种误用）。
  // 明确回 405，比让它落进某个分支、返回一份"看起来成功但没做任何事"的数据强。
  const SUPPORTED = ['GET', 'POST', 'PATCH', 'DELETE'];
  if (SUPPORTED.indexOf(method) === -1) {
    return toResponse(fail(405, `本接口不支持 ${method}（只支持 GET、POST、PATCH、DELETE）`));
  }

  /* -------- 第一步：先把请求校验干净（纯函数，不碰数据库）--------
     ★ 顺序很要紧：校验放在"取连接"之前。
       一是请求不合法就不该占着连接池里的连接；
       二是这条顺序让本地自检脚本**在没装 mysql2、也没有数据库**的情况下
         能把全部 400 分支跑一遍（校验不过就直接返回了，走不到连库那一步）。
       改这个顺序会静默地毁掉本地那批断言 —— 自检脚本里有一条专门守它。 */
  let job;
  if (method === 'GET') {
    const query = read.parseQuery(e.queryStringParameters);
    if (query.error) return toResponse(fail(400, query.error));
    job = (conn) => read.listNotes(conn, query);

  } else if (method === 'POST') {
    const body = write.parseBody(e);
    if (body.error) return toResponse(fail(400, body.error));
    const checked = write.validateNote(body.body);
    if (checked.error) return toResponse(fail(400, checked.error));
    job = (conn) => write.insertNote(conn, checked.value);

  } else if (method === 'PATCH') {
    // PATCH 必须有请求体（要改什么），所以没有就 400
    const body = write.parseBody(e);
    if (body.error) return toResponse(fail(400, body.error));
    const checked = write.validatePatch(e.queryStringParameters, body.body);
    if (checked.error) return toResponse(fail(400, checked.error));
    job = (conn) => write.updateNote(conn, checked.value);

  } else {
    // DELETE：请求体可有可无（很多客户端发 DELETE 时不带 body），
    // 所以 id 主要看查询参数，取不到再看 body。
    const body = write.parseBody(e);
    const rawBody = body.error ? {} : body.body;
    const id = write.pickId(e.queryStringParameters, rawBody);
    if (id === null) return toResponse(fail(400, write.MISSING_ID_MESSAGE));
    job = (conn) => write.deleteNote(conn, id);
  }

  /* -------- 第二步：才去连库执行 -------- */
  let conn;
  try {
    conn = await getPool().getConnection();
    return toResponse(await job(conn));
  } catch (error) {
    // 真实的错误只进日志（控制台 → 云函数 → 日志），不回给前端：
    // 数据库报错里常带着主机名、库名这类信息，没必要公网可见。
    console.error('[notelab/notes] 处理失败', {
      version: pkg.version,
      method,
      error: error && error.message,
      code: error && error.code
    });
    // 前端展示"出错状态"时要的是一句人话 + 重试按钮（契约第五节 500）
    // ★ Day 23：这句文案与前端 errors.js 的 server.withStatus(500) 是**同一类错误的两个说法**，
    //   改任何一边都要看一眼另一边，别让用户在同一件事上读到两种解释。
    return toResponse(fail(500, '服务器开小差了'));
  } finally {
    // 只还连接，不销毁连接池：池是跨调用复用的（见 db.js 的 getPool 注释）
    if (conn) conn.release();
  }
}


/* ------------------------------------------------------------
   入口：只做"认出这是什么请求 + 计时 + 记一行日志"
   ------------------------------------------------------------
   ★ 为什么把 main 拆薄、把逻辑放进 handle：
     记日志这件事要**包住整个请求**，不管成功失败都得记一行 ——
     混在业务逻辑里的话，每个 return 分支前面都得记得写一遍，
     漏一个分支就变成"失败的请求没有日志"，而那恰恰是最需要日志的时候。
   ------------------------------------------------------------ */
exports.main = async (event) => {
  const startedAt = Date.now();
  const e = event || {};

  // HTTP 访问服务会把请求信息放进 event（官方文档给的结构）。
  // 大写化是防御性的：值来自网关，真跑之前没法确认它一定给大写；
  // 万一给的是 'get'，不做这一步就会把一个正常的 GET 判成 405。
  const method = String(e.httpMethod || 'GET').toUpperCase();
  const path = e.path || '/api/notes';   // 网关不一定给，给不出就当默认路径

  let res;
  try {
    res = await handle(e, method);
  } catch (error) {
    // handle 内部已经兜住"连库失败"这类；走到这儿说明是没预料到的错误。
    // 这里只回一句人话，真实原因记在下面那行 error 里。
    console.error('[notelab/notes] 入口没兜住的错误', { error: error && error.message });
    res = toResponse(fail(500, '服务器开小差了'));
  }

  logRequest(startedAt, method, path, res.statusCode);
  return res;
};


/* ------------------------------------------------------------
   挂出纯函数供自检脚本使用
   ------------------------------------------------------------
   这些函数不碰数据库、不碰网络，是最容易写错、也最该被断言的部分
   （参数边界、占位符个数和参数个数是否对得上、时间格式、中文提示语）。
   挂在这里，自检脚本就能直接跑**这份代码里的真函数**，
   而不是另写一套"看起来一样"的仿制品 —— 仿制品全绿但真代码有 bug 是最糟的情况。
   云函数运行时不会用到它，留着无害。
   ------------------------------------------------------------ */
exports.__test__ = {
  // 读（参数解析在 read.js，SQL 组装在 repository.js —— Day 19 挪的）
  parseQuery: read.parseQuery,
  buildWhere: repo.buildWhere,
  withNotDeleted: repo.withNotDeleted,
  TAG_NONE: repo.TAG_NONE,
  LIMIT_DEFAULT: read.LIMIT_DEFAULT,
  LIMIT_MAX: read.LIMIT_MAX,
  // 写
  parseBody: write.parseBody,
  validateNote: write.validateNote,
  insertNote: write.insertNote,
  newId: write.newId,
  isDuplicateToken: write.isDuplicateToken,
  MAX_LENGTH: write.MAX_LENGTH,
  MAX_TAGS: write.MAX_TAGS,
  MAX_TAG_LENGTH: write.MAX_TAG_LENGTH,
  TOKEN_MIN: write.TOKEN_MIN,
  TOKEN_MAX: write.TOKEN_MAX,
  DUPLICATE_MESSAGE: write.DUPLICATE_MESSAGE,
  // 改 / 删（Day 22）
  validatePatch: write.validatePatch,
  updateNote: write.updateNote,
  deleteNote: write.deleteNote,
  pickId: write.pickId,
  normalizeTags: write.normalizeTags,
  NOT_FOUND_MESSAGE: write.NOT_FOUND_MESSAGE,
  MISSING_ID_MESSAGE: write.MISSING_ID_MESSAGE,
  // 时间
  toIsoUtc,
  toDbDateTime,
  // 顺手把没直接用到但同属"响应形状"的 ok/fail 露出来，方便断言信封
  ok,
  fail
};
