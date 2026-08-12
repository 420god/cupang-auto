/* ============================================================
   Supabase 연동
   - publishable key + 관리자 계정 로그인 방식
   - service_role 키는 사용하지 않습니다 (노출 위험)
   ============================================================ */

const SB = {
  url: '',
  key: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  email: ''
};

/* ---------- 설정 저장/복원 ---------- */
async function sbLoadConfig() {
  try {
    const c = await chrome.storage.local.get([
      'sb_url', 'sb_key', 'sb_access', 'sb_refresh', 'sb_expires', 'sb_email'
    ]);
    SB.url = c.sb_url || '';
    SB.key = c.sb_key || '';
    SB.accessToken = c.sb_access || '';
    SB.refreshToken = c.sb_refresh || '';
    SB.expiresAt = c.sb_expires || 0;
    SB.email = c.sb_email || '';
  } catch (e) { /* 무시 */ }
}

async function sbSaveConfig() {
  try {
    await chrome.storage.local.set({
      sb_url: SB.url,
      sb_key: SB.key,
      sb_access: SB.accessToken,
      sb_refresh: SB.refreshToken,
      sb_expires: SB.expiresAt,
      sb_email: SB.email
    });
  } catch (e) { /* 무시 */ }
}

function sbConfigured() {
  return !!(SB.url && SB.key);
}

function sbLoggedIn() {
  return !!(SB.accessToken && Date.now() < SB.expiresAt);
}

/* ---------- 인증 ---------- */
async function sbLogin(email, password) {
  const res = await fetch(`${SB.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SB.key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const d = await res.json();
  if (!res.ok) {
    throw new Error(d.error_description || d.msg || d.message || `로그인 실패 (HTTP ${res.status})`);
  }
  SB.accessToken = d.access_token;
  SB.refreshToken = d.refresh_token;
  SB.expiresAt = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
  SB.email = email;
  await sbSaveConfig();
  return d;
}

async function sbRefresh() {
  if (!SB.refreshToken) throw new Error('저장된 세션이 없습니다. 다시 로그인하세요.');
  const res = await fetch(`${SB.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': SB.key, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: SB.refreshToken })
  });
  const d = await res.json();
  if (!res.ok) throw new Error('세션 갱신 실패. 다시 로그인하세요.');
  SB.accessToken = d.access_token;
  SB.refreshToken = d.refresh_token;
  SB.expiresAt = Date.now() + (d.expires_in || 3600) * 1000 - 60000;
  await sbSaveConfig();
}

async function sbEnsureAuth() {
  if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. URL과 키를 먼저 입력하세요.');
  if (sbLoggedIn()) return;
  await sbRefresh();
}

async function sbLogout() {
  SB.accessToken = '';
  SB.refreshToken = '';
  SB.expiresAt = 0;
  await sbSaveConfig();
}

/* ---------- REST 호출 ---------- */
async function sbRequest(path, opts) {
  await sbEnsureAuth();
  const o = opts || {};
  const headers = Object.assign({
    'apikey': SB.key,
    'authorization': 'Bearer ' + SB.accessToken,
    'content-type': 'application/json'
  }, o.headers || {});

  const res = await fetch(`${SB.url}/rest/v1/${path}`, {
    method: o.method || 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined
  });

  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.message || j.hint || j.details || msg;
    } catch (e) { /* 원문 사용 */ }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}

/* upsert: 충돌 시 갱신 */
async function sbUpsert(table, rows, onConflict) {
  if (!rows || rows.length === 0) return { count: 0 };
  const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  await sbRequest(table + q, {
    method: 'POST',
    headers: {
      'prefer': 'resolution=merge-duplicates,return=minimal',
      'content-profile': 'public'
    },
    body: rows
  });
  return { count: rows.length };
}

/* insert: 충돌 시 무시 (이력 테이블용) */
async function sbInsertIgnore(table, rows) {
  if (!rows || rows.length === 0) return { count: 0 };
  await sbRequest(table, {
    method: 'POST',
    headers: { 'prefer': 'resolution=ignore-duplicates,return=minimal' },
    body: rows
  });
  return { count: rows.length };
}

/* ---------- 데이터 변환 ---------- */

