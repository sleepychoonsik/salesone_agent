# 세일즈원 자동화 공통 규칙

1. 결과물: 즐겨찾기 북마클릿 + 같은 로직의 F12 콘솔용 원본 코드
   - 즐겨찾기는 **로더**(`loader.txt`)로 제공: 깃헙 `main` 브랜치의 원본을 불러와 실행 → 업데이트는 main에 반영만 하면 끝, 즐겨찾기 교체 불필요 (`scripts/build-loader.js`)
   - 코드 전체를 담은 `bookmarklet.txt`는 예비용
2. 버전: 코드 상단 주석과 패널 제목에 `vX.Y` 표시, 작업 폴더마다 `CHANGELOG.md` 유지
3. 진단: 모든 패널에 **[진단 내용 복사]** 버튼. 버전·단계·오류·URL·화면 요약·최근 로그·현재 팝업 HTML(축약)을 클립보드로 복사해서 Claude에게 붙여넣는다
4. 되돌리기 어려운 동작(저장 등)은 실행 전 패널에서 확인
5. 화면 요소를 못 찾으면 멈추고 "직접 처리 후 [계속]"으로 안내
6. 디자인: 모든 패널은 Claude 디자인 시스템 **"세일즈원 자동화 UI"**를 따른다
   - 레포 사본은 `design/so-ui.css` 하나(토큰 + `so-` 컴포넌트 + 입력칸 등 레포 확장). 색·간격을 패널마다 따로 쓰지 않는다
   - 패널은 Shadow DOM 안에 그리고, js에는 `const SO_UI_CSS = /*SO-UI:BEGIN*/``/*SO-UI:END*/;` 표식만 둔다. `node scripts/inject-design.js`가 표식 사이에 CSS를 채운다
   - 구성 순서: 헤더(점·이름·버전 칩·접기·닫기) → 단계 → 주 버튼 → 확인·안내 메시지 → 숫자 카드·표 → 진행 로그 → 아래 [진단 내용 복사]
   - 브라우저 `confirm` 대신 패널 안 확인창을 쓴다

빌드: `node scripts/inject-design.js` (디자인 CSS를 고쳤을 때) → `node scripts/build-loader.js <원본 경로> <loader.txt>` / `node scripts/build-bookmarklet.js <원본.js> <bookmarklet.txt>` (terser 필요)
