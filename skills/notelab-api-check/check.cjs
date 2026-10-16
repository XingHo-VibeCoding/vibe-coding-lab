/* ============================================================
   check.cjs —— NoteLab 云函数自检（notelab-api-check）
   ============================================================
   八层，按"离数据库多远"排：
     A 层：直接 require 云函数文件，断言它**自己的**纯函数
           （GET 查询参数的边界、SQL 占位符与参数个数是否对得上、时间格式两个方向）
     B 层：把函数真实生成的 SQL 机械翻译成 SQLite 方言，跑真数据验 GET 的语义
     C 层：调 main() 本身 —— 只测"碰数据库之前"就返回的那几支
           （方法不对 / 参数不合法 / 预检）。这几支最该测：
           写错了不会报错，只会变成"接口返回成功但什么都没做"。
     D 层：POST 的校验（parseBody / validateNote）——**全部拒绝分支逐条断言**，
           并逐条检查提示语是中文（Day 18 的完成标准里明写了这一条）
     E 层：用 SQLite 假造一个 mysql2 式的 conn，**真的跑 write.insertNote()**，
           验插入、事务回滚，以及最要紧的那条：
           **同一个 clientToken 第二次插入必须失败** —— 重复提交被拒的证明
     F 层：分层守卫（Day 19 新增）——读源码断言"SQL 与 conn.* 只许待在 repository.js"。
           重构最容易出的问题不是改错，是**过一阵又长回去**，
           所以把"分层"这条看不见的约定也变成断言。
     G 层：health 云函数冒烟（Day 19 新增）——"全接口回归"里的另一个接口
     H 层：PATCH / DELETE 也真的跑一遍（Day 22 新增）——重点验"删了但行还在"，
           以及"一句 UPDATE 能改回来"。删除是最容易出事的操作，值得单独一层。

   为什么值得这么写：A/C/D/E/G/H 跑的都是云函数文件里的真代码，不是另抄一份。
   E 层尤其如此 —— 它没重写写入逻辑，只把"连接"这一层换成替身。
   F 层更特别：它不断言行为，断言**代码的形状**（哪一层写了什么）。

   ⚠️ 明确**没有**被验证的部分在文件末尾打印，不要当成已验过。

   用法：node skills/notelab-api-check/check.cjs
   要求：Node 22+（用的是内置 node:sqlite，不用装任何依赖）
   ============================================================ */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// 用相对路径（不用绝对路径）——这个脚本要跟着仓库走到任何机器上都能跑
const FN_DIR = path.join(__dirname, '..', '..', 'cloudbase-functions', 'notes');
const api = require(path.join(FN_DIR, 'index.js'));
const T = api.__test__;

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

/** 提示语必须是中文（今天的完成标准里明写"提示是中文"） */
function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s);
}


/* ============================================================
   A 层：GET 查询参数解析
   ============================================================ */
console.log('\nA 层｜parseQuery —— 查询参数边界（跑的是函数里的真代码）');

const p = (qs) => T.parseQuery(qs);

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
const whereCases = [
  ['A-18 只关键词', 'flomo', null, 2],
  ['A-19 只标签', null, '想法', 1],
  ['A-20 只无标签', null, 'none', 0],
  ['A-21 关键词+标签', 'flomo', '想法', 3],
  ['A-22 关键词+无标签', 'flomo', 'none', 2],
  ['A-23 都不传', null, null, 0]
];

for (const c of whereCases) {
  const name = c[0];
  const built = T.buildWhere(c[1], c[2]);
  check(name + '：占位符 ' + countQ(built.whereSql) + ' 个 / 参数 ' + built.params.length + ' 个必须相等',
    countQ(built.whereSql) === built.params.length,
    'SQL=' + built.whereSql.replace(/\s+/g, ' ').slice(0, 60) + '…');
  check(name + '：参数个数应为 ' + c[3], built.params.length === c[3], '实际 ' + built.params.length);
}

check('A-24 都不传时不留空 WHERE（否则 SQL 语法错误）',
  T.buildWhere(null, null).whereSql === '', '得到 "' + T.buildWhere(null, null).whereSql + '"');

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
   A 层：时间格式（库里 ↔ 接口，两个方向）
   ============================================================ */
console.log('\nA 层｜toIsoUtc / toDbDateTime —— 同一个时刻的两种写法');

eq('A-30 带毫秒的 DATETIME → ISO',
  T.toIsoUtc('2026-09-24 09:12:00.000'), '2026-09-24T09:12:00.000Z');

eq('A-31 不带毫秒也能转',
  T.toIsoUtc('2026-09-24 09:12:00'), '2026-09-24T09:12:00Z');

eq('A-32 空值返回 null（不是 undefined，也不是 "null" 字符串）',
  T.toIsoUtc(null), null);

eq('A-33 已经是 ISO 的不再补 Z（避免出现 ...ZZ）',
  T.toIsoUtc('2026-09-24T09:12:00.000Z'), '2026-09-24T09:12:00.000Z');

eq('A-34 ISO → 写库格式（去掉 T 和 Z）',
  T.toDbDateTime('2026-10-10T13:18:58.123Z'), '2026-10-10 13:18:58.123');

eq('A-35 ★ 两个方向互为逆运算（写完再读回来必须一模一样，差一个字符前端排序就乱）',
  T.toIsoUtc(T.toDbDateTime('2026-10-10T13:18:58.123Z')), '2026-10-10T13:18:58.123Z');


/* ============================================================
   D 层：POST 的请求体解析
   ============================================================ */
console.log('\nD 层｜parseBody —— 请求体解析');

check('D-01 没有 body → 报错', typeof T.parseBody({}).error === 'string');
check('D-02 空字符串 body → 报错', typeof T.parseBody({ body: '' }).error === 'string');
check('D-03 不是 JSON → 报错', typeof T.parseBody({ body: '这是中文不是JSON' }).error === 'string');
check('D-04 JSON 但是数组 → 报错（接口只收对象）',
  typeof T.parseBody({ body: '[1,2]' }).error === 'string');
check('D-05 JSON 但是 null → 报错', typeof T.parseBody({ body: 'null' }).error === 'string');
check('D-06 JSON 但是字符串 → 报错', typeof T.parseBody({ body: '"abc"' }).error === 'string');
check('D-07 body 是数字 → 报错', typeof T.parseBody({ body: 123 }).error === 'string');

eq('D-08 正常 JSON 字符串 → 解析成对象',
  T.parseBody({ body: '{"content":"hi","clientToken":"abcdefgh"}' }).body,
  { content: 'hi', clientToken: 'abcdefgh' });

// 控制台"测试云函数"里人往往直接填对象，所以两种都收
eq('D-09 body 已经是对象（调试工具手填事件时）→ 直接收下',
  T.parseBody({ body: { content: 'hi' } }).body, { content: 'hi' });

eq('D-10 base64 编码的 body → 先解码再解析',
  T.parseBody({
    isBase64Encoded: true,
    body: Buffer.from('{"content":"hi","clientToken":"abcdefgh"}', 'utf8').toString('base64')
  }).body,
  { content: 'hi', clientToken: 'abcdefgh' });


