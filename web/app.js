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

/* ===================== 소싱 목록 ===================== */
function buildQuery() {
  const f = state.filters;
  const parts = [
    'select=product_id,product_name,brand_name,category_code,category_path,rep_image_path,' +
    'max_sales,sum_sales,min_price,max_price,option_count,has_rocket,pv_rank,pv_lower,pv_upper' +
    (state.hasDeliveryCol ? ',delivery_badges' : ''),
    'is_active=eq.true'
  ];

  if (state.search) parts.push(`product_name=ilike.*${encodeURIComponent(state.search)}*`);
  if (f.category)   parts.push(`category_code=eq.${f.category}`);
  if (f.root)       parts.push(`category_path=ilike.${encodeURIComponent(f.root)}*`);
  if (f.priceMin)   parts.push(`min_price=gte.${f.priceMin}`);
  if (f.priceMax)   parts.push(`min_price=lte.${f.priceMax}`);
  if (f.salesMin)   parts.push(`max_sales=gte.${f.salesMin}`);
  if (f.salesMax)   parts.push(`max_sales=lte.${f.salesMax}`);
  /* 옵션 중 하나라도 그 배송유형이면 걸린다 (배열 포함 검색, GIN 인덱스 사용) */
  if (f.delivery && state.hasDeliveryCol) {
    parts.push('delivery_badges=cs.' + encodeURIComponent(`{"${f.delivery}"}`));
  }

  if (f.favCatOnly && state.favCatCodes.size) {
    parts.push(`category_code=in.(${Array.from(state.favCatCodes).join(',')})`);
  }

  const sort = f.sort || 'max_sales';
  parts.push(`order=${sort}.${sort === 'min_price' || sort === 'pv_rank' ? 'asc' : 'desc'}.nullslast`);
  parts.push(`limit=${state.limit}`);
  parts.push(`offset=${state.offset}`);

  return 'products?' + parts.join('&');
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  $('#sourcingLoader').classList.remove('hidden');

  try {
    let rows;
    try {
      rows = await api(buildQuery());
    } catch (err) {
      /* 004 마이그레이션 전 DB에는 delivery_badges 컬럼이 없다 —
         한 번만 감지해서 예전 방식(has_rocket)으로 되돌리고 다시 시도한다. */
      if (state.hasDeliveryCol && /delivery_badges/.test(err.message)) {
        state.hasDeliveryCol = false;
        rows = await api(buildQuery());
      } else throw err;
    }
    if (!rows || rows.length < state.limit) state.done = true;

    if (rows && rows.length) {
      state.rows.push(...rows);
      renderRows(rows);
      state.offset += rows.length;
      loadRowMargins(rows);
    }

    $('#sourcingCount').textContent = `${state.rows.length}개 상품` + (state.done ? '' : ' (스크롤하면 더 불러옵니다)');
    $('#sourcingEmpty').classList.toggle('hidden', state.rows.length > 0);
    $('#sourcingEnd').classList.toggle('hidden', !(state.done && state.rows.length > 0));
  } catch (e) {
    toast('불러오기 실패: ' + e.message, 4000);
  } finally {
    state.loading = false;
    $('#sourcingLoader').classList.add('hidden');
  }
}

function resetAndLoad() {
  state.rows = []; state.offset = 0; state.done = false;
  state.openProducts.clear();
  $('#sourcingBody').innerHTML = '';
  $('#sourcingEnd').classList.add('hidden');
  loadMore();
}

function renderRows(rows) {
  const tb = $('#sourcingBody');
  const html = rows.map((p) => {
    const root = (p.category_path || '').split('>')[0] || '—';
    const leaf = (p.category_path || '').split('>').pop() || '—';
    const priceTxt = (p.min_price === p.max_price)
      ? won(p.min_price)
      : `${won(p.min_price)}~`;
    const pv = (p.pv_lower || p.pv_upper)
      ? `${p.pv_lower ? p.pv_lower.toLocaleString() : ''}~${p.pv_upper ? p.pv_upper.toLocaleString() : ''}`
      : '—';

    return `
<tr class="prow" data-pid="${esc(p.product_id)}" data-cat="${esc(p.category_code || '')}">
  <td class="col-img">
    <img class="thumb" loading="lazy" src="${esc(imageUrl(p.rep_image_path, 120))}" alt="" onerror="this.style.visibility='hidden'" />
  </td>
  <td class="col-name">
    <div class="pname">
      <svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      <span>${esc(p.product_name || '(이름 없음)')}</span>
    </div>
    <div class="psub">${esc(p.brand_name || '')} · 옵션 ${p.option_count || 0}개</div>
  </td>
  <td class="col-num" data-label="판매량">${cnt(p.max_sales)}</td>
  <td class="col-num" data-label="가격">${priceTxt}</td>
  <td class="col-num" data-label="조회수">${pv}</td>
  <td class="col-num margin-rate" data-label="마진율"><span class="dim">—</span></td>
  <td class="col-num margin-amt"  data-label="마진액"><span class="dim">—</span></td>
  <td class="col-delivery" data-label="배송">${deliveryCell(p)}</td>
  <td class="col-mid" data-label="대분류">${esc(root)}</td>
  <td class="col-mid" data-label="말단">${esc(leaf)}</td>
  <td class="col-fav"></td>
</tr>
<tr class="detail hidden" data-detail="${esc(p.product_id)}"><td colspan="11"><div class="detail-inner">불러오는 중…</div></td></tr>`;
  }).join('');

  tb.insertAdjacentHTML('beforeend', html);
}

/* 클릭(옵션 펼치기) 없이도 이미 입력해 둔 원가로 상품 목록에 최고 마진율을 채운다 */
async function loadRowMargins(rows) {
  const pids = rows.map((p) => p.product_id).filter(Boolean);
  if (!pids.length) return;

  try {
    const [, costedRaw] = await Promise.all([
      state.readyForMargins,
      api(
        'user_items?select=item_id,product_id,cost_cny,want_price,exchange_rate,outbound_fee,work_fee' +
        `&product_id=in.(${pids.map(encodeURIComponent).join(',')})&cost_cny=not.is.null`
      )
    ]);
    const costed = costedRaw || [];
    if (!costed.length) return;

    costed.forEach((u) => { state.userItems[u.item_id] = Object.assign(state.userItems[u.item_id] || {}, u); });

    const needPrice = costed.filter((u) => u.want_price == null).map((u) => u.item_id);
    const priceMap = {};
    if (needPrice.length) {
      const items = await api(
        `product_items?select=item_id,current_price&item_id=in.(${needPrice.map(encodeURIComponent).join(',')})`
      ) || [];
      items.forEach((it) => { priceMap[it.item_id] = it.current_price; });
    }

    const byProduct = {};
    costed.forEach((u) => { (byProduct[u.product_id] = byProduct[u.product_id] || []).push(u); });

    rows.forEach((p) => {
      const items = byProduct[p.product_id];
      if (!items) return;

      let best = null, bestAmt = null;
      items.forEach((u) => {
        const price = num(u.want_price) ?? num(priceMap[u.item_id]);
        const size = u.size_type || settings.size;
        const fee = feeFor(p.category_code, size, price);
        const c = calcMargin({
          price, commission: commissionFor(p.category_code), fulfillment: fee,
          costCny: u.cost_cny, rate: u.exchange_rate,
          outbound: u.outbound_fee, work: u.work_fee
        });
        if (c && c.margin !== null && (best === null || c.rate > best)) {
          best = c.rate; bestAmt = c.margin;
        }
      });

      if (best !== null) {
        const prow = document.querySelector(`tr.prow[data-pid="${CSS.escape(p.product_id)}"]`);
        if (!prow) return;
        const cls = best >= 0 ? 'pos' : 'neg';
        prow.querySelector('.margin-rate').innerHTML = `<span class="${cls}">${best}%</span>`;
        prow.querySelector('.margin-amt').innerHTML = `<span class="${cls}">${bestAmt.toLocaleString()}</span>`;
      }
    });
  } catch (e) { /* 목록 표시는 계속 정상 동작해야 하므로 조용히 무시 */ }
}

/* ---------- 옵션 펼치기 ---------- */
$('#sourcingBody').addEventListener('click', async (ev) => {
  const star = ev.target.closest('.star');
  if (star) { ev.stopPropagation(); await toggleFavorite(star); return; }

  const row = ev.target.closest('tr.prow');
  if (!row) return;

  const pid = row.dataset.pid;
  const detail = document.querySelector(`tr[data-detail="${CSS.escape(pid)}"]`);
  const open = !detail.classList.contains('hidden');

  if (open) {
    detail.classList.add('hidden');
    row.classList.remove('open');
    state.openProducts.delete(pid);
    return;
  }

  detail.classList.remove('hidden');
  row.classList.add('open');
  state.openProducts.add(pid);

  if (!detail.dataset.loaded) {
    await loadOptions(pid, row.dataset.cat, detail);
    detail.dataset.loaded = '1';
  }
});

async function loadOptions(pid, catCode, detailEl) {
  const box = detailEl.querySelector('.detail-inner');
  try {
    /* user_items를 따로 조회하지 않고 product_items에 PostgREST 리소스 임베딩으로
       한 번에 묶어서 받는다(FK: user_items.item_id -> product_items.item_id).
       예전엔 두 요청을 Promise.all로 동시에 보냈는데, 그래도 요청 2개 자체의
       왕복 오버헤드(연결·헤더 등)는 남아있었다 — 1개로 줄이면 그만큼 더 빨라진다.
       RLS가 이미 user_items를 본인 것만 보이게 걸러주므로 item당 최대 1개만 온다.

       readyForMargins도 같이 기다린다(네트워크 요청과 동시에 — 이미 끝나 있으면
       비용 0). 이게 없으면 페이지 열자마자 바로 클릭했을 때 카테고리 로딩이
       아직 안 끝나 commissionFor()/feeFor()가 전부 null을 주고, detail은 한 번
       열리면 dataset.loaded로 캐시돼서 다시 안 그려지니 "수수료 정보 없음"이
       영영 안 고쳐진다(소싱 목록의 loadRowMargins도 같은 이유로 이걸 기다림). */
    const [items] = await Promise.all([
      api(
        `product_items?select=item_id,vendor_item_id,item_name,image_path,current_price,` +
        `sales_number,sales_text,delivery_badge,shipping_fee,seller_name,is_soldout,user_items(*)` +
        `&product_id=eq.${encodeURIComponent(pid)}&is_active=eq.true&order=sales_number.desc.nullslast`
      ),
      state.readyForMargins
    ]);

    (items || []).forEach((it) => {
      const mine = it.user_items && it.user_items[0];
      if (mine) state.userItems[it.item_id] = mine;
    });

    box.innerHTML = renderOptions(items || [], pid, catCode);
    updateProductMargin(pid);
  } catch (e) {
    box.innerHTML = `<p class="muted sm">옵션을 불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

function renderOptions(items, pid, catCode) {
  if (!items.length) return '<p class="muted sm">옵션이 없습니다</p>';

  const rows = items.map((it) => {
    const u = state.userItems[it.item_id] || {};
    const size = u.size_type || settings.size;
    const price = num(u.want_price) ?? num(it.current_price);
    const fee = feeFor(catCode, size, price);
    const commissionRate = commissionFor(catCode);
    const c = commissionRate != null ? calcMargin({
      price, commission: commissionRate, fulfillment: fee,
      costCny: u.cost_cny, rate: u.exchange_rate,
      outbound: u.outbound_fee, work: u.work_fee
    }) : null;

    const noCommissionTxt = '<span class="dim">수수료 정보 없음</span>';
    const marginTxt = commissionRate == null ? noCommissionTxt
      : (c && c.margin !== null)
        ? `<span class="${c.margin >= 0 ? 'pos' : 'neg'}">${c.margin.toLocaleString()}원 · ${c.rate}%</span>`
        : '<span class="dim">원가 입력 필요</span>';

    const fav = state.userItems[it.item_id] && state.userItems[it.item_id].is_favorite;

    return `
<tr data-iid="${esc(it.item_id)}" data-pid="${esc(pid)}" data-cat="${esc(catCode || '')}">
  <td data-label="옵션">
    <a href="${esc(productUrl(pid, it.item_id, it.vendor_item_id))}" target="_blank" rel="noopener">
      ${esc(it.item_name || '기본')}
    </a>
    ${it.is_soldout ? ' <span class="tag tag-seller">품절</span>' : ''}
  </td>
  <td data-label="판매량">${cnt(it.sales_number)}</td>
  <td data-label="현재가">${won(it.current_price)}</td>
  <td data-label="배송">${deliveryTag(it.delivery_badge)}</td>
  <td data-label="원가(¥)">
    <input type="number" class="w-cost in-cost" step="0.01" min="0" max="${MAX_COST_CNY}" placeholder="0"
           value="${u.cost_cny != null ? u.cost_cny : ''}" />
  </td>
  <td data-label="희망가">
    <input type="number" class="w-price in-want" min="0" max="${MAX_WANT_PRICE}" placeholder="현재가"
           value="${u.want_price != null ? u.want_price : ''}" />
  </td>
  <td data-label="사이즈">
    <select class="w-size in-size">
      ${['MINI','SMALL','MEDIUM','LARGE1','LARGE2','XLARGE'].map((s) =>
        `<option value="${s}"${s === size ? ' selected' : ''}>${
          {MINI:'극소형',SMALL:'소형',MEDIUM:'중형',LARGE1:'대형1',LARGE2:'대형2',XLARGE:'특대형'}[s]
        }</option>`).join('')}
    </select>
  </td>
  <td data-label="입출고비" class="calc-out out-fulfillment">${fee != null ? won(fee) : '<span class="dim">요금표 없음</span>'}</td>
  <td data-label="수수료" class="calc-out out-commission">${commissionRate == null ? noCommissionTxt : (c ? `${won(c.commission)} (${commissionRate}%)` : '—')}</td>
  <td data-label="정산" class="calc-out out-settle">${commissionRate == null ? noCommissionTxt : (c ? won(c.settlement) : '—')}</td>
  <td data-label="마진" class="calc-out out-margin">${marginTxt}</td>
  <td data-label="즐겨찾기">
    <button class="star ${fav ? 'on' : ''}" data-iid="${esc(it.item_id)}" data-pid="${esc(pid)}">
      <svg viewBox="0 0 24 24"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>
    </button>
  </td>
</tr>`;
  }).join('');

  return `
<table class="opt-table">
  <thead><tr>
    <th>옵션</th><th>판매량</th><th>현재가</th><th>배송</th>
    <th>원가(¥)</th><th>희망가</th><th>사이즈</th><th>입출고비</th><th>수수료</th><th>정산예상</th><th>실마진</th><th></th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/* ---------- 옵션 입력 → 즉시 재계산 + 저장 ---------- */
const saveUserItem = debounceKeyed(async (iid, pid, patch) => {
  try {
    await api('user_items?on_conflict=user_id,item_id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [Object.assign({ user_id: AUTH.userId, item_id: iid, product_id: pid }, patch)]
    });
  } catch (e) {
    toast('저장 실패: ' + e.message, 3500);
  }
}, 600);

$('#sourcingBody').addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-iid]');
  if (!tr) return;
  if (!ev.target.matches('.in-cost, .in-want, .in-size')) return;
  recalcRow(tr, true);
});
$('#sourcingBody').addEventListener('change', (ev) => {
  const tr = ev.target.closest('tr[data-iid]');
  if (tr && ev.target.matches('.in-size')) recalcRow(tr, true);
});

function recalcRow(tr, save) {
  const iid = tr.dataset.iid, pid = tr.dataset.pid, cat = tr.dataset.cat;
  const costEl = tr.querySelector('.in-cost');
  const wantEl = tr.querySelector('.in-want');
  const sizeEl = tr.querySelector('.in-size');

  const cost = costEl.value === '' ? null : parseFloat(costEl.value);
  const want = wantEl.value === '' ? null : parseInt(wantEl.value, 10);
  const size = sizeEl.value;

  /* DB 컬럼 한도를 넘는 값은 저장이 매번 400으로 실패해서 헛돌기만 하므로
     여기서 걸러서 계산·저장 둘 다 건너뛴다 (실수로 자릿수를 잘못 입력했을 때 보호) */
  const costTooBig = cost !== null && (cost > MAX_COST_CNY || cost < 0);
  const wantTooBig = want !== null && (want > MAX_WANT_PRICE || want < 0);
  costEl.classList.toggle('input-invalid', costTooBig);
  wantEl.classList.toggle('input-invalid', wantTooBig);

  if (costTooBig || wantTooBig) {
    const label = wantTooBig ? '희망가' : '원가';
    const limit = wantTooBig ? MAX_WANT_PRICE : MAX_COST_CNY;
    tr.querySelector('.out-fulfillment').innerHTML = '<span class="dim">—</span>';
    tr.querySelector('.out-commission').textContent = '—';
    tr.querySelector('.out-settle').textContent = '—';
    tr.querySelector('.out-margin').innerHTML =
      `<span class="neg">${label}는 ${limit.toLocaleString()} 이하로 입력하세요</span>`;
    return;
  }

  const cur = state.userItems[iid] || {};
  const basePrice = num(want) ?? num(cur._current_price) ?? currentPriceOf(tr);
  const fee = feeFor(cat, size, basePrice);
  const commissionRate = commissionFor(cat);

  const c = commissionRate != null ? calcMargin({
    price: basePrice, commission: commissionRate, fulfillment: fee,
    costCny: cost, rate: cur.exchange_rate ?? settings.rate,
    outbound: cur.outbound_fee, work: cur.work_fee
  }) : null;

  tr.querySelector('.out-fulfillment').innerHTML = fee != null ? won(fee) : '<span class="dim">요금표 없음</span>';
  if (commissionRate == null) {
    tr.querySelector('.out-commission').innerHTML = '<span class="dim">수수료 정보 없음</span>';
    tr.querySelector('.out-settle').textContent = '—';
    tr.querySelector('.out-margin').innerHTML = '<span class="dim">수수료 정보 없음</span>';
  } else {
    tr.querySelector('.out-commission').textContent = c ? `${won(c.commission)} (${commissionRate}%)` : '—';
    tr.querySelector('.out-settle').textContent = c ? won(c.settlement) : '—';
    tr.querySelector('.out-margin').innerHTML = (c && c.margin !== null)
      ? `<span class="${c.margin >= 0 ? 'pos' : 'neg'}">${c.margin.toLocaleString()}원 · ${c.rate}%</span>`
      : '<span class="dim">원가 입력 필요</span>';
  }

  state.userItems[iid] = Object.assign(cur, {
    cost_cny: cost, want_price: want, size_type: size,
    exchange_rate: cur.exchange_rate ?? settings.rate
  });

  if (save) {
    saveUserItem(iid, pid, {
      cost_cny: cost, want_price: want,
      exchange_rate: cur.exchange_rate ?? settings.rate
    });
  }
  updateProductMargin(pid);
}

