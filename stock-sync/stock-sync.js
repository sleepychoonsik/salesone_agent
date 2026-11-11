/* =========================================================================
 * [세일즈원 자동화] 재고동기화 (SJ와니 · AM) v1.2.1
 *  - 직매입 재고/평가감 현황(영업부서 S31)에서 SJ와니·AM 상품코드 추출
 *  - 판매상태/수량관리: 전체주문가능수량 = 주문가능재고(A), 주문가능재고 ≤ 0 인 판매중 → 일시품절
 *  - 재고 있는데 판매종료/일시품절인 SKU는 체크한 것만 판매중으로 전환
 *  - 수량은 조회 직후 확인 없이 자동 저장, 판매상태 변경(일시품절 전환·판매재개)만 패널 안 확인 후 저장
 *  - 저장은 1000건 단위, 저장 뒤 재조회 점검
 *  - 세일즈원이 저장을 거절하면(예: "종료해제 대상이 아닙니다") 판매재개를 한 건씩 저장해 거절된 행만 가려내고 나머지는 저장
 *  - 화면 요소를 못 찾으면 멈추고 "직접 처리 후 [계속]" 안내
 *  - 문제가 생기면 [진단 내용 복사] → Claude에게 붙여넣기
 *  - 디자인: 세일즈원 자동화 UI 디자인 시스템(design/so-ui.css) — Montage 토큰 · Pretendard · 포인트 #0088FF
 * ========================================================================= */