/* ============================================================
   D 层：validateNote —— 拒绝分支逐条过
   ============================================================ */
console.log('\nD 层｜validateNote —— 拒绝分支逐条过（完成标准：提示是中文）');

const rejectCases = [
  ['D-11 content 缺失', { clientToken: 'abcdefgh' }, 'content'],
  ['D-12 content 是 null', { content: null, clientToken: 'abcdefgh' }, 'content'],
  ['D-13 content 是数字', { content: 123, clientToken: 'abcdefgh' }, 'content'],
  ['D-14 content 是空串', { content: '', clientToken: 'abcdefgh' }, 'content'],
  ['D-15 content 只有空白', { content: '   \n  ', clientToken: 'abcdefgh' }, 'content'],
  ['D-16 content 超长（5001 字）', { content: 'a'.repeat(5001), clientToken: 'abcdefgh' }, '5000'],
  ['D-17 clientToken 缺失', { content: '你好' }, 'clientToken'],
  ['D-18 clientToken 是 null', { content: '你好', clientToken: null }, 'clientToken'],
  ['D-19 clientToken 是数字', { content: '你好', clientToken: 12345678 }, 'clientToken'],
  ['D-20 clientToken 太短（7 位）', { content: '你好', clientToken: 'abcdefg' }, '长度'],
  ['D-21 clientToken 太长（65 位）', { content: '你好', clientToken: 'a'.repeat(65) }, '长度'],
  ['D-22 clientToken 含空格', { content: '你好', clientToken: 'abc defgh' }, '只能包含'],
  ['D-23 clientToken 含中文', { content: '你好', clientToken: '令牌令牌令牌令牌' }, '只能包含'],
  ['D-24 tags 不是数组', { content: '你好', clientToken: 'abcdefgh', tags: '工作' }, '数组'],
  ['D-25 tags 里混了数字', { content: '你好', clientToken: 'abcdefgh', tags: ['工作', 7] }, '每一项'],
  ['D-26 单个标签 51 字', { content: '你好', clientToken: 'abcdefgh', tags: ['标'.repeat(51)] }, '50']
];

const rejectMessages = [];
for (const c of rejectCases) {
  const msg = T.validateNote(c[1]).error;
  rejectMessages.push([c[0], msg]);
  check(c[0], typeof msg === 'string' && msg.includes(c[2]), '得到 ' + JSON.stringify(msg));
}

// ★ 完成标准里明写"缺必填字段被拒且提示是中文"——所以这条要单独守住，
//   而且是**逐条**守：有一条英文或者 undefined 都算不合格。
const notChinese = rejectMessages.filter((r) => !hasChinese(r[1]));
check('D-27 ★ 上面全部 ' + rejectMessages.length + ' 条拒绝提示都是中文',
  notChinese.length === 0,
  notChinese.map((r) => r[0] + ' → ' + r[1]).join(' / '));


console.log('\nD 层｜validateNote —— 正常输入与边界值');

eq('D-28 最少参数（只有 content + clientToken）→ tags 补成空数组',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh' }).value,
  { content: '你好', clientToken: 'abcdefgh', tags: [] });

eq('D-29 content 首尾空白被 trim',
  T.validateNote({ content: '  你好  ', clientToken: 'abcdefgh' }).value.content, '你好');

check('D-30 content 正好 5000 字 → 放行（边界值不该被误杀）',
  T.validateNote({ content: 'a'.repeat(5000), clientToken: 'abcdefgh' }).value !== undefined);

check('D-31 clientToken 正好 8 位 → 放行',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh' }).value !== undefined);

check('D-32 clientToken 正好 64 位 → 放行',
  T.validateNote({ content: '你好', clientToken: 'a'.repeat(64) }).value !== undefined);

check('D-33 clientToken 允许下划线和短横线（UUID 里就有短横线）',
  T.validateNote({ content: '你好', clientToken: '8f2a1c94-5b17_4e6d' }).value !== undefined);

eq('D-34 标签被 trim 且顺序不变',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: [' 工作 ', ' 想法'] }).value.tags,
  ['工作', '想法']);

eq('D-35 标签里的空白项被丢掉（不是变成空标签）',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: ['工作', '', '  '] }).value.tags,
  ['工作']);

eq('D-36 同一张笔记里重复的标签只留第一个',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: ['工作', '想法', '工作'] }).value.tags,
  ['工作', '想法']);

eq('D-37 标签超过 5 个只取前 5 个（与前端 MAX_TAGS 一致）',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).value.tags,
  ['a', 'b', 'c', 'd', 'e']);

eq('D-38 单个标签正好 50 字 → 放行（边界值）',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: ['标'.repeat(50)] }).value.tags.length, 1);

eq('D-39 tags 传 null → 当成没传（不是报错）',
  T.validateNote({ content: '你好', clientToken: 'abcdefgh', tags: null }).value.tags, []);

check('D-40 校验只回一条错误（不甩一堆，用户不知道该先改哪个）',
  (() => {
    const r = T.validateNote({ content: '', tags: 'notarray', clientToken: 'x' });
    return typeof r.error === 'string' && r.value === undefined;
  })());

check('D-41 前端能过的输入服务端也必须能过（服务端只兜底，不是"更严"）',
  (() => {
    const r = T.validateNote({
      content: '开会记一下 #工作 #想法',
      clientToken: '8f2a1c94-5b17-4e6d-9a03',
      tags: ['工作', '想法']
    });
    return r.value && r.value.tags.length === 2 && r.value.content === '开会记一下 #工作 #想法';
  })());


console.log('\nD 层｜newId / isDuplicateToken');

const id1 = T.newId();
const id2 = T.newId();
check('D-42 id 形如 n_xxx_xxxxxxxx（沿用前端既有格式）', /^n_[0-9a-z]+_[0-9a-f]{8}$/.test(id1), id1);
check('D-43 id 长度不超过 VARCHAR(32)', id1.length <= 32, id1.length + ' 位：' + id1);
check('D-44 连续生成不重复', id1 !== id2);

check('D-45 isDuplicateToken 认 mysql2 的 code=ER_DUP_ENTRY',
  T.isDuplicateToken({ code: 'ER_DUP_ENTRY' }) === true);
check('D-46 isDuplicateToken 也认 errno=1062（不同驱动给的字段不一样）',
  T.isDuplicateToken({ errno: 1062 }) === true);
check('D-47 ★ isDuplicateToken 对别的错误说 false（否则会把真故障当成重复提交吞掉）',
  T.isDuplicateToken({ code: 'ER_NO_SUCH_TABLE' }) === false &&
  T.isDuplicateToken(new Error('连接超时')) === false &&
  T.isDuplicateToken(null) === false);

check('D-48 409 的文案是中文，且告诉用户出路（"改一个字再提交"）',
  hasChinese(T.DUPLICATE_MESSAGE) && T.DUPLICATE_MESSAGE.includes('改一个字'),
  T.DUPLICATE_MESSAGE);


