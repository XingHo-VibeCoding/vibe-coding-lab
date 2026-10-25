/* 给截图加一条说明条（真实网址 + 截图方式），不伪造浏览器外壳。
   用法：node make-caption.cjs <原始图> <输出图> <标题> <网址行> <说明行> */
const fs = require('fs');
const path = require('path');

const [raw, out, title, urlLine, noteLine] = process.argv.slice(2);
if (!raw || !out) { console.error('参数不够'); process.exit(1); }

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#f4f5f7;font-family:"Microsoft YaHei",system-ui,sans-serif}
  .cap{padding:14px 20px;background:#101418;color:#e9ecf1}
  .t{font-size:15px;font-weight:600;margin-bottom:6px}
  .u{font:13px/1.5 Consolas,"Microsoft YaHei",monospace;color:#7fd3a0;word-break:break-all}
  .n{font-size:12px;color:#8b93a1;margin-top:5px}
  img{display:block;width:100%;height:auto}
</style></head><body>
<div class="cap">
  <div class="t">${esc(title)}</div>
  <div class="u">${esc(urlLine)}</div>
  <div class="n">${esc(noteLine)}</div>
</div>
<img src="${esc(path.basename(raw))}">
</body></html>`;

fs.writeFileSync(path.join(path.dirname(out), '_cap.html'), html, 'utf8');
console.log('已生成 _cap.html');
