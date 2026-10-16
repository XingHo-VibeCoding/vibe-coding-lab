/* ============================================================
   http.js —— 响应的形状（只在这里定义一次）
   ============================================================
   为什么单独一个文件：GET 和 POST 是两个接口，但"成功长什么样、失败长什么样"
   只能有一套。各写各的，早晚会出现"这个接口返回 ok:true、那个返回 success:true"。

   形状的依据是 api-contract.md 第一节和第五节。

   ⚠️ 这里有个**只能在云上验证**的不确定点（写在文件里免得忘）：
   官方文档里"返回响应"出现过两种写法 —— 直接 return 一个普通对象，
   或 return { statusCode, headers, body }。我们用的是后者（因为失败时要能控制状态码）。
   如果部署后发现前端拿到的是 {"statusCode":200,"body":"{\"ok\":true...}"} 这种
   套了一层的形状，说明这台网关不吃结构化返回 —— 改法：把 toResponse 改成
   直接返回 payload（一行的事），改完两个接口一起生效（所以它放在这个共享文件里）。
   ============================================================ */

const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // 前端是网页，早晚要跨域调这两个接口（契约第六节第 1 条）。
  // 先放开：这是个人工具，本来就没有鉴权（风险记录在 PRD 第 9 节）。
  'Access-Control-Allow-Origin': '*',
  // 下面三行是给浏览器的"预检（OPTIONS）"用的：
  // JSON 格式的 POST 属于"非简单请求"，浏览器会先发一个 OPTIONS 问一句
  // "我能发吗"。不答这几个头，前端将来的 POST 会在浏览器控制台报跨域错 ——
  // 而且报的错看起来像"接口挂了"，实际是预检没答。所以现在就答上。
  // ★ Day 22：PATCH / DELETE 加进来之后这行必须跟着加。
  //   不改的话，前端的 PATCH/DELETE 会被浏览器在**预检**这一步就拦掉，
  //   而报错的样子是"接口不通"—— 很难想到是这里少写了两个方法名。
  //   （自检 C-10 / H-43 守着这一行。）
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

/** 成功：200 + { ok: true, ... } */
function ok(payload) {
  return { statusCode: 200, payload: Object.assign({ ok: true }, payload) };
}

/** 失败：{ ok: false, message: '中文人话' } */
function fail(statusCode, message) {
  return { statusCode, payload: { ok: false, message } };
}

/** 预检请求：204 无内容（不需要 body） */
function preflight() {
  return { statusCode: 204, payload: null };
}

/** 把处理结果包成 HTTP 访问服务要的响应 */
function toResponse(result) {
  return {
    statusCode: result.statusCode,
    headers: CORS_HEADERS,
    body: result.payload === null || result.payload === undefined
      ? ''
      : JSON.stringify(result.payload)
  };
}

module.exports = { ok, fail, preflight, toResponse, CORS_HEADERS };
