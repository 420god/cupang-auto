/* ============================================================
   00-core.js — 설정·유틸·Supabase 호출·마진 계산·로그인·앱 진입
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ============================================================
   소싱 대시보드 · 앱 로직
   ============================================================ */

const CFG = { url: '', key: '' };
const AUTH = { token: '', refresh: '', expires: 0, userId: '', email: '', isAdmin: false };

/* 단일 관리자 전용 배포 — 로그인 화면 없이 자동 로그인한다.
   publishable key는 공개돼도 되지만 비밀번호는 그대로 노출되니 다른 사용자를 들일 계획이면 제거할 것. */
const DEFAULT_SB_URL = 'https://winpzjbisxxsstmynywp.supabase.co';
const DEFAULT_SB_KEY = 'sb_publishable_AlaigI_h6rAmahLF3b7kMA_lxMJNUD1';
const ADMIN_EMAIL = 'main@gmail.com';
const ADMIN_PASSWORD = '0000';

let settings = {
  rate: 320,
  outbound: 300,
  work: 300,
  size: 'MINI'
};

const state = {
  page: 'sourcing',
  rows: [],
  offset: 0,
  limit: 40,
  loading: false,
  done: false,
  filters: {},
  search: '',
  favCatCodes: new Set(),
  userItems: {},      // item_id -> {want_price, cost_cny, ...}
  feeCache: {},       // "unit1|unit2|CAP" -> [{min_price, final_amount}]  (정가/할인가 표)
  feeCacheLow: {},    // 같은 키, 저가 상품 전용 할인가(전용할인가) 표 — 일부 카테고리만 있음
  catUnits: {},       // category_code -> {unit1, unit2}
  catStatusRows: null, // 카테고리 탭 데이터 캐시 (탭 클릭마다 재요청 방지)
  openProducts: new Set(),
  hasDeliveryCol: true // products.delivery_badges 존재 여부 (004 미실행 DB 대비, 첫 조회에서 판별)
};

/* ===================== 유틸 ===================== */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* new Intl.DateTimeFormat()은 인스턴스 생성 비용이 커서 행마다 새로 만들면
   8000여 행 기준 수백 ms가 그냥 날아간다 — 하나만 만들어 재사용한다. */
const KST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });
const kstDateStr = (d) => KST_FMT.format(d);
/* v_category_status 뷰의 status 계산 로직을 클라이언트에서 그대로 재현.
   뷰를 계속 쓰면 8000여 행마다 is_favorite용 상관 서브쿼리가 돌아 느려진다 —
   그 필드는 이제 state.favCatCodes로 대체했으니 categories 원본 테이블만 읽는다.
   today는 호출부에서 한 번만 계산해 넘긴다 (행마다 다시 계산하지 않도록). */
function catStatus(r, today) {
  if (r.last_detail_at && kstDateStr(new Date(r.last_detail_at)) === today) return 'collected';
  if (r.last_list_at && kstDateStr(new Date(r.last_list_at)) === today) return 'partial';
  if (r.last_list_at || r.last_detail_at) return 'stale';
  return 'never';
}
const num = (v) => (typeof v === 'number' && !isNaN(v)) ? v : null;
const won = (v) => num(v) === null ? '—' : v.toLocaleString() + '원';
const cnt = (v) => num(v) === null ? '—' : v.toLocaleString();

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), ms || 2200);
}

function imageUrl(path, size) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const s = size || 200;
  return `https://thumbnail6.coupangcdn.com/thumbnails/remote/${s}x${s}ex/image/` +
         String(path).replace(/^\/+/, '');
}

function productUrl(pid, iid, vid) {
  if (!pid) return '#';
  let u = 'https://www.coupang.com/vp/products/' + pid;
  const q = [];
  if (iid) q.push('itemId=' + iid);
  if (vid) q.push('vendorItemId=' + vid);
  return q.length ? u + '?' + q.join('&') : u;
}

function deliveryTag(badge) {
  if (!badge) return '<span class="dim">—</span>';
  let cls = 'tag-seller';
  if (badge.includes('프레시')) cls = 'tag-fresh';
  else if (badge.includes('판매자로켓')) cls = 'tag-merchant';
  else if (badge.includes('로켓')) cls = 'tag-rocket';
  return `<span class="tag ${cls}">${esc(badge)}</span>`;
}

