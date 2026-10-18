/* ============================================================
   scan.cjs —— 密钥排查（Day 23，上线红线）
   ============================================================
   为什么这件事要排在"功能"前面：
     代码推到公开仓库是**不可撤回**的。密钥一旦上去，
     就算下一秒删掉，GitHub 的 fork / 缓存 / 各种镜像站都还留着。
     功能做错了可以明天改，密钥泄露改不回来 —— 所以它是红线，不是待办。

   这个脚本干四件事：
     一、把仓库里**该扫的文件**列出来（跳过 .git / node_modules / 二进制）
     二、用 8 条规则扫高置信度的密钥特征
     三、把"环境变量的名字"和"真实的值"分开（名字不是密钥）
     四、查 .env 本身：在不在版本库里、在不在历史里、有没有被忽略

   ★ 脚本自己也上了一道保险（--selftest）：
     把一段**假的**密钥塞进临时文件，确认 8 条规则**每一条都能抓到**。
     否则"扫描结果 0 条"到底是"真的干净"还是"规则根本没生效"，说不清 ——
     后者是最危险的假绿：它会让你以为安全。

   用法：
     node skills/notelab-safety-check/scan.cjs            正常扫描
     node skills/notelab-safety-check/scan.cjs --selftest 自检扫描器本身
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/* ---------- 输出用的小工具 ---------- */
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


/* ============================================================
   一、扫描范围
   ============================================================ */

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.workbuddy', '.cache', 'dist', 'build', 'coverage'
]);
// 二进制 / 大文件不扫：读了也没意义，还慢
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.mp4', '.mp3',
  '.zip', '.gz', '.pdf', '.woff', '.woff2', '.ttf', '.eot'
]);
const MAX_BYTES = 512 * 1024;   // 超过 512KB 的文件当作不是源码，跳过

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 读成文本；二进制或过大返回 null */
function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    // 前 8KB 里出现 NUL 字节就当二进制
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString('utf8');
  } catch (e) {
    return null;
  }
}


/* ============================================================
   二、8 条规则
   ============================================================
   ★ 每条都先剥掉 URL 再扫。
     理由（今天真踩到过）：db.js 注释里那个 CloudBase 文档地址
     "…/database/configuration/db/tdsql/initialization"
     被"32 位以上长串"规则当成 base64 命中了 ——
     **误报一次的代价，是下次真命中时你开始不信它。**
   ============================================================ */

