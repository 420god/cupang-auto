#!/usr/bin/env node
/* GCP VPS(고정 IP)에서 직접 실행하는 동기화 스크립트.
   Vercel(web/api/sales-today.js)은 고정 IP가 없어서 쿠팡 WAF에 막혔다 —
   이 스크립트는 VPS 자체의 고정 IP로 쿠팡 로켓그로스 주문 API를 호출하고,
   결과를 Supabase의 rocket_growth_sales_daily 테이블에 upsert한다
   (db/migrations/005_rocket_growth_sales.sql). 웹은 이 테이블만 읽는다.

   cron으로 주기 실행. 기본은 "오늘 + 어제"만 다시 계산해서 upsert한다
   (자정 근처 오차, 뒤늦게 반영되는 주문을 잡기 위함 — upsert라서 안전하게 반복 가능).

   필요한 환경변수 (.env, git에 올리지 말 것 — .gitignore 확인):
     COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID
     SUPABASE_URL, SUPABASE_ANON_KEY   (publishable key. service_role은 절대 안 씀 — 프로젝트 규칙)
     SB_ADMIN_EMAIL, SB_ADMIN_PASSWORD (관리자 계정 — is_admin() RLS로 쓰기 허용됨)

   실행: node rocket-growth-sync.js [--days=N]   (기본 N=2, 오늘+어제)

   --products 플래그를 추가하면 상품 등록정보(등록상품ID·상품ID·옵션ID 매핑,
   rocket_growth_product_registry, db/migrations/014)도 같이 동기화한다.
   전체 카탈로그를 페이지네이션하는 무거운 호출이라 주문 동기화처럼 몇 분마다
   돌리면 낭비다 — cron에 별도의 낮은 빈도(예: 하루 1회) 줄로 따로 등록할 것.
   예시(주문 동기화는 몇 분 간격, 상품 레지스트리는 새벽 3시에 하루 1회):
     node rocket-growth-sync.js            (기존 주문 동기화 크론, 그대로 둠)
     node rocket-growth-sync.js --products (새로 추가, 0 3 dot dot dot 형태로 하루 1회)
   주의: 이 주석 블록 안에는 cron의 분 단위 반복 기호를 별표+슬래시로 쓴 리터럴을
   넣지 말 것 — JS 블록 주석에서 별표+슬래시는 "주석 끝"으로 해석돼 그 뒤 전체가
   코드로 파싱되면서 SyntaxError가 난다(2026-08-17 실제로 겪음: 별표/5 * * * * 를
   그대로 적었다가 VPS에서 파일 전체가 깨졌었다 — 크론 예시는 항상 말로 풀어 쓸 것).
*/

const crypto = require('crypto');
const path = require('path');
/* .env를 __dirname 기준으로 읽는다 — dotenv 기본값은 "실행한 위치(cwd)"라서,
   저장소 루트에서 node scripts/rocket-growth-sync.js 로 돌리면 scripts/.env를
   못 찾아 환경변수 7개가 전부 누락됐다고 죽는다(2026-08-18 실제로 겪음).
   이렇게 해두면 어느 디렉터리에서 실행해도 동작한다 — 기존 크론(scripts로 cd한 뒤
   실행)도 __dirname이 같으므로 영향 없음. */
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID,
  SUPABASE_URL, SUPABASE_ANON_KEY, SB_ADMIN_EMAIL, SB_ADMIN_PASSWORD
} = process.env;

function requireEnv() {
  const missing = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID',
    'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SB_ADMIN_EMAIL', 'SB_ADMIN_PASSWORD']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('환경변수 누락:', missing.join(', '));
    process.exit(1);
  }
}

const HOST = 'https://api-gateway.coupang.com';

function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function authHeader(method, path, query) {
  const datetime = signedDate();
  const message = datetime + method + path + query;
  const signature = crypto.createHmac('sha256', COUPANG_SECRET_KEY).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

function kstDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/* days=2 -> 오늘, 어제 두 날짜(KST)를 8자리로 반환 */
function recentDates(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    out.push(kstDateStr(new Date(Date.now() - i * 86400000)).replace(/-/g, ''));
  }
  return out; // [오늘, 어제, ...] 최신순
}