function currentPriceOf(tr) {
  const td = tr.querySelector('td[data-label="현재가"]');
  const n = parseInt((td ? td.textContent : '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/* 상품 행에 옵션 중 최고 마진율 표시 */
function updateProductMargin(pid) {
  const detail = document.querySelector(`tr[data-detail="${CSS.escape(pid)}"]`);
  const prow = document.querySelector(`tr.prow[data-pid="${CSS.escape(pid)}"]`);
  if (!detail || !prow) return;

  let best = null, bestAmt = null;
  detail.querySelectorAll('tr[data-iid]').forEach((tr) => {
    const txt = tr.querySelector('.out-margin').textContent;
    const m = txt.match(/(-?[\d,]+)원\s*·\s*(-?[\d.]+)%/);
    if (m) {
      const r = parseFloat(m[2]);
      if (best === null || r > best) { best = r; bestAmt = parseInt(m[1].replace(/,/g, ''), 10); }
    }
  });

  const rc = prow.querySelector('.margin-rate');
  const ac = prow.querySelector('.margin-amt');
  if (best === null) {
    rc.innerHTML = '<span class="dim">—</span>';
    ac.innerHTML = '<span class="dim">—</span>';
  } else {
    const cls = best >= 0 ? 'pos' : 'neg';
    rc.innerHTML = `<span class="${cls}">${best}%</span>`;
    ac.innerHTML = `<span class="${cls}">${bestAmt.toLocaleString()}</span>`;
  }
}

/* ---------- 즐겨찾기 ---------- */
async function toggleFavorite(btn) {
  const iid = btn.dataset.iid, pid = btn.dataset.pid;
  const on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);

  try {
    await api('user_items?on_conflict=user_id,item_id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [{ user_id: AUTH.userId, item_id: iid, product_id: pid, is_favorite: on }]
    });
    const cur = state.userItems[iid] || {};
    cur.is_favorite = on;
    state.userItems[iid] = cur;
    toast(on ? '즐겨찾기에 추가했습니다' : '즐겨찾기에서 제거했습니다');
  } catch (e) {
    btn.classList.toggle('on', !on);
    toast('실패: ' + e.message, 3500);
  }
}

/* ===================== 즐겨찾기 페이지 ===================== */
let favStatus = '';

async function loadFavorites() {
  const box = $('#favList');
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  try {
    let q = 'v_favorites?select=*&order=updated_at.desc&limit=300';
    if (favStatus) q += `&status=eq.${encodeURIComponent(favStatus)}`;
    const rows = await api(q) || [];

    $('#favCount').textContent = `${rows.length}건`;
    $('#favEmpty').classList.toggle('hidden', rows.length > 0);

    box.innerHTML = rows.map((r) => `
<div class="fav-card" data-iid="${esc(r.item_id)}">
  <img loading="lazy" src="${esc(imageUrl(r.image_path, 200))}" alt="" onerror="this.style.visibility='hidden'" />
  <div class="fav-main">
    <div class="fav-title">
      <a href="${esc(productUrl(r.product_id, r.item_id))}" target="_blank" rel="noopener">
        ${esc(r.product_name || '')}
      </a>
    </div>
    <div class="muted sm">${esc(r.item_name || '')} · ${esc(r.brand_name || '')}</div>
    <div class="fav-meta">
      <span>현재가 ${won(r.current_price)}</span>
      <span>판매량 ${cnt(r.sales_number)}</span>
      <span>${r.delivery_badge ? esc(r.delivery_badge) : '—'}</span>
      ${r.cur_margin_rate != null
        ? `<span class="${r.cur_margin_rate >= 0 ? 'pos' : 'neg'}">마진 ${r.cur_margin_rate}%</span>` : ''}
    </div>
    <div class="fav-tools">
      <select class="fav-status">
        ${['검토중','소싱대기','소싱완료','구매완료','판매중','보류'].map((s) =>
          `<option${s === (r.status || '검토중') ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <textarea class="fav-memo" placeholder="메모">${esc(r.memo || '')}</textarea>
      <button class="btn btn-sm btn-ghost fav-remove">해제</button>
    </div>
  </div>
</div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#statusTabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  $$('#statusTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  favStatus = t.dataset.status || '';
  loadFavorites();
});

$('#favList').addEventListener('change', async (ev) => {
  const card = ev.target.closest('.fav-card');
  if (!card) return;
  const iid = card.dataset.iid;

  if (ev.target.matches('.fav-status')) {
    await patchUserItem(iid, { status: ev.target.value });
    toast('상태를 변경했습니다');
  }
});

const saveFavMemo = debounceKeyed(async (iid, memo) => {
  await patchUserItem(iid, { memo });
}, 800);

$('#favList').addEventListener('input', (ev) => {
  const card = ev.target.closest('.fav-card');
  if (!card || !ev.target.matches('.fav-memo')) return;
  saveFavMemo(card.dataset.iid, ev.target.value);
});

$('#favList').addEventListener('click', async (ev) => {
  if (!ev.target.matches('.fav-remove')) return;
  const card = ev.target.closest('.fav-card');
  await patchUserItem(card.dataset.iid, { is_favorite: false });
  card.remove();
  toast('즐겨찾기에서 제거했습니다');
});

async function patchUserItem(iid, patch) {
  try {
    await api(`user_items?item_id=eq.${encodeURIComponent(iid)}&user_id=eq.${AUTH.userId}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: patch
    });
  } catch (e) {
    toast('저장 실패: ' + e.message, 3500);
  }
}

/* ===================== 카테고리 ===================== */
const selectedCats = new Set();

async function loadCategories(force) {
  const box = $('#catGroups');
  if (!force && state.catStatusRows) { renderCategories(); return; }
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  try {
    const rows = await apiAll('categories?select=category_code,name,full_path,root_name,last_list_at,last_detail_at&order=full_path') || [];
    const today = kstDateStr(new Date());
    rows.forEach((r) => { r.status = catStatus(r, today); });
    state.catStatusRows = rows;
    renderCategories();
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

function renderCategories() {
  const box = $('#catGroups');
  try {
    const rows = state.catStatusRows || [];
    const favOnly = $('#catFavOnly').checked;
    const list = favOnly ? rows.filter((r) => state.favCatCodes.has(r.category_code)) : rows;

    const groups = {};
    list.forEach((r) => {
      const g = r.root_name || (r.full_path || '').split('>')[0] || '기타';
      (groups[g] = groups[g] || []).push(r);
    });

    const counts = { collected: 0, partial: 0, stale: 0, never: 0 };
    list.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    $('#catSummary').textContent =
      `전체 ${list.length}개 · 오늘 완료 ${counts.collected} · 목록만 ${counts.partial} · 과거 ${counts.stale} · 미수집 ${counts.never}`;

    box.innerHTML = Object.keys(groups).sort().map((g) => {
      const items = groups[g];
      const c = items.filter((x) => x.status === 'collected').length;
      return `
<div class="cat-group">
  <div class="cat-group-head">
    <svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
    <h3>${esc(g)}</h3>
    <div class="cat-stat">
      <span>${items.length}개</span>
      <span class="pos">완료 ${c}</span>
    </div>
  </div>
  <div class="cat-items">
    ${items.map((r) => `
    <div class="cat-chip" data-code="${esc(r.category_code)}" data-name="${esc(r.name)}">
      <i class="dot s-${r.status}"></i>
      <div class="cat-name">
        <div class="ellipsis">${esc(r.name)}</div>
        <div class="cat-path" title="${esc(r.full_path || '')}">${esc(r.full_path || '')}</div>
        <div class="cat-date">${
          r.last_detail_at ? new Date(r.last_detail_at).toLocaleDateString('ko-KR')
          : (r.last_list_at ? new Date(r.last_list_at).toLocaleDateString('ko-KR') + ' (목록)' : '미수집')
        }</div>
      </div>
      <button class="star cat-star ${state.favCatCodes.has(r.category_code) ? 'on' : ''}" data-code="${esc(r.category_code)}" title="즐겨찾기">
        <svg viewBox="0 0 24 24"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>
      </button>
      ${AUTH.isAdmin ? `<button class="icon-btn cat-del" data-code="${esc(r.category_code)}" data-name="${esc(r.name)}" title="삭제">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>
      </button>` : ''}
    </div>`).join('')}
  </div>
</div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#catGroups').addEventListener('click', async (ev) => {
  const star = ev.target.closest('.cat-star');
  if (star) {
    ev.stopPropagation();
    const code = star.dataset.code;
    const on = !star.classList.contains('on');
    star.classList.toggle('on', on);
    try {
      if (on) {
        await api('user_category_favorites', {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
          body: [{ user_id: AUTH.userId, category_code: code }]
        });
        state.favCatCodes.add(code);
      } else {
        await api(`user_category_favorites?category_code=eq.${encodeURIComponent(code)}&user_id=eq.${AUTH.userId}`,
                  { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        state.favCatCodes.delete(code);
      }
    } catch (e) {
      star.classList.toggle('on', !on);
      toast('실패: ' + e.message, 3500);
    }
    return;
  }

  const del = ev.target.closest('.cat-del');
  if (del) {
    ev.stopPropagation();
    const code = del.dataset.code, name = del.dataset.name;
    if (!confirm(`"${name}" 카테고리를 삭제하시겠습니까?\n\n이 카테고리로 수집된 상품 데이터도 함께 삭제됩니다.`)) return;
    try {
      await api(`categories?category_code=eq.${encodeURIComponent(code)}`, {
        method: 'DELETE', headers: { prefer: 'return=minimal' }
      });
      del.closest('.cat-chip').remove();
      selectedCats.delete(code);
      if (state.catStatusRows) state.catStatusRows = state.catStatusRows.filter((r) => r.category_code !== code);
      toast(`"${name}" 카테고리를 삭제했습니다`);
    } catch (e) {
      toast('삭제 실패: ' + e.message, 4000);
    }
    return;
  }

  const head = ev.target.closest('.cat-group-head');
  if (head) { head.parentElement.classList.toggle('open'); return; }

  const chip = ev.target.closest('.cat-chip');
  if (chip) {
    const code = chip.dataset.code;
    if (selectedCats.has(code)) { selectedCats.delete(code); chip.classList.remove('sel'); }
    else { selectedCats.add(code); chip.classList.add('sel'); }
    $('#catSelCount').textContent = selectedCats.size;
    const none = selectedCats.size === 0;
    $('#catQueueBtn').classList.toggle('hidden', none);
    $('#catDeleteBtn').classList.toggle('hidden', none || !AUTH.isAdmin);
  }
});

$('#catFavOnly').onchange = renderCategories;

$('#catDeleteBtn').onclick = async () => {
  if (!selectedCats.size) return;
  const n = selectedCats.size;
  if (!confirm(`선택한 ${n}개 카테고리를 삭제하시겠습니까?\n\n해당 카테고리로 수집된 상품 데이터도 함께 삭제됩니다.`)) return;
  try {
    const codes = Array.from(selectedCats).map(encodeURIComponent).join(',');
    await api(`categories?category_code=in.(${codes})`, {
      method: 'DELETE', headers: { prefer: 'return=minimal' }
    });
    selectedCats.clear();
    $('#catSelCount').textContent = '0';
    $('#catQueueBtn').classList.add('hidden');
    $('#catDeleteBtn').classList.add('hidden');
    toast(`${n}개 카테고리를 삭제했습니다`);
    loadCategories(true);
  } catch (e) {
    toast('삭제 실패: ' + e.message, 4000);
  }
};

$('#catQueueBtn').onclick = async () => {
  if (!selectedCats.size) return;
  try {
    const chips = Array.from(selectedCats).map((code) => {
      const el = document.querySelector(`.cat-chip[data-code="${CSS.escape(code)}"]`);
      return {
        requested_by: AUTH.userId,
        category_code: code,
        category_name: el ? el.dataset.name : '',
        job_type: 'full'
      };
    });
    await api('collect_queue', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: chips
    });
    toast(`${chips.length}건을 수집 대기열에 등록했습니다`);
    selectedCats.clear();
    $$('.cat-chip.sel').forEach((c) => c.classList.remove('sel'));
    $('#catQueueBtn').classList.add('hidden');
  } catch (e) {
    toast('등록 실패: ' + e.message, 4000);
  }
};

/* ===================== 대기열 ===================== */
async function loadQueue() {
  const box = $('#queueList');
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';
  try {
    const rows = await api('collect_queue?select=*&order=status,priority.desc,requested_at&limit=200') || [];
    const pend = rows.filter((r) => r.status === 'pending').length;
    $('#queueSummary').textContent = `전체 ${rows.length}건 · 대기 ${pend}건`;

    if (!rows.length) { box.innerHTML = '<div class="empty"><p>대기열이 비어 있습니다</p></div>'; return; }

    const label = { pending: '대기', running: '진행중', done: '완료', failed: '실패', cancelled: '취소' };
    box.innerHTML = rows.map((r) => `
<div class="queue-item">
  <span class="q-status q-${r.status}">${label[r.status] || r.status}</span>
  <div style="flex:1;min-width:0">
    <div class="ellipsis">${esc(r.category_name || r.category_code)}</div>
    <div class="muted xs">${new Date(r.requested_at).toLocaleString('ko-KR')}${
      r.result_count != null ? ` · ${r.result_count}건 수집` : ''}${
      r.error_message ? ` · ${esc(r.error_message)}` : ''}</div>
  </div>
  ${r.status === 'pending'
    ? `<button class="btn btn-sm btn-ghost q-cancel" data-id="${r.id}">취소</button>` : ''}
</div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#queueList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.q-cancel');
  if (!btn) return;
  try {
    await api(`collect_queue?id=eq.${btn.dataset.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { status: 'cancelled' }
    });
    loadQueue();
  } catch (e) { toast('취소 실패: ' + e.message, 3500); }
});

$('#queueRefresh').onclick = loadQueue;

/* ===================== 판매현황 =====================
   로켓그로스 Open API(공식) 기반 — 위 소싱 기능들과는 완전히 별개 데이터 소스.
   웹은 쿠팡 API를 직접 호출하지 않는다 — 고정 IP가 없는 Vercel에서 호출하면
   쿠팡 WAF가 막는다(docs/api-notes.md 4-6/4-7). 대신 GCP VPS(고정 IP)에서 도는
   scripts/rocket-growth-sync.js가 주기적으로 쿠팡을 호출해 Supabase의
   rocket_growth_sales_daily 테이블에 upsert해두고, 여기서는 그 테이블만 읽는다.
   그 결과를 product_items.vendor_item_id로 조인해 item_id를 찾고, 기존
   feeFor()+calcMargin()으로 수수료·입출고비·마진을 추정한다. 쿠팡이 당일 확정
   수수료·정산액을 API로 안 주기 때문에 전부 추정치다(docs/api-notes.md 4-4).

   반품은 위 방식(공식 Open API)에 아예 없다(docs/api-notes.md 4-4-1). 대신 WING
   내부 API(로그인 세션 기반)엔 반품이 순액으로 반영돼 있는데(4-4-2), 세션이 필요해서
   웹이 직접 못 부르고 브라우저 확장프로그램(extension/background.js)에
   메시지를 보내 대신 호출시킨다 — 성공하면 rocket_growth_sales_wing_daily 테이블에
   순매출이 채워지고, 아래 fetchAndRenderSales()가 그 테이블 값을 우선 사용한다.
   확장프로그램이 없거나 응답이 없어도(일반 방문자 등) 기존 방식으로 정상 동작한다. */
const SALES_EXT_ID = 'jbcbkoclamjhjkoedfjeocnhkgioabaj';

function extensionSendMessage(message, timeoutMs) {
  return new Promise((resolve) => {
    if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
      resolve({ ok: false, error: 'no-extension' });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); }
    }, timeoutMs || 25000);
    try {
      chrome.runtime.sendMessage(SALES_EXT_ID, message, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: 'empty-response' });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

async function syncSalesViaExtension() {
  const statusEl = $('#salesSyncStatus');
  const to = kstDateStr(new Date());
  const from = kstDateStr(new Date(Date.now() - 86400000));

  statusEl.textContent = '확장프로그램으로 반품·확정정산 데이터 동기화 중…';
  statusEl.classList.remove('hidden');

  const resp = await extensionSendMessage({ type: 'SYNC_SALES', dateFrom: from, dateTo: to });

  if (resp.ok) {
    statusEl.textContent = `동기화 완료 (판매 ${resp.rowCount}건, 정산 ${resp.profitRowCount}건)`;
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
    return true;
  }
  if (resp.error === 'no-extension') {
    statusEl.classList.add('hidden');
  } else if (resp.error === 'timeout') {
    statusEl.textContent = '동기화 응답 시간초과 — 기존 데이터로 표시합니다.';
    setTimeout(() => statusEl.classList.add('hidden'), 4000);
  } else {
    statusEl.textContent = `동기화 실패: ${resp.error} — 기존 데이터로 표시합니다.`;
    setTimeout(() => statusEl.classList.add('hidden'), 6000);
  }
  return false;
}

/* 수동 백필(2026-08-15 추가) — 자동 동기화는 항상 "오늘+어제"만 조회한다(위 syncSalesViaExtension,
   기본값을 넓히지 말라는 규칙은 extension/CLAUDE.md 참조). 그래서 그보다 과거 날짜는
   rocket_growth_profit_daily(확정 정산)에 애초에 행이 없고, 상단 고정기간 카드(이번 달 등)가
   그 구간을 카테고리 요율 추정으로 메꾸는데 이 계정처럼 카테고리 매칭이 안 된 상품이 많으면
   추정치가 사실상 0으로 깔려서 WING 실제 위젯과 크게 어긋난다(2026-08-15, 실사용 중 발견).
   이 버튼은 하단 조회 기간(salesFrom~salesTo)을 그대로 확장프로그램에 보내 그 범위의
   WING 확정 정산·반품을 다시 채운다 — background.js의 SYNC_SALES는 원래 임의 범위를
   받을 수 있고(최대 31일, MAX_DAYS) 자동 동기화 쪽에서만 "오늘+어제"로 좁혀 쓰고 있었을 뿐이라
   background.js는 손댈 필요 없이 웹에서 넓은 범위로 같은 메시지를 보내기만 하면 된다.
   하루씩 WING 탭에서 순차 조회라 범위가 넓으면 오래 걸릴 수 있어 타임아웃을 넉넉히 잡는다. */
async function backfillSales() {
  const from = $('#salesFrom').value;
  const to = $('#salesTo').value;
  if (!from || !to) return;

  const statusEl = $('#salesSyncStatus');
  const btn = $('#salesBackfillBtn');
  btn.disabled = true;
  statusEl.textContent = `${from} ~ ${to} 정산 백필 중… (하루씩 조회라 기간이 넓으면 오래 걸릴 수 있습니다)`;
  statusEl.classList.remove('hidden');

  const resp = await extensionSendMessage({ type: 'SYNC_SALES', dateFrom: from, dateTo: to }, 180000);

  if (resp.ok) {
    const profitFailed = resp.profitFailed || [];
    if (profitFailed.length) {
      // 실패한 날짜·이유를 화면에 그대로 보여준다 — 전엔 콘솔에만 남아서 "백필해도 계속
      // 안 맞는다"는 원인을 사용자가 알 방법이 없었다(2026-08-15 실사용 중 겪음).
      console.warn('[정산 백필] 정산 실패 날짜:', profitFailed);
      const sample = profitFailed.slice(0, 5).map((f) => `${f.date}(${f.error})`).join(', ');
      const more = profitFailed.length > 5 ? ` 외 ${profitFailed.length - 5}건` : '';
      statusEl.textContent =
        `백필 완료 (판매 ${resp.rowCount}건, 정산 ${resp.profitRowCount}건) — ` +
        `정산 실패 ${profitFailed.length}일: ${sample}${more}`;
    } else {
      statusEl.textContent = `백필 완료 (판매 ${resp.rowCount}건, 정산 ${resp.profitRowCount}건)`;
      setTimeout(() => statusEl.classList.add('hidden'), 5000);
    }
    await fetchAndRenderSales(from, to);
  } else if (resp.error === 'no-extension') {
    statusEl.textContent = '확장프로그램이 연결되지 않았습니다 — 설치·로그인 상태를 확인하세요.';
  } else {
    statusEl.textContent = `백필 실패: ${resp.error}`;
  }
  btn.disabled = false;
}

/* 상품별 실제 원가정보(개당 수수료/입출고비/보관비) 수동 갱신 — 정산 백필과 마찬가지로
   자동으로는 안 돈다(전체 상품을 페이지네이션으로 다 훑어야 해서 WING에 부담,
   extension/CLAUDE.md 참조). 덮어쓰지 않고 새 스냅샷을 쌓는 방식이라 여러 번 눌러도
   과거 기록이 지워지지 않는다 — 가격을 바꿀 때마다 눌러주면 그 시점 요율이 남는다.
   상품이 수백 개면 페이지가 많아 오래 걸릴 수 있어 타임아웃을 넉넉히 잡는다. */
async function refreshItemCosts() {
  const statusEl = $('#salesSyncStatus');
  const btn = $('#itemCostRefreshBtn');
  btn.disabled = true;
  statusEl.textContent = '상품 원가정보(개당 수수료·입출고비·보관비) 갱신 중… (상품 수가 많으면 오래 걸릴 수 있습니다)';
  statusEl.classList.remove('hidden');

  const resp = await extensionSendMessage({ type: 'SYNC_ITEM_COSTS' }, 300000);

  if (resp.ok) {
    statusEl.textContent = `상품 원가정보 갱신 완료 (${resp.rowCount}개 옵션)`;
    setTimeout(() => statusEl.classList.add('hidden'), 5000);
    const fromEl = $('#salesFrom');
    const toEl = $('#salesTo');
    if (fromEl.value && toEl.value) await fetchAndRenderSales(fromEl.value, toEl.value);
  } else if (resp.error === 'no-extension') {
    statusEl.textContent = '확장프로그램이 연결되지 않았습니다 — 설치·로그인 상태를 확인하세요.';
  } else {
    statusEl.textContent = `상품 원가정보 갱신 실패: ${resp.error}`;
  }
  btn.disabled = false;
}

function setSalesRange(daysBack) {
  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 86400000);
  $('#salesFrom').value = kstDateStr(from);
  $('#salesTo').value = kstDateStr(to);
}

$('#page-sales').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-preset]');
  if (!btn) return;
  setSalesRange(parseInt(btn.dataset.preset, 10) || 0);
  loadSales();
});

async function loadSales() {
  const fromEl = $('#salesFrom');
  const toEl = $('#salesTo');
  if (!fromEl.value || !toEl.value) setSalesRange(0); // 최초 진입 시 기본값: 오늘

  await fetchAndRenderSales(fromEl.value, toEl.value);

  // 확장프로그램으로 반품 포함(WING) 데이터 동기화 시도 — 성공하면 조용히 다시 렌더
  const synced = await syncSalesViaExtension();
  if (synced) await fetchAndRenderSales(fromEl.value, toEl.value);
}

/* ===================== 판매현황 — 날짜 유틸 =====================
   sale_date는 'YYYY-MM-DD' 캘린더 날짜 문자열이라, 요일·월 경계 계산은
   타임존과 무관하게 UTC 자정으로 다뤄도 KST로 해석한 것과 같은 결과가 나온다. */
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function dateRangeList(fromStr, toStr) {
  const out = [];
  for (let d = fromStr; d <= toStr; d = addDaysStr(d, 1)) out.push(d);
  return out;
}
function mondayOnOrBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=일 .. 6=토
  return addDaysStr(dateStr, -(dow === 0 ? 6 : dow - 1));
}
function startOfMonthStr(dateStr) { return dateStr.slice(0, 8) + '01'; }

/* vendorItemId → 카테고리/원가 메타. 일별집계(buildDailyRow)와 상품별 표(renderSales)가
   공유한다 — product_items/products/user_items 조회를 범위당 한 번만 하기 위함. */
/* ── 실제 매입원가(선입선출) ──────────────────────────────────
   발주 → 출고에서 확정된 로트 원가를 판매에 붙인다. 결과는 (날짜|옵션ID) 단위
   개당 원가 맵이고, 판매현황의 원가·영업이익이 이걸 쓴다.

   **왜 미리 계산해서 저장하지 않고 볼 때마다 계산하나**: 로트 원가는 출고 시점에
   작업비가 붙으면서 한 번 올라간다. 미리 저장해두면 그때 과거 이익을 소급 갱신하는
   로직이 필요해지는데, 매번 현재 로트 원가로 계산하면 그런 게 아예 필요 없다
   (사용자와 확인, 2026-08-18 — 작업비 청구서가 쿠팡 도착 전에 오므로 실무상 어긋날
   일도 거의 없다).

   **판매 이력 전체를 읽는 이유**: 선입선출은 처음부터 순서대로 소진시켜야 맞다.
   조회 기간만 읽으면 이미 팔려나간 옛 로트가 아직 남은 것처럼 계산돼 원가가 낮게 나온다.
   이 계정 규모(상품 수십 개)에선 전량 조회가 몇백 KB라 문제되지 않는다 — 나중에
   수천 SKU가 되어 느려지면 그때 cogs_allocations(016)에 확정분을 물질화할 것. */
async function loadLotCogs(vendorItemIds) {
  const out = new Map();
  if (!vendorItemIds.length) return out;

  const [listings, lots, wing, gross] = await Promise.all([
    apiAll('sku_channel_listings?select=sku_id,external_option_id&channel=eq.coupang_rg'),
    apiAll('inventory_lots?select=id,sku_id,qty_coupang,unit_cost_krw,arrived_coupang_at&arrived_coupang_at=not.is.null'),
    apiAll('rocket_growth_sales_wing_daily?select=sale_date,vendor_item_id,quantity'),
    apiAll('rocket_growth_sales_daily?select=sale_date,vendor_item_id,quantity')
  ]);
  if (!lots.length) return out;

  const skuByVid = new Map();
  listings.forEach((l) => { if (l.external_option_id) skuByVid.set(String(l.external_option_id), l.sku_id); });
  if (!skuByVid.size) return out;

  /* 로트를 SKU별 선입선출 대기열로. 쿠팡에 도착한 수량이 곧 팔 수 있는 수량이다
     (불량은 출고 전에 이미 빠졌고, 판매될 때 로트 수량을 깎지는 않는다). */
  const queues = new Map();
  lots.slice()
    .sort((a, b) => new Date(a.arrived_coupang_at) - new Date(b.arrived_coupang_at))
    .forEach((lot) => {
      const cap = Number(lot.qty_coupang) || 0;
      if (!lot.sku_id || cap <= 0) return;
      const q = queues.get(lot.sku_id) || [];
      q.push({ left: cap, unit: Number(lot.unit_cost_krw) || 0,
               arrivedAt: (lot.arrived_coupang_at || '').slice(0, 10) });
      queues.set(lot.sku_id, q);
    });

  /* 판매 이력 병합 — 그 날짜에 WING 행이 하나라도 있으면 그 날짜는 WING만 쓴다
     (fetchSalesRange()와 같은 규칙. 섞으면 반품 반영분이 이중 계상된다). */
  const wingDates = new Set(wing.map((r) => r.sale_date));
  const byDate = new Map();
  const push = (r) => {
    const arr = byDate.get(r.sale_date) || [];
    arr.push(r);
    byDate.set(r.sale_date, arr);
  };
  wing.forEach(push);
  gross.forEach((r) => { if (!wingDates.has(r.sale_date)) push(r); });

  const wanted = new Set(vendorItemIds.map(String));
  Array.from(byDate.keys()).sort().forEach((date) => {
    byDate.get(date).forEach((r) => {
      const vid = String(r.vendor_item_id);
      const skuId = skuByVid.get(vid);
      if (!skuId) return;
      const q = queues.get(skuId);
      if (!q) return;

      let qty = Number(r.quantity) || 0;
      const sold = qty;              // 원가를 나눌 기준(아래 주석 참조)
      if (qty <= 0) {
        /* 반품(음수)은 로트로 되돌린다 — 맨 앞 로트에 얹으면 다음 판매가 그 원가로 나간다 */
        if (qty < 0 && q.length) q[0].left += -qty;
        return;
      }
      let total = 0, taken = 0;
      for (const lot of q) {
        if (qty <= 0) break;
        /* **판매일보다 나중에 도착한 로트는 쓸 수 없다.** 이걸 안 막으면 시스템 도입
           전의 옛 판매가 최근 매입분을 끌어다 써서, 없던 원가가 생기고 정작 최근
           판매는 로트가 모자라게 된다(2026-08-18 검증 중 발견). 원가를 못 매긴
           수량은 short로 남겨 화면에서 "원가 없음"으로 보이게 한다. */
        if (lot.arrivedAt && lot.arrivedAt > date) break;
        const take = Math.min(lot.left, qty);
        if (take <= 0) continue;
        lot.left -= take; qty -= take; taken += take; total += take * lot.unit;
      }
      /* 조회 대상 옵션만 결과에 담는다(계산은 전체를 돌려야 순서가 맞다).

         **개당 원가는 "덮인 수량"이 아니라 그날 판매수량 전체로 나눈다** — 화면 계산이
         (개당원가 x 판매수량)으로 합계를 내기 때문이다. 로트가 모자라 일부만 덮인 날에
         덮인 부분의 평균을 그대로 넘기면 없는 원가가 부풀려진다(8개 팔렸는데 6개분
         원가만 아는데도 8개분으로 계산되는 식). 이렇게 하면 합계는 항상 실제로 아는
         원가와 정확히 같고, 모자란 만큼은 short로 남아 화면에서 구분된다. */
      if (taken > 0 && wanted.has(vid)) {
        out.set(`${date}|${vid}`, {
          qty: sold, covered: taken, total,
          unit: Math.round((total / sold) * 100) / 100,
          short: qty > 0 ? qty : 0   // 로트가 모자라 원가를 못 매긴 수량
        });
      }
    });
  });
  return out;
}

async function loadItemMeta(vendorItemIds) {
  const meta = {};
  if (!vendorItemIds.length) return meta;

  const pItemsRaw = await api(
    `product_items?select=item_id,vendor_item_id,product_id&vendor_item_id=in.(${vendorItemIds.map(encodeURIComponent).join(',')})`
  ) || [];
  const linkByVendorItem = {};
  pItemsRaw.forEach((r) => { linkByVendorItem[r.vendor_item_id] = r; });

  const productIds = Array.from(new Set(pItemsRaw.map((r) => r.product_id).filter(Boolean)));
  const itemIds = pItemsRaw.map((r) => r.item_id).filter(Boolean);

  const [productsRaw, userItemsRaw] = await Promise.all([
    productIds.length
      ? api(`products?select=product_id,category_code&product_id=in.(${productIds.map(encodeURIComponent).join(',')})`)
      : [],
    itemIds.length
      ? api(`user_items?select=item_id,cost_cny,exchange_rate,outbound_fee,work_fee,size_type&item_id=in.(${itemIds.map(encodeURIComponent).join(',')})`)
      : []
  ]);
  const catByProduct = {};
  (productsRaw || []).forEach((p) => { catByProduct[p.product_id] = p.category_code; });
  const userItemByItem = {};
  (userItemsRaw || []).forEach((u) => { userItemByItem[u.item_id] = u; });

  vendorItemIds.forEach((vid) => {
    const link = linkByVendorItem[vid];
    const itemId = link && link.item_id;
    const productId = link && link.product_id;
    const u = (itemId && userItemByItem[itemId]) || {};
    meta[vid] = {
      catCode: productId ? catByProduct[productId] : null,
      size: u.size_type || settings.size,
      costCny: u.cost_cny, exchangeRate: u.exchange_rate,
      outboundFee: u.outbound_fee, workFee: u.work_fee
      // 옵션ID 클릭용 등록상품ID·상품ID는 여기 안 넣는다 — product_items는 카테고리
      // 소싱(마진 조사용으로 수집한 다른 상품 목록)이라 실제 판매된 vendor_item_id와는
      // 무관한 데이터라 여기서 조인하면 틀린 값이 나온다(2026-08-16 사용자 지적으로
      // 발견 — web/CLAUDE.md 참조). 대신 loadProductRegistry()가 실제 등록정보
      // 테이블(rocket_growth_product_registry)에서 따로 가져온다.
    };
  });
  return meta;
}

/* 등록상품ID·상품ID — rocket_growth_product_registry(db/migrations/014)에서 가져온다.
   GCP VPS의 rocket-growth-sync.js --products가 공식 Open API "상품 목록 페이징 조회"로
   채운 실제 등록정보다(docs/api-notes.md 4-7). product_items(소싱 DB)와는 완전히
   별개 — 그쪽은 카테고리 소싱(마진 조사용으로 수집한 다른 상품 목록)이라 실제로
   판매된 vendor_item_id와 무관하다(2026-08-16 사용자 지적). SKU ID는 이 API에
   없어서 안 채움(나중에 재고 페이지 만들 때 다시 조사하기로 함) — meta에 없는
   vendor_item_id는 그 옵션이 아직 이 계정에서 동기화 안 됐거나(레지스트리 동기화
   전) 로켓그로스 상품이 아닌 경우다. */
async function loadProductRegistry(vendorItemIds) {
  const out = {};
  if (!vendorItemIds.length) return out;
  let rows;
  try {
    // 마이그레이션 014 미실행이거나 --products 동기화를 아직 한 번도 안 돌렸으면
    // 테이블이 없거나 비어있을 수 있다 — 이 표 하나 때문에 판매현황 전체가
    // 멎으면 안 되므로 실패해도 조용히 빈 값으로 폴백한다(등록상품ID·쿠팡 링크만
    // "—"로 빠지고 나머지 화면은 항상 정상 동작해야 하는 기존 원칙과 동일).
    rows = await api(
      `rocket_growth_product_registry?select=vendor_item_id,seller_product_id,product_id` +
      `&vendor_item_id=in.(${vendorItemIds.map(encodeURIComponent).join(',')})`
    ) || [];
  } catch (e) {
    console.warn('[판매현황] 상품 등록정보 조회 실패(등록상품ID/링크만 빠짐):', e.message);
    return out;
  }
  rows.forEach((r) => {
    out[r.vendor_item_id] = { sellerProductId: r.seller_product_id, productId: r.product_id };
  });
  return out;
}

