// 사용법: node scripts/build-loader.js <저장소 안 원본 경로> <출력.txt> [깃헙토큰(비공개 저장소일 때)]
// 즐겨찾기에 한 번만 등록하면, 누를 때마다 깃헙 main 브랜치의 최신 원본을 불러와 실행하는 북마클릿을 만든다.
const fs = require('fs');
const [file, out, token = ''] = process.argv.slice(2);
const code = `(()=>{const R='sleepychoonsik/salesone_agent',B='main',F='${file}',T='${token}';` +
  `const u=T?'https://api.github.com/repos/'+R+'/contents/'+F+'?ref='+B+'&t='+Date.now():'https://raw.githubusercontent.com/'+R+'/'+B+'/'+F+'?t='+Date.now();` +
  `fetch(u,{cache:'no-store',headers:T?{Authorization:'Bearer '+T,Accept:'application/vnd.github.raw'}:{}})` +
  `.then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text()})` +
  `.then(c=>{try{(0,eval)(c)}catch(e){if(e instanceof EvalError||/Content.Security|unsafe-eval/i.test(e.message)){const s=document.createElement('script');s.textContent=c;document.head.appendChild(s)}else throw e}})` +
  `.catch(e=>alert('[세일즈원 자동화] 깃헙에서 코드를 불러오지 못했어요: '+e.message+'\\n'+u.split('?')[0]))})()`;
const line = 'javascript:' + encodeURIComponent(code);
fs.writeFileSync(out, line + '\n');
console.log(`${out}: ${line.length} chars`);
