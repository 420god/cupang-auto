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

  const costKrw = (num(o.costCny) !== null)
    ? Math.round(o.costCny * (num(o.rate) ?? settings.rate))
    : null;

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
    };
  });
  return meta;
}

/* 하루치 옵션별 판매(items)를 확정 정산(confirmed, 있으면)과 합쳐 한 줄로 만든다.
   확정 정산에 있는 필드(수수료/입출고비/쿠폰/밀크런/순이익/매출)는 WING 확정값을 그대로 쓰고,
   없으면(주로 오늘 — 정산 인식이 D-1 지연) 카테고리 요율+요금표 추정으로 채운다.
   원가·배송/작업비·영업이익은 정산현황 API 자체에 없는 필드라 항상 옵션별 추정
   (user_items.cost_cny 등, calcMargin() 재사용)으로만 계산한다 — 확정/추정 여부와 무관. */
function buildDailyRow(date, items, meta, confirmed) {
  let quantity = 0, itemRevenue = 0;
  let estCommission = 0, estFulfillment = 0, estSettlement = 0;
  let cost = 0, shipWork = 0, opProfit = 0, costedQty = 0;

  items.forEach((it) => {
    quantity += it.quantity;
    itemRevenue += it.revenue;
    const m = meta[it.vendor_item_id] || {};
    const avgPrice = it.quantity ? it.revenue / it.quantity : 0;
    const commissionRate = commissionFor(m.catCode);
    const fee = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
    if (commissionRate == null) return;
    const c = calcMargin({
      price: avgPrice, commission: commissionRate, fulfillment: fee,
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

  const hasConfirmed = !!confirmed;
  const revenue = hasConfirmed ? confirmed.net_sales_amount : itemRevenue;
  const netProfit = hasConfirmed ? confirmed.profit_amount : estSettlement;
  const hasCost = costedQty > 0;

  return {
    date, quantity, revenue,
    commission: hasConfirmed ? confirmed.commission_amount : estCommission,
    fulfillment: hasConfirmed ? confirmed.fulfillment_amount : estFulfillment,
    coupon: hasConfirmed ? confirmed.coupon_amount : 0,
    milkrun: hasConfirmed ? confirmed.milkrun_amount : 0,
    netProfit,
    cost: hasCost ? cost : null,
    shipWork: hasCost ? shipWork : null,
    operatingProfit: hasCost ? (netProfit - cost - shipWork) : null,
    confirmed: hasConfirmed, itemRevenue
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
      `rocket_growth_profit_daily?select=sale_date,net_sales_amount,commission_amount,fulfillment_amount,` +
      `coupon_amount,ad_amount,milkrun_amount,profit_amount` +
      `&sale_date=gte.${fromDate}&sale_date=lte.${toDate}`
    )
  ]);

  // 같은 (날짜, 옵션)이면 WING 값(반품 반영)이 Open API 값(반품 미반영)보다 우선한다
  const merged = {};
  (grossRows || []).forEach((r) => { merged[r.sale_date + '|' + r.vendor_item_id] = r; });
  (wingRows || []).forEach((r) => { merged[r.sale_date + '|' + r.vendor_item_id] = r; });

  const byDate = {};
  Object.values(merged).forEach((r) => {
    (byDate[r.sale_date] = byDate[r.sale_date] || []).push(r);
  });

  const profitByDate = {};
  (profitRows || []).forEach((r) => { profitByDate[r.sale_date] = r; });

  const vendorItemIds = Array.from(new Set(Object.values(merged).map((r) => r.vendor_item_id)));

  return { byDate, profitByDate, vendorItemIds, hasWing: (wingRows || []).length > 0 };
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

/* 조회 기간(salesFrom~salesTo)만 표시하는 일별 상세표. */
function renderDailyTable(dailyByDate, fromDate, toDate) {
  const dates = dateRangeList(fromDate, toDate).slice().reverse(); // 최신 날짜가 위로
  const rows = dates.map((d) => dailyByDate[d]).filter(Boolean);

  $('#dailyEmpty').classList.toggle('hidden', rows.length > 0);
  $('#dailyBody').innerHTML = rows.map((r) => `
<tr>
  <td data-label="날짜">${r.date}</td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(r.commission)}</td>
  <td class="col-num" data-label="입출고비">${won(r.fulfillment)}</td>
  <td class="col-num" data-label="쿠폰비">${won(r.coupon)}</td>
  <td class="col-num" data-label="밀크런">${won(r.milkrun)}</td>
  <td class="col-num" data-label="순이익"><span class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${r.netProfit.toLocaleString()}원</span></td>
  <td class="col-num" data-label="원가">${r.cost != null ? won(r.cost) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="배송·작업비">${r.shipWork != null ? won(r.shipWork) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="영업이익">${
    r.operatingProfit != null
      ? `<span class="${r.operatingProfit >= 0 ? 'pos' : 'neg'}">${r.operatingProfit.toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`).join('');
}

/* 정산현황 API는 계정 전체 합계만 주고 어떤 상품이 팔렸는지는 없다(docs/api-notes.md 4-4-4) —
   그래서 상품별 합산 매출과 정산 매출을 서로 다른 소스에서 각각 만들 수밖에 없고, 둘이
   구조적으로 100% 일치할 보장이 없다. 조회 기간 안에 확정 정산이 있는 날짜만 골라 두 값을
   대조해서 보여준다 — 나중에 상품별 집계 로직을 손볼 때 어디서 얼마나 어긋나는지 바로 보이게. */
function renderReconcileNote(dailyByDate, fromDate, toDate) {
  const note = $('#salesReconcileNote');
  const rows = dateRangeList(fromDate, toDate).map((d) => dailyByDate[d]).filter((r) => r && r.confirmed);
  if (!rows.length) { note.classList.add('hidden'); return; }

  const itemSum = rows.reduce((s, r) => s + r.itemRevenue, 0);
  const settleSum = rows.reduce((s, r) => s + r.revenue, 0);
  const diff = itemSum - settleSum;
  if (Math.abs(diff) < 1) { note.classList.add('hidden'); return; }

  note.textContent =
    `대조: 확정 정산이 있는 ${rows.length}일 기준 — 옵션별 합산 매출 ${itemSum.toLocaleString()}원 vs ` +
    `정산현황 매출 ${settleSum.toLocaleString()}원 (차이 ${diff.toLocaleString()}원). ` +
    `아래 상품/옵션별 표와 정산 요약이 서로 다른 API를 집계한 값이라 생기는 차이일 수 있음.`;
  note.classList.remove('hidden');
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

    const dailyByDate = {};
    dateRangeList(fetchFrom, fetchTo).forEach((d) => {
      dailyByDate[d] = buildDailyRow(d, byDate[d] || [], meta, profitByDate[d]);
    });

    renderPeriodCards(dailyByDate, todayStr);
    renderDailyTable(dailyByDate, fromDate, toDate);
    renderReconcileNote(dailyByDate, fromDate, toDate);

    const rangeTxt = fromDate === toDate ? fromDate : `${fromDate} ~ ${toDate}`;
    $('#salesSummary').textContent = `${rangeTxt} 기준 (로켓그로스 Open API${hasWing ? ' + WING 반품 반영' : ''})`;

    // 상품/옵션별 표는 선택한 기간(fromDate~toDate)만 옵션 단위로 다시 합산
    const rangeByVendorItem = {};
    dateRangeList(fromDate, toDate).forEach((d) => {
      (byDate[d] || []).forEach((r) => {
        const cur = (rangeByVendorItem[r.vendor_item_id] = rangeByVendorItem[r.vendor_item_id] ||
          { vendorItemId: r.vendor_item_id, productName: r.product_name, quantity: 0, revenue: 0 });
        cur.quantity += r.quantity;
        cur.revenue += r.revenue;
      });
    });
    const items = Object.values(rangeByVendorItem);

    if (!items.length) {
      $('#salesEmpty').classList.remove('hidden');
      return;
    }

    renderSales(items, meta);
  } catch (e) {
    $('#salesMsg').textContent = '판매현황을 불러오지 못했습니다: ' + e.message;
    $('#salesMsg').classList.remove('hidden');
  } finally {
    $('#salesLoader').classList.add('hidden');
    $('#dailyLoader').classList.add('hidden');
  }
}

function renderSales(items, meta) {
  let costedCount = 0, noCommissionCount = 0;

  const rows = items.map((it) => {
    const m = meta[it.vendorItemId] || {};
    const avgPrice = it.quantity ? it.revenue / it.quantity : 0;
    const fee = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
    const commissionRate = commissionFor(m.catCode);

    if (commissionRate == null) { noCommissionCount++; return { it, noCommission: true }; }

    const c = calcMargin({
      price: avgPrice, commission: commissionRate, fulfillment: fee,
      costCny: m.costCny, rate: m.exchangeRate, outbound: m.outboundFee, work: m.workFee
    });

    const commissionSum = c ? c.commission * it.quantity : null;
    const fulfillmentSum = (fee != null) ? fee * it.quantity : null;
    const marginSum = (c && c.margin !== null) ? c.margin * it.quantity : null;

    if (marginSum != null) costedCount++;

    return { it, commissionSum, fulfillmentSum, marginSum, commissionRate };
  });

  const uncosted = items.length - costedCount - noCommissionCount;
  const notes = [];
  if (uncosted > 0) notes.push(`원가 미입력 상품 ${uncosted}개`);
  if (noCommissionCount > 0) notes.push(`수수료 정보 없는 상품 ${noCommissionCount}개`);
  $('#salesTableNote').textContent = notes.length ? `${notes.join(' · ')}는 이익 합계에서 제외됨` : '';

  $('#salesBody').innerHTML = rows.map((r) => {
    const { it } = r;
    if (r.noCommission) {
      return `
<tr>
  <td>${esc(it.productName || '(이름 없음)')}</td>
  <td class="col-num" data-label="판매수량">${cnt(it.quantity)}</td>
  <td class="col-num" data-label="매출">${won(it.revenue)}</td>
  <td class="col-num" data-label="추정 수수료"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="추정 입출고비"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="추정 이익"><span class="dim">수수료 정보 없음</span></td>
</tr>`;
    }
    const { commissionSum, fulfillmentSum, marginSum, commissionRate } = r;
    return `
<tr>
  <td>${esc(it.productName || '(이름 없음)')}</td>
  <td class="col-num" data-label="판매수량">${cnt(it.quantity)}</td>
  <td class="col-num" data-label="매출">${won(it.revenue)}</td>
  <td class="col-num" data-label="추정 수수료">${commissionSum != null ? `${won(Math.round(commissionSum))} (${commissionRate}%)` : '—'}</td>
  <td class="col-num" data-label="추정 입출고비">${fulfillmentSum != null ? won(Math.round(fulfillmentSum)) : '<span class="dim">요금표 없음</span>'}</td>
  <td class="col-num" data-label="추정 이익">${
    marginSum != null
      ? `<span class="${marginSum >= 0 ? 'pos' : 'neg'}">${Math.round(marginSum).toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
  }).join('');
}

$('#salesRefresh').onclick = loadSales;
$('#salesBackfillBtn').onclick = backfillSales;

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

/* ===================== 네비게이션 ===================== */
$$('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    const page = btn.dataset.page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.page').forEach((p) => p.classList.add('hidden'));
    $('#page-' + page).classList.remove('hidden');
    state.page = page;
    closeSidebar();

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