/* 하루치 옵션별 판매(items)를 확정 정산(confirmed, 있으면)과 합쳐 한 줄로 만든다.
   확정 정산에 있는 필드(수수료/입출고비/보관비/쿠폰/밀크런/순이익/매출)는 WING 확정값을
   그대로 쓰고, 없으면(주로 오늘 — 정산 인식이 D-1 지연) 옵션별 추정으로 채운다.
   추정은 renderSales()와 동일한 우선순위를 따른다 — 상품 원가정보 스냅샷(costSnapshots)이
   있으면 그 실제 개당 값을, 없는 상품만 카테고리 요율+요금표로 폴백(2026-08-16 개선:
   예전엔 항상 카테고리 폴백만 써서, 카테고리 매칭이 안 된 계정은 당일 수수료·입출고비·
   보관비·쿠폰비·순이익이 전부 0으로 보였다 — 매출·판매수량만 별도 경로라 정상이었음).
   광고비·밀크런은 정산현황 API에만 있는 값이라 추정 방법 자체가 없어 항상 0(사용자 확인:
   당일엔 몰라도 되는 값). 원가·배송/작업비·영업이익도 정산현황 API에 없는 필드라 항상
   옵션별 추정(user_items.cost_cny 등, calcMargin() 재사용)으로만 계산 — 확정/추정 여부와 무관. */
function buildDailyRow(date, items, meta, confirmed, costSnapshots, lotCogs) {
  let quantity = 0, itemRevenue = 0;
  let estCommission = 0, estFulfillment = 0, estCoupon = 0, estStorage = 0, estSettlement = 0;
  let cost = 0, shipWork = 0, opProfit = 0, costedQty = 0;

  items.forEach((it) => {
    quantity += it.quantity;
    itemRevenue += it.revenue;
    const m = meta[it.vendor_item_id] || {};
    const avgPrice = it.quantity ? it.revenue / it.quantity : 0;

    const snapResult = snapshotAsOf(costSnapshots && costSnapshots[it.vendor_item_id], date);
    let commissionRate, fee, coupon;
    if (snapResult) {
      // 수수료는 그 자체로 부가세 포함 확정값과 대응되는 독립 항목이라 여기서 바로
      // 보정한다(withSnapshotVat, 2026-08-17 실측 검증됨). 입출고비는 다르다 — WING
      // 자신의 "풀필먼트서비스 비용" 상세(사용자 스크린샷)를 보면 부가세는 입출고비
      // 하나가 아니라 "입출고비+보관비를 합친 금액의 10%"로 계산된다. 그래서 여기서는
      // fee를 세전 원값 그대로 두고, 보관비까지 합산한 뒤 아래에서 부가세를 한 번에
      // 계산한다 — withSnapshotVat을 fee에 바로 곱하면 보관비 몫의 부가세가 빠진다.
      commissionRate = avgPrice > 0 ? (withSnapshotVat(snapResult.snap.commission_amount) / avgPrice * 100) : 0;
      fee = snapResult.snap.fulfillment_amount;
      coupon = snapResult.snap.coupon_amount || 0;
    } else {
      commissionRate = commissionFor(m.catCode);
      fee = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
      coupon = 0; // 카테고리 요율표엔 쿠폰 개념이 없어 추정 불가
    }
    if (commissionRate == null) return;
    estCoupon += coupon * it.quantity;
    const storageInfo = storageAllocationForItem(costSnapshots && costSnapshots[it.vendor_item_id], 1);
    if (storageInfo) estStorage += storageInfo.allocated;

    const lc = lotCogs && lotCogs.get(`${date}|${it.vendor_item_id}`);
    const c = calcMargin({
      price: avgPrice, commission: commissionRate, fulfillment: fee,
      costKrw: lc ? lc.unit : null,
      costCny: m.costCny, rate: m.exchangeRate, outbound: m.outboundFee, work: m.workFee
    });
    if (!c) return;
    estCommission += c.commission * it.quantity;
    estSettlement += c.settlement * it.quantity;
    if (fee != null) estFulfillment += fee * it.quantity;
    if (c.margin != null) {
      cost += c.cost * it.quantity;
      shipWork += c.shipWork * it.quantity;
      opProfit += c.margin * it.quantity;
      costedQty += it.quantity;
    }
  });

  // WING 정산현황 페이지 자체가 "오늘" 날짜는 절대 안 보여준다(항상 D-1까지만,
  // 사용자 확인 2026-08-17) — 그런데 profit-status/search API는 오늘 날짜로 조회해도
  // 가끔 필드가 채워진(0이 아닌) 응답을 준다. 처음엔 "전부 0이면 빈 응답"으로만
  // 걸렀는데(바로 아래 looksEmpty, 2026-08-16), 그건 놓치는 경우가 있었다 — 실사용
  // 사례(2026-08-17): 오늘 실제 판매 0건인데 profit-status가 fulfillment_amount:6470,
  // storage_amount:1282(0이 아님)를 줘서 "빈 응답" 필터를 통과해버렸고, 순이익 -6,470원이
  // "확정"으로 화면에 떴다. 보관비 같은 항목은 판매 이벤트 없이도(창고에 쌓인 재고
  // 기준으로) 매일 누적되는 비용이라 이런 식으로 부분 데이터가 먼저 채워질 수 있는
  // 것으로 보인다 — 즉 "0이 아니다"가 "그날 정산이 최종 확정됐다"를 보장하지 않는다.
  // **그래서 날짜 자체가 오늘(KST)이면 confirmed 내용과 무관하게 항상 확정으로 안 믿는다**
  // — WING 자신도 오늘 날짜는 화면에 아예 안 보여주는 것과 원칙을 맞춘 것. 옵션별
  // 추정으로 폴백해서 "정보 없음"보다야 낫지만, 이것도 결국 추정치일 뿐이라는 걸
  // 감안할 것.
  const isToday = date === kstDateStr(new Date());
  const looksEmpty = confirmed && !confirmed.total_sales_amount && !confirmed.total_deduction_amount;
  const hasConfirmed = !!confirmed && !isToday && !(looksEmpty && quantity > 0);
  const revenue = hasConfirmed ? confirmed.net_sales_amount : itemRevenue;
  // 풀필먼트서비스 부가세 — WING 자신의 "수익 현황" 화면(사용자 스크린샷, 2026-08-17)에서
  // "부가가치세는 조회된 기간에 발생한 요금의 10%로 계산"됨을 확인, 실측 검산(9,336원)까지
  // 정확히 일치했다. 확정일은 WING이 이미 "배송비+입출고비+보관비+부가세"를 fulfillment_amount
  // 하나로 합쳐서 주므로(별도 필드 없음), 총액÷11 = 그 안에 포함된 부가세와 수학적으로 완전히
  // 같다(총액=세전×1.1 이므로 세전=총액÷1.1, 부가세=총액−세전=총액÷11). 추정일(오늘 등)은
  // 우리가 직접 세전 입출고비+보관비를 만들었으니 그 합의 10%로 계산 — 어느 쪽이든 "보관비"
  // 컬럼(참고용, 이미 입출고비 안에 포함된 서브셋)과 별개로 하나 더 참고용 컬럼을 추가한다.
  const vat = hasConfirmed ? Math.round(confirmed.fulfillment_amount / 11) : Math.round((estFulfillment + estStorage) * 0.1);
  // 순이익 = 매출 − 수수료 − 입출고비 − 보관비 − 쿠폰비 − 광고비 − 부가세(사용자 확정,
  // 2026-08-17) — 확정일은 WING의 profit_amount에 이미 다 반영돼 있어 그대로 쓰고,
  // 추정일만 직접 이 여섯 항목을 다 뺀다(광고비는 추정 방법이 없어 0으로 고정).
  const estNetProfit = estSettlement - estCoupon - estStorage - vat;
  const netProfit = hasConfirmed ? confirmed.profit_amount : estNetProfit;
  const hasCost = costedQty > 0;

  return {
    date, quantity, revenue,
    commission: hasConfirmed ? confirmed.commission_amount : estCommission,
    fulfillment: hasConfirmed ? confirmed.fulfillment_amount : estFulfillment,
    storage: hasConfirmed ? confirmed.storage_amount : estStorage,
    vat,
    coupon: hasConfirmed ? confirmed.coupon_amount : estCoupon,
    ad: hasConfirmed ? confirmed.ad_amount : 0,
    milkrun: hasConfirmed ? confirmed.milkrun_amount : 0,
    netProfit,
    cost: hasCost ? cost : null,
    shipWork: hasCost ? shipWork : null,
    operatingProfit: hasCost ? (netProfit - cost - shipWork) : null,
    // itemRevenue와 같은 이유로, hasConfirmed 여부와 무관하게 옵션별 추정치를
    // 그대로 같이 들고 있는다 — renderReconcileNote()가 확정값과 대조할 때 씀
    // (2026-08-17, 수수료+입출고비·순이익도 매출처럼 대조하기 위해 추가).
    confirmed: hasConfirmed, itemRevenue,
    itemFeeCombined: estCommission + estFulfillment, itemNetProfit: estNetProfit
  };
}

/* fromDate~toDate 범위의 옵션별 판매(gross+wing 병합)와 확정 정산을 한 번에 불러와
   날짜별로 묶는다. 상단 고정기간 카드·일별 상세표·상품별 상세표가 이 결과 하나를 공유한다. */
async function fetchSalesRange(fromDate, toDate) {
  const [grossRows, wingRows, profitRows] = await Promise.all([
    api(
      `rocket_growth_sales_daily?select=sale_date,vendor_item_id,product_name,quantity,revenue` +
      `&sale_date=gte.${fromDate}&sale_date=lte.${toDate}`
    ),
    api(
      `rocket_growth_sales_wing_daily?select=sale_date,vendor_item_id,product_name,quantity,revenue` +
      `&sale_date=gte.${fromDate}&sale_date=lte.${toDate}`
    ),
    api(
      `rocket_growth_profit_daily?select=sale_date,total_sales_amount,total_deduction_amount,net_sales_amount,` +
      `commission_amount,fulfillment_amount,storage_amount,coupon_amount,ad_amount,milkrun_amount,profit_amount` +
      `&sale_date=gte.${fromDate}&sale_date=lte.${toDate}`
    )
  ]);

  /* 날짜 단위로 병합한다(항목별 병합 아님, 2026-08-16 수정) — WING의
     sold-vendor-item-list는 그 날짜를 동기화했다면 "순매출이 있는 항목 전체"를
     완전한 목록으로 준다. 그런데 당일 매입+반품으로 순매출이 정확히 0이 된 항목은
     그 목록 자체에서 빠진다(0을 보여주는 게 아니라 아예 없음). 예전엔 항목별로
     "WING에 있으면 WING, 없으면 Open API" 식으로 병합해서, 이런 순제로 항목이
     Open API의 반품 반영 전 값 그대로 남아 매출이 과다 계상되는 버그가 있었다
     (실사용 중 발견: 2026-08-15에 "덴넬 빅치즈...510g"가 당일 매입+반품으로 WING
     목록엔 없는데 Open API엔 12,900원으로 남아있어 그만큼 이중 계상됨).
     그래서 "이 날짜에 WING 데이터가 하나라도 있으면 그 날짜는 WING만 쓰고
     Open API는 통째로 무시"로 바꿨다 — WING이 그 날짜를 동기화했다면 원래
     완전한 목록이라 섞을 필요가 없다. WING이 아예 동기화 안 된 날짜만
     Open API로 폴백한다(반품 미반영이라 부정확할 수 있지만 없는 것보단 낫다). */
  const wingDates = new Set((wingRows || []).map((r) => r.sale_date));
  const byDate = {};
  (grossRows || []).forEach((r) => {
    if (wingDates.has(r.sale_date)) return; // 이 날짜는 WING이 완전한 진실 — Open API 무시
    (byDate[r.sale_date] = byDate[r.sale_date] || []).push(r);
  });
  (wingRows || []).forEach((r) => {
    (byDate[r.sale_date] = byDate[r.sale_date] || []).push(r);
  });

  const profitByDate = {};
  (profitRows || []).forEach((r) => { profitByDate[r.sale_date] = r; });

  const vendorItemIds = Array.from(new Set(
    Object.values(byDate).flat().map((r) => r.vendor_item_id)
  ));

  return { byDate, profitByDate, vendorItemIds, hasWing: wingDates.size > 0 };
}

function sumDailyRows(dailyRows) {
  const revenue = dailyRows.reduce((s, r) => s + r.revenue, 0);
  const coupon = dailyRows.reduce((s, r) => s + r.coupon, 0);
  const netProfit = dailyRows.reduce((s, r) => s + r.netProfit, 0);
  const costedRows = dailyRows.filter((r) => r.operatingProfit != null);
  const operatingProfit = costedRows.length ? costedRows.reduce((s, r) => s + r.operatingProfit, 0) : null;
  return { revenueNetCoupon: revenue - coupon, netProfit, operatingProfit };
}

/* 상단 고정기간 카드(이번 달/이번 주/최근 7일/오늘) — 조회 기간 선택과 무관하게 항상 표시.
   매출은 항상 확정 쿠폰비를 뺀 금액(사용자 요청). */
