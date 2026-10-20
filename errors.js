/* ============================================================
   errors.js —— 三类错误的中文提示（Day 23 新增）
   ============================================================
   为什么要有这个文件：
     改之前，同一句话散在四个地方，各写各的 ——
       · api.js 里三段网络报错
       · app.js 里三处存储提示
       · app.js 里 error-box 的兜底「未知错误」
       · 云函数 index.js 里那句「服务器开小差了」
     后果不是"不好看"，是**同一类病在不同地方说法不一样**：
     用户在写笔记页看到"注意：浏览器不允许本地存储"，
     在列表页看到"未知错误"，他不知道这是两回事还是一回事。

     "统一"的意思就是：同一类错误 → 同一句话 → 只有一个地方能改它。

   ★ 这个文件**不是**异常处理框架（今天明确不做那个）。
     它只是一张文案表 + 两个"把原始错误翻成人话"的小函数。
     真正的 try/catch 仍然留在各处的业务代码里，一行没动。

   ---------- 三类是怎么划的 ----------
     A 存储类：数据存不下 / 读不出（本地存储的问题，跟网络无关）
     B 网络类：数据取不到（跨域 / 地址 / 形状，三病同症状不同治法）
     C 服务端类：接口明确回了个失败（400 / 404 / 409 / 500）

   ---------- 每条文案的三条硬要求（自检会逐条盯）----------
     ① 是中文
     ② 说清"发生了什么"，不是"出错了"
     ③ 带一句"下一步看哪 / 做什么"（把排查成本还给我，不推给用户）
   ============================================================ */

const ERROR_MESSAGES = {
  /* ---------- A 存储类 ---------- */
  storage: {
    // 隐私模式 / 浏览器禁用存储：连"试写一下"都抛错
    unavailable: '浏览器不允许本地存储（可能是隐私模式）。这次记的内容关掉页面就会丢 —— '
      + '换个普通窗口打开，或者先复制到别处存着。',
    // 空间写满：存储是能用的，只是装不下（★ 改前这条被误报成"不允许存储"）
    quota: '本地存储空间写满了，这条没存上。删掉一些旧笔记再试，'
      + '或者先去「全部笔记」看看有没有可以清掉的。',
    // 存进去的东西读不出来了（被别的程序改过 / 版本不兼容）
    corrupt: '本地存的数据读不出来（可能坏了）。已按"空列表"继续，页面不会卡住 —— '
      + '你之前记的内容还在浏览器里，别急着清空。',
    // ★ Day 24 新增：**有一部分**读不出来（数组里混进了不合格的条目）。
    //   这种情况改前是**直接崩**的（TypeError，整页空白），
    //   现在是"坏的跳过、好的照常显示"—— 但如果不吭声，
    //   用户只会看到自己的笔记少了几条，却不知道为什么少，
    //   那跟"页面吞了我的笔记"没区别。所以这一类**必须**说话。
    /* ⚠️ 这是**直接显示给用户**的字符串，不是 Markdown —— 别在里面写 **加粗** 之类，
       否则用户在界面上看到的会是带星号的原文（第一版就是这么写的）。 */
    partial: '有几条笔记读不出来（数据可能被改坏了），已经跳过，其余的照常显示 —— '
      + '坏的那几条还留在浏览器里没删，按 F12 看 Console 里带 [notelab] 的那行就知道是哪几条。'
  },

  /* ---------- B 网络类 ---------- */
  network: {
    // fetch 直接抛错：请求根本没到服务器（断网 / DNS 失败 / 跨域被拦）
    unreachable: '取不到数据。请按 F12 看一眼：'
      + '① Network 里那条 /api/notes 是什么状态（404/502 → 地址不对；200 但没内容 → 跨域没过）；'
      + '② Console 里有没有带 CORS 的红字（有 → 是服务端响应头的问题，前端改不了）。',
    // 请求通了但内容不是 JSON：典型是网关返回了一个 HTML 错误页
    notJson: '接口返回了 200，但内容不是 JSON（多半是网关的错误页）。'
      + 'F12 → Network 点开那条请求看 Response。',
    // JSON 是对的，但形状与 api-contract.md 不一致 —— 四种情况各说各的，
    // 因为"少了 ok"和"少了 notes"要改的地方不一样，不能都报一句"形状不对"。
    // ★ 每一条都补了"去 F12 看 Response"这一句：光说"形状不对"，
    //   用户不知道该去哪儿看、该拿什么跟契约对照（自检 M-3 就是盯这一句的）。
    notObject: '接口返回的数据看不懂（不是一个 JSON 对象）。'
      + 'F12 → Network 点开那条请求，把 Response 和 api-contract.md 对一下。',
    noOk: '接口返回里没有 ok 字段，形状与 api-contract.md 不一致。'
      + 'F12 → Network 看那条请求的 Response。',
    noNotes: '接口返回里没有 notes 数组，形状与 api-contract.md 不一致。'
      + 'F12 → Network 看那条请求的 Response。',
    failedNoReason: '接口说这次取数失败了（没给原因）。'
      + 'F12 → Network 看那条请求的状态码，再去控制台看云函数的日志。'
  },

  /* ---------- C 服务端类 ----------
     这一类分两种：接口**给了**中文原因（直接用它的），
     和接口**没给**（我们补一句，绝不留空白、也绝不显示 undefined）。 */
  server: {
    // 服务端没给原因时的兜底，按状态码说人话
    withStatus: (status) => '接口返回了 HTTP ' + status + '，但没有说明原因。'
      + (status >= 500
        ? '这是服务端的问题，重试一次通常就好。'
        : '多半是请求本身有问题（比如缺字段），对照 api-contract.md 检查一下。'),
    // 连状态码都拿不到时的最后兜底（★ 改前这里是"未知错误"三个字）
    unknown: '出了点问题，但我没拿到具体原因。'
      + '点「重试」再试一次；还是不行的话，按 F12 看 Console 里那条红色记录。'
  }
};