/* ============================================================
   B 层：GET 的 SQL 语义（SQLite 等价翻译）
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
    id           TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    client_token TEXT,
    -- Day 22 软删除两列，与 db/schema.sql 对齐（DELETE 只改标记，行还在）
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT,
    UNIQUE (client_token)
  );
  CREATE TABLE note_tags (
    note_id  TEXT NOT NULL,
    tag      TEXT NOT NULL COLLATE BINARY,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, tag),
    FOREIGN KEY (note_id) REFERENCES notes (id) ON DELETE CASCADE
  );
`);

// 与 db/seed.sql 完全一致的 6 条（client_token 都是 NULL —— 它们不是接口写进来的）
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

const insN = db.prepare('INSERT INTO notes (id, content, created_at, client_token) VALUES (?, ?, ?, ?)');
const insT = db.prepare('INSERT INTO note_tags (note_id, tag, position) VALUES (?, ?, ?)');
for (const r of seedNotes.concat(csNotes)) insN.run(r[0], r[1], r[2], null);
for (const r of seedTags.concat(csTags)) insT.run(r[0], r[1], r[2]);

// —— 直接复用函数生成 SQL 的取数流程 ——
// ⚠️ 顺序：先 parseQuery 再 buildWhere —— 和云函数入口里的顺序完全一致。
//    自检脚本第一版是直接 buildWhere(keyword, tag) 的，B 层因此报过错：
//    那时 tag 的换算还发生在参数解析里，绕过它就等于绕过了那道转换。
//    那次的结论是"那层换算本来就多余"，于是把它删了（见 read.js 的 TAG_NONE 注释）。
//    但脚本仍然按真实顺序调 —— 免得以后再冒出"两个模块之间的隐式约定被测试绕过"。
function queryNotes(keyword, tag, limit) {
  const parsed = T.parseQuery({ keyword: keyword, tag: tag, limit: limit });
  if (parsed.error) throw new Error('parseQuery 报错：' + parsed.error);
  const built = T.buildWhere(parsed.keyword, parsed.tag);
  // ★ Day 22：连"跳过已删除的"这半句也调真函数 withNotDeleted，不在这里自己拼。
  //   自己拼 'AND is_deleted = 0' 拼错了不会报错，只会让"已删的又冒出来"，
  //   而 B 层会跟着一起绿 —— 那正是最难发现的假绿。
  const sql = `SELECT n.id, n.content, n.created_at
                 FROM notes AS n
                 ${toSqlite(T.withNotDeleted(built.whereSql))}
                ORDER BY n.created_at DESC
                LIMIT ?`;
  const noteRows = db.prepare(sql).all(...built.params, parsed.limit);

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

// ★ 这一条是"拆两句 SQL"的**唯一理由**，也是最该被守住的正确性
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

eq('B-19 精确筛标签区分大小写：tag=Work 只命中 cs_UP',
  idsOf(queryNotes(null, 'Work', 200).filter((r) => isFixture(r.id))), ['cs_UP']);

eq('B-20 精确筛标签区分大小写：tag=work 只命中 cs_low',
  idsOf(queryNotes(null, 'work', 200).filter((r) => isFixture(r.id))), ['cs_low']);

eq('B-21 对照：关键词搜 Work（走正文 LIKE）两条都命中',
  idsOf(queryNotes('Work', null, 200).filter((r) => isFixture(r.id))), ['cs_UP', 'cs_low']);

db.prepare('DELETE FROM notes WHERE id = ?').run('seed_04');
eq('B-22 删笔记时标签行跟着删（ON DELETE CASCADE）',
  db.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE note_id = ?').get('seed_04').c, 0);

eq('B-23 删掉 seed_04 后全量变 5 条 seed',
  seedOnly(queryNotes(null, null, 200)).length, 5);

eq('B-24 删掉 seed_04 后「想法」只剩 seed_02',
  idsOf(seedOnly(queryNotes(null, '想法', 200))), ['seed_02']);

eq('B-25 删掉 seed_04 后搜索 seed_04 的标签也搜不到了（没有孤儿标签行）',
  idsOf(seedOnly(queryNotes('代码', null, 200))), []);


/* ============================================================
   E 层：POST 真的跑一遍
   ============================================================
   做法：用 SQLite 假造一个"长得像 mysql2 连接"的对象，喂给真函数 insertNote()。
   这样跑的是**云函数里那份写入代码**（校验后的组装、事务、错误映射全都算数），
   只有"连接"这一层被替换掉了。

   ⚠️ 替身要负责两件"方言翻译"，它们不属于被测代码：
       ① mysql2 的 `VALUES ?` 数组展开
       ② mysql2 用 code='ER_DUP_ENTRY' / errno=1062 表示唯一键冲突，
          SQLite 用的是另一个错误形状 —— 替身把它翻译过来，
          否则 insertNote 里的 isDuplicateToken 在本机永远认不出来。
   ============================================================ */
console.log('\nE 层｜真的跑 insertNote()（连接层用 SQLite 替身）');

function makeConn(sqlite, opts) {
  const o = opts || {};
  return {
    async query(sql, params) {
      const given = Array.isArray(params) ? params : [];
      let s = sql;
      let flat = given;

      if (s.indexOf('VALUES ?') !== -1) {
        const rows = given[0] || [];
        s = s.replace('VALUES ?', 'VALUES ' + rows.map(() => '(?, ?, ?)').join(', '));
        flat = [];
        for (const r of rows) for (const v of r) flat.push(v);
      }

      // ★ Day 22 补的第二种方言翻译：`IN (?)` 的数组展开。
      //   mysql2 的 query() 会把数组参数展开成 (?, ?, ?)，SQLite 不会 ——
      //   不翻译的话 findNoteById → selectTags 会直接报 Unknown named parameter。
      //   （E 层没踩到，因为 insertNote 不走 selectTags。）
      while (s.indexOf('IN (?)') !== -1) {
        const at = flat.findIndex((v) => Array.isArray(v));
        if (at === -1) break;
        const arr = flat[at];
        const holders = arr.length ? arr.map(() => '?').join(', ') : 'NULL';
        s = s.replace('IN (?)', 'IN (' + holders + ')');
        flat = flat.slice(0, at).concat(arr, flat.slice(at + 1));
      }

      // 故障注入：用来验"标签写失败时笔记要一起回滚"
      if (o.failOn && o.failOn.test(s)) {
        throw new Error('自检注入的写入失败');
      }

      try {
        if (s.trim().slice(0, 6).toUpperCase() === 'SELECT') {
          return [sqlite.prepare(s).all(...flat), []];
        }
        // ★ Day 22：affectedRows 要报真实值，不能固定给 1。
        //   markNoteDeleted() 是靠 affectedRows 判断"到底有没有改到一行"的，
        //   替身固定返回 1 的话，那个判断就永远成立、永远绿 —— 等于没测。
        const info = sqlite.prepare(s).run(...flat);
        return [{ affectedRows: info.changes }, []];
      } catch (err) {
        // 把 SQLite 的唯一键冲突翻译成 mysql2 的错误形状
        if (/UNIQUE constraint failed/i.test(String(err && err.message))) {
          const dup = new Error(String(err.message));
          dup.code = 'ER_DUP_ENTRY';
          dup.errno = 1062;
          throw dup;
        }
        throw err;
      }
    },
    async beginTransaction() { sqlite.exec('BEGIN'); },
    async commit() { sqlite.exec('COMMIT'); },
    async rollback() { sqlite.exec('ROLLBACK'); },
    release() { /* 替身不需要真的还连接 */ }
  };
}

