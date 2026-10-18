# DEPLOY.md｜部署指南（Day 15 立，Day 17 续，Day 18 补写接口，Day 20 补公网首页）

> 注册那一步（课程附录 M）只能你自己做：要登录腾讯账号、手机验证。
> 装好后剩下的每一步，这份文件给出控制台点法。**控制台界面和我描述的对不上时，
> 以课程附录 M 为准**——腾讯的界面隔几个月会改版，菜单名可能有出入。

---

## 你要做的事

| # | 事 | 大概耗时 | 我能帮忙的程度 |
|---|---|---|---|
| ① | 注册并开通 CloudBase 环境 | 10–15 分钟 | 帮不了（要你本人账号） |
| ② | 部署 `/api/health` 云函数 | 5 分钟 | 代码我已写好，在 `cloudbase-functions/health/` |
| ③ | 部署前端 mock 版页面（静态托管） | 5 分钟 | 文件就是现有那 4 个，原样上传 |
| ④ | 建库建表 + 部署 `/api/notes`（读 + 写同一函数） | 20 分钟 | 代码和 SQL 都已写好并在本机验过，见文末附录 |

① 不做，②③④ 全都做不了（没有环境就没有地方部署）。**所以第 ① 步是唯一的硬阻塞。**

---

## ① 注册并开通（按课程附录 M）

