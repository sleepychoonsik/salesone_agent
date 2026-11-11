// 사용법: node scripts/inject-design.js [패널.js ...]   (인자 없으면 모든 패널)
// design/so-ui.css(디자인 시스템 토큰 + 컴포넌트)를 한 줄로 줄여, 각 패널 js의
//   /*SO-UI:BEGIN*/ ... /*SO-UI:END*/
// 사이에 넣는다. 북마클릿은 파일 하나로 실행되므로 CSS를 js 안에 넣어 둬야 한다.
// CSS를 고친 뒤에는 이 스크립트 → build-bookmarklet.js 순서로 돌린다.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'design/so-ui.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*\n\s*/g, '')
  .replace(/\s*([{};,])\s*/g, '$1')
  .replace(/;}/g, '}')
  .trim();
if (/[`\\]|\$\{/.test(css)) throw new Error('so-ui.css에 `, \\, ${ 는 쓸 수 없어요 (js 템플릿 문자열 안에 들어갑니다)');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(root)
  .filter(d => fs.existsSync(path.join(root, d, d + '.js'))).map(d => path.join(d, d + '.js'));
const RE = /\/\*SO-UI:BEGIN\*\/[\s\S]*?\/\*SO-UI:END\*\//;
for (const f of files) {
  const p = path.isAbsolute(f) ? f : path.join(root, f);
  const src = fs.readFileSync(p, 'utf8');
  if (!RE.test(src)) { console.log(`${f}: 표식(/*SO-UI:BEGIN*/…/*SO-UI:END*/) 없음 — 건너뜀`); continue; }
  fs.writeFileSync(p, src.replace(RE, () => '/*SO-UI:BEGIN*/`' + css + '`/*SO-UI:END*/'));
  console.log(`${f}: 디자인 CSS ${css.length}자 반영`);
}
