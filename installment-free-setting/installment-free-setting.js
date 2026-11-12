/* =========================================================================
 * [세일즈원 자동화] 방송중 무이자 세팅 v1.2
 *  - 상품조회/수정 > 가격/프로모션 기능을 세일즈원 API로 처리 (화면과 동일한 요청)
 *  - 개월수는 상품별로 지정(기본 10개월, 2~12개월). 당사 무이자 할부 규정(판매가별 최대 개월) 안이면 가격은 건드리지 않음
 *    규정: 5만 미만 없음 / 5~10만 미만 3개월 / 10~20만 미만 9개월 / 20만 이상 12개월 → 규정 밖이면 기준가로 올린 뒤 세팅·원복
 *  - 직매입 : 기존 무이자 종료 → (기준가 인상) → 방송중 무이자(당사100) → (가격 원복) → 기존 무이자 복구
 *  - 위수탁 : 3개월 이하는 당사100이라 직매입처럼 한 번에 처리, 4개월 이상은 당사50/업체50
 *             [1단계] 기존 무이자 종료 → (기준가 예약) → 방송중 무이자(당사50/업체50) 합의요청
 *             [2단계: 합의 승인 후] 가격 원복(마진48%) → 기존 무이자 복구(업체부담>0이면 합의요청)
 *  - 업체부담 > 0 인 무이자는 반드시 협력사 합의 요청으로만 등록 (직접 등록 금지)
 *  - 문제가 생기면 패널의 [진단 내용 복사]로 버전·단계·오류·URL·API 기록·로그를 복사해 Claude에게 붙여넣는다.
 * ========================================================================= */
