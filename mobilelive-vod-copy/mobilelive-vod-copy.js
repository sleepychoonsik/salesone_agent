/*
 * 세일즈원 모바일라이브 [VOD] 편성상품 복사 자동화 v1.5.2  (변경 이력: CHANGELOG.md)
 *
 * 사용 위치: 세일즈원 > 아이템 편성 > 모바일라이브 탭 (프로그램명 '와니' 등으로 조회한 상태)
 * 하는 일:
 *   0) 아이템 편성 > 모바일라이브 탭에서 방송일자(오늘~30일 뒤)·프로그램명(와니)을 넣고 조회한다.
 *   1) 목록에서 프로그램명에 [VOD]가 있고 상품코드가 비어 있는 편성을 찾는다.
 *   2) 각 편성의 상품코드 칸을 더블클릭해 상품 편성 화면으로 이동하고, 방송일시/프로그램명이 맞는지 확인한다.
 *      (틀리면 방송일시 캘린더 > 프로그램 조회 팝업에서 해당 편성을 찾아 들어간다.)
 *   3) 편성상품 복사 팝업에서 프로그램명 괄호 안 원방송 일시(예: 10/1 17시)로 조회하고,
 *      같은 시간에 여러 개면 브랜드명(와니/AM)이 들어간 편성을 골라 편성 상품 적용 > 확인.
 *   4) 1번 상품 주력상품 체크 > (확인 후) 저장 > 확인, 목록으로 돌아가 상품코드가 채워졌는지 검증.
 * 저장 전에는 기본적으로 한 건씩 확인을 받는다. 자동화가 화면을 못 찾으면 멈추고 직접 처리 후 [계속]을 누르게 한다.
 * 문제가 생기면 패널의 [진단 내용 복사]로 버전·단계·오류·URL·화면 요약을 클립보드에 담아 Claude에게 붙여넣는다.
 */
