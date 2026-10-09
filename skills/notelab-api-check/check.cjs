/* ============================================================
   day17-notes-fn-check.cjs —— GET /api/notes 云函数的自检
   ============================================================
   两层：
     A 层：直接 require 云函数文件，断言它**自己的**纯函数
           （参数边界、SQL 占位符与参数个数是否对得上、时间格式）
     B 层：把函数真实生成的 SQL 机械翻译成 SQLite 方言，跑真数据验语义
     C 层：调 main() 本身 —— 只测"碰数据库之前"就返回的那两条
           （方法不对 / 参数不合法）。这两条最该测：
           写错了会变成"接口返回成功但什么都没做"。

   为什么值得这么写：A 层跑的是云函数文件里的真代码，不是另抄一份。
   另抄一份的问题在于——仿制品全绿、真代码有 bug，是最糟的情况
   （Day 13 已经在"桩测试 34/34 全过但页面上什么都没有"上吃过一次这个亏）。

   ⚠️ B 层验证不了的部分（已在输出里列出，不要当成已验过）：
      - MySQL 的 COLLATE utf8mb4_unicode_ci 对**中文/Unicode**的大小写折叠
        （SQLite 的 LIKE 只对 ASCII 做大小写不敏感，本脚本的数据全是 ASCII 场景）
      - mysql2 的 query() 对 IN (?) 的数组展开（SQLite 驱动没有这个行为）
      - DATETIME(3) 在 mysql2 dateStrings 模式下的真实回传格式
      - 云函数 event.queryStringParameters 在 HTTP 访问服务下是否真的有值

   用法：node skills/notelab-api-check/check.cjs
   要求：Node 22+（用的是内置 node:sqlite，不用装任何依赖）
   ============================================================ */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 用相对路径（不用绝对路径）——这个脚本要跟着仓库走到任何机器上都能跑
const FN_PATH = path.join(__dirname, '..', '..', 'cloudbase-functions', 'notes', 'index.js');
const T = require(FN_PATH).__test__;

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

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, '得到 ' + a + '，期望 ' + e);
}

function countQ(sql) {
  return (sql.match(/\?/g) || []).length;
}


/* ============================================================
   A 层：参数解析
   ============================================================ */
console.log('\nA 层｜parseParams —— 参数边界（跑的是函数里的真代码）');

const p = (qs) => T.parseParams(qs);

eq('A-01 什么都不传：limit 用默认 50，其余为 null',
  p({}), { keyword: null, tag: null, limit: 50 });

eq('A-02 关键词两边空白被 trim',
  p({ keyword: '  flomo  ' }), { keyword: 'flomo', tag: null, limit: 50 });

eq('A-03 关键词是空字符串 → 当成没传（清空搜索框不该搜不到东西）',
  p({ keyword: '' }), { keyword: null, tag: null, limit: 50 });

eq('A-04 关键词只有空格 → 当成没传',
  p({ keyword: '   ' }), { keyword: null, tag: null, limit: 50 });

eq('A-05 标签原样保留（区分大小写的关键：不能被小写化）',
  p({ tag: 'Work' }), { keyword: null, tag: 'Work', limit: 50 });

eq('A-06 标签传 none → 原样保留（none 是契约保留值，不做二次换算）',
  p({ tag: 'none' }), { keyword: null, tag: 'none', limit: 50 });

eq('A-07 标签空字符串 → 当成没传',
  p({ tag: '' }), { keyword: null, tag: null, limit: 50 });

eq('A-08 limit 传字符串数字 → 转成数字',
  p({ limit: '10' }), { keyword: null, tag: null, limit: 10 });

check('A-09 limit=0 被拒（错误信息里带上默认值，方便用户照着改）',
  typeof p({ limit: '0' }).error === 'string' && p({ limit: '0' }).error.includes('50'),
  JSON.stringify(p({ limit: '0' })));

check('A-10 limit=-3 被拒', typeof p({ limit: '-3' }).error === 'string', JSON.stringify(p({ limit: '-3' })));

