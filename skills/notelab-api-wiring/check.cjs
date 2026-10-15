/* ============================================================
   check.cjs —— 前端「接线」自检（notelab-api-wiring，Day 20 建立）
   ============================================================
   验的是 `api.js`：页面上那份"从公网取数据"的代码。

   分两段：
     纯函数段  不用网络。验"网关可能给的两种信封"的拆解与形状校验
     真实请求段 本机起一个临时 HTTP 服务，用真的 fetch 打真的请求
               （Node 22 自带 fetch，不需要装任何依赖）

   ★ 今天要掌握的那件事在这里被摊开验：
     同一句"取不到数据"可能是跨域 / 地址错 / 形状不对三种病。
     所以断言里有一条专门盯"出错提示有没有告诉用户去看哪里" ——
     只写"出错了"的提示等于把排查成本推给用户。

   ⚠️ 验不到的：浏览器**是否真的放行跨域**。CORS 是浏览器执行的规则，
      Node 的 fetch 不执行它 —— 这一条只能靠真浏览器 + F12 验。

   用法：node skills/notelab-api-wiring/check.cjs
   要求：Node 22+（自带 fetch），零依赖
   ============================================================ */

const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..', '..');
const API_FILE = path.join(ROOT, 'api.js');

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

/** 每次都重新加载 api.js，好让 window.location.search 的改动生效 */
function loadApi(search) {
  delete require.cache[require.resolve(API_FILE)];
  if (search === null) {
    delete global.window;
  } else {
    global.window = { location: { search: search } };
  }
  return require(API_FILE);
}


/* ============================================================
   一、地址是怎么配的
   ============================================================ */
console.log('\n一｜接口地址的配置（默认不启用，是这条改动的安全底线）');

const plain = loadApi(null);
check('A-01 什么都不配 → 不启用（页面照旧读 localStorage）',
  plain.isEnabled() === false, String(plain.API_BASE));

const fromUrl = loadApi('?api=https://cloud1-3g1abc.service.tcloudbase.com');
check('A-02 网址参数 ?api=… 能配上（临时调试用）',
  fromUrl.isEnabled() === true &&
  fromUrl.API_BASE === 'https://cloud1-3g1abc.service.tcloudbase.com',
  String(fromUrl.API_BASE));

const trailing = loadApi('?api=https://cloud1-3g1abc.service.tcloudbase.com/');
check('A-03 地址末尾多一个斜杠会被去掉（否则拼出 /api/notes 前的双斜杠）',
  trailing.API_BASE === 'https://cloud1-3g1abc.service.tcloudbase.com',
  String(trailing.API_BASE));

const fromGlobal = loadApi('');
global.window.NOTELAB_API_BASE = 'https://global.example.com';
delete require.cache[require.resolve(API_FILE)];
const g = require(API_FILE);
check('A-04 window.NOTELAB_API_BASE 也能配上（部署时不想改文件的用法）',
  g.API_BASE === 'https://global.example.com', String(g.API_BASE));
delete global.window;


/* ============================================================
   二、拆信封：网关可能给两种形状
   ============================================================ */
console.log('\n二｜信封拆解（这是部署前唯一确定不了的一处，所以两种都要认）');

const api = loadApi(null);

const wrapped = { statusCode: 200, headers: {}, body: '{"ok":true,"notes":[{"id":"a"}]}' };
const unwrappedJson = api.unwrapGatewayPayload(wrapped);
check('B-01 网关没拆（给了 statusCode + body 字符串）→ 自己拆一层',
  unwrappedJson && unwrappedJson.ok === true && unwrappedJson.notes.length === 1,
  JSON.stringify(unwrappedJson));

const already = { ok: true, notes: [] };
check('B-02 网关已经拆开了 → 原样返回，不多拆一层',
  api.unwrapGatewayPayload(already) === already);

check('B-03 body 不是合法 JSON → 返回 null（交给下面报"形状不对"，不能当场崩）',
  api.unwrapGatewayPayload({ statusCode: 200, body: '不是JSON' }) === null);

check('B-04 有 statusCode 但 body 不是字符串 → 不当成结构化信封',
  api.unwrapGatewayPayload({ statusCode: 200, body: { ok: true } }).body.ok === true);


/* ============================================================
   三、形状校验：只认契约里那一种
   ============================================================ */
console.log('\n三｜形状校验（对不上就报错，不许"拿到什么算什么"）');

const okRes = api.normalizeNotesResponse({ ok: true, notes: [{ id: 'x' }] });
check('C-01 正常 → ok=true 且 notes 原样带回来',
  okRes.ok === true && okRes.notes.length === 1);

check('C-02 接口明确说失败 → 把它的中文原因透传（前端会原样显示）',
  api.normalizeNotesResponse({ ok: false, message: '服务器开小差了' }).message === '服务器开小差了');

check('C-03 失败但没给原因 → 补一句人话，不能显示 undefined',
  api.normalizeNotesResponse({ ok: false }).message.indexOf('没给原因') !== -1);

const noOk = api.normalizeNotesResponse({ notes: [] });
check('C-04 没有 ok 字段 → 判为形状不对（不许默认当成功）',
  noOk.ok === false && noOk.message.indexOf('ok') !== -1);