const countByContent = (content) =>
  db.prepare('SELECT COUNT(*) AS c FROM notes WHERE content = ?').get(content).c;
const countTagsOf = (noteId) =>
  db.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE note_id = ?').get(noteId).c;
const tokenOf = (noteId) =>
  db.prepare('SELECT client_token AS t FROM notes WHERE id = ?').get(noteId).t;
const dbTimeOf = (noteId) =>
  db.prepare('SELECT created_at AS t FROM notes WHERE id = ?').get(noteId).t;

async function layerE() {
  const good = {
    content: '自检写入的内容 #自检',
    clientToken: 'selfcheck-token-0001',
    tags: ['自检', '写入']
  };

  const res = await T.insertNote(makeConn(db), good);

  check('E-01 成功返回 200 且 ok=true', res.statusCode === 200 && res.payload.ok === true,
    JSON.stringify(res));
  eq('E-02 返回的 note 正好是契约里那四个字段（多一个少一个都不行）',
    Object.keys(res.payload.note).sort(), ['content', 'createdAt', 'id', 'tags']);
  eq('E-03 content 一致', res.payload.note.content, good.content);
  eq('E-04 tags 一致（含顺序）', res.payload.note.tags, ['自检', '写入']);

  eq('E-05 ★ 数据库里真的多了一行（完成标准：数据库多一行）',
    countByContent(good.content), 1);
  eq('E-06 标签行也写进去了（两张表都写了）', countTagsOf(res.payload.note.id), 2);

  eq('E-07 ★ 返回的 createdAt 与库里那一行是同一时刻（不是各算各的）',
    dbTimeOf(res.payload.note.id), T.toDbDateTime(res.payload.note.createdAt));

  eq('E-08 库里存的 client_token 就是请求里给的那个（没有变形）',
    tokenOf(res.payload.note.id), good.clientToken);

  /* -------- ★★★ 今天最要紧的一条 ★★★ -------- */
  const dup = await T.insertNote(makeConn(db), good);

  check('E-09 ★★★ 同一个 clientToken 再提交一次 → 409，这就是今天要防的那件事',
    dup.statusCode === 409, JSON.stringify(dup));

  eq('E-10 拒绝时 ok=false，且 message 就是那条中文提示（前端会原样显示它）',
    dup.payload, { ok: false, message: T.DUPLICATE_MESSAGE });

  eq('E-11 ★ 被拒之后数据库**没有**多出第二行（拦住了，不是"报个错但照样写进去"）',
    countByContent(good.content), 1);

  check('E-12 被拒时 ok 字段是 false（前端靠它判断，不是靠 HTTP 状态码）',
    dup.payload.ok === false);

  /* -------- 边界：换 token 同内容必须放行（锁住"不做内容重复判断"这个取舍）-------- */
  const sameContentNewToken = await T.insertNote(makeConn(db), {
    content: good.content,
    clientToken: 'selfcheck-token-0002',
    tags: []
  });
  check('E-13 ★ 换一个 token、内容完全相同 → 放行（证明我们没做"内容重复"判断）',
    sameContentNewToken.statusCode === 200, JSON.stringify(sameContentNewToken));
  eq('E-14 所以同样的内容在库里可以有两行（这是故意的，不是 bug）',
    countByContent(good.content), 2);

  const nullTokens = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE client_token IS NULL').get().c;
  check('E-15 seed 和夹具那几行 client_token 都是 NULL，且互不冲突（唯一索引不约束 NULL）',
    nullTokens >= 5, nullTokens + ' 行 NULL');

  /* -------- 事务：标签写失败时，笔记必须一起回滚 -------- */
  const before = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const rollbackContent = '自检：这条应该被整体回滚 #回滚';
  let threw = false;
  try {
    await T.insertNote(makeConn(db, { failOn: /INSERT INTO note_tags/ }), {
      content: rollbackContent,
      clientToken: 'selfcheck-token-rollback',
      tags: ['回滚']
    });
  } catch (err) {
    threw = true;
  }
  check('E-16 标签写失败时异常往上抛（交给入口统一回 500），不会假装成功', threw);
  eq('E-17 ★ 回滚干净：笔记一行也没留下（事务的意义就在这一条）',
    countByContent(rollbackContent), 0);
  eq('E-18 而且总行数没变（说明不是"写了又删"，是压根没提交）',
    db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, before);

  /* -------- 写进去的，用 GET 的同一套 SQL 读得回来吗 -------- */
  const readBack = queryNotes(null, null, 200).filter((r) => r.content === good.content);
  check('E-19 ★ 写进去的笔记，用 GET 的同一套 SQL 能读回来（写入与读回对得上）',
    readBack.length === 2 && readBack.some((r) => r.tags.join(',') === '自检,写入'),
    JSON.stringify(readBack.map((r) => r.tags)));
  check('E-20 读回时标签仍是 position 顺序（不是插入时的偶然顺序）',
    readBack.some((r) => r.tags.join(',') === '自检,写入'));
  check('E-21 另一条（没给标签的那条）读回来是空数组，不是 null',
    readBack.some((r) => Array.isArray(r.tags) && r.tags.length === 0));

  /* -------- 再验一次 isDuplicateToken 与真代码的配合 -------- */
  let captured = null;
  try {
    await T.insertNote(makeConn(db), good);
  } catch (err) {
    captured = err;
  }
  // 上一句应该返回 409 而不是抛错；captured 保持 null 就是对的
  check('E-22 重复提交走的是"返回 409"这条路，不是"抛异常"（否则前端会拿到 500）',
    captured === null, captured ? String(captured.message) : '');
}


/* ============================================================
   C 层：main() 入口 —— 碰数据库之前就返回的那几支
   ============================================================
   main() 里凡是需要连库的分支，本机都测不了（没装 mysql2、也没有库）。
   但"方法不对""参数不合法""预检"在碰数据库**之前**就返回了，所以它们能测。
   这几支尤其该测：写错了不会报错，只会变成"接口返回成功但其实什么都没做"。
   ============================================================ */
console.log('\nC 层｜main 入口 —— 碰数据库之前就返回的几支');