async function fetchOrders(fromDate, toDate) {
  const path = `/v2/providers/rg_open_api/apis/api/v1/vendors/${COUPANG_VENDOR_ID}/rg/orders`;
  let nextToken = '';
  let orders = [];

  for (let page = 0; page < 50; page++) {
    const query = `paidDateFrom=${fromDate}&paidDateTo=${toDate}` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : '');
    const header = authHeader('GET', path, query);

    const res = await fetch(`${HOST}${path}?${query}`, {
      headers: { Authorization: header, 'Content-Type': 'application/json;charset=UTF-8' }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`쿠팡 API 오류 (HTTP ${res.status}): ${text.slice(0, 300)}`);

    const body = JSON.parse(text);
    orders = orders.concat(body.data || []);
    nextToken = body.nextToken || '';
    if (!nextToken) break;
  }
  return orders;
}

/* 주문을 (paidAt의 KST 날짜, vendorItemId) 기준으로 집계 */
function groupByDay(orders) {
  const byDay = {}; // sale_date -> { vendorItemId -> {productName, quantity, revenue} }

  orders.forEach((order) => {
    const day = kstDateStr(new Date(order.paidAt));
    const bucket = (byDay[day] = byDay[day] || {});

    (order.orderItems || []).forEach((it) => {
      const qty = Number(it.salesQuantity) || 0;
      const unit = Number(it.unitSalesPrice) || 0;
      const key = String(it.vendorItemId);
      const row = (bucket[key] = bucket[key] || { vendorItemId: key, productName: it.productName || '', quantity: 0, revenue: 0 });
      row.quantity += qty;
      row.revenue += qty * unit;
    });
  });

  const rows = [];
  Object.entries(byDay).forEach(([day, items]) => {
    Object.values(items).forEach((it) => rows.push({
      sale_date: day,
      vendor_item_id: it.vendorItemId,
      product_name: it.productName,
      quantity: it.quantity,
      revenue: it.revenue
    }));
  });
  return rows;
}

/* 상품 목록 페이징 조회(공식 Open API, seller_api 계열 — RG 전용 API 아님에 주의) —
   등록상품ID(sellerProductId)·상품ID(productId)·옵션ID(vendorItemId)를 매핑해서
   rocket_growth_product_registry에 채운다. docs/api-notes.md 4-7 참조.
   SKU ID는 이 API에 없어서 뺐다(2026-08-16 사용자 결정, 나중에 재고 페이지 만들 때
   다시 조사하기로 함).
   businessTypes=rocketGrowth로 걸러도 하이브리드(로켓그로스+마켓플레이스 동시운영)
   상품은 items[].rocketGrowthItem과 items[].marketPlaceItem이 둘 다 있을 수 있어서,
   rocketGrowthItem을 우선 쓰고 없으면 marketPlaceItem으로 폴백한다(판매현황이
   로켓그로스 vendorItemId 기준이라 원칙적으로는 rocketGrowthItem이 맞음). */
async function fetchProductRegistry() {
  const path = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  let nextToken = '';
  let products = [];

  for (let page = 0; page < 200; page++) {
    const query = `vendorId=${COUPANG_VENDOR_ID}&businessTypes=rocketGrowth&maxPerPage=100` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : '');
    const header = authHeader('GET', path, query);

    const res = await fetch(`${HOST}${path}?${query}`, {
      headers: { Authorization: header, 'Content-Type': 'application/json;charset=UTF-8' }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`쿠팡 상품목록 API 오류 (HTTP ${res.status}): ${text.slice(0, 300)}`);

    const body = JSON.parse(text);
    products = products.concat(body.data || []);
    nextToken = body.nextToken || '';
    if (!nextToken) break;
  }
  return products;
}

function flattenProductRegistry(products) {
  const rows = [];
  products.forEach((p) => {
    (p.items || []).forEach((it) => {
      const rg = it.rocketGrowthItem || it.marketPlaceItem;
      if (!rg || rg.vendorItemId == null) return;
      rows.push({
        vendor_item_id: String(rg.vendorItemId),
        seller_product_id: p.sellerProductId != null ? String(p.sellerProductId) : null,
        seller_product_item_id: it.sellerProductItemId != null ? String(it.sellerProductItemId) : null,
        product_id: p.productId != null ? String(p.productId) : null,
        vendor_inventory_item_id: rg.vendorInventoryItemId != null ? String(rg.vendorInventoryItemId) : null,
        seller_product_name: p.sellerProductName || null,
        updated_at: new Date().toISOString()
      });
    });
  });
  return rows;
}