/* 상품 목록의 배송 칸. products.delivery_badges에 그 상품의 옵션들에 실제로
   존재하는 배송유형이 들어 있다(DB 트리거가 채움 — db/migrations/004).
   섞여 있으면 전부 보여준다. 004를 아직 실행하지 않은 DB에서는 컬럼이 없어
   state.hasDeliveryCol이 false가 되고, 예전처럼 has_rocket으로 폴백한다. */
function deliveryCell(p) {
  const b = p.delivery_badges;
  if (Array.isArray(b) && b.length) return b.map(deliveryTag).join(' ');
  if (!state.hasDeliveryCol) {
    return p.has_rocket
      ? '<span class="tag tag-rocket">로켓</span>'
      : '<span class="tag tag-seller">일반</span>';
  }
  return '<span class="dim">—</span>';
}

function debounce(fn, ms) {
  let t;
  return function () {
    clearTimeout(t);
    const a = arguments, c = this;
    t = setTimeout(() => fn.apply(c, a), ms);
  };
}

/* debounce와 달리 타이머를 key별로 따로 관리한다.
   행이 여러 개인 표에서 하나의 공유 타이머를 쓰면 A행을 고치고 바로 B행을 고쳤을 때
   A행의 저장이 취소되고 사라진다 — key(보통 item_id)로 분리해서 막는다. */
function debounceKeyed(fn, ms) {
  const timers = {};
  return function (key, ...rest) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => { delete timers[key]; fn(key, ...rest); }, ms);
  };
}

/* ===================== Supabase ===================== */
function loadCfg() {
  CFG.url = localStorage.getItem('sb_url') || DEFAULT_SB_URL;
  CFG.key = localStorage.getItem('sb_key') || DEFAULT_SB_KEY;
  AUTH.token   = localStorage.getItem('sb_token')   || '';
  AUTH.refresh = localStorage.getItem('sb_refresh') || '';
  AUTH.expires = Number(localStorage.getItem('sb_expires') || 0);
  AUTH.email   = localStorage.getItem('sb_email')   || '';
  AUTH.userId  = localStorage.getItem('sb_uid')     || '';
}

function saveAuth() {
  localStorage.setItem('sb_token', AUTH.token);
  localStorage.setItem('sb_refresh', AUTH.refresh);
  localStorage.setItem('sb_expires', String(AUTH.expires));
  localStorage.setItem('sb_email', AUTH.email);
  localStorage.setItem('sb_uid', AUTH.userId);
}

