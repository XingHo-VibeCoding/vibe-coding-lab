# notelab-release-check｜发布前检查（总闸）

**一句话**：上线前跑一条命令，告诉你"能不能发布，不能的话去改哪儿"。

```bash
node skills/notelab-release-check/check.cjs                  # 发布专项 + 密钥红线
node skills/notelab-release-check/check.cjs --full           # 再把其余 5 个自检一并跑完
node skills/notelab-release-check/check.cjs --url=https://xxx.service.tcloudbase.com
```

---

## 三种结果，别把 ⊘ 当绿灯

| 符号 | 含义 | 例子 |
|---|---|---|
| ✓ | 验过了，没问题 | CORS 方法是 `GET, POST, PATCH, DELETE, OPTIONS` |
| ✗ | 验过了，有问题 | CORS 只允许 `https://notelab.example.com` |
| **⊘** | **没验到，不算通过** | 没给 `--url`，公网那三项就是 ⊘ |

★ 第三条是这套检查最重要的设计。把"没验到"和"验过了没问题"混为一谈，
是发布前检查最容易犯、也最致命的错：**绿灯一片，其实好几项根本没查。**
所以不给 `--url` 时，公网那三项**必须**标 ⊘，不能假装通过。

---

## 检查项 & 红了去改哪儿

| 项 | 查什么 | 红了去改哪 |
|---|---|---|
| A-1 | 上线必备文件都在 | 补文件或改清单 |
| **A-2** | **index.html 引用的每个本地文件都真实存在** | 删掉那行引用，或把文件补上 |
| A-3 | 代码取的 `id` 在 html 里都有 | 补 id，或删掉那次 `getElementById` |
| A-4 | 上线文件里没写死 localhost | 换成公网地址 / 环境变量 |
| B-1 | 全仓库密钥 0 命中 | 见下面"密钥"一节，红线优先 |
| B-2 | `.env` 相关的 9 条断言全绿 | 同上 |
| C-1 | 接口地址不是 `xxxxx`/`EXAMPLE` 占位符 | `api.js` 的 `CONFIGURED_BASE` |
| **C-2** | **`Access-Control-Allow-Origin` 是 `*`** | `cloudbase-functions/notes/http.js` 的 `CORS_HEADERS` |
| C-3 | CORS 允许的方法齐全 | 同上（少 `DELETE` 的话，PATCH/DELETE 会在**预检**那步被拦掉，报错看起来却像"接口不通"） |
| C-4/5/6 | 公网 `/api/notes` 真的 200、形状对、有 CORS 头 | 需要 `--url`，否则这三项是 ⊘ |
| D-1 | 请求日志不记请求体 | `cloudbase-functions/notes/index.js` 的 `logRequest` |
| D-2 | `errors.js` 排在 `api.js`/`app.js` 之前 | `index.html` 的 script 顺序 |
| D-3 | 源码里没有残留裸报错文案 | 见下面"已知红项" |
| E-1/2 | 笔记数据的第二层校验还在、三个入口都过 | `app.js` 的 `sanitizeNotes` |
| F-1 | 超 500 行的都已在 README 欠账清单登记 | 要么拆，要么登记 |

**B 段（密钥）不另写规则**，直接用子进程调 `notelab-safety-check/scan.cjs`。
两套规则早晚会长得不一样，到时候不知道该信哪个。

---

## ★ 今天故意弄坏的两项（这就是"你故意弄坏哪一项"的答案）

| 故意弄坏 | 怎么改的 | 被 A-2 / C-2 抓到了吗 |
|---|---|---|
| CORS 只允许单一域名 | `'*'` → `'https://notelab.example.com'` | ✅ C-2 抓到 |
| 引用了不存在的文件 | index.html 里加 `<script src="analytics.js">` | ✅ A-2 抓到 |

**为什么挑这两项**：它们都是"开发机上不疼，一发布就要命"的典型 ——
CORS 写死单一域名，本地访问照样通（因为你就是从那个域名访问的），上线后别的来源全进不来；
引用了不存在的 js，本地因为有缓存可能照样能跑，线上就是 404。

**最有说服力的那件事**：故意留着这两个问题时，我把其余 6 个自检全跑了一遍 ——

```
✅ 密钥扫描   17/17   ✅ 文案自检  27/27   ✅ 行为层 49/49
✅ 可见层     23/23   ✅ 云函数  210/210   ✅ 接线    24/24
```

**350 项断言全部照样全绿，没有一条发现这两个问题。**
这说明新 Skill 不是把已有检查换个名字重跑一遍，而是补上了它们结构上就看不见的那一段。

证据存档：`BASELINE.txt`（弄坏前）/ `BROKEN.txt`（弄坏后）/ `RESTORED.txt`（还原后）。

---

## 已知红项（本次实跑发现的真问题，今天按规矩不修）

**D-3 红**：`cloudbase-functions/notes/index.js` 两处 `fail(500, '服务器开小差了')`。

它是 Day 23 文案统一**留下的尾巴** —— `errors.js` 的文件头注释里，
还把"云函数 index.js 里那句「服务器开小差了」"列为"四处散落的文案之一"，
但 Day 23 实际只统一了三处，这处没动。它满足"中文""说清了"，但**没有下一步指引**。

为什么今天不修：修它要让云函数引用 `errors.js`，
那就得先解决"部署时 `errors.js` 会不会被一起打包进云函数目录"这个问题 ——
属于部署打包，不是改一行文案的事。已记进 `CANDIDATES.md` 的 **C11**。

> 顺带一句：500 只给一句笼统的话**是有意为之**（`api-contract.md` 第 289 行：
> 真实错误只写云函数日志，不外泄）。所以修法不是把内部错误细节吐给用户，
> 而是补上"重试一次通常就好"这一步 —— 那不泄露任何内部信息。

---

## 写完/改完代码后，什么时候必须重跑

- 动了 `index.html` 的引用或 script 顺序 → A-2 / A-3 / D-2
- 动了 `http.js` 的 CORS 头 → C-2 / C-3
- 动了 `api.js` 的接口地址 → C-1
- 加了新文件 → F-1（超 500 行要登记或拆）
- 要上线 → 给 `--url` 把 C-4/5/6 从 ⊘ 变成真验过
