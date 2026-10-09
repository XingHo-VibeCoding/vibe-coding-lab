# notelab-api-check｜云函数自检（Day 17 建立）

## 什么时候跑

改了这些东西之后**必须先跑一次再提交**：

- `cloudbase-functions/notes/index.js`（尤其 `parseParams` / `buildWhere` / `toIsoUtc`）
- `db/schema.sql` 里 `notes` / `note_tags` 的列
- `db/seed.sql`（B 层的断言是照着这 6 条 seed 写死的）

```bash
node skills/notelab-api-check/check.cjs
```

要求 **Node 22+**（用的是内置 `node:sqlite`）。**不需要装任何依赖**，
不需要 mysql2，也不需要数据库 —— 这一点是故意的：
本机没有 CloudBase 环境，能验的部分要在没环境的时候也能验。

记录本次结果：全绿（71/71）再提交；有失败项时脚本会以退出码 1 结束。

---

## 为什么分三层

前端的 `notelab-filter-check` 之所以分行为层 + 可见层，是因为
**桩测试能证明"代码是对的"，证明不了"用户看得见"**（Day 13 栽过一次）。
云函数这边是**同一类问题换了个位置**，所以也分层：

| 层 | 验什么 | 为什么非有不可 |
|---|---|---|
| **A 层** | 直接 require 云函数文件，断言它**自己的**纯函数 | 跑的是真代码，不是另抄一份。另抄一份的问题是"仿制品全绿、真代码有 bug" |
| **B 层** | 把函数**真实生成的 SQL** 机械翻译成 SQLite 方言，跑真数据 | SQL 的语义只能拿真数据验；但本机没有 MySQL |
| **C 层** | 调 `main()` 本身，只测"碰数据库之前"就返回的几支（405 / 400） | 写错了不会报错，只会变成"接口返回成功但什么都没做" |

**A 层里最值钱的一条**：SQL 里的 `?` 个数必须等于参数个数。
写错的后果是运行时才报数据库的错，报的不是"你少传了一个参数" ——
所以它必须在本地被拦死，六个组合逐个核。

**C 层里最值钱的一条**：`main({httpMethod:'POST'})` 必须回 405。
否则一个 POST 会落到 GET 分支，返回一份**看起来成功、其实什么都没写**的数据。

---

## 明确**没**验到的（不要当成已验过）

脚本每次运行都会把这些打印出来，这是刻意的 ——
这个项目连着几天被"看起来正常"骗过（Day 13 四种状态没有入口、
Day 14 无头浏览器窗口宽度 504 的下限），所以**验证的边界要写在输出里**：

1. MySQL 的 `COLLATE utf8mb4_unicode_ci` 对非 ASCII 的大小写折叠
2. mysql2 的 `query()` 对 `IN (?)` 的数组展开
3. `DATETIME(3)` 经 mysql2 `dateStrings` 回传的真实格式
4. HTTP 访问服务下 `event.queryStringParameters` 是否真的有值
5. 配了 VPC 之后函数能否真的连上库
6. 网关吃不吃 `{statusCode, headers, body}` 这种结构化返回
   → 第 6 条有明确的部署后核对步骤，见 `DEPLOY.md` 文末附录第 6 步第 3 条

---

## 三层重复踩过的坑（新增一个就写进来）

1. **测试绕过被测代码的调用顺序**：B 层第一版直接调 `buildWhere(keyword, tag)`，
   跳过了 `parseParams` —— 而当时 `tag` 的换算正发生在 `parseParams` 里，
   于是 B-11 报错。查下去发现"那层换算本来就多余"，把它删了。
   但脚本仍然按**真实顺序**调（先 `parseParams` 再 `buildWhere`）。
   教训：测试要跟着真流程走，否则要么漏 bug，要么报假警。
2. **别写恒真断言**：C-07 第一版写成了一个恒真的表达式（绿得毫无意义）。
   现在是"守住导出面"——常量一经改名，上面所有断言会读到 `undefined` 而**静默失败**，
   那才是最坏的情况（脚本假绿）。当天改的 `TAG_NONE_SENTINEL` 就是活例子。
3. **SQLite 外键默认是关的**（Day 16 就栽过）：任何用 `ON DELETE CASCADE` 的断言，
   前面必须 `PRAGMA foreign_keys = ON`，否则删除不级联、断言报一个看不懂的错。