/* 수집 행들을 products / product_items / item_history 로 변환 */
function buildSupabasePayload(rows, details, feeMap) {
  const productMap = {};
  const items = [];
  const history = [];
  const cats = {};

  rows.forEach((r) => {
    const pid = String(r.productId || '');
    const iid = String(r.itemId || '');
    if (!pid || !iid) return;

    const d = details[pid + '_' + iid] || details[pid] || {};
    const price = (d.salePrice !== undefined && d.salePrice !== '' && d.salePrice !== null)
      ? Number(d.salePrice)
      : (r.salesPrice ? Number(r.salesPrice) : null);
    const sales = (typeof d.salesNumber === 'number') ? d.salesNumber : null;

    /* 카테고리 */
    if (r.categoryCode && !cats[r.categoryCode]) {
      const u = feeMap && feeMap[String(r.categoryId)];
      cats[r.categoryCode] = {
        category_code: String(r.categoryCode),
        name: r.categoryName || '',
        full_path: r.categoryHierarchy || '',
        depth: r.categoryHierarchy ? r.categoryHierarchy.split('>').length : null,
        is_leaf: true,
        kan_category_id: r.categoryId ? String(r.categoryId) : null,
        unit1: u ? u.unit1 : null,
        unit2: u ? u.unit2 : null
      };
    }

    /* 상품 (옵션들을 모아 집계) */
    if (!productMap[pid]) {
      productMap[pid] = {
        product_id: pid,
        product_name: r.productName || '',
        brand_name: r.brandName || '',
        manufacture: r.manufacture || '',
        category_code: r.categoryCode ? String(r.categoryCode) : null,
        category_id: r.categoryId ? String(r.categoryId) : null,
        category_path: r.categoryHierarchy || '',
        pv_rank: (typeof r.pvLast28dRank === 'number') ? r.pvLast28dRank : null,
        pv_lower: cleanPv(r.lowerPvLast28d) || null,
        pv_upper: cleanPv(r.upperPvLast28d) || null,
        rating: (typeof r.rating === 'number') ? r.rating : null,
        rating_count: (typeof r.ratingCount === 'number') ? r.ratingCount : null,
        max_sales: null,
        sum_sales: null,
        min_price: null,
        max_price: null,
        option_count: 0,
        has_rocket: false,
        all_soldout: true,
        rep_image_path: null,
        last_seen_at: new Date().toISOString(),
        _repSales: -1
      };
    }

    const p = productMap[pid];
    p.option_count++;

    if (typeof sales === 'number') {
      p.max_sales = (p.max_sales === null) ? sales : Math.max(p.max_sales, sales);
      p.sum_sales = (p.sum_sales === null) ? sales : p.sum_sales + sales;
      if (sales > p._repSales) {
        p._repSales = sales;
        p.rep_image_path = r.imagePath || p.rep_image_path;
      }
    }
    if (!p.rep_image_path && r.imagePath) p.rep_image_path = r.imagePath;

    if (typeof price === 'number' && price > 0) {
      p.min_price = (p.min_price === null) ? price : Math.min(p.min_price, price);
      p.max_price = (p.max_price === null) ? price : Math.max(p.max_price, price);
    }

    const badge = d.deliveryBadge || '';
    if (badge && badge.indexOf('로켓') !== -1) p.has_rocket = true;
    if (!d.soldOut) p.all_soldout = false;

    /* 옵션 */
    items.push({
      item_id: iid,
      product_id: pid,
      vendor_item_id: r.vendorItemId ? String(r.vendorItemId) : null,
      item_name: r.itemName || '',
      image_path: r.imagePath || '',
      current_price: (typeof price === 'number') ? price : null,
      origin_price: (typeof d.originPrice === 'number') ? d.originPrice : null,
      price_basis: d.priceBasis || null,
      sales_text: d.salesText || null,
      sales_number: sales,
      delivery_badge: d.deliveryBadge || null,
      delivery_basis: d.deliveryBasis || null,
      shipping_fee: d.shippingFee || null,
      courier: d.courier || null,
      seller_name: d.sellerName || null,
      is_soldout: !!d.soldOut,
      listing_eligibility: r.listingEligibility || null,
      last_seen_at: new Date().toISOString(),
      detail_updated_at: (d.salesText || d.deliveryBadge) ? new Date().toISOString() : null
    });

    /* 이력 (같은 날 중복은 DB의 유니크 인덱스가 막습니다) */
    if (price !== null || sales !== null) {
      history.push({
        item_id: iid,
        product_id: pid,
        price: (typeof price === 'number') ? price : null,
        sales_number: sales,
        pv_rank: (typeof r.pvLast28dRank === 'number') ? r.pvLast28dRank : null,
        rating_count: (typeof r.ratingCount === 'number') ? r.ratingCount : null,
        delivery_badge: d.deliveryBadge || null,
        is_soldout: !!d.soldOut,
        change_reason: 'collect'
      });
    }
  });

  const products = Object.values(productMap).map((p) => {
    delete p._repSales;
    return p;
  });

  return {
    categories: Object.values(cats),
    products,
    items,
    history
  };
}