1. 打开 [console.cloud.tencent.com](https://console.cloud.tencent.com)，
   用手机号 / QQ / 微信登录（选你平时用的那个，**以后一直用它**）
2. 进「云开发 CloudBase」→ 首次会让你「创建环境」：
   - 环境名随手填（比如 `notelab`）
   - 计费选**按量付费的基础版/免费额度**（个人学习够用，先不花钱）
3. 创建完，控制台首页能看到**环境 ID**（形如 `cloud1-3g1xxxxx`）
   ——**把它记下来发给我**，这是今天最重要的一个信息

> 开通时的套餐/额度政策以你课程附录 M 的说法为准，别为这个多花钱。

---

## ② 部署 /api/health 云函数

1. 控制台左侧「云函数」→「函数管理」→「新建」（或「创建函数」）
2. 按下面填：
   - 函数名：`health`
   - 运行环境：**Node.js 16.13**（或列表里最新的 16.x）
   - 创建方式：**空白函数**（不用模板）
   - 高级设置里的内存 128MB / 超时 3 秒，默认就行
3. 创建完进入这个函数 →「函数代码」页签 → **上传方式选「文件夹上传」**，
   选中 `C:\D\Projects\vibe-coding-lab\cloudbase-functions\health` 整个文件夹
   （里面就两个文件：`index.js` + `package.json`，都要传）
4. 关键一步：开启 **HTTP 访问（云接入）**——
   左侧「云函数」→「HTTP 访问服务」（有的版本叫「云接入」或「HTTP 触发」）
   → 开启 → 新建路径：**路径填 `/api/health`，关联函数选 `health`**
5. 浏览器打开它给的地址（形如 `https://<环境ID>.service.tcloudbase.com/api/health`）

**看到这样的 JSON 就成了**：

```json
{"ok":true,"service":"notelab","version":"0.1.0","time":"2026-10-01T...","env":"..."}
```

> 卡住降级（任务清单里写了）：**先只保证这一步通**。前端部署受阻的话，
> 把报错截图发我，Day 20 前补齐即可。

---

## ③ 部署前端 mock 版页面（静态托管）

1. 控制台左侧「静态网站托管」→ 开通（首次会提示，按量付费基础版即可）
2. 「文件管理」→「上传文件夹」不行的话就**逐个上传文件**——需要这 5 个
   （Day 20 起多了 `api.js`，少传它页面会取不到云端数据）：

```
index.html     页面结构
styles.css     样式
app.js         全部逻辑
mock-data.js   假数据（演示模式用）
api.js         Day 20 新增：真实接口的取数（含接口地址配置）
```

   > ⚠️ `skills/`、`*.md`、`cloudbase-functions/` 都**不用传**——那是开发用的，不是页面要跑的。
3. 上传完点「访问」（或用它的默认域名，形如
   `https://<环境ID>.tcloudbaseapp.com/index.html` 或 `…/<环境ID>.index.html`）

**手机上打开这个地址，页面能写笔记、能切三个视图，就成了。**

---

## 部署成功后，立刻做三个确认（今天要掌握的那件事）

**公网地址第一次打开，第一个要确认的不是"能不能打开"，而是"打开的是不是我刚部署的那个版本"。**
理由：公网地址背后可能是**默认函数、旧缓存、或者干脆是别人的环境**——
200 谁都会返回，版本不对你白高兴。这也是这个项目连着两天被"看起来正常"骗过之后，
我给自己立的规矩：先认人，再谈好坏。

| 确认什么 | 怎么确认 |
|---|---|
| health 是**我的**版本 | JSON 里 `version` 是 `0.1.0`、`service` 是 `notelab`（这是埋进代码里的暗号，默认函数没有） |
| health 不是**缓存** | 刷新两次，`time` 字段会变（缓存的时间戳不变） |
| 前端是**最新**版本 | 手机页面上，「全部笔记」列表下有「打开演示模式 →」那一行（Day 13 才加的，旧版/传错文件夹都没有） |

---

## 要发回给我的东西

1. **环境 ID**（一串 `cloud1-…`）
2. `/api/health` 的公网地址 + 返回的 JSON
3. 前端页面的公网地址
4. 三张截图（按任务清单）：
   - 云函数公网地址的返回（地址栏 + JSON 都在画面里）
   - 前端公网页面（同伴手机上打开的样子）
   - 控制台环境信息（环境 ID、剩余额度、到期日期）

拿到 1 我就把环境 ID 填进 `api-contract.md` 的 Base URL，然后提交推送收尾。

---

## 附录：Day 17 续——建库 + 部署读接口 `GET /api/notes`

### 先说结论：代码已经写好了

在 `cloudbase-functions/notes/`（`index.js` + `package.json`）。
"云函数怎么连这个环境的 MySQL"这一步**我去查了官方文档照着写的，不是猜的**：

- 怎么连：<https://docs.cloudbase.net/cloud-function/resource-integration/mysql>
- 环境变量怎么用：<https://docs.cloudbase.net/cloud-function/function-configuration/env>
- 函数怎么读 HTTP 入参：<https://docs.cloudbase.net/service/access-cloud-function>

本机自检 **71/71 通过**（跑法：`node skills/notelab-api-check/check.cjs`）。
但要说清楚它**验到了哪**——A 层直接跑云函数文件里的真代码（参数边界、
"SQL 里的 `?` 个数必须等于参数个数"、"标签分支不能带 COLLATE"），
B 层把函数**真实生成的那段 SQL** 机械翻译成 SQLite 方言跑真数据，
C 层调 `main()` 本身验"方法不对 / 参数不合法"这两支。
**这仍然只是本机验证。** 没验到的有六条，写在脚本输出末尾，其中最关键的是
"配了 VPC 之后到底能不能连上库"和"网关吃不吃结构化返回"——
这两条只有真环境能试，所以下面第 6 步不能跳。

### 需要你先给我的信息

| 要什么 | 在哪儿找 |
|---|---|
| 环境 ID | 控制台首页（形如 `cloud1-3g1xxxxx`） |
| MySQL 的**内网连接地址**、端口、用户名 | 数据库 → MySQL →「数据库设置」页 |
| MySQL 实例版本（5.7 还是 8.0） | 同上页面 |
| 云函数**运行环境**下拉框里有哪些 Node 版本 | 新建函数时能截图 |

> ⚠️ **数据库密码不要发在聊天里，也不要提交进仓库。**
> 它只填进云函数的「环境变量」那一格（第 4 步），代码里从头到尾没有明文密码。

---

### 1. 开通 MySQL + 建表 + 灌种子

1. 控制台 →「数据库」→「MySQL」→ 首次要**开通**，提示说要等 2～3 分钟
2. 进「SQL 编辑器」，**按顺序**粘这三份文件的内容执行：
   - `db/schema.sql` —— 建两张表
   - `db/seed.sql` —— 塞 6 条样例笔记（幂等，重复跑结果一样）
   - `db/verify.sql` —— 核对：每张表都该 ≥ 5 行
3. 再跑一遍 `db/queries-read.sql` 里的 ①～⑤，**逐句对照文件里的注释**
   （注释写了"该看到什么"，对不上就先停下告诉我）

> 顺手关掉「自动暂停」：MySQL数据库 →「数据库设置」→ 关掉「自动暂停」开关。
> 云开发 MySQL 是 serverless 的，**连续 10 分钟没人访问会自动暂停**，
> 下次请求要等一次冷启动。不影响正确性，只是"第一次请求特别慢"很容易被误当成接口坏了。

### 2. 装依赖 + 新建云函数 `notes`

先在本地把依赖装好（这个函数比 health 多一个 `mysql2`）：

```bat
cd C:\D\Projects\vibe-coding-lab\cloudbase-functions\notes
npm install
```

装完会多出一个 `node_modules` 文件夹 —— **上传时要一起带上**。
（它在 `.gitignore` 里，不会被提交到 GitHub，放心。）

然后控制台：
1. 「云函数」→「新建」→ 函数名 `notes`
2. 运行环境：**Node.js 18**（列表里没有就选 16.x，和 `health` 保持一致最好）
3. 创建方式：空白函数
4. 进「函数代码」→ 上传方式选**文件夹上传** → 选 `cloudbase-functions\notes` 整个文件夹

### 3. ★ 配 VPC（这一步不做，接口一定连不上库）

「notes」→「函数配置」→「高级配置」→「私有网络」→ 开启 →
**选中 MySQL 数据库所在的那个 VPC**。

为什么必须配：CloudBase MySQL 只开**内网**地址，云函数默认不在那个内网里。
（这不是我推测的，是官方文档"连接方式详解"里写死的。）

> ⚠️ 配了 VPC 之后，这个函数**默认连不上公网**。
> 本函数只连库、不需要公网，所以无所谓；
> 但以后要是给某个函数加了"调外部 API"的功能，就得额外做内网互联配置。

### 4. 配环境变量（密码填在这一格）

同一个「函数配置」页面 →「环境变量」，加这五条：

| 变量名 | 填什么 |
|---|---|
| `DB_HOST` | 第 1 步拿到的**内网**连接地址 |
| `DB_PORT` | `3306` |
| `DB_USER` | 用户名（通常是 `root`） |
| `DB_PASSWORD` | 你的数据库密码（**只填这里**） |
| `DB_NAME` | `tcb`（控制台里写的库名） |

### 5. 开 HTTP 访问

和 `health` 一样的做法：「HTTP 访问服务」→ 新建路径 `/api/notes` → 关联函数 `notes`
→ 拿到 `https://<环境ID>.service.tcloudbase.com/api/notes`

### 6. ★ 核对（不能跳，顺序也别换）

1. **先**打开 `/api/health` —— 确认基础通路还在。
   它挂了就说明是环境/网关的问题，不是读接口的问题
2. **再**打开 `/api/notes` —— 该看到 6 条，就是 seed 进去的那 6 条
3. **形状核对**：和 `mock-data.js` 逐字段比 —— 每条必须**正好**是这四个：
   `id` / `content` / `tags` / `createdAt`，一个不多一个不少。
   多于或少于，前端就得多改文件（Day 8 承诺的"只改一处"就破了）。
   > ⚠️ 如果你看到的是 `{"statusCode":200,"body":"{\"ok\":true…"}` 这种**套了一层**的形状，
   > 说明这台网关不吃"结构化返回"。截个图告诉我，我把 `respond()` 改成直接返回对象 —— 一行的事。
   > （官方文档里两种返回写法都出现过，所以这里必须真跑一次才知道是哪一种。）
4. **筛选核对**（对照 `db/queries-read.sql` 注释里写的结果）：

   | 请求 | 该看到 |
   |---|---|
   | `/api/notes?keyword=FLOMO` | 1 条 —— 大小写不一样也能搜到（PRD 3.1） |
   | `/api/notes?tag=想法` | 2 条 —— 且其中一条的 `tags` 是 `["想法","代码"]` **两个** |
   | `/api/notes?tag=none` | 1 条 —— 无标签那条 |
   | `/api/notes?limit=2` | 2 条 |
   | `/api/notes?limit=0` | `{"ok":false,"message":"limit 必须是正整数…"}` |

   > 第 2 行那条是最值钱的：它证明"筛标签时，标签不会被筛选条件吃掉"。
   > 这个坑原本要靠挑一个安全的分隔符来躲，现在改成两句 SQL 之后是**结构上**不可能错。

5. **报错就去日志找真因**：「云函数」→ `notes` →「日志」。
   错误的细节（含库名、主机名）**故意不返回给前端**，只写日志 ——
   公网地址谁都能访问，没必要把内部信息挂出去。

### 这一步做完，发给我

1. 环境 ID
2. `/api/notes` 的公网地址 + 返回的 JSON 截图（第 6 步的 **3** 和 **4** 都要）
3. 日志里有报错的话，把那几行截下来

拿到之后我就把环境 ID 填进 `api-contract.md` 的 Base URL，
然后把前端的取数口从 localStorage 切到这个接口上，提交推送收尾。

---

## 附录：Day 18 续——写接口 `POST /api/notes`（防重复提交）

### 一句话：读和写是**同一个云函数**

HTTP 访问服务里**一个路径只能绑一个函数**，所以 `/api/notes` 上的 GET 和 POST
只能住在同一个 `notes` 函数里。Day 18 把原来的 `index.js` 拆成了 5 个文件
（`index.js` 路由 + `http.js` / `db.js` / `read.js` / `write.js`），
**函数名、路径、环境变量、VPC 配置全都不用改** —— 重新上传一次代码就行。

> 拆文件是因为约束 5「单文件超 500 行就拆」。现在每个文件都在 200 行以内。

### 这一步要防的是什么（今天要掌握的那件事）

**防的是同一次提交被发了两次**。最典型的场景：网卡了一下，用户以为没保存成功，
又点了一次「保存」。前端保证不了"绝不发第二次"，所以必须服务端兜底。

防法：前端每次提交生成一个随机串 `clientToken`，库里给这一列建了 `UNIQUE` 索引，
插入时撞键就回 `409`。**拦住重复的是数据库那条唯一约束，不是代码里的一段判断**
（"先查再插"有竞态，两个请求会双双通过检查）。设计细节见 `db/README.md` 第二节。

### 1. 更新数据库（老表要补一列）

已经跑过 Day 17 建表的话，`notes` 表还**缺 `client_token` 这一列**，补一下：

```sql
-- db/schema.sql 里已有；老表执行这两句即可
ALTER TABLE notes ADD COLUMN client_token VARCHAR(64) NULL;
CREATE UNIQUE INDEX uk_notes_client_token ON notes (client_token);
```

> MySQL 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会报"列已存在" —— 报错就是已经加过了，忽略即可。
> 全新环境直接跑 `db/schema.sql` 一次到位。
> 跑完用 `db/verify.sql` 的 ⑥ 核一下：列在不在、唯一索引在不在。

### 2. 重新上传云函数代码

「云函数」→ `notes` →「函数代码」→ 文件夹上传 →
选 `C:\D\Projects\vibe-coding-lab\cloudbase-functions\notes` 整个文件夹
（**5 个 `.js` + `package.json` + `node_modules`** 一起）。

> 依赖没变（还是只有 `mysql2`），本地不用重跑 `npm install`。

### 3. ★ 写一次 + 读回，再故意重复一次

**第 1 步：正常写一条**（把 `clientToken` 换成任意 8～64 位的随机串）：

```bash
curl -X POST "https://<环境ID>.service.tcloudbase.com/api/notes" \
  -H "Content-Type: application/json" \
  -d '{"content":"Day 18 第一条真实写入 #部署","tags":["部署"],"clientToken":"tok-day18-demo-0001"}'
```

**该看到**（形状与 `api-contract.md` 第 4 节一致）：

```json
{"ok":true,"note":{"id":"n_...","content":"Day 18 第一条真实写入 #部署","tags":["部署"],"createdAt":"2026-10-10T...Z"}}
```

**第 2 步：把上面那条命令原样再跑一次**（`clientToken` 一个字都不改）：

**该看到** —— 同样的 token 被拦下：

```json
{"ok":false,"message":"这一条刚刚已经提交过了（重复提交已拦下）。如果是想要的新笔记，改一个字再提交。"}
```

> 这就是"重复提交被拒"的现场。注意它是 **`409`**，不是 `400` ——
> `400` 是"你发的请求本身有毛病"，`409` 是"请求没毛病、但和已有数据撞了"。

**第 3 步：读回，确认只多了一行**：

```bash
curl "https://<环境ID>.service.tcloudbase.com/api/notes?limit=1"
```

`note.content` 该是你刚写的那句；再去数据库里核：

```sql
SELECT id, content, client_token, created_at FROM notes ORDER BY created_at DESC LIMIT 3;
```

**该看到**：最新的那一行 `content` 是刚写的、`client_token` 是 `tok-day18-demo-0001`，
并且**只有一行**是它 —— 第 2 步那次重复**没有**在库里留下第二行。

### 4. 顺手核一下"缺字段也会被拒"（中文提示）

```bash
curl -X POST "https://<环境ID>.service.tcloudbase.com/api/notes" \
  -H "Content-Type: application/json" \
  -d '{"content":"","clientToken":"tok-day18-demo-0002"}'
```

**该看到**：`{"ok":false,"message":"正文不能为空。"}` —— 提示语是**中文**，
且这次请求**根本没碰数据库**（校验在连库之前，见 README 约束 16）。

### 5. 今天要发的截图（两张）

| 截图 | 画面里要有 |
|---|---|
| **① POST 成功返回** | 第 3 步里那条 `curl` 的返回（返回 JSON 的 `{ok:true, note:{…}}` 形状要看得清）；最好连第 2 步"重复被拒"的返回也一起截进去 |
| **② 数据库新增的那一行** | 在控制台 SQL 编辑器里跑第 3 步那句 `SELECT`，把结果表格截下来 —— **能看清 `content` 和 `client_token`，且确认只有一行** |

### 6. 报错去哪找

「云函数」→ `notes` →「日志」。写成功时日志里有一条
`[notelab/notes] 写入成功 { id, clientToken, tags, ms }`；
拦下重复时有一条 `[notelab/notes] 拦下一次重复提交 { id, clientToken, tags }`。
（这是任务清单"余力加练"要求的服务端日志 —— 以后排查"到底写没写进去"就看这两行。）

> 连接失败 / 超时这类，先回看 Day 17 附录的第 3 步（VPC）和第 4 步（环境变量）——
> 那两步没做对，读写都连不上。

### 这一步做完，发给我

1. 两张截图（POST 返回 + 数据库那一行）
2. 第 2 步"重复被拒"的返回
3. 日志里有报错的话，截那几行


---

## 附录：Day 20 —— 公网首页显示真实数据

> ⚠️ **这一节目前执行不了**，原因还是第 ① 步：环境 ID 到今天仍是占位符
> （`api-contract.md` 第 15 行的 Base URL 还写着 `<环境ID>`）。
> 下面的步骤已经按可照抄的程度写好，拿到环境 ID 后当天就能走完。

### ① 确认云函数可用 + 跨域已配

先后顺序别换 —— **先认服务在不在，再谈跨域**：

1. 浏览器打开 `https://<环境ID>.service.tcloudbase.com/api/health`
   → 该看到 `{"ok":true,"service":"notelab",...}`。看不到就说明环境/网关有问题，
   **不是跨域问题**，往回查 Day 15 的部署步骤
2. 再打开 `https://<环境ID>.service.tcloudbase.com/api/notes`
   → 该看到 `{"ok":true,"notes":[...]}`
3. **跨域那一眼怎么看**：在这个页面上按 F12 → Network，点那条 `/api/notes` →
   Response Headers 里应当有：

   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET, POST, OPTIONS
   ```

   这三行是 Day 18 写在 `cloudbase-functions/notes/http.js` 里的，**不需要今天再配**。
   ★ 如果页面（而不是直接访问地址）取不到数据，但直接访问地址有数据 —— 那就是跨域，
   改服务端，前端改什么都没用。

### ② 本地接线（这一块**已经做完并验过**）

`api.js` 已建好：默认不启用，配了地址才走网络。
本机自检 `node skills/notelab-api-wiring/check.cjs` → **24/24 通过**（含真发 HTTP 请求）。
前端既有回归同时确认没被改坏：`run.js` 34/34、`render-check.js` 23/23。

### ③ 上传：填地址 + 传 5 个文件

1. 打开 `api.js`，把第 31 行那一处改成你的地址：

   ```js
   const CONFIGURED_BASE = 'https://<环境ID>.service.tcloudbase.com';
   ```

2. 静态托管上传 **5 个**文件（比 Day 15 多一个 `api.js`）：
   `index.html` / `styles.css` / `app.js` / `mock-data.js` / `api.js`

### ④ 逐项验证（三条，缺一条不算完成）

| # | 验什么 | 怎么看 |
|---|---|---|
| 1 | **公网首页展示数据库真实数据** | 打开静态托管的公网地址，列表里应是 `db/seed.sql` 灌进去的那些笔记，**不是** mock 那 10 条 |
| 2 | **控制台改数据，刷新跟着变** | 在 SQL 编辑器里 `UPDATE` 一条笔记的正文 → 刷新页面 → 页面上的正文跟着变 |
| 3 | **F12 里请求地址是公网地址** | Network 里那条请求的地址应是 `https://<环境ID>.service.tcloudbase.com/api/notes`，不是 localhost |

> 页面顶部那行小字「数据来源：公网接口 … · 最后更新 HH:MM:SS」是余力加练加的，
> 一眼就能看出这批数据是哪来的、几点取的 —— 排查"刷新了却没变"时先看它。

### 卡住时的分辨法（今天要掌握的那件事）

| 现象 | 是什么病 | 改哪里 |
|---|---|---|
| Console 有带 `CORS` 的红字；Network 那条 200 但 Response 空 | 跨域没过 | 服务端 `http.js` 的响应头 |
| Network 那条 404 / 502 | 地址不对或服务不在 | 核对环境 ID 与路径 |
| 请求 200、有内容，但页面空白或报"形状不一致" | 返回形状不对 | 对照 `api-contract.md`，看 `api.js` 的 `unwrapGatewayPayload` |
| 页面正常、但显示的还是 mock 那 10 条 | 地址没配上 | 检查 `api.js` 第 31 行，以及托管里到底传没传 `api.js` |

---

## 附录六｜Day 22：改（PATCH）与删（DELETE）接口

四个方法现在都在**同一个云函数**里（一个路径只能绑一个函数，见 Day 17 的说明）。
上传的仍然是那 6 个文件，`index.js` 里的路由按 `httpMethod` 分发。

### ① 部署前：库里要先有软删除那两列

**⚠️ 新表不用管，老表要手动补两列。** `db/schema.sql` 的 `CREATE TABLE` 已经带上
`is_deleted` / `deleted_at`，但 MySQL **不支持** `ADD COLUMN IF NOT EXISTS`，
所以"给已经建好的表补列"那段 `ALTER TABLE` 在文件里是**注释状态**，需要你手动跑：

```sql
ALTER TABLE notes
  ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '软删除标记：0=正常，1=已删除',
  ADD COLUMN deleted_at DATETIME(3) NULL
    COMMENT '删除时间，UTC';
```

> 重复执行会报 `Duplicate column name` —— **这不是出错**，是 MySQL 在告诉你已经有了。
> （Day 18 那次补 `client_token` 也是同一句，两列可以一次加完。）

跑完确认这两列在位 —— `db/verify.sql` 第 ⑧ 段：

```sql
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes'
  AND COLUMN_NAME IN ('is_deleted', 'deleted_at');
```

该看到两行。看不到就说明 ALTER 没跑成功，**DELETE 会直接报 500**。

### ② 部署：上传 6 个文件

```
cloudbase-functions/notes/ 下的 index.js / http.js / db.js / repository.js / read.js / write.js
```

★ 别漏 `http.js`：Day 22 改了它的 CORS 头，加了 `PATCH, DELETE`。
漏传的话前端的 PATCH / DELETE 会在**预检**就被浏览器拦掉，
而报错的样子是"接口不通"—— 排查时很容易朝错的方向走。

### ③ 四条 curl（把 `<环境ID>` 换成真的）

```bash
# 1) 查列表（GET）
curl "https://<环境ID>.service.tcloudbase.com/api/notes?limit=5"

# 2) 新建（POST）—— 换一个 clientToken 就能再建一条
curl -X POST "https://<环境ID>.service.tcloudbase.com/api/notes" \
  -H "Content-Type: application/json" \
  -d '{"content":"Day 22 联调：这条会被改、然后被删 #联调","clientToken":"day22-a","tags":["联调","待删"]}'

# 3) 改（PATCH）—— id 用第 2 步返回的那个；只给 content，标签会原样保留
curl -X PATCH "https://<环境ID>.service.tcloudbase.com/api/notes?id=n_xxx" \
  -H "Content-Type: application/json" \
  -d '{"content":"Day 22 联调：正文改过了"}'

# 4) 删（DELETE）—— 只打标记，行还在库里
curl -X DELETE "https://<环境ID>.service.tcloudbase.com/api/notes?id=n_xxx"
```

该看到的：

| 步骤 | 预期 |
|---|---|
| 2 | `{"ok":true,"note":{...}}`，库里多一行 |
| 3 | `{"ok":true,"note":{...}}`，`content` 变了、`tags` 还是 `["联调","待删"]`、`createdAt` **没变** |
| 4 | `{"ok":true,"deleted":{"id":"n_xxx","at":"2026-…Z"}}` |
| 4 之后 | 再跑第 1 步，这条**查不到了** |
| 4 之后 | 再跑一次第 4 步 → `404`（已经删过的不能再删） |

### ④ 软删除的核对（三条，缺一条不算验过）

| # | 验什么 | 怎么看 |
|---|---|---|
| 1 | **行还在库里** | `SELECT COUNT(*) FROM notes;` 删之前之后**一样多**；而 `WHERE is_deleted = 0` 那个数少了 1 |
| 2 | **标记打上了** | `SELECT id, is_deleted, deleted_at FROM notes WHERE is_deleted = 1;` 能看到刚删的那条 |
| 3 | **能找回来** | 跑 `db/verify.sql` 第 ⑨ 段那句 `UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = 'n_xxx';` → 第 1 步的列表里它又出现了，标签也在 |

> 第 3 条是软删除的全部意义：**"删错了能找回"不是一句承诺，是被真的跑过一遍的。**
> 界面上的「撤销」按钮还没做（属 `CANDIDATES.md` 的 C2，未批准不开工），
> 现在的后悔药就是这句人工 SQL。

### 卡住时的分辨法

| 现象 | 是什么病 | 改哪里 |
|---|---|---|
| DELETE 后列表还有它 | 查询没带 `is_deleted = 0` | `repository.withNotDeleted()`，别处不许自己拼 |
| PUT / 任意不支持的方法 → 405 | 正常（故意只支持四个方法） | —— |
| PATCH 返回 404 但这条明明在 | 它可能已经被软删除了 | 查 `is_deleted`，或用 ④ 第 3 条恢复 |
| 前端 PATCH / DELETE 报跨域 | 预检没答 PATCH/DELETE | `http.js` 的 `Access-Control-Allow-Methods`（自检 H-43 守着） |
| 控制台里 DELETE 报 500，说未知列 `is_deleted` | `schema.sql` 的 ALTER 没跑 | 回 ① 补跑建表语句 |

---

## 附录七｜Day 23：上线前的红线检查 + 三类错误提示 + 请求日志

### ① 推上去之前先跑一次密钥排查（**红线，不能跳过**）

```bash
node skills/notelab-safety-check/scan.cjs
```

必须是 **0 条命中**。不是 0 就先处理，别先推送 —— 推上公开仓库是**不可撤回**的。

真扫到时的顺序（**别只删文件**）：
1. 去服务商后台**吊销 / 轮换**那把钥匙（删代码救不了已经泄的密钥）
2. 把值挪进 `.env` 或云函数控制台的环境变量，代码里只留 `process.env.XXX`
3. 最后才考虑改 git 历史（`git filter-repo`）+ 强推

### ② `.env` 怎么用（本机 / 云上两种放法）

| 放哪 | 怎么用 |
|---|---|
| 云上（**推荐**） | CloudBase 控制台 → 云函数 → `notes` → **环境变量**，加 `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`。代码不用改，它读的就是 `process.env.*` |
| 本机 | `cp .env.example .env`，把等号右边换成自己的值。`.env` 已被 `.gitignore` 忽略，**永远不会上传** |

> ⚠️ `.gitignore` 里那三行有讲究：`.env` 和 `.env.*` 一律忽略，再用
> `!.env.example` 把模板放行。**放行那行不能带行尾注释** ——
> `.gitignore` 不认 `# 注释` 写在模式后面，整行会被当成一个模式（Day 23 踩过）。

### ③ 三类错误的提示在哪改

统一在 **`errors.js`** 里，改一处三处生效：

| 类 | 什么时候出现 | 在 errors.js 里的键 |
|---|---|---|
| A 存储类 | 存不下 / 读不出本地数据 | `ERROR_MESSAGES.storage.*` |
| B 网络类 | 取不到接口数据（跨域 / 地址 / 形状） | `ERROR_MESSAGES.network.*` |
| C 服务端类 | 接口明确回了失败 | `ERROR_MESSAGES.server.*` |

改完跑：
```bash
node skills/notelab-safety-check/messages.cjs
node skills/notelab-filter-check/render-check.js   # ★ 改了前端变量名必须跑这个
```

### ④ 请求日志怎么看（Day 23 余力加练加的）

云函数每次被调用都会在控制台留一行：

```
[notelab/notes] 请求 { at: '2026-10-18T…Z', method: 'GET', path: '/api/notes', status: 200, ms: 41 }
```

四个字段正好回答"排查时最先要确认的四件事"：**进来了吗 / 哪个方法 / 哪条路径 / 成功还是失败**。
`ms` 用来分辨"慢"还是"挂"（首启要拉连接池，第一次通常会慢一些）。

★ **日志里没有请求体、没有笔记正文** —— 用户的东西不进日志（自检 C-15 守着）。
要查某条笔记的内容，用返回的 `id` 去库里查。

### 卡住时的分辨法

| 现象 | 是什么病 | 看哪里 |
|---|---|---|
| 页面白屏、但 `run.js` 全绿 | 十有八九是前端脚本顶层 `const` 重名（浏览器 SyntaxError） | 跑 `render-check.js`；自检 `L-4` 会直接指出哪个名字重了 |
| 提示语改了、页面上没变 | 浏览器缓存，或 `errors.js` 没传上去 | F12 → Network 看 `errors.js` 是不是 200；托管里有没有这个文件 |
| 保存失败但提示说"浏览器不允许存储" | 老版本（Day 23 之前）的说法 | 新版会区分"写满"和"不允许" |