async function upsertProductRegistry(accessToken, rows) {
  if (!rows.length) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rocket_growth_product_registry?on_conflict=vendor_item_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase upsert 실패 (상품 레지스트리, HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
  }
}

async function supabaseLogin() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: SB_ADMIN_EMAIL, password: SB_ADMIN_PASSWORD })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`Supabase 로그인 실패: ${d.error_description || d.msg || res.status}`);
  return d.access_token;
}

async function upsertRows(accessToken, rows) {
  if (!rows.length) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rocket_growth_sales_daily?on_conflict=sale_date,vendor_item_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase upsert 실패 (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
  }
}

/* ============================================================
   --skus : 상품원장(my_skus) 자동 적재  (db/migrations/015, 2026-08-18 신설)

   왜 필요한가: 015에서 만든 my_products/my_skus가 비어 있으면 발주·원가·재고가
   붙을 곳이 없다. 다행히 rocket_growth_product_registry에 등록상품ID가 이미 다
   들어와 있으므로, 그걸로 "상품 조회 단건"(query-product, docs/api-notes.md 4-7 ②)을
   돌려 **바코드**까지 포함한 SKU 목록을 통째로 만들어 넣을 수 있다 — 사용자가 손으로
   넣을 건 1688 링크·한글표시사항뿐이다(docs/decisions.md 2026-08-18).

   바코드가 왜 중요한가: 쿠팡 발급 바코드 = 로켓그로스 입고용 바코드 =
   쿠플러스 구매요청에 입력하는 값 = 구매대행 청구서 PDF에 찍혀 나오는 값이라,
   이 프로젝트에서 발주·청구서·창고·쿠팡을 잇는 유일한 조인키다.

   멱등(idempotent)하게 만든 방법: my_skus에는 쿠팡 옵션ID를 직접 안 박았다
   (채널 독립 구조 — 015 주석 참조). 대신 sku_channel_listings의
   (channel, external_option_id)로 "이미 넣은 옵션인지"를 판정한다. 이미 있는
   SKU는 건드리지 않고, 바코드가 비어 있을 때만 채워 넣는다. 그래서 몇 번을
   다시 돌려도 안전하다.

   실행:
     node rocket-growth-sync.js --skus                (주문 동기화 후 이어서)
     node rocket-growth-sync.js --skus --skip-orders  (SKU만)
     node rocket-growth-sync.js --skus --skip-orders --limit=5 --dry-run
        → 첫 실행 때 반드시 이걸로 5개만 찍어보고 응답 구조를 눈으로 확인할 것.
          첫 상품의 원본 응답이 scripts/_sample_query_product.json 으로 떨어진다.

   주의: 단건 조회라 등록상품 수만큼 호출한다. 상품이 많으면 시간이 걸리므로
   cron에 넣더라도 하루 1회 이하로. 호출 간격은 250ms.
   ============================================================ */

const SKU_CHANNEL = 'coupang_rg';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Supabase에서 전체 행을 페이지 나눠 읽는다(기본 1000행 제한 회피) */
async function sbSelectAll(accessToken, table, query) {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`Supabase 조회 실패 (${table}, HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function sbInsert(accessToken, table, rows, returning) {
  if (!rows.length) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      prefer: returning ? 'return=representation' : 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase insert 실패 (${table}, HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return returning ? res.json() : [];
}

async function sbPatch(accessToken, table, filter, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Supabase patch 실패 (${table}, HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/* 상품 조회 단건 — 페이징 목록(seller-products)엔 없는 barcode가 여기 있다 */
async function fetchProductDetail(sellerProductId) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
  const header = authHeader('GET', path, '');
  const res = await fetch(`${HOST}${path}`, {
    headers: { Authorization: header, 'Content-Type': 'application/json;charset=UTF-8' }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`쿠팡 상품 단건조회 오류 (sellerProductId=${sellerProductId}, HTTP ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text).data;
}

/* 값이 응답 어디에 박혀 있는지 확실치 않아 방어적으로 여러 자리를 훑는다.
   2026-08-18 시점에 단건조회 응답을 실제로 저장해본 적이 없다 — 첫 실행에서
   scripts/_sample_query_product.json 을 열어보고 위치가 확정되면 여기를 정리할 것. */
