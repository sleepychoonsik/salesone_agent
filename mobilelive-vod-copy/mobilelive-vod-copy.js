/*
 * 세일즈원 모바일라이브 [VOD] 편성상품 복사 자동화 v1.0
 *
 * 사용 위치: 세일즈원 > 아이템 편성 > 모바일라이브 탭 (프로그램명 '와니' 등으로 조회한 상태)
 * 하는 일:
 *   1) 목록에서 프로그램명에 [VOD]가 있고 상품코드가 비어 있는 편성을 찾는다.
 *   2) 각 편성의 상품코드 칸을 더블클릭해 상품 편성 화면으로 이동하고, 방송일시/프로그램명이 맞는지 확인한다.
 *      (틀리면 방송일시 캘린더 > 프로그램 조회 팝업에서 해당 편성을 찾아 들어간다.)
 *   3) 편성상품 복사 팝업에서 프로그램명 괄호 안 원방송 일시(예: 10/1 17시)로 조회하고,
 *      같은 시간에 여러 개면 브랜드명(와니/AM)이 들어간 편성을 골라 편성 상품 적용 > 확인.
 *   4) 1번 상품 주력상품 체크 > (확인 후) 저장 > 확인, 목록으로 돌아가 상품코드가 채워졌는지 검증.
 * 저장 전에는 기본적으로 한 건씩 확인을 받는다. 자동화가 화면을 못 찾으면 멈추고 직접 처리 후 [계속]을 누르게 한다.
 */