/* ------------------------------------------------------------
   把 localStorage 抛的**裸错误**翻成人话
   ------------------------------------------------------------
   ★ 这就是今天"把哪句裸报错改成了人话"的答案：
     浏览器给的是 `QuotaExceededError: The quota has been exceeded.`
     直接显示给用户，他看到的是一串英文 + 一个他从没听过的词；
     而且改前的代码**不管什么错都显示"浏览器不允许本地存储"** ——
     空间写满时这句是**错的**，用户会以为浏览器坏了，
     真正的解法（删几条旧笔记）他根本想不到。

   判断顺序有讲究：先看"是不是被禁用"，再看"是不是写满"，
   因为两种错的治法完全不同（换窗口 vs 删旧笔记）。
   ------------------------------------------------------------ */
function describeStorageError(err) {
  const name = (err && (err.name || err.code)) || '';
  const text = String((err && err.message) || err || '');

  // ① 被禁用 / 隐私模式：Safari 无痕、或用户在设置里关了存储
  if (/SecurityError|NotAllowedError|AccessDenied/i.test(name + ' ' + text)) {
    return 'unavailable';
  }
  if (err && (err === 'unavailable')) return 'unavailable';

  // ② 空间写满：各浏览器给的名字不统一，四种都认
  if (/QuotaExceeded|QUOTA|NS_ERROR_DOM_QUOTA_REACHED|quota/i.test(name + ' ' + text)) {
    return 'quota';
  }

  // ③ 剩下的（读出来的不是 JSON 之类）当"数据坏了"
  return 'corrupt';
}

/** 拿一句可以直接显示给用户的话（原始错误只进 console，不进界面） */
function storageMessage(err) {
  const kind = describeStorageError(err);
  return ERROR_MESSAGES.storage[kind];
}


/* ------------------------------------------------------------
   服务端那类：优先用接口自己给的中文原因
   ------------------------------------------------------------
   接口给的原因才是准的（比如"content 最多 5000 字，当前 5200 字"），
   我们不该用自己的话盖掉它。只在它**没给**的时候才补。
   ------------------------------------------------------------ */
function serverMessage(status, serverReason) {
  const reason = typeof serverReason === 'string' ? serverReason.trim() : '';
  if (reason) return reason;                       // 接口说了原因 → 直接用
  if (typeof status === 'number') return ERROR_MESSAGES.server.withStatus(status);
  return ERROR_MESSAGES.server.unknown;
}


/* 给自检脚本和页面共用（浏览器挂 window，Node 走 module） */
const errorsModule = {
  ERROR_MESSAGES,
  describeStorageError,
  storageMessage,
  serverMessage
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = errorsModule;
}
if (typeof window !== 'undefined') {
  window.NoteLabErrors = errorsModule;
}
