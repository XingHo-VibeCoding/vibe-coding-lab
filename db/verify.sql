-- ============================================================
-- db/verify.sql —— select 验证（Day 16 第 ④ 步）
--
-- 用法：在 CloudBase 控制台 → 数据库 → MySQL → SQL 编辑器里，
--       一句一句单独执行，对照每句下面写的"该看到什么"。
--       截图就截这里的 ①② 两个结果（每张表都该 ≥5 行）。
-- ============================================================


-- ---------- ① 每张核心表都有数据（完成标准：各 ≥5 行）----------
-- 该看到：notes_rows = 6
SELECT COUNT(*) AS notes_rows FROM notes;

-- 该看到：note_tags_rows = 6
SELECT COUNT(*) AS note_tags_rows FROM note_tags;


-- ---------- ② 两张表关联是否成立（今天就靠这句证明"关联字段"是对的）----------
-- 该看到：6 行，每行右侧是这条笔记的标签；seed_05 的 tags 是 NULL（它无标签）
SELECT
  n.id,
  n.content,
  GROUP_CONCAT(t.tag ORDER BY t.position SEPARATOR ' #') AS tags
FROM notes AS n
LEFT JOIN note_tags AS t ON t.note_id = n.id
GROUP BY n.id, n.content, n.created_at
ORDER BY n.created_at DESC;


-- ---------- ③ 标签统计（PRD 验收 2.2「标签按使用次数排序」的依据）----------
-- 该看到：想法 2、代码 1、产品研究 1、待办 1、记录 1（共 5 个标签）
SELECT tag, COUNT(*) AS note_count
FROM note_tags
GROUP BY tag
ORDER BY note_count DESC, tag ASC;


-- ---------- ④ 悬空关联检查（该看到 0 行）----------
-- 有输出就说明：note_tags 里存在指向"不存在的笔记"的脏行，
-- 外键没生效或数据是绕过外键塞进去的。0 行才是健康的。
SELECT t.note_id AS dangling_note_id, t.tag
FROM note_tags AS t
LEFT JOIN notes AS n ON n.id = t.note_id
WHERE n.id IS NULL;


-- ---------- ⑤ 幂等自检：再跑一遍 seed.sql，然后重跑 ①----------
-- 该看到：数字**完全不变**（还是 6 / 6）。数字变大 = 幂等没做对。
-- （这一条没有语句，是操作步骤：重跑 db/seed.sql → 重跑上面的 COUNT）