function pickVendorItemId(item) {
  const cands = [
    item.vendorItemId,
    item.rocketGrowthItemData && item.rocketGrowthItemData.vendorItemId,
    item.rocketGrowthItem && item.rocketGrowthItem.vendorItemId,
    item.marketPlaceItem && item.marketPlaceItem.vendorItemId
  ];
  const v = cands.find((x) => x != null);
  return v == null ? null : String(v);
}

function pickBarcode(item) {
  const cands = [
    item.barcode,
    item.skuInfo && item.skuInfo.barcode,
    item.rocketGrowthItemData && item.rocketGrowthItemData.barcode,
    item.rocketGrowthItem && item.rocketGrowthItem.barcode
  ];
  const v = cands.find((x) => x != null && String(x).trim() !== '');
  return v == null ? null : String(v).trim();
}

function pickItemName(item) {
  return item.itemName || item.vendorItemName || null;
}

async function syncSkuLedger(accessToken, opts) {
  const { limit, dryRun } = opts;

  const registry = await sbSelectAll(accessToken, 'rocket_growth_product_registry',
    'select=vendor_item_id,seller_product_id,product_id,seller_product_name');
  console.log(`레지스트리 ${registry.length}행`);

  const listings = await sbSelectAll(accessToken, 'sku_channel_listings',
    `select=sku_id,external_option_id,external_product_id&channel=eq.${SKU_CHANNEL}`);
  const skus = await sbSelectAll(accessToken, 'my_skus', 'select=id,product_id,barcode');
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const mappedOption = new Map(listings.map((l) => [String(l.external_option_id), l]));

  /* 이미 만들어둔 등록상품 -> my_products.id 매핑을 리스팅에서 역산한다
     (my_products에 쿠팡 ID를 안 박았으므로 여기서 되짚는 게 유일한 방법) */
  const productUuidBySpid = new Map();
  listings.forEach((l) => {
    if (!l.external_product_id) return;
    const s = skuById.get(l.sku_id);
    if (s && s.product_id && !productUuidBySpid.has(String(l.external_product_id))) {
      productUuidBySpid.set(String(l.external_product_id), s.product_id);
    }
  });

  /* 등록상품ID 단위로 묶고, "새 옵션이 있거나 바코드가 빈 SKU가 있는" 것만 조회 대상 */
  const bySpid = new Map();
  registry.forEach((r) => {
    if (!r.seller_product_id) return;
    const spid = String(r.seller_product_id);
    if (!bySpid.has(spid)) bySpid.set(spid, []);
    bySpid.get(spid).push(r);
  });

  const targets = [];
  for (const [spid, rows] of bySpid) {
    const needs = rows.some((r) => {
      const l = mappedOption.get(String(r.vendor_item_id));
      if (!l) return true;                       // 아직 없는 옵션
      const s = skuById.get(l.sku_id);
      return !s || !s.barcode;                   // 바코드가 아직 빈 SKU
    });
    if (needs) targets.push(spid);
  }
  console.log(`조회 대상 등록상품 ${targets.length}건 (전체 ${bySpid.size}건 중)`);

  const slice = limit ? targets.slice(0, limit) : targets;
  let sampleWritten = false;
  let created = 0, backfilled = 0, failed = 0;

  for (const spid of slice) {
    let detail;
    try {
      detail = await fetchProductDetail(spid);
    } catch (e) {
      failed++;
      console.warn(`  건너뜀 ${spid}: ${e.message}`);
      await sleep(250);
      continue;
    }

    if (!sampleWritten) {
      /* 실행 위치와 무관하게 항상 scripts/ 안에 떨어지도록 __dirname 기준으로 쓴다 */
      const samplePath = path.join(__dirname, '_sample_query_product.json');
      try {
        require('fs').writeFileSync(samplePath, JSON.stringify(detail, null, 2));
        console.log(`첫 응답을 ${samplePath} 에 저장함 (필드 위치 확인용)`);
      } catch (e) { /* 쓰기 실패해도 동기화 자체는 계속 */ }
      sampleWritten = true;
    }

    const detailByVid = new Map();
    (detail.items || []).forEach((it) => {
      const vid = pickVendorItemId(it);
      if (vid) detailByVid.set(vid, it);
    });

    const rows = bySpid.get(spid);
    const productName = (rows[0] && rows[0].seller_product_name) || detail.sellerProductName || '(이름없음)';

    /* 1) 새 옵션이 하나라도 있으면 my_products를 확보(없으면 생성) */
    const newRows = rows.filter((r) => !mappedOption.has(String(r.vendor_item_id)));
    let productUuid = productUuidBySpid.get(spid) || null;

    if (newRows.length && !productUuid) {
      if (dryRun) {
        productUuid = '(dry-run)';
      } else {
        const inserted = await sbInsert(accessToken, 'my_products', [{ name: productName }], true);
        productUuid = inserted[0].id;
        productUuidBySpid.set(spid, productUuid);
      }
    }

    /* 2) 새 SKU + 채널 매핑 생성 */
    for (const r of newRows) {
      const vid = String(r.vendor_item_id);
      const it = detailByVid.get(vid) || {};
      const barcode = pickBarcode(it);
      const optName = pickItemName(it);
      const skuName = optName ? `${productName}, ${optName}` : productName;

      if (dryRun) {
        console.log(`  [dry-run] 신규 SKU  vid=${vid}  barcode=${barcode || '(없음)'}  ${skuName}`);
        created++;
        continue;
      }
      const skuRows = await sbInsert(accessToken, 'my_skus',
        [{ product_id: productUuid, sku_name: skuName, barcode: barcode || null }], true);
      const skuId = skuRows[0].id;
      await sbInsert(accessToken, 'sku_channel_listings', [{
        sku_id: skuId,
        channel: SKU_CHANNEL,
        external_option_id: vid,
        external_product_id: spid
      }], false);
      mappedOption.set(vid, { sku_id: skuId, external_product_id: spid });
      skuById.set(skuId, { id: skuId, product_id: productUuid, barcode: barcode || null });
      created++;
    }

    /* 3) 이미 있는데 바코드만 비어 있는 SKU 백필 */
    for (const r of rows) {
      const vid = String(r.vendor_item_id);
      const l = mappedOption.get(vid);
      if (!l) continue;
      const s = skuById.get(l.sku_id);
      if (!s || s.barcode) continue;
      const barcode = pickBarcode(detailByVid.get(vid) || {});
      if (!barcode) continue;
      if (dryRun) {
        console.log(`  [dry-run] 바코드 백필  vid=${vid}  -> ${barcode}`);
      } else {
        await sbPatch(accessToken, 'my_skus', `id=eq.${s.id}`,
          { barcode, updated_at: new Date().toISOString() });
        s.barcode = barcode;
      }
      backfilled++;
    }

    await sleep(250);
  }

  console.log(`SKU 신규 ${created}건, 바코드 백필 ${backfilled}건, 실패 ${failed}건`
    + (dryRun ? ' (dry-run — 실제 저장 안 함)' : ''));
}

