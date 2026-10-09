-- ============================================================
-- db/queries-read.sql —— 读接口要用的 SQL（Day 17）
--
-- 用法：在 CloudBase 控制台 → 数据库 → MySQL → SQL 编辑器里逐句执行。
--       这是任务清单"卡住降级"里要求的顺序：**先把 SQL 验对，再排查部署环节**。
--       云函数里跑的是等价的两句（见第 ⑥ 段），把示例值换成占位符 ?。
--
-- 注意：下面的示例值都是字面量（方便直接粘着跑）；
--       ① ～ ③ 里的 GROUP_CONCAT 是**给人在控制台看结果用的**（'#' 拼起来一眼能读懂），
--       云函数里不这么拼 —— 为什么不这么拼，第 ⑥ 段有完整说明（那是个真踩到的坑）。
-- ============================================================


-- ---------- ① 全量列表（对应 PRD 验收 1.2：按时间倒序）----------
-- 该看到：6 行，每行右侧是该笔记的标签（用 '#' 拼起来），seed_05 的 tags 是 NULL
SELECT
  n.id,
  n.content,
  n.created_at,
  GROUP_CONCAT(t.tag ORDER BY t.position SEPARATOR ' #') AS tags
FROM notes AS n
LEFT JOIN note_tags AS t ON t.note_id = n.id
GROUP BY n.id, n.content, n.created_at
ORDER BY n.created_at DESC;


-- ---------- ② 关键词搜索（PRD 验收 3.1、3.2：正文和标签都能命中，不区分大小写）----------
-- 示例：搜「flomo」→ 该命中 seed_03（正文里是小写 flomo）
--     把 'flomo' 换成 'FLOMO' 结果**必须一样** —— 这就是"不区分大小写"的验收点
--
-- ★ 这里藏着今天最值得注意的一处：标签搜索要**手动指定排序规则**。
--   note_tags.tag 这一列为了"标签区分大小写"用的是 utf8mb4_bin，
--   于是 `t.tag LIKE '%FLOMO%'` 会变成区分大小写 —— 与 PRD 3.2 冲突。
--   所以下面在比较时显式套一层 utf8mb4_unicode_ci，把这次比较掰回"不区分大小写"。
--   列本身的排序规则不动（精确筛选标签时仍要区分大小写）。
SELECT
  n.id,
  n.content,
  n.created_at,
  GROUP_CONCAT(t.tag ORDER BY t.position SEPARATOR ' #') AS tags
FROM notes AS n
LEFT JOIN note_tags AS t ON t.note_id = n.id
WHERE n.content LIKE CONCAT('%', 'flomo', '%')
   OR EXISTS (
        SELECT 1 FROM note_tags AS z
        WHERE z.note_id = n.id
          AND z.tag COLLATE utf8mb4_unicode_ci LIKE CONCAT('%', 'flomo', '%')
      )
GROUP BY n.id, n.content, n.created_at
ORDER BY n.created_at DESC;


-- ---------- ③ 按标签筛选（PRD 验收 2.3、2.5）----------
-- 示例：筛「想法」→ 该命中 seed_02 和 seed_04 两条
-- ★ 这里**故意不套 _ci**：标签精确筛选要区分大小写（筛「想法」不该命中「想法A」）
SELECT
  n.id,
  n.content,
  n.created_at,
  GROUP_CONCAT(t.tag ORDER BY t.position SEPARATOR ' #') AS tags
FROM notes AS n
LEFT JOIN note_tags AS t ON t.note_id = n.id
WHERE EXISTS (
        SELECT 1 FROM note_tags AS z
        WHERE z.note_id = n.id AND z.tag = '想法'
      )
GROUP BY n.id, n.content, n.created_at
ORDER BY n.created_at DESC;


-- ---------- ④ 只取无标签的（PRD 验收 2.5）----------
-- 该命中 seed_05 一条
SELECT
  n.id,
  n.content,
  n.created_at
FROM notes AS n
WHERE NOT EXISTS (SELECT 1 FROM note_tags AS z WHERE z.note_id = n.id)
ORDER BY n.created_at DESC;


-- ---------- ⑤ 限制返回条数（余力加练：limit 参数）----------
-- 该看到：2 行（seed_01、seed_02 —— 时间最新的两条）
-- 为什么必须显式传 limit：不传的话，笔记多了会一次全拉回前端。
-- 个人工具现在几百条无所谓，但"接口没有上限"是个迟早会咬人的习惯。
SELECT
  n.id, n.content, n.created_at
FROM notes AS n
ORDER BY n.created_at DESC
LIMIT 2;


-- ---------- ⑥ 筛选组合 + 标签怎么拼（云函数实际跑的形态）----------
--
-- ★ Day 17 写云函数时的修正：本段原先是一句带 GROUP_CONCAT 的 SQL，
--   用 '\u001f' 当分隔符。那是**错的**，三个原因：
--   1) MySQL 不认 '\u001f' 这种转义（那是 JS / Python 的写法）。
--      MySQL 遇到不认识的转义会**丢掉反斜杠** → 它实际是字面量 `u001f`，
--      拼出来变成 `想法u001f代码`，而且**不报错**。
--      要改也得写 CHAR(31)，但 GROUP_CONCAT 的 SEPARATOR 后面只收字符串字面量。
--   2) 标签是用户自己起的名，逗号、竖线、'#' 都可能出现 ——
--      "挑一个不会出现的分隔符"本质上是赌。
--   3) 顺带：GROUP_CONCAT 受 group_concat_max_len 限制（默认 1024 字节），
--      超了**静默截断**，不报错，只是悄悄少标签。
--
-- → 云函数里改成**两句**（都在 cloudbase-functions/notes/index.js）：
--
-- 第一句：只要"是哪几条"，筛选条件全在这句。
--   关键词为空则不拼第一个 WHERE 条件；标签为空则不拼第二个；
--   云函数里用 ? 占位符按需拼，下面把示例值写死方便直接跑。
SELECT n.id, n.content, n.created_at
FROM notes AS n
WHERE (n.content LIKE CONCAT('%', '想法', '%')
       OR EXISTS (SELECT 1 FROM note_tags AS z
                  WHERE z.note_id = n.id
                    AND z.tag COLLATE utf8mb4_unicode_ci LIKE CONCAT('%', '想法', '%')))
ORDER BY n.created_at DESC
LIMIT 50;


-- 第二句：按上面这批 id，把它们的**全部**标签取回来
-- （'seed_02','seed_04' 换成第一步实际得到的 id）
SELECT note_id, tag
FROM note_tags
WHERE note_id IN ('seed_02', 'seed_04')
ORDER BY note_id, position;


-- ★ 为什么必须拆两句：如果按老写法 JOIN + WHERE 一起筛，
--   标签会被 WHERE 一起过滤掉，拼出来的 tags 只剩"命中的那个标签"。
--   例：搜「想法」命中 seed_04，卡片该显示 `想法 #代码` 两个标签，
--       而不是只有 `想法`（PRD 要求卡片展示这条笔记的全部标签）。
--   拆开之后，这条正确性是**结构上**保证的 —— 不依赖分隔符挑得好不好。


-- ---------- ⑦ 自检：接口返回的条数对不对 ----------
-- 该看到：all=6, tagged=5, untagged=1
SELECT
  (SELECT COUNT(*) FROM notes) AS all_rows,
  (SELECT COUNT(DISTINCT note_id) FROM note_tags) AS tagged_rows,
  (SELECT COUNT(*) FROM notes n WHERE NOT EXISTS
       (SELECT 1 FROM note_tags z WHERE z.note_id = n.id)) AS untagged_rows;