check('C-05 notes 不是数组 → 判为形状不对',
  api.normalizeNotesResponse({ ok: true, notes: 'abc' }).ok === false);

check('C-06 空数据也算成功（契约第三节：空不是错误，页面有空状态）',
  api.normalizeNotesResponse({ ok: true, notes: [] }).ok === true);

check('C-07 返回 null → 判为形状不对，不许崩',
  api.normalizeNotesResponse(null).ok === false);


/* ============================================================
   四、出错提示要告诉用户"去哪看"（今天要掌握的那件事）
   ============================================================ */
console.log('\n四｜出错提示（写"出错了"等于把排查成本推给用户）');

const hint = api.corsHint();
check('D-01 提示里点名了 CORS（否则用户不知道该朝哪个方向查）',
  hint.indexOf('CORS') !== -1, hint);
check('D-02 提示里教了怎么看：F12 → Network / Console',
  hint.indexOf('F12') !== -1 && hint.indexOf('Network') !== -1 && hint.indexOf('Console') !== -1);
check('D-03 提示里给出了"什么状态对应什么病"（404/502 是地址，200 空内容是跨域）',
  hint.indexOf('404') !== -1 && hint.indexOf('502') !== -1);


/* ============================================================
   五、真的打一次请求（本机临时服务，不是桩）
   ============================================================ */
console.log('\n五｜真实请求（本机起一个临时服务，用真 fetch 打过去）');

const NOTES = [
  { id: 'seed_01', content: '第一条真实数据 #想法', tags: ['想法'], createdAt: '2026-09-24T09:12:00.000Z' }
];
const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/plain/') === 0) {
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, notes: NOTES }));
      } else if (req.url.indexOf('/wrapped/') === 0) {
        // 模拟"网关没拆信封"的那种
        res.writeHead(200, CORS);
        res.end(JSON.stringify({
          statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, notes: NOTES })
        }));
      } else if (req.url.indexOf('/failed/') === 0) {
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: false, message: '服务器开小差了' }));
      } else if (req.url.indexOf('/html/') === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>网关错误页</body></html>');
      } else {
        res.writeHead(404, CORS);
        res.end(JSON.stringify({ ok: false, message: 'not found' }));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function live() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;

  const good = loadApi('?api=' + base + '/plain');
  const r1 = await good.fetchApiNotes();
  check('E-01 正常返回 → ok=true，笔记带回来',
    r1.ok === true && r1.notes.length === 1 && r1.notes[0].id === 'seed_01', JSON.stringify(r1));

  const wrap = loadApi('?api=' + base + '/wrapped');
  const r2 = await wrap.fetchApiNotes();
  check('E-02 ★ 网关套了一层也能取到（部署后才知道是哪一种，两种都得活）',
    r2.ok === true && r2.notes.length === 1, JSON.stringify(r2));

  const bad = loadApi('?api=' + base + '/failed');
  const r3 = await bad.fetchApiNotes();
  check('E-03 接口说失败 → 原因原样传给页面（前端会显示它）',
    r3.ok === false && r3.message.indexOf('服务器开小差') !== -1, JSON.stringify(r3));

  const html = loadApi('?api=' + base + '/html');
  const r4 = await html.fetchApiNotes();
  check('E-04 返回 200 但不是 JSON → 明确说"多半是网关错误页"，而不是静默失败',
    r4.ok === false && r4.message.indexOf('不是 JSON') !== -1, JSON.stringify(r4));

  const gone = loadApi('?api=' + base + '/nope');
  const r5 = await gone.fetchApiNotes();
  check('E-05 404 → 失败，且提示里带上了 HTTP 状态码（方便对号入座）',
    r5.ok === false && r5.message.indexOf('404') !== -1, JSON.stringify(r5));

  // 端口没人听 → fetch 直接 reject，走的是"请求根本没发出去"那一支
  const dead = loadApi('?api=http://127.0.0.1:1');
  const r6 = await dead.fetchApiNotes();
  check('E-06 ★ 连不上（地址错/服务不在）→ 提示指向"去 F12 看是地址问题还是 CORS 问题"',
    r6.ok === false && r6.message.indexOf('F12') !== -1, JSON.stringify(r6));

  server.close();
}

live().then(() => {
  console.log('\n' + '='.repeat(64));
  console.log('接线自检结果：' + pass + '/' + (pass + failures.length) + ' 通过');
  console.log('='.repeat(64));

  console.log('\n⚠️ 明确**没有**被验证的部分（别当成已验过）：');
  console.log('  1. ★ 浏览器是否真的放行跨域（CORS）。这是**浏览器**执行的规则，');
  console.log('     Node 的 fetch 不执行它 —— 本机验不了，只能部署后用真浏览器 + F12 看。');
  console.log('  2. CloudBase 的 HTTP 访问服务到底拆不拆信封（B 段两种都认，');
  console.log('     但真跑一次才知道实际是哪一种）。');
  console.log('  3. 公网 URL 与静态托管是否可达（需要环境 ID，目前仍缺失）。');
  console.log('  4. 页面在真浏览器里渲染真实数据的样子（需要环境 ID）。');

  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
}).catch((err) => {
  console.error('\n自检脚本自己崩了：', err);
  process.exitCode = 1;
});