check('A-11 limit=1.5 被拒（必须是整数）', typeof p({ limit: '1.5' }).error === 'string', JSON.stringify(p({ limit: '1.5' })));

check('A-12 limit=abc 被拒', typeof p({ limit: 'abc' }).error === 'string', JSON.stringify(p({ limit: 'abc' })));

check('A-13 limit=999 被夹到上限 200', p({ limit: '999' }).limit === 200, JSON.stringify(p({ limit: '999' })));

check('A-14 limit=200（正好等于上限）不被改', p({ limit: '200' }).limit === 200);

check('A-15 limit=201 被夹到 200', p({ limit: '201' }).limit === 200);

eq('A-16 三个参数一起传', p({ keyword: 'flomo', tag: '想法', limit: '5' }),
  { keyword: 'flomo', tag: '想法', limit: 5 });

check('A-17 常量与契约一致：默认 50 / 上限 200 / 保留值 none',
  T.LIMIT_DEFAULT === 50 && T.LIMIT_MAX === 200 && T.TAG_NONE === 'none',
  T.LIMIT_DEFAULT + '/' + T.LIMIT_MAX + '/' + T.TAG_NONE);


/* ============================================================
   A 层：SQL 组装 —— 占位符个数必须等于参数个数
   ============================================================ */
console.log('\nA 层｜buildWhere —— 最要命的不变量：? 的个数 === 参数个数');

// 一个组合写错了占位符数，运行时才报错，而且报的是数据库的错，
// 不是"你少传了一个参数"——所以这条必须在本地拦死。
// 注意 buildWhere 返回的 SQL 里不含 LIMIT ?，所以这里比对的是 params.length 本身。
const cases = [
  ['A-18 只关键词', 'flomo', null, 2],
  ['A-19 只标签', null, '想法', 1],
  ['A-20 只无标签', null, 'none', 0],
  ['A-21 关键词+标签', 'flomo', '想法', 3],
  ['A-22 关键词+无标签', 'flomo', 'none', 2],
  ['A-23 都不传', null, null, 0]
];

for (const [name, kw, tg, expectParams] of cases) {
  const { whereSql, params } = T.buildWhere(kw, tg);
  check(name + '：占位符 ' + countQ(whereSql) + ' 个 / 参数 ' + params.length + ' 个必须相等',
    countQ(whereSql) === params.length,
    'SQL=' + whereSql.slice(0, 60) + '...');
  check(name + '：参数个数应为 ' + expectParams,
    params.length === expectParams, '实际 ' + params.length);
}

// 都不传时不能留下一个空的 WHERE
check('A-24 都不传时不留空 WHERE（否则 SQL 语法错误）',
  T.buildWhere(null, null).whereSql === '', '得到 "' + T.buildWhere(null, null).whereSql + '"');

// 大小写：这两条是整套设计的核心，必须一眼看得见
const kwOnly = T.buildWhere('flomo', null).whereSql;
const tagOnly = T.buildWhere(null, '想法').whereSql;

check('A-25 关键词分支带 COLLATE utf8mb4_unicode_ci（搜索不区分大小写，PRD 3.2）',
  kwOnly.includes('COLLATE utf8mb4_unicode_ci'));

check('A-26 标签精确筛选分支**不带** COLLATE（标签区分大小写，PRD 2.3）',
  !tagOnly.includes('COLLATE') && tagOnly.includes('y.tag = ?'),
  tagOnly.replace(/\s+/g, ' ').slice(0, 80));

check('A-27 无标签分支是 NOT EXISTS，且不含任何占位符',
  T.buildWhere(null, 'none').whereSql.includes('NOT EXISTS') &&
  countQ(T.buildWhere(null, 'none').whereSql) === 0);

check('A-28 无标签分支绝不出现 "y.tag = ?"（那是精确筛选标签的写法）',
  !T.buildWhere(null, 'none').whereSql.includes('y.tag = ?'));