/** 剥掉 URL 与注释里的网址，避免长路径被当成密钥 */
function stripUrls(text) {
  return text
    .replace(/https?:\/\/[^\s"'<>)\]]+/g, ' ')
    .replace(/\b[\w.-]+\.(com|cn|net|org|io|dev)\b[^\s"'<>)\]]*/g, ' ');
}

const RULES = [
  {
    id: 'R1',
    name: 'OpenAI / Anthropic 风格密钥（sk-…）',
    re: /sk-[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'R2',
    name: 'AWS Access Key（AKIA…）',
    re: /AKIA[0-9A-Z]{16}/g
  },
  {
    id: 'R3',
    name: 'GitHub Token（ghp_ / github_pat_）',
    re: /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/g
  },
  {
    id: 'R4',
    name: 'Slack Token（xox[baprs]-…）',
    re: /xox[baprs]-[A-Za-z0-9-]{10,}/g
  },
  {
    id: 'R5',
    name: '私钥块（-----BEGIN … PRIVATE KEY-----）',
    re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g
  },
  {
    id: 'R6',
    // ★ 名字和注释里都**不要**写完整的示例 —— 我第一版在注释里写了一句
    //   "别写成 协议://账号:口令@主机 的样子，会被自己命中",
    //   结果那句注释本身就是个完整示例，被自己这条规则命中了（同一天踩两遍）。
    //   所以这里只描述形状，一个完整样例都不给。
    name: '连接串里带密码（协议名://账号:口令@主机）',
    re: /\b(mysql|postgres|postgresql|mongodb|redis|amqp)(\+srv)?:\/\/[^\s:/@"']+:[^\s@"']+@/g
  },
  {
    id: 'R7',
    name: '硬编码赋值（password = "真实的值"）',
    re: /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']([^"'\n]{4,})["']/g,
    /* ★ 这一条最容易误报，所以要过滤"占位符"：
       文档里写 password = "你的密码" 是**教材**，不是泄露。
       判断占位符的三条：含中文 / 是尖括号或大括号包起来的 / 是明显的示例词。 */
    isPlaceholder: (value) =>
      /[\u4e00-\u9fa5]/.test(value) ||                       // 含中文
      /^[<{]|[>}]$/.test(value) ||                           // <这里填> / {{DB_PASSWORD}}
      /^(xxx+|your|changeme|change_me|todo|placeholder|example|test|demo|123456|password)/i.test(value) ||
      /^\$\{/.test(value)                                    // ${process.env.X}
  },
  {
    id: 'R8',
    name: '长串指纹（32 位以上、大小写数字混合）',
    re: /\b(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{32,}={0,2}\b/g
    /* ★ "必须大小写数字都有"这条不是随便加的：
       git 的提交号是 40 位**纯小写**十六进制，没有大写 ——
       不加这条，仓库里每个 commit sha 都会被报成密钥（全是误报）。 */
  }
];

/** 对一段文本跑全部规则，返回命中列表 */
function scanText(text, fileLabel) {
  const hits = [];
  const prepped = stripUrls(text);

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(prepped)) !== null) {
      const raw = m[0];
      // R7 要额外判占位符；其它规则命中即算
      if (rule.isPlaceholder && rule.isPlaceholder(m[2] !== undefined ? m[2] : raw)) continue;

      const lineNo = prepped.slice(0, m.index).split('\n').length;
      hits.push({
        rule: rule.id,
        ruleName: rule.name,
        file: fileLabel,
        line: lineNo,
        // ★ 只打前 12 个字符 + 长度 —— 万一真扫出密钥，这个脚本的输出本身
        //   也不该变成第二处泄露（输出会被贴进截图、进聊天记录）
        evidence: raw.slice(0, 12) + '…（共 ' + raw.length + ' 字符）'
      });
    }
  }
  return hits;
}


/* ============================================================
   三、"名字" 与 "值" 要分开
   ============================================================
   process.env.DB_PASSWORD 这种是**读取环境变量的名字**，
   它出现在代码里天经地义，而且恰恰是"没有硬编码"的证据。
   把它们和真值混在一起报，会让"0 命中"这个结论永远达不到，
   最后的结果一定是有人把它关掉。
   ============================================================ */
const ENV_READ = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g;
const SECRETISH_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|API|CREDENTIAL)/i;

function collectEnvReads(text) {
  const names = new Set();
  ENV_READ.lastIndex = 0;
  let m;
  while ((m = ENV_READ.exec(text)) !== null) names.add(m[1]);
  return names;
}


/* ============================================================
   四、.env 与忽略规则
   ============================================================ */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

/* git 会不会忽略这个路径（返回命中的规则行；**没被忽略返回空串**）
   ★ 这里有个坑，今天真踩到：
     `git check-ignore -v` 遇到**否定规则**（`!xxx`）时，退出码仍然是 0，
     而且把那行 `!.env.example` 原样打印出来。
     只看"有没有输出"就会把它判成"被忽略了" —— 而真相恰好相反
     （S-06 当天报的就是这个假红，用 `git status --ignored` 才看出是 ?? 不是 !!）。
   所以必须自己看规则行是不是以 ! 开头。 */
function ignoredBy(relPath) {
  const out = git(['check-ignore', '-v', relPath]).trim();
  if (!out) return '';                       // 没命中任何规则 = 不忽略 = 会推上去
  // 输出形如：.gitignore:16:!.env.example\t.env.example
  const pattern = out.split('\t')[0].split(':').slice(2).join(':');
  return pattern.startsWith('!') ? '' : out; // 否定规则 = 不忽略
}


/* ============================================================
   主流程
   ============================================================ */
function main() {
  const files = walk(ROOT, []);
  const scanned = [];
  let allHits = [];
  const envNames = new Set();

  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;                 // 二进制 / 太大，跳过
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    scanned.push({ rel, ignored: ignoredBy(rel) !== '' });
    allHits = allHits.concat(scanText(text, rel));
    for (const n of collectEnvReads(text)) envNames.add(n);
  }

  /* ---------- ★ 分两类，这个区分比"扫到几处"更要紧 ----------
     被 .gitignore 忽略的文件**根本推不上去**，里面就算有密码也不是泄露；
     而"没被忽略"的文件会在下次 git add -A 时一起走。
     混在一起报的话，.env 里那个正常存在的密码会天天报警，
     报久了人就会把这条检查关掉 —— 那才是真的危险。 */
  for (const h of allHits) {
    const rec = scanned.find((s) => s.rel === h.file);
    h.uploadable = !(rec && rec.ignored);
  }

  const uploadable = scanned.filter((s) => !s.ignored);
  const localOnly = scanned.filter((s) => s.ignored);

  console.log('\n一｜扫描范围');
  console.log('  已扫文件：' + scanned.length + ' 个（跳过 .git / node_modules / 二进制 / >512KB）');
  console.log('    其中 **会推上仓库** 的：' + uploadable.length + ' 个 ← 红线的真正范围');
  console.log('    已被忽略、只在本机的：' + localOnly.length + ' 个' +
    (localOnly.length ? '（' + localOnly.map((s) => s.rel).join(', ') + '）' : ''));
  for (const s of uploadable) console.log('    · ' + s.rel);

  console.log('\n二｜8 条密钥特征规则（只看**会推上仓库**的那 ' + uploadable.length + ' 个文件）');
  let total = 0;
  for (const rule of RULES) {
    const hits = allHits.filter((h) => h.rule === rule.id && h.uploadable);
    total += hits.length;
    check(rule.id + ' ' + rule.name + ' → 命中 ' + hits.length + ' 条',
      hits.length === 0,
      hits.map((h) => h.file + ':' + h.line + ' ' + h.evidence).join(' | '));
  }

  const localHits = allHits.filter((h) => !h.uploadable);
  if (localHits.length) {
    console.log('  ⓘ 另有 ' + localHits.length + ' 处命中在**已被忽略**的本机文件里 —— 不是泄露，但值得看一眼：');
    for (const h of localHits) console.log('      ' + h.file + ':' + h.line + '  ' + h.rule + ' ' + h.evidence);
  }

  console.log('\n三｜"环境变量名"与"真实值"分开看');
  const secretish = [...envNames].filter((n) => SECRETISH_NAME.test(n));
  if (secretish.length === 0) {
    console.log('  （没有读任何带密钥味的环境变量）');
  } else {
    for (const n of secretish) {
      // 名字本身不是泄露；要断言的是"它旁边没有硬编码的值"
      console.log('  ✓ ' + n + ' —— 只以 process.env.' + n + ' 的形式出现，是**读名字**，不是硬编码的值');
      pass++;
    }
  }
  check('S-01 ★ 会推上仓库的文件里，一处密钥**值**都没有（只有环境变量名）',
    total === 0, total + ' 处');

  console.log('\n四｜.env 与忽略规则');
  const envPath = path.join(ROOT, '.env');
  const envExists = fs.existsSync(envPath);

  console.log('  ' + (envExists ? '· 工作区里有 .env（这是**正常且必要**的：密码得有个地方放）'
                                 : '· 工作区里没有 .env'));

  const tracked = git(['ls-files', '.env', '.env.*']).trim();
  check('S-02 ★ 版本库里**没有** .env（git ls-files 查不到）',
    tracked === '', tracked);

  const inHistory = git(['log', '--all', '--oneline', '--', '.env', '.env.*']).trim();
  check('S-03 ★ git 历史里**从未**出现过 .env（泄露了删文件也没用，历史还在）',
    inHistory === '', inHistory.split('\n')[0]);

  const ig1 = ignoredBy('.env');
  check('S-04 .env 被 .gitignore 忽略', ig1 !== '', '没命中任何忽略规则');
  if (ig1) console.log('      命中规则：' + ig1);

  // ★ 这一条是今天补的缺口：原来只有 .env / .env.local / .env.*.local，
  //   .env.production、.env.bak 这类**漏在网外**，改个名字就被推上去。
  const probes = ['.env', '.env.local', '.env.production', '.env.development', '.env.bak'];
  const missed = probes.filter((p) => ignoredBy(p) === '');
  check('S-05 ★ 各种 .env 变体**全都被**忽略（含 .env.production / .env.bak）',
    missed.length === 0, '漏了 ' + missed.join(', '));

  // 反向：模板文件必须**能**进仓库，否则队友不知道该配什么
  const exampleIgnored = ignoredBy('.env.example');
  check('S-06 .env.example **不被**忽略（它是给队友看的模板，该进仓库）',
    exampleIgnored === '', exampleIgnored);
  /* ★ 拿第二把尺子再量一次（今天正是靠它拆穿了 check-ignore 的坑）：
     `git status --porcelain --ignored` 里，
       `!! 文件` = 已忽略（推不上去）
       `?? 文件` = 未跟踪但**可以** git add 上去
     同一个事实换个问法，两边对得上才算数。 */
  const statusLines = git(['status', '--porcelain', '--ignored'])
    .split('\n').filter((l) => /env/i.test(l));
  const envLine = statusLines.find((l) => l.trim().endsWith('.env'));
  const exLine = statusLines.find((l) => l.trim().endsWith('.env.example'));
  check('S-08 ★ 交叉验证：git status 里 .env 是 !!（已忽略）、.env.example 是 ??（可提交）',
    /^!!/.test(envLine || '') && /^\?\?/.test(exLine || ''),
    (envLine || '(.env 没出现)') + ' / ' + (exLine || '(.env.example 没出现)'));

  check('S-09 .env.example 存在，且里面只有占位符没有真值',
    (() => {
      const p = path.join(ROOT, '.env.example');
      if (!fs.existsSync(p)) return false;
      return scanText(readText(p) || '', '.env.example').length === 0;
    })());

  console.log('\n' + '='.repeat(64));
  console.log('密钥排查结果：' + total + ' 条命中' + (total === 0 ? '（干净）' : '（★ 有泄露，立刻处理）'));
  console.log('断言：' + pass + '/' + (pass + failures.length) + ' 通过');
  console.log('='.repeat(64));

  if (total > 0 || failures.length) {
    console.log('\n未通过项：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    if (total > 0) {
      console.log('\n★ 真扫到密钥时的处理顺序（别慌、别只删文件）：');
      console.log('  1. 先去服务商后台**吊销/轮换**那把钥匙 —— 删代码救不了已经泄的密钥');
      console.log('  2. 再把值挪进 .env / 云函数环境变量，代码里只留 process.env.XXX');
      console.log('  3. 最后才是改历史（git filter-repo），并强制推送');
    }
    process.exitCode = 1;
  }
}


/* ============================================================
   --selftest：给扫描器自己上保险
   ============================================================
   "扫描结果 0 条"有两种可能：真的干净，或者规则根本没生效。
   这两种看起来一模一样，所以必须能区分 —— 办法是喂一段**假的**密钥进去，
   看每条规则是不是都能叫。有一条叫不应的，就说明那条规则是摆设。
   ============================================================ */
function selftest() {
  console.log('\n自检：给扫描器喂一段**假的**密钥，每条规则都必须叫');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notelab-selftest-'));

  /* ★ 样本**故意用短片段拼接**，源码里不留任何完整的密钥字面量。
     为什么非要这么别扭：
       第一版我老老实实把 `"const K = 'sk-abcdefghij…';"` 写进源码，
       结果**扫描器把自己的测试夹具扫了出来** —— R1~R8 全红（8 条假红）。
       假红一次，下次真红了就会有人说"它一直都红的吧" —— 这条检查就废了。

     拼接的两条硬约束（改这段时照着守）：
       ① 每个片段必须在源码里**单独不构成命中**（前缀和主体分开、长度压到 32 以下）
       ② 拼完之后必须**确实构成命中**（由下面那段断言盯住） */
  const s = (a, b) => a + b;

  const samples = {
    R1: "const K = '" + s('sk-', 'abcdefghij0123456789ABCDEFGH') + "';",
    R2: "aws_key = '" + s('AKIA', 'IOSFODNN7EXAMPLE') + "';",
    R3: "gh = '" + s('ghp_', 'abcdefghij0123456789abcdefghij012345') + "';",
    R4: "slack = '" + s('xoxb-', '123456789012-abcdefghijklmnop') + "';",
    R5: "-----BEGIN " + s('RSA ', 'PRIVATE KEY-----'),
    R6: "const url = '" + s('mysql://root:', 'hunter2@127.0.0.1:3306/notelab') + "';",
    // 变量名用 passwd（在规则词表里），但**值**拆成 4 段，
    // 这样源码里凑不出 `passwd = "<连续4字符以上>"` 这个形状，运行时拼起来又确实命中
    R7: ['const passwd = "', 'Hun', 'ter2', 'Hun', 'ter2', '";'].join(''),
    R8: "blob = '" + s('aB3dEfGh1JkL', 'mNoPqRsTuVwXyZ') + s('0123', '456789abcd') + "';"
  };

  for (const rule of RULES) {
    const file = path.join(tmp, rule.id + '.txt');
    fs.writeFileSync(file, samples[rule.id]);
    const hits = scanText(fs.readFileSync(file, 'utf8'), rule.id + '.txt');
    check(rule.id + ' 注入假密钥后能被抓到（否则这条规则是摆设）',
      hits.some((h) => h.rule === rule.id),
      '没抓到，样本：' + samples[rule.id].slice(0, 30));
  }

  // 反向：教材里的占位符**不该**被当成泄露
  const doc = 'password = "你的数据库密码"  /* 这是教材，不是密钥 */';
  const docHits = scanText(doc, '教材.txt');
  check('R7 反向：占位符「你的数据库密码」不被误报（文档里写示例是正常的）',
    docHits.length === 0, JSON.stringify(docHits.map((h) => h.evidence)));

  // 反向：git 提交号（40 位纯小写十六进制）不该被当成密钥
  const sha = '见提交 5d52aeb9a16c9b68cfe553cc2bdab9955e6f79e3 那次改动';
  const shaHits = scanText(sha, '提交号.txt');
  check('R8 反向：40 位 git 提交号不被误报（所以规则要求"大小写数字都有"）',
    shaHits.length === 0, JSON.stringify(shaHits.map((h) => h.evidence)));

  // 反向：文档 URL 不该被当成密钥（今天真的踩到过）
  const url = '参考 https://docs.cloudbase.net/database/configuration/db/tdsql/initialization 这一页';
  const urlHits = scanText(url, '文档地址.txt');
  check('R8 反向：文档 URL 不被误报（先剥 URL 再扫，否则全是噪音）',
    urlHits.length === 0, JSON.stringify(urlHits.map((h) => h.evidence)));

  console.log('\n' + '='.repeat(64));
  console.log('扫描器自检：' + pass + '/' + (pass + failures.length) + ' 通过');
  console.log('='.repeat(64));
  if (failures.length) {
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
}

if (process.argv.includes('--selftest')) selftest();
else main();
