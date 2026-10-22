// 사용법: node scripts/build-bookmarklet.js <원본.js> <출력.txt>
// terser로 압축한 뒤 javascript: 북마클릿 한 줄로 만든다. (npm i terser 필요)
const fs = require('fs');
const { minify } = require('terser');
(async () => {
  const [src, out] = process.argv.slice(2);
  const code = fs.readFileSync(src, 'utf8');
  const r = await minify(code, { compress: true, mangle: true, format: { comments: false } });
  const line = 'javascript:' + encodeURIComponent(r.code);
  fs.writeFileSync(out, line + '\n');
  console.log(`${out}: ${line.length} chars`);
})();