check('A-29 关键词同时查正文和标签（PRD 3.1：标签也要能被搜到）',
  kwOnly.includes('n.content LIKE') && kwOnly.includes('FROM note_tags AS z'));


/* ============================================================
   A 层：时间格式
   ============================================================ */
console.log('\nA 层｜toIsoUtc —— 库里存 UTC，前端要 ISO 字符串');

eq('A-30 带毫秒的 DATETIME → ISO',
  T.toIsoUtc('2026-09-24 09:12:00.000'), '2026-09-24T09:12:00.000Z');

eq('A-31 不带毫秒也能转',
  T.toIsoUtc('2026-09-24 09:12:00'), '2026-09-24T09:12:00Z');

eq('A-32 空值返回 null（不是 undefined，也不是 "null" 字符串）',
  T.toIsoUtc(null), null);

eq('A-33 已经是 ISO 的不再补 Z（避免出现 ...ZZ）',
  T.toIsoUtc('2026-09-24T09:12:00.000Z'), '2026-09-24T09:12:00.000Z');


/* ============================================================
   B 层：SQL 语义（SQLite 等价翻译）
   ============================================================ */
console.log('\nB 层｜SQL 语义 —— 翻译成 SQLite 方言跑真数据');

// 把函数生成的 MySQL SQL 机械翻译成 SQLite 方言。
// 翻译是纯字符串替换，不改结构 —— 所以验的就是函数真正生成的那段 SQL。
function toSqlite(sql) {
  return sql
    .replace(/CONCAT\('%', \?, '%'\)/g, "('%' || ? || '%')")  // MySQL CONCAT → SQLite ||
    .replace(/ COLLATE utf8mb4_unicode_ci/g, '');              // SQLite 的 LIKE 默认就是 ASCII 不区分大小写
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');   // ⚠️ SQLite 默认是关的（Day 16 就在这儿栽过一次）
db.exec(`
  CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE note_tags (
    note_id  TEXT NOT NULL,
    tag      TEXT NOT NULL COLLATE BINARY,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, tag),
    FOREIGN KEY (note_id) REFERENCES notes (id) ON DELETE CASCADE
  );
`);

// 与 db/seed.sql 完全一致的 6 条
const seedNotes = [
  ['seed_01', '第一版跑起来了，比想象中简单——因为该砍的功能都砍掉了 #记录',                 '2026-09-24 09:12:00.000'],
  ['seed_02', '真花时间的不是功能，是边界：空内容、超长、搜不到、存储不可用 #想法',             '2026-09-24 08:05:00.000'],
  ['seed_03', 'flomo 最值钱的不是功能多，是它逼我做的决定少。这条要记牢 #产品研究',            '2026-09-23 21:40:00.000'],
  ['seed_04', '把 loadNotes / saveNotes 单独拎出来是对的，以后换存储只改这两个函数 #想法 #代码', '2026-09-23 19:02:00.000'],
  ['seed_05', '无标签的随手记：周四晚上下了雨，楼下那家店关得比平时早。',                     '2026-09-22 22:10:00.000'],
  ['seed_06', '周报里要把 Day 8 的截图补上，别忘了 #待办',                                  '2026-09-22 10:30:00.000']
];
const seedTags = [
  ['seed_01', '记录', 0], ['seed_02', '想法', 0], ['seed_03', '产品研究', 0],
  ['seed_04', '想法', 0], ['seed_04', '代码', 1], ['seed_06', '待办', 0]
];
// 额外两条夹具：专门验"标签区分大小写"（seed 数据里没有只差大小写的标签）
const csNotes = [['cs_UP', '夹具：大写标签 #Work', '2026-09-19 01:00:00.000'],
                 ['cs_low', '夹具：小写标签 #work', '2026-09-19 00:00:00.000']];
const csTags = [['cs_UP', 'Work', 0], ['cs_low', 'work', 0]];

const insN = db.prepare('INSERT INTO notes (id, content, created_at) VALUES (?, ?, ?)');
const insT = db.prepare('INSERT INTO note_tags (note_id, tag, position) VALUES (?, ?, ?)');
for (const r of seedNotes.concat(csNotes)) insN.run(...r);
for (const r of seedTags.concat(csTags)) insT.run(...r);

// —— 直接复用函数生成 SQL 的取数流程 ——
// ⚠️ 顺序：先 parseParams 再 buildWhere —— 和云函数出口里的顺序完全一致。
//    自检脚本第一版是直接 buildWhere(keyword, tag) 的，B-11 因此报错：
//    那时 tag 的换算还发生在 parseParams 里，绕过它就等于绕过了那道转换。
//    那次的结论是"那层换算本来就多余"，于是把它删了（见 index.js 的 TAG_NONE 注释）。
//    但脚本仍然按真实顺序调 —— 免得以后再冒出"两个函数之间的隐式约定被测试绕过"。
function queryNotes(keyword, tag, limit) {
  const parsed = T.parseParams({ keyword, tag, limit });
  if (parsed.error) throw new Error('parseParams 报错：' + parsed.error);
  const { whereSql, params } = T.buildWhere(parsed.keyword, parsed.tag);
  const sql = `SELECT n.id, n.content, n.created_at
                 FROM notes AS n
                 ${toSqlite(whereSql)}
                ORDER BY n.created_at DESC
                LIMIT ?`;
  const noteRows = db.prepare(sql).all(...params, parsed.limit);

  const byNote = new Map();
  const ids = noteRows.map((r) => r.id);
  if (ids.length) {
    // 函数里写的是 IN (?) 交给 mysql2 展开；SQLite 这边手动展开成 (?,?,...)
    const holders = ids.map(() => '?').join(', ');
    const tagRows = db.prepare(
      `SELECT note_id, tag FROM note_tags WHERE note_id IN (${holders}) ORDER BY note_id, position`
    ).all(...ids);
    for (const r of tagRows) {
      if (!byNote.has(r.note_id)) byNote.set(r.note_id, []);
      byNote.get(r.note_id).push(r.tag);
    }
  }
  return noteRows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: byNote.get(r.id) || [],
    createdAt: r.created_at
  }));
}

