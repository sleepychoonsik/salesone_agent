/* =========================================================================
 * [세일즈원 자동화] 장기무이자(무10) 세팅 v1.0.2
 *  - 상품조회/수정 > 가격/프로모션 기능을 세일즈원 API로 처리 (화면과 동일한 요청)
 *  - 직매입 : 기존 무이자 종료 → 200,000 → 무10(당사100) → 가격 원복 → 기존 무이자 복구
 *  - 위수탁 : [1단계] 기존 무이자 종료 → 200,000 예약 → 무10(당사50/업체50) 합의요청
 *             [2단계: 합의 승인 후] 가격 원복(마진48%) → 기존 무이자 복구(업체부담>0이면 합의요청)
 *  - 업체부담 > 0 인 무이자는 반드시 협력사 합의 요청으로만 등록 (직접 등록 금지)
 *  - 문제가 생기면 패널의 [진단 내용 복사]로 버전·단계·오류·URL·API 기록·로그를 복사해 Claude에게 붙여넣는다.
 * ========================================================================= */
(async () => {
  'use strict';
  const TITLE = '장기무이자 세팅 자동화';
  const VER = 'v1.0.2';
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
  const NOINT_MM = 10;
  const MIN_PRICE = 200000;
  const MAX_DROP = 0.41;      // 업체지급액 기준 1회 최대 하락률
  const CONSIGN_GIV = 0.52;   // 위수탁 업체지급율 (마진 48%)
  const NOINT_SUP_CONSIGN = 50; // 위수탁 무10 업체부담율

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
  function steps(target) {
    const s = []; let cur = MIN_PRICE;
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
  function analyze(cd, d, dc, win) {
    const cur = latestPrice(d) || {};
    const consign = isConsign(d);
    const rows = cRows(d);
    const has10 = rows.find(r => r.noIntMmCnt === NOINT_MM && r.validStrDtm === win.s);
    const st = loadState()[stKey(cd, win)];
    const oldRow = rows.find(r => r.noIntMmCnt !== NOINT_MM && r.validStrDtm < win.s && r.validEndDtm >= win.s)
      || rows.find(r => r.noIntMmCnt !== NOINT_MM && r.validEndDtm === win.oldEnd);
    // 원래 가격: 저장된 값 → 없으면 200,000이 아닌 마지막 가격 → 없으면 현재 마지막 가격
    const non200 = prices(d).filter(x => x.salePrc !== MIN_PRICE).slice(-1)[0];
    const basePrc = (st && st.prc) || (cur.salePrc === MIN_PRICE && non200 ? non200.salePrc : cur.salePrc);
    const restoreRow = rows.find(r => r.noIntMmCnt !== NOINT_MM && r.validStrDtm === win.rs);
    return {
      cd, nm: d.promotion.prdNm, consign, cur, basePrc, oldRow, has10, restoreRow, dc,
      needRaise: basePrc < MIN_PRICE, steps: basePrc < MIN_PRICE ? steps(basePrc) : [],
      old: st ? st.old : (oldRow ? { mm: oldRow.noIntMmCnt, sup: oldRow.noIntInsmFeeSupShrRt || 0, end: oldRow.validEndDtm > win.s ? oldRow.validEndDtm : END } : null)
    };
  }

  /* ---------------- 실행: 직매입 ---------------- */
  async function runDirect(a, win, log) {
    const cd = a.cd;
    if (a.has10) { log(cd, '이미 무10 등록됨 — 건너뜀'); return; }
    if (a.oldRow && a.oldRow.validEndDtm > win.oldEnd) {
      const r = await endNoint(a.oldRow, win.oldEnd); log(cd, `기존 무이자 ${a.oldRow.noIntMmCnt}개월 종료 → ${short(win.oldEnd)} ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    let T = null;
    if (a.needRaise) {
      T = nextFreeMinute(a);
      const r = await postPrice(cd, false, fmt(T), MIN_PRICE, a.cur, a.dc.agreeDocNo);
      log(cd, `200,000 @${short(fmt(T))} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    // 무이자 한도는 '마지막 가격'으로 검사 → 원복 가격보다 먼저 무10 등록
    const r10 = await insNointGs100(cd, win.s, win.e, NOINT_MM);
    log(cd, `무10(당사100) ${short(win.s)}~${short(win.e)} ${ok(r10) ? '완료' : '실패: ' + msg(r10)}`);
    if (a.needRaise) {
      for (let i = 0; i < a.steps.length; i++) {
        const t = fmt(addMin(T, i + 1));
        const r = await postPrice(cd, false, t, a.steps[i], a.cur, a.dc.agreeDocNo);
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
    if (a.has10) { log(cd, '이미 무10 등록(승인)됨 — 2단계로 진행하세요'); return; }
    if (a.dc.inProgressSupplierAgree) { log(cd, '진행 중인 협력사 합의가 있음 — 끝난 뒤 다시 실행'); return; }
    const state = loadState();
    state[stKey(cd, win)] = { prc: a.basePrc, old: a.old, at: fmt(new Date()) };
    saveState(state);
    if (a.oldRow && a.oldRow.validEndDtm > win.oldEnd) {
      const r = await endNoint(a.oldRow, win.oldEnd); log(cd, `기존 무이자 ${a.oldRow.noIntMmCnt}개월 종료 → ${short(win.oldEnd)} ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    if (a.needRaise && a.cur.salePrc !== MIN_PRICE) {
      const T = raiseAt > new Date() ? raiseAt : nextFreeMinute(a);
      const r = await postPrice(cd, true, fmt(T), MIN_PRICE, a.cur, a.dc.agreeDocNo);
      log(cd, `200,000(업체지급 ${Math.round(MIN_PRICE * CONSIGN_GIV).toLocaleString()}, 마진48%) @${short(fmt(T))} ${ok(r) ? '예약' : '실패: ' + msg(r)}`);
      if (!ok(r)) return;
    }
    const r = await requestAgree(cd, a.dc, win.s, win.e, NOINT_MM, NOINT_SUP_CONSIGN);
    log(cd, `무10(당사50/업체50) ${short(win.s)}~${short(win.e)} ${ok(r) ? '합의요청' : '실패: ' + msg(r)}`, ok(r));
  }

  /* ---------------- 실행: 위수탁 2단계 (합의 승인 후) ---------------- */
  async function runConsign2(a, win, log) {
    const cd = a.cd;
    if (!a.has10) { log(cd, '무10 아직 미승인 — 합의 후 다시 실행'); return; }
    // 가격: 아직 시작 안 한 200,000 예약은 삭제(노출 0), 이미 적용 중이면 41% 이내 n차 원복
    const all = prices(a.d);
    const fut200 = all.find(x => x.salePrc === MIN_PRICE && x.validStrDtm > fmt(new Date()));
    const live200 = a.cur.salePrc === MIN_PRICE && a.cur.validStrDtm <= fmt(new Date()) && a.basePrc < MIN_PRICE;
    if (fut200 && a.basePrc < MIN_PRICE) {
      const r = await deletePrice(cd, fut200); log(cd, `200,000 예약(@${short(fut200.validStrDtm)}) 삭제 ${ok(r) ? '완료' : '실패: ' + msg(r)}`);
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

  /* ---------------- UI ---------------- */
  const css = `
#${PANEL_ID}{position:fixed;top:70px;right:20px;width:560px;max-height:84vh;z-index:2147483000;background:#fff;border:1px solid #cfd6d2;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.45 'Pretendard','Malgun Gothic',sans-serif;color:#222;display:flex;flex-direction:column}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .h{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1f8f5f;color:#fff;border-radius:10px 10px 0 0;cursor:move}
#${PANEL_ID} .h b{font-size:14px}#${PANEL_ID} .x{background:none;border:0;color:#fff;font-size:18px;cursor:pointer}
#${PANEL_ID} .b{padding:12px 14px;overflow:auto}
#${PANEL_ID} label{display:block;font-weight:600;margin:8px 0 4px}
#${PANEL_ID} textarea,#${PANEL_ID} input{width:100%;border:1px solid #cfd6d2;border-radius:6px;padding:6px 8px;font:inherit}
#${PANEL_ID} textarea{height:110px;font-family:Consolas,monospace}
#${PANEL_ID} .row{display:flex;gap:8px}#${PANEL_ID} .row>div{flex:1}
#${PANEL_ID} .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
#${PANEL_ID} button.a{border:1px solid #1f8f5f;background:#fff;color:#1f8f5f;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600}
#${PANEL_ID} button.a.p{background:#1f8f5f;color:#fff}#${PANEL_ID} button.a:disabled{opacity:.4;cursor:default}
#${PANEL_ID} table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
#${PANEL_ID} th,#${PANEL_ID} td{border:1px solid #e2e6e4;padding:4px 6px;text-align:left;vertical-align:top}
#${PANEL_ID} th{background:#f3f6f4}
#${PANEL_ID} .log{margin-top:10px;background:#f7f8f7;border:1px solid #e2e6e4;border-radius:6px;padding:8px;max-height:220px;overflow:auto;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap}
#${PANEL_ID} .agree{margin-top:10px;border:1px solid #f0b400;background:#fffaf0;border-radius:6px;padding:8px;display:none}
#${PANEL_ID} .hint{color:#777;font-size:12px;margin-top:4px}`;
  const style = document.createElement('style'); style.textContent = css;
  const el = document.createElement('div'); el.id = PANEL_ID; el.appendChild(style);
  el.insertAdjacentHTML('beforeend', `
<div class="h"><b>${TITLE} <small>${VER}</small></b><button class="x" title="닫기">×</button></div>
<div class="b">
  <label>상품코드 (한 줄에 하나, 직매입/위수탁은 자동 판별)</label>
  <textarea id="nif-codes" placeholder="1131710679&#10;1131688507"></textarea>
  <div class="row">
    <div><label>방송 시작</label><input id="nif-bs" placeholder="2026-11-06 09:25"></div>
    <div><label>방송 종료</label><input id="nif-be" placeholder="2026-11-06 11:35"></div>
  </div>
  <label>위수탁 200,000 적용 시각 (1단계, 비우면 방송 전날 03:00)</label>
  <input id="nif-ra" placeholder="2026-11-05 03:00">
  <div class="hint">무10 구간 = 방송 -30분 ~ +30분 · 기존 무이자는 그 1초 전 종료, 끝난 다음 분부터 복구 · 위수탁 가격은 마진 48%</div>
  <div class="btns">
    <button class="a" id="nif-prev">① 미리보기</button>
    <button class="a p" id="nif-run1" disabled>② 실행 (직매입 전체 · 위수탁 1단계)</button>
    <button class="a" id="nif-run2" disabled>③ 위수탁 2단계 (합의 승인 후)</button>
    <button class="a" id="nif-diag" title="오류가 나면 눌러서 Claude에게 붙여넣기">진단 내용 복사</button>
  </div>
  <div id="nif-table"></div>
  <div class="agree" id="nif-agree"><b>협력사 합의 요청 필요</b> <button class="a" id="nif-copy" style="padding:2px 8px;margin-left:6px">복사</button><pre id="nif-agree-list" style="margin:6px 0 0;white-space:pre-wrap"></pre></div>
  <div class="log" id="nif-log">상품코드와 방송시간을 넣고 ① 미리보기를 눌러주세요.</div>
</div>`);
  document.body.appendChild(el);
  const $ = id => el.querySelector('#' + id);
  el.querySelector('.x').onclick = () => el.remove();
  (() => { // 드래그
    const h = el.querySelector('.h'); let sx, sy, ox, oy;
    h.onmousedown = e => { if (e.target.tagName === 'BUTTON') return; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      const mv = ev => { el.style.left = ox + ev.clientX - sx + 'px'; el.style.top = oy + ev.clientY - sy + 'px'; el.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); };
  })();
  try { const s = JSON.parse(sessionStorage.getItem('__nif_inputs') || '{}'); if (s.c) $('nif-codes').value = s.c; if (s.bs) $('nif-bs').value = s.bs; if (s.be) $('nif-be').value = s.be; if (s.ra) $('nif-ra').value = s.ra; } catch (e) {}

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
  const showAgree = () => { $('nif-agree').style.display = agreeList.length ? 'block' : 'none'; $('nif-agree-list').textContent = agreeList.join('\n'); };
  $('nif-copy').onclick = () => { navigator.clipboard.writeText(agreeList.join('\n')).then(() => { $('nif-copy').textContent = '복사됨'; setTimeout(() => $('nif-copy').textContent = '복사', 1200); }); };

  let plan = null;
  function readInputs() {
    const codes = [...new Set(($('nif-codes').value.match(/\b1\d{9}\b/g) || []))];
    const bs = parseDt($('nif-bs').value), be = parseDt($('nif-be').value);
    try { sessionStorage.setItem('__nif_inputs', JSON.stringify({ c: $('nif-codes').value, bs: $('nif-bs').value, be: $('nif-be').value, ra: $('nif-ra').value })); } catch (e) {}
    if (!codes.length) throw new Error('상품코드(1로 시작하는 10자리)를 넣어주세요');
    if (!bs || !be || be <= bs) throw new Error('방송 시작/종료를 "2026-11-06 09:25" 형식으로 넣어주세요');
    let ra = parseDt($('nif-ra').value);
    if (!ra) { ra = new Date(bs); ra.setDate(ra.getDate() - 1); ra.setHours(3, 0, 0, 0); }
    return { codes, win: windowOf(bs, be), ra };
  }
  function render(list, win) {
    const rows = list.map(a => {
      if (a.err) return `<tr><td>${a.cd}</td><td colspan="6" style="color:#c00">${a.err}</td></tr>`;
      const old = a.old ? `${a.old.mm}개월 (업체${a.old.sup})` : '없음';
      const st = a.has10 ? '무10 등록됨' : (a.consign ? '1단계: 무10 합의요청' : '전체 진행');
      const pr = a.has10 ? '-' : a.needRaise ? `200,000 → ${a.steps.map(n => n.toLocaleString()).join(' → ')}` : `변경 없음 (${Number(a.basePrc).toLocaleString()})`;
      return `<tr><td>${a.cd}<br><small>${a.nm}</small></td><td>${a.consign ? '위수탁' : '직매입'}</td><td>${Number(a.cur.salePrc).toLocaleString()}</td><td>${old}</td><td>${pr}</td><td>${a.consign ? '50/50 (합의)' : '100/0'}</td><td>${st}</td></tr>`;
    }).join('');
    $('nif-table').innerHTML = `<table><tr><th>상품</th><th>형태</th><th>현재가</th><th>기존 무이자</th><th>가격</th><th>무10 당사/업체</th><th>할 일</th></tr>${rows}</table>
<div class="hint">무10 ${short(win.s)} ~ ${short(win.e)} · 기존 종료 ${short(win.oldEnd)} · 복구 ${short(win.rs)}~</div>`;
  }
  async function collect(codes, win) {
    const out = [];
    for (const cd of codes) {
      try { const { d, dc } = await loadProduct(cd); names[cd] = d.promotion.prdNm; const a = analyze(cd, d, dc, win); a.d = d; out.push(a); }
      catch (e) { out.push({ cd, err: e.message }); }
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
    L.push(`입력: 상품코드 ${($('nif-codes').value.match(/\b1\d{9}\b/g) || []).join(',')} / 방송 ${$('nif-bs').value} ~ ${$('nif-be').value} / 위수탁 200,000 적용 ${$('nif-ra').value || '(기본: 전날 03:00)'}`);
    if (plan) {
      L.push(`무10 구간: ${plan.win.s} ~ ${plan.win.e} / 기존 종료 ${plan.win.oldEnd} / 복구 ${plan.win.rs}~`);
      L.push('\n## 미리보기 결과');
      plan.list.forEach(a => L.push(a.err ? `- ${a.cd} 오류: ${a.err}` :
        `- ${a.cd} ${a.nm} | ${a.consign ? '위수탁' : '직매입'} | 마지막가 ${a.cur.salePrc}@${a.cur.validStrDtm} | 기준가 ${a.basePrc} | 단계 ${a.steps.join('>') || '-'} | 기존무이자 ${a.old ? a.old.mm + '개월/업체' + a.old.sup + '/~' + a.old.end : '없음'} | 무10 ${a.has10 ? '있음' : '없음'} | 복구 ${a.restoreRow ? '있음' : '없음'} | 합의진행중 ${!!a.dc.inProgressSupplierAgree}`));
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
      const nC = list.filter(a => a.consign && !a.err).length, nD = list.filter(a => !a.consign && !a.err).length;
      logEl.textContent = `미리보기 완료: 직매입 ${nD} · 위수탁 ${nC} · 오류 ${list.filter(a => a.err).length}\n내용 확인 후 ② 실행`;
    } catch (e) { logEl.textContent = '⚠ ' + e.message; S.errors.push(`[${tnow()}] (${S.step}) ${e.message}`); plan = null; }
    busy(false);
  };
  async function runAll(stage) {
    if (!plan) return;
    const { win, ra } = plan;
    const target = plan.list.filter(a => !a.err && (stage === 1 || a.consign));
    if (!target.length) { logEl.textContent += '\n대상 없음'; return; }
    const msgTxt = stage === 1
      ? `직매입 ${target.filter(a => !a.consign).length}개 전체 진행 + 위수탁 ${target.filter(a => a.consign).length}개 무10 합의요청을 실행할까요?\n(직매입 20만 원 노출은 상품당 약 1분)`
      : `위수탁 ${target.length}개 2단계(가격 원복 + 기존 무이자 복구)를 실행할까요?\n무10 미승인 상품은 자동으로 건너뜁니다.`;
    if (!confirm('[' + TITLE + ']\n' + msgTxt)) return;
    busy(true); agreeList = []; showAgree();
    S.step = stage === 1 ? '② 실행' : '③ 위수탁 2단계';
    logEl.textContent = `${S.step} 시작`;
    try {
      if (!await ensureAuth(t => log('', t))) throw new Error('로그인 정보 만료 — 세일즈원에서 [조회]를 누른 뒤 다시 실행');
      for (const a0 of target) {
        try {
          const { d, dc } = await loadProduct(a0.cd);              // 실행 직전 최신 상태로 다시 계산
          const a = analyze(a0.cd, d, dc, win); a.d = d;
          if (stage === 1) await (a.consign ? runConsign1(a, win, log, ra) : runDirect(a, win, log));
          else await runConsign2(a, win, log);
        } catch (e) { log(a0.cd, '오류: ' + e.message); }
      }
      log('', '— 결과 확인 중 —');
      const list = await collect(target.map(a => a.cd), win);
      for (const a of list) {
        if (a.err) continue;
        const last = latestPrice(a.d);
        // 위수탁 1단계(합의 대기)는 200,000 예약이 남는 게 정상
        const expected = a.consign && !a.has10;
        const warn = last.salePrc === MIN_PRICE && a.basePrc < MIN_PRICE && !expected ? ' ⚠ 200,000이 마지막 가격으로 남아 있음 — 원복 확인 필요' : '';
        log(a.cd, `최종가 ${Number(last.salePrc).toLocaleString()}${a.consign ? ' (업체지급 ' + Number(last.supGivRtamt).toLocaleString() + ')' : ''} · 무10 ${a.has10 ? '등록' : (a.consign ? '합의 대기' : '없음')}${warn}`);
      }
      log('', agreeList.length ? `완료 — 협력사 합의 요청 ${agreeList.length}건 (노란 상자 복사)` : '완료');
    } catch (e) { log('', '⚠ ' + e.message); }
    busy(false);
  }
  $('nif-run1').onclick = () => runAll(1);
  $('nif-run2').onclick = () => runAll(2);
})();