function renderPeriodCards(dailyByDate, todayStr) {
  const periods = [
    { label: '이번 달', from: startOfMonthStr(todayStr), to: todayStr },
    { label: '이번 주', from: mondayOnOrBefore(todayStr), to: todayStr },
    { label: '최근 7일', from: addDaysStr(todayStr, -6), to: todayStr },
    { label: '오늘', from: todayStr, to: todayStr }
  ];

  $('#periodBody').innerHTML = periods.map((p) => {
    const rows = dateRangeList(p.from, p.to).map((d) => dailyByDate[d]).filter(Boolean);
    const s = sumDailyRows(rows);
    return `
<tr>
  <td>${p.label}</td>
  <td class="col-num" data-label="매출(쿠폰 제외)">${won(s.revenueNetCoupon)}</td>
  <td class="col-num" data-label="순수익"><span class="${s.netProfit >= 0 ? 'pos' : 'neg'}">${s.netProfit.toLocaleString()}원</span></td>
  <td class="col-num" data-label="영업이익">${
    s.operatingProfit != null
      ? `<span class="${s.operatingProfit >= 0 ? 'pos' : 'neg'}">${s.operatingProfit.toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
  }).join('');
}

/* 조회 기간(salesFrom~salesTo)만 표시하는 일별 상세표. 날짜가 2개 이상이면 맨 위에
   합계 행을 고정 표시한다(사용자 요청, 2026-08-16) — 날짜 정렬과 무관하게 항상 맨 위. */
function renderDailyTable(dailyByDate, fromDate, toDate) {
  const dates = dateRangeList(fromDate, toDate).slice().reverse(); // 최신 날짜가 위로
  const rows = dates.map((d) => dailyByDate[d]).filter(Boolean);

  $('#dailyEmpty').classList.toggle('hidden', rows.length > 0);
  const totalHtml = rows.length > 1 ? dailyRowHtml(sumDailyFullRows(rows), '합계', true) : '';
  $('#dailyBody').innerHTML = totalHtml + rows.map((r) => dailyRowHtml(r, r.date, false)).join('');
}

/* 일별 상세표 한 줄 렌더러 — 날짜별 행과 맨 위 합계 행이 이 함수 하나를 공유한다. */
function dailyRowHtml(r, dateLabel, isTotal) {
  return `
<tr class="${isTotal ? 'daily-total-row' : ''}">
  <td data-label="날짜">${dateLabel}</td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(r.commission)}</td>
  <td class="col-num" data-label="입출고비">${won(r.fulfillment)}</td>
  <td class="col-num" data-label="보관비">${won(r.storage)}</td>
  <td class="col-num" data-label="부가세">${won(r.vat)}</td>
  <td class="col-num" data-label="쿠폰비">${won(r.coupon)}</td>
  <td class="col-num" data-label="광고비">${won(r.ad)}</td>
  <td class="col-num" data-label="밀크런">${won(r.milkrun)}</td>
  <td class="col-num" data-label="순이익"><span class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${r.netProfit.toLocaleString()}원</span></td>
  <td class="col-num" data-label="원가">${r.cost != null ? won(r.cost) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="배송·작업비">${r.shipWork != null ? won(r.shipWork) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="영업이익">${
    r.operatingProfit != null
      ? `<span class="${r.operatingProfit >= 0 ? 'pos' : 'neg'}">${r.operatingProfit.toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
}

/* renderDailyTable() 합계 행 전용 — sumDailyRows()(상단 카드용, 매출/순이익/영업이익 3개만)와
   달리 일별 상세표의 모든 칸을 채워야 해서 별도로 둔다. cost/shipWork/operatingProfit은
   원가 입력된 날짜만 골라 합산(부분 계산 허용 관례, buildDailyRow()와 동일). */
function sumDailyFullRows(rows) {
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const costedRows = rows.filter((r) => r.cost != null);
  return {
    quantity: sum('quantity'), revenue: sum('revenue'), commission: sum('commission'),
    fulfillment: sum('fulfillment'), storage: sum('storage'), vat: sum('vat'), coupon: sum('coupon'),
    ad: sum('ad'), milkrun: sum('milkrun'), netProfit: sum('netProfit'),
    cost: costedRows.length ? costedRows.reduce((s, r) => s + r.cost, 0) : null,
    shipWork: costedRows.length ? costedRows.reduce((s, r) => s + r.shipWork, 0) : null,
    operatingProfit: costedRows.length ? costedRows.reduce((s, r) => s + r.operatingProfit, 0) : null
  };
}

/* 정산현황 API는 계정 전체 합계만 주고 어떤 상품이 팔렸는지는 없다(docs/api-notes.md 4-4-4) —
   그래서 상품별 합산과 정산 매출을 서로 다른 소스에서 각각 만들 수밖에 없고, 둘이 구조적으로
   100% 일치할 보장이 없다. 조회 기간 안에 확정 정산이 있는 날짜만 골라 매출·수수료+입출고비·
   순이익 세 가지를 대조해서 보여준다(2026-08-17, 원래 매출만 보던 걸 확장 — 사용자가 8/16
   수수료+입출고비·순이익이 다르다고 지적해서 원인을 조사했고, 그 결과를 매번 수동으로 찾을
   필요 없이 화면에서 바로 보이게 함).

   **알려진 구조적 원인 두 가지(2026-08-17 조사, docs/decisions.md 참조)**:
   1. 상품별 수수료·입출고비 추정은 WING 재고현황의 "예상(개당)" 값(부가세 별도)에
      ×1.1(부가세)을 보정해서 쓴다(`withSnapshotVat()`) — 이걸로 수수료 쪽 차이는
      거의 없어짐(8/16 실측: 정확히 일치).
   2. 입출고비는 보정해도 차이가 남을 수 있다 — 당일 매입+당일 반품으로 순수량이
      정확히 0이 된 옵션은 WING 판매목록(`sold-vendor-item-list`) 자체에서 빠져서
      (0으로 안 찍히고 아예 없음) 그 옵션의 반품처리비가 상품별 어디에도 안 잡힌다.
      이건 코드로 못 고치는 한계 — WING에 반품만 따로 보여주는 API가 있는지 별도
      조사 중(2026-08-17 착수). */
function renderReconcileNote(dailyByDate, fromDate, toDate) {
  const note = $('#salesReconcileNote');
  const rows = dateRangeList(fromDate, toDate).map((d) => dailyByDate[d]).filter((r) => r && r.confirmed);
  if (!rows.length) { note.classList.add('hidden'); return; }

  const sums = {
    revenue: [rows.reduce((s, r) => s + r.itemRevenue, 0), rows.reduce((s, r) => s + r.revenue, 0), '매출'],
    fee: [rows.reduce((s, r) => s + r.itemFeeCombined, 0), rows.reduce((s, r) => s + r.commission + r.fulfillment, 0), '수수료+입출고비'],
    profit: [rows.reduce((s, r) => s + r.itemNetProfit, 0), rows.reduce((s, r) => s + r.netProfit, 0), '순이익']
  };

  const lines = Object.values(sums)
    .map(([itemSum, settleSum, label]) => ({ itemSum, settleSum, label, diff: itemSum - settleSum }))
    .filter((x) => Math.abs(x.diff) >= 1);
  if (!lines.length) { note.classList.add('hidden'); return; }

  note.innerHTML =
    `대조: 확정 정산이 있는 ${rows.length}일 기준 — 옵션별 합산 vs 정산현황(둘 다 부가세 보정 반영):<br>` +
    lines.map((x) => `${x.label} ${x.itemSum.toLocaleString()}원 vs ${x.settleSum.toLocaleString()}원 (차이 ${x.diff.toLocaleString()}원)`).join(' · ') +
    `<br><span class="dim xs">수수료+입출고비·순이익 차이는 주로 당일 매입+당일 반품으로 순수량이 0이 된 옵션의 반품처리비가 WING 판매목록 자체에서 빠지기 때문(구조적 한계, web/CLAUDE.md 참조)</span>`;
  note.classList.remove('hidden');
}

/* 상품별 실제 원가정보(개당 수수료/입출고비/보관비) — WING 재고현황 API 기반(docs/api-notes.md 4-4-6).
   덮어쓰지 않고 스냅샷으로 쌓이므로(db/migrations/012), 조회하는 날짜 이전 중 가장 최근
   스냅샷을 골라 써야 "가격 바뀌기 전에 팔린 건 바뀌기 전 요율로" 계산된다. */
async function loadItemCostSnapshots(vendorItemIds) {
  const out = {};
  if (!vendorItemIds.length) return out;
  // 조회 기간 끝 날짜로 필터링하지 않는다 — 예전엔 "captured_at <= 조회기간 끝"으로
  // 걸렀는데, 스냅샷이 전부 조회기간보다 나중에 찍혔으면(예: 오늘 막 처음 갱신했는데
  // "어제"만 조회) 그 필터가 스냅샷을 통째로 걸러내서 snapshotAsOf()의 참고용 폴백
  // (그 상품에 있는 것 중 가장 이른 스냅샷 사용)까지 같이 막아버리는 버그가 있었다
  // (2026-08-16 실사용 중 발견). snapshotAsOf() 자체가 이미 "그 날짜 이전 것 우선,
  // 없으면 가장 이른 것"을 골라내므로 여기서는 전체를 다 가져오기만 하면 된다.
  const rows = await api(
    `rocket_growth_item_cost_snapshots?select=vendor_item_id,captured_at,commission_amount,fulfillment_amount,coupon_amount,monthly_storage_fee_amount` +
    `&vendor_item_id=in.(${vendorItemIds.map(encodeURIComponent).join(',')})` +
    `&order=vendor_item_id.asc,captured_at.asc`
  ) || [];
  rows.forEach((r) => { (out[r.vendor_item_id] = out[r.vendor_item_id] || []).push(r); });
  return out; // 이미 captured_at 오름차순 — 아이템별 배열
}

/* 상품별 원가 스냅샷(commission_amount/fulfillment_amount)은 WING 재고현황의
   "예상(개당)" 툴팁 값 — 부가세 별도. 반면 확정 정산(rocket_growth_profit_daily)의
   commission_amount/fulfillment_amount는 필드명 자체가 totalTakeRateAmountWithVat/
   totalCfsAmountWithVat, 즉 부가세 포함이다. 2026-08-17 실사용 대조로 확인:
   8/16 스냅샷 기반 수수료 합(3,758원)×1.1=4,134원이 그날 확정 수수료(4,134원)와
   정확히 일치 — 부가세 차이였다는 걸 산술로 검증함(`docs/decisions.md` 참조).
   **카테고리 요율 폴백(commissionFor/feeFor)에는 이 보정을 적용하지 않는다** —
   그쪽은 부가세 포함 여부를 검증한 적이 없어서(요율표·요금표 출처가 다름), 근거
   없이 같은 보정을 씌우면 오히려 새로운 오차를 만들 수 있다. 쿠폰비(coupon_amount)도
   보정 대상 아님 — 8/16 대조에서 쿠폰비는 보정 없이 이미 정확히 일치했다. */
const SNAPSHOT_VAT_RATE = 1.1;
function withSnapshotVat(amount) {
  return amount == null ? amount : Math.round(amount * SNAPSHOT_VAT_RATE);
}

/* dateStr 하루 끝(KST) 시점에 유효했던 가장 최근 스냅샷. 시각 비교는 오프셋이 서로 다른
   ISO 문자열(DB는 +00:00, 여기선 +09:00)이라 문자열 비교가 아니라 epoch ms로 해야 한다. */
function snapshotAsOf(snapshots, dateStr) {
  if (!snapshots || !snapshots.length) return null;
  const cutoffMs = new Date(`${dateStr}T23:59:59.999+09:00`).getTime();
  let picked = null;
  for (const s of snapshots) {
    if (new Date(s.captured_at).getTime() <= cutoffMs) picked = s; else break;
  }
  if (picked) return { snap: picked, exact: true };
  // 그 날짜 이전 스냅샷이 없으면(스냅샷을 도입하기 전에 팔린 과거 판매 — 예: 처음
  // "상품 원가정보 갱신"을 누르기 전 날짜들) 그 상품에 있는 것 중 가장 이른 스냅샷을
  // 참고값으로 쓴다. 그 날짜의 진짜 요율이 아닐 수 있다는 걸 알고 쓸 것 — 사용자가
  // "정산현황과 맞는지 검증해보려고" 과거 날짜도 빈칸 대신 값을 채워달라고 요청함
  // (2026-08-16). renderSales()에서 이 경우만 exact:false로 구분해 표시한다.
  return { snap: snapshots[0], exact: false };
}

/* 보관비는 "이번 달 누적" 스냅샷 하나뿐이라 일별로 못 쪼갠다(사용자 확인, 2026-08-16) —
   가장 최근 스냅샷의 누적액을 그 스냅샷 시점까지의 이번 달 경과일수로 나눠 일평균을 낸 뒤
   조회 기간 일수만큼 곱해 참고용으로 배분한다. 영업이익 계산엔 포함하지 않는다(사용자 명시). */
function storageAllocationForItem(snapshots, rangeDayCount) {
  if (!snapshots || !snapshots.length) return null;
  const latest = snapshots[snapshots.length - 1];
  const dayOfMonth = parseInt(kstDateStr(new Date(latest.captured_at)).split('-')[2], 10);
  if (!dayOfMonth) return null;
  const dailyRate = latest.monthly_storage_fee_amount / dayOfMonth;
  return {
    monthly: latest.monthly_storage_fee_amount,
    allocated: Math.round(dailyRate * rangeDayCount)
  };
}

async function fetchAndRenderSales(fromDate, toDate) {
  $('#salesMsg').classList.add('hidden');
  $('#dailyEmpty').classList.add('hidden');
  $('#dailyBody').innerHTML = '';
  $('#salesEmpty').classList.add('hidden');
  $('#salesBody').innerHTML = '';
  $('#salesLoader').classList.remove('hidden');
  $('#dailyLoader').classList.remove('hidden');

  try {
    const todayStr = kstDateStr(new Date());
    // 상단 고정기간 카드(이번 달 등)까지 커버하도록 조회 범위를 필요한 만큼 넓힌다
    const fetchFrom = [startOfMonthStr(todayStr), mondayOnOrBefore(todayStr), addDaysStr(todayStr, -6), fromDate].sort()[0];
    const fetchTo = toDate > todayStr ? toDate : todayStr;

    const { byDate, profitByDate, vendorItemIds, hasWing } = await fetchSalesRange(fetchFrom, fetchTo);

    await state.readyForMargins; // feeCache 로딩 대기 (enterApp에서 이미 시작됨)
    const meta = await loadItemMeta(vendorItemIds);
    // 상단 카드·일별 상세표의 추정치도 상품/옵션별 상세표와 같은 실제 개당 원가 스냅샷을
    // 우선 쓰도록 여기서 한 번만 불러와 공유한다(2026-08-16 개선, 아래 buildDailyRow 참조) —
    // 조회 범위 전체(fetchFrom~fetchTo)를 커버하니 뒤에서 renderSales()용으로 다시 불러올
    // 필요 없다.
    const costSnapshots = await loadItemCostSnapshots(vendorItemIds);
    // 발주·출고에서 확정된 실제 매입원가(선입선출) — 원가·영업이익이 이걸 우선 쓴다
    const lotCogs = await loadLotCogs(vendorItemIds);
    // 등록상품ID·상품ID(옵션ID 클릭용) — meta에 병합해서 renderSales()가 그대로 씀.
    const registry = await loadProductRegistry(vendorItemIds);
    vendorItemIds.forEach((vid) => {
      if (registry[vid]) Object.assign(meta[vid], registry[vid]);
    });

    const dailyByDate = {};
    dateRangeList(fetchFrom, fetchTo).forEach((d) => {
      dailyByDate[d] = buildDailyRow(d, byDate[d] || [], meta, profitByDate[d], costSnapshots, lotCogs);
    });

    renderPeriodCards(dailyByDate, todayStr);
    renderDailyTable(dailyByDate, fromDate, toDate);
    renderReconcileNote(dailyByDate, fromDate, toDate);

    const rangeTxt = fromDate === toDate ? fromDate : `${fromDate} ~ ${toDate}`;
    $('#salesSummary').textContent = `${rangeTxt} 기준 (로켓그로스 Open API${hasWing ? ' + WING 반품 반영' : ''})`;

    // 상품/옵션별 표는 선택한 기간(fromDate~toDate)만 다루되, 날짜별로 묶어서 보여준다
    // — 아래 renderSales() 참조.
    const rangeDates = dateRangeList(fromDate, toDate);
    const hasAnyInRange = rangeDates.some((d) => (byDate[d] || []).length);

    if (!hasAnyInRange) {
      $('#salesEmpty').classList.remove('hidden');
      return;
    }

    renderSales(rangeDates, byDate, meta, costSnapshots, profitByDate, lotCogs);
  } catch (e) {
    $('#salesMsg').textContent = '판매현황을 불러오지 못했습니다: ' + e.message;
    $('#salesMsg').classList.remove('hidden');
  } finally {
    $('#salesLoader').classList.add('hidden');
    $('#dailyLoader').classList.add('hidden');
  }
}

function mdFmt(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/* 쿠팡 실제 판매 페이지 URL(옵션ID 클릭 시 이동, 사용자 요청 2026-08-16) — 등록정보
   레지스트리(rocket_growth_product_registry)에 그 옵션이 아직 없으면(동기화 전이거나
   로켓그로스 상품이 아님) null 반환, 호출부에서 링크 없이 표시. itemId는 지금 안 받아오므로
   (SKU ID 보류, 위 loadProductRegistry 참조) 빼고 productId+vendorItemId만으로 연결한다
   — docs/api-notes.md 2-5에 정리된 URL 시도 순서 중 "?vendorItemId=" 패턴, 실사용 확인됨. */
function coupangProductUrl(m, vid) {
  if (!m || !m.productId) return null;
  return `https://www.coupang.com/vp/products/${encodeURIComponent(m.productId)}?vendorItemId=${encodeURIComponent(vid)}`;
}

/* 상품/옵션별 상세표 — 2026-08-16 오후 재개편(날짜별 그룹핑, docs/decisions.md 참조)에
   이어 2026-08-17에 부가세·보관비 처리를 다시 손봤다.
   **수수료/입출고비는 다시 별도 컬럼이다**(2026-08-16엔 "수수료 및 입출고비" 하나로
   합쳤었는데, 사용자가 다시 나눠달라고 요청 — 개별 상품 행까지 전부 적용).
   **보관비는 더 이상 옵션 단위로 안 나온다** — WING 자신도 "고정 보관비"는 그날 팔린
   특정 주문에 묶이지 않은, 재고 전체 기준 하루치 총액이라(사용자 확인) 개별 옵션에
   배분하는 게 억지 정밀도였다. 그래서 옵션 행은 보관비를 "—"로 두고, **날짜 그룹
   헤더(합계 행)에서만** 그 날짜의 확정 정산(`rocket_growth_profit_daily.storage_amount`)을
   그대로 가져와 보여준다(`profitByDate` 필요) — 확정 정산이 없는 날(예: 오늘)은 "—".
   **부가세도 새로 추가됨** — WING "수익 현황" 화면(사용자 스크린샷, 2026-08-17)에서
   "부가가치세 = 조회 기간 요금의 10%"임을 확인했다. 옵션 행은 그 옵션의 입출고비만
   기준으로 10%(보관비를 옵션 단위로 안 다루니 여기엔 보관비 몫이 없음), 날짜 합계
   행은 옵션별 부가세 합 + 그 날짜 고정 보관비의 10%까지 더해서 완전하게 계산한다.
   **순이익 = 매출 − 수수료 − 입출고비 − 보관비 − 쿠폰비 − 광고비 − 부가세**
   (사용자 확정 공식, 2026-08-17) — 옵션 행은 보관비 항이 없어 6개 항만 빼고, 날짜
   합계 행에서 그 날짜의 고정 보관비와 그 부가세를 추가로 뺀다. */
function renderSales(rangeDates, byDate, meta, costSnapshots, profitByDate, lotCogs) {
  let costedCount = 0, noCommissionCount = 0, estimatedCount = 0, approxCount = 0, rowCount = 0;

  const sections = rangeDates.slice().reverse().map((date) => {
    const rows = (byDate[date] || []).map((r) => {
      const vid = r.vendor_item_id;
      const m = meta[vid] || {};
      const avgPrice = r.quantity ? r.revenue / r.quantity : 0;
      const snapResult = snapshotAsOf(costSnapshots[vid], date);

      let commissionRate, fulfillmentAmt, couponAmt, hasApprox = false, hasEstimate = false;
      if (snapResult) {
        if (!snapResult.exact) hasApprox = true; // 그 날짜 이전 스냅샷이 없어 이후 스냅샷을 대신 씀
        commissionRate = avgPrice > 0 ? (withSnapshotVat(snapResult.snap.commission_amount) / avgPrice * 100) : 0;
        fulfillmentAmt = snapResult.snap.fulfillment_amount; // 세전 원값 — 부가세는 아래서 따로 계산
        couponAmt = snapResult.snap.coupon_amount || 0;
      } else {
        hasEstimate = true;
        commissionRate = commissionFor(m.catCode);
        fulfillmentAmt = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
        couponAmt = 0; // 카테고리 요율표엔 쿠폰 개념이 없어 추정 불가
      }

      rowCount++;
      const url = coupangProductUrl(m, vid);
      if (commissionRate == null) {
        noCommissionCount++;
        return {
          vid, name: r.product_name, url, productId: m.productId, sellerProductId: m.sellerProductId,
          quantity: r.quantity, revenue: r.revenue, noCommission: true
        };
      }
      if (hasEstimate) estimatedCount++;
      else if (hasApprox) approxCount++;

      const lc = lotCogs && lotCogs.get(`${date}|${vid}`);
      const c = calcMargin({
        price: avgPrice, commission: commissionRate, fulfillment: fulfillmentAmt,
        costKrw: lc ? lc.unit : null,
        costCny: m.costCny, rate: m.exchangeRate, outbound: m.outboundFee, work: m.workFee
      });
      const commission = c ? c.commission * r.quantity : 0;
      const fulfillment = (c && fulfillmentAmt != null) ? fulfillmentAmt * r.quantity : 0;
      const coupon = couponAmt * r.quantity;
      const settlement = c ? c.settlement * r.quantity : 0;
      const vat = Math.round(fulfillment * 0.1); // 보관비 몫은 옵션 단위가 아니라 날짜 합계에서 더함
      // storageAllocationForItem은 이제 순이익에 안 쓰지만, "이번달 누적보관비" 참고용
      // 표시(상세 펼치기)엔 여전히 씀 — 그 상품 자체의 보관비 규모를 가늠하는 용도.
      const storageInfo = storageAllocationForItem(costSnapshots[vid], 1);
      const netProfit = settlement - coupon - vat;
      const hasCost = !!(c && c.margin != null);
      if (hasCost) costedCount++;

      return {
        vid, name: r.product_name, url, productId: m.productId, sellerProductId: m.sellerProductId,
        quantity: r.quantity, revenue: r.revenue,
        commission, fulfillment, vat, coupon,
        storageMonthly: storageInfo ? storageInfo.monthly : null,
        netProfit,
        cost: hasCost ? c.cost * r.quantity : null,
        shipWork: hasCost ? c.shipWork * r.quantity : null,
        operatingProfit: hasCost ? (netProfit - c.cost * r.quantity - c.shipWork * r.quantity) : null,
        // 우선순위: 카테고리 추정을 쓰면 "(추정)", 아니면 스냅샷은 있는데 그 날짜 이전 게
        // 아니라 이후 것(참고용)을 쓰면 "(참고용)", 둘 다 없으면 라벨 없음.
        label: hasEstimate ? '(추정)' : (hasApprox ? '(참고용)' : '')
      };
    });
    const confirmedStorage = profitByDate[date] ? profitByDate[date].storage_amount : null;
    return { date, rows, confirmedStorage };
  }).filter((sec) => sec.rows.length);

  const uncosted = rowCount - costedCount - noCommissionCount;
  const notes = [];
  if (uncosted > 0) notes.push(`원가 미입력 ${uncosted}건`);
  if (noCommissionCount > 0) notes.push(`수수료 정보 없는 판매 ${noCommissionCount}건`);
  if (estimatedCount > 0) notes.push(`상품 원가정보 스냅샷 없어 카테고리 추정을 쓴 판매 ${estimatedCount}건`);
  if (approxCount > 0) notes.push(`판매 시점 이전 스냅샷이 없어 이후 스냅샷(참고용)을 쓴 판매 ${approxCount}건`);
  $('#salesTableNote').textContent = notes.length ? `${notes.join(' · ')}` : '';

  $('#salesBody').innerHTML = sections.map((sec) => {
    const headHtml = dateGroupHeadHtml(sec.date, sec.rows, sec.confirmedStorage);
    const rowsHtml = sec.rows.map((r) => salesRowHtml(r)).join('');
    return headHtml + rowsHtml;
  }).join('');
}

/* 등록상품ID·옵션ID를 WING 상품 목록 화면과 같은 순서·구분자("·")로 보여준다
   (사용자가 WING 화면 스크린샷으로 요청, 2026-08-16) — WING도 옵션ID(=vendorItemId)에만
   외부링크 아이콘을 붙여 클릭 가능하게 하므로 우리도 옵션ID만 <a>로 감싼다.
   등록상품ID=rocket_growth_product_registry.seller_product_id(공식 Open API "상품 목록
   페이징 조회"로 채움, docs/api-notes.md 4-7) — 그 옵션이 레지스트리 동기화 전이면 "—".
   **SKU ID는 뺐다(2026-08-16 사용자 결정)** — 공식 Open API 세 개(상품목록/상품조회/
   재고) 어디에도 WING이 보여주는 8자리 SKU ID와 자릿수가 맞는 필드가 없어서, 나중에
   재고 페이지를 만들 때 WING 내부 API 캡처로 다시 조사하기로 함. */
function optionSubtitle(r) {
  const pid = r.sellerProductId ? esc(r.sellerProductId) : '—';
  const vidHtml = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" title="옵션ID — 쿠팡 판매 페이지로 이동" onclick="event.stopPropagation()">${esc(r.vid)}</a>`
    : `<span title="옵션ID">${esc(r.vid)}</span>`;
  return `<div class="psub"><span title="등록상품ID">${pid}</span> · ${vidHtml}</div>`;
}

/* 그 날짜의 상품/옵션 행들을 합산 — 일별 상세표의 같은 날짜 행(확정 정산 또는 추정)과
   나란히 비교하기 쉽게 하려고 둠(사용자 요청, 2026-08-17). 두 표는 애초에 서로 다른
   API에서 나온 값이라(일별 상세표는 계정 전체 합계인 확정 정산 or 옵션별 추정, 이 표는
   상품마다 실제 스냅샷/카테고리 추정을 항목별로 더한 것) 100% 일치를 보장 못 한다 —
   `renderReconcileNote()`가 이미 매출 기준으로 이 구조적 차이를 안내하고 있음, 여기서는
   나머지 항목도 한눈에 비교할 수 있게 보여주기만 한다.

   보관비·부가세는 옵션별 합이 아니다 — confirmedStorage(그 날짜의 확정 고정 보관비,
   없으면 null)를 여기서 한 번만 반영한다: 옵션별 부가세 합에 "고정 보관비의 10%"를
   더하고, 순이익에서도 옵션별 순이익 합에서 고정 보관비와 그 부가세를 추가로 뺀다
   (옵션 행 각각은 보관비 항이 아예 없어서 이렇게 날짜 합계 단계에서만 반영 가능). */
function sumSalesRows(rows, confirmedStorage) {
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const costedRows = rows.filter((r) => r.cost != null);
  const storage = confirmedStorage != null ? confirmedStorage : null;
  const storageVat = storage != null ? Math.round(storage * 0.1) : 0;
  return {
    quantity: sum('quantity'), revenue: sum('revenue'),
    commission: sum('commission'), fulfillment: sum('fulfillment'),
    storage, vat: sum('vat') + storageVat, coupon: sum('coupon'),
    netProfit: sum('netProfit') - (storage || 0) - storageVat,
    operatingProfit: costedRows.length ? costedRows.reduce((s, r) => s + r.operatingProfit, 0) : null
  };
}

function dateGroupHeadHtml(date, rows, confirmedStorage) {
  const s = sumSalesRows(rows, confirmedStorage);
  return `
<tr class="date-group-head">
  <td>${date} (${mdFmt(date)}) <span class="muted xs">${rows.length}건</span></td>
  <td class="col-num" data-label="판매수량">${cnt(s.quantity)}</td>
  <td class="col-num" data-label="매출">${won(s.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(Math.round(s.commission))}</td>
  <td class="col-num" data-label="입출고비">${won(Math.round(s.fulfillment))}</td>
  <td class="col-num" data-label="보관비">${s.storage != null ? won(s.storage) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="부가세">${won(s.vat)}</td>
  <td class="col-num" data-label="광고비"><span class="dim">—</span></td>
  <td class="col-num" data-label="쿠폰비">${won(Math.round(s.coupon))}</td>
  <td class="col-num" data-label="순이익"><span class="${s.netProfit >= 0 ? 'pos' : 'neg'}">${Math.round(s.netProfit).toLocaleString()}원</span></td>
  <td class="col-num" data-label="영업이익">${
    s.operatingProfit != null
      ? `<span class="${s.operatingProfit >= 0 ? 'pos' : 'neg'}">${Math.round(s.operatingProfit).toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
}

function salesRowHtml(r) {
  const name = esc(r.name || '(이름 없음)');
  // 광고비는 계정 전체 합계로만 나와 상품별로 못 구한다(WING 정산현황·재고현황 둘 다 항목
  // 단위 데이터 없음, 2026-08-16 확인) — 나중에 외부 연동이 생기면 채울 자리만 미리 만들어둠.
  const adCell = '<span class="dim" title="상품별 광고비는 아직 연동된 데이터 소스가 없습니다(추후 연동 예정)">—</span>';
  if (r.noCommission) {
    return `
<tr>
  <td>
    <div class="pname"><span>${name}</span></div>
    ${optionSubtitle(r)}
  </td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="입출고비"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="보관비"><span class="dim">—</span></td>
  <td class="col-num" data-label="부가세"><span class="dim">—</span></td>
  <td class="col-num" data-label="광고비">${adCell}</td>
  <td class="col-num" data-label="쿠폰비"><span class="dim">—</span></td>
  <td class="col-num" data-label="순이익"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="영업이익"><span class="dim">수수료 정보 없음</span></td>
</tr>`;
  }
  const est = r.label ? ` <span class="dim xs">${r.label}</span>` : '';
  return `
<tr class="prow">
  <td>
    <div class="pname"><svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><span>${name}</span></div>
    ${optionSubtitle(r)}
  </td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(Math.round(r.commission))}${est}</td>
  <td class="col-num" data-label="입출고비">${won(Math.round(r.fulfillment))}${est}</td>
  <td class="col-num" data-label="보관비"><span class="dim" title="이 옵션 하나에만 귀속되지 않는 재고 전체 기준 비용이라 날짜 합계 행에서만 보여줍니다">—</span></td>
  <td class="col-num" data-label="부가세">${won(r.vat)}</td>
  <td class="col-num" data-label="광고비">${adCell}</td>
  <td class="col-num" data-label="쿠폰비">${won(Math.round(r.coupon))}${est}</td>
  <td class="col-num" data-label="순이익"><span class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${Math.round(r.netProfit).toLocaleString()}원</span></td>
  <td class="col-num" data-label="영업이익">${
    r.operatingProfit != null
      ? `<span class="${r.operatingProfit >= 0 ? 'pos' : 'neg'}">${Math.round(r.operatingProfit).toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>
<tr class="detail hidden"><td colspan="11"><div class="detail-inner">
  <div class="kv-grid">
    <div class="kv"><span class="kv-k">이번달 누적보관비</span><span class="kv-v">${r.storageMonthly != null ? won(r.storageMonthly) : '<span class="dim">—</span>'}</span></div>
    <div class="kv"><span class="kv-k">원가</span><span class="kv-v">${r.cost != null ? won(Math.round(r.cost)) : '<span class="dim">원가 입력 필요</span>'}</span></div>
    <div class="kv"><span class="kv-k">배송·작업비</span><span class="kv-v">${r.shipWork != null ? won(Math.round(r.shipWork)) : '<span class="dim">—</span>'}</span></div>
  </div>
</div></td></tr>`;
}

$('#salesRefresh').onclick = loadSales;
$('#salesBackfillBtn').onclick = backfillSales;
$('#itemCostRefreshBtn').onclick = refreshItemCosts;

/* 상품/옵션별 상세표 행 펼치기 — 소싱 탭(.prow/.detail)과 같은 패턴이지만, 필요한
   값을 renderSales()가 이미 다 계산해서 HTML에 심어뒀으므로 추가 조회 없이 보이기만
   전환한다(사용자 요청, 2026-08-16 — 컬럼이 13개라 상품명 칸이 압착되던 문제 해결).
   detail 행은 항상 그 prow 바로 다음 형제로 붙인다(nextElementSibling으로 찾음) —
   날짜별 그룹핑 이후 같은 vendor_item_id가 여러 날짜 섹션에 중복해서 나올 수 있어서
   (2026-08-16 오후) id로 매칭하면 첫 번째 행만 계속 찾게 되는 버그가 생김. */
$('#salesBody').addEventListener('click', (ev) => {
  const row = ev.target.closest('tr.prow');
  if (!row) return;
  const detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains('detail')) return;
  const open = !detail.classList.contains('hidden');
  detail.classList.toggle('hidden', open);
  row.classList.toggle('open', !open);
});

/* ===================== 필터 · 검색 ===================== */
$('#filterToggle').onclick = () => $('#filterPanel').classList.toggle('hidden');

$('#filterApply').onclick = () => {
  state.filters = {
    root:      $('#fRoot').value,
    category:  $('#fCategory').value,
    delivery:  $('#fDelivery').value,
    priceMin:  $('#fPriceMin').value,
    priceMax:  $('#fPriceMax').value,
    salesMin:  $('#fSalesMin').value,
    salesMax:  $('#fSalesMax').value,
    marginMin: $('#fMarginMin').value,
    marginMax: $('#fMarginMax').value,
    sort:      $('#fSort').value,
    favCatOnly: $('#fFavCatOnly').checked
  };
  const n = Object.values(state.filters).filter((v) => v !== '' && v !== false && v !== 'max_sales').length;
  const b = $('#filterCount');
  b.textContent = n; b.classList.toggle('hidden', n === 0);
  resetAndLoad();
};

$('#filterReset').onclick = () => {
  ['fRoot','fCategory','fDelivery','fPriceMin','fPriceMax','fSalesMin','fSalesMax','fMarginMin','fMarginMax']
    .forEach((id) => { $('#' + id).value = ''; });
  $('#fSort').value = 'max_sales';
  $('#fFavCatOnly').checked = false;
  state.filters = {};
  $('#filterCount').classList.add('hidden');
  resetAndLoad();
};

$('#searchInput').addEventListener('input', debounce((ev) => {
  state.search = ev.target.value.trim();
  if (state.page === 'sourcing') resetAndLoad();
}, 400));

/* 무한 스크롤 — 스크롤 이벤트는 초당 수십 번 오므로 엘리먼트를 매번 찾지 않는다 */
const MAIN_EL = $('.main');
MAIN_EL.addEventListener('scroll', () => {
  if (state.page !== 'sourcing' || state.loading || state.done) return;
  if (MAIN_EL.scrollTop + MAIN_EL.clientHeight >= MAIN_EL.scrollHeight - 320) loadMore();
}, { passive: true });

/* ===================== 내보내기 ===================== */
$('#exportBtn').onclick = () => {
  if (!state.rows.length) return toast('내보낼 데이터가 없습니다');
  const head = ['상품ID','상품명','브랜드','최대판매량','합계판매량','최저가','최고가','옵션수','순위','배송유형','카테고리'];
  const lines = [head.join(',')];
  state.rows.forEach((p) => {
    lines.push([
      p.product_id, p.product_name, p.brand_name, p.max_sales, p.sum_sales,
      p.min_price, p.max_price, p.option_count, p.pv_rank,
      Array.isArray(p.delivery_badges) ? p.delivery_badges.join(' / ') : '',
      p.category_path
    ].map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sourcing_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast(`${state.rows.length}건을 내보냈습니다`);
};

/* ===================== 설정 모달 ===================== */
$('#settingsBtn').onclick = () => {
  $('#setRate').value = settings.rate;
  $('#setOutbound').value = settings.outbound;
  $('#setWork').value = settings.work;
  $('#setSize').value = settings.size;
  $('#settingsMsg').textContent = '';
  $('#settingsModal').classList.remove('hidden');
};

$$('[data-close]').forEach((el) => {
  el.onclick = () => $('#settingsModal').classList.add('hidden');
});

$('#settingsSave').onclick = async () => {
  settings.rate = parseFloat($('#setRate').value) || settings.rate;
  settings.outbound = parseInt($('#setOutbound').value, 10) || 0;
  settings.work = parseInt($('#setWork').value, 10) || 0;
  settings.size = $('#setSize').value;

  try {
    // 개인 설정으로 저장 (공통 settings는 관리자만 수정 가능)
    await api(`profiles?id=eq.${AUTH.userId}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { prefs: settings }
    });
    $('#settingsModal').classList.add('hidden');
    toast('설정을 저장했습니다');
    if (state.page === 'sourcing') resetAndLoad();
  } catch (e) {
    const el = $('#settingsMsg');
    el.className = 'msg err';
    el.textContent = '저장 실패: ' + e.message;
  }
};

/* ===================== 구매대행 청구서 파서 =====================
   쿠플러스(㈜쿠패스) 구매대행 청구서 PDF의 텍스트를 줄 단위 구조로 되돌린다.
   구조와 함정은 docs/decisions.md 2026-08-18 "구매대행 청구서 PDF 구조" 참조.
   여기 다시 요약하는 이유는 이 함수가 그 함정들 위에 통째로 서 있기 때문이다:

   1) **한 줄 = SKU 1개**(옵션 단위). 같은 상품 다른 옵션도 각각 한 줄.
   2) **줄이 "1688 주문 묶음"으로 그룹지어져 있다.** 배송비·총금액은 묶음의 첫 줄에만
      찍히고 나머지 줄은 빈칸이다. → 숫자 개수로 그룹 머리/구성원을 판별한다:
        숫자 7개 = [수량, 협상전단가, 협상전배송비, 협상전총액, 협상후단가, 협상후배송비, 협상후총액]  → 그룹 머리
        숫자 3개 = [수량, 협상전단가, 협상후단가]                                                    → 그룹 구성원
   3) **줄별 KRW가 없다.** ₩ 붙은 3개 값(결제금액/부가세/최종합계)은 문서 전체 합계이고
      첫 줄에 한 번만 나온다. → 환율은 (전체 KRW ÷ 전체 CNY)로 역산한다.
   4) **협상후 단가는 총액에서 역산된 소수점 5자리**(1.04545 등)라 믿으면 안 된다.
      계산 기준은 언제나 그룹 총금액이고, 단가는 표시용이다.

   PDF→텍스트 변환기(pdf-parse 등)마다 줄바꿈 위치가 달라지므로 **줄 구조에 의존하지 않는다** —
   날짜 패턴으로 레코드를 자르고, 각 레코드에서 뒤쪽의 연속된 숫자 토큰만 뽑는다.
   상품명에 "3p" 같은 숫자+문자 토큰이 섞여도 순수 숫자만 세므로 안전하다. */

const PO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const PO_PURE_NUM = /^\d+(\.\d+)?$/;

function parseCouplusInvoice(text) {
  const src = String(text || '').replace(/ /g, ' ');
  /* ── 줄 단위로 읽는 이유 ────────────────────────────────────────
     처음엔 날짜 위치로 텍스트를 잘랐는데, 병합된 칸(배송비·총금액)이 **자기만의 줄**로
     떨어져 나오는 청구서가 있었다(2026-06-26Z, 2026-08-18 발견):

       2026-06-26 growth 말차 샌드위치 슬랑이 6 13 13 NOBARCODE
       9 321 9 321                 <- 이 줄이 직전 상품의 숫자로 붙어버렸다
       2026-06-26 growth 청포도 샌드위치 슬랑이 6 13 13 NOBARCODE

     그래서 줄 단위로 보고, 날짜로 시작하지 않는 줄을 둘로 나눈다:
       (a) 직전 상품 줄이 아직 안 끝났으면 -> 줄바꿈으로 잘린 그 줄의 이어짐
       (b) 이미 끝났으면 -> 묶음의 배송비·총금액만 따로 그려진 줄
     "끝났는지"는 **바코드 칸(숫자가 아닌 토큰)이 나왔는지**로 판단한다.
     추출기에 따라 (a)로도 (b)로도 나오는 걸 실제로 겪어서 둘 다 처리한다. */
  const lines = src.split(/\r?\n/);
  const recs = [];
  const standalone = [];   // 묶음 값만 따로 그려진 줄. {afterRec, nums}
  let cur = null;
  let started = false;

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const dm = line.match(/^(\d{4}-\d{2}-\d{2})\b/);
    if (dm) {
      started = true;
      cur = {
        date: dm[1],
        toks: line.slice(dm[0].length).trim().split(/\s+/).filter(Boolean),
        closed: false
      };
      if (cur.toks.length && !PO_PURE_NUM.test(cur.toks[0])) cur.toks.shift();  // 업체명(growth)
      recs.push(cur);
    } else if (started && cur && !cur.closed) {
      cur.toks = cur.toks.concat(line.split(/\s+/).filter(Boolean));
    } else if (started) {
      standalone.push({
        afterRec: recs.length - 1,
        nums: line.split(/\s+/).filter((t) => PO_PURE_NUM.test(t)).map(Number)
      });
      return;
    } else {
      return;   // 첫 날짜 이전(계좌번호·표 머리글)은 통째로 무시 — 숫자가 섞여 있어 오인 위험
    }
    /* 바코드 칸(숫자가 아닌 토큰)이 나오면 그 상품 줄은 끝난 것으로 본다 */
    if (cur.toks.length && !PO_PURE_NUM.test(cur.toks[cur.toks.length - 1])) cur.closed = true;
  });

  if (!recs.length) return { rows: [], groups: [], totals: null, error: '청구서에서 날짜를 찾지 못했습니다.' };

  const rows = [];
  let totalKrw = null, vatKrw = null, grandKrw = null;

  recs.forEach((rec, recIdx) => {
    const mk = { date: rec.date, recIdx };
    const toks = rec.toks;

    /* 원화 토큰(₩12,345)은 문서 전체 합계 — 첫 레코드에만 나온다 */
    const krw = [];
    const rest = [];
    toks.forEach((t) => {
      if (/[₩₩]/.test(t)) krw.push(Number(t.replace(/[^\d.]/g, '')));
      else rest.push(t);
    });
    if (krw.length >= 3 && totalKrw === null) {
      totalKrw = krw[0]; vatKrw = krw[1]; grandKrw = krw[2];
    }

    /* 바코드 칸은 맨 끝이지만 **공백이 든 여러 토큰일 수 있다** — 실제로 바코드 대신
       "핑크 호빵 스퀴지" 같은 상품명이 적혀 온 청구서가 있었다(2026-07-02).
       그래서 토큰 하나가 아니라 뒤쪽의 "숫자가 아닌 토큰이 이어지는 구간" 전체를 뗀다.
       NOBARCODE면 없는 것으로 본다(샘플 화주수령 등 예외 케이스). */
    let barcode = null;
    let b = rest.length;
    while (b > 0 && !PO_PURE_NUM.test(rest[b - 1])) b--;
    if (b < rest.length) {
      const tail = rest.splice(b).join(' ');
      barcode = /^NOBARCODE$/i.test(tail) ? null : tail;
    } else if (rest.length && /^\d{8,}$/.test(rest[rest.length - 1])) {
      /* 숫자로만 된 바코드는 위 방법으로 안 잡힌다 — 8자리 이상 정수면 바코드로 본다
         (청구서의 수치 칸은 이만큼 커지지 않는다) */
      barcode = rest.pop();
    }

    /* 뒤에서부터 순수 숫자가 이어지는 구간이 수치 영역, 그 앞이 상품명 */
    let k = rest.length;
    while (k > 0 && PO_PURE_NUM.test(rest[k - 1])) k--;
    const nums = rest.slice(k).map(Number);
    const name = rest.slice(0, k).join(' ').trim();
    if (!name && !nums.length) return;

    rows.push({ date: mk.date, recIdx: mk.recIdx, name, barcode, nums });
  });

  /* ── 묶음 복원 ──────────────────────────────────────────────────
     처음엔 "총금액이 찍힌 줄이 묶음의 첫 줄"이라고 봤는데 **틀렸다**(2026-08-18).
     2026-07-02 청구서에서 총금액이 묶음 한가운데 줄에 찍혀 있었다:

       빨간구슬 21x7.5=157.5   <- 총금액 166.5 (=157.5+9)
       꿀빵     21x9  =189
       망고스틴 16x13 =208     <- 총금액 676.8 (묶음 한가운데!)
       딸기     16x15 =240
                        637 + 39.8 = 676.8

     PDF에서 세로로 병합된 칸이라 값이 어느 줄에 그려지는지가 일정하지 않다.
     위치에 의존하면 못 푼다. 그래서 **산수로 푼다**:

       묶음들은 줄 순서를 끊지 않고 이어지는 덩어리이고,
       각 묶음은  총금액 - 배송비 = 그 묶음 줄들의 (수량 x 단가) 합  을 만족한다.

     그래서 위에서부터 (수량 x 단가)를 누적하다가 다음 총금액과 맞아떨어지는 순간
     거기서 묶음을 끊는다. 위치와 무관하고, 맞으면 그 자체가 검산이 된다. */
  const markers = [];
  const out = rows.map((r) => {
    const n = r.nums;
    return {
      date: r.date, name: r.name, barcode: r.barcode,
      qty: n.length ? n[0] : 0,
      /* 협상후 단가: 7개면 5번째, 3개면 3번째. 협상전 값은 쓰지 않는다 */
      unitCny: n.length >= 7 ? n[4] : (n.length >= 3 ? n[2] : (n.length >= 2 ? n[1] : null)),
      groupIndex: -1, raw: n.slice()
    };
  });
  /* 배송비·총금액은 두 가지 방식으로 나온다 — 상품 줄 안에 섞여 있거나(숫자 7개),
     자기만의 줄로 떨어져 있거나. 둘을 **나온 순서 그대로** 한 줄로 세운다.
     아래 산수 방식은 순서만 맞으면 되고 어느 줄에 붙어 있었는지는 안 본다. */
  rows.forEach((r) => {
    if (r.nums.length >= 7) markers.push({ shippingCny: r.nums[5], totalCny: r.nums[6] });
    standalone.filter((s) => s.afterRec === r.recIdx).forEach((s) => {
      const n = s.nums;
      /* 협상전·협상후가 한 줄에 같이 오면(예: "12 174 8 170") 뒤쪽이 협상후다 */
      if (n.length >= 4) markers.push({ shippingCny: n[n.length - 2], totalCny: n[n.length - 1] });
      else if (n.length === 2) markers.push({ shippingCny: n[0], totalCny: n[1] });
    });
  });

  const r2 = (v) => Math.round(v * 100) / 100;
  const groups = [];
  let mi = 0, acc = 0, start = 0;
  out.forEach((l, i) => {
    acc = r2(acc + (l.qty || 0) * (l.unitCny || 0));
    if (mi < markers.length) {
      const target = r2(markers[mi].totalCny - markers[mi].shippingCny);
      if (Math.abs(acc - target) < 0.02) {
        groups.push({ shippingCny: markers[mi].shippingCny, totalCny: markers[mi].totalCny, lines: [] });
        for (let k = start; k <= i; k++) out[k].groupIndex = groups.length - 1;
        mi++; acc = 0; start = i + 1;
      }
    }
  });
  /* 어느 총금액과도 안 맞고 남은 줄들 — 인식이 깨졌거나 청구서 구조가 또 다른 경우다.
     조용히 버리지 않고 별도 묶음으로 남겨서 확인 화면의 검산 경고에 걸리게 한다. */
  if (start < out.length) {
    groups.push({ shippingCny: 0, totalCny: null, lines: [], leftover: true });
    for (let k = start; k < out.length; k++) out[k].groupIndex = groups.length - 1;
  }
  const unusedMarkers = markers.length - mi;
  out.forEach((l) => { if (groups[l.groupIndex]) groups[l.groupIndex].lines.push(l); });

  /* 묶음 배송비를 수량 비례로 배분 — 이 청구서 구조에서 유일하게 남은 배분 대상이다 */
  groups.forEach((g) => {
    const qtySum = g.lines.reduce((a, l) => a + (l.qty || 0), 0);
    g.lines.forEach((l) => {
      l.allocShipCny = qtySum > 0 ? (g.shippingCny || 0) * (l.qty / qtySum) : 0;
      l.lineCny = (l.qty || 0) * (l.unitCny || 0) + l.allocShipCny;
    });
    /* 검산: 우리가 계산한 합이 청구서의 묶음 총금액과 맞는가 */
    if (g.totalCny != null) {
      const calc = g.lines.reduce((a, l) => a + l.lineCny, 0);
      g.diffCny = Math.round((calc - g.totalCny) * 100) / 100;
    }
  });

  const sumCny = groups.reduce((a, g) => a + (g.totalCny != null
    ? g.totalCny
    : g.lines.reduce((b, l) => b + l.lineCny, 0)), 0);

  /* 환율은 문서에 안 적혀 있다 — 전체 KRW ÷ 전체 CNY로 역산한다.
     실측(2026-06-26 청구서): 2055.28 CNY, ₩657,690 → 320.0 */
  const rate = (totalKrw && sumCny) ? Math.round((totalKrw / sumCny) * 100) / 100 : null;

  return {
    rows: out, groups, unusedMarkers,
    totals: { totalKrw, vatKrw, grandKrw, sumCny, rate },
    date: out.length ? out[0].date : null,
    error: null
  };
}