function idsOf(rows) { return rows.map((r) => r.id); }
function tagsOf(rows, id) { const r = rows.find((x) => x.id === id); return r ? r.tags : null; }

// 先算一步"只有 seed 数据"的基线（把夹具排除掉的过滤条件）
const isFixture = (id) => id.startsWith('cs_');
const seedOnly = (rows) => rows.filter((r) => !isFixture(r.id));

check('B-01 全量：6 条 seed（+2 条夹具），按时间倒序',
  seedOnly(queryNotes(null, null, 200)).length === 6,
  '得到 ' + seedOnly(queryNotes(null, null, 200)).length + ' 条');

eq('B-02 全量顺序：最新的 seed_01 排第一、最老的 seed_06 排最后',
  idsOf(seedOnly(queryNotes(null, null, 200))),
  ['seed_01', 'seed_02', 'seed_03', 'seed_04', 'seed_05', 'seed_06']);

eq('B-03 标签按 position 还原顺序：seed_04 = 想法, 代码',
  tagsOf(queryNotes(null, null, 200), 'seed_04'), ['想法', '代码']);

eq('B-04 无标签的 seed_05 拿到空数组（不是 null）',
  tagsOf(queryNotes(null, null, 200), 'seed_05'), []);

eq('B-05 关键词 flomo → 命中 seed_03',
  idsOf(seedOnly(queryNotes('flomo', null, 200))), ['seed_03']);

eq('B-06 关键词大写 FLOMO → 结果与 B-05 完全一样（PRD 3.1 不区分大小写）',
  idsOf(seedOnly(queryNotes('FLOMO', null, 200))), ['seed_03']);

eq('B-07 关键词命中标签：搜「产品研究」→ seed_03（标签也要能被搜到，PRD 3.2）',
  idsOf(seedOnly(queryNotes('产品研究', null, 200))), ['seed_03']);