(async () => {
  'use strict';
  const VER = '1.5.2';
  const TOOL = '모바일라이브 VOD 편성상품 복사';
  const PANEL_ID = '__mlcopy_panel';
  // 최신 버전 확인: raw 주소는 최대 5분 캐시되므로, 최신 커밋을 직접 조회해 더 새 버전이 있으면 그걸 실행한다
  if (!window.__MLCOPY_FRESH) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
      const R = 'sleepychoonsik/salesone_agent', F = 'mobilelive-vod-copy/mobilelive-vod-copy.js';
      const sha = (await (await fetch(`https://api.github.com/repos/${R}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store', signal: ctl.signal })).text()).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        const code = await (await fetch(`https://raw.githubusercontent.com/${R}/${sha}/${F}`, { signal: ctl.signal })).text();
        const m = code.match(/const VER = '([^']+)'/);
        clearTimeout(tm);
        if (m && m[1] !== VER) {
          window.__MLCOPY_FRESH = true;
          setTimeout(() => { window.__MLCOPY_FRESH = false; }, 5000);
          (0, eval)(code);
          return;
        }
      }
      clearTimeout(tm);
    } catch (e) { /* 확인 실패 시 지금 버전으로 진행 */ }
  }
  // 같은 버전이 이미 떠 있으면 다시 보여주기만, 다른(옛) 버전이면 지우고 새로 띄운다(깃헙 자동 업데이트 대응)
  if (window.__MLCOPY) {
    if (window.__MLCOPY.ver === VER && window.__MLCOPY.show) { window.__MLCOPY.show(); return; }
    if (window.__MLCOPY.running && window.__MLCOPY.running()) { alert('이전 버전이 실행 중입니다. 중지한 뒤 다시 눌러주세요.'); return; }
    const old = document.getElementById(PANEL_ID); if (old) old.remove();
    window.__MLCOPY = null;
  }
  const S = { stop: false, running: false, autoSave: false, targets: [], step: '대기', cur: null, errors: [], logs: [] };
  const setStep = name => { S.step = name; };

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

  // 날짜 입력은 화면 컴포넌트마다 반응 방식이 달라 여러 방법을 차례로 시도한다.
  function reactProps(el) {
    const k = Object.keys(el).find(x => x.startsWith('__reactProps$'));
    return k ? el[k] : null;
  }
  const execCmd = (c, u, v) => { try { return document.execCommand(c, u, v); } catch (e) { return false; } };
  const fakeEv = (el, type) => ({ target: el, currentTarget: el, type, nativeEvent: new Event(type), bubbles: true,
    preventDefault() {}, stopPropagation() {}, persist() {}, isDefaultPrevented: () => false, isPropagationStopped: () => false });
  const DATE_WAYS = {
    '값 직접 설정': async (el, v) => { await setInput(el, v); },
    'React onChange 호출': async (el, v) => {
      const pr = reactProps(el); if (!pr) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      pr.onFocus && pr.onFocus(fakeEv(el, 'focus'));
      pr.onChange && pr.onChange(fakeEv(el, 'change'));
      await sleep(150);
      pr.onBlur && pr.onBlur(fakeEv(el, 'blur'));
      await sleep(250);
    }
  };
  // ---------- 달력 클릭으로 날짜 고르기 (세일즈원 날짜칸은 입력이 아니라 달력 클릭으로만 바뀜) ----------
  const isLeaf = e => ![...e.children].some(c => c.textContent.trim());
  const MONTH_RE = /^(\d{4})년\s*(\d{1,2})월$/;
  function calHeads() {
    return [...document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,h6,strong,button,th,td')]
      .filter(e => !inPanel(e) && MONTH_RE.test(e.textContent.trim()) && isLeaf(e) && vis(e));
  }
  const numLeafs = root => [...root.querySelectorAll('*')].filter(e => /^\d{1,2}$/.test(e.textContent.trim()) && isLeaf(e) && vis(e));
  function calMonths() {
    const heads = calHeads();
    const raw = heads.map(h => {
      let panel = h;
      for (let i = 0; i < 10 && panel; i++) {
        panel = panel.parentElement;
        if (panel && numLeafs(panel).length >= 28) break;
      }
      const [, y, m] = h.textContent.trim().match(MONTH_RE);
      return { y: +y, m: +m, head: h, panel };
    }).filter(x => x.panel);
    // 1부터 연속으로 증가하는 묶음(28개 이상)을 한 달로 본다. 앞뒤 회색 날짜는 제외됨.
    // 두 달이 한 덩어리에 있으면 제목 순서대로 묶음을 짝지음.
    return raw.map(x => {
      const cells = numLeafs(x.panel);
      const runs = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].textContent.trim() !== '1') continue;
        const run = new Map();
        for (let j = i, n = 1; j < cells.length && +cells[j].textContent.trim() === n; j++, n++) run.set(n, cells[j]);
        if (run.size >= 28) { runs.push(run); i += run.size - 1; }
      }
      const same = raw.filter(o => o.panel === x.panel);
      const k = same.indexOf(x);
      return { ...x, days: runs[k] || runs[0] || new Map() };
    });
  }
  function calArrows(ms) {
    if (!ms.length) return {};
    const first = ms[0].head.getBoundingClientRect(), last = ms[ms.length - 1].head.getBoundingClientRect();
    let root = ms[0].panel;
    for (let i = 0; i < 6 && root && !ms.every(x => root.contains(x.head)); i++) root = root.parentElement;
    root = (root && root.parentElement) || document.body;
    const cy = (first.top + first.bottom) / 2;
    const cands = [...root.querySelectorAll('button,[role="button"],svg,span,div,i,a')].filter(e => {
      if (inPanel(e) || !vis(e)) return false;
      const t = e.textContent.trim();
      if (t && !/^[<>‹›«»←→]$/.test(t)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.width < 60 && r.height < 60 && Math.abs((r.top + r.bottom) / 2 - cy) < 22;
    });
    const L = cands.filter(e => e.getBoundingClientRect().right <= first.left + 2).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const R = cands.filter(e => e.getBoundingClientRect().left >= last.right - 2).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const top = e => { let n = e; while (n.parentElement && n.parentElement.getBoundingClientRect().width < 60 && n.parentElement.getBoundingClientRect().height < 60) n = n.parentElement; return n; };
    return { prev: L[0] && top(L[0]), next: R[0] && top(R[0]) };
  }
  async function calClickDay(ymdStr) {
    const [y, m, d] = ymdStr.split('-').map(Number);
    for (let guard = 0; guard < 30; guard++) {
      const ms = calMonths();
      if (!ms.length) return false;
      const hit = ms.find(x => x.y === y && x.m === m);
      if (hit) {
        const el = hit.days.get(d); if (!el) return false;
        await realClick(el);
        await sleep(350);
        return true;
      }
      const diff = (y * 12 + m) - (ms[0].y * 12 + ms[0].m);
      const ar = calArrows(ms);
      const btn = diff > 0 ? ar.next : ar.prev;
      if (!btn) return false;
      await realClick(btn);
      await sleep(300);
    }
    return false;
  }
  function closeCal(inp) {
    [inp, document.activeElement, document.body].forEach(t => t && t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })));
  }
  // getInputs(): [시작, 끝] 또는 [하루] input, values: 같은 순서의 날짜
  async function pickByCalendar(getInputs, values) {
    const ins = getInputs();
    if (!ins.length) return false;
    const want = ins.map((_, i) => values[i] != null ? values[i] : values[0]);
    if (ins.every((e, i) => e.value === want[i])) return true;
    const open = async () => {
      if (calHeads().length) return true;
      const el = getInputs()[0];
      await realClick(el);
      if (await waitFor(() => calHeads().length, 3000)) return true;
      const box = el.closest('.gui-date-picker, .gui-date-range, .MuiFormControl-root') || el.parentElement;
      const icon = box && [...(box.closest('.gui-date-picker') || box).querySelectorAll('button')].filter(vis).pop();
      if (icon) { await realClick(icon); if (await waitFor(() => calHeads().length, 3000)) return true; }
      return false;
    };
    if (!(await open())) { log('  달력이 열리지 않았습니다.'); return false; }
    for (let i = 0; i < want.length; i++) {
      if (i > 0 && !calHeads().length) { const ok2 = await open(); if (!ok2) break; }
      if (!(await calClickDay(want[i]))) { log(`  달력에서 ${want[i]}을(를) 찾지 못했습니다.`); break; }
    }
    await sleep(400);
    if (calHeads().length) { closeCal(getInputs()[0]); await sleep(300); }
    const now = getInputs().map(e => e.value);
    S.dateTries = (S.dateTries || []).concat(`${S.step}: 달력 클릭 → ${now.join(' ~ ')}`);
    return now.every((v, i) => v === want[i]);
  }

  // 일반 텍스트칸(프로그램명 등) 값 넣기: 덮어쓰기만 하고 이어 붙이지 않음
  async function setText(el, v) {
    if (el.value === v) return true;
    await setInput(el, v);
    if (el.value === v) return true;
    el.focus(); el.select && el.select();
    execCmd('insertText', false, v);
    await sleep(200);
    el.blur();
    return el.value === v;
  }

  // getInputs(): 현재 화면의 날짜 input 배열, values: 넣을 값 배열, ok(): 조회 결과가 맞는지
  async function setDatesAndQuery(scope, getInputs, values, ok) {
    if (await pickByCalendar(getInputs, values)) {
      const now = getInputs().map(e => e.value).join(' ~ ');
      const q = findBtn(scope(), '조회'); if (q) await realClick(q);
      await sleep(1200);
      if (await waitFor(ok, 12000)) { log(`  날짜 입력 성공(달력 클릭): ${now}`); return true; }
      log(`  달력으로 날짜는 바뀌었지만 조회 결과가 맞지 않습니다: ${now}`);
    }
    for (const [way, fn] of Object.entries(DATE_WAYS)) {
      if (S.stop) throw STOP;
      const ins = getInputs();
      if (!ins.length) return false;
      for (let i = 0; i < ins.length; i++) {
        const el = getInputs()[i] || ins[i];
        if (el) await fn(el, values[i] != null ? values[i] : values[0]);
      }
      const now = getInputs().map(e => e.value).join(' ~ ');
      const q = findBtn(scope(), '조회'); if (q) await realClick(q);
      await sleep(1200);
      if (await waitFor(ok, 8000)) { log(`  입력 성공(${way}): ${now}`); return true; }
      log(`  입력 시도 실패(${way}): 화면값 ${now}`);
      S.dateTries = (S.dateTries || []).concat(`${S.step}: ${way} → ${now}`);
    }
    return false;
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
    // 세일즈원 팝업은 MUI Dialog(#root 밖, role=dialog)로 뜸 → 그 안의 것만 쓴다
    for (const h of heads.slice().reverse()) {
      const d = h.closest('.MuiDialog-paper, [role="dialog"], [role="presentation"] .MuiPaper-root');
      if (d && vis(d) && !d.contains(document.getElementById('root'))) return d;
    }
    for (const h of heads.reverse()) {
      if (document.getElementById('root') && document.getElementById('root').contains(h) && document.getElementById('root').getAttribute('aria-hidden') === 'true') continue;
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
#${PANEL_ID} input:not([type]){border:1px solid #bbb;border-radius:4px;padding:2px 4px;font:inherit}
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
  <div class="row" style="align-items:center">방송일자 <input data-r="sd" size="10" style="width:92px"> ~ <input data-r="ed" size="10" style="width:92px"> 프로그램명 <input data-r="kw" style="width:60px"></div>
  <div class="row"><button class="btn p" data-a="search">조회 + 대상 찾기</button><button class="btn" data-a="scan">대상 다시 찾기</button><button class="btn" data-a="diag" title="오류가 나면 눌러서 Claude에게 붙여넣기">진단 내용 복사</button><span data-r="cnt" style="align-self:center;color:#555"></span></div>
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
    S.logs.push(`[${t}] ${m}`); if (S.logs.length > 300) S.logs.shift();
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
        b.onclick = () => {
          if (l === '진단 내용 복사') { copyDiag(); return; }
          box.style.display = 'none'; res(l);
        };
        btns.appendChild(b);
      });
      S.cancelAsk = () => { box.style.display = 'none'; res('중지'); };
    });
  }
  // 자동화가 못 하는 단계: 사용자가 직접 처리 후 계속
  async function manual(msg) {
    log('⏸ ' + msg.split('\n')[0]);
    S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '자동화 멈춤', msg });
    const a = await ask('⏸ ' + msg + '\n\n직접 처리한 뒤 [계속]을 눌러주세요. 자주 멈추면 [진단 내용 복사]를 눌러 Claude에게 보내주세요.', ['계속', '이 건 건너뛰기', '중지', '진단 내용 복사']);
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
  // ---------- 0) 방송일자·프로그램명 세팅 후 조회 ----------
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOff = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const LS_KEY = '__mlcopy_settings';
  function loadSettings() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { o = {}; }
    $('[data-r="sd"]').value = dayOff(0);
    $('[data-r="ed"]').value = dayOff(o.days != null ? o.days : 30);
    $('[data-r="kw"]').value = o.kw || '와니';
  }
  function saveSettings() {
    const sd = new Date($('[data-r="sd"]').value), ed = new Date($('[data-r="ed"]').value);
    const days = Math.round((ed - sd) / 86400000);
    try { localStorage.setItem(LS_KEY, JSON.stringify({ kw: $('[data-r="kw"]').value.trim(), days: isNaN(days) ? 30 : days })); } catch (e) { /* 저장 불가 무시 */ }
  }
  async function searchList() {
    setStep('0 아이템 편성 조회');
    const sd = $('[data-r="sd"]').value.trim(), ed = $('[data-r="ed"]').value.trim(), kw = $('[data-r="kw"]').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) { log('❗ 방송일자를 YYYY-MM-DD 형식으로 넣어주세요.'); return false; }
    saveSettings();
    if (!(await goList(true))) { log('❗ 아이템 편성 > 모바일라이브 화면을 찾지 못했습니다. 그 화면을 연 뒤 [조회 + 대상 찾기]를 눌러주세요.'); return false; }
    log(`조회: ${sd} ~ ${ed} / 프로그램명 "${kw}"`);
    const getIns = () => {
      const p = listPanel(); if (!p) return [];
      const a = p.querySelector('input[name="startDate"]'), b = p.querySelector('input[name="endDate"]');
      const k = p.querySelector('input[placeholder*="프로그램명"]') || fieldInput(p, '프로그램명');
      return [a, b, k];
    };
    const ins = getIns();
    if (ins.some(x => !x)) { log('❗ 조회 조건 입력칸을 찾지 못했습니다. [진단 내용 복사]로 알려주세요.'); S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '입력칸 없음', msg: '방송일자/프로그램명 input' }); return false; }
    const ok = () => {
      const [a, b, k] = getIns();
      if (!a || a.value !== sd || b.value !== ed || norm(k.value) !== norm(kw)) return false;
      const g = listGrid(); if (!g) return false;
      const rows = renderedRows(g);
      return rows.every(r => { const d = (r.cells.broadStrDtm || '').slice(0, 10); return d >= sd && d <= ed && (!kw || norm(r.cells.pgmTitleNm).includes(norm(kw))); });
    };
    if (!(await setText(getIns()[2], kw))) log(`  ❗ 프로그램명 입력 확인 필요: 화면값 "${getIns()[2].value}"`);
    const done = await setDatesAndQuery(listPanel, () => getIns().slice(0, 2).filter(Boolean), [sd, ed], ok);
    if (!done) { log('❗ 조회 조건이 화면에 반영되지 않았습니다. [진단 내용 복사]로 알려주세요.'); S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '조회 조건 반영 실패', msg: `${sd}~${ed} ${kw}` }); return false; }
    await waitFor(() => listGrid() && renderedRows(listGrid()).length, 3000);
    return true;
  }
  async function searchAndScan() {
    if (S.running || S.searching) return;
    S.searching = true;
    $('[data-a="search"]').disabled = true;
    try { if (await searchList()) await doScan(); }
    catch (e) { if (e !== STOP) { log('❌ ' + e.message); S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '조회 오류', msg: e.message }); } }
    finally { S.searching = false; $('[data-a="search"]').disabled = false; S.stop = false; setStep('대기'); }
  }

  async function doScan() {
    log('목록에서 [VOD] + 상품코드 빈 편성 찾는 중…');
    S.targets = await scanTargets();
    renderTargets();
    log(`대상 ${S.targets.length}건`);
  }

  // ---------- 단계 ----------
  // 아이템 편성 화면의 모바일라이브 탭이 선택돼 있는지 확인하고 아니면 누른다
  async function ensureMobileTab() {
    const tabs = [...document.querySelectorAll('[role="tab"], button')].filter(b => !inPanel(b) && norm(b.textContent) === '모바일라이브' && vis(b));
    const lp = listPanel();
    const tab = tabs.find(b => lp && lp.contains(b)) || tabs[0];
    if (tab && tab.getAttribute('aria-selected') === 'false') { await realClick(tab); await sleep(800); }
  }
  async function goList(quiet) {
    if (listPanel()) { await ensureMobileTab(); return true; }
    const cands = [...document.querySelectorAll('body *')].filter(e =>
      !inPanel(e) && norm(e.textContent) === '아이템편성' && ![...e.children].some(c => norm(c.textContent) === '아이템편성') && vis(e));
    const bottom = cands.filter(e => e.getBoundingClientRect().top > window.innerHeight * 0.6);
    const el = (bottom.length ? bottom : cands).pop();
    if (el) await realClick(el);
    if (await waitFor(listPanel, 5000)) { await ensureMobileTab(); return true; }
    if (quiet) return false;
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
    setStep('2-1 프로그램 조회 팝업으로 재진입');
    const p = prodPanel(); if (!p) return false;
    log('  프로그램명이 달라 방송일시 캘린더 > 프로그램 조회로 다시 찾습니다.');
    const inp = fieldInput(p, '방송일시'); if (!inp) return false;
    const adorn = inp.closest('.MuiInputBase-root');
    const cal = adorn && [...adorn.querySelectorAll('button')].find(vis);
    if (cal) await realClick(cal); else await realClick(inp);
    let dlg = await waitFor(() => dialogByTitle('프로그램 조회'), 10000);
    if (!dlg && cal) { await realClick(inp); dlg = await waitFor(() => dialogByTitle('프로그램 조회'), 10000); }
    if (!dlg) return false;
    const day = t.start.slice(0, 10);
    const curDlg = () => dialogByTitle('프로그램 조회') || dlg;
    const okDay = () => { const rs = popupRowsNow(curDlg()); return rs.length > 0 && rs.every(r => r.dtm.startsWith(day)); };
    if (!okDay()) await setDatesAndQuery(curDlg, () => [fieldInput(curDlg(), '방송일자') || curDlg().querySelector('input[name="startDate"]')].filter(Boolean), [day], okDay);
    const match = r => r.dtm === t.start && norm(r.name) === norm(t.pgm);
    const { found } = await popupRows(curDlg(), match);
    if (!found) { log(`  프로그램 조회 팝업에서 ${t.start} ${t.pgm}을(를) 찾지 못했습니다.`); return false; }
    await realClick(found.el);
    if (!(await waitFor(() => !dialogByTitle('프로그램 조회'), 1500))) {
      const again = (await popupRows(curDlg(), match)).found;
      if (again) await realDblClick(again.el);
    }
    return !!(await waitFor(() => { const pp = prodPanel(); return pp && sameTarget(prodInfo(pp), t); }, 6000));
  }

  // 팝업 목록 행 읽기: TOAST 그리드면 그대로, 아니면 'YYYY-MM-DD HH:MM' 칸을 기준으로 행을 찾는다
  const DTM_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  function popupRowsNow(dlg) {
    const g = gridsIn(dlg)[0];
    if (g) {
      const cD = colOf(g, '방송일시'), cP = colOf(g, '프로그램명', '프로그램 명');
      return renderedRows(g).map(r => ({ key: 'g' + r.key, dtm: (r.cells[cD] || '').trim(), name: r.cells[cP] || '', el: r.tds[cD] }));
    }
    const leafs = [...dlg.querySelectorAll('*')].filter(e => !e.closest('input') && DTM_RE.test(e.textContent.trim()) && isLeaf(e) && vis(e));
    return leafs.map(e => {
      let row = e;
      while (row.parentElement && row.parentElement !== dlg &&
        [...row.parentElement.querySelectorAll('*')].filter(x => DTM_RE.test(x.textContent.trim()) && isLeaf(x)).length === 1) row = row.parentElement;
      const texts = [...row.querySelectorAll('*')].filter(x => isLeaf(x) && x.textContent.trim()).map(x => x.textContent.trim());
      const i = texts.indexOf(e.textContent.trim());
      const name = texts.slice(i + 1).find(x => !DTM_RE.test(x)) || '';
      return { key: e.textContent.trim() + '|' + name, dtm: e.textContent.trim(), name, el: e };
    });
  }
  async function popupRows(dlg, pred) {
    const all = new Map();
    const g = gridsIn(dlg)[0];
    const sc = g ? g.querySelector('.tui-grid-rside-area .tui-grid-body-area')
      : [...dlg.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(e).overflowY) && DTM_RE.test((e.textContent.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [''])[0]));
    if (sc && sc.scrollTop > 0) { sc.scrollTop = 0; await sleep(250); }
    for (let guard = 0; guard < 300; guard++) {
      for (const r of popupRowsNow(dlg)) { all.set(r.key, r); if (pred && pred(r)) return { found: r, all: [...all.values()] }; }
      if (!sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
      sc.scrollTop += Math.max(28, sc.clientHeight - 30);
      await sleep(250);
    }
    return { found: null, all: [...all.values()] };
  }

  async function processOne(t) {
    S.cur = t;
    log(`▶ ${t.start} ${t.pgm}`);
    // 1) 목록에서 행 찾기
    setStep('1 목록에서 대상 행 찾기');
    await goList();
    const g = await waitFor(() => { const gg = listGrid(); return gg && renderedRows(gg).length && gg; }, 6000);
    if (!g) { await manual('아이템 편성 목록이 비어 있습니다. 조회 후 [계속]을 눌러주세요.'); }
    const { found, all: seen } = await scanGrid(listGrid(), r => r.cells.broadStrDtm === t.start && norm(r.cells.pgmTitleNm) === norm(t.pgm));
    if (!found) {
      log(`  목록에서 행을 찾지 못해 건너뜁니다. (목록 ${seen.length}행: ${seen.slice(0, 3).map(r => r.cells.broadStrDtm + ' ' + r.cells.pgmTitleNm).join(' / ')}…)`);
      S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '대상 행 없음', msg: `${t.start} ${t.pgm} / 목록 ${seen.length}행` });
      return 'skip';
    }
    if ((found.cells.mainBroadPrdCd || '').trim()) { log('  이미 상품이 있어 건너뜁니다.'); return 'skip'; }

    // 2) 상품코드 칸 더블클릭 → 상품 편성
    setStep('2 상품코드 더블클릭→상품 편성 진입');
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
    setStep('3 기존 방송상품 확인');
    let pg = prodGrid(p);
    if (pg && renderedRows(pg).length) { log('  이 편성에는 이미 방송상품이 있어 건너뜁니다.'); return 'skip'; }

    // 4) 편성상품 복사 팝업
    setStep('4 편성상품 복사 팝업 조회');
    const copyBtn = findBtn(p, '편성상품 복사');
    if (copyBtn) await realClick(copyBtn);
    let dlg = await waitFor(() => dialogByTitle('편성상품 복사'), 15000);
    // 세일즈원 팝업은 뜨는 데 시간이 걸림: 날짜칸과 목록이 그려질 때까지 기다린다
    if (dlg) {
      await waitFor(() => { const d = dialogByTitle('편성상품 복사'); return d && d.querySelector('input[name="startDate"]') && popupRowsNow(d).length; }, 12000);
      await sleep(700);
    }
    if (!dlg) { await manual('[편성상품 복사] 팝업을 열어주세요.'); dlg = dialogByTitle('편성상품 복사'); if (!dlg) return 'skip'; }

    const { date, time } = t.orig;
    const want = `${date} ${time}`;
    const curDlg = () => dialogByTitle('편성상품 복사') || dlg;
    const getDates = () => {
      const d = curDlg();
      let a = d.querySelector('input[name="startDate"]'), b = d.querySelector('input[name="endDate"]');
      if (!a || !b) {
        const ds = [...d.querySelectorAll('input')].filter(i => /^\d{4}[-./]\d{2}[-./]\d{2}$/.test(i.value));
        a = a || ds[0]; b = b || ds[1];
      }
      return [a, b].filter(Boolean);
    };
    log(`  팝업 방송일자: ${getDates().map(e => e.value).join(' ~ ')} → ${date} ~ ${date}`);
    const onlyDate = () => { const rs = popupRowsNow(curDlg()); return rs.length > 0 && rs.every(r => r.dtm.startsWith(date)); };
    let okDates = onlyDate() || await setDatesAndQuery(curDlg, getDates, [date, date], onlyDate);
    if (!okDates) {
      // 기본 조회 기간(한 달)에 원방송 날짜가 들어 있으면 그대로 진행
      const d0 = getDates().map(e => e.value);
      if (d0.length === 2 && d0[0] <= date && date <= d0[1]) { log('  날짜를 못 바꿨지만 현재 조회 기간에 원방송 날짜가 포함돼 그대로 찾습니다.'); okDates = true; }
    }
    if (!okDates) { await manual(`팝업의 방송일자를 ${date} ~ ${date} 로 맞추고 [조회]를 눌러주세요.`); }

    // 5) 원방송 편성 고르기
    setStep('5 원방송 편성 선택');
    await waitFor(() => popupRowsNow(curDlg()).length, 10000);
    await sleep(500);
    const { all } = await popupRows(curDlg());
    const atTime = all.filter(r => r.dtm === want);
    let cand = atTime.filter(r => brandMatch(r.name, t.brand));
    if (cand.length > 1) { const live = cand.filter(r => !/VOD/i.test(r.name)); if (live.length) cand = live; }
    let srcName = '';
    if (cand.length === 1) {
      srcName = cand[0].name;
      const fresh = (await popupRows(curDlg(), r => r.key === cand[0].key)).found || cand[0];
      await realClick(fresh.el);
      log(`  원본 선택: ${want} ${srcName}`);
    } else {
      const names = atTime.map(r => ' - ' + r.name).join('\n') || ' (해당 시간 편성 없음)';
      log(`  ${want} 후보 ${atTime.length}건 / 팝업 행 ${all.length}건`);
      await manual(`${want} 원본 편성을 자동으로 고르지 못했습니다(${BRAND_LABEL[t.brand]} 포함 ${cand.length}건).\n${names}\n팝업에서 원본 편성을 클릭해 선택해 주세요.`);
      srcName = '(직접 선택)';
    }

    // 6) 편성 상품 적용 → 확인
    setStep('6 편성 상품 적용·확인');
    const apply = findBtn(curDlg(), '편성 상품 적용') || findBtn(document, '편성 상품 적용');
    if (!apply) { await manual('[편성 상품 적용] 버튼을 눌러 주세요.'); }
    else {
      nativeMsgs.length = 0;
      await realClick(apply);
      const msgs = (await handleConfirms({ max: 3, firstWait: 15000, nextWait: 3000 })).concat(nativeMsgs);
      const reg = msgs.join(' ').match(/(\d+)\s*개의?\s*상품/); if (reg) log(`  복사 대상 상품 ${reg[1]}개`);
      const err = errIn(msgs);
      if (err) { await manual(`적용 중 메시지: ${err}\n화면을 확인해 주세요.`); }
    }
    // 팝업이 닫힐 때까지 기다리면서, 그 사이 늦게 뜨는 확인창도 눌러 준다
    for (let i = 0; i < 4 && dialogByTitle('편성상품 복사'); i++) {
      if (await waitFor(() => !dialogByTitle('편성상품 복사'), 4000)) break;
      await handleConfirms({ max: 1, firstWait: 500 });
    }
    if (dialogByTitle('편성상품 복사')) {
      await manual('편성상품 복사 팝업이 아직 열려 있습니다. 적용이 끝났는지 확인하고 팝업을 닫아 주세요.');
    }

    // 7) 복사 결과 확인 + 1번 주력상품 체크
    setStep('7 복사 결과 확인·1번 주력 체크');
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
    setStep('8 저장·확인');
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
      const msgs = (await handleConfirms({ max: 3, firstWait: 15000, nextWait: 6000 })).concat(nativeMsgs);
      const err = errIn(msgs);
      if (err) { log('  ❗ 저장 메시지: ' + err); await manual(`저장 중 메시지: ${err}\n화면을 확인해 주세요.`); }
    }

    // 9) 목록으로 돌아가 검증
    setStep('9 목록 재조회·검증');
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
    $('[data-a="run"]').disabled = true; $('[data-a="scan"]').disabled = true; $('[data-a="search"]').disabled = true; $('[data-a="stop"]').disabled = false;
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
          S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '스크립트 오류', msg: (e && e.message) || String(e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : '' });
          const a = await ask(`오류가 났습니다: ${e && e.message}\n[진단 내용 복사]를 눌러 Claude에게 보내주시면 고쳐드려요.\n다음 건으로 계속할까요?`, ['계속', '중지', '진단 내용 복사']);
          if (a === '중지') throw STOP;
        }
      }
    } catch (e) {
      if (e === STOP) log('■ 중지했습니다.');
      else { log('❌ ' + (e && e.message)); console.error(e); S.errors.push({ time: new Date().toTimeString().slice(0, 8), step: S.step, type: '실행 중단 오류', msg: (e && e.message) || String(e) }); }
    } finally {
      patchNative(false);
      S.running = false; S.cur = null; setStep('대기');
      $('[data-a="run"]').disabled = false; $('[data-a="scan"]').disabled = false; $('[data-a="search"]').disabled = false; $('[data-a="stop"]').disabled = true;
      log(`=== 결과: 완료 ${res.ok.length} · 확인필요 ${res.check.length} · 건너뜀 ${res.skip.length} · 오류 ${res.fail.length}`);
      res.check.concat(res.fail).forEach(t => log(`   확인: ${t.start} ${t.pgm}`));
      if (listPanel()) await doScan().catch(() => {});
    }
  }

  // ---------- 진단 내용 복사 ----------
  function compactHTML(node, limit = 20000) {
    if (!node) return '';
    const c = node.cloneNode(true);
    c.querySelectorAll('svg').forEach(v => { v.innerHTML = ''; });
    c.querySelectorAll('.MuiTouchRipple-root, style, script').forEach(v => v.remove());
    c.querySelectorAll('.tui-grid-body-area tbody').forEach(tb => [...tb.children].slice(6).forEach(tr => tr.remove()));
    c.querySelectorAll('*').forEach(el => {
      el.removeAttribute('style');
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(x => x && !/^css-/.test(x)).join(' ');
      if (cls) el.setAttribute('class', cls); else el.removeAttribute('class');
    });
    const h = c.outerHTML.replace(/\s{2,}/g, ' ');
    return h.length > limit ? h.slice(0, limit) + ' …(잘림)' : h;
  }
  function descInput(i) {
    const pr = reactProps(i);
    return `  - input name=${i.name || '-'} id=${i.id || '-'} type=${i.type} value="${i.value}" ${i.readOnly ? 'readonly ' : ''}${i.disabled ? 'disabled ' : ''}placeholder="${i.placeholder || ''}" react=[${pr ? Object.keys(pr).filter(k => /^on/.test(k)).join(',') : '없음'}]`;
  }
  function descGrid(g) {
    const rows = renderedRows(g);
    const hm = headerMap(g);
    const out = [`  - 그리드: 헤더 ${JSON.stringify(hm)} / 표시된 행 ${rows.length}`];
    rows.slice(0, 5).forEach(r => out.push('    · ' + Object.entries(r.cells).filter(([k]) => k !== '_checked').map(([k, v]) => `${k}=${v}`).join(' | ')));
    return out.join('\n');
  }
  function descScope(name, sc) {
    if (!sc) return `[${name}] 없음`;
    const out = [`[${name}]`];
    out.push('  버튼: ' + [...sc.querySelectorAll('button')].filter(b => vis(b) && !inPanel(b)).map(b => norm(b.textContent)).filter(Boolean).join(', '));
    [...sc.querySelectorAll('input')].filter(i => vis(i) && i.type !== 'checkbox' && !inPanel(i)).slice(0, 15).forEach(i => out.push(descInput(i)));
    gridsIn(sc).forEach(g => out.push(descGrid(g)));
    return out.join('\n');
  }
  function buildDiag() {
    const L = [];
    L.push(`### 세일즈원 자동화 진단: ${TOOL} v${VER}`);
    L.push(`시각: ${new Date().toLocaleString('ko-KR')}`);
    L.push(`URL: ${location.href}`);
    L.push(`브라우저: ${navigator.userAgent} / 창 ${innerWidth}x${innerHeight}`);
    L.push(`현재 단계: ${S.step} / 실행중: ${S.running} / 자동저장: ${S.autoSave}`);
    if (S.cur) L.push(`현재 대상: ${S.cur.start} ${S.cur.pgm} (원방송 ${S.cur.orig && S.cur.orig.date} ${S.cur.orig && S.cur.orig.time}, 브랜드 ${S.cur.brand})`);
    L.push(`대상 목록 ${S.targets.length}건: ` + S.targets.map(t => `${t.start} ${t.pgm}`).join(' / '));
    L.push('\n## 오류·멈춤 기록');
    L.push(S.errors.length ? S.errors.map(e => `- [${e.time}] (${e.step}) ${e.type}: ${e.msg}${e.stack ? ' / ' + e.stack : ''}`).join('\n') : '- 없음');
    if (S.dateTries && S.dateTries.length) { L.push('\n## 날짜 입력 시도'); S.dateTries.slice(-12).forEach(x => L.push('- ' + x)); }
    if (nativeMsgs.length) L.push('\n## 최근 alert/confirm: ' + nativeMsgs.slice(-5).join(' / '));
    L.push('\n## 화면 요약');
    let ex = '';
    try {
      const lp = listPanel(), pp = prodPanel();
      L.push(`목록 화면(아이템 편성): ${lp ? '보임' : '안 보임'} / 상품 편성 화면: ${pp ? '보임' : '안 보임'}`);
      if (pp) { const info = prodInfo(pp); L.push(`상품 편성 방송일시="${info.dtm}" 프로그램명="${info.pgm}"`); }
      const dCopy = dialogByTitle('편성상품 복사'), dPgm = dialogByTitle('프로그램 조회');
      L.push(descScope('편성상품 복사 팝업', dCopy));
      L.push(descScope('프로그램 조회 팝업', dPgm));
      if (pp && !dCopy && !dPgm) L.push(descScope('상품 편성 화면', pp));
      if (lp && !pp) L.push(descScope('아이템 편성 목록', lp));
      const others = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .MuiDialog-paper, .swal2-popup')].filter(d => vis(d) && !inPanel(d) && d !== dCopy && d !== dPgm);
      others.slice(0, 3).forEach((d, i) => L.push(`[기타 팝업${i + 1}] ${txt(d).slice(0, 200)}`));
      const tabs = [...document.querySelectorAll('body *')].filter(e => !inPanel(e) && e.children.length === 0 && /편성|현황|관리|점검/.test(e.textContent) && e.textContent.length < 20 && vis(e) && e.getBoundingClientRect().top > innerHeight * 0.8).map(e => e.textContent.trim());
      L.push('하단 탭: ' + [...new Set(tabs)].join(', '));
      const focus = dCopy || dPgm || (S.step.startsWith('7') || S.step.startsWith('8') ? pp : null);
      if (focus) ex = compactHTML(focus);
      const ms = calMonths();
      if (ms.length) {
        L.push(`달력 열림: ${ms.map(x => `${x.y}-${x.m}(날짜 ${x.days.size}개)`).join(', ')} / 이동버튼 ${(() => { const a = calArrows(ms); return `${a.prev ? '‹있음' : '‹없음'} ${a.next ? '›있음' : '›없음'}`; })()}`);
        let root = ms[0].panel; for (let i = 0; i < 3 && root.parentElement; i++) root = root.parentElement;
        ex = compactHTML(root, 15000) + (ex ? '\n\n' + ex : '');
      } else {
        const dp = (focus || lp || document).querySelector('.gui-date-picker, .gui-date-range');
        if (dp) ex = '[날짜칸] ' + compactHTML(dp, 6000) + (ex ? '\n\n' + ex : '');
      }
    } catch (e) { L.push('화면 요약 중 오류: ' + e.message); }
    L.push('\n## 최근 로그');
    L.push(S.logs.slice(-60).join('\n'));
    if (ex) { L.push('\n## 현재 팝업/화면 HTML(축약)'); L.push(ex); }
    return L.join('\n');
  }
  async function copyDiag() {
    const text = buildDiag();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      try { ok = execCmd('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    console.log(text);
    log(ok ? `📋 진단 내용을 복사했습니다(${text.length}자). Claude 대화창에 붙여넣어 주세요.` : '❗ 클립보드 복사 실패. F12 콘솔에 출력된 진단 내용을 복사해 주세요.');
  }

  P.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const act = a.dataset.a;
    if (act === 'close') { if (S.running) { S.stop = true; S.cancelAsk && S.cancelAsk(); } P.style.display = 'none'; }
    if (act === 'scan') doScan();
    if (act === 'search') searchAndScan();
    if (act === 'diag') copyDiag();
    if (act === 'run') run();
    if (act === 'stop') { S.stop = true; S.cancelAsk && S.cancelAsk(); log('중지 요청…'); }
  });
  $('[data-r="auto"]').addEventListener('change', e => { S.autoSave = e.target.checked; });

  window.__MLCOPY = { show: () => { P.style.display = 'flex'; if (!S.running) searchAndScan(); }, diag: copyDiag, diagText: buildDiag, ver: VER, running: () => S.running, _dbg: { dialogByTitle, popupRows, popupRowsNow, pickByCalendar } };
  log(`v${VER} 시작. 대상 확인 후 [선택 항목 실행]을 누르세요.`);
  loadSettings();
  await searchAndScan();
})();
