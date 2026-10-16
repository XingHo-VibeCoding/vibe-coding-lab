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

-- ★ Day 22 起上面的数字**不再等于"用户能看到的条数"**：
--   删除是软删除，行还在、COUNT(*) 不会减少。想知道"页面上有几条"用这一句：
--   该看到：visible_rows = 6（删过之后会变少，而上面那句不变 —— 差别就是软删除的痕迹）
SELECT COUNT(*) AS visible_rows FROM notes WHERE is_deleted = 0;

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
WHERE n.is_deleted = 0          -- ★ Day 22：不加这句就会把"已删除的"也列出来
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


-- ---------- ⑥ 幂等键那一列在位（Day 18 新增）----------
-- 该看到：一行，COLUMN_NAME = client_token、IS_NULLABLE = YES
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes' AND COLUMN_NAME = 'client_token';

-- 该看到：一行，INDEX_NAME = uk_notes_client_token、NON_UNIQUE = 0（0 就是"唯一"）
-- 如果 NON_UNIQUE 是 1，说明建成了普通索引 —— 那样重复提交就拦不住了
SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes'
  AND INDEX_NAME = 'uk_notes_client_token';


-- ---------- ⑦ 重复提交的证据长什么样（Day 18 截图要用这一句）----------
-- POST 一条成功之后再跑这句：该看到刚写进去的那一行，client_token 就是你请求里给的那个值
SELECT id, content, created_at, client_token
FROM notes
WHERE client_token IS NOT NULL
ORDER BY created_at DESC
LIMIT 5;

-- seed 那 6 行应该都是 NULL（它们不是通过接口写进来的，所以没有幂等键）
SELECT COUNT(*) AS null_token_rows FROM notes WHERE client_token IS NULL;


-- ============================================================
-- ⑧ 软删除那一列在位（Day 22 新增）
-- ============================================================
-- 该看到：两行，is_deleted / deleted_at，IS_NULLABLE 分别是 NO 和 YES
-- 如果一句都查不到，说明 schema.sql 的 ALTER 没跑，DELETE 会直接报错
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes'
  AND COLUMN_NAME IN ('is_deleted', 'deleted_at');

-- DELETE 一次之后跑这句：该看到刚"删"的那条 is_deleted = 1、deleted_at 有值，
-- 而这一行**依然在表里** —— 这就是"删错了还能找回"的依靠
SELECT id, LEFT(content, 30) AS content_head, is_deleted, deleted_at
FROM notes
WHERE is_deleted = 1
ORDER BY deleted_at DESC
LIMIT 10;


-- ============================================================
-- ⑨ ★ 删错了怎么找回来（Day 22：后悔药）
-- ============================================================
-- 第 1 步：先找出被删的是哪条（按删除时间倒序，最近删的在前）
SELECT id, LEFT(content, 40) AS content_head, deleted_at
FROM notes
WHERE is_deleted = 1
ORDER BY deleted_at DESC
LIMIT 20;

-- 第 2 步：确认是这条之后，把它改回来（把 'n_xxx' 换成第 1 步查到的 id）
-- UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = 'n_xxx';

-- 第 3 步：验一次 —— 该看到这条重新出现在列表里（标签也在，因为删的时候没动标签行）
-- SELECT id, LEFT(content, 40) AS content_head, created_at
-- FROM notes WHERE id = 'n_xxx' AND is_deleted = 0;

