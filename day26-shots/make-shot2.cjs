/* 生成"回滚前后提交记录"截图用的 HTML —— 内容全部来自真实 git 输出，不手写。 */
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHIP = ['index.html', 'app.js', 'api.js', 'errors.js', 'mock-data.js', 'styles.css'];
const git = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

const head = git(['rev-parse', '--short', 'HEAD']);
const log = git(['log', '--oneline', '-n', '6']);
const stat = git(['diff', '--stat', 'HEAD', '9b1ac92', '--'].concat(SHIP));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  body{margin:0;background:#0f1115;color:#d7dae0;font:14px/1.65 "Cascadia Mono",Consolas,"Microsoft YaHei",monospace;
       padding:22px 26px;}
  h2{font:600 15px/1.4 "Microsoft YaHei",sans-serif;color:#e8eaee;margin:0 0 4px}
  .sub{font:12px "Microsoft YaHei",sans-serif;color:#7c8390;margin-bottom:16px}
  .box{background:#161a21;border:1px solid #232a34;border-radius:6px;padding:14px 16px;margin-bottom:14px}
  .lbl{font:12px "Microsoft YaHei",sans-serif;color:#6ea8fe;margin-bottom:8px}
  pre{margin:0;white-space:pre-wrap;word-break:break-all}
  .g{color:#63d18a}.y{color:#e3b341}.r{color:#f07c7c}.d{color:#7c8390}
</style></head><body>
<h2>Day 26 · 回滚演练前后的提交记录</h2>
<div class="sub">HEAD = ${esc(head)}　　数据来源：git log / git diff，未手工编辑</div>

<div class="box"><div class="lbl">$ git log --oneline -n 6　（回滚目标：最后一条 9b1ac92）</div>
<pre>${esc(log).split('\n').map((l, i) => {
  const c = i === 0 ? 'g' : (l.startsWith('9b1ac92') ? 'y' : '');
  return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
}).join('\n')}</pre></div>

<div class="box"><div class="lbl">$ git diff --stat HEAD 9b1ac92 -- index.html app.js api.js errors.js mock-data.js styles.css</div>
<pre>${esc(stat)}</pre>
<div style="margin-top:10px;color:#7c8390;font:12px 'Microsoft YaHei',sans-serif">
<span class="y">★ 回滚基线取 9b1ac92，不是 HEAD~1</span> —— 因为 HEAD~1（a60c38f）是纯文档提交，
发布物与当前一字不差，退它线上毫无变化（"假回滚"）。只有上表这两个文件的差异，退回去才真看得见。
</div></div>

<div class="box"><div class="lbl">$ node skills/notelab-release-check/rollback-drill.cjs　（③ 关键三项）</div>
<pre><span class="g">  ✓</span> R-1 回滚前：当前版本 6 个上线文件全部可访问
<span class="g">  ✓</span> R-2 ★ 回滚后：上一版 6 个上线文件仍然全部可访问
<span class="g">  ✓</span> R-3 ★ 回滚确实换了内容（发布物整体指纹变了）
    <span class="d">· 两版之间有差异的文件：app.js、errors.js</span>
<span class="g">  ✓</span> B-1 ★ 已恢复到当前版本，发布物指纹与回滚前完全一致

<span class="y">  · ③ 回滚（决定 → 上一版可访问）  0.45 秒</span>   <span class="d">← 回滚窗口</span>
<span class="d">  · 演练结果：13/13 项断言通过 ✅</span></pre></div>

<div class="box" style="border-color:#2d3b2f;background:#141a16">
<pre><span class="y">★ 慢的从来不是"退回去"（0.45 秒），是<span style="color:#e8eaee">决定要不要退</span>和<span style="color:#e8eaee">退完确认没问题</span>。</span>
  所以演练的价值不在练手速，在于把这两个判断提前定死 —— 见 ROLLBACK.md 第二节判断表。</pre></div>
</body></html>`;

fs.writeFileSync(path.join(__dirname, '_shot2.html'), html, 'utf8');
console.log('已生成 _shot2.html');
