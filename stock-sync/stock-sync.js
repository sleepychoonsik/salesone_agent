/* =========================================================================
 * [세일즈원 자동화] 재고동기화 (SJ와니 · AM) v1.0
 *  - 직매입 재고/평가감 현황(영업부서 S31)에서 SJ와니·AM 상품코드 추출
 *  - 판매상태/수량관리: 전체주문가능수량 = 주문가능재고(A), 주문가능재고 ≤ 0 인 판매중 → 일시품절
 *  - 재고 있는데 판매종료/일시품절인 SKU는 체크한 것만 판매중으로 전환
 *  - 저장은 패널 안 확인 후 1000건 단위, 저장 뒤 재조회 점검
 *  - 화면 요소를 못 찾으면 멈추고 "직접 처리 후 [계속]" 안내
 *  - 문제가 생기면 [진단 내용 복사] → Claude에게 붙여넣기
 *  - 디자인: Montage(wanteddev/montage-web) 토큰 · Pretendard · 포인트 #0088FF
 * ========================================================================= */
(async () => {
  'use strict';
  const TITLE = '재고동기화';
  const VER = 'v1.0';
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
    const rows = (await querySale()).getDataSource().getJsonRows(0, -1);
    const plan = buildPlan(rows);
    const after = new Map(plan.map(p => [p.attr, p]));
    const prevPick = new Set((S.rep || []).filter(r => r.pick).map(r => r.attr));
    S.rep = rows.map(r => {
      const p = after.get(r.attrPrdCd);
      return Object.assign(info(r), { q: p ? p.qA : Number(r.allOrdPsblQty), f: p ? p.fA : r.saleFlag, pick: prevPick.has(r.attrPrdCd) });
    }).filter(x => x.q > 0 && (x.f === 'Y' || x.f === 'T'));
    S.plan = plan; S.verify = null; S.n = rows.length; persist();
    log(`SKU ${rows.length}건 · 수량 갱신 ${plan.filter(p => p.qA !== p.qB).length} · 일시품절 전환 ${plan.filter(p => p.fA !== p.fB).length} · 재고 있는 판매중지 ${S.rep.length}`);
  }

  /* ---------------- ③ 저장 ---------------- */
  async function clickSave() {
    (await need(() => btnByText('저장'), '[저장] 버튼')).click();
    const d1 = await need(() => { const d = topDialog(); return d && btnByText('확인', d) ? d : null; }, '저장 확인창', 15000);
    const m1 = txt(d1).replace(/\s+/g, ' ');
    if (!/저장\s*하시겠습니까/.test(m1)) throw new Error('예상 못한 팝업: ' + m1.slice(0, 120));
    btnByText('확인', d1).click();
    await waitIdle(180000);
    const d2 = await need(() => { const d = topDialog(); return d && btnByText('확인', d) ? d : null; }, '저장 결과 팝업', 60000);
    const m2 = txt(d2).replace(/\s+/g, ' ');
    btnByText('확인', d2).click();
    await sleep(500);
    if (!/저장\s*완료/.test(m2)) throw new Error('저장 결과 팝업: ' + m2.slice(0, 160));
  }
  async function stepSave() {
    D.step = '③ 저장';
    const picks = S.rep.filter(r => r.pick);
    if (!S.plan.length && !picks.length) { log('저장할 변경이 없어요'); return; }
    const nq = S.plan.filter(p => p.qA !== p.qB).length, nt = S.plan.filter(p => p.fA !== p.fB).length;
    const ok = await ask('brand', '세일즈원에 저장할까요?',
      `수량 갱신 ${nq}건 · 일시품절 전환 ${nt}건${picks.length ? ` · 판매재개 ${picks.length}건` : ''}<br>저장 직전에 다시 조회해서 최신 값 기준으로 적용합니다.`, '저장', '취소');
    if (!ok) { log('저장 취소'); return; }
    log('저장 직전 재조회');
    const g = await querySale();
    const ds = g.getDataSource();
    const fresh = ds.getJsonRows(0, -1);
    const idx = new Map(fresh.map((r, i) => [r.attrPrdCd, i]));
    S.plan = buildPlan(fresh); persist();
    const ops = new Map();
    const add = (i, fn) => { const prev = ops.get(i); ops.set(i, prev ? () => { prev(); fn(); } : fn); };
    for (const p of S.plan) {
      const i = idx.get(p.attr); if (i == null) continue;
      add(i, () => { if (p.qA !== p.qB) ds.setValue(i, 'allOrdPsblQty', p.qA); if (p.fA !== p.fB) ds.setValue(i, 'saleFlag', p.fA); });
    }
    for (const r of picks) {
      const i = idx.get(r.attr); if (i == null) continue;
      const cur = fresh[i].saleFlag;
      if (cur !== 'Y' && cur !== 'T') continue;                  // 이미 판매중이면 건너뜀
      add(i, () => ds.setValue(i, 'saleFlag', cur === 'T' ? 'S' : 'N')); // 일시품절→품절해제, 판매종료→판매중
    }
    const list = [...ops.entries()];
    log(`적용 대상 ${list.length}행 (최신 값 기준 변경 ${S.plan.length} · 판매재개 ${picks.length})`);
    for (let k = 0; k < list.length; k += BATCH) {
      const chunk = list.slice(k, k + BATCH);
      if (g.commit) g.commit(true);
      if (g.checkAll) g.checkAll(false);
      chunk.forEach(([i, fn]) => { fn(); g.checkRow(i, true); });
      log(`${k + 1}–${k + chunk.length}행 저장 중…`);
      await clickSave();
      log('저장 완료');
    }
    S.saved = { plan: S.plan, picks: picks.map(r => Object.assign({}, r)) };
    persist();
    await stepVerify();
  }

  /* ---------------- ④ 점검 ---------------- */
  async function stepVerify() {
    D.step = '④ 점검';
    log('다시 조회해서 점검');
    const rows = (await querySale()).getDataSource().getJsonRows(0, -1);
    const by = new Map(rows.map(r => [r.attrPrdCd, r]));
    const sv = S.saved || { plan: [], picks: [] };
    const nf = [];
    for (const p of sv.plan) {
      const r = by.get(p.attr);
      if (!r || Number(r.allOrdPsblQty) !== p.qA || r.saleFlag !== p.fA)
        nf.push(Object.assign({}, p, { why: !r ? '행 없음' : r.saleFlag === 'Y' ? '판매종료 상품이라 반영 안 됨' : `값 불일치(${r.allOrdPsblQty}/${FLAG[r.saleFlag]})` }));
    }
    for (const p of sv.picks) {
      const r = by.get(p.attr);
      if (!r || r.saleFlag === 'Y' || r.saleFlag === 'T') nf.push(Object.assign({}, p, { why: '판매재개 미반영(' + (r ? FLAG[r.saleFlag] : '행 없음') + ')' }));
    }
    const nfSet = new Set(nf.map(x => x.attr));
    const mism = rows.filter(r => Number(r.allOrdPsblQty) !== Number(r.ordPsblStockQty) && !nfSet.has(r.attrPrdCd)).map(info);
    const soLeft = rows.filter(r => Number(r.ordPsblStockQty) <= 0 && r.saleFlag === 'N').map(info);
    const codeSet = new Set(S.codes);
    const outside = sv.plan.filter(p => !codeSet.has(p.prd)).length;
    S.rep = rows.filter(r => Number(r.allOrdPsblQty) > 0 && (r.saleFlag === 'Y' || r.saleFlag === 'T'))
      .map(r => Object.assign(info(r), { q: Number(r.allOrdPsblQty), f: r.saleFlag, pick: false }));
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
    if (sv.picks.length) {
      L.push(`- 판매재개 ${sv.picks.length}건`);
      sv.picks.forEach(p => L.push(`  - ${p.prd} · ${p.nm} · ${p.a1}/${p.a2} (${FLAG[p.f]}→판매중)`));
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
    L.push('\n## 최근 로그'); L.push(D.logs.slice(-80).join('\n') || '- 없음');
    return L.join('\n');
  }

  /* ---------------- UI (Montage 토큰) ---------------- */
  if (!document.getElementById('__ssy_font')) {
    const lk = document.createElement('link'); lk.id = '__ssy_font'; lk.rel = 'stylesheet';
    lk.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.appendChild(lk);
  }
  const old = document.getElementById(PANEL_ID); if (old) old.remove();
  const host = document.createElement('div'); host.id = PANEL_ID;
  host.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
:host{all:initial;
  /* Montage semantic tokens — brand = GS SHOP blue */
  --brand:#0088FF;--brand-strong:#0077E6;--brand-heavy:#0066C7;--brand-subtle:rgba(0,136,255,.05);--brand-line:rgba(0,136,255,.28);--brand-focus:rgba(0,136,255,.12);
  --fg:#171719;--fg-2:rgba(46,47,51,.88);--fg-3:rgba(55,56,60,.61);--fg-4:rgba(55,56,60,.28);--fg-dis:rgba(55,56,60,.16);
  --bg:#FFFFFF;--bg-2:#F7F7F8;--sf-2:rgba(112,115,124,.08);--sf-3:rgba(112,115,124,.05);--sf-dis:#F4F4F5;
  --line:rgba(112,115,124,.22);--line-2:rgba(112,115,124,.16);--line-3:rgba(112,115,124,.08);
  --pos:#00BF40;--pos-sf:rgba(0,191,64,.08);--cau:#FF9200;--cau-sf:rgba(255,146,0,.08);--neg:#FF4242;--neg-strong:#E52222;--neg-sf:rgba(255,66,66,.08);
  --shadow:0 6px 10px -4px rgba(23,23,23,.08),0 16px 24px -6px rgba(23,23,23,.08);
  --font:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
*{box-sizing:border-box}
.p{font-family:var(--font);color:var(--fg);width:452px;max-height:84vh;display:flex;flex-direction:column;background:var(--bg);
   border:1px solid var(--line-2);border-radius:16px;box-shadow:var(--shadow);overflow:hidden;-webkit-font-smoothing:antialiased}
/* header — headline2 */
.h{display:flex;align-items:center;gap:8px;padding:14px 12px 14px 18px;border-bottom:1px solid var(--line-3);cursor:move;user-select:none}
.h .t{flex:1;font-size:17px;line-height:24px;font-weight:600;letter-spacing:0}
.h .t i{display:inline-block;width:8px;height:8px;border-radius:9999px;background:var(--brand);margin-right:8px;vertical-align:2px}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--brand-subtle);color:var(--brand);font-size:11px;line-height:14px;font-weight:600;letter-spacing:.0311em;vertical-align:2px;margin-left:4px}
.ib{width:32px;height:32px;border:0;border-radius:10px;background:transparent;color:var(--fg-3);font:500 18px/1 var(--font);cursor:pointer}
.ib:hover{background:var(--sf-2);color:var(--fg)}
.b{padding:16px 18px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
/* buttons — Montage small (32 / r10 / caption1 bold) & medium (40 / r12 / label1 bold) */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:0;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:background .12s,box-shadow .12s}
.btn.md{min-height:40px;padding:10px 16px;border-radius:12px;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.0145em}
.btn.sm{min-height:32px;padding:8px 12px;border-radius:10px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.0252em}
.btn.xs{min-height:28px;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;font-weight:600}
.btn.primary{background:var(--brand);color:#fff}.btn.primary:hover{background:var(--brand-strong)}
.btn.outlined{background:var(--bg);color:var(--brand);box-shadow:inset 0 0 0 1px var(--line)}.btn.outlined:hover{background:var(--brand-subtle)}
.btn.assist{background:var(--sf-2);color:var(--fg-2)}.btn.assist:hover{background:rgba(112,115,124,.14)}
.btn.text{background:transparent;color:var(--fg-3);padding-left:6px;padding-right:6px}.btn.text:hover{color:var(--fg)}
.btn:disabled{background:var(--sf-dis)!important;color:var(--fg-dis)!important;box-shadow:none!important;cursor:default}
.btn:focus-visible,.cb:focus-visible{outline:none;box-shadow:0 0 0 3px var(--brand-focus)}
.full{width:100%}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
/* steps */
.steps{display:flex;gap:4px}
.st{flex:1;display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:14px;font-weight:500;color:var(--fg-3);letter-spacing:.0311em}
.st b{display:block;height:4px;border-radius:9999px;background:var(--sf-2)}
.st.on{color:var(--brand)}.st.on b{background:var(--brand)}.st.done b{background:var(--brand-line)}
/* stat cards */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.sc{background:var(--bg-2);border-radius:12px;padding:10px 10px 9px}
.sc .k{font-size:11px;line-height:14px;color:var(--fg-3);font-weight:500;letter-spacing:.0311em}
.sc .v{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.012em;font-variant-numeric:tabular-nums}
.sc.brand .v{color:var(--brand)}
/* section message */
.msg{display:flex;gap:10px;padding:12px 14px;border-radius:12px;font-size:13px;line-height:18px;letter-spacing:.0194em;background:var(--sf-3);color:var(--fg-2)}
.msg .dot{flex:none;width:18px;height:18px;border-radius:9999px;display:grid;place-items:center;font:700 11px/1 var(--font);color:#fff;background:var(--fg-3);margin-top:0}
.msg.brand{background:var(--brand-subtle)}.msg.brand .dot{background:var(--brand)}
.msg.caution{background:var(--cau-sf)}.msg.caution .dot{background:var(--cau)}
.msg.negative{background:var(--neg-sf)}.msg.negative .dot{background:var(--neg)}
.msg.positive{background:var(--pos-sf)}.msg.positive .dot{background:var(--pos)}
.msg .c{flex:1;min-width:0}.msg .c strong{display:block;color:var(--fg);font-weight:600;margin-bottom:2px}
.msg .act{display:flex;gap:6px;margin-top:10px}
/* section header */
.sh{display:flex;align-items:center;gap:6px;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.0145em}
.sh .n{color:var(--brand)}.sh .sp{flex:1}
/* table */
.tw{border:1px solid var(--line-2);border-radius:12px;overflow:auto;max-height:228px}
table{border-collapse:collapse;width:100%;font-size:12px;line-height:16px;letter-spacing:.0252em}
th{position:sticky;top:0;background:var(--bg-2);color:var(--fg-3);font-weight:500;text-align:left;padding:8px;border-bottom:1px solid var(--line-2);white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--line-3);vertical-align:top;color:var(--fg-2)}
tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td .s{display:block;color:var(--fg-3);font-size:11px;line-height:14px;margin-top:2px}
.up{color:var(--brand);font-weight:600}.dn{color:var(--neg-strong);font-weight:600}
.tag{display:inline-flex;height:20px;align-items:center;padding:0 6px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap}
.tag.Y{background:var(--sf-2);color:var(--fg-3)}.tag.T{background:var(--cau-sf);color:#D47800}.tag.N{background:var(--brand-subtle);color:var(--brand)}
tr.pk td{background:var(--brand-subtle)}
/* checkbox — Montage: 20px, r5, brand fill */
.cb{appearance:none;-webkit-appearance:none;width:20px;height:20px;margin:0;border-radius:5px;box-shadow:inset 0 0 0 1.5px var(--line);background:var(--bg);cursor:pointer;display:grid;place-items:center;vertical-align:middle}
.cb:checked{background:var(--brand);box-shadow:none}
.cb:checked::after{content:"";width:10px;height:6px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:translateY(-1px) rotate(-45deg)}
.hint{font-size:12px;line-height:16px;color:var(--fg-3);letter-spacing:.0252em}
/* log */
details{border-top:1px solid var(--line-3);padding-top:10px}
summary{cursor:pointer;font-size:13px;line-height:18px;font-weight:600;color:var(--fg-2);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";display:inline-block;margin-right:6px;color:var(--fg-3);transition:transform .15s}
details[open] summary::before{transform:rotate(90deg)}
.log{margin-top:8px;background:var(--bg-2);border-radius:10px;padding:10px;max-height:150px;overflow:auto;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--fg-2);white-space:pre-wrap}
.log .e{color:var(--neg-strong)}
.foot{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:9999px;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
</style>
<div class="p">
  <div class="h"><div class="t"><i></i>${TITLE}<span class="chip">${VER}</span><span class="chip" style="background:var(--sf-2);color:var(--fg-3)">SJ와니 · AM</span></div>
    <button class="ib" id="min" title="접기">–</button><button class="ib" id="x" title="닫기">×</button></div>
  <div class="b" id="body">
    <div class="steps" id="steps"></div>
    <button class="btn md primary full" id="all">대상 추출하고 변경안 보기</button>
    <div class="grid2">
      <button class="btn sm outlined" id="s1">① 대상 추출</button>
      <button class="btn sm outlined" id="s2">② 조회·변경안</button>
      <button class="btn sm primary" id="s3">③ 저장</button>
      <button class="btn sm outlined" id="s4">④ 점검</button>
    </div>
    <div id="ask"></div>
    <div id="view"></div>
    <details id="logbox"><summary>진행 로그</summary><div class="log" id="log"></div></details>
    <div class="foot">
      <button class="btn xs text" id="cp">보고 복사</button>
      <button class="btn xs text" id="csv">CSV 저장</button>
      <button class="btn xs assist" id="diag" title="오류가 나면 눌러서 Claude에게 붙여넣기">진단 내용 복사</button>
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
    const div = document.createElement('div'); div.textContent = line; if (err) div.className = 'e';
    $('log').appendChild(div); $('log').scrollTop = $('log').scrollHeight;
  }
  // 패널 안 확인창 (되돌리기 어려운 동작·사용자 처리 대기)
  function ask(kind, title, body, yes, no) {
    return new Promise(res => {
      $('ask').innerHTML = `<div class="msg ${kind}"><span class="dot">${kind === 'brand' ? '?' : '!'}</span><div class="c"><strong>${esc(title)}</strong>${body}
        <div class="act"><button class="btn sm primary" id="ay">${esc(yes)}</button>${no ? `<button class="btn sm assist" id="an">${esc(no)}</button>` : ''}</div></div></div>`;
      const done = v => { $('ask').innerHTML = ''; res(v); };
      $('ay').onclick = () => done(true);
      if ($('an')) $('an').onclick = () => done(false);
      $('ask').scrollIntoView({ block: 'nearest' });
    });
  }

  function render() {
    const stage = S.verify ? 4 : S.saved ? 3 : S.plan.length || S.rep.length || S.n ? 2 : S.codes.length ? 1 : 0;
    $('steps').innerHTML = ['대상 추출', '변경안', '저장', '점검'].map((t, i) =>
      `<div class="st ${i + 1 === stage + 1 ? 'on' : i < stage ? 'done' : ''}"><b></b>${i + 1}. ${t}</div>`).join('');
    const nq = S.plan.filter(p => p.qA !== p.qB).length, nt = S.plan.filter(p => p.fA !== p.fB).length;
    let h = '';
    if (S.codes.length) {
      h += `<div class="stats">
        <div class="sc"><div class="k">대상 상품</div><div class="v">${S.codes.length}</div></div>
        <div class="sc brand"><div class="k">수량 갱신</div><div class="v">${S.n ? nq : '-'}</div></div>
        <div class="sc brand"><div class="k">일시품절</div><div class="v">${S.n ? nt : '-'}</div></div>
        <div class="sc"><div class="k">재고있는 중지</div><div class="v">${S.n ? S.rep.length : '-'}</div></div></div>`;
    } else {
      h += `<div class="msg brand"><span class="dot">i</span><div class="c"><strong>세일즈원 로그인 상태에서 바로 실행돼요</strong>위 버튼을 누르면 직매입 재고(S31) → 판매상태/수량관리 순서로 화면을 자동 조작합니다. 저장은 ③에서 확인 후에만 해요.</div></div>`;
    }
    if (S.verify) {
      const v = S.verify, clean = !v.nf.length && !v.mism.length && !v.soLeft.length && !v.outside;
      const list = v.nf.map(p => `${p.prd} · ${p.nm} · ${p.attr} — ${p.why}`).concat(v.mism.map(p => `${p.prd} · ${p.nm} · ${p.attr} — 남은 불일치`));
      h += `<div class="msg ${clean ? 'positive' : 'caution'}"><span class="dot">${clean ? '✓' : '!'}</span><div class="c"><strong>점검 ${clean ? '이상 없음' : '확인 필요'}</strong>
        미반영 ${v.nf.length} · 남은 불일치 ${v.mism.length} · 판매중 0재고 ${v.soLeft.length} · 대상 외 수정 ${v.outside}
        ${list.length ? '<br>' + list.map(esc).join('<br>') : ''}</div></div>`;
    }
    if (S.plan.length && !S.verify) {
      h += `<div class="sh">변경안 <span class="n">${S.plan.length}</span></div><div class="tw"><table><tr><th>상품</th><th>속성</th><th style="text-align:right">전체주문가능</th><th>판매상태</th></tr>`;
      S.plan.forEach(p => {
        const q = p.qA !== p.qB ? `${p.qB} → <span class="${p.qA > p.qB ? 'up' : 'dn'}">${p.qA}</span>` : p.qB;
        const f = p.fA !== p.fB ? `<span class="tag ${p.fB}">${FLAG[p.fB]}</span> → <span class="tag ${p.fA}">${FLAG[p.fA]}</span>` : `<span class="tag ${p.fB}">${FLAG[p.fB]}</span>`;
        h += `<tr><td>${esc(p.prd)}<span class="s">${esc(p.nm)}</span></td><td>${esc(p.a1)}/${esc(p.a2)}</td><td class="n">${q}</td><td>${f}</td></tr>`;
      });
      h += '</table></div>';
    } else if (S.n && !S.plan.length && !S.verify) {
      h += `<div class="msg positive"><span class="dot">✓</span><div class="c"><strong>수량·판매상태 변경할 게 없어요</strong>전체주문가능수량이 모두 주문가능재고와 같아요.</div></div>`;
    }
    if (S.rep.length) {
      const np = S.rep.filter(r => r.pick).length;
      h += `<div class="sh">재고 있는데 판매종료·일시품절 <span class="n">${S.rep.length}</span><span class="sp"></span>
        <button class="btn xs text" id="pt">일시품절만</button><button class="btn xs text" id="pa">전체</button><button class="btn xs text" id="pn">해제</button></div>
        <div class="tw"><table><tr><th><input type="checkbox" class="cb" id="pall"${np && np === S.rep.length ? ' checked' : ''}></th><th>상품</th><th>속성</th><th>상태</th><th style="text-align:right">수량</th></tr>`;
      S.rep.forEach((r, i) => {
        h += `<tr class="${r.pick ? 'pk' : ''}"><td><input type="checkbox" class="cb" data-i="${i}"${r.pick ? ' checked' : ''}></td><td>${esc(r.prd)}<span class="s">${esc(r.nm)} · ${esc(r.attr)}</span></td><td>${esc(r.a1)}/${esc(r.a2)}</td><td><span class="tag ${r.f}">${FLAG[r.f]}</span></td><td class="n">${esc(r.q)}</td></tr>`;
      });
      h += `</table></div><div class="hint">체크한 ${np}건은 ③ 저장 때 판매중으로 바뀌어요. 일시품절 → 품절해제(저장 후 판매중) · 판매종료 → 판매중${S.rep.some(r => r.pick && r.f === 'Y') ? ' <b style="color:var(--neg-strong)">· 판매종료 전환은 아직 실사용 검증 전이에요</b>' : ''}</div>`;
    }
    $('view').innerHTML = h;
    root.querySelectorAll('.cb[data-i]').forEach(cb => cb.onchange = () => { S.rep[+cb.dataset.i].pick = cb.checked; persist(); render(); });
    const setAll = fn => { S.rep.forEach(r => (r.pick = fn(r))); persist(); render(); };
    if ($('pall')) $('pall').onchange = e => setAll(() => e.target.checked);
    if ($('pa')) $('pa').onclick = () => setAll(() => true);
    if ($('pn')) $('pn').onclick = () => setAll(() => false);
    if ($('pt')) $('pt').onclick = () => setAll(r => r.f === 'T');
    $('s3').disabled = busy || !(S.plan.length || S.rep.some(r => r.pick));
    $('s2').disabled = busy || !S.codes.length;
    $('s4').disabled = busy || !S.codes.length;
  }

  let busy = false;
  const ACT = ['all', 's1', 's2', 's3', 's4'];
  const run = (id, fn) => async () => {
    if (busy) return; busy = true;
    const b = $(id), label = b.innerHTML;
    ACT.forEach(x => ($(x).disabled = true));
    b.innerHTML = `<span class="spin" style="${b.classList.contains('primary') ? '' : 'border-color:var(--brand-line);border-top-color:var(--brand)'}"></span>${label}`;
    $('logbox').open = true;
    try { await fn(); } catch (e) { log('오류: ' + (e && e.message || e), true); $('ask').innerHTML = `<div class="msg negative"><span class="dot">!</span><div class="c"><strong>멈췄어요</strong>${esc(e && e.message || e)}<br>[진단 내용 복사]를 눌러 Claude에게 붙여넣어 주세요.</div></div>`; }
    busy = false; b.innerHTML = label;
    ACT.forEach(x => ($(x).disabled = false));
    render();
  };
  $('s1').onclick = run('s1', async () => { await stepExtract(); });
  $('s2').onclick = run('s2', stepQuery);
  $('all').onclick = run('all', async () => { await stepExtract(); render(); await stepQuery(); log('변경안을 확인하고 ③ 저장을 눌러주세요'); });
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
    const h = root.querySelector('.h'); let sx, sy, ox, oy;
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