(async () => {
  'use strict';
  if (window.__MLCOPY && window.__MLCOPY.show) { window.__MLCOPY.show(); return; }

  const VER = '1.0';
  const PANEL_ID = '__mlcopy_panel';
  const S = { stop: false, running: false, autoSave: false, targets: [] };

  // ---------- 공통 유틸 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, '');
  const txt = el => (el ? (el.innerText != null ? el.innerText : el.textContent) : '').replace(/\s+/g, ' ').trim();
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inPanel = el => !!(el && el.closest && el.closest('#' + PANEL_ID));
  const pad = n => String(n).padStart(2, '0');
  const STOP = new Error('STOP');

  async function waitFor(fn, ms = 8000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (S.stop) throw STOP;
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function fire(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: /down$/.test(type) ? 1 : 0, detail: 1, ...extra
    };
    const Ev = /^pointer/.test(type) && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ev(type, init));
  }
  async function realClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(120);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => fire(el, t));
    await sleep(250);
  }
  async function realDblClick(el) {
    await realClick(el);
    ['mousedown', 'mouseup', 'click'].forEach(t => fire(el, t, { detail: 2 }));
    fire(el, 'dblclick', { detail: 2 });
    await sleep(300);
  }

  // React 제어 input 값 넣기
  async function setInput(el, v) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await sleep(300);
    return el.value === v;
  }

  function findBtn(scope, label) {
    const L = norm(label);
    const btns = [...(scope || document).querySelectorAll('button, [role="button"]')]
      .filter(b => !inPanel(b) && norm(b.textContent) === L && vis(b));
    return btns[btns.length - 1] || null;
  }

  // 라벨(p.fieldLabel 등) 옆의 input 찾기
  function fieldInput(scope, label) {
    const L = norm(label);
    const lab = [...(scope || document).querySelectorAll('.fieldLabel, label, p, span')]
      .find(e => !inPanel(e) && norm(e.textContent) === L && vis(e));
    if (!lab) return null;
    let n = lab;
    for (let i = 0; i < 4 && n; i++) {
      n = n.parentElement;
      const inp = n && n.querySelector('input:not([type="checkbox"]):not([type="hidden"]):not([aria-hidden="true"])');
      if (inp) return inp;
    }
    return null;
  }

  // ---------- TOAST UI Grid ----------
  const gridsIn = scope => [...(scope || document).querySelectorAll('.tui-grid-container')].filter(vis);
  function headerMap(grid) {
    const m = {};
    grid.querySelectorAll('th[data-column-name]').forEach(th => {
      const k = norm(txt(th));
      if (k && !m[k]) m[k] = th.getAttribute('data-column-name');
    });
    return m;
  }
  function colOf(grid, ...labels) {
    const m = headerMap(grid);
    for (const l of labels) if (m[norm(l)]) return m[norm(l)];
    return null;
  }
  function renderedRows(grid) {
    const rows = new Map();
    grid.querySelectorAll('td[data-row-key]').forEach(td => {
      const k = td.getAttribute('data-row-key');
      if (!rows.has(k)) rows.set(k, { key: k, cells: {}, tds: {} });
      const r = rows.get(k);
      const c = td.getAttribute('data-column-name');
      r.cells[c] = txt(td);
      r.tds[c] = td;
    });
    return [...rows.values()];
  }
  // 가상 스크롤 대응: 위에서부터 내려가며 행 수집, pred 만족 행을 찾으면 바로 반환
  async function scanGrid(grid, pred) {
    const sc = grid.querySelector('.tui-grid-rside-area .tui-grid-body-area');
    const all = new Map();
    if (sc && sc.scrollTop > 0) { sc.scrollTop = 0; await sleep(250); }
    for (let guard = 0; guard < 300; guard++) {
      for (const r of renderedRows(grid)) {
        all.set(r.key, r);
        if (pred && pred(r)) return { found: r, all: [...all.values()] };
      }
      if (!sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
      sc.scrollTop += Math.max(28, sc.clientHeight - 30);
      await sleep(250);
    }
    return { found: null, all: [...all.values()] };
  }

  // ---------- 화면 찾기 ----------
  function listPanel() {
    const c = [...document.querySelectorAll('.gui-tabPanel')]
      .filter(p => p.querySelector('th[data-column-name="pgmTitleNm"]') && p.querySelector('th[data-column-name="mainBroadPrdCd"]') && vis(p));
    return c[c.length - 1] || null;
  }
  const listGrid = () => { const p = listPanel(); return p && gridsIn(p).find(g => g.querySelector('th[data-column-name="pgmTitleNm"]')); };

  function prodPanel() {
    const c = [...document.querySelectorAll('.gui-tabPanel')]
      .filter(p => !p.querySelector('th[data-column-name="pgmTitleNm"]') && findBtn(p, '편성상품 복사') && norm(p.textContent).includes('방송상품편성'));
    return c[c.length - 1] || null;
  }
  const prodGrid = p => gridsIn(p).find(g => colOf(g, '주력상품'));
  const prodInfo = p => ({
    dtm: (fieldInput(p, '방송일시') || {}).value || '',
    pgm: (fieldInput(p, '프로그램명') || {}).value || ''
  });

  // 팝업: 제목 텍스트(버튼이 아닌 요소)를 찾고 그리드를 품은 조상까지 올라감
  function dialogByTitle(title) {
    const T = norm(title);
    const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div,strong')]
      .filter(e => !inPanel(e) && !e.closest('button') && norm(e.textContent) === T &&
        ![...e.children].some(ch => norm(ch.textContent) === T) && vis(e));
    for (const h of heads.reverse()) {
      let n = h;
      for (let i = 0; i < 12 && n; i++) {
        n = n.parentElement;
        if (n && n.querySelector('.tui-grid-container')) return n;
      }
    }
    return null;
  }

  // 확인/알림 창 처리 (확인 버튼을 눌러 닫고 메시지를 모은다)
  const OK_LABELS = ['확인', '예', 'OK'];
  async function handleConfirms({ max = 3, firstWait = 5000, nextWait = 2000 } = {}) {
    const msgs = [];
    for (let i = 0; i < max; i++) {
      const btn = await waitFor(() => {
        const bs = [...document.querySelectorAll('button')]
          .filter(b => !inPanel(b) && OK_LABELS.includes(norm(b.textContent)) && vis(b));
        return bs[bs.length - 1];
      }, i === 0 ? firstWait : nextWait);
      if (!btn) break;
      const box = btn.closest('[role="dialog"], [role="alertdialog"], .MuiDialog-paper, .swal2-popup, [class*="odal"], [class*="ialog"]') ||
        (btn.parentElement && btn.parentElement.parentElement);
      const m = txt(box).replace(/(^|\s)(확인|취소|닫기)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
      msgs.push(m);
      log('  └ 알림창: ' + (m || '(내용 없음)') + ' → 확인');
      await realClick(btn);
      await sleep(600);
    }
    return msgs;
  }
  const nativeMsgs = [];
  const nat = { alert: window.alert, confirm: window.confirm };
  function patchNative(on) {
    if (on) {
      window.alert = m => { nativeMsgs.push(String(m)); log('  └ 알림(alert): ' + m); };
      window.confirm = m => { nativeMsgs.push(String(m)); log('  └ 확인(confirm): ' + m + ' → 확인'); return true; };
    } else { window.alert = nat.alert; window.confirm = nat.confirm; }
  }
  const ERR_RE = /실패|오류|에러|error|불가|없습니다|입력하|선택하|필수|확인하여|확인해\s*주/i;
  function errIn(msgs) { return msgs.find(m => ERR_RE.test(m)); }

  // ---------- 규칙 ----------
  // "(10/1 17시)", "(9/1 19)", "(10/3 9시)", "(10/1 17:30)" → 원방송 일시
  function parseOrig(pgm, startDtm) {
    const m = pgm.match(/\(\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2})(?:\s*[:시]\s*(\d{1,2})?)?/);
    if (!m) return null;
    const ty = +startDtm.slice(0, 4), tm = +startDtm.slice(5, 7), mo = +m[1];
    const y = mo > tm ? ty - 1 : ty;
    return { date: `${y}-${pad(mo)}-${pad(+m[2])}`, time: `${pad(+m[3])}:${pad(m[4] ? +m[4] : 0)}` };
  }
  const AM_RE = /아뜰리에|마졸리|(^|[^A-Za-z])AM([^A-Za-z]|$)/i;
  const WANI_RE = /와니|WANI/i;
  const brandOf = pgm => (WANI_RE.test(pgm) ? 'WANI' : AM_RE.test(pgm) ? 'AM' : null);
  const brandMatch = (name, b) => (b === 'WANI' ? WANI_RE.test(name) : b === 'AM' ? AM_RE.test(name) : false);
  const BRAND_LABEL = { WANI: '와니', AM: 'AM' };

  // ---------- 패널 UI ----------
  const css = `
#${PANEL_ID}{position:fixed;top:70px;right:16px;width:440px;max-height:82vh;z-index:2147483647;background:#fff;border:2px solid #1e6fe8;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);font:13px/1.45 'Malgun Gothic',sans-serif;color:#222;display:flex;flex-direction:column}
#${PANEL_ID} .h{background:#1e6fe8;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move;border-radius:7px 7px 0 0}
#${PANEL_ID} .h button{background:none;border:0;color:#fff;font-size:16px;cursor:pointer}
#${PANEL_ID} .b{padding:10px 12px;overflow:auto}
#${PANEL_ID} .t{max-height:190px;overflow:auto;border:1px solid #ddd;border-radius:6px;margin:6px 0}
#${PANEL_ID} .t label{display:flex;gap:6px;padding:4px 8px;border-bottom:1px solid #f0f0f0;cursor:pointer}
#${PANEL_ID} .t label small{color:#888}
#${PANEL_ID} .row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
#${PANEL_ID} .btn{padding:5px 10px;border:1px solid #1e6fe8;background:#fff;color:#1e6fe8;border-radius:5px;cursor:pointer;font:inherit}
#${PANEL_ID} .btn.p{background:#1e6fe8;color:#fff}
#${PANEL_ID} .btn.r{border-color:#d33;color:#d33}
#${PANEL_ID} .btn:disabled{opacity:.4;cursor:default}
#${PANEL_ID} .ask{display:none;background:#fff8e1;border:1px solid #f0c040;border-radius:6px;padding:8px;margin:6px 0;white-space:pre-wrap}
#${PANEL_ID} .log{background:#f7f7f9;border:1px solid #e3e3e3;border-radius:6px;padding:6px;height:170px;overflow:auto;font:12px/1.4 Consolas,monospace;white-space:pre-wrap}
`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const P = document.createElement('div'); P.id = PANEL_ID;
  P.innerHTML = `
<div class="h"><span>모바일라이브 VOD 편성상품 복사 v${VER}</span><button data-a="close" title="닫기">✕</button></div>
<div class="b">
  <div class="row"><button class="btn" data-a="scan">대상 다시 찾기</button><span data-r="cnt" style="align-self:center;color:#555"></span></div>
  <div class="t" data-r="list"></div>
  <label style="display:block;margin:4px 0"><input type="checkbox" data-r="auto"> 저장 전 확인 없이 자동 저장 (익숙해진 뒤 사용)</label>
  <div class="row"><button class="btn p" data-a="run">선택 항목 실행</button><button class="btn r" data-a="stop" disabled>중지</button></div>
  <div class="ask" data-r="ask"><div data-r="askMsg"></div><div class="row" data-r="askBtns"></div></div>
  <div class="log" data-r="log"></div>
</div>`;
  document.body.appendChild(P);
  const $ = sel => P.querySelector(sel);
  const logBox = $('[data-r="log"]');
  function log(m) {
    const t = new Date().toTimeString().slice(0, 8);
    logBox.textContent += `[${t}] ${m}\n`;
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[VOD복사] ' + m);
  }
  function ask(msg, labels) {
    const box = $('[data-r="ask"]');
    $('[data-r="askMsg"]').textContent = msg;
    const btns = $('[data-r="askBtns"]'); btns.innerHTML = '';
    box.style.display = 'block';
    return new Promise(res => {
      labels.forEach((l, i) => {
        const b = document.createElement('button');
        b.className = 'btn' + (i === 0 ? ' p' : '');
        b.textContent = l;
        b.onclick = () => { box.style.display = 'none'; res(l); };
        btns.appendChild(b);
      });
      S.cancelAsk = () => { box.style.display = 'none'; res('중지'); };
    });
  }
  // 자동화가 못 하는 단계: 사용자가 직접 처리 후 계속
  async function manual(msg) {
    log('⏸ ' + msg.split('\n')[0]);
    const a = await ask('⏸ ' + msg + '\n\n직접 처리한 뒤 [계속]을 눌러주세요.', ['계속', '이 건 건너뛰기', '중지']);
    if (a === '중지') throw STOP;
    if (a === '이 건 건너뛰기') throw new Error('SKIP');
  }

  // 드래그 이동
  (() => {
    const h = $('.h'); let sx, sy, ox, oy, on = false;
    h.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; on = true; sx = e.clientX; sy = e.clientY; const r = P.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!on) return; P.style.left = ox + e.clientX - sx + 'px'; P.style.top = oy + e.clientY - sy + 'px'; P.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { on = false; });
  })();

  // ---------- 대상 찾기 ----------
  async function scanTargets() {
    const g = listGrid();
    if (!g) { log('❗ 아이템 편성 > 모바일라이브 목록을 찾지 못했습니다. 해당 화면에서 조회 후 [대상 다시 찾기]를 눌러주세요.'); return []; }
    const { all } = await scanGrid(g);
    const ts = [];
    for (const r of all) {
      const pgm = r.cells.pgmTitleNm || '', start = r.cells.broadStrDtm || '';
      if (!/\[VOD\]/i.test(pgm) || (r.cells.mainBroadPrdCd || '').trim()) continue;
      ts.push({ pgm, start, orig: parseOrig(pgm, start), brand: brandOf(pgm) });
    }
    return ts;
  }
  function renderTargets() {
    const L = $('[data-r="list"]'); L.innerHTML = '';
    S.targets.forEach((t, i) => {
      const ok = t.orig && t.brand;
      const lb = document.createElement('label');
      lb.innerHTML = `<input type="checkbox" ${ok ? 'checked' : 'disabled'} data-i="${i}"><span><b>${t.start}</b> ${t.pgm.replace(/</g, '&lt;')}<br><small>${ok ? `원방송 ${t.orig.date} ${t.orig.time} · 브랜드 ${BRAND_LABEL[t.brand]}` : '⚠ 원방송 일시/브랜드를 읽을 수 없어 제외'}</small></span>`;
      L.appendChild(lb);
    });
    $('[data-r="cnt"]').textContent = `[VOD] 상품 빈 편성 ${S.targets.length}건`;
    if (!S.targets.length) L.innerHTML = '<div style="padding:8px;color:#888">대상 없음</div>';
  }
  async function doScan() {
    log('목록에서 [VOD] + 상품코드 빈 편성 찾는 중…');
    S.targets = await scanTargets();
    renderTargets();
    log(`대상 ${S.targets.length}건`);
  }

  // ---------- 단계 ----------
  async function goList() {
    if (listPanel()) return true;
    const cands = [...document.querySelectorAll('body *')].filter(e =>
      !inPanel(e) && norm(e.textContent) === '아이템편성' && ![...e.children].some(c => norm(c.textContent) === '아이템편성') && vis(e));
    const bottom = cands.filter(e => e.getBoundingClientRect().top > window.innerHeight * 0.6);
    const el = (bottom.length ? bottom : cands).pop();
    if (el) await realClick(el);
    if (await waitFor(listPanel, 5000)) return true;
    await manual('하단 탭에서 [아이템 편성] > 모바일라이브 목록 화면으로 이동해 주세요.');
    return !!listPanel();
  }

  async function refreshList() {
    const p = listPanel(); if (!p) return;
    const b = findBtn(p, '조회'); if (!b) return;
    await realClick(b);
    await sleep(1500);
    await waitFor(() => listGrid() && renderedRows(listGrid()).length, 6000);
  }

  const sameTarget = (info, t) => info.dtm.trim() === t.start && norm(info.pgm) === norm(t.pgm);

  async function openViaProgramPopup(t) {
    const p = prodPanel(); if (!p) return false;
    log('  프로그램명이 달라 방송일시 캘린더 > 프로그램 조회로 다시 찾습니다.');
    const inp = fieldInput(p, '방송일시'); if (!inp) return false;
    const adorn = inp.closest('.MuiInputBase-root');
    const cal = adorn && [...adorn.querySelectorAll('button')].find(vis);
    if (cal) await realClick(cal); else await realClick(inp);
    let dlg = await waitFor(() => dialogByTitle('프로그램 조회'), 3000);
    if (!dlg && cal) { await realClick(inp); dlg = await waitFor(() => dialogByTitle('프로그램 조회'), 3000); }
    if (!dlg) return false;
    const day = t.start.slice(0, 10);
    const dIn = fieldInput(dlg, '방송일자');
    if (dIn && dIn.value !== day) await setInput(dIn, day);
    const q = findBtn(dlg, '조회'); if (q) await realClick(q);
    const g = await waitFor(() => { const gg = gridsIn(dlg)[0]; return gg && renderedRows(gg).some(r => Object.values(r.cells).some(v => v.startsWith(day))) && gg; }, 6000);
    if (!g) return false;
    const cD = colOf(g, '방송일시'), cP = colOf(g, '프로그램명');
    const { found } = await scanGrid(g, r => r.cells[cD] === t.start && norm(r.cells[cP]) === norm(t.pgm));
    if (!found) return false;
    await realClick(found.tds[cD]);
    if (!(await waitFor(() => !dialogByTitle('프로그램 조회'), 1500))) {
      const again = (await scanGrid(g, r => r.cells[cD] === t.start && norm(r.cells[cP]) === norm(t.pgm))).found;
      if (again) await realDblClick(again.tds[cD]);
    }
    return !!(await waitFor(() => { const pp = prodPanel(); return pp && sameTarget(prodInfo(pp), t); }, 6000));
  }

  async function processOne(t) {
    log(`▶ ${t.start} ${t.pgm}`);
    // 1) 목록에서 행 찾기
    await goList();
    const g = listGrid();
    const { found } = await scanGrid(g, r => r.cells.broadStrDtm === t.start && norm(r.cells.pgmTitleNm) === norm(t.pgm));
    if (!found) { log('  목록에서 행을 찾지 못해 건너뜁니다.'); return 'skip'; }
    if ((found.cells.mainBroadPrdCd || '').trim()) { log('  이미 상품이 있어 건너뜁니다.'); return 'skip'; }

    // 2) 상품코드 칸 더블클릭 → 상품 편성
    await realDblClick(found.tds.mainBroadPrdCd);
    let p = await waitFor(() => { const pp = prodPanel(); return pp && sameTarget(prodInfo(pp), t) && pp; }, 7000);
    if (!p && prodPanel()) {
      const info = prodInfo(prodPanel());
      log(`  열린 화면: ${info.dtm} ${info.pgm}`);
      if (await openViaProgramPopup(t)) p = prodPanel();
    }
    if (!p) {
      await manual(`상품 편성 > 모바일라이브 화면에서 아래 편성을 직접 열어주세요.\n${t.start} ${t.pgm}`);
      p = prodPanel();
      if (!p || !sameTarget(prodInfo(p), t)) { log('  편성이 일치하지 않아 건너뜁니다.'); return 'skip'; }
    }
    log('  상품 편성 화면 진입 확인');

    // 3) 이미 상품이 있으면 중복 복사 방지
    let pg = prodGrid(p);
    if (pg && renderedRows(pg).length) { log('  이 편성에는 이미 방송상품이 있어 건너뜁니다.'); return 'skip'; }

    // 4) 편성상품 복사 팝업
    const copyBtn = findBtn(p, '편성상품 복사');
    if (copyBtn) await realClick(copyBtn);
    let dlg = await waitFor(() => dialogByTitle('편성상품 복사'), 5000);
    if (!dlg) { await manual('[편성상품 복사] 팝업을 열어주세요.'); dlg = dialogByTitle('편성상품 복사'); if (!dlg) return 'skip'; }

    const { date, time } = t.orig;
    const want = `${date} ${time}`;
    let sIn = dlg.querySelector('input[name="startDate"]'), eIn = dlg.querySelector('input[name="endDate"]');
    if (!sIn || !eIn) {
      const ds = [...dlg.querySelectorAll('input')].filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.value));
      sIn = sIn || ds[0]; eIn = eIn || ds[1];
    }
    if (sIn) await setInput(sIn, date);
    if (eIn) await setInput(eIn, date);
    const q = findBtn(dlg, '조회'); if (q) await realClick(q);
    const hasDate = () => { const gg = gridsIn(dlg)[0]; return gg && renderedRows(gg).some(r => Object.values(r.cells).some(v => v.startsWith(date))) && gg; };
    let cg = await waitFor(hasDate, 6000);
    if (!cg) { await manual(`팝업의 방송일자를 ${date} ~ ${date} 로 맞추고 [조회]를 눌러주세요.`); cg = hasDate(); if (!cg) return 'skip'; }

    // 5) 원방송 편성 고르기
    const cD = colOf(cg, '방송일시'), cP = colOf(cg, '프로그램명', '프로그램 명');
    const { all } = await scanGrid(cg);
    const atTime = all.filter(r => (r.cells[cD] || '').trim() === want);
    let cand = atTime.filter(r => brandMatch(r.cells[cP] || '', t.brand));
    if (cand.length > 1) { const live = cand.filter(r => !/VOD/i.test(r.cells[cP] || '')); if (live.length) cand = live; }
    let srcName = '';
    if (cand.length === 1) {
      srcName = cand[0].cells[cP];
      const fresh = (await scanGrid(cg, r => r.key === cand[0].key)).found;
      await realClick(fresh.tds[cD]);
      log(`  원본 선택: ${want} ${srcName}`);
    } else {
      const names = atTime.map(r => ' - ' + r.cells[cP]).join('\n') || ' (해당 시간 편성 없음)';
      await manual(`${want} 원본 편성을 자동으로 고르지 못했습니다(${BRAND_LABEL[t.brand]} 포함 ${cand.length}건).\n${names}\n팝업에서 원본 편성을 클릭해 선택해 주세요.`);
      srcName = '(직접 선택)';
    }

    // 6) 편성 상품 적용 → 확인
    const apply = findBtn(dlg, '편성 상품 적용') || findBtn(document, '편성 상품 적용');
    if (!apply) { await manual('[편성 상품 적용] 버튼을 눌러 주세요.'); }
    else {
      nativeMsgs.length = 0;
      await realClick(apply);
      const msgs = (await handleConfirms({ max: 2, firstWait: 4000 })).concat(nativeMsgs);
      const err = errIn(msgs);
      if (err) { await manual(`적용 중 메시지: ${err}\n화면을 확인해 주세요.`); }
    }
    if (!(await waitFor(() => !dialogByTitle('편성상품 복사'), 4000))) {
      await manual('편성상품 복사 팝업이 아직 열려 있습니다. 적용이 끝났는지 확인하고 팝업을 닫아 주세요.');
    }

    // 7) 복사 결과 확인 + 1번 주력상품 체크
    p = prodPanel();
    pg = await waitFor(() => { const gg = prodGrid(p); return gg && renderedRows(gg).length && gg; }, 8000);
    if (!pg) { await manual('복사된 방송상품이 보이지 않습니다. 확인해 주세요.'); pg = prodGrid(prodPanel()); if (!pg || !renderedRows(pg).length) return 'skip'; }
    const cMain = colOf(pg, '주력상품'), cNo = colOf(pg, 'No.', 'No'), cCode = colOf(pg, '상품코드'), cName = colOf(pg, '상품명');
    const prows = (await scanGrid(pg)).all;
    const first = (await scanGrid(pg, r => cNo && r.cells[cNo] === '1')).found || renderedRows(pg)[0];
    const cb = first && first.tds[cMain] && first.tds[cMain].querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) { cb.click(); await sleep(400); }
    const firstNow = first && (renderedRows(pg).find(r => r.key === first.key) || first);
    const cbNow = firstNow && firstNow.tds[cMain] && firstNow.tds[cMain].querySelector('input[type="checkbox"]');
    if (!cbNow || !cbNow.checked) await manual('1번 상품의 [주력상품]을 체크해 주세요.');
    const firstCode = first ? first.cells[cCode] : '';
    const firstName = first ? first.cells[cName] : '';
    log(`  복사된 상품 ${prows.length}개, 1번 ${firstCode} 주력 체크`);

    // 8) 저장 (확인 후)
    if (!S.autoSave) {
      const a = await ask(
        `저장할까요?\n\n대상: ${t.start} ${t.pgm}\n원본: ${want} ${srcName}\n상품 ${prows.length}개 · 1번(주력) ${firstCode} ${firstName}`,
        ['저장', '이 건 건너뛰기(저장 안 함)', '이후 모두 자동 저장', '중지']);
      if (a === '중지') throw STOP;
      if (a.startsWith('이 건')) { log('  저장하지 않고 건너뜀 (화면에 복사된 내용은 저장 전 상태로 남아 있습니다)'); return 'skip'; }
      if (a === '이후 모두 자동 저장') { S.autoSave = true; $('[data-r="auto"]').checked = true; }
    }
    const save = findBtn(prodPanel(), '저장');
    if (!save) { await manual('[저장] 버튼을 눌러 주세요.'); }
    else {
      nativeMsgs.length = 0;
      await realClick(save);
      const msgs = (await handleConfirms({ max: 3, firstWait: 5000, nextWait: 2500 })).concat(nativeMsgs);
      const err = errIn(msgs);
      if (err) { log('  ❗ 저장 메시지: ' + err); await manual(`저장 중 메시지: ${err}\n화면을 확인해 주세요.`); }
    }

    // 9) 목록으로 돌아가 검증
    await goList();
    await refreshList();
    const chk = (await scanGrid(listGrid(), r => r.cells.broadStrDtm === t.start && norm(r.cells.pgmTitleNm) === norm(t.pgm))).found;
    const code = chk ? (chk.cells.mainBroadPrdCd || '').trim() : '';
    if (code) { log(`  ✅ 완료: 목록 상품코드 ${code}`); return 'ok'; }
    log('  ⚠ 저장 후 목록에 상품코드가 보이지 않습니다. 직접 확인해 주세요.');
    return 'check';
  }

  async function run() {
    if (S.running) return;
    const idx = [...P.querySelectorAll('[data-r="list"] input[type="checkbox"]:checked')].map(c => +c.dataset.i);
    const list = idx.map(i => S.targets[i]);
    if (!list.length) { log('선택된 대상이 없습니다.'); return; }
    S.running = true; S.stop = false; S.autoSave = $('[data-r="auto"]').checked;
    $('[data-a="run"]').disabled = true; $('[data-a="scan"]').disabled = true; $('[data-a="stop"]').disabled = false;
    patchNative(true);
    const res = { ok: [], skip: [], check: [], fail: [] };
    try {
      for (const t of list) {
        try {
          const r = await processOne(t);
          res[r].push(t);
        } catch (e) {
          if (e === STOP) throw e;
          if (e && e.message === 'SKIP') { log('  건너뜀'); res.skip.push(t); continue; }
          log('  ❌ 오류: ' + (e && e.message)); console.error(e); res.fail.push(t);
          const a = await ask(`오류가 났습니다: ${e && e.message}\n다음 건으로 계속할까요?`, ['계속', '중지']);
          if (a === '중지') throw STOP;
        }
      }
    } catch (e) {
      if (e === STOP) log('■ 중지했습니다.'); else { log('❌ ' + (e && e.message)); console.error(e); }
    } finally {
      patchNative(false);
      S.running = false;
      $('[data-a="run"]').disabled = false; $('[data-a="scan"]').disabled = false; $('[data-a="stop"]').disabled = true;
      log(`=== 결과: 완료 ${res.ok.length} · 확인필요 ${res.check.length} · 건너뜀 ${res.skip.length} · 오류 ${res.fail.length}`);
      res.check.concat(res.fail).forEach(t => log(`   확인: ${t.start} ${t.pgm}`));
      if (listPanel()) await doScan().catch(() => {});
    }
  }

  P.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const act = a.dataset.a;
    if (act === 'close') { if (S.running) { S.stop = true; S.cancelAsk && S.cancelAsk(); } P.style.display = 'none'; }
    if (act === 'scan') doScan();
    if (act === 'run') run();
    if (act === 'stop') { S.stop = true; S.cancelAsk && S.cancelAsk(); log('중지 요청…'); }
  });
  $('[data-r="auto"]').addEventListener('change', e => { S.autoSave = e.target.checked; });

  window.__MLCOPY = { show: () => { P.style.display = 'flex'; if (!S.running) doScan(); } };
  log(`v${VER} 시작. 대상 확인 후 [선택 항목 실행]을 누르세요.`);
  await doScan();
})();