eq('B-08 标签精确筛选「想法」→ seed_02 和 seed_04',
  idsOf(seedOnly(queryNotes(null, '想法', 200))), ['seed_02', 'seed_04']);

// ★ 这一条是拆两句的**唯一理由**，也是这次改动最该被守住的正确性
eq('B-09 ★ 搜「想法」命中 seed_04 时，标签必须是它全部的两个 [想法, 代码]，不是只剩下命中那个',
  tagsOf(queryNotes('想法', null, 200), 'seed_04'), ['想法', '代码']);

eq('B-10 按标签筛「想法」时 seed_04 的标签同样完整 [想法, 代码]',
  tagsOf(queryNotes(null, '想法', 200), 'seed_04'), ['想法', '代码']);

eq('B-11 标签 none → 只命中无标签的 seed_05',
  idsOf(seedOnly(queryNotes(null, 'none', 200))), ['seed_05']);

eq('B-12 无标签结果的 tags 是空数组',
  tagsOf(queryNotes(null, 'none', 200), 'seed_05'), []);

eq('B-13 limit=2 → 只取最新的两条',
  idsOf(seedOnly(queryNotes(null, null, 2))), ['seed_01', 'seed_02']);

eq('B-14 limit=2 时 seed_04 不在结果里（证明确实限了条数，不是限了之后又补回来）',
  queryNotes(null, null, 2).some((r) => r.id === 'seed_04'), false);

eq('B-15 标签+limit 组合：筛「想法」取 1 条 → seed_02',
  idsOf(seedOnly(queryNotes(null, '想法', 1))), ['seed_02']);

eq('B-16 关键词+标签组合同时生效：flomo + 想法 → 空（seed_03 没有「想法」标签）',
  idsOf(seedOnly(queryNotes('flomo', '想法', 200))), []);

eq('B-17 搜不到时返回空数组，不报错',
  idsOf(seedOnly(queryNotes('这个关键词一定搜不到', null, 200))), []);

eq('B-18 空结果时不去查标签也不会崩（对应函数里的 ids.length 判断）',
  queryNotes('这个关键词一定搜不到', null, 200).length, 0);

// —— 标签区分大小写（PRD 2.3）：这一条对应 A-26 的"标签分支不带 COLLATE" ——
eq('B-19 精确筛标签区分大小写：tag=Work 只命中 cs_UP',
  idsOf(queryNotes(null, 'Work', 200).filter((r) => isFixture(r.id))), ['cs_UP']);

eq('B-20 精确筛标签区分大小写：tag=work 只命中 cs_low',
  idsOf(queryNotes(null, 'work', 200).filter((r) => isFixture(r.id))), ['cs_low']);

eq('B-21 对照：关键词搜 Work（走正文 LIKE）两条都命中',
  idsOf(queryNotes('Work', null, 200).filter((r) => isFixture(r.id))), ['cs_UP', 'cs_low']);

// —— 级联删除（顺手复核 Day 16 的结论在翻译后的结构上仍成立）——
db.prepare('DELETE FROM notes WHERE id = ?').run('seed_04');
eq('B-22 删笔记时标签行跟着删（ON DELETE CASCADE）',
  callCount('SELECT COUNT(*) AS c FROM note_tags WHERE note_id = ?', 'seed_04'), 0);

function callCount(sql, arg) {
  return db.prepare(sql).get(arg).c;
}

eq('B-23 删掉 seed_04 后全量变 5 条 seed',
  seedOnly(queryNotes(null, null, 200)).length, 5);

eq('B-24 删掉 seed_04 后「想法」只剩 seed_02',
  idsOf(seedOnly(queryNotes(null, '想法', 200))), ['seed_02']);

eq('B-25 删掉 seed_04 后搜索 seed_04 的标签也搜不到了（没有孤儿标签行）',
  idsOf(seedOnly(queryNotes('代码', null, 200))), []);


