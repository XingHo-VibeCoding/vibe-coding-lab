/* ============================================================
   db.js —— 和数据库直接相关的东西：连接池 + 取值转换
   ============================================================
   只有这一个文件碰连接。分开放是为了让"怎么连库"和"业务逻辑"不要缠在一起：
   以后换连接方式（比如改用官方 Node SDK 的 app.rdb()），只改这里。

   ★ 云上部署的三个前提（照官方文档，不是猜的）：
   1) 必须在云函数上配 VPC（选 MySQL 数据库所在的私有网络），用内网地址连。
      ⚠️ 配了 VPC 之后函数**默认不能访问公网**（本函数只连库，无所谓）。
      文档：https://docs.cloudbase.net/cloud-function/resource-integration/mysql
   2) 连接信息全部走环境变量：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME。
      密码只填在控制台，不进仓库、不进聊天。
      文档：https://docs.cloudbase.net/cloud-function/function-configuration/env
   3) 云开发 MySQL 是 serverless 的，**连续 10 分钟没人访问会自动暂停** ——
      "第一次请求特别慢"很可能是冷启动，不是接口写坏了。
      文档：https://docs.cloudbase.net/database/configuration/db/tdsql/initialization
   ============================================================ */

let pool;

function getPool() {
  if (!pool) {
    // mysql2 在这里才 require（不在文件顶部）：
    //   一来没连库的场合（比如本地自检脚本）不需要装着它；
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
   时间：库里 ↔ 接口，同一个时刻的两种写法
   ------------------------------------------------------------
   库里：DATETIME(3)，一律 UTC，形如 '2026-09-24 09:12:00.000'（没有时区后缀）
   接口：ISO 字符串，形如 '2026-09-24T09:12:00.000Z'（前端 localStorage 里就是这个格式）
   ★ 两个方向的转换都放在这一个文件里 —— 只在这里转，别处不许自己拼时间字符串。
     否则早晚会出现"某处多补了一个 Z"这种只错一个字符的问题。
   ------------------------------------------------------------ */

/** 库里取出来的 → 给前端的 */
function toIsoUtc(value) {
  if (!value) return null;
  const s = String(value).replace(' ', 'T');
  return /Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
}

/** 给前端的 ISO → 写进库里的（去掉 T 和 Z，其余一模一样） */
function toDbDateTime(iso) {
  return String(iso).replace('T', ' ').replace('Z', '');
}

module.exports = { getPool, toIsoUtc, toDbDateTime };