async function layerC() {
  const post = await api.main({ httpMethod: 'POST' });
  check('C-01 POST 没有请求体 → 400（不是 405，也不是假装成功）',
    post.statusCode === 400 && JSON.parse(post.body).ok === false, JSON.stringify(post));

  // Day 22 起支持四个方法，PUT 仍然不支持（PUT 语义是"整体替换"，
  // 我们要的是"改其中几个字段"= PATCH，多一个 PUT 只会多一种误用）。
  const put = await api.main({ httpMethod: 'PUT' });
  check('C-02 PUT → 405（四个方法里没有它）',
    put.statusCode === 405, JSON.stringify(put));

  check('C-03 405 的 message 是中文，且写明支持哪四个方法',
    hasChinese(JSON.parse(put.body).message) &&
    ['GET', 'POST', 'PATCH', 'DELETE'].every((m) => JSON.parse(put.body).message.includes(m)),
    JSON.parse(put.body).message);

  // 网关给什么大小写都不该把一个正常 GET 判成 405
  const lower = await api.main({ httpMethod: 'get', queryStringParameters: { limit: '0' } });
  check('C-04 小写 get 也认（否则会误判 405）', lower.statusCode === 400, '得到 ' + lower.statusCode);

  const badLimit = await api.main({ httpMethod: 'GET', queryStringParameters: { limit: 'abc' } });
  check('C-05 limit 非法 → 400，且提示是中文（发生在碰数据库之前）',
    badLimit.statusCode === 400 && hasChinese(JSON.parse(badLimit.body).message),
    JSON.stringify(badLimit));

  const opt = await api.main({ httpMethod: 'OPTIONS' });
  check('C-06 预检 OPTIONS → 204 且没有 body（浏览器跨域 POST 之前会先问这一句）',
    opt.statusCode === 204 && opt.body === '', JSON.stringify(opt));

  // ★ 这一条存在的唯一目的，是守住"先校验、再取连接"这个顺序。
  //   顺序一旦被改回去，C-01/C-05/C-07 会变成 500（装了 mysql2 的机器）
  //   或者直接崩（本机没装）—— 两种表现都难查，所以单独守一条。
  const missingToken = await api.main({
    httpMethod: 'POST',
    body: JSON.stringify({ content: '你好' })
  });
  check('C-07 ★ 缺 clientToken → 400（守住"校验在取连接之前"这个顺序）',
    missingToken.statusCode === 400 && hasChinese(JSON.parse(missingToken.body).message),
    JSON.stringify(missingToken));

  check('C-08 返回是结构化形式：statusCode + headers + body 字符串',
    typeof post.statusCode === 'number' && typeof post.body === 'string' &&
    String(post.headers['Content-Type']).includes('application/json'),
    Object.keys(post).join(','));

  check('C-09 body 能 JSON.parse，不是双重编码',
    (() => { try { return typeof JSON.parse(post.body) === 'object'; } catch (e) { return false; } })());

  check('C-10 响应头带上了跨域预检需要的几个头（前端将来才不会被浏览器拦）',
    ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'].every(
      (m) => String(post.headers['Access-Control-Allow-Methods']).includes(m)),
    String(post.headers['Access-Control-Allow-Methods']));

  // 这条是"给自检自己上的保险"：常量或函数一旦改名，
  // 上面那些断言会读到 undefined 而静默失败 —— 那才是最坏的情况（脚本假绿）。
  // （parseParams 改名 parseQuery、删掉 TAG_NONE_SENTINEL，都是被这条真拦下来的。）
  const need = [
    'parseQuery', 'buildWhere', 'withNotDeleted', 'TAG_NONE', 'LIMIT_DEFAULT', 'LIMIT_MAX',
    'parseBody', 'validateNote', 'insertNote', 'newId', 'isDuplicateToken',
    'MAX_LENGTH', 'MAX_TAGS', 'MAX_TAG_LENGTH', 'TOKEN_MIN', 'TOKEN_MAX',
    'DUPLICATE_MESSAGE', 'toIsoUtc', 'toDbDateTime', 'ok', 'fail',
    // Day 22 新增：改 / 删
    'validatePatch', 'updateNote', 'deleteNote', 'pickId', 'normalizeTags',
    'NOT_FOUND_MESSAGE', 'MISSING_ID_MESSAGE'
  ];
  const missing = need.filter((k) => T[k] === undefined);
  check('C-11 导出面没变：__test__ 里该有的都在（防改名让自检悄悄失效）',
    typeof api.main === 'function' && missing.length === 0,
    missing.length ? '缺 ' + missing.join(',') : Object.keys(T).length + ' 个导出');

  check('C-12 契约里的默认值与上限和代码一致（5000 字 / 5 个标签 / token 8~64）',
    T.MAX_LENGTH === 5000 && T.MAX_TAGS === 5 && T.TOKEN_MIN === 8 && T.TOKEN_MAX === 64,
    [T.MAX_LENGTH, T.MAX_TAGS, T.TOKEN_MIN, T.TOKEN_MAX].join('/'));

  check('C-13 ok() / fail() 的信封与契约一致',
    JSON.stringify(T.ok({ notes: [] })) === '{"statusCode":200,"payload":{"ok":true,"notes":[]}}' &&
    JSON.stringify(T.fail(409, '重复提交')) === '{"statusCode":409,"payload":{"ok":false,"message":"重复提交"}}',
    JSON.stringify(T.ok({ notes: [] })));
}


/* ============================================================
   H 层：PATCH / DELETE 真的跑一遍（Day 22 新增）
   ============================================================
   和 E 层同一套办法：SQLite 替身顶掉"连接"这一层，
   跑的是云函数里**真的那份** updateNote() / deleteNote()。

   今天最要紧的三条，都写成了断言：
     H-14 删完之后**行还在库里**（软删除，不是真删）
     H-16 删完之后 GET 列表里查不到（跳过的那一半生效了）
     H-19 一句 UPDATE 就能改回来（"删错了还能找回"不是一句承诺，是被跑过的）

   顺序上，H 放在 C 之后、F 之前：它要往库里写东西，
   而 F 层只看源码文本，不受影响。
   ============================================================ */
console.log('\nH 层｜真的跑 updateNote() / deleteNote()（连接层同样是 SQLite 替身）');

/** 取一行笔记的软删除状态 */
const rowState = (noteId) =>
  db.prepare('SELECT is_deleted AS d, deleted_at AS t FROM notes WHERE id = ?').get(noteId);