/* ===================== 발주 =====================
   원가가 태어나는 화면. 청구서를 인식해서 purchase_orders / purchase_order_lines /
   inventory_lots 세 테이블을 한 번에 만든다(db/migrations/016).

   저장 전 사람 확인 단계를 반드시 거친다 — 인식이 틀린 채로 저장되면 원가가 조용히
   어긋나고, 원가는 이 시스템 전체 이익 계산의 바닥이라 뒤늦게 발견하기 가장 어렵다. */
const PO = { list: [], parsed: null, skuByBarcode: new Map() };

async function loadPOs() {
  const el = $('#poRows');
  el.innerHTML = '<tr><td colspan="10" class="muted">불러오는 중…</td></tr>';
  try {
    const [orders, lines, skus, lots] = await Promise.all([
      apiAll('purchase_orders?select=*&order=requested_at.desc'),
      apiAll('purchase_order_lines?select=id,po_id,qty,line_cost_cny,line_cost_krw,sku_id'),
      /* 청구서의 바코드로 SKU를 찾기 위한 색인. 상품원장 탭을 안 거쳐도 발주가
         동작해야 하므로 여기서 따로 읽는다(두 탭이 서로를 전제하지 않게). */
      apiAll('my_skus?select=id,sku_name,barcode'),
      /* 로트 수를 목록에 같이 보여준다 — 청구서를 저장했는데 원가가 실제로 상품에
         붙었는지를 화면에서 바로 확인할 수 있어야 한다(로트가 0이면 원가가 떠 있는 상태). */
      apiAll('inventory_lots?select=po_line_id&po_line_id=not.is.null')
    ]);
    const lotLineIds = new Set(lots.map((l) => l.po_line_id));
    PO.skuByBarcode = new Map(
      skus.filter((s) => s.barcode).map((s) => [String(s.barcode), { sku: s }])
    );
    PO.allSkus = skus;   // 수동 연결(발주 상세)에서 고를 후보
    const empty = () => ({ n: 0, qty: 0, cny: 0, krw: 0, unmatched: 0, lots: 0 });
    const byPo = new Map();
    lines.forEach((l) => {
      const a = byPo.get(l.po_id) || empty();
      a.n++; a.qty += l.qty || 0;
      a.cny += Number(l.line_cost_cny) || 0;
      a.krw += Number(l.line_cost_krw) || 0;
      if (!l.sku_id) a.unmatched++;
      if (lotLineIds.has(l.id)) a.lots++;
      byPo.set(l.po_id, a);
    });
    PO.list = orders.map((o) => ({ o, agg: byPo.get(o.id) || empty() }));
    renderPOs();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="10" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

/* 발주 진행 단계 — 사용자가 정해준 업무 순서 중 **발주 전체가 함께 움직이는 구간**만.
   순서 자체가 의미를 가지므로 바꾸지 말 것.

   왜 "작업비 청구 / 쿠팡 출고중 / 쿠팡센터 도착"이 여기 없나(2026-08-18 재설계):
   한 발주를 나눠서 한국에 보낼 수 있고(부분 출고), 제트 작업비 청구서는 여러 발주를
   가로질러 묶여서 온다("28일 주문분 + 29일 주문분을 묶어서, 없는 건 빼고"). 그래서
   그 세 단계는 발주 단위로는 참도 거짓도 아니다 — **출고 묶음(inbound_shipments)**
   단위로 따로 관리한다. 발주 화면에서는 "얼마나 나갔나"를 수량으로 보여준다.

   재고 수량도 더 이상 이 단계에서 파생시키지 않는다(예전엔 그랬음) — 부분 출고를
   지원하는 순간 "발주 전량이 같이 움직인다"는 전제가 깨지기 때문. */
const PO_STEPS = [
  { code: 'invoiced',    label: '청구서 수령' },
  { code: 'paid',        label: '결제완료' },
  { code: 'shipping_cn', label: '중국배대지 배송중' },
  { code: 'arrived_cn',  label: '중국배대지 도착' }
];
const PO_STEP_INDEX = new Map(PO_STEPS.map((s, i) => [s.code, i]));

/* 016 주석에 적어둔 옛 코드들 — 실제로 쓰인 적은 'invoiced'뿐이지만,
   과거 행이 남아 있어도 화면이 안 깨지도록 라벨만 남겨둔다. */
const PO_STATUS_LABEL = Object.assign(
  { requested: '요청', ordered: '발주', arrived_china: '중국배대지 도착',
    inbound_requested: '쿠팡 출고중', received: '쿠팡센터 도착', cancelled: '취소' },
  Object.fromEntries(PO_STEPS.map((s) => [s.code, s.label]))
);

function renderPOs() {
  const rows = PO.list;
  const totalKrw = rows.reduce((a, r) => a + r.agg.krw, 0);
  $('#poSummary').textContent = rows.length
    ? `발주 ${rows.length}건 · 누적 매입원가 ${Math.round(totalKrw).toLocaleString()}원`
    : '아직 등록된 발주가 없습니다. "청구서 넣기"로 시작하세요.';

  if (!rows.length) { $('#poRows').innerHTML = ''; return; }

  $('#poRows').innerHTML = rows.map((r) => {
    const o = r.o;
    const unmatched = r.agg.unmatched;
    return `<tr class="prow" data-po="${esc(o.id)}">
      <td>${esc((o.requested_at || '').slice(0, 10))}</td>
      <td>${esc(PO_STATUS_LABEL[o.status] || o.status)}</td>
      <td class="col-num">${r.agg.n}${unmatched ? ` <span class="muted">(미매칭 ${unmatched})</span>` : ''}</td>
      <td class="col-num">${r.agg.lots === r.agg.n && r.agg.n
          ? r.agg.lots
          : `<span class="warn-txt">${r.agg.lots}</span>`}</td>
      <td class="col-num">${cnt(r.agg.qty)}</td>
      <td class="col-num">${r.agg.cny ? r.agg.cny.toFixed(2) : '—'}</td>
      <td class="col-num">${o.rate_purchase == null ? '—' : Number(o.rate_purchase).toFixed(2)}</td>
      <td class="col-num">${won(Math.round(r.agg.krw))}</td>
      <td>${o.confirmed_by_user ? '확인됨' : '<span class="muted">미확인</span>'}</td>
      <td>${poPayCellHtml(o)}</td>
    </tr>`;
  }).join('');
}

/* ── 발주 상세 : 청구서 줄에 SKU 붙이기 ─────────────────────────
   왜 필요한가: 청구서의 바코드로 SKU를 자동 매칭하지만, 바코드를 안 넣고 발주한
   건(과거 청구서는 전부 NOBARCODE)은 매칭이 안 된다. 그러면 원가가 어느 상품
   것인지 이어지지 않아 그 줄은 죽은 데이터가 된다 — 여기서 손으로 붙인다.

   **로트는 SKU가 붙는 순간 만들어진다.** 청구서 저장 시점엔 매칭된 줄만 로트를
   만들었으므로, 여기서 뒤늦게 붙인 줄도 같은 규칙으로 로트를 만들어줘야
   선입선출 대기열에 들어간다. 이미 로트가 있는 줄은 건드리지 않는다(중복 방지). */
const POD = { poId: null, po: null, lines: [], lots: [], lotByLine: new Map(),
              picks: new Map(), bcEdits: new Map() };

/* 한글 상품명 비교는 단어 단위로는 잘 안 맞는다("도시락 말랑이" vs
   "덴넬 버터 스틱 말랑이 슬라임 스퀴시, 노랑 100g 2개"). 글자 2개씩 겹치는
   비율(Dice 계수)로 보면 표기가 달라도 같은 상품을 꽤 잘 찾아낸다. */
function bigramSet(s) {
  const t = String(s || '').replace(/[\s,·\-_()]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function diceScore(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach((g) => { if (b.has(g)) hit++; });
  return (2 * hit) / (a.size + b.size);
}
function suggestSkus(name, skus, limit) {
  const q = bigramSet(name);
  return skus
    .map((s) => ({ s, score: diceScore(q, bigramSet(s.sku_name)) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3);
}

/* 줄(=SKU) 단위 진행 상태. **발주 단계와 별개다.**
   한 발주 안에서도 어떤 SKU는 이미 쿠팡에 있고 어떤 건 아직 중국에 있을 수 있다
   (부분 출고 + 1688에서 일부만 먼저 도착하는 경우, 사용자 확인 2026-08-18).
   그래서 상태를 따로 저장하지 않고 **로트 수량에서 파생**시킨다 —
   저장된 상태와 실제 수량이 어긋날 일이 원천적으로 없다. */
function lineProgress(lots) {
  if (!lots.length) return { code: 'nolot', label: '미연결', cls: 'warn' };
  const n = (k) => lots.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const cn = n('qty_china'), tr = n('qty_transit'), cp = n('qty_coupang');
  if (cn + tr + cp === 0) return { code: 'empty', label: '재고 없음', cls: 'dim' };
  const places = [cn > 0, tr > 0, cp > 0].filter(Boolean).length;
  if (places > 1) return { code: 'partial', label: '일부 출고', cls: 'mid' };
  if (cn > 0) return { code: 'china', label: '중국창고', cls: 'dim' };
  if (tr > 0) return { code: 'transit', label: '쿠팡 출고중', cls: 'mid' };
  return { code: 'coupang', label: '쿠팡센터', cls: 'ok' };
}

async function openPoDetail(poId) {
  const entry = PO.list.find((r) => r.o.id === poId);
  if (!entry) return;
  POD.poId = poId;
  POD.po = entry.o;
  POD.picks = new Map();
  POD.bcEdits = new Map();
  
  $('#poDetailMsg').className = 'msg hidden';
  $('#poDetailTitle').textContent = `발주 상세 — ${(entry.o.requested_at || '').slice(0, 10)}`;
  $('#poDetailRows').innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  $('#poDetailModal').classList.remove('hidden');

  try {
    const [lines, lots] = await Promise.all([
      apiAll(`purchase_order_lines?select=*&po_id=eq.${encodeURIComponent(poId)}&order=line_no.asc`),
      /* 로트를 수량까지 통째로 읽는다 — 창고/운송중/쿠팡이 각각 몇 개인지
         화면에 보여줘야 부분 출고 뒤에도 상황이 파악된다. */
      apiAll('inventory_lots?select=*&po_line_id=not.is.null')
    ]);
    POD.lines = lines;
    POD.lots = lots.filter((lot) => lines.some((l) => l.id === lot.po_line_id));
    POD.lotByLine = new Map();
    POD.lots.forEach((lot) => {
      const arr = POD.lotByLine.get(lot.po_line_id) || [];
      arr.push(lot);
      POD.lotByLine.set(lot.po_line_id, arr);
    });

    /* 후보 목록은 datalist로 준다 — SKU가 수천 개가 돼도 브라우저가 알아서 걸러준다.
       select 태그였다면 수천 개 option을 그리느라 느려진다. */
    $('#skuPickList').innerHTML = (PO.allSkus || [])
      .map((s) => `<option value="${esc(skuPickLabel(s))}"></option>`).join('');

    renderPoDetail();
  } catch (e) {
    $('#poDetailRows').innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const skuPickLabel = (s) => `${s.sku_name} [${s.barcode || '바코드없음'}]`;

function renderPoDetail() {
  const po = POD.po;
  const rate = Number(po.rate_purchase) || 0;
  const skus = PO.allSkus || [];
  const byId = new Map(skus.map((s) => [s.id, s]));

  /* 아직 저장 안 한 선택(picks)도 반영해서 센다 — 안 그러면 화면에서 고르는데도
     "미연결 2/3"이 안 줄어들어서 반영이 안 된 것처럼 보인다. */
  const pickedOf = (l) => (POD.picks.has(String(l.id)) ? POD.picks.get(String(l.id)) : l.sku_id);
  const bcOf = (l) => (POD.bcEdits.has(String(l.id)) ? POD.bcEdits.get(String(l.id)) : l.barcode_text);
  const unmatched = POD.lines.filter((l) => !pickedOf(l)).length;
  $('#poDetailRo').innerHTML = [
    ['상태', PO_STATUS_LABEL[po.status] || po.status],
    ['환율', rate ? rate.toFixed(2) : '—'],
    ['합계(CNY)', po.total_cny != null ? Number(po.total_cny).toFixed(2) : '—'],
    ['미연결 줄', `${unmatched} / ${POD.lines.length}`]
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  /* 진행 단계 — 누르면 그 단계로 바꾼다. 되돌리기도 되게 했다(잘못 눌렀을 때
     방법이 없으면 안 되고, 수량은 단계에서 파생되므로 되돌려도 어긋나지 않는다). */
  const curIdx = PO_STEP_INDEX.has(po.status) ? PO_STEP_INDEX.get(po.status) : -1;
  $('#poSteps').innerHTML = PO_STEPS.map((s, i) => {
    const cls = i < curIdx ? 'done' : (i === curIdx ? 'now' : '');
    return `<button class="po-step ${cls}" data-step="${s.code}">
      <b>${i + 1}</b><span>${esc(s.label)}</span></button>`;
  }).join('');

  $('#poDetailHint').textContent = unmatched
    ? '연결할 SKU를 고르면 저장할 때 그 줄의 재고 로트가 만들어집니다. 상품명이 비슷한 후보를 아래에 추천해뒀습니다.'
    : '모든 줄이 SKU에 연결돼 있습니다.';

  $('#poDetailRows').innerHTML = POD.lines.map((l) => {
    /* picks의 키는 DOM dataset에서 와서 항상 문자열이고 l.id는 숫자다 —
       String()으로 맞추지 않으면 고른 값이 조용히 무시된다(2026-08-18에 실제로 겪음). */
    const picked = pickedOf(l);
    const cur = picked ? byId.get(picked) : null;
    const lots = POD.lotByLine.get(l.id) || [];
    const hasLot = lots.length > 0;
    const sum = (k) => lots.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const prog = lineProgress(lots);
    const unit = l.qty ? Math.round((l.line_cost_krw || 0) / l.qty) : 0;

    let cell;
    if (cur) {
      cell = `<div class="pick-on">
          <span>${esc(cur.sku_name)}</span>
          ${hasLot ? '<span class="muted sm">로트 생성됨</span>'
                   : '<button class="btn btn-sm btn-ghost pick-clear" data-line="' + esc(l.id) + '">해제</button>'}
        </div>`;
    } else {
      const sugg = suggestSkus(l.product_name_text, skus, 3);
      cell = `<div class="pick-off">
          <input class="pick-input" list="skuPickList" data-line="${esc(l.id)}" placeholder="SKU 검색…" />
          ${sugg.length ? '<div class="pick-sugg">' + sugg.map((x) =>
            `<button class="chip-btn pick-sugg-btn" data-line="${esc(l.id)}" data-sku="${esc(x.s.id)}"
               title="유사도 ${(x.score * 100).toFixed(0)}%">${esc(x.s.sku_name)}</button>`).join('') + '</div>' : ''}
        </div>`;
    }

    /* 바코드를 고칠 수 있게 한다 — 쿠플러스에 바코드를 안 넣고 발주한 건은 여기서
       나중에 채워 넣는 게 가장 자연스럽다. 고치면 그 바코드로 SKU를 찾아보고,
       있으면 자동 연결하고 없으면 원래처럼 검색·추천이 뜬다.
       청구서 원문은 purchase_order_lines.raw_line(jsonb)에 그대로 남아 있으므로
       이 칸을 고쳐도 원본을 잃지 않는다. */
    const bc = bcOf(l);
    return `<tr>
      <td><input class="bc-input" data-line="${esc(l.id)}" value="${esc(bc || '')}"
                 placeholder="바코드 없음" /></td>
      <td>${esc(l.product_name_text)}</td>
      <td class="col-num">${cnt(l.qty)}</td>
      <td class="col-num">${hasLot
          ? `<span class="prog prog-${prog.cls}">${esc(prog.label)}</span>
             <span class="prog-qty">${sum('qty_china')} · ${sum('qty_transit')} · ${sum('qty_coupang')}</span>`
          : `<span class="prog prog-${prog.cls}">${esc(prog.label)}</span>`}</td>
      <td class="col-num">${unit ? unit.toLocaleString() + '원' : '—'}</td>
      <td>${cell}</td>
    </tr>`;
  }).join('');
}

/* SKU를 고르면 왼쪽 바코드 칸도 그 SKU의 바코드로 맞춰준다(사용자 요청 2026-08-18) —
   둘이 다른 채로 저장되면 나중에 "이 줄이 왜 이 상품에 붙었지"를 추적할 수 없다.
   SKU에 바코드가 없으면(드묾) 기존 값을 지우지 않는다 — 있는 정보를 없애는 쪽이 더 나쁘다. */
function podPick(lineId, skuId) {
  POD.picks.set(lineId, skuId);
  const sku = (PO.allSkus || []).find((s) => s.id === skuId);
  if (sku && sku.barcode) POD.bcEdits.set(lineId, String(sku.barcode));
  renderPoDetail();
}

$('#poDetailRows').addEventListener('click', (ev) => {
  const sug = ev.target.closest('.pick-sugg-btn');
  if (sug) { podPick(sug.dataset.line, sug.dataset.sku); return; }
  const clr = ev.target.closest('.pick-clear');
  if (clr) { POD.picks.set(clr.dataset.line, null); renderPoDetail(); }
});
$('#poDetailRows').addEventListener('change', (ev) => {
  const inp = ev.target.closest('.pick-input');
  if (inp) {
    const hit = (PO.allSkus || []).find((s) => skuPickLabel(s) === inp.value);
    if (hit) podPick(inp.dataset.line, hit.id);
    return;
  }

  const bcInp = ev.target.closest('.bc-input');
  if (!bcInp) return;
  const lineId = bcInp.dataset.line;
  const line = POD.lines.find((l) => String(l.id) === String(lineId));
  const val = bcInp.value.trim() || null;
  POD.bcEdits.set(lineId, val);

  /* 바코드를 고치면 **먼저 그 바코드의 SKU가 있는지 본다.**
     있으면 자동으로 연결하고, 없으면 연결을 비워서 원래처럼 검색·추천이 뜨게 한다.
     단 이미 로트가 만들어진 줄은 연결을 건드리지 않는다 — 바꾸면 로트가 붕 뜬다.
     (바코드 글자 자체는 고쳐도 로트에 영향이 없으므로 수정은 허용한다) */
  if (line && !POD.lotByLine.has(line.id)) {
    const hit = val ? PO.skuByBarcode.get(String(val)) : null;
    POD.picks.set(lineId, hit ? hit.sku.id : null);
  }
  renderPoDetail();
});

$$('#poDetailModal [data-close]').forEach((b) => {
  b.onclick = () => $('#poDetailModal').classList.add('hidden');
});

/* 단계 변경은 이제 재고를 건드리지 않는다 — 재고 이동은 출고 묶음이 담당한다.
   '중국배대지 도착'만 로트에 도착 시각을 남긴다(리드타임 실측에 쓸 값이다). */
$('#poSteps').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.po-step');
  if (!btn || !POD.po) return;
  const code = btn.dataset.step;
  if (code === POD.po.status) return;

  const msg = $('#poDetailMsg');
  $$('#poSteps .po-step').forEach((b) => { b.disabled = true; });
  try {
    await api(`purchase_orders?id=eq.${encodeURIComponent(POD.po.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: code }
    });
    POD.po.status = code;

    if (code === 'arrived_cn') {
      const now = new Date().toISOString();
      for (const lot of POD.lots.filter((l) => !l.arrived_china_at)) {
        await api(`inventory_lots?id=eq.${lot.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: { arrived_china_at: now }
        });
        lot.arrived_china_at = now;
      }
    }
    renderPoDetail();
    toast(`단계 변경 — ${PO_STATUS_LABEL[code] || code}`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '단계 변경 실패: ' + e.message;
  } finally {
    $$('#poSteps .po-step').forEach((b) => { b.disabled = false; });
  }
});

$('#poDetailSave').onclick = async () => {
  const btn = $('#poDetailSave');
  const msg = $('#poDetailMsg');
  /* 연결과 바코드를 따로 저장하지 않는다 — 한 줄에 둘 다 바뀌었으면 PATCH 한 번으로 끝낸다 */
  const touched = new Set([...POD.picks.keys(), ...POD.bcEdits.keys()]);
  const changes = Array.from(touched).map((lineId) => {
    const line = POD.lines.find((l) => String(l.id) === String(lineId));
    if (!line) return null;
    const skuId = POD.picks.has(lineId) ? POD.picks.get(lineId) : line.sku_id;
    const bc = POD.bcEdits.has(lineId) ? POD.bcEdits.get(lineId) : line.barcode_text;
    const patch = {};
    if ((line.sku_id || null) !== (skuId || null)) patch.sku_id = skuId;
    if ((line.barcode_text || null) !== (bc || null)) patch.barcode_text = bc;
    return Object.keys(patch).length ? { line, skuId, patch } : null;
  }).filter(Boolean);

  if (!changes.length) { msg.className = 'msg'; msg.textContent = '바뀐 내용이 없습니다.'; return; }

  btn.disabled = true;
  try {
    const rate = Number(POD.po.rate_purchase) || 0;
    let lotsMade = 0;
    for (const { line, skuId, patch } of changes) {
      await api(`purchase_order_lines?id=eq.${encodeURIComponent(line.id)}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: patch
      });
      Object.assign(line, patch);

      /* 청구서 저장 때와 같은 규칙으로 로트를 만든다. 이미 있으면 건너뛴다 —
         같은 줄에 로트가 두 개 생기면 재고와 원가가 이중 계상된다. */
      if (skuId && !POD.lotByLine.has(line.id)) {
        await api('inventory_lots', {
          method: 'POST', headers: { prefer: 'return=minimal' },
          body: [{
            sku_id: skuId,
            po_line_id: line.id,
            qty_ordered: line.qty,
            qty_china: 0,      // 아직 중국 창고에 없다 (020 참조)
            qty_arrived: 0,
            unit_cost_krw: line.qty ? Math.round((line.line_cost_krw / line.qty) * 100) / 100 : 0,
            unit_purchase_cost_krw: line.qty ? Math.round((line.line_cost_krw / line.qty) * 100) / 100 : 0,
            unit_work_fee_krw: 0,     // 배대지 작업비는 출고할 때 확정된다
            cost_status: 'estimated',
            cost_breakdown: {
              cny_line: line.line_cost_cny,
              cny_unit: line.unit_price_cny,
              cny_shipping_alloc: line.allocated_shipping_cny,
              rate_purchase: rate,
              linked_manually: true      // 바코드가 아니라 사람이 붙인 연결임을 남긴다
            },
            ordered_at: POD.po.requested_at
          }]
        });
        POD.lotByLine.set(line.id, [{ po_line_id: line.id, qty_china: line.qty }]);
        lotsMade++;
      }
    }
    POD.picks = new Map();
    POD.bcEdits = new Map();
    renderPoDetail();
    toast(`${changes.length}줄 저장 · 로트 ${lotsMade}개 생성`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

$('#poRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-po]');
  if (tr) openPoDetail(tr.dataset.po);
});

/* 결제완료 버튼 — 누르면 결제 시각을 남기고 **바로 "중국배대지 배송중"으로 넘긴다**
   (사용자 요청 2026-08-18). 결제하면 쿠플러스가 1688에 주문을 넣고 물건이 움직이기
   시작하므로, "결제완료"에 머무는 시간이 실무에 사실상 없다. 그래서 단계를 하나
   건너뛰는 게 아니라, 결제라는 사건이 곧 배송 시작이라는 뜻이다.
   paid_at은 따로 남기므로 "언제 결제했나"는 잃지 않는다. */
function poPayCellHtml(o) {
  const idx = PO_STEP_INDEX.has(o.status) ? PO_STEP_INDEX.get(o.status) : -1;
  if (o.status === 'cancelled') return '';
  if (idx <= PO_STEP_INDEX.get('invoiced')) {
    return `<button class="btn btn-sm btn-primary po-pay" data-po="${esc(o.id)}">결제완료</button>`;
  }
  return o.paid_at
    ? `<span class="muted sm">결제 ${esc(String(o.paid_at).slice(0, 10))}</span>`
    : '';
}

$('#poRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.po-pay');
  if (!btn) return;
  ev.stopPropagation();          // 행 클릭(상세 열기)과 겹치지 않게
  btn.disabled = true;
  try {
    const now = new Date().toISOString();
    await api(`purchase_orders?id=eq.${encodeURIComponent(btn.dataset.po)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { status: 'shipping_cn', paid_at: now }
    });
    toast('결제완료 — 중국배대지 배송중으로 넘겼습니다');
    loadPOs();
  } catch (e) {
    toast('실패: ' + e.message, 4000);
    btn.disabled = false;
  }
});

function poOpenModal() {
  PO.parsed = null;
  $('#poStep1').classList.remove('hidden');
  $('#poStep2').classList.add('hidden');
  $('#poSave').classList.add('hidden');
  $('#poBack').classList.add('hidden');
  $('#poMsg').className = 'msg hidden';
  $('#poText').value = '';
  $('#poModal').classList.remove('hidden');
}
function poCloseModal() { $('#poModal').classList.add('hidden'); }

$('#poNewBtn').onclick = poOpenModal;
$$('#poModal [data-close]').forEach((b) => { b.onclick = poCloseModal; });
$('#poBack').onclick = () => {
  $('#poStep1').classList.remove('hidden');
  $('#poStep2').classList.add('hidden');
  $('#poSave').classList.add('hidden');
  $('#poBack').classList.add('hidden');
};

$('#poDrop').onclick = () => $('#poFile').click();
$('#poDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#poDrop').classList.add('over'); });
$('#poDrop').addEventListener('dragleave', () => $('#poDrop').classList.remove('over'));
$('#poDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#poDrop').classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) poHandleFile(f);
});
$('#poFile').onchange = (e) => { const f = e.target.files[0]; if (f) poHandleFile(f); };
$('#poParseText').onclick = () => poShowParsed(parseCouplusInvoice($('#poText').value), null);

/* PDF에서 텍스트를 뽑는 일만 서버리스 함수에 맡긴다(브라우저에 PDF 라이브러리를
   넣지 않기 위함 — 프론트엔드 무의존 원칙, web/CLAUDE.md).
   텍스트→줄 구조 변환은 브라우저에서 한다: 로직이 한 곳에 있고 테스트가 쉽다. */
async function poHandleFile(file) {
  const msg = $('#poMsg');
  msg.className = 'msg';
  msg.textContent = 'PDF 읽는 중…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/parse-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: buf
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    msg.className = 'msg hidden';
    PO.method = d.method || null;
    poShowParsed(parseCouplusInvoice(d.text), d.text);
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = 'PDF 인식 실패: ' + e.message +
      ' — 아래 "텍스트로 직접 붙여넣기"를 쓰시면 됩니다.';
  }
}