async function authRequest(path, body) {
  const res = await fetch(`${CFG.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: CFG.key, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error_description || d.msg || d.message || '요청 실패');
  return d;
}

function applySession(d) {
  AUTH.token = d.access_token;
  AUTH.refresh = d.refresh_token;
  AUTH.expires = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
  if (d.user) { AUTH.email = d.user.email; AUTH.userId = d.user.id; }
  saveAuth();
}

async function ensureAuth() {
  if (AUTH.token && Date.now() < AUTH.expires) return;
  if (!AUTH.refresh) throw new Error('로그인이 필요합니다');
  const d = await authRequest('token?grant_type=refresh_token', { refresh_token: AUTH.refresh });
  applySession(d);
}

async function api(path, opts) {
  await ensureAuth();
  const o = opts || {};
  const res = await fetch(`${CFG.url}/rest/v1/${path}`, {
    method: o.method || 'GET',
    headers: Object.assign({
      apikey: CFG.key,
      authorization: 'Bearer ' + AUTH.token,
      'content-type': 'application/json'
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    let m = text.slice(0, 240);
    try { const j = JSON.parse(text); m = j.message || j.hint || m; } catch (e) {}
    throw new Error(`HTTP ${res.status}: ${m}`);
  }
  return text ? JSON.parse(text) : null;
}

/* Supabase 프로젝트의 Max Rows 설정(기본 1000)에 걸리지 않도록
   Range 헤더로 전체를 끝까지 페이지네이션해서 가져온다.
   첫 페이지에서 Content-Range로 전체 개수를 받아 나머지 페이지는 병렬로 요청 —
   순차로 하면 8000여 행 기준 페이지 수만큼 왕복이 생겨 느리다. */
async function apiAll(path, pageSize) {
  const size = pageSize || 1000;
  await ensureAuth();
  const headers = {
    apikey: CFG.key,
    authorization: 'Bearer ' + AUTH.token,
    'content-type': 'application/json'
  };

  async function fetchPage(offset, withCount) {
    const h = Object.assign({}, headers, { range: `${offset}-${offset + size - 1}` });
    if (withCount) h.prefer = 'count=exact';
    const res = await fetch(`${CFG.url}/rest/v1/${path}`, { headers: h });
    const text = await res.text();
    if (!res.ok) {
      let m = text.slice(0, 240);
      try { const j = JSON.parse(text); m = j.message || j.hint || m; } catch (e) {}
      throw new Error(`HTTP ${res.status}: ${m}`);
    }
    const rows = text ? JSON.parse(text) : [];
    const cr = res.headers.get('content-range'); // "0-999/8154"
    const total = (cr && cr.indexOf('/') !== -1) ? parseInt(cr.split('/')[1], 10) : null;
    return { rows, total };
  }

  const first = await fetchPage(0, true);
  let out = first.rows;

  if (first.total != null && first.total > out.length) {
    const offsets = [];
    for (let o = size; o < first.total; o += size) offsets.push(o);
    const pages = await Promise.all(offsets.map((o) => fetchPage(o, false)));
    pages.forEach((p) => { out = out.concat(p.rows); });
  } else if (first.total == null && first.rows.length === size) {
    // count 헤더를 못 받는 경우 순차 폴백
    let offset = size;
    for (;;) {
      const p = await fetchPage(offset, false);
      out = out.concat(p.rows);
      if (p.rows.length < size) break;
      offset += size;
    }
  }
  return out;
}

/* ===================== 계산 ===================== */
const LOW_ASP_PRICE_LIMIT = 14000; // 저가 상품 전용 할인 요금표 적용 상한 (docs/api-notes.md 2-4)

/* DB 컬럼 한도 안에서 넉넉히 잡은 입력 상한.
   user_items.want_price는 int(최대 약 21억), cost_cny는 numeric(10,2)(최대 99,999,999.99) —
   이 이상 입력하면 저장이 "value out of range" 400으로 매번 실패하면서 헛돌기만 한다. */
const MAX_WANT_PRICE = 2000000000;
const MAX_COST_CNY = 9999999;

function pickFeeTier(tiers, price) {
  let hit = tiers[0];
  for (const t of tiers) { if (price >= t.min_price) hit = t; else break; }
  return hit;
}

/* 항상 최종가격(할인 적용가) 기준. 14,000원 미만이고 전용할인가 표(feeCacheLow)가
   있는 카테고리면 그걸 우선 쓰고, 없으면 일반 할인가 표로 폴백한다. */
function feeFor(catCode, size, price) {
  const u = state.catUnits[catCode];
  if (!u || price == null) return null;
  const key = `${u.unit1}|${u.unit2}|${size}`;

  if (price < LOW_ASP_PRICE_LIMIT) {
    const lowTiers = state.feeCacheLow[key];
    if (lowTiers && lowTiers.length) return pickFeeTier(lowTiers, price).final_amount;
  }

  const tiers = state.feeCache[key];
  if (!tiers || !tiers.length) return null;
  return pickFeeTier(tiers, price).final_amount;
}

/* 카테고리별 실제 수수료율(db/migrations/006, WING 수수료안내 페이지 기반)만 쓴다.
   매칭 안 된 카테고리(표에 없거나 대분류 이름이 다른 경우)는 null — 전역 가정치로
   때우지 않기로 확정함(부정확한 값을 조용히 보여주는 것보다 "정보 없음"이 낫다는 판단). */
function commissionFor(catCode) {
  const u = state.catUnits[catCode];
  return (u && u.commission != null) ? u.commission : null;
}

function calcMargin(o) {
  const price = num(o.price);
  if (price === null || price <= 0) return null;

  const rate = num(o.commission);
  if (rate === null) return null; // 수수료율 정보 없음 — 호출부에서 "수수료 정보 없음"으로 표시
  const commission = Math.round(price * rate / 100);
  const fulfillment = num(o.fulfillment) ?? 0;
  const settlement = price - commission - fulfillment;

  /* costKrw가 오면 그걸 그대로 쓴다 — 발주·출고에서 확정된 **실제 매입원가**(로트 선입선출,
     db/migrations/015~019)다. 없을 때만 예전 방식(소싱 탭에 손으로 넣은 CNY 원가 x 환율)으로
     떨어진다. 두 값을 섞지 않는다: 실제 원가가 있으면 추정을 볼 이유가 없다. */
  const costKrw = (num(o.costKrw) !== null)
    ? Math.round(o.costKrw)
    : ((num(o.costCny) !== null)
        ? Math.round(o.costCny * (num(o.rate) ?? settings.rate))
        : null);

  if (costKrw === null) {
    return { commission, fulfillment, settlement, cost: null, margin: null, shipWork: null, rate: null };
  }

  const outbound = num(o.outbound) ?? settings.outbound;
  const work = num(o.work) ?? settings.work;
  const shipWork = outbound + work;
  const margin = settlement - costKrw - shipWork;

  return {
    commission, fulfillment, settlement,
    cost: costKrw, shipWork, margin,
    rate: Math.round(margin / price * 1000) / 10
  };
}

/* ===================== 로그인 ===================== */
$('#cfgSaveBtn').onclick = () => {
  const u = $('#cfgUrl').value.trim().replace(/\/+$/, '');
  const k = $('#cfgKey').value.trim();
  if (!u || !k) return showLoginMsg('URL과 키를 모두 입력하세요', true);
  if (k.includes('secret') || k.includes('service_role')) {
    return showLoginMsg('secret 키는 사용할 수 없습니다. publishable 키를 넣으세요', true);
  }
  CFG.url = u; CFG.key = k;
  localStorage.setItem('sb_url', u);
  localStorage.setItem('sb_key', k);
  showLoginMsg('설정을 저장했습니다', false);
};

function showLoginMsg(msg, isErr) {
  const el = $('#loginMsg');
  el.textContent = msg;
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
}

$('#loginBtn').onclick = async () => {
  try {
    if (!CFG.url || !CFG.key) return showLoginMsg('먼저 서버 설정을 입력하세요', true);
    showLoginMsg('로그인 중…', false);
    const d = await authRequest('token?grant_type=password', {
      email: $('#loginEmail').value.trim(),
      password: $('#loginPassword').value
    });
    applySession(d);
    $('#loginPassword').value = '';
    await enterApp();
  } catch (e) {
    showLoginMsg(e.message, true);
  }
};

$('#signupBtn').onclick = async () => {
  try {
    if (!CFG.url || !CFG.key) return showLoginMsg('먼저 서버 설정을 입력하세요', true);
    const email = $('#loginEmail').value.trim();
    const pw = $('#loginPassword').value;
    if (!email || !pw) return showLoginMsg('이메일과 비밀번호를 입력하세요', true);
    showLoginMsg('가입 중…', false);
    await authRequest('signup', { email, password: pw });
    showLoginMsg('가입되었습니다. 로그인해주세요.', false);
  } catch (e) {
    showLoginMsg(e.message.includes('초대') ? e.message : '가입 실패: ' + e.message, true);
  }
};

$('#logoutBtn').onclick = () => {
  AUTH.token = AUTH.refresh = ''; AUTH.expires = 0;
  saveAuth();
  location.reload();
};

/* ===================== 앱 진입 ===================== */
async function enterApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');

  $('#userEmail').textContent = AUTH.email;
  $('#userAvatar').textContent = (AUTH.email[0] || '?').toUpperCase();

  /* 상품 목록(resetAndLoad)은 설정·카테고리·즐겨찾기와 무관하게 그릴 수 있으므로
     그것들을 기다리지 않고 바로 시작한다 — 이전엔 순서대로 기다리느라 로딩이 길었다.
     margin 계산(loadRowMargins)만 settings/feeCache/카테고리별 수수료율이 필요해서
     별도로 대기시킨다. loadCategoryOptions()가 채우는 state.catUnits[].commission을
     commissionFor()가 쓰기 시작하면서(2026-08-13) 이것도 꼭 여기 포함돼야 한다 —
     빠지면 첫 페이지가 카테고리 로딩보다 먼저 계산돼서 전부 "수수료 정보 없음"으로
     굳어버리고 다시 계산되지 않는다(실제로 겪은 버그). */
  state.readyForMargins = Promise.all([loadSettings(), loadFeeTables(), loadCategoryOptions()]);
  resetAndLoad();

  loadFavCategories();

  try {
    const prof = await api('profiles?select=is_admin,prefs');
    if (prof && prof[0]) {
      AUTH.isAdmin = !!prof[0].is_admin;
      $('#userRole').textContent = AUTH.isAdmin ? '관리자' : '일반 회원';
      if (prof[0].prefs && Object.keys(prof[0].prefs).length) {
        Object.assign(settings, prof[0].prefs);
      }
    }
  } catch (e) { /* 무시 */ }

  /* 앱에 들어왔다고 알린다. 지표 자동 동기화가 이걸 듣는다(web/js/90-boot.js).
     여기서 직접 부르지 않는 이유: 00-core.js는 90-boot.js보다 먼저 로드되므로
     그쪽 함수를 이 시점에 부르면 아직 정의 전일 수 있다(D-17 — 파일 순서가 곧 실행 순서). */
  try { window.dispatchEvent(new Event('cwc-app-ready')); } catch (e) { /* 무시 */ }
}

async function loadSettings() {
  try {
    const rows = await api('settings?select=key,value');
    (rows || []).forEach((r) => {
      if (r.key === 'exchange_rate') settings.rate = r.value.cny_krw ?? settings.rate;
      if (r.key === 'default_costs') {
        settings.outbound = r.value.outbound_fee ?? settings.outbound;
        settings.work = r.value.work_fee ?? settings.work;
      }
    });
  } catch (e) { /* 기본값 사용 */ }
}

async function loadFeeTables() {
  try {
    const rows = await apiAll('fulfillment_fees?select=unit1,unit2,capacity_type,min_price,final_amount,is_low_asp&order=min_price');
    (rows || []).forEach((r) => {
      const k = `${r.unit1}|${r.unit2}|${r.capacity_type}`;
      const bucket = r.is_low_asp ? state.feeCacheLow : state.feeCache;
      (bucket[k] = bucket[k] || []).push(r);
    });
    Object.values(state.feeCache).forEach((a) => a.sort((x, y) => x.min_price - y.min_price));
    Object.values(state.feeCacheLow).forEach((a) => a.sort((x, y) => x.min_price - y.min_price));
  } catch (e) { /* 요금표 없으면 입출고비 0 */ }
}

/* 카테고리가 8000여 개라 <option>을 하나씩 createElement+appendChild 하면
   그때마다 레이아웃이 걸려 눈에 띄게 버벅인다 — 문자열로 만들어 한 번에 넣는다.
   full_path는 정렬에만 쓰이고 화면에는 안 쓰므로 select 목록에서 뺐다(전송량 감소). */
async function loadCategoryOptions() {
  try {
    const rows = await apiAll('categories?select=category_code,name,root_name,unit1,unit2,commission_rate&order=full_path');
    const roots = new Set();
    const opts = new Array(rows ? rows.length : 0);
    (rows || []).forEach((c, i) => {
      if (c.root_name) roots.add(c.root_name);
      state.catUnits[c.category_code] = { unit1: c.unit1, unit2: c.unit2, commission: c.commission_rate };
      opts[i] = `<option value="${esc(c.category_code)}">${esc(c.name || c.category_code)}</option>`;
    });
    $('#fCategory').insertAdjacentHTML('beforeend', opts.join(''));
    $('#fRoot').insertAdjacentHTML('beforeend',
      Array.from(roots).sort().map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join(''));
  } catch (e) { /* 무시 */ }
}

async function loadFavCategories() {
  try {
    const rows = await api('user_category_favorites?select=category_code');
    state.favCatCodes = new Set((rows || []).map((r) => r.category_code));
  } catch (e) { /* 무시 */ }
}