async function layerH() {
  /* ---------- 先备一条"待改、待删"的笔记（用真代码写进去）---------- */
  const made = await T.insertNote(makeConn(db), {
    content: 'Day 22 自检：这条会被改一次，然后被删掉 #自检',
    clientToken: 'selfcheck-token-day22',
    tags: ['自检', '待删']
  });
  check('H-01 前置：这条待改待删的笔记写进去了',
    made.statusCode === 200, JSON.stringify(made));
  const id = made.payload.note.id;
  const createdAt = made.payload.note.createdAt;

  /* ============================================================
     第一部分：validatePatch（纯函数，不碰数据库）
     ============================================================ */
  const noId = T.validatePatch({}, { content: '改点什么' });
  check('H-02 PATCH 缺 id → 拦下，且提示是中文（"要改哪一条"必须说清楚）',
    !!noId.error && hasChinese(noId.error), JSON.stringify(noId));

  const nothing = T.validatePatch({ id: id }, {});
  check('H-03 content 和 tags 一个都不给 → 拦下（否则就是"返回成功但什么都没做"）',
    !!nothing.error && hasChinese(nothing.error), JSON.stringify(nothing));

  const onlyContent = T.validatePatch({ id: id }, { content: '只改正文' });
  eq('H-04 只给 content → value 里 content 有值、tags 是 undefined（未给的字段不动）',
    [onlyContent.value && onlyContent.value.content, onlyContent.value && onlyContent.value.tags],
    ['只改正文', undefined]);

  const onlyTags = T.validatePatch({ id: id }, { tags: ['甲'] });
  eq('H-05 只给 tags → content 是 undefined',
    [onlyTags.value && onlyTags.value.content, onlyTags.value && onlyTags.value.tags],
    [undefined, ['甲']]);

  const fromQuery = T.validatePatch({ id: id }, { content: '从查询参数拿 id' });
  eq('H-06 id 可以来自查询参数 ?id=（前端用 PATCH /api/notes?id=xxx）',
    fromQuery.value && fromQuery.value.id, id);

  const fromBody = T.validatePatch({}, { id: id, content: '从请求体拿 id' });
  eq('H-07 id 也可以来自请求体（两条路都通，免得某个客户端发不出去）',
    fromBody.value && fromBody.value.id, id);

  check('H-08 PATCH 不要求 clientToken（幂等键是防重复**新建**的，改已有的笔记不需要）',
    !T.validatePatch({ id: id }, { content: '没给 token 也该过' }).error);

  /* ---------- 标签的兜底规则与 POST 完全共用一处 ---------- */
  const messy = T.validatePatch({ id: id }, {
    tags: ['  甲  ', '甲', '', '乙', '丙', '丁', '戊', '己']
  });
  eq('H-09 ★ 标签走的是与 POST 同一套兜底：去空白、去重、截断到 5 个',
    messy.value && messy.value.tags, ['甲', '乙', '丙', '丁', '戊']);

  const badTags = T.validatePatch({ id: id }, { tags: '不是数组' });
  check('H-10 tags 不是数组 → 拦下且提示是中文',
    !!badTags.error && hasChinese(badTags.error), JSON.stringify(badTags));

  const emptyContent = T.validatePatch({ id: id }, { content: '   ' });
  check('H-11 content 只有空白 → 拦下（不能把正文改成空的）',
    !!emptyContent.error && hasChinese(emptyContent.error), JSON.stringify(emptyContent));

  /* ============================================================
     第二部分：updateNote —— 真的改
     ============================================================ */
  const ghost = await T.updateNote(makeConn(db), { id: 'n_根本不存在', content: '改它' });
  check('H-12 ★ 改一条不存在的 → 404（不是静默成功）',
    ghost.statusCode === 404, JSON.stringify(ghost));
  eq('H-13 404 的 message 就是契约里那句中文（前端会原样显示）',
    ghost.payload, { ok: false, message: T.NOT_FOUND_MESSAGE });

  const patched = await T.updateNote(makeConn(db), { id: id, content: 'Day 22：正文被改过了' });
  check('H-14 改正文 → 200 且 ok=true',
    patched.statusCode === 200 && patched.payload.ok === true, JSON.stringify(patched));
  eq('H-15 ★ 正文真的变了', patched.payload.note.content, 'Day 22：正文被改过了');
  eq('H-16 ★ 只给了 content，标签**原样保留**（PATCH 不是整体替换）',
    patched.payload.note.tags, ['自检', '待删']);
  eq('H-17 ★ createdAt **没有**被改动（创建时间不该因为编辑而变）',
    patched.payload.note.createdAt, createdAt);
  eq('H-18 返回的仍是契约里那四个字段',
    Object.keys(patched.payload.note).sort(), ['content', 'createdAt', 'id', 'tags']);

  const patched2 = await T.updateNote(makeConn(db), { id: id, tags: ['新标签A', '新标签B'] });
  eq('H-19 ★ 改标签 → 整批替换：旧的「自检/待删」都没了',
    patched2.payload.note.tags, ['新标签A', '新标签B']);
  eq('H-20 整批替换后库里的标签行数就是新的两个（不是追加成 4 个）',
    countTagsOf(id), 2);
  eq('H-21 没给 content，正文保持上一次改过的值',
    patched2.payload.note.content, 'Day 22：正文被改过了');

  /* ============================================================
     第三部分：deleteNote —— 删，但只是打标记
     ============================================================ */
  const ghostDel = await T.deleteNote(makeConn(db), 'n_根本不存在');
  check('H-22 ★ 删一条不存在的 → 404（**绝不**静默成功 —— 删除的假成功最可怕）',
    ghostDel.statusCode === 404, JSON.stringify(ghostDel));

  const before = db.prepare('SELECT COUNT(*) AS c FROM notes').get().c;
  const del = await T.deleteNote(makeConn(db), id);
  check('H-23 删 → 200 且 ok=true',
    del.statusCode === 200 && del.payload.ok === true, JSON.stringify(del));
  eq('H-24 返回里带被删的 id（对得上删的是哪一条）', del.payload.deleted.id, id);
  check('H-25 返回里带删除时刻 at，是 ISO 串',
    typeof del.payload.deleted.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(del.payload.deleted.at),
    String(del.payload.deleted.at));

  eq('H-26 ★★★ 行**还在库里** —— 软删除的证据（真删的话这一条会是 0）',
    db.prepare('SELECT COUNT(*) AS c FROM notes WHERE id = ?').get(id).c, 1);
  eq('H-27 ★ 总行数也一点没少（DELETE 只改标记，不删行）',
    db.prepare('SELECT COUNT(*) AS c FROM notes').get().c, before);
  eq('H-28 ★ is_deleted 被打成了 1', rowState(id).d, 1);
  eq('H-29 ★ deleted_at 与返回的 at 是同一时刻（两个方向都对得上）',
    rowState(id).t, T.toDbDateTime(del.payload.deleted.at));

  eq('H-30 ★ 标签行**没被删**（恢复的时候整条笔记才是完整的）', countTagsOf(id), 2);

  check('H-31 ★ 删完之后，用 GET 的同一套 SQL 查不到了（"查询时跳过"那一半生效）',
    !queryNotes(null, null, 200).some((r) => r.id === id),
    JSON.stringify(queryNotes(null, null, 200).map((r) => r.id)));

  const again = await T.deleteNote(makeConn(db), id);
  check('H-32 ★ 再删一次 → 404（已经删过的不能再删，也不假装成功）',
    again.statusCode === 404, JSON.stringify(again));

  const patchDeleted = await T.updateNote(makeConn(db), { id: id, content: '改一条已删的' });
  check('H-33 ★ 已删除的笔记也改不动（404，不会把删掉的东西改活）',
    patchDeleted.statusCode === 404, JSON.stringify(patchDeleted));

  /* ---------- ★★★ 今天最想证明的一件事：删错了能找回来 ---------- */
  db.prepare('UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?').run(id);
  check('H-34 ★★★ 一句 UPDATE 就把删掉的笔记找回来了（这就是软删除的全部意义）',
    queryNotes(null, null, 200).some((r) => r.id === id),
    JSON.stringify(queryNotes(null, null, 200).map((r) => r.id)));
  eq('H-35 恢复后标签是完整的两个（所以当初不该删标签行）',
    tagsOf(queryNotes(null, null, 200), id), ['新标签A', '新标签B']);

  const afterRecover = await T.updateNote(makeConn(db), { id: id, content: '恢复之后还能继续改' });
  check('H-36 恢复之后这条笔记能正常继续编辑',
    afterRecover.statusCode === 200 && afterRecover.payload.note.content === '恢复之后还能继续改',
    JSON.stringify(afterRecover));

  /* ============================================================
     第四部分：main() 入口 —— 碰数据库之前就返回的几支
     ============================================================ */
  const patchNoBody = await api.main({ httpMethod: 'PATCH' });
  check('H-37 PATCH 不带请求体 → 400（要改什么都不知道）',
    patchNoBody.statusCode === 400 && hasChinese(JSON.parse(patchNoBody.body).message),
    JSON.stringify(patchNoBody));

  const patchNoId = await api.main({
    httpMethod: 'PATCH',
    body: JSON.stringify({ content: '改点什么' })
  });
  check('H-38 PATCH 缺 id → 400，提示是中文',
    patchNoId.statusCode === 400 && hasChinese(JSON.parse(patchNoId.body).message),
    JSON.stringify(patchNoId));

  const delNoId = await api.main({ httpMethod: 'DELETE' });
  check('H-39 DELETE 不带 id → 400（不指名就不删，绝不批量删）',
    delNoId.statusCode === 400, JSON.stringify(delNoId));
  eq('H-40 缺 id 的提示就是那句中文（前端原样显示）',
    JSON.parse(delNoId.body).message, T.MISSING_ID_MESSAGE);

  check('H-41 DELETE 不带请求体也能走 —— id 从查询参数取（很多客户端发 DELETE 不带 body）',
    await api.main({ httpMethod: 'DELETE', queryStringParameters: { id: id } })
      .then((r) => r.statusCode !== 400),
    '被 400 拦下了，说明 DELETE 强制要求 body');

  check('H-42 方法名小写 patch 也认（网关给什么大小写都不该误判成 405）',
    (await api.main({ httpMethod: 'patch', body: JSON.stringify({}) })).statusCode === 400);

  /* ---------- ★ 跨域允许的方法名单必须跟上四个方法 ---------- */
  // 少写 PATCH / DELETE 的话，浏览器的预检会先失败，
  // 而报错长得像"接口挂了"—— 排查时会从完全错误的地方开始。
  // 这条断言就是为了把"改了路由却忘了改响应头"堵在出门前。
  const allowMethods = String(
    (await api.main({ httpMethod: 'OPTIONS' })).headers['Access-Control-Allow-Methods']);
  check('H-43 ★ 跨域 Allow-Methods 里 PATCH / DELETE 都在（否则前端会在预检被拦）',
    allowMethods.includes('PATCH') && allowMethods.includes('DELETE'), allowMethods);
}


