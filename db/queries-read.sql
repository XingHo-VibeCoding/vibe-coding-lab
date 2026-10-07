-- ============================================================
-- db/queries-read.sql —— 读接口要用的 SQL（Day 17）
--
-- 用法：在 CloudBase 控制台 → 数据库 → MySQL → SQL 编辑器里逐句执行。
--       这是任务清单"卡住降级"里要求的顺序：**先把 SQL 验对，再排查部署环节**。
--       Day 17 云函数里跑的，就是下面这几句（把示例值换成参数）。
--
-- 注意：下面的示例值都是字面量（方便直接粘着跑）；
--       云函数里会换成占位符 ? 并按顺序传参。
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


-- ---------- ⑥ 三种筛选组合（云函数实际拼的就是这一句的骨架）----------
-- 传什么算什么：关键词为空则不过滤关键词；标签为空则不过滤标签
-- 云函数里用占位符，形态如下（不要直接跑，先看懂结构）：
--
--   SELECT n.id, n.content, n.created_at,
--          GROUP_CONCAT(t.tag ORDER BY t.position SEPARATOR '\u001f') AS tags_joined
--   FROM (
--     SELECT n.id FROM notes AS n
--     WHERE (? IS NULL OR n.content LIKE CONCAT('%', ?, '%')
--            OR EXISTS (SELECT 1 FROM note_tags z
--                       WHERE z.note_id = n.id
--                         AND z.tag COLLATE utf8mb4_unicode_ci LIKE CONCAT('%', ?, '%')))
--       AND (? IS NULL
--            OR (? = '__none__' AND NOT EXISTS (SELECT 1 FROM note_tags x WHERE x.note_id = n.id))
--            OR EXISTS (SELECT 1 FROM note_tags y WHERE y.note_id = n.id AND y.tag = ?))
--     ORDER BY n.created_at DESC
--     LIMIT ?
--   ) AS f
--   JOIN notes AS n ON n.id = f.id
--   LEFT JOIN note_tags AS t ON t.note_id = n.id
--   GROUP BY n.id, n.content, n.created_at
--   ORDER BY n.created_at DESC;
--
-- 为什么先筛 id 再拼标签：如果直接 JOIN + WHERE，标签会被 WHERE 过滤掉一部分，
-- 拼出来的 tags 就只剩"命中的那个标签"，而不是这条笔记的全部标签。
-- （例：搜「想法」命中 seed_04，它应该显示 `想法 #代码` 两个标签，而不是只有 `想法`）
-- 分隔符用 \u001f（单元分隔符）而不是逗号：标签名里出现逗号时不会串味。


-- ---------- ⑦ 自检：接口返回的条数对不对 ----------
-- 该看到：all=6, tagged=5, untagged=1
SELECT
  (SELECT COUNT(*) FROM notes) AS all_rows,
  (SELECT COUNT(DISTINCT note_id) FROM note_tags) AS tagged_rows,
  (SELECT COUNT(*) FROM notes n WHERE NOT EXISTS
       (SELECT 1 FROM note_tags z WHERE z.note_id = n.id)) AS untagged_rows;