(async () => {
  'use strict';
  const TITLE = '재고동기화';
  const VER = 'v1.2.1';
  // 최신 버전 확인: raw 주소는 최대 5분 캐시되므로, 최신 커밋을 직접 조회해 더 새 버전이 있으면 그걸 실행한다
  if (!window.__SSY_FRESH) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
      const R = 'sleepychoonsik/salesone_agent', F = 'stock-sync/stock-sync.js';
      const sha = (await (await fetch(`https://api.github.com/repos/${R}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store', signal: ctl.signal })).text()).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        const code = await (await fetch(`https://raw.githubusercontent.com/${R}/${sha}/${F}`, { signal: ctl.signal })).text();
        const m = code.match(/const VER = '([^']+)'/);
        clearTimeout(tm);
        if (m && m[1] !== VER) {
          window.__SSY_FRESH = true;
          setTimeout(() => { window.__SSY_FRESH = false; }, 5000);
          (0, eval)(code);
          return;
        }
      }
      clearTimeout(tm);
    } catch (e) { /* 확인 실패 시 지금 버전으로 진행 */ }
  }

  if (!/nsalesone\.gshs\.co\.kr$/.test(location.host)) {
    alert('[' + TITLE + '] n세일즈원(nsalesone.gshs.co.kr) 화면에서 실행해주세요.');
    return;
  }

  /* ---------------- 설정 ---------------- */
  const PANEL_ID = '__ssy_panel';
  const SS_KEY = '__ssy_state_v1';
  const DEPT = 'S31';                                   // 영업부서(패션1팀)
  const HASH_STOCK = '#/logistics/delivery/DirectBuyStock';
  const HASH_SALE = '#/product/product/bundle/SaleStQtyMng';
  const BATCH = 1000;                                   // 저장 1회 최대 건수
  const isTargetSku = s => { s = String(s || ''); return s.includes('SJ와니') || /sj wani/i.test(s) || /(?<![A-Za-z])AM(?![A-Za-z])/.test(s); };
  const isPrdCd = c => /^1\d{9}$/.test(String(c || ''));
  const FLAG = { N: '판매중', Y: '판매종료', T: '일시품절', S: '품절해제' };
  const TAG = { N: 'on', S: 'on', T: 'paused', Y: 'ended' };   // 디자인 시스템 Tag 종류

  /* ---------------- 상태 (진단용 · 토큰·쿠키는 담지 않음) ---------------- */
  const D = { step: '대기', errors: [], logs: [] };
  let S = { codes: [], plan: [], rep: [], saved: null, verify: null, date: '' };
  try { const v = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); if (v) S = Object.assign(S, v); } catch (e) {}
  const persist = () => { try { sessionStorage.setItem(SS_KEY, JSON.stringify(S)); } catch (e) {} };
  const tnow = () => new Date().toTimeString().slice(0, 8);

  /* ---------------- 화면 유틸 ---------------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pane = () => document.querySelector('.rc-dyn-tabs-selected') || document.body;
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const txt = el => (el && el.innerText || '').trim();
  async function waitFor(fn, timeout = 60000, step = 300) {
    const t0 = Date.now();
    for (;;) {
      let v; try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await sleep(step);
    }
  }
  const isLoading = () => [...document.querySelectorAll('body *')].some(e => e.childElementCount === 0 && /잠시만 기다려주세요/.test(e.textContent || '') && vis(e));
  async function waitIdle(timeout = 180000) { await sleep(500); await waitFor(() => !isLoading(), timeout, 500); await sleep(300); }
  function setVal(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const enter = el => ['keydown', 'keypress', 'keyup'].forEach(type => el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
  const btnByText = (t, scope) => [...(scope || pane()).querySelectorAll('button')].find(b => txt(b) === t && vis(b));
  function topDialog() {
    const ds = [...document.querySelectorAll('.MuiDialog-root, [role="dialog"], [role="presentation"]')].filter(vis);
    return ds[ds.length - 1] || null;
  }
  const totals = () => {
    const t = txt(pane());
    const m = t.match(/총\s*([\d,]+)\s*\/\s*([\d,]+)\s*건/);
    if (m) return { a: +m[1].replace(/,/g, ''), b: +m[2].replace(/,/g, '') };
    const m2 = t.match(/총\s*([\d,]+)\s*건/);
    return m2 ? { a: +m2[1].replace(/,/g, ''), b: +m2[1].replace(/,/g, '') } : null;
  };

  // 못 찾으면 멈추고 사용자에게 직접 처리 후 [계속]을 받는다. [중단]이면 예외.
  async function need(fn, what, timeout = 30000) {
    for (;;) {
      const v = await waitFor(fn, timeout);
      if (v) return v;
      const ok = await ask('caution', `${what}을(를) 찾지 못했어요.`, '세일즈원 화면에서 직접 처리한 뒤 [계속]을 눌러주세요.', '계속', '중단');
      if (!ok) throw new Error(`${what} 없음 — 사용자가 중단`);
      timeout = 5000;
    }
  }

  async function goto(hash) {
    if (location.hash !== hash) location.hash = hash;
    await need(() => location.hash === hash && pane().id && pane().id.includes(hash.slice(1)), '화면 이동(' + hash.split('/').pop() + ')');
    await need(() => btnByText('조회'), '[조회] 버튼');
    await waitIdle();
  }

  // RealGrid2: 선택된 탭 안의 .rg-root → React fiber를 거슬러 올라가며 GridView / DataProvider 탐색
  function findGridObjs() {
    const grids = [], providers = [], seen = new Set();
    const chk = v => {
      try {
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        if (typeof v.getDataSource === 'function') { seen.add(v); grids.push(v); }
        else if (typeof v.getJsonRows === 'function' && typeof v.getRowCount === 'function') { seen.add(v); providers.push(v); }
      } catch (e) {}
    };
    const scan = (o, d) => {
      if (!o || typeof o !== 'object' || d > 3 || o instanceof Node) return;
      chk(o);
      let ks; try { ks = Object.keys(o); } catch (e) { return; }
      for (const k of ks.slice(0, 60)) {
        if (k === '_owner' || k === 'children' || k === 'return' || k === 'child' || k === 'sibling') continue;
        let v; try { v = o[k]; } catch (e) { continue; }
        if (v && typeof v === 'object') scan(v, d + 1);
      }
    };
    pane().querySelectorAll('.rg-root').forEach(root => {
      let el = root;
      for (let up = 0; up < 3 && el; up++) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (key) {
          let f = el[key];
          for (let d = 0; f && d < 25; d++) {
            scan(f.memoizedProps, 0);
            let s = f.memoizedState, n = 0;
            while (s && n < 40) { scan(s.memoizedState, 0); s = s.next; n++; }
            f = f.return;
          }
          break;
        }
        el = el.parentElement;
      }
    });
    return { grids, providers };
  }

  /* ---------------- ① 대상 추출 ---------------- */
  async function stepExtract() {
    D.step = '① 대상 추출';
    log('직매입 재고/평가감 현황으로 이동');
    await goto(HASH_STOCK);
    const inp = await need(() => pane().querySelector('input[placeholder="영업부서코드"]'), '영업부서코드 입력칸');
    inp.focus(); setVal(inp, DEPT); enter(inp);
    await waitFor(() => (pane().querySelector('input[placeholder="영업부서명"]') || {}).value, 15000);
    await waitIdle();
    const dn = (pane().querySelector('input[placeholder="영업부서명"]') || {}).value || '?';
    log(`영업부서 ${DEPT} (${dn}) 조회 중… 약 2만 건이라 30초쯤 걸려요`);
    (await need(() => btnByText('조회'), '[조회] 버튼')).click();
    await waitIdle(300000);
    const t = await need(() => { const x = totals(); return x && x.b > 0 ? x : null; }, '조회 결과 건수', 120000);
    const rows = await need(() => {
      const { grids, providers } = findGridObjs();
      const p = providers.concat(grids.map(g => g.getDataSource()))
        .find(p => p.getRowCount() === t.b && p.getRowCount() > 0 && 'skuName' in p.getJsonRows(0, 0)[0]);
      return p ? p.getJsonRows(0, -1) : null;
    }, '직매입 재고 그리드 데이터', 60000);
    const codes = [...new Set(rows.filter(r => isTargetSku(r.skuName) && isPrdCd(r.prdCd)).map(r => String(r.prdCd)))];
    S = { codes, plan: [], rep: [], saved: null, verify: null, date: new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) };
    persist();
    log(`전체 ${rows.length.toLocaleString()}건 → 대상 상품코드 ${codes.length}개`);
  }

  /* ---------------- ② 판매상태/수량관리 조회 ---------------- */
  const saleGrid = () => findGridObjs().grids.find(g => { const ds = g.getDataSource(); return ds.getRowCount() > 0 && 'saleFlag' in ds.getJsonRows(0, 0)[0]; });
  async function querySale() {
    await goto(HASH_SALE);
    // 상품코드 옆 다건조회 아이콘: 상품코드 입력칸과 같은 줄, 오른쪽의 colorInherit 아이콘 버튼
    const icon = await need(() => {
      const inp = pane().querySelector('input[placeholder="상품코드"]'); if (!inp) return null;
      const ir = inp.getBoundingClientRect();
      const o = [...pane().querySelectorAll('button')]
        .filter(b => !txt(b) && /colorInherit/.test(b.className) && vis(b))
        .map(b => ({ b, r: b.getBoundingClientRect() }))
        .filter(o => Math.abs(o.r.y + o.r.height / 2 - (ir.y + ir.height / 2)) < 20 && o.r.x > ir.right)
        .sort((a, b) => a.r.x - b.r.x)[0];
      return o && o.b;
    }, '상품코드 다건조회 아이콘');
    icon.click();
    const dlg = await need(() => { const d = topDialog(); return d && /다건 조회/.test(txt(d)) ? d : null; }, '상품코드 다건 조회 팝업', 10000);
    const ta = await need(() => dlg.querySelector('textarea'), '다건조회 입력칸');
    ta.focus(); ta.click(); setVal(ta, S.codes.join('\n'));
    await need(() => new RegExp('총\\s*' + S.codes.length + '\\s*건').test(txt(dlg)), `다건조회 팝업의 "총 ${S.codes.length}건" 표시(코드를 직접 붙여넣어 주세요)`, 5000);
    (await need(() => btnByText('확인', dlg), '팝업 [확인] 버튼')).click();
    await sleep(500);
    (await need(() => btnByText('조회'), '[조회] 버튼')).click();
    await waitIdle(180000);
    const t = await need(() => { const x = totals(); return x && x.b > 0 ? x : null; }, '검색 결과 건수', 60000);
    let g = await need(saleGrid, '판매상태 그리드');
    for (let i = 0; i < 40 && g.getDataSource().getRowCount() < t.b; i++) {
      g.setTopItem(g.getDataSource().getRowCount() - 1);
      await sleep(1500); await waitIdle();
      g = saleGrid() || g;
    }
    const n = g.getDataSource().getRowCount();
    if (n < t.b) throw new Error(`전체 행 로드 실패 (${n}/${t.b})`);
    return g;
  }
  const info = r => ({ attr: r.attrPrdCd, prd: String(r.prdCd), nm: r.prdNm, a1: r.attrVal1, a2: r.attrVal2 });
  // 규칙: 전체주문가능수량 = 주문가능재고(A), 주문가능재고 ≤ 0 인 판매중 → 일시품절. 판매종료·일시품절은 상태 유지.
  function buildPlan(rows) {
    const plan = [];
    rows.forEach(r => {
      const a = Number(r.allOrdPsblQty), o = Number(r.ordPsblStockQty);
      if (r.ordPsblStockQty == null || isNaN(o)) return;
      const p = Object.assign(info(r), { qB: a, qA: a, fB: r.saleFlag, fA: r.saleFlag });
      let ch = false;
      if (a !== o) { p.qA = o; ch = true; }
      if (o <= 0 && r.saleFlag === 'N') { p.fA = 'T'; ch = true; }
      if (ch) plan.push(p);
    });
    return plan;
  }
  async function stepQuery() {
    D.step = '② 조회';
    if (!S.codes.length) throw new Error('먼저 ① 대상 추출을 실행해주세요');
    log(`판매상태/수량관리 조회 (상품코드 ${S.codes.length}개)`);
    let g = await querySale();
    let rows = g.getDataSource().getJsonRows(0, -1);
    let plan = buildPlan(rows);
    const nq = plan.filter(p => p.qA !== p.qB).length;
    if (nq) {
      // 수량은 확인 없이 바로 적용한다.
      {
        D.step = '② 수량 자동 적용';
        log(`수량 ${nq}건 자동 적용`);
        remember(await applyAndSave(g, rows, { qty: true, flag: false }));
        D.step = '② 반영 확인';
        log('다시 조회해서 반영 확인');
        g = await querySale();
        rows = g.getDataSource().getJsonRows(0, -1);
        plan = buildPlan(rows);
        const left = plan.filter(p => p.qA !== p.qB).length;
        log(left ? `수량 미반영 ${left}건 (판매종료 상품은 반영되지 않을 수 있어요)` : '수량 모두 반영됨');
      }
    }
    const after = new Map(plan.map(p => [p.attr, p]));
    const prevPick = new Set((S.rep || []).filter(r => r.pick).map(r => r.attr));
    S.rep = rows.map(r => {
      const p = after.get(r.attrPrdCd);
      return Object.assign(info(r), { q: p ? p.qA : Number(r.allOrdPsblQty), f: p ? p.fA : r.saleFlag, pick: prevPick.has(r.attrPrdCd) });
    }).filter(x => x.q > 0 && (x.f === 'Y' || x.f === 'T'));
    S.plan = plan; S.verify = null; S.n = rows.length; persist();
    log(`SKU ${rows.length}건 · 수량 미반영 ${plan.filter(p => p.qA !== p.qB).length} · 일시품절 전환 대기 ${plan.filter(p => p.fA !== p.fB).length} · 재고 있는 판매중지 ${S.rep.length}`);
  }

  /* ---------------- ③ 저장 ---------------- */
  async function clickSave() {
    (await need(() => btnByText('저장'), '[저장] 버튼')).click();
    const d1 = await need(() => { const d = topDialog(); return d && btnByText('확인', d) ? d : null; }, '저장 확인창', 15000);
    const m1 = txt(d1).replace(/\s+/g, ' ');
    if (!/저장\s*하시겠습니까/.test(m1)) {
      // 저장 확인창 대신 뜬 안내창(버튼이 [확인] 하나)은 세일즈원이 저장 전에 거절한 것 → 닫고 거절 사유를 알린다.
      // 버튼이 더 있는 창은 무엇을 묻는지 모르므로 건드리지 않고 멈춘다.
      const btns = [...d1.querySelectorAll('button')].filter(b => vis(b) && txt(b));
      if (btns.length !== 1) throw new Error('예상 못한 팝업: ' + m1.slice(0, 120));
      const why = m1.replace(/^확인\s*/, '').replace(/\s*확인$/, '').slice(0, 120) || m1.slice(0, 120);
      btns[0].click();
      await waitFor(() => !document.contains(d1) || !vis(d1), 5000, 200);
      await sleep(300);
      const e = new Error('세일즈원이 저장을 거절했어요: ' + why); e.rejected = why; throw e;
    }
    btnByText('확인', d1).click();
    await waitIdle(180000);
    const d2 = await need(() => { const d = topDialog(); return d && btnByText('확인', d) ? d : null; }, '저장 결과 팝업', 60000);
    const m2 = txt(d2).replace(/\s+/g, ' ');
    btnByText('확인', d2).click();
    await sleep(500);
    if (!/저장\s*완료/.test(m2)) throw new Error('저장 결과 팝업: ' + m2.slice(0, 160));
  }
  // 최신 조회 결과(fresh) 기준으로 변경을 그리드에 넣고 1000건 단위로 저장한다.
  // qty: 수량 적용 여부, flag: 판매중→일시품절 적용 여부, picks: 판매재개할 행. 실제로 적용한 내역을 돌려준다.
  // 세일즈원이 저장 전에 거절하면(한 행만 걸려도 전체가 막힘) 수량·일시품절을 먼저 저장하고,
  // 판매재개는 한 건씩 저장해서 거절된 행만 rejected로 돌려준다.
  async function applyAndSave(g, fresh, { qty, flag, picks = [] }) {
    let ds, idx, planBy;
    const bind = (g2, rows) => {
      g = g2; fresh = rows; ds = g.getDataSource();
      idx = new Map(rows.map((r, i) => [r.attrPrdCd, i]));
      planBy = new Map(buildPlan(rows).map(p => [p.attr, p]));
    };
    const reload = async () => { const g2 = await querySale(); bind(g2, g2.getDataSource().getJsonRows(0, -1)); };
    bind(g, fresh);
    const pickBy = new Map(picks.map(r => [r.attr, r]));
    // 한 행에 넣을 값 [필드, 새 값, 원래 값]과 기록. 지금 그리드 값 기준으로 계산한다.
    const itemOf = (attr, withPick) => {
      const i = idx.get(attr); if (i == null) return null;
      const row = fresh[i], p = planBy.get(attr), sets = [], it = { i, attr, sets, plan: null, pick: null };
      const dq = !!p && qty && p.qA !== p.qB, df = !!p && flag && p.fA !== p.fB;
      if (dq) sets.push(['allOrdPsblQty', p.qA, row.allOrdPsblQty]);
      if (df) sets.push(['saleFlag', p.fA, row.saleFlag]);
      if (dq || df) it.plan = Object.assign({}, p, { qA: dq ? p.qA : p.qB, fA: df ? p.fA : p.fB });
      const cur = row.saleFlag;
      if (withPick && pickBy.has(attr) && (cur === 'Y' || cur === 'T')) {      // 이미 판매중이면 건너뜀
        sets.push(['saleFlag', cur === 'T' ? 'S' : 'N', cur]);                  // 일시품절→품절해제, 판매종료→판매중
        it.pick = Object.assign({}, pickBy.get(attr), { f: cur });
      }
      return sets.length ? it : null;
    };
    const done = [], donePicks = [], rejected = [];
    // attrs를 그리드에 넣고 저장. 거절되면 넣은 값을 되돌리고 사유를 돌려준다(저장된 것은 없음).
    const save = async (attrs, withPick) => {
      const items = attrs.map(a => itemOf(a, withPick)).filter(Boolean);
      if (!items.length) return null;
      if (g.commit) g.commit(true);
      if (g.checkAll) g.checkAll(false);
      items.forEach(it => { it.sets.forEach(([f, v]) => ds.setValue(it.i, f, v)); g.checkRow(it.i, true); });
      try { await clickSave(); }
      catch (e) {
        if (!e.rejected) throw e;
        items.forEach(it => {
          it.sets.slice().reverse().forEach(([f, , v0]) => ds.setValue(it.i, f, v0));
          try { ds.setRowState(it.i, 'none', true); } catch (e2) {}
          g.checkRow(it.i, false);
        });
        if (g.commit) g.commit(true);
        return e.rejected;
      }
      items.forEach(it => { if (it.plan) done.push(it.plan); if (it.pick) donePicks.push(it.pick); });
      return null;
    };
    const label = a => { const r = fresh[idx.get(a)] || pickBy.get(a) || {}; return `${r.prdCd || r.prd} · ${r.prdNm || r.nm} · ${a}`; };

    const all = fresh.map(r => r.attrPrdCd).filter(a => itemOf(a, true));
    const nPick = all.filter(a => itemOf(a, true).pick).length;
    log(`적용 대상 ${all.length}행 (수량·일시품절 ${all.filter(a => itemOf(a, false)).length} · 판매재개 ${nPick})`);
    let why = null, k = 0;
    for (; k < all.length; k += BATCH) {
      const chunk = all.slice(k, k + BATCH);
      log(`${k + 1}–${k + chunk.length}행 저장 중…`);
      why = await save(chunk, true);
      if (why) break;
      log('저장 완료');
    }
    if (why) {
      const rest = all.slice(k);
      const restPicks = rest.filter(a => itemOf(a, true).pick);
      if (!restPicks.length) throw new Error('세일즈원이 저장을 거절했어요: ' + why);
      log(`세일즈원이 저장을 거절했어요: ${why}`);
      let dirty = k > 0;                                        // 앞에서 저장한 게 있으면 화면을 새로 읽는다
      const plain = rest.filter(a => itemOf(a, false));
      if (plain.length) {
        log(`수량·일시품절 ${plain.length}행 먼저 저장`);
        if (dirty) { await reload(); dirty = false; }
        for (let j = 0; j < plain.length; j += BATCH) {
          const w = await save(plain.slice(j, j + BATCH), false);
          if (w) throw new Error('세일즈원이 수량·일시품절 저장을 거절했어요: ' + w);
        }
        log('저장 완료');
        dirty = true;
      }
      log(`판매재개 ${restPicks.length}건을 한 건씩 저장해서 거절된 행을 가려냅니다`);
      for (const a of restPicks) {
        if (dirty) { await reload(); dirty = false; }
        const before = donePicks.length;
        const w = restPicks.length === 1 && !plain.length ? why : await save([a], true);
        if (w) { rejected.push(Object.assign({}, pickBy.get(a), { why: w })); log(`판매재개 거절: ${label(a)} — ${w}`, true); }
        else if (donePicks.length > before) { dirty = true; log(`판매재개 저장: ${label(a)}`); }
      }
    }
    return { plan: done, picks: donePicks, rejected };
  }
  // 저장 내역 누적(같은 SKU는 처음 값 → 마지막 값으로 합침). ④ 점검과 보고에 쓴다.
  function remember(res) {
    const sv = S.saved || { plan: [], picks: [] };
    const by = new Map(sv.plan.map(p => [p.attr, p]));
    res.plan.forEach(p => { const e = by.get(p.attr); if (e) { e.qA = p.qA; e.fA = p.fA; } else { sv.plan.push(p); by.set(p.attr, p); } });
    const pk = new Set(sv.picks.map(p => p.attr));
    res.picks.forEach(p => { if (!pk.has(p.attr)) { sv.picks.push(p); pk.add(p.attr); } });
    // 세일즈원이 거절한 판매재개(나중에 저장되면 목록에서 뺀다)
    const rj = new Map((sv.rej || []).map(p => [p.attr, p]));
    (res.rejected || []).forEach(p => rj.set(p.attr, p));
    res.picks.forEach(p => rj.delete(p.attr));
    sv.rej = [...rj.values()];
    S.saved = sv; persist();
  }
  async function stepSave() {
    D.step = '③ 판매상태 저장';
    const picks = S.rep.filter(r => r.pick);
    const nt = S.plan.filter(p => p.fA !== p.fB).length;
    if (!nt && !picks.length) { log('저장할 판매상태 변경이 없어요'); return; }
    const ok = await ask('info', '판매상태를 저장할까요?',
      `일시품절 전환 ${nt}건${picks.length ? ` · 판매재개 ${picks.length}건` : ''}<br>저장 직전에 다시 조회해서 최신 값 기준으로 적용합니다. 그 사이 바뀐 수량도 함께 맞춥니다.`, '저장', '취소');
    if (!ok) { log('저장 취소'); return; }
    log('저장 직전 재조회');
    const g = await querySale();
    const fresh = g.getDataSource().getJsonRows(0, -1);
    const res = await applyAndSave(g, fresh, { qty: true, flag: true, picks });
    remember(res);
    if (res.rejected.length) log(`판매재개 ${res.rejected.length}건은 세일즈원이 거절해서 저장하지 않았어요 (저장 ${res.picks.length}건)`);
    await stepVerify();
  }

  /* ---------------- ④ 점검 ---------------- */
  async function stepVerify() {
    D.step = '④ 점검';
    log('다시 조회해서 점검');
    const rows = (await querySale()).getDataSource().getJsonRows(0, -1);
    const by = new Map(rows.map(r => [r.attrPrdCd, r]));
    const sv = S.saved || { plan: [], picks: [] };
    const nf = [], pkSet = new Set(sv.picks.map(p => p.attr));
    for (const p of sv.plan) {
      const r = by.get(p.attr);
      if (!r || Number(r.allOrdPsblQty) !== p.qA || (r.saleFlag !== p.fA && !pkSet.has(p.attr)))
        nf.push(Object.assign({}, p, { why: !r ? '행 없음' : r.saleFlag === 'Y' ? '판매종료 상품이라 반영 안 됨' : `값 불일치(${r.allOrdPsblQty}/${FLAG[r.saleFlag]})` }));
    }
    for (const p of sv.picks) {
      const r = by.get(p.attr);
      if (!r || r.saleFlag === 'Y' || r.saleFlag === 'T') nf.push(Object.assign({}, p, { why: '판매재개 미반영(' + (r ? FLAG[r.saleFlag] : '행 없음') + ')' }));
    }
    for (const p of sv.rej || []) {
      const r = by.get(p.attr);
      if (r && (r.saleFlag === 'Y' || r.saleFlag === 'T')) nf.push(Object.assign({}, p, { why: `판매재개 거절(${FLAG[r.saleFlag]} 유지): ${p.why}` }));
    }
    const nfSet = new Set(nf.map(x => x.attr));
    const mism = rows.filter(r => Number(r.allOrdPsblQty) !== Number(r.ordPsblStockQty) && !nfSet.has(r.attrPrdCd)).map(info);
    const soLeft = rows.filter(r => Number(r.ordPsblStockQty) <= 0 && r.saleFlag === 'N').map(info);
    const codeSet = new Set(S.codes);
    const outside = sv.plan.filter(p => !codeSet.has(p.prd)).length;
    S.rep = rows.filter(r => Number(r.allOrdPsblQty) > 0 && (r.saleFlag === 'Y' || r.saleFlag === 'T'))
      .map(r => Object.assign(info(r), { q: Number(r.allOrdPsblQty), f: r.saleFlag, pick: false }));
    S.plan = buildPlan(rows);
    S.verify = { nf, mism, soLeft, outside, n: rows.length };
    S.n = rows.length; persist();
    log(`점검: 미반영 ${nf.length} · 남은 불일치 ${mism.length} · 판매중 0재고 ${soLeft.length} · 대상 외 수정 ${outside}`);
  }

  /* ---------------- 보고 ---------------- */
  function report() {
    const L = [];
    const sv = S.saved || { plan: S.plan, picks: [] };
    const qty = sv.plan.filter(p => p.qA !== p.qB), so = sv.plan.filter(p => p.fA !== p.fB);
    const byPrd = {};
    qty.forEach(p => { const k = p.prd + ' · ' + p.nm; byPrd[k] = (byPrd[k] || 0) + 1; });
    L.push(`**[재고동기화 ${S.date}]**`, '');
    L.push(`- 대상 상품코드 ${S.codes.length}개${S.n ? ` / SKU ${S.n}개` : ''}`);
    L.push(`- 수량 갱신 ${qty.length}건${S.saved ? '' : ' (저장 전)'}`);
    Object.entries(byPrd).forEach(([k, n]) => L.push(`  - ${k} · ${n} SKU`));
    L.push(`- 일시품절 전환 ${so.length}건`);
    so.forEach(p => L.push(`  - ${p.prd} · ${p.nm} · ${p.a1} · ${p.a2}`));
    const pend = S.saved && !S.verify ? S.plan.filter(p => p.fA !== p.fB) : [];
    if (pend.length) { L.push(`- 일시품절 전환 대기 ${pend.length}건 (저장 전)`); pend.forEach(p => L.push(`  - ${p.prd} · ${p.nm} · ${p.a1} · ${p.a2}`)); }
    if (sv.picks.length) {
      L.push(`- 판매재개 ${sv.picks.length}건`);
      sv.picks.forEach(p => L.push(`  - ${p.prd} · ${p.nm} · ${p.a1}/${p.a2} (${FLAG[p.f]}→판매중)`));
    }
    if ((sv.rej || []).length) {
      L.push(`- 판매재개 거절 ${sv.rej.length}건 (세일즈원이 저장을 받지 않음)`);
      sv.rej.forEach(p => L.push(`  - ${p.prd} · ${p.nm} · ${p.a1}/${p.a2} (${FLAG[p.f]}) — ${p.why}`));
    }
    if (S.verify) {
      const v = S.verify;
      if (!v.nf.length && !v.mism.length && !v.soLeft.length && !v.outside) L.push('- 점검 결과: 이상 없음');
      else {
        L.push('- 점검 결과');
        if (v.nf.length) { L.push(`  - 미반영 ${v.nf.length}건`); v.nf.forEach(p => L.push(`    - ${p.prd} · ${p.nm} · ${p.attr} · ${p.why}`)); }
        if (v.mism.length) { L.push(`  - 남은 불일치 ${v.mism.length}건`); v.mism.forEach(p => L.push(`    - ${p.prd} · ${p.nm} · ${p.attr}`)); }
        if (v.soLeft.length) L.push(`  - 주문가능재고 0 이하인데 판매중 ${v.soLeft.length}건`);
        if (v.outside) L.push(`  - 대상 외 상품 수정 ${v.outside}건`);
      }
    }
    L.push(`- 재고 있는데 판매종료/일시품절 ${S.rep.length ? S.rep.length + '건' : '없음'}`);
    if (S.rep.length) {
      L.push('', '| 상품코드 | 상품명 | 상품속성코드 | 속성1 | 속성2 | 판매상태 | 전체주문가능수량 |', '|---|---|---|---|---|---|---|');
      S.rep.forEach(r => L.push('| ' + [r.prd, r.nm, r.attr, r.a1, r.a2, FLAG[r.f], r.q].join(' | ') + ' |'));
    }
    return L.join('\n');
  }
  function downloadCsv() {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const L = [['구분', '상품코드', '상품명', '속성코드', '속성1', '속성2', '수량 전', '수량 후', '판매상태 전', '판매상태 후'].map(q).join(',')];
    const sv = S.saved || { plan: S.plan, picks: [] };
    sv.plan.forEach(p => L.push(['수정', p.prd, p.nm, p.attr, p.a1, p.a2, p.qB, p.qA, FLAG[p.fB], FLAG[p.fA]].map(q).join(',')));
    sv.picks.forEach(p => L.push(['판매재개', p.prd, p.nm, p.attr, p.a1, p.a2, p.q, p.q, FLAG[p.f], '판매중'].map(q).join(',')));
    S.rep.forEach(r => L.push(['재고있음-판매중지', r.prd, r.nm, r.attr, r.a1, r.a2, r.q, r.q, FLAG[r.f], FLAG[r.f]].map(q).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = '재고동기화_' + (S.date || '').replace(/\D+/g, '') + '.csv'; a.click();
  }
  async function copyText(text) {
    let done = false;
    try { done = await Promise.race([navigator.clipboard.writeText(text).then(() => true), sleep(1500).then(() => false)]); } catch (e) {}
    if (!done) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      try { done = document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    return done;
  }
  function buildDiag() {
    const L = [];
    L.push(`### 세일즈원 자동화 진단: ${TITLE} ${VER}`);
    L.push(`시각: ${new Date().toLocaleString('ko-KR')}`);
    L.push(`URL: ${location.href.split('?')[0]}`);
    L.push(`브라우저: ${navigator.userAgent} / 창 ${innerWidth}x${innerHeight}`);
    L.push(`현재 단계: ${D.step} / 대상 상품코드 ${S.codes.length}개 / 변경안 ${S.plan.length} / 재고있는 판매중지 ${S.rep.length} (체크 ${S.rep.filter(r => r.pick).length})`);
    const t = totals(); L.push(`화면 건수: ${t ? t.a + '/' + t.b : '-'} / 그리드 ${findGridObjs().grids.length}개 / 로딩중 ${isLoading()}`);
    L.push('\n## 화면 요약'); L.push(txt(pane()).replace(/\s+/g, ' ').slice(0, 600));
    const d = topDialog(); L.push('\n## 현재 팝업'); L.push(d ? d.outerHTML.replace(/\s+/g, ' ').slice(0, 1500) : '- 없음');
    L.push('\n## 오류 기록'); L.push(D.errors.length ? D.errors.map(e => '- ' + e).join('\n') : '- 없음');
    L.push('\n## 변경안(앞 30건)'); L.push(S.plan.slice(0, 30).map(p => `- ${p.attr} ${p.qB}→${p.qA} ${p.fB}→${p.fA}`).join('\n') || '- 없음');
    L.push('\n## 체크한 판매재개'); L.push(S.rep.filter(r => r.pick).slice(0, 30).map(r => `- ${r.attr} ${r.nm} ${r.a1}/${r.a2} ${r.f}(${FLAG[r.f]}) 수량 ${r.q}`).join('\n') || '- 없음');
    const rj = (S.saved && S.saved.rej) || []; if (rj.length) { L.push('\n## 세일즈원이 거절한 판매재개'); L.push(rj.map(r => `- ${r.attr} ${r.nm} ${r.f}(${FLAG[r.f]}) — ${r.why}`).join('\n')); }
    L.push('\n## 최근 로그'); L.push(D.logs.slice(-80).join('\n') || '- 없음');
    return L.join('\n');
  }

  /* ---------------- UI (세일즈원 자동화 UI 디자인 시스템) ---------------- */
  if (!document.getElementById('__so_font')) {
    const lk = document.createElement('link'); lk.id = '__so_font'; lk.rel = 'stylesheet';
    lk.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.appendChild(lk);
  }
  const old = document.getElementById(PANEL_ID); if (old) old.remove();
  const host = document.createElement('div'); host.id = PANEL_ID;
  host.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  // 디자인 시스템 CSS: design/so-ui.css → scripts/inject-design.js 가 아래 표식 사이를 채운다 (직접 고치지 않는다)
  const SO_UI_CSS = /*SO-UI:BEGIN*/`:host{all:initial;--brand:#0088FF;--brand-strong:#0077E6;--brand-heavy:#0066C7;--brand-text:#0070D6;--brand-subtle:rgba(0,136,255,0.05);--brand-line:rgba(0,136,255,0.28);--brand-focus:rgba(0,136,255,0.12);--fg:#171719;--fg-secondary:rgba(46,47,51,0.88);--fg-tertiary:rgba(55,56,60,0.61);--fg-quaternary:rgba(55,56,60,0.28);--fg-disable:rgba(55,56,60,0.16);--on-brand:#FFFFFF;--bg:#FFFFFF;--bg-secondary:#F7F7F8;--surface-secondary:rgba(112,115,124,0.08);--surface-tertiary:rgba(112,115,124,0.05);--surface-disable:#F4F4F5;--line:rgba(112,115,124,0.22);--line-secondary:rgba(112,115,124,0.16);--line-tertiary:rgba(112,115,124,0.08);--positive:#00BF40;--positive-text:#006E25;--positive-surface:rgba(0,191,64,0.08);--cautionary:#FF9200;--cautionary-text:#9C5800;--cautionary-surface:rgba(255,146,0,0.08);--negative:#FF4242;--negative-text:#E52222;--negative-surface:rgba(255,66,66,0.08);--dimmer:rgba(23,23,25,0.52);--font-sans:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Consolas,monospace;--space-4:4px;--space-6:6px;--space-8:8px;--space-10:10px;--space-12:12px;--space-16:16px;--space-18:18px;--radius-5:5px;--radius-6:6px;--radius-8:8px;--radius-10:10px;--radius-12:12px;--radius-16:16px;--radius-full:9999px;--shadow-panel:0px 6px 10px -4px rgba(23,23,23,0.08),0px 16px 24px -6px rgba(23,23,23,0.08);--shadow-focus:0px 0px 0px 3px rgba(0,136,255,0.12);--panel-width:452px;--control-xs:28px;--control-sm:32px;--control-md:40px;--checkbox:20px;--z-panel:2147483000}.so-panel{font-family:var(--font-sans);color:var(--fg);width:var(--panel-width);max-height:84vh;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line-secondary);border-radius:var(--radius-16);box-shadow:var(--shadow-panel);overflow:hidden;-webkit-font-smoothing:antialiased;box-sizing:border-box}.so-panel *{box-sizing:border-box}.so-panel__head{display:flex;align-items:center;gap:var(--space-8);padding:14px 12px 14px var(--space-18);border-bottom:1px solid var(--line-tertiary);cursor:move;user-select:none}.so-panel__title{flex:1;min-width:0;font-size:17px;line-height:24px;font-weight:600}.so-panel__dot{display:inline-block;width:8px;height:8px;border-radius:var(--radius-full);background:var(--brand);margin-right:var(--space-8);vertical-align:2px}.so-panel__body{padding:var(--space-16) var(--space-18) var(--space-18);overflow:auto;display:flex;flex-direction:column;gap:var(--space-12)}.so-panel__foot{display:flex;gap:var(--space-4);justify-content:flex-end;flex-wrap:wrap}.so-chip{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-6);border-radius:var(--radius-6);background:var(--brand-subtle);color:var(--brand-text);font-size:11px;line-height:14px;font-weight:600;letter-spacing:.0311em;vertical-align:2px;margin-left:var(--space-4)}.so-chip--neutral{background:var(--surface-secondary);color:var(--fg-tertiary)}.so-icon-btn{width:var(--control-sm);height:var(--control-sm);border:0;border-radius:var(--radius-10);background:transparent;color:var(--fg-tertiary);font:500 18px/1 var(--font-sans);cursor:pointer}.so-icon-btn:hover{background:var(--surface-secondary);color:var(--fg)}.so-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-4);border:0;cursor:pointer;font-family:var(--font-sans);font-weight:600;white-space:nowrap;transition:background .12s,box-shadow .12s}.so-btn--md{min-height:var(--control-md);padding:10px 16px;border-radius:var(--radius-12);font-size:14px;line-height:20px;letter-spacing:.0145em}.so-btn--sm{min-height:var(--control-sm);padding:8px 12px;border-radius:var(--radius-10);font-size:12px;line-height:16px;letter-spacing:.0252em}.so-btn--xs{min-height:var(--control-xs);padding:6px 10px;border-radius:var(--radius-8);font-size:12px;line-height:16px}.so-btn--primary{background:var(--brand);color:var(--on-brand)}.so-btn--primary:hover{background:var(--brand-strong)}.so-btn--primary:active{background:var(--brand-heavy)}.so-btn--outlined{background:var(--bg);color:var(--brand-text);box-shadow:inset 0 0 0 1px var(--line)}.so-btn--outlined:hover{background:var(--brand-subtle)}.so-btn--assistive{background:var(--surface-secondary);color:var(--fg-secondary)}.so-btn--text{background:transparent;color:var(--fg-tertiary);padding-left:var(--space-6);padding-right:var(--space-6)}.so-btn--text:hover{color:var(--fg)}.so-btn--full{width:100%}.so-btn:disabled{background:var(--surface-disable);color:var(--fg-disable);box-shadow:none;cursor:default}.so-btn:focus-visible,.so-checkbox:focus-visible{outline:none;box-shadow:var(--shadow-focus)}.so-spinner{width:14px;height:14px;border:2px solid var(--brand-line);border-top-color:var(--brand);border-radius:var(--radius-full);animation:so-spin .8s linear infinite}.so-btn--primary .so-spinner{border-color:rgba(255,255,255,.4);border-top-color:var(--on-brand)}@keyframes so-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.so-spinner{animation-duration:2.4s}}.so-checkbox{appearance:none;-webkit-appearance:none;width:var(--checkbox);height:var(--checkbox);margin:0;border-radius:var(--radius-5);box-shadow:inset 0 0 0 1.5px var(--line);background:var(--bg);cursor:pointer;display:inline-grid;place-items:center;vertical-align:middle}.so-checkbox:checked{background:var(--brand);box-shadow:none}.so-checkbox:checked::after{content:"";width:10px;height:6px;border-left:2px solid var(--on-brand);border-bottom:2px solid var(--on-brand);transform:translateY(-1px) rotate(-45deg)}.so-checkbox:disabled{background:var(--surface-disable);box-shadow:none;cursor:default}.so-steps{display:flex;gap:var(--space-4)}.so-step{flex:1;display:flex;flex-direction:column;gap:var(--space-4);font-size:11px;line-height:14px;font-weight:500;color:var(--fg-tertiary);letter-spacing:.0311em}.so-step::before{content:"";display:block;height:4px;border-radius:var(--radius-full);background:var(--surface-secondary)}.so-step--done::before{background:var(--brand-line)}.so-step--current{color:var(--brand-text)}.so-step--current::before{background:var(--brand)}.so-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-6)}.so-stat{background:var(--bg-secondary);border-radius:var(--radius-12);padding:10px 10px 9px;min-width:0}.so-stat__label{font-size:11px;line-height:14px;color:var(--fg-tertiary);font-weight:500;letter-spacing:.0311em}.so-stat__value{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.012em;font-variant-numeric:tabular-nums}.so-stat--brand .so-stat__value{color:var(--brand)}.so-msg{display:flex;gap:var(--space-10);padding:var(--space-12) 14px;border-radius:var(--radius-12);font-size:13px;line-height:18px;letter-spacing:.0194em;background:var(--surface-tertiary);color:var(--fg-secondary)}.so-msg__icon{flex:none;width:18px;height:18px;border-radius:var(--radius-full);display:grid;place-items:center;font:700 11px/1 var(--font-sans);color:var(--on-brand);background:var(--fg-tertiary)}.so-msg__body{flex:1;min-width:0}.so-msg__title{display:block;color:var(--fg);font-weight:600;margin-bottom:2px}.so-msg__actions{display:flex;gap:var(--space-6);margin-top:var(--space-10)}.so-msg--info{background:var(--brand-subtle)}.so-msg--info .so-msg__icon{background:var(--brand)}.so-msg--positive{background:var(--positive-surface)}.so-msg--positive .so-msg__icon{background:var(--positive)}.so-msg--caution{background:var(--cautionary-surface)}.so-msg--caution .so-msg__icon{background:var(--cautionary)}.so-msg--negative{background:var(--negative-surface)}.so-msg--negative .so-msg__icon{background:var(--negative)}.so-section-head{display:flex;align-items:center;gap:var(--space-6);font-size:14px;line-height:20px;font-weight:600;letter-spacing:.0145em}.so-section-head__count{color:var(--brand-text)}.so-section-head__spacer{flex:1}.so-table-wrap{border:1px solid var(--line-secondary);border-radius:var(--radius-12);overflow:auto;max-height:228px}.so-table{border-collapse:collapse;width:100%;font-size:12px;line-height:16px;letter-spacing:.0252em}.so-table th{position:sticky;top:0;background:var(--bg-secondary);color:var(--fg-tertiary);font-weight:500;text-align:left;padding:var(--space-8);border-bottom:1px solid var(--line-secondary);white-space:nowrap}.so-table td{padding:var(--space-8);border-bottom:1px solid var(--line-tertiary);vertical-align:top;color:var(--fg-secondary)}.so-table tr:last-child td{border-bottom:0}.so-table .so-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.so-table .so-sub{display:block;color:var(--fg-tertiary);font-size:11px;line-height:14px;margin-top:2px}.so-table tr.is-selected td{background:var(--brand-subtle)}.so-up{color:var(--brand-text);font-weight:600}.so-down{color:var(--negative-text);font-weight:600}.so-tag{display:inline-flex;height:20px;align-items:center;padding:0 var(--space-6);border-radius:var(--radius-6);font-size:11px;font-weight:600;white-space:nowrap}.so-tag--on{background:var(--brand-subtle);color:var(--brand-text)}.so-tag--paused{background:var(--cautionary-surface);color:var(--cautionary-text)}.so-tag--ended{background:var(--surface-secondary);color:var(--fg-tertiary)}.so-tag--error{background:var(--negative-surface);color:var(--negative-text)}.so-hint{font-size:12px;line-height:16px;color:var(--fg-tertiary);letter-spacing:.0252em}.so-log{border-top:1px solid var(--line-tertiary);padding-top:var(--space-10)}.so-log>summary{cursor:pointer;font-size:13px;line-height:18px;font-weight:600;color:var(--fg-secondary);list-style:none}.so-log>summary::-webkit-details-marker{display:none}.so-log>summary::before{content:"▸";display:inline-block;margin-right:var(--space-6);color:var(--fg-tertiary);transition:transform .15s}.so-log[open]>summary::before{transform:rotate(90deg)}.so-log__box{margin-top:var(--space-8);background:var(--bg-secondary);border-radius:var(--radius-10);padding:var(--space-10);max-height:150px;overflow:auto;font:12px/18px var(--font-mono);color:var(--fg-secondary);white-space:pre-wrap}.so-log__box .is-error{color:var(--negative-text)}.so-panel__body>*{flex-shrink:0}.so-view{display:flex;flex-direction:column;gap:var(--space-12)}.so-view:empty,.so-slot:empty{display:none}.so-row{display:flex;gap:var(--space-6);flex-wrap:wrap;align-items:center}.so-grid2{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-8)}.so-grow{flex:1;min-width:0}.so-field{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}.so-field__label{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.0252em;color:var(--fg-secondary)}.so-input,.so-textarea{width:100%;min-height:var(--control-sm);border:0;border-radius:var(--radius-10);box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);color:var(--fg);padding:7px var(--space-10);font:400 13px/18px var(--font-sans);letter-spacing:.0194em;outline:none}.so-input::placeholder,.so-textarea::placeholder{color:var(--fg-quaternary)}.so-input:focus,.so-textarea:focus{box-shadow:inset 0 0 0 1px var(--brand),var(--shadow-focus)}.so-textarea{min-height:92px;resize:vertical;font-family:var(--font-mono);font-size:12px;letter-spacing:0}.so-input--date{width:108px;font-variant-numeric:tabular-nums}.so-check{display:flex;gap:var(--space-8);align-items:center;font-size:12px;line-height:16px;letter-spacing:.0252em;color:var(--fg-secondary);cursor:pointer}.so-picks{border:1px solid var(--line-secondary);border-radius:var(--radius-12);overflow:auto;max-height:228px}.so-pick{display:flex;gap:var(--space-8);padding:var(--space-8);border-bottom:1px solid var(--line-tertiary);font-size:12px;line-height:16px;letter-spacing:.0252em;color:var(--fg-secondary);cursor:pointer}.so-pick:last-child{border-bottom:0}.so-pick b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}.so-pick .so-sub{display:block;color:var(--fg-tertiary);font-size:11px;line-height:14px;margin-top:2px}.so-pick.is-off{cursor:default}.so-empty{padding:var(--space-12);font-size:12px;line-height:16px;color:var(--fg-tertiary);text-align:center}.so-msg__text{white-space:pre-wrap}.so-msg__actions{flex-wrap:wrap}.so-msg__list{margin-top:var(--space-10);padding-top:var(--space-10);border-top:1px solid var(--line-tertiary);max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:var(--space-6);font-size:12px;line-height:16px}.so-msg__pre{margin:var(--space-8) 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;font:12px/18px var(--font-mono);color:var(--fg-secondary)}`/*SO-UI:END*/;
  root.innerHTML = `<style>${SO_UI_CSS}</style>
<div class="so-panel">
  <div class="so-panel__head"><div class="so-panel__title"><span class="so-panel__dot"></span>${TITLE}<span class="so-chip">${VER}</span><span class="so-chip so-chip--neutral">SJ와니 · AM</span></div>
    <button class="so-icon-btn" id="min" title="접기">–</button><button class="so-icon-btn" id="x" title="닫기">×</button></div>
  <div class="so-panel__body" id="body">
    <div class="so-steps" id="steps"></div>
    <button class="so-btn so-btn--md so-btn--primary so-btn--full" id="all">대상 추출하고 수량 맞추기</button>
    <div class="so-grid2">
      <button class="so-btn so-btn--sm so-btn--outlined" id="s1">① 대상 추출</button>
      <button class="so-btn so-btn--sm so-btn--outlined" id="s2">② 조회·수량 적용</button>
      <button class="so-btn so-btn--sm so-btn--primary" id="s3">③ 판매상태 저장</button>
      <button class="so-btn so-btn--sm so-btn--outlined" id="s4" title="저장하지 않고 다시 조회해서 확인만 합니다">④ 점검만 다시</button>
    </div>
    <div id="ask" class="so-slot"></div>
    <div id="view" class="so-view"></div>
    <details class="so-log" id="logbox"><summary>진행 로그</summary><div class="so-log__box" id="log"></div></details>
    <div class="so-panel__foot">
      <button class="so-btn so-btn--xs so-btn--text" id="cp">보고 복사</button>
      <button class="so-btn so-btn--xs so-btn--text" id="csv">CSV 저장</button>
      <button class="so-btn so-btn--xs so-btn--assistive" id="diag" title="오류가 나면 눌러서 Claude에게 붙여넣기">진단 내용 복사</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(host);
  const $ = id => root.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function log(m, err) {
    const line = `${tnow()} ${m}`;
    D.logs.push(line); if (D.logs.length > 300) D.logs.shift();
    if (err) D.errors.push(`[${tnow()}] (${D.step}) ${m}`);
    const div = document.createElement('div'); div.textContent = line; if (err) div.className = 'is-error';
    $('log').appendChild(div); $('log').scrollTop = $('log').scrollHeight;
  }
  // 패널 안 확인창 (되돌리기 어려운 동작·사용자 처리 대기)
  function ask(kind, title, body, yes, no) {
    return new Promise(res => {
      $('ask').innerHTML = `<div class="so-msg so-msg--${kind}"><span class="so-msg__icon">${kind === 'info' ? '?' : '!'}</span><div class="so-msg__body"><strong class="so-msg__title">${esc(title)}</strong>${body}
        <div class="so-msg__actions"><button class="so-btn so-btn--sm so-btn--primary" id="ay">${esc(yes)}</button>${no ? `<button class="so-btn so-btn--sm so-btn--assistive" id="an">${esc(no)}</button>` : ''}</div></div></div>`;
      const done = v => { $('ask').innerHTML = ''; res(v); };
      $('ay').onclick = () => done(true);
      if ($('an')) $('an').onclick = () => done(false);
      $('ask').scrollIntoView({ block: 'nearest' });
    });
  }

  function render() {
    const stage = S.verify ? 4 : S.plan.length || S.rep.length || S.n ? 2 : S.codes.length ? 1 : 0;
    $('steps').innerHTML = ['대상 추출', '수량 적용', '판매상태', '점검'].map((t, i) =>
      `<div class="so-step ${i + 1 === stage + 1 ? 'so-step--current' : i < stage ? 'so-step--done' : ''}">${'①②③④'[i]} ${t}</div>`).join('');
    const nq = S.plan.filter(p => p.qA !== p.qB).length, nt = S.plan.filter(p => p.fA !== p.fB).length;
    const nApplied = S.saved ? S.saved.plan.filter(p => p.qA !== p.qB).length : 0;
    let h = '';
    if (S.codes.length) {
      h += `<div class="so-stats">
        <div class="so-stat"><div class="so-stat__label">대상 상품</div><div class="so-stat__value">${S.codes.length}</div></div>
        <div class="so-stat so-stat--brand"><div class="so-stat__label">수량 적용</div><div class="so-stat__value">${S.n ? nApplied : '-'}</div></div>
        <div class="so-stat so-stat--brand"><div class="so-stat__label">일시품절 대기</div><div class="so-stat__value">${S.n ? nt : '-'}</div></div>
        <div class="so-stat"><div class="so-stat__label">재고있는 중지</div><div class="so-stat__value">${S.n ? S.rep.length : '-'}</div></div></div>`;
    } else {
      h += `<div class="so-msg so-msg--info"><span class="so-msg__icon">i</span><div class="so-msg__body"><strong class="so-msg__title">세일즈원 로그인 상태에서 바로 실행돼요</strong>위 버튼을 누르면 직매입 재고(S31) → 판매상태/수량관리 순서로 화면을 자동 조작합니다. 수량은 조회 직후 자동으로 맞추고, 판매상태 변경은 ③에서 확인 후에만 저장해요.</div></div>`;
    }
    if (S.verify) {
      const v = S.verify, clean = !v.nf.length && !v.mism.length && !v.soLeft.length && !v.outside;
      const list = v.nf.map(p => `${p.prd} · ${p.nm} · ${p.attr} — ${p.why}`).concat(v.mism.map(p => `${p.prd} · ${p.nm} · ${p.attr} — 남은 불일치`));
      h += `<div class="so-msg so-msg--${clean ? 'positive' : 'caution'}"><span class="so-msg__icon">${clean ? '✓' : '!'}</span><div class="so-msg__body"><strong class="so-msg__title">점검 ${clean ? '이상 없음' : '확인 필요'}</strong>
        미반영 ${v.nf.length} · 남은 불일치 ${v.mism.length} · 판매중 0재고 ${v.soLeft.length} · 대상 외 수정 ${v.outside}
        ${list.length ? '<div class="so-msg__list">' + list.map(x => '<div>' + esc(x) + '</div>').join('') + '</div>' : ''}</div></div>`;
    }
    if (nApplied && !S.verify) h += `<div class="so-msg so-msg--positive"><span class="so-msg__icon">✓</span><div class="so-msg__body"><strong class="so-msg__title">수량 ${nApplied}건 자동 적용</strong>전체주문가능수량을 주문가능재고에 맞춰 저장했어요.${nq ? ` 아직 다른 ${nq}건은 아래 표에서 확인해주세요.` : ''}</div></div>`;
    if (S.plan.length && !S.verify) {
      h += `<div class="so-section-head">남은 변경 <span class="so-section-head__count">${S.plan.length}</span><span class="so-section-head__spacer"></span><span class="so-hint">판매상태는 ③에서 확인 후 저장</span></div><div class="so-table-wrap"><table class="so-table"><tr><th>상품</th><th>속성</th><th class="so-num">전체주문가능</th><th>판매상태</th></tr>`;
      S.plan.forEach(p => {
        const q = p.qA !== p.qB ? `${p.qB} → <span class="${p.qA > p.qB ? 'so-up' : 'so-down'}">${p.qA}</span>` : p.qB;
        const f = p.fA !== p.fB ? `<span class="so-tag so-tag--${TAG[p.fB]}">${FLAG[p.fB]}</span> → <span class="so-tag so-tag--${TAG[p.fA]}">${FLAG[p.fA]}</span>` : `<span class="so-tag so-tag--${TAG[p.fB]}">${FLAG[p.fB]}</span>`;
        h += `<tr><td>${esc(p.prd)}<span class="so-sub">${esc(p.nm)}</span></td><td>${esc(p.a1)}/${esc(p.a2)}</td><td class="so-num">${q}</td><td>${f}</td></tr>`;
      });
      h += '</table></div>';
    } else if (S.n && !S.plan.length && !S.verify) {
      h += `<div class="so-msg so-msg--positive"><span class="so-msg__icon">✓</span><div class="so-msg__body"><strong class="so-msg__title">남은 변경이 없어요</strong>전체주문가능수량이 모두 주문가능재고와 같고, 바꿀 판매상태도 없어요.</div></div>`;
    }
    if (S.rep.length) {
      const np = S.rep.filter(r => r.pick).length;
      h += `<div class="so-section-head">재고 있는데 판매종료·일시품절 <span class="so-section-head__count">${S.rep.length}</span><span class="so-section-head__spacer"></span>
        <button class="so-btn so-btn--xs so-btn--text" id="pt">일시품절만</button><button class="so-btn so-btn--xs so-btn--text" id="pa">전체</button><button class="so-btn so-btn--xs so-btn--text" id="pn">해제</button></div>
        <div class="so-table-wrap"><table class="so-table"><tr><th><input type="checkbox" class="so-checkbox" id="pall"${np && np === S.rep.length ? ' checked' : ''}></th><th>상품</th><th>속성</th><th>상태</th><th class="so-num">수량</th></tr>`;
      S.rep.forEach((r, i) => {
        h += `<tr class="${r.pick ? 'is-selected' : ''}"><td><input type="checkbox" class="so-checkbox" data-i="${i}"${r.pick ? ' checked' : ''}></td><td>${esc(r.prd)}<span class="so-sub">${esc(r.nm)} · ${esc(r.attr)}</span></td><td>${esc(r.a1)}/${esc(r.a2)}</td><td><span class="so-tag so-tag--${TAG[r.f]}">${FLAG[r.f]}</span></td><td class="so-num">${esc(r.q)}</td></tr>`;
      });
      h += `</table></div><div class="so-hint">체크한 ${np}건은 ③ 판매상태 저장 때 판매중으로 바뀌어요. 일시품절 → 품절해제(저장 후 판매중) · 판매종료 → 판매중${S.rep.some(r => r.pick && r.f === 'Y') ? ' <b style="color:var(--negative-text)">· 판매종료 전환은 아직 실사용 검증 전이에요</b>' : ''}</div>`;
    }
    $('view').innerHTML = h;
    root.querySelectorAll('.so-checkbox[data-i]').forEach(cb => cb.onchange = () => { S.rep[+cb.dataset.i].pick = cb.checked; persist(); render(); });
    const setAll = fn => { S.rep.forEach(r => (r.pick = fn(r))); persist(); render(); };
    if ($('pall')) $('pall').onchange = e => setAll(() => e.target.checked);
    if ($('pa')) $('pa').onclick = () => setAll(() => true);
    if ($('pn')) $('pn').onclick = () => setAll(() => false);
    if ($('pt')) $('pt').onclick = () => setAll(r => r.f === 'T');
    $('s3').disabled = busy || !(S.plan.some(p => p.fA !== p.fB) || S.rep.some(r => r.pick));
    $('s2').disabled = busy || !S.codes.length;
    $('s4').disabled = busy || !S.codes.length;
  }

  let busy = false;
  const ACT = ['all', 's1', 's2', 's3', 's4'];
  const run = (id, fn) => async () => {
    if (busy) return; busy = true;
    const b = $(id), label = b.innerHTML;
    ACT.forEach(x => ($(x).disabled = true));
    b.innerHTML = `<span class="so-spinner"></span>${label}`;
    $('logbox').open = true;
    try { await fn(); } catch (e) { log('오류: ' + (e && e.message || e), true); $('ask').innerHTML = `<div class="so-msg so-msg--negative"><span class="so-msg__icon">!</span><div class="so-msg__body"><strong class="so-msg__title">멈췄어요</strong>${esc(e && e.message || e)}<br>[진단 내용 복사]를 눌러 Claude에게 붙여넣어 주세요.</div></div>`; }
    busy = false; b.innerHTML = label;
    ACT.forEach(x => ($(x).disabled = false));
    render();
  };
  $('s1').onclick = run('s1', async () => { await stepExtract(); });
  $('s2').onclick = run('s2', stepQuery);
  $('all').onclick = run('all', async () => { await stepExtract(); render(); await stepQuery(); log(S.plan.some(p => p.fA !== p.fB) || S.rep.length ? '판매상태 변경은 확인 후 ③ 판매상태 저장을 눌러주세요' : '판매상태를 바꿀 것은 없어요'); });
  $('s3').onclick = run('s3', stepSave);
  $('s4').onclick = run('s4', async () => { if (!S.saved) S.saved = { plan: [], picks: [] }; await stepVerify(); });
  $('cp').onclick = async () => log(await copyText(report()) ? '📋 보고 내용을 복사했습니다' : '❗ 복사 실패', false);
  $('csv').onclick = downloadCsv;
  $('diag').onclick = async () => {
    const text = buildDiag(); console.log(text);
    $('logbox').open = true;
    log(await copyText(text) ? `📋 진단 내용을 복사했습니다(${text.length}자). Claude 대화창에 붙여넣어 주세요.` : '❗ 클립보드 복사 실패. F12 콘솔에 출력된 진단 내용을 복사해 주세요.');
  };
  $('x').onclick = () => host.remove();
  $('min').onclick = () => { const b = $('body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
  (() => { // 드래그
    const h = root.querySelector('.so-panel__head'); let sx, sy, ox, oy;
    h.onmousedown = e => {
      if (e.target.tagName === 'BUTTON') return;
      sx = e.clientX; sy = e.clientY; const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      const mv = ev => { host.style.left = ox + ev.clientX - sx + 'px'; host.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; host.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    };
  })();
  log(`${TITLE} ${VER} 준비됨${S.codes.length ? ` · 이전 결과(대상 ${S.codes.length}개) 불러옴` : ''}`);
  render();
})();