function poShowParsed(parsed, rawText) {
  if (parsed.error || !parsed.rows.length) {
    const msg = $('#poMsg');
    msg.className = 'msg err';
    msg.textContent = parsed.error || '인식된 줄이 없습니다.';
    return;
  }
  PO.parsed = parsed;
  PO.rawText = rawText || $('#poText').value || null;

  $('#poDate').value = parsed.date || '';
  $('#poRate').value = parsed.totals.rate || '';
  $('#poTotalCny').value = parsed.totals.sumCny ? parsed.totals.sumCny.toFixed(2) : '';
  $('#poTotalKrw').value = parsed.totals.totalKrw || '';
  $('#poRateNote').textContent = parsed.totals.rate
    ? `환율은 청구서에 안 적혀 있어 합계로 역산했습니다 (${parsed.totals.totalKrw.toLocaleString()}원 ÷ ${parsed.totals.sumCny.toFixed(2)} CNY). 다르면 직접 고치세요.`
    : '환율을 역산할 수 없었습니다 — 직접 입력하세요.';

  $('#poRaw').value = PO.rawText || '';
  $('#poMethod').textContent = PO.method
    ? (PO.method === 'position' ? '(좌표 기반 추출)' : '(기본 추출 — 공백이 뭉개졌을 수 있음)')
    : '';

  poRenderLines();
  $('#poStep1').classList.add('hidden');
  $('#poStep2').classList.remove('hidden');
  $('#poSave').classList.remove('hidden');
  $('#poBack').classList.remove('hidden');
}

function poRenderLines() {
  const rate = Number($('#poRate').value) || 0;
  const bc = PO.skuByBarcode;
  let unmatched = 0;

  $('#poLineRows').innerHTML = PO.parsed.rows.map((l, i) => {
    const hit = l.barcode ? bc.get(String(l.barcode)) : null;
    if (!hit) unmatched++;
    const unitKrw = l.qty ? (l.lineCny / l.qty) * rate : 0;
    return `<tr data-i="${i}">
      <td class="sku-bc">${l.barcode ? esc(l.barcode) : '<span class="muted">없음</span>'}</td>
      <td>${esc(l.name)}</td>
      <td>${hit ? esc(hit.sku.sku_name) : '<span class="warn-txt">매칭 안 됨</span>'}</td>
      <td class="col-num">${cnt(l.qty)}</td>
      <td class="col-num">${l.unitCny == null ? '—' : l.unitCny}</td>
      <td class="col-num">${l.allocShipCny ? l.allocShipCny.toFixed(2) : '0'}</td>
      <td class="col-num">${rate ? Math.round(unitKrw).toLocaleString() + '원' : '—'}</td>
    </tr>`;
  }).join('');

  const notes = [];
  /* 숫자 개수가 7(그룹 머리)·3(구성원)·1(수량만) 중 어느 것도 아니면 텍스트 추출이
     깨졌을 가능성이 크다 — 2026-08-18에 pdf-parse 기본 추출기가 칸 사이 공백을
     버려서 "세알2069.8129.868128" 같은 토큰이 만들어진 적이 있다. 그때 화면엔
     아무 경고도 안 떠서 사용자가 눈으로 보고서야 알았다. 다시는 조용히 넘어가지 않게 한다. */
  const odd = PO.parsed.rows.filter((l) =>
    ![1, 3, 7].includes(l.raw.length) ||
    /* 수량은 반드시 양의 정수다. 소수가 나왔다면 두 칸이 붙어버린 것
       (실제 사례: "16 5.7"이 "165.7"로 붙어 수량 14196.4가 만들어졌다). */
    !Number.isInteger(l.qty) || l.qty <= 0
  ).length;
  if (odd) {
    notes.push(`숫자 구조가 예상과 다른 줄 ${odd}개 — PDF 텍스트 추출이 깨졌을 수 있습니다. ` +
      '아래 "인식된 원문 보기"에서 칸이 공백으로 제대로 나뉘었는지 확인하세요.');
  }
  if (unmatched) notes.push(`바코드로 SKU를 못 찾은 줄 ${unmatched}개 — 그대로 저장하면 원가가 어느 상품 것인지 이어지지 않습니다.`);
  PO.parsed.groups.forEach((g, i) => {
    if (g.leftover) {
      notes.push(`${i + 1}번 묶음: 어느 총금액과도 맞아떨어지지 않은 줄이 ${g.lines.length}개 남았습니다 — 배송비 배분이 안 된 상태입니다.`);
    } else if (g.diffCny != null && Math.abs(g.diffCny) > 0.05) {
      notes.push(`${i + 1}번 묶음 합계가 청구서와 ${g.diffCny > 0 ? '+' : ''}${g.diffCny} CNY 차이납니다.`);
    }
  });
  if (PO.parsed.unusedMarkers > 0) {
    notes.push(`쓰이지 못한 묶음 총금액이 ${PO.parsed.unusedMarkers}개 있습니다 — 줄을 일부 못 읽었을 수 있습니다.`);
  }
  const w = $('#poWarn');
  if (notes.length) { w.className = 'msg err'; w.innerHTML = notes.map(esc).join('<br>'); }
  else { w.className = 'msg hidden'; }
}
$('#poRate').oninput = () => { if (PO.parsed) poRenderLines(); };