/* 요금표를 DB 형식으로 */
function buildFeeRows(feeTables, isLowAsp) {
  const out = [];
  Object.keys(feeTables).forEach((k) => {
    const [u1, u2] = k.split('|');
    const t = feeTables[k];
    Object.keys(t).forEach((cap) => {
      t[cap].forEach((tier) => {
        out.push({
          unit1: u1,
          unit2: u2,
          capacity_type: cap,
          min_price: tier.minPrice,
          base_amount: tier.base,
          final_amount: tier.final,
          is_low_asp: !!isLowAsp
        });
      });
    });
  });
  return out;
}


/* 카테고리 트리 전체를 DB 형식으로 변환 */
function buildCategoryRows(cats) {
  return cats.map((c) => {
    const path = c.path || c.name || '';
    const root = path.split('>')[0] || '';
    const parts = path.split('>');
    return {
      category_code: String(c.code),
      name: c.name || '',
      full_path: path,
      depth: c.depth || parts.length,
      is_leaf: !!c.isLeaf,
      root_name: root,
      parent_path: parts.slice(0, -1).join('>') || null
    };
  });
}

/* 1000행 제한을 넘겨서 전부 가져오기 (limit/offset 페이지네이션) */
async function sbFetchAll(pathBase, pageSize) {
  pageSize = pageSize || 1000;
  let all = [];
  let offset = 0;
  for (;;) {
    const sep = pathBase.indexOf('?') === -1 ? '?' : '&';
    const rows = await sbRequest(`${pathBase}${sep}limit=${pageSize}&offset=${offset}`);
    if (!rows || !rows.length) break;
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/* 이미 DB에 채워진 카테고리 unit 매핑 / 요금표 unit 조합을 조회 (중복 수집 방지용) */
async function sbFetchKnownFeeState() {
  const catRows = await sbFetchAll(
    'categories?select=kan_category_id,unit1,unit2&kan_category_id=not.is.null&unit1=not.is.null'
  );
  const catMap = {};
  catRows.forEach((r) => {
    if (r.kan_category_id) catMap[String(r.kan_category_id)] = { unit1: r.unit1, unit2: r.unit2 };
  });

  const feeRows = await sbFetchAll('fulfillment_fees?select=unit1,unit2,is_low_asp');
  const feeSet = new Set();
  feeRows.forEach((r) => feeSet.add(`${r.unit1}|${r.unit2}|${r.is_low_asp ? 1 : 0}`));

  return { catMap, feeSet };
}

/* 카테고리 수집 시각 갱신 */
async function sbMarkCategoryCollected(categoryCode, stage) {
  const patch = {};
  const now = new Date().toISOString();
  if (stage === 'list' || stage === 'both') patch.last_list_at = now;
  if (stage === 'detail' || stage === 'both') patch.last_detail_at = now;
  if (!Object.keys(patch).length) return;

  await sbRequest(`categories?category_code=eq.${encodeURIComponent(categoryCode)}`, {
    method: 'PATCH',
    headers: { 'prefer': 'return=minimal' },
    body: patch
  });
}

/* ---------- 대기열 ---------- */

/* 처리할 다음 작업 하나 가져오기 */
async function sbFetchNextJob() {
  const rows = await sbRequest(
    'collect_queue?select=*&status=eq.pending&order=priority.desc,requested_at.asc&limit=1'
  );
  return (Array.isArray(rows) && rows.length) ? rows[0] : null;
}

/* 작업 상태 변경 */
async function sbUpdateJob(id, patch) {
  await sbRequest(`collect_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'prefer': 'return=minimal' },
    body: patch
  });
}

/* 대기 중인 작업 수 */
async function sbCountPending() {
  const res = await fetch(`${SB.url}/rest/v1/collect_queue?select=id&status=eq.pending`, {
    headers: {
      'apikey': SB.key,
      'authorization': 'Bearer ' + SB.accessToken,
      'prefer': 'count=exact',
      'range': '0-0'
    }
  });
  const cr = res.headers.get('content-range') || '';
  const n = parseInt((cr.split('/')[1] || '0'), 10);
  return isNaN(n) ? 0 : n;
}

/* 배열을 n개씩 나눕니다 (대량 업로드용) */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