/* ============================================================
   F 层：分层守卫（Day 19 新增）
   ============================================================
   规矩（写进 README 约束 18）：
     **全项目只有 repository.js 里出现 SQL 语句和 conn.query / 事务调用。**
   read.js / write.js 只调用仓库，自己一句 SQL 都不写。

   为什么要把这件事写成断言：
   重构最容易出的问题不是"这次改错了"（那会当场报错），
   而是**过一阵又长回去** —— 某天为了让某个小功能跑起来，
   顺手在 read.js 里插一句 conn.query，功能立刻就好了、测试也全绿，
   没人发现分层已经名存实亡。等下次换数据库时才会发现"改一处"变成了"改八处"。

   做法：直接读源码文本来断言"哪一层写了什么"。
   这是这个脚本里唯一一层不看行为的 —— 因为它要守的本来就不是行为，是形状。
   ★ 会先剥掉注释再找关键字：注释里写"这里为什么不用 SELECT"是正常的，
     不该被当成"这一层有 SQL"（本项目的注释里确实到处在提 SQL）。
   ============================================================ */
console.log('\nF 层｜分层守卫 —— SQL 与 conn.* 只许待在 repository.js');

const LAYER_FILES = ['index.js', 'http.js', 'db.js', 'read.js', 'write.js'];

const sourceOf = (file) => fs.readFileSync(path.join(FN_DIR, file), 'utf8');

/** 剥掉注释：块注释 + 行注释（行注释要求 // 前面不是冒号，免得误伤 https:// ）*/
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

const layerSrc = {};
for (const f of LAYER_FILES) layerSrc[f] = stripComments(sourceOf(f));
const repoCode = stripComments(sourceOf('repository.js'));