$('#poSave').onclick = async () => {
  if (!PO.parsed) return;
  const btn = $('#poSave');
  const msg = $('#poMsg');
  const rate = Number($('#poRate').value) || null;
  if (!rate) {
    msg.className = 'msg err';
    msg.textContent = '환율이 없으면 원가를 원화로 못 만듭니다. 환율을 입력하세요.';
    return;
  }
  btn.disabled = true;
  try {
    const t = PO.parsed.totals;
    const po = (await api('purchase_orders', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: [{
        requested_at: ($('#poDate').value || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z',
        status: 'invoiced',
        rate_purchase: rate,
        rate_source: t.rate && Math.abs(t.rate - rate) < 0.01 ? 'derived_from_invoice' : 'manual',
        invoice_raw_text: PO.rawText,
        parsed_at: new Date().toISOString(),
        parse_method: 'regex',
        confirmed_by_user: true,
        total_cny: t.sumCny || null,
        total_krw: t.totalKrw || null,
        vat_krw: t.vatKrw || null,
        grand_total_krw: t.grandKrw || null
      }]
    }))[0];

    const lineBody = PO.parsed.rows.map((l, i) => {
      const hit = l.barcode ? PO.skuByBarcode.get(String(l.barcode)) : null;
      return {
        po_id: po.id,
        line_no: i + 1,
        sku_id: hit ? hit.sku.id : null,
        barcode_text: l.barcode,
        product_name_text: l.name,
        qty: l.qty,
        group_key: 'G' + (l.groupIndex + 1),
        unit_price_cny: l.unitCny,
        group_shipping_cny: PO.parsed.groups[l.groupIndex].shippingCny,
        group_total_cny: PO.parsed.groups[l.groupIndex].totalCny,
        allocated_shipping_cny: l.allocShipCny,
        line_cost_cny: l.lineCny,
        line_cost_krw: Math.round(l.lineCny * rate),
        raw_line: { nums: l.raw, date: l.date }
      };
    });
    const savedLines = await api('purchase_order_lines', {
      method: 'POST', headers: { prefer: 'return=representation' }, body: lineBody
    });

    /* 매칭된 줄만 로트를 만든다 — SKU를 모르는 원가는 어차피 어디에도 못 붙는다.
       나중에 바코드를 채워 매칭하면 그때 로트를 만들 수 있게 줄은 그대로 남겨둔다. */
    const lots = savedLines.filter((l) => l.sku_id).map((l) => ({
      sku_id: l.sku_id,
      po_line_id: l.id,
      qty_ordered: l.qty,
      qty_china: 0,          // 아직 중국 창고에 없다 — 입고 페이지에서 도착 처리해야 생긴다
      qty_arrived: 0,
      unit_cost_krw: l.qty ? Math.round((l.line_cost_krw / l.qty) * 100) / 100 : 0,
      unit_purchase_cost_krw: l.qty ? Math.round((l.line_cost_krw / l.qty) * 100) / 100 : 0,
      unit_work_fee_krw: 0,
      cost_status: 'estimated',   // 배대지 작업비(개당 300원 수준)가 아직 안 붙었다
      cost_breakdown: {
        cny_line: l.line_cost_cny,
        cny_unit: l.unit_price_cny,
        cny_shipping_alloc: l.allocated_shipping_cny,
        rate_purchase: rate
      },
      ordered_at: po.requested_at
    }));
    if (lots.length) {
      await api('inventory_lots', { method: 'POST', headers: { prefer: 'return=minimal' }, body: lots });
    }

    poCloseModal();
    toast(`청구서 저장 완료 — ${savedLines.length}줄, 로트 ${lots.length}개`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ===================== 입고 (중국 배대지) =====================
   물건의 **물리적 상태**를 관리하는 화면. 발주 상세가 "원가와 SKU 연결"을 맡는다면
   여기는 "실제로 몇 개가 왔고 몇 개가 불량인가"를 맡는다.
   같은 걸 두 군데서 고칠 수 있으면 반드시 헷갈리므로 불량 입력은 여기로 일원화했다
   (발주 상세에서는 뺐음, 2026-08-18 사용자 동의).

   **도착은 SKU(로트) 단위다** — 1688에서 일부만 먼저 오는 일이 실제로 있어서
   발주 단위로는 표현이 안 된다. 한 발주 안에서도 상품마다 도착 시점이 다르다.
   그 발주의 모든 줄이 다 도착하면 발주 단계를 자동으로 '중국배대지 도착'으로 올린다. */
const INB = { lots: [], lines: [], skuById: new Map(), lineById: new Map(), poById: new Map() };

async function loadInbound() {
  $('#inboundWaitRows').innerHTML = '<tr><td colspan="8" class="muted">불러오는 중…</td></tr>';
  try {
    const [lots, skus, lines, orders] = await Promise.all([
      apiAll('inventory_lots?select=*'),
      apiAll('my_skus?select=id,sku_name,barcode'),
      apiAll('purchase_order_lines?select=id,po_id,sku_id,qty,product_name_text,barcode_text'),
      apiAll('purchase_orders?select=id,status,requested_at')
    ]);
    INB.lots = lots;
    INB.lines = lines;
    INB.skuById = new Map(skus.map((s) => [s.id, s]));
    INB.lineById = new Map(lines.map((l) => [l.id, l]));
    INB.poById = new Map(orders.map((o) => [o.id, o]));
    renderInbound();
  } catch (e) {
    $('#inboundWaitRows').innerHTML = `<tr><td colspan="8" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const inbPoDate = (lot) => {
  const line = INB.lineById.get(lot.po_line_id);
  const po = line && INB.poById.get(line.po_id);
  return po ? String(po.requested_at || '').slice(0, 10) : '—';
};
const inbSkuName = (lot) => {
  const s = INB.skuById.get(lot.sku_id);
  return s ? s.sku_name : '(알 수 없는 SKU)';
};
const inbSkuBarcode = (lot) => {
  const s = INB.skuById.get(lot.sku_id);
  return (s && s.barcode) || '바코드 없음';
};

function renderInbound() {
  const waiting = INB.lots
    .filter((l) => lotIncoming(l) > 0)
    .sort((a, b) => String(inbPoDate(a)).localeCompare(String(inbPoDate(b))));
  const inStock = INB.lots
    .filter((l) => (Number(l.qty_china) || 0) > 0)
    .sort((a, b) => String(inbPoDate(a)).localeCompare(String(inbPoDate(b))));

  const waitQty = waiting.reduce((a, l) => a + lotIncoming(l), 0);
  const stockQty = inStock.reduce((a, l) => a + (Number(l.qty_china) || 0), 0);
  const defectQty = INB.lots.reduce((a, l) => a + (Number(l.qty_defect) || 0), 0);
  $('#inboundSummary').textContent =
    `도착 대기 ${waitQty}개 · 중국창고 ${stockQty}개 · 누적 불량 ${defectQty}개`;

  /* **이 화면은 로트만 보여준다** — SKU가 연결 안 된 청구서 줄은 로트가 없어서
     아무 데도 안 나온다. 그러면 "발주했는데 입고에 아무것도 없다"로 보이고 원인을
     알 길이 없다(2026-08-18 사용자가 실제로 겪음). 그래서 그 줄들을 여기서 짚어준다. */
  const lotLineIds = new Set(INB.lots.map((l) => l.po_line_id));
  const orphans = (INB.lines || []).filter((ln) => {
    if (lotLineIds.has(ln.id)) return false;
    const po = INB.poById.get(ln.po_id);
    return po && po.status !== 'cancelled';
  });
  const warn = $('#inboundOrphan');
  if (orphans.length) {
    const names = orphans.slice(0, 5).map((o) => esc(o.product_name_text || '(이름없음)')).join(', ');
    warn.className = 'msg err';
    warn.innerHTML = `SKU가 연결되지 않은 청구서 줄이 <b>${orphans.length}개</b> 있습니다 — ` +
      '이 줄들은 재고 로트가 없어서 입고·출고·원가 어디에도 잡히지 않습니다.<br>' +
      `<span class="muted">${names}${orphans.length > 5 ? ' 외' : ''}</span><br>` +
      '<b>발주</b> 탭에서 해당 발주를 열어 SKU를 연결한 뒤 다시 오세요.';
  } else {
    warn.className = 'msg hidden';
  }

  $('#inboundWaitRows').innerHTML = waiting.length ? waiting.map((l) => {
    const left = lotIncoming(l);
    return `<tr>
      <td>${esc(inbPoDate(l))}</td>
      <td>${esc(inbSkuName(l))}<span class="sku-name-sub">${esc(inbSkuBarcode(l))}</span></td>
      <td class="col-num">${l.qty_ordered || 0}</td>
      <td class="col-num">${l.qty_arrived || 0}</td>
      <td class="col-num"><b>${left}</b></td>
      <td class="col-num"><input type="number" class="inb-arrive defect-input" min="0" max="${left}"
            data-lot="${esc(l.id)}" value="${left}" /></td>
      <td class="col-num"><input type="number" class="inb-defect defect-input" min="0"
            data-lot="${esc(l.id)}" value="0" /></td>
      <td><button class="btn btn-sm btn-primary inb-receive" data-lot="${esc(l.id)}">도착 처리</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="muted">도착 대기 중인 물량이 없습니다. (발주한 물량이 전부 도착했거나, 아직 SKU가 연결되지 않아 로트가 없는 상태입니다)</td></tr>';

  $('#inboundStockRows').innerHTML = inStock.length ? inStock.map((l) => `<tr>
      <td>${esc(inbPoDate(l))}</td>
      <td>${esc(inbSkuName(l))}<span class="sku-name-sub">${esc(inbSkuBarcode(l))}</span></td>
      <td class="col-num"><b>${l.qty_china}</b></td>
      <td class="col-num">${l.qty_defect || 0}${l.defect_disposition
          ? `<span class="sku-name-sub">${l.defect_disposition === 'refund' ? '환불' : '손실'}</span>` : ''}</td>
      <td class="col-num"><input type="number" class="inb-adddefect defect-input" min="0" max="${l.qty_china}"
            data-lot="${esc(l.id)}" value="0" /></td>
      <td><select class="inb-disp ship-filter" data-lot="${esc(l.id)}">
            <option value="refund">예치금 환불</option>
            <option value="loss">손실 처리</option>
          </select></td>
      <td><button class="btn btn-sm inb-defect-apply" data-lot="${esc(l.id)}">불량 반영</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">중국창고에 있는 물량이 없습니다. (아직 도착 처리를 안 했거나, 이미 한국으로 출고된 상태입니다)</td></tr>';
}

/* 그 발주의 모든 줄이 다 도착했으면 발주 단계를 '중국배대지 도착'으로 올린다.
   줄마다 따로 도착하므로 발주 단계는 "전부 왔는가"의 요약일 뿐이다. */
async function inbMaybeAdvancePo(lot) {
  const line = INB.lineById.get(lot.po_line_id);
  const po = line && INB.poById.get(line.po_id);
  if (!po || po.status === 'arrived_cn') return;
  const lineIds = new Set(
    Array.from(INB.lineById.values()).filter((l) => l.po_id === po.id).map((l) => l.id)
  );
  const siblings = INB.lots.filter((l) => lineIds.has(l.po_line_id));
  if (siblings.some((l) => lotIncoming(l) > 0)) return;   // 아직 안 온 게 남았다
  await api(`purchase_orders?id=eq.${encodeURIComponent(po.id)}`, {
    method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'arrived_cn' }
  });
  po.status = 'arrived_cn';
}

$('#inboundWaitRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.inb-receive');
  if (!btn) return;
  const lotId = btn.dataset.lot;
  const lot = INB.lots.find((l) => String(l.id) === String(lotId));
  if (!lot) return;
  const val = (sel) => {
    const el = document.querySelector(`.${sel}[data-lot="${CSS.escape(lotId)}"]`);
    return Math.max(0, parseInt(el && el.value, 10) || 0);
  };
  const arrive = Math.min(lotIncoming(lot), val('inb-arrive'));
  const defect = Math.min(arrive, val('inb-defect'));
  const msg = $('#inboundMsg');
  if (arrive <= 0) { msg.className = 'msg err'; msg.textContent = '도착 수량을 입력하세요.'; return; }

  btn.disabled = true;
  try {
    /* 증분으로 더한다 — 나중에 나머지가 또 도착해도 그때 다시 눌러 쌓을 수 있다.
       창고 수량은 (도착 − 불량)만큼 늘린다. 이미 나간 수량은 건드리지 않는다. */
    const body = {
      qty_arrived: (Number(lot.qty_arrived) || 0) + arrive,
      qty_defect: (Number(lot.qty_defect) || 0) + defect,
      qty_china: (Number(lot.qty_china) || 0) + (arrive - defect)
    };
    if (!lot.arrived_china_at) body.arrived_china_at = new Date().toISOString();
    await api(`inventory_lots?id=eq.${encodeURIComponent(lotId)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(lot, body);
    await inbMaybeAdvancePo(lot);
    msg.className = 'msg hidden';
    toast(`도착 ${arrive}개 처리${defect ? ` (불량 ${defect}개 제외)` : ''}`);
    renderInbound();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '도착 처리 실패: ' + e.message;
    btn.disabled = false;
  }
});

$('#inboundStockRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.inb-defect-apply');
  if (!btn) return;
  const lotId = btn.dataset.lot;
  const lot = INB.lots.find((l) => String(l.id) === String(lotId));
  if (!lot) return;
  const addEl = document.querySelector(`.inb-adddefect[data-lot="${CSS.escape(lotId)}"]`);
  const dispEl = document.querySelector(`.inb-disp[data-lot="${CSS.escape(lotId)}"]`);
  const add = Math.min(Number(lot.qty_china) || 0, Math.max(0, parseInt(addEl && addEl.value, 10) || 0));
  const msg = $('#inboundMsg');
  if (add <= 0) { msg.className = 'msg err'; msg.textContent = '뺄 불량 수량을 입력하세요.'; return; }

  btn.disabled = true;
  try {
    /* 창고에서 빼고 불량 누계에 더한다. **개당 원가는 건드리지 않는다** —
       불량분은 환불받거나 손실로 털지, 남은 정상품 원가를 올리지 않는다. */
    const body = {
      qty_defect: (Number(lot.qty_defect) || 0) + add,
      qty_china: (Number(lot.qty_china) || 0) - add,
      defect_disposition: dispEl ? dispEl.value : 'refund'
    };
    await api(`inventory_lots?id=eq.${encodeURIComponent(lotId)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(lot, body);
    msg.className = 'msg hidden';
    toast(`불량 ${add}개 반영 — ${body.defect_disposition === 'refund' ? '예치금 환불 대상' : '손실 처리'}`);
    renderInbound();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '불량 반영 실패: ' + e.message;
    btn.disabled = false;
  }
});

/* ===================== 재고 · 재발주 제안 =====================
   다품종 소량에서 가장 큰 손실은 적자가 아니라 **품절**이다(팔릴 물건이 없는 것).
   반대로 너무 많이 사두면 재고에 현금이 묶인다. 사용자 방침(2026-08-18):
   "최대한 타이트하되 품절은 안 나도록, 판매 추이 보면서 발주량을 점증/점감."

   ── 계산 방식 (표준 공식으로 시작해서 나중에 튜닝) ──────────────
   일평균  = 최근 7일 평균 x 0.6 + 최근 28일 평균 x 0.4
     추이를 자동으로 따라간다. 최근에 잘 팔리면 7일 평균이 올라가 발주량이 늘고,
     시들해지면 자연히 준다 — 사용자가 원한 "점증/점감"이 별도 규칙 없이 나온다.
     28일만 쓰면 반응이 느리고, 7일만 쓰면 하루 튄 값에 휘둘린다.

   재주문점 = 일평균 x (리드타임 + 안전일수)
     리드타임 동안 팔릴 양 + 여유분. 쿠팡 재고가 이 밑으로 내려가면 조치가 필요하다.

   권장 수량 = 일평균 x (리드타임 + 안전일수 + 보충주기) - (쿠팡+운송중+중국창고)
     이미 파이프라인에 있는 물량을 빼야 이중 발주가 안 된다. MOQ 이상으로 올림.

   ── 판정 ────────────────────────────────────────────────────
   쿠팡 재고로 버틸 날이 (리드타임+안전일수)보다 짧으면 조치 필요.
     중국 창고에 재고가 있으면 -> **입고요청**(새로 사는 것보다 훨씬 빠르다)
     없으면 -> **발주 필요**
   판매 이력이 14일 미만인 SKU는 "데이터 부족"으로 표시하고 수량을 제안하지 않는다 —
   근거 없는 숫자를 자신 있게 내미는 것이 아무 말 안 하는 것보다 나쁘다. */
const STOCK = { rows: [], defaults: { leadTime: 14, safetyDays: 5, reviewCycle: 14, historyDays: 28 } };

async function loadStock() {
  const el = $('#stockRows');
  el.innerHTML = '<tr><td colspan="9" class="muted">불러오는 중…</td></tr>';
  try {
    const today = kstDateStr(new Date());
    const from = addDaysStr(today, -(STOCK.defaults.historyDays - 1));
    const [skus, listings, lots, wing, gross, poLines, orders] = await Promise.all([
      apiAll('my_skus?select=id,sku_name,barcode,moq,lead_time_days,safety_days,status'),
      apiAll('sku_channel_listings?select=sku_id,external_option_id&channel=eq.coupang_rg'),
      apiAll('inventory_lots?select=id,sku_id,po_line_id,qty_ordered,qty_arrived,qty_china,qty_transit,qty_coupang,arrived_coupang_at'),
      apiAll(`rocket_growth_sales_wing_daily?select=sale_date,vendor_item_id,quantity&sale_date=gte.${from}`),
      apiAll(`rocket_growth_sales_daily?select=sale_date,vendor_item_id,quantity&sale_date=gte.${from}`),
      apiAll('purchase_order_lines?select=id,po_id,sku_id'),
      apiAll('purchase_orders?select=id,requested_at')
    ]);

    const vidBySku = new Map();
    listings.forEach((l) => {
      if (!l.external_option_id) return;
      const arr = vidBySku.get(l.sku_id) || [];
      arr.push(String(l.external_option_id));
      vidBySku.set(l.sku_id, arr);
    });

    /* 판매 병합 규칙은 판매현황과 같다 — 그 날짜에 WING이 있으면 WING만 쓴다 */
    const wingDates = new Set(wing.map((r) => r.sale_date));
    const salesByVid = new Map();
    const addSale = (r) => {
      const key = String(r.vendor_item_id);
      const m = salesByVid.get(key) || new Map();
      m.set(r.sale_date, (m.get(r.sale_date) || 0) + (Number(r.quantity) || 0));
      salesByVid.set(key, m);
    };
    wing.forEach(addSale);
    gross.forEach((r) => { if (!wingDates.has(r.sale_date)) addSale(r); });

    /* 리드타임 실측: 발주 요청일 → 그 로트가 쿠팡에 도착한 날.
       예측(설정값)과 실측을 나란히 두는 게 이 프로젝트의 "복리" 방식이다
       (docs/decisions.md 2026-08-18 "예측을 저장한다"). */
    const poById = new Map(orders.map((o) => [o.id, o]));
    const lineById = new Map(poLines.map((l) => [l.id, l]));
    const leadBySku = new Map();
    lots.forEach((lot) => {
      if (!lot.arrived_coupang_at || !lot.sku_id) return;
      const line = lineById.get(lot.po_line_id);
      const po = line && poById.get(line.po_id);
      if (!po || !po.requested_at) return;
      const days = (new Date(lot.arrived_coupang_at) - new Date(po.requested_at)) / 86400000;
      if (!(days > 0 && days < 200)) return;
      const arr = leadBySku.get(lot.sku_id) || [];
      arr.push(days);
      leadBySku.set(lot.sku_id, arr);
    });

    const qtyBySku = new Map();
    lots.forEach((lot) => {
      if (!lot.sku_id) return;
      const q = qtyBySku.get(lot.sku_id) || { china: 0, transit: 0, coupang: 0, incoming: 0 };
      /* 아직 중국에도 안 온 물량(발주수량 − 도착수량)도 파이프라인이다 —
         이걸 빼먹으면 이미 주문한 걸 또 발주하게 된다(020). */
      q.incoming += Math.max(0, (Number(lot.qty_ordered) || 0) - (Number(lot.qty_arrived) || 0));
      q.china += Number(lot.qty_china) || 0;
      q.transit += Number(lot.qty_transit) || 0;
      q.coupang += Number(lot.qty_coupang) || 0;
      qtyBySku.set(lot.sku_id, q);
    });

    const d7from = addDaysStr(today, -6);
    STOCK.rows = skus.map((sku) => {
      const vids = vidBySku.get(sku.id) || [];
      let sum7 = 0, sum28 = 0, days = new Set();
      vids.forEach((vid) => {
        const m = salesByVid.get(vid);
        if (!m) return;
        m.forEach((q, date) => {
          days.add(date);
          sum28 += q;
          if (date >= d7from) sum7 += q;
        });
      });
      /* 판매가 아예 없는 날은 행이 없다 — 0으로 치고 기간 전체로 나눈다 */
      const avg7 = sum7 / 7;
      const avg28 = sum28 / STOCK.defaults.historyDays;
      const daily = Math.round((avg7 * 0.6 + avg28 * 0.4) * 100) / 100;

      const q = qtyBySku.get(sku.id) || { china: 0, transit: 0, coupang: 0, incoming: 0 };
      const measured = leadBySku.get(sku.id);
      const measuredLead = measured && measured.length
        ? Math.round((measured.reduce((a, x) => a + x, 0) / measured.length) * 10) / 10 : null;
      const lead = num(sku.lead_time_days) ?? measuredLead ?? STOCK.defaults.leadTime;
      const safety = num(sku.safety_days) ?? STOCK.defaults.safetyDays;

      const coverDays = daily > 0 ? q.coupang / daily : null;
      const pipeline = q.coupang + q.transit + q.china + q.incoming;
      const target = daily * (lead + safety + STOCK.defaults.reviewCycle);
      const moq = num(sku.moq) ?? 1;
      let need = Math.max(0, Math.ceil(target - pipeline));
      if (need > 0 && need < moq) need = moq;

      const enoughHistory = days.size >= 14 || sum28 > 0;
      let verdict = 'ok';
      if (sku.status && sku.status !== 'active') verdict = 'inactive';
      else if (!enoughHistory) verdict = 'nodata';
      else if (daily <= 0) verdict = 'nosale';
      else if (coverDays != null && coverDays < lead + safety) {
        verdict = q.china > 0 ? 'inbound' : 'order';
      }

      return { sku, q, daily, avg7, avg28, coverDays, lead, measuredLead, safety, need, moq, verdict, pipeline };
    });

    renderStock();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="9" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const STOCK_VERDICT = {
  order:    { label: '발주 필요',   cls: 'warn' },
  inbound:  { label: '입고요청',    cls: 'mid' },
  ok:       { label: '정상',        cls: 'dim' },
  nosale:   { label: '판매 없음',   cls: 'dim' },
  nodata:   { label: '데이터 부족', cls: 'dim' },
  inactive: { label: '판매중지',    cls: 'dim' }
};

function renderStock() {
  const f = $('#stockFilter').value;
  const q = ($('#stockSearch').value || '').trim().toLowerCase();

  const rows = STOCK.rows.filter((r) => {
    if (q) {
      const hay = `${r.sku.sku_name} ${r.sku.barcode || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f === 'action') return r.verdict === 'order' || r.verdict === 'inbound';
    if (f === 'order') return r.verdict === 'order';
    if (f === 'inbound') return r.verdict === 'inbound';
    return true;
  }).sort((a, b) => {
    const rank = (x) => ({ order: 0, inbound: 1, ok: 2 }[x.verdict] ?? 3);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.coverDays ?? 9999) - (b.coverDays ?? 9999);
  });

  const nOrder = STOCK.rows.filter((r) => r.verdict === 'order').length;
  const nInbound = STOCK.rows.filter((r) => r.verdict === 'inbound').length;
  $('#stockSummary').textContent =
    `발주 필요 ${nOrder} · 입고요청 ${nInbound} · 전체 SKU ${STOCK.rows.length}`;
  $('#stockNote').textContent =
    `일평균 = 최근 7일 평균×0.6 + 최근 ${STOCK.defaults.historyDays}일 평균×0.4 · ` +
    `재주문점 = 일평균×(리드타임+안전 ${STOCK.defaults.safetyDays}일) · ` +
    `권장 수량 = 일평균×(리드타임+안전+보충 ${STOCK.defaults.reviewCycle}일) − 이미 가진 물량, MOQ 이상 올림`;

  $('#stockRows').innerHTML = rows.length ? rows.map((r) => {
    const v = STOCK_VERDICT[r.verdict] || STOCK_VERDICT.ok;
    const cover = r.coverDays == null ? '—'
      : (r.coverDays < 999 ? `${Math.floor(r.coverDays)}일` : '—');
    const leadTxt = `${r.lead}일` + (r.measuredLead != null && num(r.sku.lead_time_days) == null
      ? '<span class="sku-name-sub">실측</span>' : '');
    return `<tr>
      <td>${esc(r.sku.sku_name)}<span class="sku-name-sub">${esc(r.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${r.q.coupang || '—'}</td>
      <td class="col-num">${r.q.transit || '—'}</td>
      <td class="col-num">${r.q.china || '—'}</td>
      <td class="col-num">${r.daily > 0 ? r.daily.toFixed(1) : '—'}</td>
      <td class="col-num ${r.verdict === 'order' || r.verdict === 'inbound' ? 'warn-txt' : ''}">${cover}</td>
      <td class="col-num">${leadTxt}</td>
      <td><span class="prog prog-${v.cls}">${esc(v.label)}</span></td>
      <td class="col-num">${(r.verdict === 'order' || r.verdict === 'inbound') && r.need > 0
          ? `<b>${r.need.toLocaleString()}</b>${r.need === r.moq ? '<span class="sku-name-sub">MOQ</span>' : ''}`
          : '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="muted">해당하는 SKU가 없습니다.</td></tr>';
}
$('#stockFilter').onchange = () => renderStock();
$('#stockSearch').oninput = () => renderStock();

/* ===================== 배대지(제트) 작업비 청구서 파서 =====================
   구매대행 청구서(PDF)와 완전히 다른 문서다. **어떤 상품이 몇 개인지가 아예 없고**
   작업 항목별 단가·건수·금액과 총액만 있다. 그래서 여기서 읽는 건 검산용 총액뿐이고,
   상품별 배분은 화면에서 SKU 기본 작업비로 계산한 값을 쓴다(사용자와 확인, 2026-08-18).

   실제 구조(2026-07-31 청구서 기준, 0-based 열):
     3열=단가, 4열=건수, 5열=청구금액
     "입고분류/검수/포장"  200원 x 447건 = 89,400원
     "바코드작업/원산지작업" 100원 x 894건 = 89,400원
     ...
     "청구 금액 합계"  178,800
     "부가세"           17,880
     "총 금액 합계"    196,680

   **빈 칸이 null이 아니라 공백 두 개('  ')나 '-'로 오는 칸이 많다** — 숫자인지부터
   확인해야 한다. 항목 행은 "단가·건수·금액이 모두 숫자이고 금액이 0보다 큰" 것만 고른다
   (금액 0인 행은 요금표에만 있고 이번에 청구되지 않은 항목이다). */
function parseZetInvoice(rows) {
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, '');

  let totalKrw = null, vatKrw = null, grandTotalKrw = null, rateNote = null;
  const items = [];

  (rows || []).forEach((r) => {
    if (!Array.isArray(r)) return;
    const label = norm(r[0]);
    const amount = r.find((c, i) => i >= 5 && isNum(c));

    if (label === '청구금액합계' && isNum(amount)) totalKrw = amount;
    else if (label === '부가세' && isNum(amount)) vatKrw = amount;
    else if (label === '총금액합계' && isNum(amount)) grandTotalKrw = amount;

    /* 구매대행 환율이 비고란에 문장으로 적혀 있다("... x 270 일괄적용").
       계산에 쓰진 않지만 화면에 보여주면 환율이 바뀐 걸 눈치챌 수 있다. */
    if (!rateNote) {
      const joined = r.map((c) => (c == null ? '' : String(c))).join(' ');
      const m = joined.match(/x\s*(\d{2,4})\s*일괄적용/);
      if (m) rateNote = { rate: Number(m[1]), text: joined.trim() };
    }

    if (isNum(r[3]) && isNum(r[4]) && isNum(r[5]) && r[5] > 0) {
      items.push({ name: String(r[1] || r[0] || '').trim(), unit: r[3], count: r[4], amount: r[5] });
    }
  });

  const itemSum = items.reduce((a, x) => a + x.amount, 0);
  return {
    totalKrw, vatKrw, grandTotalKrw, items, rateNote, itemSum,
    /* 항목 합과 "청구 금액 합계"가 다르면 우리가 못 읽은 항목이 있다는 뜻이다 */
    itemMismatch: (totalKrw != null && Math.abs(itemSum - totalKrw) > 1) ? itemSum - totalKrw : 0,
    error: totalKrw == null ? '청구 금액 합계를 찾지 못했습니다.' : null
  };
}

/* ===================== 출고 =====================
   중국 배대지 창고에 있는 것을 골라 한국(쿠팡센터)으로 보내는 화면.

   **왜 발주가 아니라 여기서 다루나**(2026-08-18 재설계): 부분 출고가 실제로 있고,
   제트 작업비 청구서는 여러 발주를 가로질러 묶여서 온다. 그래서 출고는 발주와
   독립된 단위(inbound_shipments)이고, SKU 기준으로 모아서 보여준다 —
   실무에서 "이 상품 보내주세요"라고 하지 "6월 26일 발주분 보내주세요"라고 하지 않는다.

   **로트를 쪼개는 이유**: 100개 중 60개만 보내면 그 60개엔 작업비가 붙고 남은 40개는
   안 붙어서 한 로트가 두 개의 개당 원가를 갖게 된다. 그래서 나가는 만큼을 새 로트로
   떼어내고(split_from_lot_id) 거기에만 작업비를 얹는다.

   **여러 발주에서 온 같은 SKU는 오래된 것부터 내보낸다**(사용자 확인) —
   실제 창고 운영과 같고, 선입선출 원가 계산과도 맞는다. */
const SHIP = { skus: [], lots: [], byPoLine: new Map(), poById: new Map(), hist: [], picks: new Map() };

/* 예전엔 "도착 예정 vs 창고에 있음"을 발주 단계로 갈랐는데, 020부터 **로트가 직접
   실제 도착 수량을 갖는다**(qty_arrived). 1688에서 일부만 먼저 오는 일이 실제로 있어서
   발주 단위 상태로는 표현이 안 됐다. 이제 미도착 = 발주수량 − 도착수량이고,
   창고에 실제로 있는 건 qty_china 하나뿐이라 우회 판정이 필요 없다. */
function lotIncoming(lot) {
  return Math.max(0, (Number(lot.qty_ordered) || 0) - (Number(lot.qty_arrived) || 0));
}

function skuWorkFee(sku) {
  const it = (sku && sku.work_fee_items) || {};
  return ['inspect', 'barcode', 'extra'].reduce((a, k) => a + (Number(it[k]) || 0), 0);
}

async function loadShip() {
  const el = $('#shipRows');
  el.innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  try {
    const [skus, lots, lines, orders, shipments, shipLines] = await Promise.all([
      apiAll('my_skus?select=id,sku_name,barcode,work_fee_items&order=sku_name.asc'),
      apiAll('inventory_lots?select=*'),
      apiAll('purchase_order_lines?select=id,po_id,sku_id'),
      apiAll('purchase_orders?select=id,status,requested_at'),
      apiAll('inbound_shipments?select=*&order=requested_at.desc'),
      apiAll('inbound_shipment_lines?select=shipment_id,qty')
    ]);
    SHIP.skus = skus;
    SHIP.lots = lots;
    SHIP.byPoLine = new Map(lines.map((l) => [l.id, l]));
    SHIP.poById = new Map(orders.map((o) => [o.id, o]));

    const agg = new Map();
    shipLines.forEach((l) => {
      const a = agg.get(l.shipment_id) || { n: 0, qty: 0 };
      a.n++; a.qty += l.qty || 0;
      agg.set(l.shipment_id, a);
    });
    SHIP.hist = shipments.map((s) => ({ s, agg: agg.get(s.id) || { n: 0, qty: 0 } }));

    renderShip();
    renderShipHist();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

/* SKU별로 로트를 모아 위치별 수량을 낸다. 도착 예정과 창고는 같은 qty_china지만
   발주 단계로 갈라서 보여준다(사용자 요청: 둘 다 보고 싶다). */
function shipBuckets() {
  const bySku = new Map();
  SHIP.lots.forEach((lot) => {
    if (!lot.sku_id) return;
    const b = bySku.get(lot.sku_id) || { incoming: 0, china: 0, transit: 0, coupang: 0, lots: [], cost: null };
    b.china += Number(lot.qty_china) || 0;
    b.incoming += lotIncoming(lot);
    b.transit += Number(lot.qty_transit) || 0;
    b.coupang += Number(lot.qty_coupang) || 0;
    b.lots.push(lot);
    if (b.cost == null && lot.unit_cost_krw != null) b.cost = Number(lot.unit_cost_krw);
    bySku.set(lot.sku_id, b);
  });
  return bySku;
}

function renderShip() {
  const f = $('#shipFilter').value;
  const bySku = shipBuckets();
  const skuById = new Map(SHIP.skus.map((s) => [s.id, s]));

  const rows = [];
  bySku.forEach((b, skuId) => {
    const sku = skuById.get(skuId);
    if (!sku) return;
    if (f === 'china' && b.china <= 0) return;
    if (f === 'incoming' && b.incoming <= 0) return;
    if (f === 'transit' && b.transit <= 0) return;
    if (f === 'coupang' && b.coupang <= 0) return;
    if (f === 'all' && (b.incoming + b.china + b.transit + b.coupang) <= 0) return;
    rows.push({ sku, b });
  });
  rows.sort((a, b) => a.sku.sku_name.localeCompare(b.sku.sku_name, 'ko'));

  const tot = rows.reduce((a, r) => ({
    incoming: a.incoming + r.b.incoming, china: a.china + r.b.china,
    transit: a.transit + r.b.transit, coupang: a.coupang + r.b.coupang
  }), { incoming: 0, china: 0, transit: 0, coupang: 0 });
  $('#shipSummary').textContent = rows.length
    ? `도착예정 ${tot.incoming} · 중국창고 ${tot.china} · 출고중 ${tot.transit} · 쿠팡센터 ${tot.coupang}`
    : '표시할 재고가 없습니다.';

  $('#shipRows').innerHTML = rows.length ? rows.map((r) => `<tr>
      <td>${esc(r.sku.sku_name)}<span class="sku-name-sub">${esc(r.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${r.b.incoming || '—'}</td>
      <td class="col-num">${r.b.china ? `<b>${r.b.china}</b>` : '—'}</td>
      <td class="col-num">${r.b.transit || '—'}</td>
      <td class="col-num">${r.b.coupang || '—'}</td>
      <td class="col-num">${r.b.cost == null ? '—' : Math.round(r.b.cost).toLocaleString() + '원'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">표시할 재고가 없습니다.</td></tr>';
}
$('#shipFilter').onchange = () => renderShip();

const SHIP_METHOD_LABEL = { milkrun_parcel: '밀크런 택배', pallet: '파렛트', direct_parcel: '택배 직납' };

function renderShipHist() {
  $('#shipHistRows').innerHTML = SHIP.hist.length ? SHIP.hist.map((h) => {
    const s = h.s;
    const arrived = !!s.arrived_at;
    return `<tr>
      <td>${esc((s.requested_at || '').slice(0, 10))}<span class="sku-name-sub">${esc(SHIP_METHOD_LABEL[s.shipping_method] || '')}</span></td>
      <td class="col-num">${h.agg.n}</td>
      <td class="col-num">${cnt(h.agg.qty)}</td>
      <td class="col-num">${s.computed_work_fee_krw == null ? '—' : Math.round(s.computed_work_fee_krw).toLocaleString() + '원'}</td>
      <td class="col-num">${s.work_fee_total_krw == null ? '<span class="muted">없음</span>' : Math.round(s.work_fee_total_krw).toLocaleString() + '원'}</td>
      <td><span class="prog prog-${arrived ? 'ok' : 'mid'}">${arrived ? '쿠팡센터 도착' : '출고중'}</span></td>
      <td>${arrived ? '' : `<button class="btn btn-sm ship-arrive" data-ship="${esc(s.id)}">도착 처리</button>`}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">아직 출고 이력이 없습니다.</td></tr>';
}

/* 도착 처리 — 그 출고의 로트들을 운송중에서 쿠팡으로 옮긴다.
   arrived_coupang_at은 선입선출 정렬 기준이라 여기서 꼭 남긴다. */
$('#shipHistRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.ship-arrive');
  if (!btn) return;
  btn.disabled = true;
  try {
    const id = btn.dataset.ship;
    const lines = await apiAll(`inbound_shipment_lines?select=lot_id,qty&shipment_id=eq.${encodeURIComponent(id)}`);
    const now = new Date().toISOString();
    for (const ln of lines) {
      if (!ln.lot_id) continue;
      const lot = SHIP.lots.find((l) => l.id === ln.lot_id);
      const transit = lot ? (Number(lot.qty_transit) || 0) : (ln.qty || 0);
      await api(`inventory_lots?id=eq.${ln.lot_id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { qty_transit: 0, qty_coupang: transit, arrived_coupang_at: now }
      });
    }
    await api(`inbound_shipments?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { arrived_at: now }
    });
    toast('쿠팡센터 도착 처리 완료');
    loadShip();
  } catch (e) {
    toast('도착 처리 실패: ' + e.message, 4000);
  } finally {
    btn.disabled = false;
  }
});

/* ── 출고 만들기 ── */
$('#shipNewBtn').onclick = () => {
  const bySku = shipBuckets();
  const skuById = new Map(SHIP.skus.map((s) => [s.id, s]));
  SHIP.picks = new Map();
  bySku.forEach((b, skuId) => {
    const sku = skuById.get(skuId);
    if (!sku || b.china <= 0) return;
    /* 기본값은 전량 — 사용자가 "왠만하면 전량 출고"라고 확인(2026-08-18) */
    SHIP.picks.set(skuId, { sku, avail: b.china, qty: b.china, fee: skuWorkFee(sku), on: true });
  });
  $('#shipDate').value = new Date().toISOString().slice(0, 10);
  $('#shipInvoiceTotal').value = '';
  $('#shipMsg').className = 'msg hidden';
  $('#shipInvoiceInfo').className = 'msg hidden';
  $('#shipFile').value = '';
  SHIP.invoice = null;
  renderShipPicks();
  $('#shipModal').classList.remove('hidden');
};
$$('#shipModal [data-close]').forEach((b) => { b.onclick = () => $('#shipModal').classList.add('hidden'); });

function renderShipPicks() {
  const rows = Array.from(SHIP.picks.entries());
  if (!rows.length) {
    $('#shipPickRows').innerHTML = '<tr><td colspan="6" class="muted">중국 창고에 보낼 재고가 없습니다. 발주를 "중국배대지 도착"으로 바꾸면 여기 나타납니다.</td></tr>';
    $('#shipComputed').value = '';
    return;
  }
  $('#shipPickRows').innerHTML = rows.map(([skuId, p]) => `<tr>
      <td><input type="checkbox" class="ship-on" data-sku="${esc(skuId)}" ${p.on ? 'checked' : ''} /></td>
      <td>${esc(p.sku.sku_name)}<span class="sku-name-sub">${esc(p.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${p.avail}</td>
      <td class="col-num"><input type="number" class="ship-qty defect-input" min="0" max="${p.avail}"
            data-sku="${esc(skuId)}" value="${p.qty}" ${p.on ? '' : 'disabled'} /></td>
      <td class="col-num"><input type="number" class="ship-fee defect-input" min="0"
            data-sku="${esc(skuId)}" value="${p.fee}" ${p.on ? '' : 'disabled'} /></td>
      <td class="col-num">${p.on ? (p.qty * p.fee).toLocaleString() + '원' : '—'}</td>
    </tr>`).join('');

  const computed = rows.reduce((a, [, p]) => a + (p.on ? p.qty * p.fee : 0), 0);
  $('#shipComputed').value = computed;

  const inv = Number($('#shipInvoiceTotal').value);
  const el = $('#shipCheck');
  if (!inv) {
    el.className = 'muted sm';
    el.textContent = '청구서 총액을 넣으면 우리 계산과 대조합니다. 비워두면 SKU 기본 작업비로 추정 저장됩니다.';
  } else if (Math.abs(inv - computed) < 1) {
    el.className = 'muted sm';
    el.textContent = `청구서와 정확히 일치합니다 (${computed.toLocaleString()}원).`;
  } else {
    el.className = 'warn-txt sm';
    el.textContent = `청구서 ${inv.toLocaleString()}원 vs 우리 계산 ${computed.toLocaleString()}원 — ` +
      `${(inv - computed > 0 ? '+' : '')}${(inv - computed).toLocaleString()}원 차이. 개당 작업비를 확인하세요.`;
  }
}

$('#shipPickRows').addEventListener('change', (ev) => {
  const on = ev.target.closest('.ship-on');
  if (on) { SHIP.picks.get(on.dataset.sku).on = on.checked; renderShipPicks(); return; }
  const q = ev.target.closest('.ship-qty');
  if (q) {
    const p = SHIP.picks.get(q.dataset.sku);
    p.qty = Math.max(0, Math.min(p.avail, parseInt(q.value, 10) || 0));
    renderShipPicks(); return;
  }
  const f = ev.target.closest('.ship-fee');
  if (f) {
    SHIP.picks.get(f.dataset.sku).fee = Math.max(0, parseInt(f.value, 10) || 0);
    renderShipPicks();
  }
});
$('#shipInvoiceTotal').oninput = () => renderShipPicks();

/* 작업비 청구서 업로드 — PDF와 같은 엔드포인트를 쓰고 응답의 kind로 갈린다.
   읽는 건 총액·부가세뿐이고, 상품별 배분은 화면의 SKU 작업비가 담당한다. */
$('#shipDrop').onclick = () => $('#shipFile').click();
$('#shipDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#shipDrop').classList.add('over'); });
$('#shipDrop').addEventListener('dragleave', () => $('#shipDrop').classList.remove('over'));
$('#shipDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#shipDrop').classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) shipHandleFile(f);
});
$('#shipFile').onchange = (e) => { const f = e.target.files[0]; if (f) shipHandleFile(f); };

async function shipHandleFile(file) {
  const info = $('#shipInvoiceInfo');
  info.className = 'msg';
  info.textContent = '청구서 읽는 중…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/parse-invoice', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    if (d.kind !== 'xlsx') throw new Error('엑셀 청구서만 자동 인식됩니다. PDF면 총액을 직접 넣어주세요.');

    const z = parseZetInvoice(d.rows);
    if (z.error) throw new Error(z.error);

    SHIP.invoice = z;
    $('#shipInvoiceTotal').value = z.totalKrw;

    const lines = [
      `<b>청구 금액 합계 ${z.totalKrw.toLocaleString()}원</b>` +
      (z.vatKrw != null ? ` · 부가세 ${z.vatKrw.toLocaleString()}원` : '') +
      (z.grandTotalKrw != null ? ` · 총액 ${z.grandTotalKrw.toLocaleString()}원` : '')
    ];
    z.items.forEach((it) => {
      lines.push(`${esc(it.name)} — ${it.unit.toLocaleString()}원 × ${it.count.toLocaleString()}건 = ${it.amount.toLocaleString()}원`);
    });
    if (z.itemMismatch) {
      lines.push(`<span class="warn-txt">항목 합계가 청구 금액 합계와 ${z.itemMismatch > 0 ? '+' : ''}${z.itemMismatch.toLocaleString()}원 차이 — 못 읽은 항목이 있을 수 있습니다.</span>`);
    }
    if (z.rateNote) {
      lines.push(`<span class="muted">구매대행 적용 환율 ${z.rateNote.rate} (청구서 비고란)</span>`);
    }
    info.className = 'msg';
    info.innerHTML = lines.join('<br>');
    renderShipPicks();
  } catch (e) {
    SHIP.invoice = null;
    info.className = 'msg err';
    info.textContent = '청구서 인식 실패: ' + e.message;
  }
}
$('#shipAll').onchange = (ev) => {
  SHIP.picks.forEach((p) => { p.on = ev.target.checked; });
  renderShipPicks();
};

$('#shipSave').onclick = async () => {
  const btn = $('#shipSave');
  const msg = $('#shipMsg');
  const picks = Array.from(SHIP.picks.values()).filter((p) => p.on && p.qty > 0);
  if (!picks.length) { msg.className = 'msg err'; msg.textContent = '보낼 상품을 고르세요.'; return; }

  btn.disabled = true;
  try {
    const computed = picks.reduce((a, p) => a + p.qty * p.fee, 0);
    const invoiceTotal = Number($('#shipInvoiceTotal').value) || null;
    const shipment = (await api('inbound_shipments', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: [{
        requested_at: ($('#shipDate').value || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z',
        shipping_method: $('#shipMethod').value,
        computed_work_fee_krw: computed,
        work_fee_total_krw: invoiceTotal,
        vat_krw: SHIP.invoice ? SHIP.invoice.vatKrw : null,
        grand_total_krw: SHIP.invoice ? SHIP.invoice.grandTotalKrw : null,
        /* 총액이 파일에서 온 건지 손으로 넣은 건지 남긴다 — 나중에 신뢰도를 판단하려면
           출처가 필요하다(프로젝트 원칙: 근거 데이터 소스를 추적 가능하게). */
        invoice_source: SHIP.invoice ? 'xlsx' : (invoiceTotal ? 'manual' : 'none'),
        confirmed_by_user: true
      }]
    }))[0];

    const shipLines = [];
    for (const p of picks) {
      /* 오래된 로트부터 뺀다(사용자 확인) — 창고 운영 순서이자 선입선출 원가와도 맞는다.
         도착 시각이 없으면(아직 안 찍힘) 발주 시각으로 정렬한다. */
      const lots = SHIP.lots
        .filter((l) => l.sku_id === p.sku.id && (Number(l.qty_china) || 0) > 0)
        .sort((a, b) => new Date(a.arrived_china_at || a.ordered_at || 0) - new Date(b.arrived_china_at || b.ordered_at || 0));

      let left = p.qty;
      for (const lot of lots) {
        if (left <= 0) break;
        const have = Number(lot.qty_china) || 0;
        const take = Math.min(have, left);
        left -= take;

        const purchase = Number(lot.unit_purchase_cost_krw != null ? lot.unit_purchase_cost_krw : lot.unit_cost_krw) || 0;
        const unitCost = Math.round((purchase + p.fee) * 100) / 100;

        let targetLotId = lot.id;
        if (take === have) {
          /* 통째로 나가면 그 로트를 그대로 옮기고 작업비를 얹는다 */
          await api(`inventory_lots?id=eq.${lot.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: {
              qty_china: 0, qty_transit: take,
              unit_work_fee_krw: p.fee, unit_cost_krw: unitCost, cost_status: 'confirmed',
              cost_breakdown: Object.assign({}, lot.cost_breakdown || {}, { work_fee: p.fee })
            }
          });
          lot.qty_china = 0; lot.qty_transit = take;
        } else {
          /* 일부만 나가면 나가는 만큼을 새 로트로 떼어낸다 —
             남은 수량은 다음에 다른 작업비로 나갈 수 있어 개당 원가가 달라진다 */
          const made = (await api('inventory_lots', {
            method: 'POST', headers: { prefer: 'return=representation' },
            body: [{
              sku_id: lot.sku_id, po_line_id: lot.po_line_id, split_from_lot_id: lot.id,
              qty_ordered: take, qty_china: 0, qty_transit: take,
              unit_purchase_cost_krw: purchase, unit_work_fee_krw: p.fee, unit_cost_krw: unitCost,
              cost_status: 'confirmed',
              cost_breakdown: Object.assign({}, lot.cost_breakdown || {}, { work_fee: p.fee, split_from: lot.id }),
              ordered_at: lot.ordered_at, arrived_china_at: lot.arrived_china_at
            }]
          }))[0];
          await api(`inventory_lots?id=eq.${lot.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: { qty_china: have - take }
          });
          lot.qty_china = have - take;
          targetLotId = made.id;
        }

        shipLines.push({
          shipment_id: shipment.id, lot_id: targetLotId, sku_id: p.sku.id, qty: take,
          work_fee_per_unit_krw: p.fee, unit_extra_cost_krw: p.fee
        });
      }
      if (left > 0) throw new Error(`${p.sku.sku_name}: 창고 수량이 부족합니다(${left}개 모자람).`);
    }
    if (shipLines.length) {
      await api('inbound_shipment_lines', { method: 'POST', headers: { prefer: 'return=minimal' }, body: shipLines });
    }

    $('#shipModal').classList.add('hidden');
    toast(`출고 저장 — ${picks.length}개 상품, 작업비 ${computed.toLocaleString()}원`);
    loadShip();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ===================== 상품원장 =====================
   my_skus가 이 시스템의 축이다(db/migrations/015). 목록 자체는 사람이 안 만든다 —
   scripts/rocket-growth-sync.js --skus 가 쿠팡 Open API에서 바코드까지 자동 적재한다.
   이 화면이 하는 일은 **쿠팡이 줄 수 없는 것만 사람이 채우는 것**이다:
   1688 링크·옵션(중국어)·MOQ·리드타임·한글표시사항.

   왜 조인을 클라이언트에서 하나: SKU 수천 개까지 가도 몇백 KB라 한 번에 받아서
   JS로 합치는 게 PostgREST 중첩 조인보다 단순하고 빠르다(소싱 탭이 8000행을
   같은 방식으로 다루고 있어 관례도 일치). */
const SKUS = { rows: [], byId: new Map(), editing: null };

async function loadSkus() {
  const el = $('#skuRows');
  el.innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  try {
    const [skus, products, listings, suppliers] = await Promise.all([
      apiAll('my_skus?select=*&order=sku_name.asc'),
      apiAll('my_products?select=id,name,status'),
      apiAll('sku_channel_listings?select=sku_id,channel,external_option_id,external_product_id'),
      apiAll('sku_suppliers?select=*')
    ]);

    const prodById = new Map(products.map((p) => [p.id, p]));
    /* 채널 매핑은 SKU당 여러 개일 수 있다(나중에 스마트스토어 등) — 지금은 쿠팡만 쓴다 */
    const listBySku = new Map();
    listings.forEach((l) => {
      if (l.channel !== 'coupang_rg') return;
      if (!listBySku.has(l.sku_id)) listBySku.set(l.sku_id, l);
    });
    /* 공급처도 복수 가능(같은 상품을 여러 1688 판매자에게서 산다) — is_primary 우선 */
    const supBySku = new Map();
    suppliers.forEach((s) => {
      const cur = supBySku.get(s.sku_id);
      if (!cur || (s.is_primary && !cur.is_primary)) supBySku.set(s.sku_id, s);
    });

    SKUS.rows = skus.map((s) => ({
      sku: s,
      product: prodById.get(s.product_id) || null,
      listing: listBySku.get(s.id) || null,
      supplier: supBySku.get(s.id) || null
    }));
    SKUS.byId = new Map(SKUS.rows.map((r) => [r.sku.id, r]));
    renderSkus();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const SKU_STATUS_LABEL = {
  active: '판매중', paused: '판매중지', liquidating: '청산중', discontinued: '단종'
};

function skuMatches(r, q) {
  if (!q) return true;
  const hay = [
    r.sku.sku_name, r.sku.barcode,
    r.listing && r.listing.external_option_id,
    r.listing && r.listing.external_product_id
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function renderSkus() {
  const q = ($('#skuSearch').value || '').trim().toLowerCase();
  const needSupplier = $('#skuNeedSupplier').checked;

  const list = SKUS.rows.filter((r) => {
    if (!skuMatches(r, q)) return false;
    if (needSupplier && r.supplier && r.supplier.offer_url) return false;
    return true;
  });

  const linked = SKUS.rows.filter((r) => r.supplier && r.supplier.offer_url).length;
  $('#skuSummary').textContent =
    `SKU ${SKUS.rows.length.toLocaleString()}개 · 1688 연결 ${linked}개` +
    (list.length !== SKUS.rows.length ? ` · 표시 ${list.length}개` : '');

  if (!list.length) {
    $('#skuRows').innerHTML =
      '<tr><td colspan="7" class="muted">해당하는 SKU가 없습니다.</td></tr>';
    return;
  }

  $('#skuRows').innerHTML = list.map((r) => {
    const s = r.sku;
    const optId = r.listing ? r.listing.external_option_id : null;
    const hasSup = !!(r.supplier && r.supplier.offer_url);
    return `<tr class="prow" data-sku="${esc(s.id)}">
      <td class="sku-bc">${s.barcode ? esc(s.barcode) : '<span class="muted">없음</span>'}</td>
      <td>${esc(s.sku_name)}</td>
      <td class="sku-bc">${optId ? esc(optId) : '<span class="muted">—</span>'}</td>
      <td>${hasSup
          ? '<span class="badge">연결됨</span>'
          : '<span class="muted">미연결</span>'}</td>
      <td class="col-num">${cnt(s.moq)}</td>
      <td class="col-num">${s.lead_time_days == null ? '—' : s.lead_time_days + '일'}</td>
      <td>${esc(SKU_STATUS_LABEL[s.status] || s.status)}</td>
    </tr>`;
  }).join('');
}

$('#skuSearch').oninput = () => renderSkus();
$('#skuNeedSupplier').onchange = () => renderSkus();

$('#skuRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-sku]');
  if (tr) openSkuModal(tr.dataset.sku);
});

function openSkuModal(skuId) {
  const r = SKUS.byId.get(skuId);
  if (!r) return;
  SKUS.editing = r;
  const s = r.sku, sup = r.supplier || {};

  $('#skuModalTitle').textContent = s.sku_name;
  /* 쿠팡에서 온 값은 편집 대상이 아니다 — 고쳐봐야 다음 동기화에 덮이거나
     조인이 깨진다. 읽기전용으로 보여주기만 한다. */
  $('#skuRo').innerHTML = [
    ['바코드', s.barcode || '없음'],
    ['옵션ID', r.listing ? r.listing.external_option_id : '—'],
    ['등록상품ID', r.listing ? r.listing.external_product_id : '—'],
    ['등록상품명', r.product ? r.product.name : '—']
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  const set = (id, v) => { $(id).value = v == null ? '' : v; };
  set('#skuOfferUrl', sup.offer_url);
  set('#skuOpt1', sup.option1_cn);
  set('#skuOpt2', sup.option2_cn);
  set('#skuPriceCny', sup.last_price_cny);
  set('#skuSellerId', sup.seller_1688_id);
  set('#skuMoq', s.moq);
  set('#skuLeadTime', s.lead_time_days);
  set('#skuSafetyDays', s.safety_days);
  set('#skuLabImporter', s.label_importer);
  set('#skuLabManufacturer', s.label_manufacturer);
  set('#skuLabOrigin', s.label_origin_country);
  set('#skuLabVolume', s.label_volume);
  set('#skuLabMaterial', s.label_material);
  set('#skuLabType', s.label_product_type);
  set('#skuLabCaution', s.label_caution);
  set('#skuLabUsage', s.label_usage_standard);
  set('#skuStatus', s.status || 'active');
  set('#skuMemo', s.memo);

  $('#skuMsg').className = 'msg hidden';
  $('#skuModal').classList.remove('hidden');
}

function closeSkuModal() {
  $('#skuModal').classList.add('hidden');
  SKUS.editing = null;
}
$$('#skuModal [data-close]').forEach((b) => { b.onclick = closeSkuModal; });

/* 빈 문자열은 null로 넣는다 — ''와 null이 섞이면 "값이 없다"를 두 가지로
   표현하게 되고, 나중에 AI가 스키마만 보고 쿼리를 짤 때 함정이 된다
   (프로젝트 원칙: 컬럼 의미가 코드 없이도 통해야 한다). */
const nz = (id) => { const v = $(id).value.trim(); return v === '' ? null : v; };
const nzNum = (id) => { const v = nz(id); return v === null ? null : Number(v); };

$('#skuSave').onclick = async () => {
  const r = SKUS.editing;
  if (!r) return;
  const btn = $('#skuSave');
  const msg = $('#skuMsg');
  btn.disabled = true;
  try {
    const patch = {
      moq: nzNum('#skuMoq'),
      lead_time_days: nzNum('#skuLeadTime'),
      safety_days: nzNum('#skuSafetyDays'),
      label_importer: nz('#skuLabImporter'),
      label_manufacturer: nz('#skuLabManufacturer'),
      label_origin_country: nz('#skuLabOrigin'),
      label_volume: nz('#skuLabVolume'),
      label_material: nz('#skuLabMaterial'),
      label_product_type: nz('#skuLabType'),
      label_caution: nz('#skuLabCaution'),
      label_usage_standard: nz('#skuLabUsage'),
      status: $('#skuStatus').value,
      memo: nz('#skuMemo'),
      updated_at: new Date().toISOString()
    };
    /* MOQ를 사람이 고치면 출처를 manual로 바꾼다 — 다음에 쿠플러스에서 자동으로
       긁어올 때 사람이 정한 값을 덮어쓰지 않기 위한 표시(015 설계 의도). */
    if (patch.moq !== r.sku.moq) patch.moq_source = 'manual';

    await api(`my_skus?id=eq.${encodeURIComponent(r.sku.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: patch
    });
    Object.assign(r.sku, patch);

    const supPatch = {
      offer_url: nz('#skuOfferUrl'),
      option1_cn: nz('#skuOpt1'),
      option2_cn: nz('#skuOpt2'),
      last_price_cny: nzNum('#skuPriceCny'),
      seller_1688_id: nz('#skuSellerId')
    };
    const hasSupInput = Object.values(supPatch).some((v) => v !== null);

    if (r.supplier) {
      await api(`sku_suppliers?id=eq.${r.supplier.id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: supPatch
      });
      Object.assign(r.supplier, supPatch);
    } else if (hasSupInput) {
      /* 첫 공급처는 자동으로 primary — 두 번째부터는 나중에 공급처 관리 화면에서 고른다 */
      const created = await api('sku_suppliers', {
        method: 'POST', headers: { prefer: 'return=representation' },
        body: [Object.assign({ sku_id: r.sku.id, is_primary: true }, supPatch)]
      });
      r.supplier = created[0];
    }

    /* offer_url에서 offerId를 뽑아둔다 — 나중에 1688 자동수집·재발주에서
       링크 문자열을 다시 파싱하지 않으려고 저장 시점에 한 번만 한다. */
    if (r.supplier && r.supplier.offer_url && !r.supplier.offer_id) {
      const m = r.supplier.offer_url.match(/offer\/(\d+)/);
      if (m) {
        await api(`sku_suppliers?id=eq.${r.supplier.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { offer_id: m[1] }
        });
        r.supplier.offer_id = m[1];
      }
    }

    renderSkus();
    closeSkuModal();
    toast('저장했습니다');
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ===================== 네비게이션 ===================== */
$$('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    const page = btn.dataset.page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.page').forEach((p) => p.classList.add('hidden'));
    $('#page-' + page).classList.remove('hidden');
    state.page = page;
    closeSidebar();

    if (page === 'po')         loadPOs();
    if (page === 'inbound')    loadInbound();
    if (page === 'stock')      loadStock();
    if (page === 'ship')       loadShip();
    if (page === 'skus')       loadSkus();
    if (page === 'sales')      loadSales();
    if (page === 'favorites')  loadFavorites();
    if (page === 'categories') loadCategories();
    if (page === 'queue')      loadQueue();
  };
});

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
}
$('#menuBtn').onclick = () => {
  $('#sidebar').classList.toggle('open');
  $('#scrim').classList.toggle('on');
};
$('#scrim').onclick = closeSidebar;

/* 사이드바 접기(데스크톱 전용, 사용자 요청 2026-08-16) — 5개 탭 아이콘+텍스트가 항상
   펼쳐진 채로 공간을 차지해서, localStorage에 상태를 저장해 다음 방문에도 유지되게 했다.
   모바일은 오프캔버스(위 .sidebar.open)라 애초에 공간을 안 차지하므로 버튼 자체를 숨김
   (CSS .nav-collapse-btn { display:none } @860px 이하). */
$('#sidebarCollapseBtn').onclick = () => {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
};

/* ===================== 테마 ===================== */
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
};

/* ===================== 시작 ===================== */
(async function init() {
  document.documentElement.dataset.theme =
    localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (localStorage.getItem('sidebarCollapsed') === '1') $('#sidebar').classList.add('collapsed');

  $('#loginView').classList.add('hidden');

  loadCfg();
  $('#cfgUrl').value = CFG.url;
  $('#cfgKey').value = CFG.key;

  if (CFG.url && CFG.key && AUTH.refresh) {
    try {
      await ensureAuth();
      await enterApp();
      return;
    } catch (e) { /* 세션 만료 - 관리자 자동 로그인으로 진행 */ }
  }

  if (CFG.url && CFG.key) {
    try {
      const d = await authRequest('token?grant_type=password', {
        email: ADMIN_EMAIL, password: ADMIN_PASSWORD
      });
      applySession(d);
      await enterApp();
      return;
    } catch (e) {
      showLoginMsg('자동 로그인 실패: ' + e.message, true);
    }
  }

  $('#loginView').classList.remove('hidden');
  if (!CFG.url) $('.cfg').setAttribute('open', '');
})();
