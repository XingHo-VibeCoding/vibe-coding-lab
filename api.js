/* ============================================================
   api.js —— 真实接口的数据来源（Day 20 接线新增）
   ============================================================
   这个文件是"页面上的数据从哪来"的第二个答案：
     mock-data.js  演示模式用的假数据（Day 8）
     本文件        公网云函数上的真数据（Day 20）

   ★ 为什么单独一个文件，而不是塞进 mock-data.js：
     mock-data.js 的名字和职责都是"假数据"，把真的网络请求放进去，
     下次看代码的人分不清哪条路径是真的。两条来源各自一个文件，
     改哪条都不会误伤另一条。
     （Day 8 立下的承诺"切真接口只改一处"依然成立 ——
       页面和渲染代码一行都不用动，动的是这个文件 + bootstrap 里选来源那几行。）

   ★ 默认不启用：没配地址时 `isEnabled()` 返回 false，
     页面照旧读 localStorage —— 你本地已经记的笔记不会因为这个改动消失。
   ============================================================ */

/* ------------------------------------------------------------
   接口地址怎么配（两种，二选一）
   ------------------------------------------------------------
   ① 部署时写死：把下面这行的 '' 换成你的公网地址，例如
        const CONFIGURED_BASE = 'https://cloud1-3g1xxxxx.service.tcloudbase.com';
      然后随页面一起上传。上传前改这一行就够了。
   ② 临时试：网址后面加 ?api=<地址>，例如
        http://localhost:8123/?api=https://cloud1-3g1xxxxx.service.tcloudbase.com
      方便在同一台机器上对比"本地数据"和"云端数据"，不用改代码。

   两个都不给 → 不启用，走本地存储。
   ------------------------------------------------------------ */
const CONFIGURED_BASE = '';

function resolveBase() {
  if (typeof window === 'undefined') return CONFIGURED_BASE;

  // ② 优先：网址参数（临时调试用，不进仓库）
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('api');
    if (fromUrl) return String(fromUrl).replace(/\/+$/, '');
  } catch (e) { /* 地址栏格式异常时忽略，退回配置值 */ }

  // ① 其次：写在文件里的
  if (typeof window.NOTELAB_API_BASE === 'string' && window.NOTELAB_API_BASE) {
    return window.NOTELAB_API_BASE.replace(/\/+$/, '');
  }
  return CONFIGURED_BASE.replace(/\/+$/, '');
}

const API_BASE = resolveBase();

/* ★ Day 23：所有面向用户的报错文案改从 errors.js 取，本文件不再自己写句子。
   浏览器里它是先加载的 window.NoteLabErrors，Node 自检里是 require（两处都走得通）。

   ⚠️ 变量名为什么叫 ERROR_TEXT 而不是更顺手的 ERRORS：
      **经典脚本（非 module）的顶层 const / let 共享同一个全局词法作用域**，
      api.js 和 app.js 都写 `const ERRORS = …` 会直接 SyntaxError
      "Identifier 'ERRORS' has already been declared"，整个 app.js 一行都不执行。
      第一版就是这么写的 —— DOM 桩测试（vm 沙箱）全绿、真实浏览器整个白屏，
      因为 vm 里每个脚本的作用域是分开的，撞不出这个错。
      这是 Day 13 那条教训的新版本：**桩测过了不等于用户看得见。**
      （自查脚本 L-4 现在会扫这个重名。） */
const ERROR_TEXT = (typeof require === 'function')
  ? require('./errors.js')
  : window.NoteLabErrors;

/** 有没有配地址 —— 没配就不启用，行为与改动前完全一致 */
function isEnabled() {
  return typeof API_BASE === 'string' && API_BASE.length > 0;
}


/* ------------------------------------------------------------
   ★ 今天要掌握的那件事：跨域 / 取不到数时，怎么认出问题出在哪
   ------------------------------------------------------------
   同样一句"取不到数据"，至少是三种完全不同的病，治法也完全不同：

     A. 跨域（CORS）没过
        表现：请求**发出去了**，浏览器也收到了响应，但把响应丢掉了。
              F12 → Console 里会有一句带 "CORS" 或
              "blocked by CORS policy" 的红字；Network 里那条请求
              状态可能是 200，但 Response 是空的。
        治法：改**服务端**的响应头（本项目在 cloudbase-functions/notes/http.js 里，
              Day 18 已经写了 Access-Control-Allow-Origin / Methods / Headers）。
              ★ 前端改任何代码都治不好跨域 —— 这是最容易白费时间的一种。

     B. 地址不对 / 服务不在
        表现：Network 里那条请求是 404 或 502，或者根本连不上（DNS 失败）。
        治法：核对环境 ID、路径是不是 /api/notes。

     C. 接口在，但返回的数据形状不对
        表现：请求 200，Response 里有内容，但页面上还是空的/报错。
        治法：看 Response 里的 JSON 长什么样（下面 unwrapGatewayPayload 在管这件事）。

   所以下面 catch 里的提示语**不写"出错了"**，而是写清楚"去看哪里"。
   ------------------------------------------------------------ */