async function main() {
  requireEnv();
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 2;
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
  const dryRun = process.argv.includes('--dry-run');
  const skipOrders = process.argv.includes('--skip-orders');

  const accessToken = await supabaseLogin();

  if (!skipOrders) {
    const dates = recentDates(days); // 최신순
    const toDate = dates[0];
    const fromDate = dates[dates.length - 1];

    console.log(`[${new Date().toISOString()}] 조회 범위: ${fromDate} ~ ${toDate}`);
    const orders = await fetchOrders(fromDate, toDate);
    console.log(`주문 ${orders.length}건 조회됨`);

    const rows = groupByDay(orders);
    console.log(`upsert 대상: ${rows.length}행`);
    await upsertRows(accessToken, rows);
  }

  if (process.argv.includes('--products')) {
    console.log('상품 등록정보 동기화 시작...');
    const products = await fetchProductRegistry();
    console.log(`상품 ${products.length}건 조회됨`);
    const registryRows = flattenProductRegistry(products);
    console.log(`레지스트리 upsert 대상: ${registryRows.length}행`);
    await upsertProductRegistry(accessToken, registryRows);
  }

  if (process.argv.includes('--skus')) {
    console.log('상품원장(my_skus) 동기화 시작...');
    await syncSkuLedger(accessToken, { limit, dryRun });
  }

  console.log('완료');
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