(async () => {
  'use strict';
  const TITLE = '장기무이자 세팅 자동화';
  const VER = 'v1.2';
  // 최신 버전 확인: raw 주소는 최대 5분 캐시되므로, 최신 커밋을 직접 조회해 더 새 버전이 있으면 그걸 실행한다
  if (!window.__NIF_FRESH) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
      const R = 'sleepychoonsik/salesone_agent', F = 'installment-free-setting/installment-free-setting.js';
      const sha = (await (await fetch(`https://api.github.com/repos/${R}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-store', signal: ctl.signal })).text()).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) {
        const code = await (await fetch(`https://raw.githubusercontent.com/${R}/${sha}/${F}`, { signal: ctl.signal })).text();
        const m = code.match(/const VER = '([^']+)'/);
        clearTimeout(tm);
        if (m && m[1] !== VER) {
          window.__NIF_FRESH = true;
          setTimeout(() => { window.__NIF_FRESH = false; }, 5000);
          (0, eval)(code);
          return;
        }
      }
      clearTimeout(tm);
    } catch (e) { /* 확인 실패 시 지금 버전으로 진행 */ }
  }
  const BFF = 'https://everest-bff.gshs.co.kr';
  const PANEL_ID = '__nif_panel';
  const LS_KEY = '__nif_state_v1';
  const DEFAULT_MM = 10;
  const MM_MIN = 2, MM_MAX = 12; // 13개월 이상은 판매가와 무관하게 규정 외(품의 대상) → 지원하지 않음
  // 당사 무이자 할부 규정(판매가별 최대 개월): 5만 미만 없음 / 5~10만 미만 3 / 10~20만 미만 9 / 20만 이상 12
  const minPriceFor = mm => mm <= 3 ? 50000 : mm <= 9 ? 100000 : 200000;
  // 위수탁 업체부담율: 3개월 이하는 당사 100, 4개월 이상은 당사 50 / 업체 50 (직매입은 항상 당사 100)
  const supRateFor = (consign, mm) => consign && mm > 3 ? 50 : 0;
  const MAX_DROP = 0.41;      // 업체지급액 기준 1회 최대 하락률
  const CONSIGN_GIV = 0.52;   // 위수탁 업체지급율 (마진 48%)

  if (!/nsalesone\.gshs\.co\.kr$/.test(location.host)) {
    alert('[' + TITLE + '] n세일즈원(nsalesone.gshs.co.kr) 화면에서 실행해주세요.');
    return;
  }
  const old = document.getElementById(PANEL_ID);
  if (old) old.remove();
  // 진단용 상태 (토큰·쿠키는 절대 담지 않음)
  const S = { step: '대기', errors: [], calls: [], logs: [] };
  const tnow = () => new Date().toTimeString().slice(0, 8);

  /* ---------------- 토큰 확보 (세일즈원 요청 헤더 가로채기) ---------------- */
  const W = window;
  if (!W.__nifHooked) {
    W.__nifHooked = true;
    const srh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (/^authorization$/i.test(k) && /^Bearer /.test(v)) W.__nifAuth = v;
      return srh.apply(this, arguments);
    };
    const of = W.fetch;
    W.fetch = function (i, o) {
      try {
        const h = o && o.headers;
        const a = h && (h.Authorization || h.authorization || (h.get && h.get('Authorization')));
        if (a && /^Bearer /.test(a) && !(o && o.__nif)) W.__nifAuth = a;
      } catch (e) {}
      return of.apply(this, arguments);
    };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jwt = () => {
    try { return JSON.parse(atob(W.__nifAuth.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
    catch (e) { return null; }
  };
  const authOk = () => { const p = jwt(); return !!(p && p.exp * 1000 > Date.now() + 60000); };
  // 토큰은 저장소에 암호화돼 있어 세일즈원이 보내는 요청에서 가로챔 → 없으면 사용자가 [조회]를 한 번 누르도록 안내
  async function ensureAuth(notify) {
    if (authOk()) return true;
    W.__nifAuth = null;
    notify && notify('🔑 세일즈원 화면에서 [조회] 버튼을 한 번 눌러주세요 (로그인 정보 확인용, 60초 대기)');
    for (let i = 0; i < 240 && !authOk(); i++) await sleep(250);
    return authOk();
  }
  async function api(method, path, body) {
    const r = await fetch(BFF + path, {
      __nif: true, method, cache: 'no-store',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': W.__nifAuth },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { j = { resultCd: 'HTTP' + r.status, message: t.slice(0, 200) }; }
    if (method !== 'GET' || !(j && (j.resultCd === 'SUCCESS' || j.promotion || Array.isArray(j)))) {
      const b = Array.isArray(body) ? body[0] : body;
      const brief = b ? ['prdCd', 'validStrDtm', 'validEndDtm', 'salePrc', 'supGivRtamt', 'noIntMmCnt', 'noIntInsmFeeSupShrRt'].filter(k => b[k] !== undefined).map(k => k + '=' + b[k]).join(' ') : '';
      S.calls.push(`[${tnow()}] ${method} ${path.split('?')[0]} → ${r.status} ${(j && j.resultCd) || ''} ${(j && j.message) || ''} ${brief}`);
      if (S.calls.length > 120) S.calls.shift();
    }
    if (j && j.resultCd === 'FAIL' && /토큰/.test(j.message || '')) throw new Error('로그인 토큰 만료 — 세일즈원에서 [조회]를 누른 뒤 다시 실행해주세요');
    return j;
  }
  const ok = r => r && r.resultCd === 'SUCCESS';
  const msg = r => (r && (r.message || r.resultCd)) || '';

  /* ---------------- 날짜 ---------------- */
  const p2 = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const short = s => String(s || '').replace('T', ' ').slice(5, 16);
  const parseDt = s => {
    const m = String(s).trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) : null;
  };
  const toZ = s => new Date(s).toISOString();
  const addMin = (d, m) => new Date(d.getTime() + m * 60000);
  const END = '2999-12-31T23:59:59';

  /* ---------------- 세일즈원 조회 ---------------- */
  async function loadProduct(cd) {
    const q = new URLSearchParams({ prdCd: cd, chanlCd: 'A', pmoCurFutGbn: 'CURR', pmoQryGbn: '01', stdDtm: fmt(new Date()) });
    const d = await api('GET', '/bff/product/v1/management/query/promotions/prices/all?' + q);
    if (!d || !d.promotion) throw new Error('상품 조회 실패: ' + msg(d));
    const dc = (await api('GET', `/bff/promotion/v1/management/query/products/${cd}/requested/types/PROMOTION`))[0] || {};
    return { d, dc };
  }
  const prices = d => (d.prices || []).slice().sort((a, b) => a.validStrDtm < b.validStrDtm ? -1 : 1);
  const latestPrice = d => prices(d).slice(-1)[0];
  const isConsign = d => String((d.promotion || {}).prchTypCd) !== '01';
  const cRows = d => (d.noInterestPromotions || []).filter(r => r.chanlCd === 'C');

  /* ---------------- 가격 단계 (직전가 대비 41% 이내, 900원 끝) ---------------- */
  function steps(target, from) {
    const s = []; let cur = from;
    for (let g = 0; g < 10; g++) {
      if ((cur - target) / cur <= MAX_DROP) { s.push(target); break; }
      let n = Math.ceil(cur * (1 - MAX_DROP) / 100) * 100;
      if (n % 1000 !== 900) n = Math.ceil((n - 900) / 1000) * 1000 + 900;
      if ((cur - n) / cur > MAX_DROP) n += 1000;
      s.push(n); cur = n;
    }
    return s;
  }

  /* ---------------- 세일즈원 쓰기 ---------------- */
  const priceBody = (cd, consign, str, prc, base, doc) => {
    const b = { prdCd: String(cd), validStrDtm: str, validEndDtm: END, salePrc: prc, prchPrc: base.prchPrc, prdAgreeDocNo: doc };
    if (consign) { const giv = Math.round(prc * CONSIGN_GIV); b.supGivRtamtCd = '01'; b.supGivRtamt = giv; b.prchPrc = giv; }
    return b;
  };
  const postPrice = (cd, consign, str, prc, base, doc) =>
    api('POST', `/bff/promotion/v1/management/command/products/${cd}/prices`, priceBody(cd, consign, str, prc, base, doc));
  const deletePrice = (cd, row) =>
    api('DELETE', `/bff/promotion/v1/management/command/products/${cd}/prices/${row.validStrDtm}/${row.validEndDtm}`);
  const endNoint = (row, newEnd) => api('PUT', '/bff/promotion/v1/management/command/promotions', {
    aprvStCd: row.aprvStCd, chanlCd: row.chanlCd, applyPriorRank: String(row.applyPriorRank),
    validStrDtm: row.validStrDtm, validEndDtm: newEnd, noIntMmCnt: row.noIntMmCnt,
    noIntInsmFeeGsShrRt: 100 - (row.noIntInsmFeeSupShrRt || 0), noIntInsmFeeSupShrRt: row.noIntInsmFeeSupShrRt || 0,
    sgpayCalc: false, rtamtCd: row.rtamtCd, gshsApplyRtamt: String(row.gshsApplyRtamt), supApplyRtamt: String(row.supApplyRtamt),
    regDtm: toZ(row.regDtm), existValidEndDtm: toZ(row.validEndDtm), regrNm: row.regrNm, modrNm: row.modrNm,
    pmoNo: String(row.pmoNo), prdCd: String(row.prdCd), offerTypCd: row.offerTypCd, ifYn: 'Y', tgtGbnCd: row.tgtGbnCd,
    aprvYn: 'N', prdPmoSeq: String(row.prdPmoSeq), storeGbn: 'U', withOtherChannel: true
  });
  // 업체부담 0 전용 (당사 100%) — 합의 불필요
  const insNointGs100 = (cd, str, end, mm) => api('POST', '/bff/promotion/v1/management/command/promotions', [{
    aprvStCd: '', chanlCd: 'C', applyPriorRank: 1, validStrDtm: str, validEndDtm: end, noIntMmCnt: mm,
    noIntInsmFeeGsShrRt: 100, noIntInsmFeeSupShrRt: 0, rtamtCd: 'A', gshsApplyRtamt: 0, supApplyRtamt: 0,
    pmoNo: '1', prdCd: Number(cd), offerTypCd: '10', ifYn: 'Y', tgtGbnCd: 'P', aprvYn: 'Y', storeGbn: 'I', withOtherChannel: true
  }]);
  // 업체부담 > 0 — 화면 저장과 동일한 협력사 합의 요청 2건
  async function requestAgree(cd, dc, str, end, mm, sup) {
    const userId = (jwt() || {}).userId;
    const base = {
      agreeDocPmoTypCd: '30', regSubjCd: 'GS', conctNo: '1', supCd: dc.supCd, pmoAgreeDocNo: dc.agreeDocNo,
      supPrdCd: dc.supPrdCd, subSupCd: dc.subSupCd, prdCd: String(cd), validStrDtm: str, validEndDtm: end,
      stCd: '10', aprvReqrId: String(userId), applyPriorRank: '1', chanlCd: 'C', noIntMmCnt: mm, noIntInsmFeeSupShrRt: sup
    };
    const r1 = await api('PATCH', `/bff/promotion/v1/management/command/products/${cd}/promotions/requests`,
      [{ ...base, sgpayShrRtamtCd: 'A', sgpayGsShrRtamt: 0, sgpaySupShrRtamt: 0, supShrRtOverYn: 'Y', befAprvTgtYn: 'N' }]);
    if (!ok(r1)) return r1;
    return api('POST', `/bff/promotion/v1/management/command/products/${cd}/promotions/agree/types/30`,
      [{ ...base, supShrRtOverYn: 'Y', befAprvTgtYn: 'N', cpnShrRtamtCd: 'A', cpnSupShrRtamt: 0, cpnGsShrRtamt: 0 }]);
  }
  const insNoint = (cd, dc, str, end, mm, sup) =>
    sup > 0 ? requestAgree(cd, dc, str, end, mm, sup) : insNointGs100(cd, str, end, mm);

  /* ---------------- 상태 저장 (위수탁 2단계용) ---------------- */
  const loadState = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } };
  const saveState = s => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} };
  const stKey = (cd, win) => cd + '@' + win.s;

  /* ---------------- 계획 ---------------- */
  function windowOf(bs, be) {
    const s = addMin(bs, -30), e = addMin(be, 30);
    return {
      s: fmt(s), e: fmt(new Date(e.getTime() + 59000)),      // 08:55:00 ~ 12:05:59
      oldEnd: fmt(new Date(s.getTime() - 1000)),             // 08:54:59
      rs: fmt(addMin(e, 1)).replace(/:\d\d$/, ':00')         // 12:06:00
    };
  }
  function analyze(cd, d, dc, win, mmIn) {
    const cur = latestPrice(d) || {};
    const consign = isConsign(d);
    const rows = cRows(d);
    const st = loadState()[stKey(cd, win)];
    const newRow = rows.find(r => r.validStrDtm === win.s);   // 방송 구간에 이미 등록된 무이자(있으면 그 개월수가 기준)
    const mm = newRow ? newRow.noIntMmCnt : mmIn;
    const minPrc = minPriceFor(mm);                           // 이 개월수가 규정 안에 드는 최소 판매가
    const sup = supRateFor(consign, mm);
    const oldRow = rows.find(r => r.validStrDtm < win.s && r.validEndDtm >= win.s)
      || rows.find(r => r.validEndDtm === win.oldEnd);
    // 원래 가격: 저장된 값 → 없으면 기준가가 아닌 마지막 가격 → 없으면 현재 마지막 가격
    const nonMin = prices(d).filter(x => x.salePrc !== minPrc).slice(-1)[0];
    const basePrc = (st && st.prc) || (cur.salePrc === minPrc && nonMin ? nonMin.salePrc : cur.salePrc);
    const restoreRow = rows.find(r => r.validStrDtm === win.rs);
    const old = st ? st.old : (oldRow ? { mm: oldRow.noIntMmCnt, sup: oldRow.noIntInsmFeeSupShrRt || 0, end: oldRow.validEndDtm > win.s ? oldRow.validEndDtm : END } : null);
    const skip = !newRow && !st && old && old.mm >= mm ? `기존 무이자가 ${old.mm}개월(무${mm} 이상)` : '';
    return {
      cd, nm: d.promotion.prdNm, consign, cur, basePrc, oldRow, newRow, restoreRow, dc, old,
      mm, mmIn, minPrc, sup, twoStage: sup > 0, skip,
      needRaise: basePrc < minPrc, steps: basePrc < minPrc ? steps(basePrc, minPrc) : []
    };
  }

  /* ---------------- 실행: 직매입 ---------------- */
  // 한 번에 끝나는 흐름: 직매입 전체 + 위수탁 중 당사 100(3개월 이하)
  async function runDirect(a, win, log) {
    const cd = a.cd;
    if (a.newRow) { log(cd, `이미 무${a.mm} 등록됨 — 건너뜀`); return; }
    if (a.skip) { log(cd, a.skip + ' — 건너뜀'); return; }
    if (a.consign && a.old && a.old.sup > 0 && a.dc.inProgressSupplierAgree) { log(cd, '진행 중인 협력사 합의가 있음(기존 무이자 복구에 합의 필요) — 끝난 뒤 다시 실행'); return; }
    if (a.oldRow && a.oldRow.validEndDtm > win.oldEnd) {
      const r = await endNoint(a.oldRow, win.oldEnd); log(cd, `기존 무이자 ${a.oldRow.noIntMmCnt}개월 종료 → ${short(win.oldEnd)} ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    let T = null;
    if (a.needRaise) {
      T = nextFreeMinute(a);
      const r = await postPrice(cd, a.consign, fmt(T), a.minPrc, a.cur, a.dc.agreeDocNo);
      log(cd, `${a.minPrc.toLocaleString()} @${short(fmt(T))} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    // 무이자 한도는 '마지막 가격'으로 검사 → 원복 가격보다 먼저 방송중 무이자 등록
    const r10 = await insNointGs100(cd, win.s, win.e, a.mm);
    log(cd, `무${a.mm}(당사100) ${short(win.s)}~${short(win.e)} ${ok(r10) ? '완료' : '실패: ' + msg(r10)}`);
    if (a.needRaise) {
      for (let i = 0; i < a.steps.length; i++) {
        const t = fmt(addMin(T, i + 1));
        const r = await postPrice(cd, a.consign, t, a.steps[i], a.cur, a.dc.agreeDocNo);
        log(cd, `원복 ${a.steps[i].toLocaleString()} @${short(t)} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      }
    }
    if (!ok(r10)) return;
    if (a.old && !a.restoreRow) {
      const r = await insNoint(cd, a.dc, win.rs, a.old.end, a.old.mm, a.old.sup);
      log(cd, `기존 무이자 ${a.old.mm}개월 복구 ${short(win.rs)}~ ${ok(r) ? (a.old.sup > 0 ? '합의요청' : '완료') : '실패: ' + msg(r)}`, a.old.sup > 0 && ok(r));
    }
  }
  function nextFreeMinute(a) {
    const now = new Date();
    let T = new Date(now); T.setSeconds(0, 0); T = addMin(T, now.getSeconds() > 40 ? 2 : 1);
    const used = new Set(prices(a.d).map(x => x.validStrDtm));
    while (used.has(fmt(T))) T = addMin(T, 1);
    return T;
  }

  /* ---------------- 실행: 위수탁 1단계 ---------------- */
  async function runConsign1(a, win, log, raiseAt) {
    const cd = a.cd;
    if (a.newRow) { log(cd, `이미 무${a.mm} 등록(승인)됨 — 2단계로 진행하세요`); return; }
    if (a.skip) { log(cd, a.skip + ' — 건너뜀'); return; }
    if (a.dc.inProgressSupplierAgree) { log(cd, '진행 중인 협력사 합의가 있음 — 끝난 뒤 다시 실행'); return; }
    const state = loadState();
    state[stKey(cd, win)] = { prc: a.basePrc, old: a.old, mm: a.mm, at: fmt(new Date()) };
    saveState(state);
    if (a.oldRow && a.oldRow.validEndDtm > win.oldEnd) {
      const r = await endNoint(a.oldRow, win.oldEnd); log(cd, `기존 무이자 ${a.oldRow.noIntMmCnt}개월 종료 → ${short(win.oldEnd)} ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    if (a.needRaise && a.cur.salePrc !== a.minPrc) {
      const T = raiseAt > new Date() ? raiseAt : nextFreeMinute(a);
      const r = await postPrice(cd, true, fmt(T), a.minPrc, a.cur, a.dc.agreeDocNo);
      log(cd, `${a.minPrc.toLocaleString()}(업체지급 ${Math.round(a.minPrc * CONSIGN_GIV).toLocaleString()}, 마진48%) @${short(fmt(T))} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    const r = await requestAgree(cd, a.dc, win.s, win.e, a.mm, a.sup);
    log(cd, `무${a.mm}(당사${100 - a.sup}/업체${a.sup}) ${short(win.s)}~${short(win.e)} ${ok(r) ? '합의요청' : '실패: ' + msg(r)}`, ok(r));
  }

  /* ---------------- 실행: 위수탁 2단계 (합의 승인 후) ---------------- */
  async function runConsign2(a, win, log) {
    const cd = a.cd;
    if (!a.newRow) { log(cd, `무${a.mm} 아직 미승인 — 합의 후 다시 실행`); return; }
    // 가격: 아직 시작 안 한 기준가 예약은 삭제(노출 0), 이미 적용 중이면 41% 이내 n차 원복
    const all = prices(a.d);
    const fut200 = all.find(x => x.salePrc === a.minPrc && x.validStrDtm > fmt(new Date()));
    const live200 = a.cur.salePrc === a.minPrc && a.cur.validStrDtm <= fmt(new Date()) && a.basePrc < a.minPrc;
    if (fut200 && a.basePrc < a.minPrc) {
      const r = await deletePrice(cd, fut200); log(cd, `${a.minPrc.toLocaleString()} 예약(@${short(fut200.validStrDtm)}) 삭제 ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
    } else if (live200) {
      const T = nextFreeMinute(a);
      for (let i = 0; i < a.steps.length; i++) {
        const t = fmt(addMin(T, i));
        const r = await postPrice(cd, true, t, a.steps[i], a.cur, a.dc.agreeDocNo);
        log(cd, `원복 ${a.steps[i].toLocaleString()}(업체지급 ${Math.round(a.steps[i] * CONSIGN_GIV).toLocaleString()}) @${short(t)} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      }
    } else log(cd, `가격 원복 필요 없음 (현재 ${Number(a.cur.salePrc).toLocaleString()})`);
    if (a.restoreRow) { log(cd, '기존 무이자 복구 이미 등록됨'); return; }
    if (!a.old) { log(cd, '기존 무이자 정보 없음 — 복구 건너뜀(화면 확인)'); return; }
    if (a.dc.inProgressSupplierAgree) { log(cd, '진행 중인 협력사 합의가 있어 복구 합의요청 보류 — 끝난 뒤 2단계 다시 실행'); return; }
    const r = await insNoint(cd, a.dc, win.rs, a.old.end, a.old.mm, a.old.sup);
    log(cd, `기존 무이자 ${a.old.mm}개월(업체${a.old.sup}) 복구 ${short(win.rs)}~ ${ok(r) ? (a.old.sup > 0 ? '합의요청' : '완료') : '실패: ' + msg(r)}`, a.old.sup > 0 && ok(r));
  }

  /* ---------------- UI (세일즈원 자동화 UI 디자인 시스템) ---------------- */
  if (!document.getElementById('__so_font')) {
    const lk = document.createElement('link'); lk.id = '__so_font'; lk.rel = 'stylesheet';
    lk.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.appendChild(lk);
  }
  // 디자인 시스템 CSS: design/so-ui.css → scripts/inject-design.js 가 아래 표식 사이를 채운다 (직접 고치지 않는다)
  const SO_UI_CSS = /*SO-UI:BEGIN*/`:host{all:initial;--brand:#0088FF;--brand-strong:#0077E6;--brand-heavy:#0066C7;--brand-text:#0070D6;--brand-subtle:rgba(0,136,255,0.05);--brand-line:rgba(0,136,255,0.28);--brand-focus:rgba(0,136,255,0.12);--fg:#171719;--fg-secondary:rgba(46,47,51,0.88);--fg-tertiary:rgba(55,56,60,0.61);--fg-quaternary:rgba(55,56,60,0.28);--fg-disable:rgba(55,56,60,0.16);--on-brand:#FFFFFF;--bg:#FFFFFF;--bg-secondary:#F7F7F8;--surface-secondary:rgba(112,115,124,0.08);--surface-tertiary:rgba(112,115,124,0.05);--surface-disable:#F4F4F5;--line:rgba(112,115,124,0.22);--line-secondary:rgba(112,115,124,0.16);--line-tertiary:rgba(112,115,124,0.08);--positive:#00BF40;--positive-text:#006E25;--positive-surface:rgba(0,191,64,0.08);--cautionary:#FF9200;--cautionary-text:#9C5800;--cautionary-surface:rgba(255,146,0,0.08);--negative:#FF4242;--negative-text:#E52222;--negative-surface:rgba(255,66,66,0.08);--dimmer:rgba(23,23,25,0.52);--font-sans:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Consolas,monospace;--space-4:4px;--space-6:6px;--space-8:8px;--space-10:10px;--space-12:12px;--space-16:16px;--space-18:18px;--radius-5:5px;--radius-6:6px;--radius-8:8px;--radius-10:10px;--radius-12:12px;--radius-16:16px;--radius-full:9999px;--shadow-panel:0px 6px 10px -4px rgba(23,23,23,0.08),0px 16px 24px -6px rgba(23,23,23,0.08);--shadow-focus:0px 0px 0px 3px rgba(0,136,255,0.12);--panel-width:452px;--control-xs:28px;--control-sm:32px;--control-md:40px;--checkbox:20px;--z-panel:2147483000}.so-panel{font-family:var(--font-sans);color:var(--fg);width:var(--panel-width);max-height:84vh;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line-secondary);border-radius:var(--radius-16);box-shadow:var(--shadow-panel);overflow:hidden;-webkit-font-smoothing:antialiased;box-sizing:border-box}.so-panel *{box-sizing:border-box}.so-panel__head{display:flex;align-items:center;gap:var(--space-8);padding:14px 12px 14px var(--space-18);border-bottom:1px solid var(--line-tertiary);cursor:move;user-select:none}.so-panel__title{flex:1;min-width:0;font-size:17px;line-height:24px;font-weight:600}.so-panel__dot{display:inline-block;width:8px;height:8px;border-radius:var(--radius-full);background:var(--brand);margin-right:var(--space-8);vertical-align:2px}.so-panel__body{padding:var(--space-16) var(--space-18) var(--space-18);overflow:auto;display:flex;flex-direction:column;gap:var(--space-12)}.so-panel__foot{display:flex;gap:var(--space-4);justify-content:flex-end;flex-wrap:wrap}.so-chip{display:inline-flex;align-items:center;height:20px;padding:0 var(--space-6);border-radius:var(--radius-6);background:var(--brand-subtle);color:var(--brand-text);font-size:11px;line-height:14px;font-weight:600;letter-spacing:.0311em;vertical-align:2px;margin-left:var(--space-4)}.so-chip--neutral{background:var(--surface-secondary);color:var(--fg-tertiary)}.so-icon-btn{width:var(--control-sm);height:var(--control-sm);border:0;border-radius:var(--radius-10);background:transparent;color:var(--fg-tertiary);font:500 18px/1 var(--font-sans);cursor:pointer}.so-icon-btn:hover{background:var(--surface-secondary);color:var(--fg)}.so-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-4);border:0;cursor:pointer;font-family:var(--font-sans);font-weight:600;white-space:nowrap;transition:background .12s,box-shadow .12s}.so-btn--md{min-height:var(--control-md);padding:10px 16px;border-radius:var(--radius-12);font-size:14px;line-height:20px;letter-spacing:.0145em}.so-btn--sm{min-height:var(--control-sm);padding:8px 12px;border-radius:var(--radius-10);font-size:12px;line-height:16px;letter-spacing:.0252em}.so-btn--xs{min-height:var(--control-xs);padding:6px 10px;border-radius:var(--radius-8);font-size:12px;line-height:16px}.so-btn--primary{background:var(--brand);color:var(--on-brand)}.so-btn--primary:hover{background:var(--brand-strong)}.so-btn--primary:active{background:var(--brand-heavy)}.so-btn--outlined{background:var(--bg);color:var(--brand-text);box-shadow:inset 0 0 0 1px var(--line)}.so-btn--outlined:hover{background:var(--brand-subtle)}.so-btn--assistive{background:var(--surface-secondary);color:var(--fg-secondary)}.so-btn--text{background:transparent;color:var(--fg-tertiary);padding-left:var(--space-6);padding-right:var(--space-6)}.so-btn--text:hover{color:var(--fg)}.so-btn--full{width:100%}.so-btn:disabled{background:var(--surface-disable);color:var(--fg-disable);box-shadow:none;cursor:default}.so-btn:focus-visible,.so-checkbox:focus-visible{outline:none;box-shadow:var(--shadow-focus)}.so-spinner{width:14px;height:14px;border:2px solid var(--brand-line);border-top-color:var(--brand);border-radius:var(--radius-full);animation:so-spin .8s linear infinite}.so-btn--primary .so-spinner{border-color:rgba(255,255,255,.4);border-top-color:var(--on-brand)}@keyframes so-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.so-spinner{animation-duration:2.4s}}.so-checkbox{appearance:none;-webkit-appearance:none;width:var(--checkbox);height:var(--checkbox);margin:0;border-radius:var(--radius-5);box-shadow:inset 0 0 0 1.5px var(--line);background:var(--bg);cursor:pointer;display:inline-grid;place-items:center;vertical-align:middle}.so-checkbox:checked{background:var(--brand);box-shadow:none}.so-checkbox:checked::after{content:"";width:10px;height:6px;border-left:2px solid var(--on-brand);border-bottom:2px solid var(--on-brand);transform:translateY(-1px) rotate(-45deg)}.so-checkbox:disabled{background:var(--surface-disable);box-shadow:none;cursor:default}.so-steps{display:flex;gap:var(--space-4)}.so-step{flex:1;display:flex;flex-direction:column;gap:var(--space-4);font-size:11px;line-height:14px;font-weight:500;color:var(--fg-tertiary);letter-spacing:.0311em}.so-step::before{content:"";display:block;height:4px;border-radius:var(--radius-full);background:var(--surface-secondary)}.so-step--done::before{background:var(--brand-line)}.so-step--current{color:var(--brand-text)}.so-step--current::before{background:var(--brand)}.so-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-6)}.so-stat{background:var(--bg-secondary);border-radius:var(--radius-12);padding:10px 10px 9px;min-width:0}.so-stat__label{font-size:11px;line-height:14px;color:var(--fg-tertiary);font-weight:500;letter-spacing:.0311em}.so-stat__value{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.012em;font-variant-numeric:tabular-nums}.so-stat--brand .so-stat__value{color:var(--brand)}.so-msg{display:flex;gap:var(--space-10);padding:var(--space-12) 14px;border-radius:var(--radius-12);font-size:13px;line-height:18px;letter-spacing:.0194em;background:var(--surface-tertiary);color:var(--fg-secondary)}.so-msg__icon{flex:none;width:18px;height:18px;border-radius:var(--radius-full);display:grid;place-items:center;font:700 11px/1 var(--font-sans);color:var(--on-brand);background:var(--fg-tertiary)}.so-msg__body{flex:1;min-width:0}.so-msg__title{display:block;color:var(--fg);font-weight:600;margin-bottom:2px}.so-msg__actions{display:flex;gap:var(--space-6);margin-top:var(--space-10)}.so-msg--info{background:var(--brand-subtle)}.so-msg--info .so-msg__icon{background:var(--brand)}.so-msg--positive{background:var(--positive-surface)}.so-msg--positive .so-msg__icon{background:var(--positive)}.so-msg--caution{background:var(--cautionary-surface)}.so-msg--caution .so-msg__icon{background:var(--cautionary)}.so-msg--negative{background:var(--negative-surface)}.so-msg--negative .so-msg__icon{background:var(--negative)}.so-section-head{display:flex;align-items:center;gap:var(--space-6);font-size:14px;line-height:20px;font-weight:600;letter-spacing:.0145em}.so-section-head__count{color:var(--brand-text)}.so-section-head__spacer{flex:1}.so-table-wrap{border:1px solid var(--line-secondary);border-radius:var(--radius-12);overflow:auto;max-height:228px}.so-table{border-collapse:collapse;width:100%;font-size:12px;line-height:16px;letter-spacing:.0252em}.so-table th{position:sticky;top:0;background:var(--bg-secondary);color:var(--fg-tertiary);font-weight:500;text-align:left;padding:var(--space-8);border-bottom:1px solid var(--line-secondary);white-space:nowrap}.so-table td{padding:var(--space-8);border-bottom:1px solid var(--line-tertiary);vertical-align:top;color:var(--fg-secondary)}.so-table tr:last-child td{border-bottom:0}.so-table .so-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.so-table .so-sub{display:block;color:var(--fg-tertiary);font-size:11px;line-height:14px;margin-top:2px}.so-table tr.is-selected td{background:var(--brand-subtle)}.so-up{color:var(--brand-text);font-weight:600}.so-down{color:var(--negative-text);font-weight:600}.so-tag{display:inline-flex;height:20px;align-items:center;padding:0 var(--space-6);border-radius:var(--radius-6);font-size:11px;font-weight:600;white-space:nowrap}.so-tag--on{background:var(--brand-subtle);color:var(--brand-text)}.so-tag--paused{background:var(--cautionary-surface);color:var(--cautionary-text)}.so-tag--ended{background:var(--surface-secondary);color:var(--fg-tertiary)}.so-tag--error{background:var(--negative-surface);color:var(--negative-text)}.so-hint{font-size:12px;line-height:16px;color:var(--fg-tertiary);letter-spacing:.0252em}.so-log{border-top:1px solid var(--line-tertiary);padding-top:var(--space-10)}.so-log>summary{cursor:pointer;font-size:13px;line-height:18px;font-weight:600;color:var(--fg-secondary);list-style:none}.so-log>summary::-webkit-details-marker{display:none}.so-log>summary::before{content:"▸";display:inline-block;margin-right:var(--space-6);color:var(--fg-tertiary);transition:transform .15s}.so-log[open]>summary::before{transform:rotate(90deg)}.so-log__box{margin-top:var(--space-8);background:var(--bg-secondary);border-radius:var(--radius-10);padding:var(--space-10);max-height:150px;overflow:auto;font:12px/18px var(--font-mono);color:var(--fg-secondary);white-space:pre-wrap}.so-log__box .is-error{color:var(--negative-text)}.so-panel__body>*{flex-shrink:0}.so-view{display:flex;flex-direction:column;gap:var(--space-12)}.so-view:empty,.so-slot:empty{display:none}.so-row{display:flex;gap:var(--space-6);flex-wrap:wrap;align-items:center}.so-grid2{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-8)}.so-grow{flex:1;min-width:0}.so-field{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}.so-field__label{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.0252em;color:var(--fg-secondary)}.so-input,.so-textarea{width:100%;min-height:var(--control-sm);border:0;border-radius:var(--radius-10);box-shadow:inset 0 0 0 1px var(--line);background:var(--bg);color:var(--fg);padding:7px var(--space-10);font:400 13px/18px var(--font-sans);letter-spacing:.0194em;outline:none}.so-input::placeholder,.so-textarea::placeholder{color:var(--fg-quaternary)}.so-input:focus,.so-textarea:focus{box-shadow:inset 0 0 0 1px var(--brand),var(--shadow-focus)}.so-textarea{min-height:92px;resize:vertical;font-family:var(--font-mono);font-size:12px;letter-spacing:0}.so-input--date{width:108px;font-variant-numeric:tabular-nums}.so-check{display:flex;gap:var(--space-8);align-items:center;font-size:12px;line-height:16px;letter-spacing:.0252em;color:var(--fg-secondary);cursor:pointer}.so-picks{border:1px solid var(--line-secondary);border-radius:var(--radius-12);overflow:auto;max-height:228px}.so-pick{display:flex;gap:var(--space-8);padding:var(--space-8);border-bottom:1px solid var(--line-tertiary);font-size:12px;line-height:16px;letter-spacing:.0252em;color:var(--fg-secondary);cursor:pointer}.so-pick:last-child{border-bottom:0}.so-pick b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}.so-pick .so-sub{display:block;color:var(--fg-tertiary);font-size:11px;line-height:14px;margin-top:2px}.so-pick.is-off{cursor:default}.so-empty{padding:var(--space-12);font-size:12px;line-height:16px;color:var(--fg-tertiary);text-align:center}.so-msg__text{white-space:pre-wrap}.so-msg__actions{flex-wrap:wrap}.so-msg__list{margin-top:var(--space-10);padding-top:var(--space-10);border-top:1px solid var(--line-tertiary);max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:var(--space-6);font-size:12px;line-height:16px}.so-msg__pre{margin:var(--space-8) 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;font:12px/18px var(--font-mono);color:var(--fg-secondary)}`/*SO-UI:END*/;
  const el = document.createElement('div'); el.id = PANEL_ID;
  el.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483000;';
  const root = el.attachShadow({ mode: 'open' });   // 세일즈원(MUI) 스타일과 섞이지 않게 Shadow DOM 안에 그린다
  root.innerHTML = `<style>${SO_UI_CSS}</style>
<div class="so-panel">
  <div class="so-panel__head"><div class="so-panel__title"><span class="so-panel__dot"></span>${TITLE}<span class="so-chip">${VER}</span><span class="so-chip so-chip--neutral">방송중 무이자</span></div>
    <button class="so-icon-btn" id="nif-min" title="접기">–</button><button class="so-icon-btn" id="nif-x" title="닫기">×</button></div>
  <div class="so-panel__body" id="nif-body">
    <div class="so-steps" id="nif-steps"></div>
    <label class="so-field"><span class="so-field__label">상품코드 (한 줄에 하나 · 코드 뒤에 개월수를 적으면 그 상품만 다르게, 예: 1131710679 6)</span>
      <textarea class="so-textarea" id="nif-codes" placeholder="1131710679&#10;1131688507 6&#10;1131700001 3"></textarea></label>
    <div class="so-grid2" style="align-items:end">
      <label class="so-field"><span class="so-field__label">무이자 개월수 (개월수를 안 적은 상품에 적용)</span><select class="so-input" id="nif-mm"></select></label>
      <div><button class="so-btn so-btn--sm so-btn--outlined" id="nif-mmall" title="고른 개월수를 모든 상품코드 뒤에 적어 넣어요">전체 상품에 일괄 적용</button></div>
    </div>
    <div class="so-grid2">
      <label class="so-field"><span class="so-field__label">방송 시작</span><input class="so-input" id="nif-bs" placeholder="2026-11-06 09:25"></label>
      <label class="so-field"><span class="so-field__label">방송 종료</span><input class="so-input" id="nif-be" placeholder="2026-11-06 11:35"></label>
    </div>
    <label class="so-field"><span class="so-field__label">위수탁 가격 인상 적용 시각 (규정 밖일 때만 · 비우면 방송 전날 03:00)</span>
      <input class="so-input" id="nif-ra" placeholder="2026-11-05 03:00"></label>
    <div class="so-hint">무이자 구간은 방송 30분 전부터 30분 뒤까지예요. 기존 무이자는 그 1초 전에 끝내고, 끝난 다음 분부터 복구해요.<br>규정(5만↑ 3개월 · 10만↑ 9개월 · 20만↑ 12개월) 안이면 가격은 그대로 두고, 밖이면 기준가로 올린 뒤 원복해요. 위수탁은 3개월 이하 당사 100, 4개월 이상 50/50(합의)이에요.</div>
    <div class="so-row">
      <button class="so-btn so-btn--sm so-btn--outlined" id="nif-prev">① 미리보기</button>
      <button class="so-btn so-btn--sm so-btn--primary" id="nif-run1" title="직매입 전체 · 위수탁 1단계" disabled>② 실행</button>
      <button class="so-btn so-btn--sm so-btn--outlined" id="nif-run2" title="협력사 합의가 승인된 뒤" disabled>③ 위수탁 2단계</button>
    </div>
    <div class="so-hint">② 실행은 직매입 전체(위수탁 3개월 이하 포함)와 위수탁 1단계를 처리해요. ③ 위수탁 2단계는 협력사 합의가 승인된 뒤에 눌러요.</div>
    <div id="nif-ask" class="so-slot"></div>
    <div id="nif-table" class="so-view"></div>
    <div id="nif-agree" class="so-slot"></div>
    <details class="so-log" id="nif-logbox" open><summary>진행 로그</summary><div class="so-log__box" id="nif-log">상품코드와 방송시간을 넣고 ① 미리보기를 눌러주세요.</div></details>
    <div class="so-panel__foot">
      <button class="so-btn so-btn--xs so-btn--assistive" id="nif-diag" title="오류가 나면 눌러서 Claude에게 붙여넣기">진단 내용 복사</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(el);
  const $ = id => root.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('nif-x').onclick = () => el.remove();
  $('nif-min').onclick = () => { const b = $('nif-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
  (() => { // 드래그
    const h = root.querySelector('.so-panel__head'); let sx, sy, ox, oy;
    h.onmousedown = e => { if (e.target.tagName === 'BUTTON') return; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      const mv = ev => { el.style.left = ox + ev.clientX - sx + 'px'; el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; el.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); };
  })();
  for (let m = MM_MIN; m <= MM_MAX; m++) $('nif-mm').insertAdjacentHTML('beforeend', `<option value="${m}"${m === DEFAULT_MM ? ' selected' : ''}>${m}개월${m === DEFAULT_MM ? ' (기본)' : ''}</option>`);
  // 상품코드 + (선택) 개월수: "1131710679", "1131710679 6", "1131710679\t무6", "1131710679 6개월"
  const CODE_RE = /\b(1\d{9})\b(?:[ \t,:\/]*무?(\d{1,2})(?!\d)[ \t]*(?:개월)?)?/g;
  $('nif-mmall').onclick = () => {
    const mm = $('nif-mm').value;
    const cds = [...new Set([...$('nif-codes').value.matchAll(CODE_RE)].map(m => m[1]))];
    if (!cds.length) { logEl.textContent = '⚠ 상품코드를 먼저 넣어주세요'; return; }
    $('nif-codes').value = cds.map(c => c + ' ' + mm).join('\n');
    plan = null; stage = 0; renderSteps(); busy(false);
    logEl.textContent = `상품 ${cds.length}개에 무이자 ${mm}개월을 일괄 적용했어요. ① 미리보기를 눌러주세요.`;
  };
  try { const s = JSON.parse(sessionStorage.getItem('__nif_inputs') || '{}'); if (s.mm) $('nif-mm').value = s.mm; if (s.c) $('nif-codes').value = s.c; if (s.bs) $('nif-bs').value = s.bs; if (s.be) $('nif-be').value = s.be; if (s.ra) $('nif-ra').value = s.ra; } catch (e) {}

  // 단계 표시: 0 = ① 미리보기 차례, 1 = ② 실행 차례, 2 = ③ 위수탁 2단계 차례, 3 = 모두 끝
  let stage = 0;
  const renderSteps = () => {
    $('nif-steps').innerHTML = ['① 미리보기', '② 실행', '③ 위수탁 2단계'].map((t, i) =>
      `<div class="so-step ${i === stage ? 'so-step--current' : i < stage ? 'so-step--done' : ''}">${t}</div>`).join('');
  };
  renderSteps();

  // 패널 안 확인창 (되돌리기 어려운 동작은 여기서 한 번 더 묻는다. 브라우저 confirm은 쓰지 않는다)
  function ask(kind, title, body, yes, no) {
    return new Promise(res => {
      $('nif-ask').innerHTML = `<div class="so-msg so-msg--${kind}"><span class="so-msg__icon">${kind === 'info' ? '?' : '!'}</span><div class="so-msg__body"><strong class="so-msg__title">${esc(title)}</strong>${body}
        <div class="so-msg__actions"><button class="so-btn so-btn--sm so-btn--primary" id="nif-ay">${esc(yes)}</button>${no ? `<button class="so-btn so-btn--sm so-btn--assistive" id="nif-an">${esc(no)}</button>` : ''}</div></div></div>`;
      const done = v => { $('nif-ask').innerHTML = ''; res(v); };
      $('nif-ay').onclick = () => done(true);
      if ($('nif-an')) $('nif-an').onclick = () => done(false);
      $('nif-ask').scrollIntoView({ block: 'nearest' });
    });
  }

  const logEl = $('nif-log');
  let agreeList = [];
  const names = {};
  const log = (cd, text, agree) => {
    const line = `${tnow()} ${cd ? cd + ' ' + (names[cd] || '') + ' | ' : ''}${text}`;
    logEl.textContent += '\n' + line; logEl.scrollTop = logEl.scrollHeight;
    S.logs.push(line); if (S.logs.length > 200) S.logs.shift();
    if (/실패|오류|⚠/.test(text)) S.errors.push(`[${tnow()}] (${S.step}) ${cd || ''} ${text}`);
    if (agree) { agreeList.push(`${cd}\t${names[cd] || ''}\t${text.replace(/ 합의요청$/, '')}`); showAgree(); }
  };
  const showAgree = () => {
    $('nif-agree').innerHTML = agreeList.length ? `<div class="so-msg so-msg--caution"><span class="so-msg__icon">!</span><div class="so-msg__body"><strong class="so-msg__title">협력사 합의 요청이 필요해요 · ${agreeList.length}건</strong>아래 목록을 복사해서 협력사에 요청해 주세요.
      <pre class="so-msg__pre">${esc(agreeList.join('\n'))}</pre>
      <div class="so-msg__actions"><button class="so-btn so-btn--sm so-btn--assistive" id="nif-copy">합의 요청 목록 복사</button></div></div></div>` : '';
    if ($('nif-copy')) $('nif-copy').onclick = () => { navigator.clipboard.writeText(agreeList.join('\n')).then(() => { const b = $('nif-copy'); if (!b) return; b.textContent = '복사했어요'; setTimeout(() => { if ($('nif-copy')) $('nif-copy').textContent = '합의 요청 목록 복사'; }, 1200); }); };
  };

  let plan = null;
  function readInputs() {
    const defMm = +$('nif-mm').value || DEFAULT_MM;
    const map = new Map();
    for (const m of $('nif-codes').value.matchAll(CODE_RE)) {
      const mm = m[2] ? +m[2] : defMm;
      if (mm < MM_MIN || mm > MM_MAX) throw new Error(`${m[1]}: 개월수 ${mm} — ${MM_MIN}~${MM_MAX}개월만 가능합니다 (13개월 이상은 품의 대상)`);
      map.set(m[1], mm);
    }
    const codes = [...map].map(([cd, mm]) => ({ cd, mm }));
    const bs = parseDt($('nif-bs').value), be = parseDt($('nif-be').value);
    try { sessionStorage.setItem('__nif_inputs', JSON.stringify({ c: $('nif-codes').value, bs: $('nif-bs').value, be: $('nif-be').value, ra: $('nif-ra').value, mm: $('nif-mm').value })); } catch (e) {}
    if (!codes.length) throw new Error('상품코드(1로 시작하는 10자리)를 넣어주세요');
    if (!bs || !be || be <= bs) throw new Error('방송 시작/종료를 "2026-11-06 09:25" 형식으로 넣어주세요');
    let ra = parseDt($('nif-ra').value);
    if (!ra) { ra = new Date(bs); ra.setDate(ra.getDate() - 1); ra.setHours(3, 0, 0, 0); }
    return { codes, win: windowOf(bs, be), ra };
  }
  function render(list, win) {
    const okList = list.filter(a => !a.err);
    const nD = okList.filter(a => !a.consign).length, nC = okList.filter(a => a.consign).length, nE = list.length - okList.length, n10 = okList.filter(a => a.newRow).length, nR = okList.filter(a => !a.newRow && !a.skip && a.needRaise).length;
    const rows = list.map(a => {
      if (a.err) return `<tr><td>${esc(a.cd)}</td><td colspan="5"><span class="so-tag so-tag--error">오류</span> ${esc(a.err)}</td></tr>`;
      const old = a.old ? `${a.old.mm}개월 (업체${a.old.sup})` : '없음';
      const st = a.newRow ? `무${a.mm} 등록됨${a.mm !== a.mmIn ? ` (입력 ${a.mmIn}개월과 다름)` : ''}` : a.skip ? `건너뜀: ${esc(a.skip)}` : (a.twoStage ? `1단계: 무${a.mm} 합의요청` : '전체 진행');
      const pr = a.newRow || a.skip ? '' : a.needRaise ? `가격 ${a.minPrc.toLocaleString()} → ${a.steps.map(n => n.toLocaleString()).join(' → ')}` : '가격 변경 없음 (규정 내)';
      return `<tr><td>${esc(a.cd)}<span class="so-sub">${esc(a.nm)}</span></td>
        <td><span class="so-tag so-tag--${a.consign ? 'ended' : 'on'}">${a.consign ? '위수탁' : '직매입'}</span></td>
        <td class="so-num">${Number(a.cur.salePrc).toLocaleString()}</td>
        <td><b>${a.mm}개월</b><span class="so-sub">분담 ${a.sup > 0 ? `${100 - a.sup}/${a.sup} (합의)` : '100/0'}</span></td>
        <td>${old}</td>
        <td>${st}${pr ? `<span class="so-sub">${pr}</span>` : ''}</td></tr>`;
    }).join('');
    $('nif-table').innerHTML = `<div class="so-stats">
        <div class="so-stat so-stat--brand"><div class="so-stat__label">직매입</div><div class="so-stat__value">${nD}</div></div>
        <div class="so-stat so-stat--brand"><div class="so-stat__label">위수탁</div><div class="so-stat__value">${nC}</div></div>
        <div class="so-stat"><div class="so-stat__label">가격 인상</div><div class="so-stat__value">${nR}</div></div>
        <div class="so-stat"><div class="so-stat__label">등록됨</div><div class="so-stat__value">${n10}</div></div>
        <div class="so-stat"><div class="so-stat__label">오류</div><div class="so-stat__value">${nE}</div></div></div>
      <div class="so-section-head">미리보기 <span class="so-section-head__count">${list.length}</span></div>
      <div class="so-table-wrap"><table class="so-table"><tr><th>상품</th><th>형태</th><th class="so-num">현재가</th><th>방송중 무이자</th><th>기존 무이자</th><th>할 일</th></tr>${rows}</table></div>
      <div class="so-hint">방송중 무이자 ${short(win.s)} ~ ${short(win.e)} · 기존 무이자 종료 ${short(win.oldEnd)} · 복구 ${short(win.rs)}~</div>`;
  }
  async function collect(codes, win) {
    const out = [];
    for (const { cd, mm } of codes) {
      try { const { d, dc } = await loadProduct(cd); names[cd] = d.promotion.prdNm; const a = analyze(cd, d, dc, win, mm); a.d = d; out.push(a); }
      catch (e) { out.push({ cd, mmIn: mm, err: e.message }); }
    }
    return out;
  }
  const busy = b => ['nif-prev', 'nif-run1', 'nif-run2'].forEach(id => $(id).disabled = b || (id !== 'nif-prev' && !plan));

  /* ---------------- 진단 내용 복사 ---------------- */
  function buildDiag() {
    const L = [];
    const p = jwt();
    L.push(`### 세일즈원 자동화 진단: ${TITLE} ${VER}`);
    L.push(`시각: ${new Date().toLocaleString('ko-KR')}`);
    L.push(`URL: ${location.href.split('?')[0]}`);
    L.push(`브라우저: ${navigator.userAgent} / 창 ${innerWidth}x${innerHeight}`);
    L.push(`현재 단계: ${S.step} / 로그인정보: ${p ? '있음(만료 ' + Math.round((p.exp * 1000 - Date.now()) / 60000) + '분 후)' : '없음'}`);
    L.push(`입력: 상품코드 ${[...$('nif-codes').value.matchAll(CODE_RE)].map(m => m[1] + (m[2] ? '(' + m[2] + '개월)' : '')).join(',')} / 기본 개월수 ${$('nif-mm').value} / 방송 ${$('nif-bs').value} ~ ${$('nif-be').value} / 위수탁 가격 인상 적용 ${$('nif-ra').value || '(기본: 전날 03:00)'}`);
    if (plan) {
      L.push(`무이자 구간: ${plan.win.s} ~ ${plan.win.e} / 기존 종료 ${plan.win.oldEnd} / 복구 ${plan.win.rs}~`);
      L.push('\n## 미리보기 결과');
      plan.list.forEach(a => L.push(a.err ? `- ${a.cd} 오류: ${a.err}` :
        `- ${a.cd} ${a.nm} | ${a.consign ? '위수탁' : '직매입'} | 무${a.mm}(입력 ${a.mmIn}) 당사${100 - a.sup}/업체${a.sup} 기준가 ${a.minPrc}${a.skip ? ' 건너뜀:' + a.skip : ''} | 마지막가 ${a.cur.salePrc}@${a.cur.validStrDtm} | 기준가 ${a.basePrc} | 단계 ${a.steps.join('>') || '-'} | 기존무이자 ${a.old ? a.old.mm + '개월/업체' + a.old.sup + '/~' + a.old.end : '없음'} | 방송중무이자 ${a.newRow ? '있음' : '없음'} | 복구 ${a.restoreRow ? '있음' : '없음'} | 합의진행중 ${!!a.dc.inProgressSupplierAgree}`));
    }
    L.push('\n## 오류·경고 기록');
    L.push(S.errors.length ? S.errors.map(e => '- ' + e).join('\n') : '- 없음');
    L.push('\n## 세일즈원 요청 기록(쓰기·실패만)');
    L.push(S.calls.length ? S.calls.slice(-60).join('\n') : '- 없음');
    L.push('\n## 최근 로그');
    L.push(S.logs.slice(-80).join('\n') || '- 없음');
    let st = ''; try { st = localStorage.getItem(LS_KEY) || ''; } catch (e) {}
    if (st) { L.push('\n## 위수탁 2단계용 저장값'); L.push(st.slice(0, 3000)); }
    return L.join('\n');
  }
  $('nif-diag').onclick = async () => {
    const text = buildDiag();
    let done = false;
    // 권한 대기로 멈추는 경우가 있어 1.5초 안에 안 되면 예비 방식으로 복사
    try { done = await Promise.race([navigator.clipboard.writeText(text).then(() => true), sleep(1500).then(() => false)]); } catch (e) {}
    if (!done) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      try { done = document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    console.log(text);
    $('nif-logbox').open = true;
    logEl.textContent += '\n' + (done ? `📋 진단 내용을 복사했습니다(${text.length}자). Claude 대화창에 붙여넣어 주세요.` : '❗ 클립보드 복사 실패. F12 콘솔에 출력된 진단 내용을 복사해 주세요.');
    logEl.scrollTop = logEl.scrollHeight;
  };

  $('nif-prev').onclick = async () => {
    S.step = '① 미리보기';
    busy(true); logEl.textContent = '조회 중…';
    try {
      const inp = readInputs();
      if (!await ensureAuth(t => { logEl.textContent = t; })) throw new Error('로그인 정보를 못 가져왔어요 — 세일즈원에서 [조회]를 누른 뒤 ① 미리보기를 다시 눌러주세요');
      logEl.textContent = '조회 중…';
      const list = await collect(inp.codes, inp.win);
      plan = { ...inp, list };
      render(list, inp.win);
      stage = 1; renderSteps();
      const nC = list.filter(a => a.consign && !a.err).length, nD = list.filter(a => !a.consign && !a.err).length;
      logEl.textContent = `미리보기 완료: 직매입 ${nD} · 위수탁 ${nC} · 가격 인상 필요 ${list.filter(a => !a.err && !a.newRow && !a.skip && a.needRaise).length} · 오류 ${list.filter(a => a.err).length}\n내용 확인 후 ② 실행`;
    } catch (e) { logEl.textContent = '⚠ ' + e.message; S.errors.push(`[${tnow()}] (${S.step}) ${e.message}`); plan = null; stage = 0; renderSteps(); }
    busy(false);
  };
  async function runAll(stg) {
    if (!plan) return;
    const { win, ra } = plan;
    const target = plan.list.filter(a => !a.err && (stg === 1 || a.twoStage));
    if (!target.length) { logEl.textContent += '\n대상 없음'; return; }
    const body = stg === 1
      ? `${target.filter(a => !a.twoStage).length}개는 한 번에 끝까지 진행하고(직매입·위수탁 당사 100), 위수탁 ${target.filter(a => a.twoStage).length}개는 합의요청을 보내요.<br>개월수: ${[...new Set(target.map(a => a.mm))].sort((x, y) => x - y).map(m => '무' + m + ' ' + target.filter(a => a.mm === m).length + '개').join(', ')}<br>가격 인상은 ${target.filter(a => !a.newRow && !a.skip && a.needRaise).length}개예요. 한 번에 진행하는 상품의 기준가 노출은 약 1분이에요.`
      : `위수탁 ${target.length}개의 가격 원복과 기존 무이자 복구를 진행해요.<br>방송중 무이자가 승인되지 않은 상품은 자동으로 건너뛰어요.`;
    busy(true);
    if (!await ask('info', stg === 1 ? '② 실행할까요?' : '③ 위수탁 2단계를 실행할까요?', body, '실행', '취소')) { busy(false); return; }
    agreeList = []; showAgree();
    S.step = stg === 1 ? '② 실행' : '③ 위수탁 2단계';
    logEl.textContent = `${S.step} 시작`;
    try {
      if (!await ensureAuth(t => log('', t))) throw new Error('로그인 정보 만료 — 세일즈원에서 [조회]를 누른 뒤 다시 실행');
      for (const a0 of target) {
        try {
          const { d, dc } = await loadProduct(a0.cd);              // 실행 직전 최신 상태로 다시 계산
          const a = analyze(a0.cd, d, dc, win, a0.mmIn); a.d = d;
          if (stg === 1) await (a.twoStage ? runConsign1(a, win, log, ra) : runDirect(a, win, log));
          else await runConsign2(a, win, log);
        } catch (e) { log(a0.cd, '오류: ' + e.message); }
      }
      log('', '— 결과 확인 중 —');
      const list = await collect(target.map(a => ({ cd: a.cd, mm: a.mmIn })), win);
      for (const a of list) {
        if (a.err) continue;
        const last = latestPrice(a.d);
        // 위수탁 1단계(합의 대기)는 기준가 예약이 남는 게 정상
        const expected = a.twoStage && !a.newRow;
        const warn = last.salePrc === a.minPrc && a.basePrc < a.minPrc && !expected ? ` ⚠ ${a.minPrc.toLocaleString()}이 마지막 가격으로 남아 있음 — 원복 확인 필요` : '';
        log(a.cd, `최종가 ${Number(last.salePrc).toLocaleString()}${a.consign ? ' (업체지급 ' + Number(last.supGivRtamt).toLocaleString() + ')' : ''} · 무${a.mm} ${a.newRow ? '등록' : (a.twoStage ? '합의 대기' : '없음')}${warn}`);
      }
      log('', agreeList.length ? `완료 — 협력사 합의 요청 ${agreeList.length}건 (주황 상자의 [합의 요청 목록 복사])` : '완료');
      stage = Math.max(stage, stg === 1 ? 2 : 3); renderSteps();
    } catch (e) { log('', '⚠ ' + e.message); }
    busy(false);
  }
  $('nif-run1').onclick = () => runAll(1);
  $('nif-run2').onclick = () => runAll(2);
})();