/* ★ Day 23：文案本身搬到 errors.js 去了，这里只留一个取值口。
   为什么连函数名都留着：断言脚本和排查文档都指名它，改名要动的地方太多；
   而"文案住在哪"这件事只要一处（errors.js），统一的目的已经达到了。 */
function corsHint() {
  return ERROR_TEXT.ERROR_MESSAGES.network.unreachable;
}


/* ------------------------------------------------------------
   拆信封：网关可能给两种形状
   ------------------------------------------------------------
   我们的云函数 return 的是 { statusCode, headers, body } 这种结构化形式。
   CloudBase 的 HTTP 访问服务**通常**会把它拆开，让浏览器直接拿到
   {"ok":true,"notes":[…]}；但也有一类网关不拆，原样把结构化对象当成 JSON 返回，
   浏览器于是收到 {"statusCode":200,"body":"{\"ok\":true…}"} —— 差一层。

   这一层差异在部署前无法确定（DEPLOY.md 里列为"部署后才能验"的第 6 条），
   所以这里两种都认，取到能用的那一层为止。
   ------------------------------------------------------------ */
function unwrapGatewayPayload(json) {
  if (
    json && typeof json === 'object' &&
    typeof json.statusCode === 'number' &&
    typeof json.body === 'string'
  ) {
    try {
      return JSON.parse(json.body);
    } catch (e) {
      return null;   // body 不是合法 JSON —— 交给下面报"形状不对"
    }
  }
  return json;       // 已经被网关拆开了，直接用
}

/** 校验形状：契约说成功必须是 { ok: true, notes: [...] } */
function normalizeNotesResponse(payload) {
  // ★ Day 23：四句文案全部取自 errors.js —— 改文案只改那一处
  const N = ERROR_TEXT.ERROR_MESSAGES.network;

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: N.notObject };
  }
  if (payload.ok === false) {
    // 服务端给了中文原因就用它的（它比我们的兜底准），没给才用兜底
    const reason = typeof payload.message === 'string' ? payload.message.trim() : '';
    return { ok: false, message: reason || N.failedNoReason };
  }
  if (payload.ok !== true) {
    return { ok: false, message: N.noOk };
  }
  if (!Array.isArray(payload.notes)) {
    return { ok: false, message: N.noNotes };
  }
  return { ok: true, notes: payload.notes };
}


/* ------------------------------------------------------------
   取数：返回与 mock 完全一样的形状，页面不用区分
     { ok: true,  notes: [...] }
     { ok: false, message: '中文原因' }
   ------------------------------------------------------------ */
async function fetchApiNotes() {
  const url = API_BASE + '/api/notes';

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // 不加 credentials：个人工具没有登录态，带上 cookie 反而会触发跨域的额外限制
      // （服务端已经回了 Access-Control-Allow-Origin: *，带凭据会与之冲突）
      credentials: 'omit'
    });
  } catch (err) {
    // ★ fetch 只在"请求根本没到服务器"时走到这里：断网、DNS 失败、**跨域被拦**
    //   所以这句提示指向"去 F12 看是地址问题还是 CORS 问题"
    console.error('[notelab] 请求没发出去', { url, err: err && err.message });
    return { ok: false, message: corsHint() };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    // 200 但内容不是 JSON —— 典型是网关返回了一个 HTML 错误页
    return { ok: false, message: ERROR_TEXT.ERROR_MESSAGES.network.notJson };
  }

  // HTTP 状态不是 2xx：契约的失败信封仍然在 body 里，照常解析
  const payload = unwrapGatewayPayload(json);
  const normalized = normalizeNotesResponse(payload);

  if (!normalized.ok && res.status >= 400) {
    // 服务端给了明确原因就用它的，没有就补上状态码，方便对号入座
    normalized.message = normalized.message + '（HTTP ' + res.status + '）';
  }
  return normalized;
}


/* 给自检脚本和页面共用的出口（浏览器里挂到 window，Node 里走 module） */
const apiModule = {
  API_BASE,
  isEnabled,
  unwrapGatewayPayload,
  normalizeNotesResponse,
  corsHint,
  fetchApiNotes
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = apiModule;
}
if (typeof window !== 'undefined') {
  window.NoteLabApi = apiModule;
}