function layerF() {
  // -------- F-01 ~ F-05：上层文件里不许出现"跟数据库说话"的调用 --------
  LAYER_FILES.forEach((f, i) => {
    const hit = /conn\.(query|execute)\s*\(/.exec(layerSrc[f]);
    check(
      'F-' + String(i + 1).padStart(2, '0') + ' ' + f + ' 里没有 conn.query / conn.execute',
      hit === null,
      hit ? '发现了 ' + hit[0] : ''
    );
  });

  // -------- F-06：事务也一样，只能待在仓库里 --------
  const txFiles = LAYER_FILES.filter((f) =>
    /conn\.(beginTransaction|commit|rollback)\s*\(/.test(layerSrc[f]));
  check('F-06 上层文件里没有事务调用（beginTransaction / commit / rollback）',
    txFiles.length === 0, txFiles.join(','));

  /* -------- F-07：剥掉注释后，上层文件里查不到 SQL **语句** --------
     ★ Day 22 修正（这条断言自己出过一次假红，值得记下来）：
       原来只查单个关键字 `SELECT|INSERT|UPDATE|DELETE`，
       结果 index.js 的 HTTP 方法表 `['GET','POST','PATCH','DELETE']`
       里那个 'DELETE' 被当成 SQL —— 它是方法名，不是语句。
       假红的坏处不是报错，是**让人开始不信这个脚本**：
       下次真有 SQL 漏上去，很可能被当成"又是误报"直接忽略。

       所以改成"关键字 + 搭档"才算一句话：
         SELECT..FROM / INSERT INTO / UPDATE..SET / DELETE FROM / REPLACE INTO
       方法名、提示语里的方法名都凑不出这种组合（"DELETE" 后面没有 FROM），
       而项目里的真实 SQL 一定带搭档。
       距离限制 200 字符，免得隔着半个文件把两个词硬凑成一句。 */
  const SQL_SNIPPETS = [
    ['SELECT ... FROM', /\bSELECT\b[\s\S]{0,200}?\bFROM\b/i],
    ['INSERT INTO', /\bINSERT\s+INTO\b/i],
    ['UPDATE ... SET', /\bUPDATE\b[\s\S]{0,200}?\bSET\b/i],
    ['DELETE FROM', /\bDELETE\s+FROM\b/i],
    ['REPLACE INTO', /\bREPLACE\s+INTO\b/i]
  ];

  const sqlHits = [];
  for (const f of LAYER_FILES) {
    for (const [name, re] of SQL_SNIPPETS) {
      if (re.test(layerSrc[f])) sqlHits.push(f + ' 里像是有 ' + name);
    }
  }
  check('F-07 上层文件里查不到 SQL 语句（SELECT..FROM / INSERT INTO / UPDATE..SET / DELETE FROM）',
    sqlHits.length === 0, sqlHits.join('；'));

  // -------- F-08：反着再守一条，防上面几条变成"空转"--------
  // 上面 7 条都是"某处**不该有**什么"。万一将来把所有 SQL 挪走、
  // 或者换个写法（比如用 string 拼接绕开关键字），它们照样全绿 —— 假绿。
  // 所以必须同时断言"该有的地方确实有"。
  const hasSelect = /SELECT/i.test(repoCode);
  const hasInsert = /INSERT\s+INTO/i.test(repoCode);
  const hasQuery = /conn\.query\s*\(/.test(repoCode);
  const hasTx = /beginTransaction\s*\(/.test(repoCode);
  check('F-08 ★ 仓库里确实有 SELECT / INSERT / conn.query / beginTransaction（否则上面几条是空转）',
    hasSelect && hasInsert && hasQuery && hasTx,
    ['SELECT=' + hasSelect, 'INSERT=' + hasInsert, 'query=' + hasQuery, 'tx=' + hasTx].join(' '));

  // -------- F-09：数据访问层不该知道 HTTP --------
  check('F-09 仓库不 require ./http（数据层不该知道「响应长什么样」）',
    !/require\(\s*'\.\/http'\s*\)/.test(repoCode));

  // -------- F-10：读/写两个上层确实都走仓库（而不是绕开它自己开一条路）--------
  check('F-10 read.js / write.js 都 require 了 repository（证明它们真的经过这一层）',
    /require\(\s*'\.\/repository'\s*\)/.test(layerSrc['read.js']) &&
    /require\(\s*'\.\/repository'\s*\)/.test(layerSrc['write.js']));

  /* -------- F-11：给 F-07 自己上一道保险 --------
     F-07 是"不该有什么"的断言，天生容易空转：
     把它的正则改窄一点（比如只留 REPLACE INTO），上层就算写满 SQL 也照样全绿。
     所以反过来断言：同一套规则用在 repository.js 上，该命中的必须都命中。
     （REPLACE INTO 是顺手加的防御项，项目里没用到，不强求命中。） */
  const MUST_HIT = ['SELECT ... FROM', 'INSERT INTO', 'UPDATE ... SET', 'DELETE FROM'];
  const notHit = SQL_SNIPPETS
    .filter(([name]) => MUST_HIT.indexOf(name) !== -1)
    .filter(([, re]) => !re.test(repoCode))
    .map(([name]) => name);
  check('F-11 ★ F-07 那套规则在 repository.js 上确实命中（否则 F-07 可能是空转的假绿）',
    notHit.length === 0, notHit.length ? '没命中：' + notHit.join(',') : '');
}


/* ============================================================
   G 层：health 云函数冒烟（Day 19 新增）
   ============================================================
   "全接口回归"里的另一个接口。health 不连库、逻辑简单，
   但它恰恰是排查问题时**第一个要打的**那个（见 health/index.js 的说明）：
   它要是坏了，后面所有"接口怎么不通了"的排查都会从错误的地方开始。
   所以回归要把每个接口都盖到，简单的也不例外。
   ============================================================ */
console.log('\nG 层｜health 冒烟 —— 另一个已上线的接口一起回归');

async function layerG() {
  const health = require(path.join(__dirname, '..', '..', 'cloudbase-functions', 'health', 'index.js'));
  const healthPkg = require(path.join(__dirname, '..', '..', 'cloudbase-functions', 'health', 'package.json'));

  const a = await health.main({}, { namespace: 'self-check-env' });

  check('G-01 health 返回 ok=true / service=notelab（认人用的暗号对得上）',
    !!a && a.ok === true && a.service === 'notelab', JSON.stringify(a));

  check('G-02 health 的 version 与它自己的 package.json 一致（发布对版本）',
    !!a && a.version === healthPkg.version,
    (a && a.version) + ' vs ' + healthPkg.version);

  // 时间戳是"现算的"还是"缓存"的分界线（DEPLOY.md 部署后核对也靠这一条）
  await new Promise((r) => setTimeout(r, 5));
  const b = await health.main({}, {});
  check('G-03 health 的 time 每次调用都不同（说明是现算的，不是缓存的旧响应）',
    !!a && !!b && a.time !== b.time, (a && a.time) + ' / ' + (b && b.time));

  check('G-04 health 能报出环境标识（公网上地址长得都差不多，靠它认环境）',
    !!a && a.env === 'self-check-env', a && String(a.env));
}


/* ============================================================
   结果
   ============================================================ */
function finish() {
  const total = pass + failures.length;
  console.log('\n' + '='.repeat(64));
  console.log('自检结果：' + pass + '/' + total + ' 通过');
  console.log('='.repeat(64));

  console.log('\n⚠️ 明确**没有**被验证的部分（别当成已验过）：');
  console.log('  1. MySQL 的 COLLATE utf8mb4_unicode_ci 对非 ASCII 的大小写折叠');
  console.log('     （B 层的 LIKE 只对 ASCII 不区分大小写，中文没有大小写，验不出差异）');
  console.log('  2. mysql2 的 query() 对 IN (?) / VALUES ? 的真实数组展开');
  console.log('     （E 层的替身自己实现了这个展开，所以它验不了 mysql2 自己做得对不对）');
  console.log('  3. DATETIME(3) 经 mysql2 dateStrings 回传的真实格式（本机无 MySQL）');
  console.log('  4. HTTP 访问服务下 event.queryStringParameters / event.body 是否真的按文档给值');
  console.log('  5. 配了 VPC 之后函数能否真的连上库（要有环境才能试）');
  console.log('  6. 网关吃不吃 {statusCode, headers, body} 这种结构化返回');
  console.log('     不吃就得改 http.js 的 toResponse（改一处，两个接口一起生效）');
  console.log('  7. 真 MySQL 上唯一键冲突到底报成什么（替身按 ER_DUP_ENTRY/1062 翻译，');
  console.log('     若 MySQL 给的是别的 code，isDuplicateToken 就认不出来 → 会变成 500 而不是 409）');
  console.log('  8. 真 MySQL 上事务回滚的行为（InnoDB 与 SQLite 的实现不同）');
  console.log('  9. 真 MySQL 上唯一索引对 NULL 的放行（理论上允许任意多 NULL）');
  console.log(' 10. OPTIONS 预检能不能穿过 CloudBase 的 HTTP 网关到达函数');
  console.log(' 11. 真 MySQL 上加 `is_deleted` 两列的 ALTER TABLE 顺不顺利（Day 22 新加的列，');
  console.log('     本机 SQLite 夹具是建表时就带上的，验不到"给已有数据的表加列"这一步）');
  console.log(' 12. 真 MySQL 上 UPDATE 的 affectedRows 语义（SQLite 与 MySQL 的"变化行数"定义');
  console.log('     不完全一样；markNoteDeleted 靠它判断，已在代码里用"先查再删"绕开了）');
  console.log(' 13. H 层的"恢复"是自检脚本自己写的一句 UPDATE，不是产品功能 ——');
  console.log('     真正的后悔药是 db/README.md 里那条人工 SQL，界面上的撤销还没做（C2）');
  console.log('\n以上 4～13 靠部署后的核对步骤验，见 DEPLOY.md 文末附录第 6 步。');

  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
}

layerE()
  .then(layerC)
  .then(layerH)
  .then(layerF)
  .then(layerG)
  .then(finish)
  .catch((err) => {
    console.error('\n自检脚本自己崩了：', err);
    process.exitCode = 1;
  });
