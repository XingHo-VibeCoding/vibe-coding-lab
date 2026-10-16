-- ============================================================
-- db/schema.sql —— NoteLab 数据表结构（Day 16）
--
-- 目标库：腾讯云 CloudBase 的 **MySQL**（控制台 → 数据库 → MySQL → SQL 编辑器）
-- 幂等：每句都带 IF NOT EXISTS，重复执行不报错、不改变已有表
-- 设计说明（两张表分别存什么、靠哪个字段关联、字段类型为什么这么选）见 db/README.md
--
-- 为什么是两张表而不是一张：
--   一条笔记有 0～5 个标签。把标签塞进 notes 的一个字段（比如逗号分隔），
--   就再也写不出"按标签筛选"和"每个标签有几条"这类查询 —— 只能把整列取回来在代码里拆。
--   拆成关联表之后，这两件事分别是一句 WHERE 和一句 GROUP BY。
-- ============================================================


-- ---------- 表一：notes（笔记本体）----------
-- 一条笔记一行，只存"笔记自己"的信息，不存标签
CREATE TABLE IF NOT EXISTS notes (
  id           VARCHAR(32)   NOT NULL
               COMMENT '笔记 ID，形如 n_1727...；沿用前端既有的字符串 ID，不用自增，老数据可直接平移',
  content      VARCHAR(5000) NOT NULL
               COMMENT '笔记正文（含 #标签 原文）。5000 与前端 MAX_LENGTH 一致，前端拦不住的后端还要拦',
  created_at   DATETIME(3)   NOT NULL
               COMMENT '创建时间，毫秒精度，库里一律存 UTC。用 DATETIME 不用 TIMESTAMP：TIMESTAMP 有 2038 年上限，且会随会话时区自动换算',
  client_token VARCHAR(64)   NULL
               COMMENT '提交幂等键（Day 18）：同一次提交被重发时，靠这一列的唯一索引把第二遍挡掉。NULL = 不是通过 POST 接口写进来的（比如 seed 数据）',
  is_deleted   TINYINT(1)    NOT NULL DEFAULT 0
               COMMENT '软删除标记（Day 22）：0=正常，1=已删除。**DELETE 只改这个标记，不真删行**，所以删错了能改回来。所有查询都带 is_deleted = 0',
  deleted_at   DATETIME(3)   NULL
               COMMENT '删除时间（Day 22），毫秒精度 UTC。只在 is_deleted=1 时有值；留着是为了以后排查"什么时候删的"，也是恢复时的线索',
  PRIMARY KEY (id),
  UNIQUE KEY uk_notes_client_token (client_token),
  KEY idx_notes_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='笔记：列表按 created_at 倒序显示；删除是软删除（is_deleted）';

-- ★ 关于 is_deleted 的三个要点（Day 22）
--
-- 1) 为什么"删除"不真删：新增错了是"多一条"，删除错了是"少一条"，
--    而少掉的东西**找不回来**。软删除把 DELETE 从不可逆操作变成可逆操作 ——
--    这是删除这件事唯一真正的后悔药（界面上的二次确认只能防手滑，防不了误判）。
--
-- 2) 为什么是 TINYINT(1) 而不是 DATETIME 判空：
--    "有没有被删"是一个是非，用布尔最直白；时间单独一列，两件事分开存。
--    也有人只用 deleted_at（NULL=没删），但那样 "WHERE deleted_at IS NULL"
--    没法建有效索引，而且读代码时要绕一下才明白意图。
--
-- 3) ★ 代价（必须知道）：SELECT COUNT(*) FROM notes **不会因为删除而减少**，
--    因为行还在。要数"实际有几条"必须写 WHERE is_deleted = 0
--    （db/verify.sql 里有现成的一句）。以后做任何统计都别忘了这一条。

-- ★ 关于 client_token 的两个要点（Day 18）
--
-- 1) 为什么是真的唯一索引，而不是"插入前先 SELECT 查一遍"：
--    先查再插有竞态 —— 两个请求可能同时查到"不存在"，然后双双插入成功。
--    唯一索引是数据库层面的一次裁决，并发也挡得住。代码里因此**没有**那句预查，
--    直接 INSERT，捕到 ER_DUP_ENTRY(1062) 就回 409。
--
-- 2) 为什么允许 NULL：MySQL 的唯一索引**不约束 NULL**，所以可以有任意多行 NULL。
--    这一点正好用得上 —— seed 数据、以及将来别的方式写进来的行都可以不带 token，
--    而它们彼此不会互相冲突。如果这一列设成 NOT NULL 就没这个余地了。
--
-- 注意 content 用的是表默认排序规则 utf8mb4_unicode_ci（大小写不敏感），
-- 这是**故意的**：PRD 验收 3.1 要求搜索"不区分大小写"，
-- 这样 `WHERE content LIKE '%flomo%'` 能匹配到 Flomo。

-- ⚠️ 如果你的 notes 表是 Day 16 那一版建的（还没有 client_token 这一列），
--    执行下面这句补上。MySQL **不支持** `ADD COLUMN IF NOT EXISTS`，
--    所以重复执行会报 "Duplicate column name" —— 那不是错误，是它告诉你已经有了。
--
-- ALTER TABLE notes
--   ADD COLUMN client_token VARCHAR(64) NULL
--     COMMENT '提交幂等键（Day 18）：同一次提交被重发时靠唯一索引挡掉第二遍',
--   ADD UNIQUE KEY uk_notes_client_token (client_token);
--
-- ⚠️ Day 22：还要再加软删除那两列。同上，重复执行报 "Duplicate column name" 属正常。
-- ALTER TABLE notes
--   ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0
--     COMMENT '软删除标记：0=正常，1=已删除',
--   ADD COLUMN deleted_at DATETIME(3) NULL
--     COMMENT '删除时间，UTC';


-- ---------- 表二：note_tags（标签关联）----------
-- 一条笔记有几个标签就几行；标签名直接存在这里，不另开关联用的 tags 表
CREATE TABLE IF NOT EXISTS note_tags (
  note_id  VARCHAR(32)      NOT NULL
           COMMENT '外键 → notes.id。**这就是两张表关联的字段**',
  tag      VARCHAR(50)      NOT NULL COLLATE utf8mb4_bin
           COMMENT '标签名（不含 #）。utf8mb4_bin = 区分大小写，因为 PRD 规定标签区分大小写；用默认的 _ci 会把 Work 和 work 合并成同一个标签',
  position TINYINT UNSIGNED NOT NULL DEFAULT 0
           COMMENT '标签在原文里的出现顺序，从 0 开始。保住原有顺序，前端不用二次排序',
  PRIMARY KEY (note_id, tag),
  KEY idx_note_tags_tag (tag),
  CONSTRAINT fk_note_tags_note
    FOREIGN KEY (note_id) REFERENCES notes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='标签关联：一条笔记最多 5 个标签 → 最多 5 行；删笔记时标签行自动跟着删';


-- ============================================================
-- 两个刻意的取舍（先记在这里，等真需要了再回来改）
--
-- 1) 不建第三张 tags 表。
--    只有"标签自身的属性"（颜色、自定义排序顺序）才需要独立表。
--    那些属于 CANDIDATES.md 里的 C4，本期没批准 —— 现在建就是空壳。
--    等 C4 立项，加一张 tags(tag, sort_order) 即可，两张表现在不用动。
--
-- 2) 不加 content 的索引。
--    搜索用的是 LIKE '%关键词%'（前置通配符），普通索引根本用不上。
--    笔记量在个人工具的规模（几百到几千条），全表扫描完全够快。
-- ============================================================