/* ============================================================
   C 层：入口 main() —— 不碰数据库就能验的那两条
   ============================================================
   main() 里凡是需要连库的分支，本机都测不了（没装 mysql2、也没有库）。
   但"方法不对"和"参数不合法"在碰数据库**之前**就返回了，所以它们能测。
   这两条尤其该测：写错了不会报错，只会变成"接口返回成功但其实什么都没做"。
   ============================================================ */
const { main } = require(FN_PATH);

async function layerC() {
  console.log('\nC 层｜main 入口 —— 碰数据库之前就返回的几支');

  const post = await main({ httpMethod: 'POST' });
  check('C-01 POST 被挡成 405，不会落到 GET 分支假装成功',
    post.statusCode === 405 && JSON.parse(post.body).ok === false,
    JSON.stringify(post));

  check('C-02 405 的 message 是给人看的中文（前端出错状态要原样显示它）',
    JSON.parse(post.body).message.includes('GET'),
    JSON.parse(post.body).message);

  // 网关给什么大小写都不该把一个正常 GET 判成 405
  const lower = await main({ httpMethod: 'get', queryStringParameters: { limit: '0' } });
  check('C-03 小写 get 也认（否则会误判 405）', lower.statusCode === 400,
    '得到 ' + lower.statusCode);

  const badLimit = await main({ queryStringParameters: { limit: 'abc' } });
  check('C-04 limit 非法 → 400，且发生在碰数据库之前',
    badLimit.statusCode === 400 && JSON.parse(badLimit.body).ok === false,
    JSON.stringify(badLimit));

  check('C-05 返回是结构化形式：statusCode + headers + body 字符串',
    typeof post.statusCode === 'number' && typeof post.body === 'string' &&
    String(post.headers['Content-Type']).includes('application/json'),
    Object.keys(post).join(','));

  check('C-06 body 能 JSON.parse，不是双重编码',
    (() => { try { return typeof JSON.parse(post.body) === 'object'; } catch (e) { return false; } })());

  // 这条是"给自检自己上的保险"：常量或函数一旦改名，
  // 上面那些断言会读到 undefined 而静默失败 —— 那才是最坏的情况（脚本假绿）。
  // （TAG_NONE_SENTINEL 就是当天改掉的一个名字，所以这条不是假想。）
  const api = require(FN_PATH);
  check('C-07 导出面没变：main 是函数，__test__ 里该有的都在（防改名让自检悄悄失效）',
    typeof api.main === 'function' &&
    ['parseParams', 'buildWhere', 'toIsoUtc', 'TAG_NONE', 'LIMIT_DEFAULT', 'LIMIT_MAX']
      .every((k) => api.__test__[k] !== undefined),
    Object.keys(api.__test__).join(','));
}


/* ============================================================
   结果
   ============================================================ */
function finish() {
  const total = pass + failures.length;
  console.log('\n' + '='.repeat(60));
  console.log('自检结果：' + pass + '/' + total + ' 通过');
  console.log('='.repeat(60));

  console.log('\n⚠️ 明确**没有**被验证的部分（别当成已验过）：');
  console.log('  1. MySQL 的 COLLATE utf8mb4_unicode_ci 对非 ASCII 的大小写折叠');
  console.log('     （B 层的 LIKE 只对 ASCII 不区分大小写，中文没有大小写，验不出差异）');
  console.log('  2. mysql2 的 query() 对 IN (?) 的数组展开（SQLite 驱动没这个行为）');
  console.log('  3. DATETIME(3) 经 mysql2 dateStrings 回传的真实格式（本机无 MySQL）');
  console.log('  4. HTTP 访问服务下 event.queryStringParameters 是否真的有值');
  console.log('  5. 配了 VPC 之后函数能否真的连上库（要有环境才能试）');
  console.log('  6. 网关吃不吃 {statusCode, body} 这种结构化返回 —— 不吃就得改成直接返回对象');
  console.log('     （部署后第 6 步核对里专门有一条查这个）');

  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
}

layerC().then(finish);

