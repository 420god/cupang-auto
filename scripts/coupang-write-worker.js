#!/usr/bin/env node
/* 쿠팡 쓰기 워커 — GCP VPS(고정 IP)에서 **상시 실행**한다.
   coupang_write_queue(db/migrations/023)를 2초마다 보고, 웹이 넣어둔 요청을
   쿠팡 Open API로 실제로 쏜 뒤 결과를 같은 행에 되적는다.

   왜 이 구조인가(D-16): 쿠팡은 WING에 등록한 IP에서만 받고 Vercel은 고정 IP가 없다.
   유료 고정 IP 프록시까지 사서 WAF에 막힌 전례가 있다. 그래서 웹은 DB에 넣기만 하고
   고정 IP를 가진 이쪽이 대신 쏜다. **웹은 포트를 열 필요도 비밀키를 만질 필요도 없다.**

   왜 폴링인가: Supabase Realtime을 쓰면 @supabase/supabase-js 의존성이 새로 붙는데,
   2초 폴링은 의존성이 0이고 사람이 버튼을 누르고 기다리는 상황에서 2초는 체감되지 않는다.
   재연결 처리도 필요 없다. cron(1분)으로는 느려서 안 되므로 상시 프로세스로 돈다.

   실행:
     node scripts/coupang-write-worker.js                # 상시 실행 (systemd 권장)
     node scripts/coupang-write-worker.js --once         # 한 바퀴만 돌고 종료 (점검용)
     node scripts/coupang-write-worker.js --dry-run      # 쿠팡에 안 쏘고 무엇을 쏠지만 출력
     node scripts/coupang-write-worker.js --sync-prices  # 전체 가격 재조회 (하루 1회 크론)

   가격 동기화가 도는 경로는 셋인데 **함수는 하나다**(syncAll/syncOne):
     ① 하루 1회 크론          → --sync-prices
     ② 웹의 '가격 새로고침'    → 큐에 kind='price_sync' → 워커가 집음
     ③ 가격 변경 성공 직후     → 그 옵션 하나만 재조회 (source='our_write')
   두 벌로 갈라지면 반드시 어긋나므로 갈라놓지 않는다.
*/

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY,
  SUPABASE_URL, SUPABASE_ANON_KEY, SB_ADMIN_EMAIL, SB_ADMIN_PASSWORD
} = process.env;

const HOST = 'https://api-gateway.coupang.com';
const POLL_MS = 2000;
const MAX_ATTEMPTS = 3;      // 이 이상 실패하면 failed로 굳힌다. 무한 재시도로 쿠팡을 때리지 않는다
const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');

/* 판매중지·재개는 **아직 실물로 확인 안 됐다.** 실패하면 실제로 상품이 내려가서
   정찰 때 일부러 시험을 미뤘다. 확인 전까지 워커가 거부한다 — 큐에 들어와도 실행하지 않고
   failed로 남기며 이유를 적는다. 확인되면 이 집합에서 빼면 된다. */
const VERIFIED_KINDS = new Set(['price', 'price_sync', 'product_update', 'product_fetch',
                                'product_create', 'category_meta']);

/* 로켓그로스 상품 수정에 반드시 들어가야 하는 쓰기 전용 값(2026-08-20 실물 확인).
   **조회 응답에는 안 나온다** — 그래서 "조회한 걸 그대로 되보내면 된다"가 성립하지 않는다.
   불리언 true나 "Y"는 안 먹고 문자열 "AGREE"만 통과한다. 후보를 나란히 던져 가렸다. */
const RG_LEGAL_AGREEMENT = 'AGREE';

function requireEnv() {
  const missing = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'SUPABASE_URL',
    'SUPABASE_ANON_KEY', 'SB_ADMIN_EMAIL', 'SB_ADMIN_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('환경변수 누락:', missing.join(', '));
    process.exit(1);
  }
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ── 쿠팡 ──────────────────────────────────────────────────────────────── */
function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function authHeader(method, apiPath, query) {
  const datetime = signedDate();
  const message = datetime + method + apiPath + (query || '');
  const signature = crypto.createHmac('sha256', COUPANG_SECRET_KEY).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

async function coupang(method, apiPath, body) {
  const res = await fetch(`${HOST}${apiPath}`, {
    method,
    headers: { Authorization: authHeader(method, apiPath, ''), 'Content-Type': 'application/json;charset=UTF-8' },
    /* 서명 대상은 datetime+method+path+query다 — 몸통은 서명에 안 들어간다.
       가격 변경은 값이 경로에 있어 몸통이 없고, 상품 수정만 몸통을 쓴다. */
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* WAF가 HTML을 줄 수 있다 */ }
  return { status: res.status, text, json };
}

/* 쿠팡의 **진짜 현재 상태**를 읽는다. 웹 화면이 아는 값은 마지막 동기화 시점 기준이라,
   그 사이 WING에서 사람이 바꿨으면 다르다.
   실측(2026-08-20): /inventories 가 { amountInStock, salePrice, onSale, sellerItemId }를 준다.
   (옵션 단건 조회 vendor-items/{id} 자체는 404다 — 이 하위 경로만 살아 있다) */
async function readInventory(vendorItemId) {
  const r = await coupang('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`);
  if (r.status !== 200 || !r.json || !r.json.data) return null;
  const d = r.json.data;
  return {
    salePrice: d.salePrice == null ? null : Number(d.salePrice),
    onSale: d.onSale == null ? null : Boolean(d.onSale),
    amountInStock: d.amountInStock == null ? null : Number(d.amountInStock)
  };
}

async function readCurrentPrice(vendorItemId) {
  const inv = await readInventory(vendorItemId);
  return inv ? inv.salePrice : null;
}

/* ── Supabase ─────────────────────────────────────────────────────────── */
let token = '';

async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: SB_ADMIN_EMAIL, password: SB_ADMIN_PASSWORD })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`Supabase 로그인 실패: ${d.error_description || d.msg || res.status}`);
  token = d.access_token;
}

async function sb(method, pathAndQuery, body, prefer) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  let res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body == null ? undefined : JSON.stringify(body)
  });
  /* 토큰은 1시간이면 만료된다. 상시 프로세스라 반드시 겪는다 — 조용히 다시 로그인하고 한 번 재시도. */
  if (res.status === 401) {
    await login();
    headers.Authorization = `Bearer ${token}`;
    res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method, headers, body: body == null ? undefined : JSON.stringify(body)
    });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery} 실패 (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* 한 건을 '내 것'으로 찍는다. status=eq.queued 를 **조건에 그대로 넣는 게 핵심**이다 —
   워커가 실수로 두 개 떠도 먼저 찍은 쪽만 0이 아닌 결과를 받아서 중복 실행이 안 난다. */
async function claim(row) {
  const got = await sb('PATCH',
    `coupang_write_queue?id=eq.${row.id}&status=eq.queued`,
    { status: 'running', started_at: new Date().toISOString(), attempts: (row.attempts || 0) + 1 },
    'return=representation');
  return Array.isArray(got) && got.length ? got[0] : null;
}

async function finish(id, patch) {
  await sb('PATCH', `coupang_write_queue?id=eq.${id}`,
    { ...patch, finished_at: new Date().toISOString() });
}

/* ── 가격 동기화 ───────────────────────────────────────────────────────────
   쿠팡에 물어본 값을 registry(최신값)에 적고, **바뀌었을 때만** 이력에 1행 넣는다
   (db/migrations/024). 매번 이력을 쌓으면 대부분이 같은 값의 반복이라
   "언제 바뀌었나"를 다시 계산해야 한다. 바뀐 것만 넣으면 이 표 자체가 변경 목록이 된다.

   source는 이 변경이 어디서 왔는지다. our_write는 우리가 바꾼 것이고,
   sync는 **어느새 달라져 있는 걸 발견한 것** = WING에서 사람이 바꿨거나 쿠팡이 조정한 것.
   나중에 둘을 구분해서 보는 게 이 표의 핵심 가치다. */
async function syncOne(vendorItemId, source, writeQueueId) {
  const inv = await readInventory(vendorItemId);
  if (!inv) return { ok: false, changed: false };

  const prevRows = await sb('GET',
    `rocket_growth_product_registry?vendor_item_id=eq.${encodeURIComponent(vendorItemId)}`
    + `&select=sale_price,on_sale`);
  const prev = prevRows && prevRows.length ? prevRows[0] : null;

  await sb('PATCH', `rocket_growth_product_registry?vendor_item_id=eq.${encodeURIComponent(vendorItemId)}`, {
    sale_price: inv.salePrice,
    on_sale: inv.onSale,
    amount_in_stock: inv.amountInStock,
    price_checked_at: new Date().toISOString()
  });

  /* '변경'과 '처음 알게 된 것'을 구분한다. 둘을 섞으면 이 표의 존재 이유가 깨진다 —
     바뀐 것만 담기로 했기 때문에 **이 표를 읽는 것 자체가 곧 변경 목록**이어야 한다.

     막아야 하는 경우가 둘이다:
       ① prev가 아예 없다  — 레지스트리에 그 옵션이 없다(신규이거나 동기화 전)
       ② prev는 있는데 값이 null — 024 직후 첫 동기화가 정확히 이 상태다
     ②를 안 막아서 첫 실행에 57행이 전부 "null→12900원"으로 들어갔다(2026-08-20 실제로 겪음).
     주석엔 "처음 알게 된 것은 넣지 않는다"고 써놓고 ①만 막았던 것 — 코드가 주석을 안 지켰다. */
  if (!prev) return { ok: true, changed: false };
  const firstSeen = prev.sale_price == null && prev.on_sale == null;
  if (firstSeen) {
    log(`처음 확인 ${vendorItemId} ${inv.salePrice}원 (이력에는 남기지 않음)`);
    return { ok: true, changed: false };
  }

  /* null끼리 비교하지 않도록 한쪽이라도 null이면 '다름'으로 보되, 위에서 firstSeen을
     걸러냈으므로 여기 오는 null은 "한쪽 값만 뒤늦게 채워진" 진짜 변화다. */
  const priceChanged = Number(prev.sale_price) !== Number(inv.salePrice);
  const saleChanged = prev.on_sale !== inv.onSale;
  if (!priceChanged && !saleChanged) return { ok: true, changed: false };

  await sb('POST', 'rocket_growth_item_price_history', [{
    vendor_item_id: vendorItemId,
    sale_price: inv.salePrice,
    prev_sale_price: prev.sale_price,
    on_sale: inv.onSale,
    prev_on_sale: prev.on_sale,
    source: source || 'sync',
    write_queue_id: writeQueueId || null
  }]);
  log(`변동 ${vendorItemId} ${prev.sale_price}→${inv.salePrice}원`
    + (saleChanged ? ` 판매 ${prev.on_sale}→${inv.onSale}` : '') + ` (${source || 'sync'})`);
  return { ok: true, changed: true };
}

/* 전체 동기화. 하루 1회 크론과 웹의 '가격 새로고침' 버튼이 둘 다 여기로 온다. */
async function syncAll() {
  const rows = await sb('GET', 'rocket_growth_product_registry?select=vendor_item_id&order=vendor_item_id.asc');
  log(`가격 동기화 시작 — 옵션 ${rows.length}개`);
  let ok = 0, changed = 0, failed = 0;
  for (const r of rows) {
    try {
      const res = await syncOne(r.vendor_item_id, 'sync', null);
      if (res.ok) { ok++; if (res.changed) changed++; } else failed++;
    } catch (e) {
      failed++; log(`동기화 실패 ${r.vendor_item_id}: ${e.message}`);
    }
    await new Promise((s) => setTimeout(s, 200));   // 쿠팡에 몰아치지 않는다
  }
  log(`가격 동기화 끝 — 성공 ${ok} · 변동 ${changed} · 실패 ${failed}`);
  return { ok, changed, failed, total: rows.length };
}

/* ── 상품 정보 수정 ────────────────────────────────────────────────────────
   **쿠팡 상품 수정은 부분 수정이 안 된다.** 전체 몸통을 PUT해야 하고, 빠뜨린 필드는
   지워진다(2026-08-20 정찰). 그래서 절차가 이렇게 된다:

     ① 쏘기 직전에 쿠팡에서 최신 상품을 조회한다
     ② 거기에 웹이 요청한 변경분만 얹는다
     ③ legalAgreement를 넣는다 (조회에 안 나오는 쓰기 전용 값)
     ④ 통째로 PUT하고, **보낸 몸통을 그대로 저장한다**

   ①이 핵심이다. 우리 DB의 사본을 보내면 그 사이 WING에서 바뀐 게 통째로 덮인다.
   가격에서 price_before를 워커가 직접 읽는 것과 같은 이유이고, 전체 PUT이라
   여기서는 결과가 훨씬 파괴적이다. */
async function fetchProduct(sellerProductId) {
  const r = await coupang('GET',
    `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`);
  if (r.status !== 200 || !r.json || !r.json.data) return null;
  return r.json.data;
}

/* 옵션 하나에 변경분을 얹는다. **payload에 있는 키만 건드린다** — 없는 키는
   조회해온 원본 값을 그대로 둔다. 여기서 실수하면 멀쩡한 필드가 지워진다. */
function applyItemPatch(item, patch) {
  if (!patch) return;
  if (patch.itemName !== undefined) item.itemName = patch.itemName;
  if (patch.searchTags !== undefined) item.searchTags = patch.searchTags;
  if (patch.images !== undefined) item.images = patch.images;
  if (patch.contents !== undefined) item.contents = patch.contents;
}

/* 이 옵션이 payload의 어느 키에 해당하나. 쿠팡은 같은 개념을 엔드포인트마다 다르게
   쓰므로 세 철자를 다 본다(docs/api/coupang-open-api.md "대소문자가 다르다"). */
function itemVendorIds(item) {
  return [
    item.rocketGrowthItemData && item.rocketGrowthItemData.vendorItemId,
    item.marketplaceItemData && item.marketplaceItemData.vendorItemId,
    item.marketPlaceItemData && item.marketPlaceItemData.vendorItemId,
    item.vendorItemId
  ].filter((x) => x != null).map(String);
}

/* ── 변경 이력 (db/migrations/026) ─────────────────────────────────────────
   **"이렇게 바꿨더니 어떻게 됐나"를 나중에 답하려면 before가 남아야 한다.**
   상품 정보는 바꾸면 product_json을 덮어써서 이전 값이 사라진다 — 오늘 썸네일이
   뭐였는지는 내일이면 알 방법이 없다. 그래서 쏘기 직전에 조회한 값을 여기 남긴다.

   바꾼 것에 따라 **봐야 할 지표가 다르다**(2026-08-20 실측으로 확인). 지표가 깔때기
   단계별로 있어서, 썸네일을 바꿨는데 전환율만 보면 아무 결론도 못 낸다.
   행마다 박아두면 AI가 매번 추측하지 않는다. */
const PRIMARY_METRICS = {
  thumbnail:    ['views', 'visitors'],           // 클릭을 좌우 → 유입이 움직여야 맞다
  search_tags:  ['views', 'visitors'],           // 검색 노출 → 유입
  product_name: ['views', 'visitors'],
  item_name:    ['views', 'visitors'],
  detail_page:  ['conversion_rate', 'cart_adds'], // 들어온 사람을 설득 → 조회는 안 변해야 정상
  price:        ['conversion_rate', 'item_winner_rate'],
  sale_status:  ['views']
};

/* ── 바꾸기 전 사진을 우리 쪽에 보관한다 ───────────────────────────────────
   before_value에 경로 문자열만 남기면 **그림 자체는 쿠팡에만 있다.** 쿠팡이 지우면
   "이전 썸네일이 뭐였나"를 영영 못 본다. 나중에 AI가 이전/이후 이미지를 눈으로
   비교하려면 파일이 있어야 한다.

   CDN 주소는 실물로 확인했다(2026-08-20):
     https://image1.coupangcdn.com/image/{cdnPath}  → 200 image/png
   **/image/ 접두사가 필요하다.** 없으면 403이다. 호스트는 image1·thumbnail1·static 등
   여러 개가 같은 파일을 준다. */
const COUPANG_IMAGE_BASE = 'https://image1.coupangcdn.com/image/';

async function archiveCoupangImage(cdnPath, vendorItemId, tag) {
  if (!cdnPath) return null;
  const url = /^https?:\/\//.test(cdnPath) ? cdnPath : COUPANG_IMAGE_BASE + cdnPath;
  /* 이미 우리 Storage에 있는 것(우리가 올린 이미지)은 다시 받지 않는다 —
     그건 이미 영구 보관 중이고, 옮겨 담으면 사본만 늘어난다. */
  if (url.startsWith(SUPABASE_URL)) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`쿠팡 이미지 내려받기 실패 ${res.status} ${url.slice(0, 90)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (cdnPath.split('.').pop() || 'jpg').split(/[?#]/)[0].toLowerCase();
  const p = `archive/${vendorItemId}/${Date.now()}-${tag}.${ext}`;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/product-images/${p}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'content-type': res.headers.get('content-type') || 'application/octet-stream'
    },
    body: buf
  });
  if (!up.ok) throw new Error(`보관 실패 ${up.status}: ${(await up.text()).slice(0, 150)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/product-images/${p}`;
}

/* 경로 하나를 { 쿠팡 경로, 우리가 보관한 사본 } 으로 만든다.
   **보관에 실패해도 경로는 남긴다** — 사본이 없는 것과 기록이 아예 없는 건 다르다. */
async function archived(cdnPath, vendorItemId, tag) {
  if (!cdnPath) return null;
  try {
    return { coupang_path: cdnPath, archived_url: await archiveCoupangImage(cdnPath, vendorItemId, tag) };
  } catch (e) {
    log(`이미지 보관 실패(계속): ${e.message}`);
    return { coupang_path: cdnPath, archived_url: null, archive_error: e.message.slice(0, 200) };
  }
}

/* entries: [{ field, before, after, hypothesis }] — 한 요청에서 두 가지를 바꿨으면 두 행이 된다.
   섞인 변경은 원인을 못 가리므로, 나중에 "이건 분석에서 빼자"를 판단하려면 쪼개져 있어야 한다. */
async function recordChanges(row, entries) {
  const rows = entries
    .filter((e) => e && e.field)
    .map((e) => ({
      vendor_item_id: row.vendor_item_id,
      seller_product_id: row.seller_product_id || null,
      sku_id: row.sku_id || null,
      field: e.field,
      before_value: e.before === undefined ? null : e.before,
      after_value: e.after === undefined ? null : e.after,
      source: 'our_write',
      primary_metrics: PRIMARY_METRICS[e.field] || null,
      hypothesis: e.hypothesis || row.hypothesis || row.reason || null,
      changed_by: row.requested_by || null,
      queue_id: row.id
    }));
  if (!rows.length) return;
  /* 이력 기록이 실패해도 변경 자체는 이미 됐다. 큐 상태를 뒤집지 않되 **반드시 남긴다** —
     조용히 넘기면 나중에 "왜 이력이 비었지"를 못 찾는다. */
  try { await sb('POST', 'product_change_history', rows); }
  catch (e) { log(`이력 기록 실패(변경 자체는 성공): ${e.message}`); }
}

/* 상품 원문을 가져와 레지스트리에 넣는다. **아무것도 바꾸지 않는다.**
   화면이 검색어·이미지·상세페이지의 '지금 값'을 보고 편집할 수 있게 하려는 것이다 —
   전체 몸통 PUT 방식에서 깜깜이 편집은 그대로 사고로 이어진다.
   레지스트리는 옵션 단위라, 같은 상품에 속한 모든 행에 같은 원문을 넣는다. */
async function storeProductJson(sellerProductId, product) {
  await sb('PATCH',
    `rocket_growth_product_registry?seller_product_id=eq.${encodeURIComponent(sellerProductId)}`,
    { product_json: product, product_fetched_at: new Date().toISOString() });
}

async function handleProductFetch(row) {
  const product = await fetchProduct(row.seller_product_id);
  if (!product) {
    await finish(row.id, { status: 'failed',
      response_body: `상품 조회 실패 (sellerProductId=${row.seller_product_id})` });
    return;
  }
  await storeProductJson(row.seller_product_id, product);
  log(`상품 원문 저장 ${row.seller_product_id} (옵션 ${(product.items || []).length}개)`);
  await finish(row.id, { status: 'done', http_status: 200,
    response_body: `옵션 ${(product.items || []).length}개 · 최상위 키 ${Object.keys(product).length}개` });
}

async function handleProductUpdate(row) {
  const payload = row.payload || {};
  const product = await fetchProduct(row.seller_product_id);
  if (!product) {
    await finish(row.id, { status: 'failed',
      response_body: `상품 조회 실패 (sellerProductId=${row.seller_product_id}) — 수정하지 않았다` });
    return;
  }

  /* **바꾸기 전 값을 먼저 붙잡는다.** PUT을 쏘고 나면 되돌아가서 알 방법이 없다.
     여기서 놓치면 그 변경은 영원히 "before 없음"으로 남는다. */
  const before = {};
  const targetItem = (product.items || []).find((it) => itemVendorIds(it).includes(String(row.vendor_item_id)));
  if (targetItem) {
    const rep = (targetItem.images || []).find((im) => im.imageType === 'REPRESENTATION');
    before.thumbnail = rep ? (rep.cdnPath || rep.vendorPath || null) : null;
    before.detail_page = (targetItem.contents || []).flatMap((c) =>
      (c.contentDetails || []).map((d) => d.content).filter(Boolean));
    before.search_tags = targetItem.searchTags || null;
    before.item_name = targetItem.itemName || null;
  }
  before.product_name = product.sellerProductName || null;

  /* **사진은 PUT 전에 받아둬야 한다.** 쏘고 나면 쿠팡이 옛 이미지를 언제 지울지 모른다.
     바꾸려는 항목의 것만 받는다 — 안 바꾸는 상세페이지 10장을 매번 받으면 느리고 낭비다. */
  const wantedPatch = (payload.items || {})[String(row.vendor_item_id)] || {};
  if (wantedPatch.images !== undefined && before.thumbnail) {
    before.thumbnail = await archived(before.thumbnail, row.vendor_item_id, 'thumb');
  }
  if (wantedPatch.contents !== undefined && (before.detail_page || []).length) {
    const arr = [];
    for (let i = 0; i < before.detail_page.length; i++) {
      arr.push(await archived(before.detail_page[i], row.vendor_item_id, `detail${i + 1}`));
    }
    before.detail_page = arr;
  }

  /* 상품 단위 필드 */
  if (payload.product) {
    Object.keys(payload.product).forEach((k) => { product[k] = payload.product[k]; });
  }

  /* 옵션 단위 필드. 이미지·상세페이지·검색어가 전부 여기다(items[] 안). */
  let touched = 0;
  const wanted = payload.items || {};
  (product.items || []).forEach((item) => {
    const key = itemVendorIds(item).find((v) => wanted[v]);
    if (!key) return;
    applyItemPatch(item, wanted[key]);
    touched++;
  });
  const askedCount = Object.keys(wanted).length;
  if (askedCount && !touched) {
    /* 바꾸려던 옵션을 상품 안에서 못 찾았다. 이대로 PUT하면 **아무것도 안 바뀐 채
       전체를 덮어쓴다** — 조용히 성공으로 보이는 최악의 경우다. 여기서 멈춘다. */
    await finish(row.id, { status: 'failed',
      response_body: `요청한 옵션 ${askedCount}개를 상품 안에서 찾지 못했다 — 덮어쓰기를 막으려고 중단했다` });
    return;
  }

  /* 승인 요청 여부는 요청마다 사람이 정한다(2026-08-20 사용자 결정).
     지정이 없으면 조회해온 값을 그대로 둔다 — 우리가 임의로 심사를 걸지 않는다. */
  if (payload.requested !== undefined) product.requested = payload.requested;

  /* 쓰기 전용 필드. 없으면 "입고 불가 조건에 동의해주세요"로 막힌다. */
  product.rocketGrowthAdditionalInformation =
    Object.assign({}, product.rocketGrowthAdditionalInformation || {},
      { legalAgreement: RG_LEGAL_AGREEMENT });

  const apiPath = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  if (DRY) {
    log(`[dry-run] PUT ${apiPath} sellerProductId=${row.seller_product_id} (옵션 ${touched}개 수정)`);
    await finish(row.id, { status: 'queued', started_at: null, sent_body: product });
    return;
  }

  const r = await coupang('PUT', apiPath, product);
  const ok = r.status === 200 && (!r.json || r.json.code === 'SUCCESS');
  log(`${ok ? '성공' : '실패'} 상품수정 ${row.seller_product_id} 옵션${touched}개 HTTP ${r.status} ${r.text.slice(0, 160)}`);

  await finish(row.id, {
    status: ok ? 'done' : 'failed',
    http_status: r.status,
    response_body: r.text.slice(0, 2000),
    /* 보낸 몸통을 통째로 남긴다(R-04). 전체 PUT이라 **무엇을 덮어썼는지가 사고 조사의
       전부**다 — 나중에 "이 필드가 왜 비었지"를 추적할 유일한 단서가 된다. */
    sent_body: product
  });

  /* 성공했으면 원문을 다시 읽어 화면을 진실에 맞춘다. **쿠팡이 SUCCESS라고 답한 것과
     실제로 그렇게 저장된 것은 다른 사실이다** — 특히 심사가 걸리면 값이 바로 반영되지
     않을 수 있다. 가격 변경 뒤 재조회를 넣은 것과 같은 이유다.
     여기서 실패해도 수정 자체는 성공이므로 큐 상태를 뒤집지 않는다. */
  if (ok) {
    /* 무엇이 무엇으로 바뀌었는지를 항목 단위로 남긴다(db/migrations/026).
       payload에 있는 것만 담는다 — 안 바꾼 항목까지 이력에 넣으면 나중에
       "이때 썸네일도 바꿨네" 하고 잘못 읽는다. */
    const p = (payload.items || {})[String(row.vendor_item_id)] || {};
    const hypos = payload.hypotheses || {};
    const entries = [];
    if (p.images !== undefined) {
      const rep = (p.images || []).find((im) => im.imageType === 'REPRESENTATION');
      entries.push({ field: 'thumbnail', before: before.thumbnail, hypothesis: hypos.thumbnail,
                     after: rep ? (rep.vendorPath || rep.cdnPath || null) : null });
    }
    if (p.contents !== undefined) {
      entries.push({ field: 'detail_page', before: before.detail_page, hypothesis: hypos.detail_page,
                     after: (p.contents || []).flatMap((c) =>
                       (c.contentDetails || []).map((d) => d.content).filter(Boolean)) });
    }
    if (p.searchTags !== undefined) {
      entries.push({ field: 'search_tags', before: before.search_tags, after: p.searchTags, hypothesis: hypos.search_tags });
    }
    if (p.itemName !== undefined) {
      entries.push({ field: 'item_name', before: before.item_name, after: p.itemName, hypothesis: hypos.item_name });
    }
    if (payload.product && payload.product.sellerProductName !== undefined) {
      entries.push({ field: 'product_name', before: before.product_name, hypothesis: hypos.product_name,
                     after: payload.product.sellerProductName });
    }
    await recordChanges(row, entries);

    await new Promise((s) => setTimeout(s, 1500));
    try {
      const fresh = await fetchProduct(row.seller_product_id);
      if (fresh) await storeProductJson(row.seller_product_id, fresh);
    } catch (e) { log(`수정 후 재조회 실패(수정 자체는 성공): ${e.message}`); }
  }
}


/* ── 복제할 때 지워야 하는 것들 ─────────────────────────────────────────────
   **정찰이 이걸 알려줬다.** 조회한 몸통을 그대로 보냈더니
   "중복된 바코드가 존재합니다"가 나왔다 — 식별자가 원본 것 그대로 붙어 있어서다.
   새 상품은 쿠팡이 새 식별자를 발급하므로 우리가 보내면 안 된다.

   지우는 것과 남기는 것을 나누는 기준: **쿠팡이 발급하는 것은 지우고,
   우리가 정하는 것은 남긴다.** 배송·반품지·과세유형·고시정보·필수속성은
   우리가 정한 값이라 그대로 따라가야 한다 — 그게 복제의 이유다. */
const CLONE_STRIP_TOP = [
  'sellerProductId',      // 쿠팡이 발급하는 상품ID
  'productId',            // 소비자 페이지 상품ID
  'statusName',           // 승인 상태. 새 상품은 쿠팡이 정한다
  'createdAt', 'modifiedAt'
];
const CLONE_STRIP_ITEM = [
  'sellerProductItemId', 'vendorItemId', 'itemId', 'barcode',
  'inventoryId', 'externalVendorSkuCode'
];

/* 옵션 안의 rocketGrowthItemData / marketplaceItemData 안에도 식별자가 들어 있다.
   **철자가 엔드포인트마다 다르므로 세 가지를 다 훑는다**
   (docs/api/coupang-open-api.md "대소문자가 다르다"). */
function stripItemIdentifiers(item) {
  CLONE_STRIP_ITEM.forEach((k) => { delete item[k]; });
  ['rocketGrowthItemData', 'marketplaceItemData', 'marketPlaceItemData'].forEach((k) => {
    if (!item[k]) return;
    CLONE_STRIP_ITEM.forEach((f) => { delete item[k][f]; });
  });
  /* 이미지의 cdnPath 는 **쿠팡이 저장한 결과값**이지 우리가 주는 값이 아니다.
     새 상품에 원본의 cdnPath 를 주면 어떻게 되는지 확인된 바 없다 — 그래서
     복제할 때 이미지는 아래 resolveCloneImages()가 공개 URL로 바꿔 넣는다. */
  return item;
}

/* 복제 원본의 이미지를 **우리 Storage 공개 URL로 바꾼다.**
   쿠팡은 vendorPath 에 http 로 시작하는 URL을 주면 내려받는다(문서·실측).
   원본의 cdnPath 를 그대로 주는 건 미검증이라 하지 않는다 — 이미 검증된
   경로(CDN에서 받아 Storage에 올린 뒤 그 URL)를 재사용한다. */
async function resolveCloneImages(item, tagPrefix) {
  const out = [];
  for (let i = 0; i < (item.images || []).length; i++) {
    const im = item.images[i];
    const src = im.cdnPath || im.vendorPath;
    if (!src) continue;
    const a = await archived(src, tagPrefix, `img${i + 1}`);
    if (!a || !a.archived_url) {
      throw new Error(`복제할 이미지를 옮기지 못했습니다: ${src}`);
    }
    out.push({ imageOrder: im.imageOrder, imageType: im.imageType, vendorPath: a.archived_url });
  }
  item.images = out;

  for (const c of (item.contents || [])) {
    for (let j = 0; j < (c.contentDetails || []).length; j++) {
      const d = c.contentDetails[j];
      if (d.detailType !== 'IMAGE' || !d.content) continue;
      const a = await archived(d.content, tagPrefix, `detail${j + 1}`);
      if (!a || !a.archived_url) {
        throw new Error(`복제할 상세페이지 이미지를 옮기지 못했습니다: ${d.content}`);
      }
      d.content = a.archived_url;
    }
  }
  return item;
}

/* ── 신규 등록 ─────────────────────────────────────────────────────────────
   payload:
     { source_seller_product_id, product: {최상위 덮어쓸 값},
       items: [{ itemName, salePrice, originalPrice, searchTags, images, contents }],
       requested, sourcing_decision_id }

   **되돌릴 수 없는 작업이다.** 등록되면 지우기 어렵다. 그래서
   ① 필수값을 워커가 다시 확인하고 ② 보낸 몸통을 통째로 남긴다. */
async function handleProductCreate(row) {
  const payload = row.payload || {};
  const srcId = payload.source_seller_product_id;
  if (!srcId) {
    await finish(row.id, { status: 'failed',
      response_body: '복제 원본(source_seller_product_id)이 없습니다. 빈 양식 등록은 아직 지원하지 않습니다.' });
    return;
  }

  const src = await fetchProduct(srcId);
  if (!src) {
    await finish(row.id, { status: 'failed', response_body: `복제 원본 조회 실패: ${srcId}` });
    return;
  }

  /* 깊은 복사. 원본 객체를 그대로 고치면 재시도할 때 이미 지워진 상태로 시작한다. */
  const product = JSON.parse(JSON.stringify(src));
  CLONE_STRIP_TOP.forEach((k) => { delete product[k]; });

  const wanted = payload.items || [];
  if (!wanted.length) {
    await finish(row.id, { status: 'failed', response_body: '등록할 옵션이 없습니다.' });
    return;
  }

  /* 옵션은 **payload가 준 개수만큼** 만든다. 원본 옵션 하나를 틀로 삼아 복제한다 —
     원본 옵션을 그대로 다 가져오면 안 팔 색상까지 같이 등록된다. */
  const template = (product.items || [])[0];
  if (!template) {
    await finish(row.id, { status: 'failed', response_body: '복제 원본에 옵션이 없습니다.' });
    return;
  }

  const items = [];
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i];
    const it = stripItemIdentifiers(JSON.parse(JSON.stringify(template)));
    if (w.itemName !== undefined) it.itemName = w.itemName;
    if (w.searchTags !== undefined) it.searchTags = w.searchTags;
    if (w.images !== undefined) it.images = w.images;         // 새로 올린 이미지
    if (w.contents !== undefined) it.contents = w.contents;
    /* 가격은 옵션 안에 **두 벌**이다 — 로켓그로스와 마켓플레이스(판매자배송).
       이 계정은 둘을 일부러 다르게 운영한다(실측 원본: 7,500 / 13,000).
       그래서 같은 값을 양쪽에 넣으면 안 된다 — 채널별로 받은 값을 각각 넣는다.
       값을 안 준 쪽은 건드리지 않는다(복제 원본 값이 그대로 남는다). */
    const setPrice = (k, sale, orig) => {
      if (!it[k] || !it[k].priceData) return;
      if (sale !== undefined && sale !== null) it[k].priceData.salePrice = Number(sale);
      if (orig !== undefined && orig !== null) it[k].priceData.originalPrice = Number(orig);
    };
    setPrice('rocketGrowthItemData', w.salePrice, w.originalPrice);
    setPrice('marketplaceItemData', w.marketplaceSalePrice, w.marketplaceOriginalPrice);
    setPrice('marketPlaceItemData', w.marketplaceSalePrice, w.marketplaceOriginalPrice);
    /* 이미지를 새로 안 올렸으면 원본 것을 우리 Storage로 옮겨서 URL로 준다. */
    if (w.images === undefined || w.contents === undefined) {
      await resolveCloneImages(it, `new-${row.id}-${i + 1}`);
    }
    items.push(it);
  }
  product.items = items;

  if (payload.product) {
    Object.keys(payload.product).forEach((k) => { product[k] = payload.product[k]; });
  }
  product.requested = payload.requested === true;

  /* 로켓그로스 전용 정보. legalAgreement 는 쓰기 전용 필수값이다.
     **rfmInboundName 은 입고 시 표기되는 이름이라 반드시 새 상품명으로 바꾼다** —
     복제하면 원본 상품명이 그대로 따라와서, 창고에 다른 상품 이름표가 붙는다.
     (2026-08-20 사용자 지적으로 발견) */
  const rgInfo = Object.assign({}, product.rocketGrowthAdditionalInformation || {},
    { legalAgreement: RG_LEGAL_AGREEMENT });
  const newName = (payload.product && payload.product.sellerProductName) || null;
  if (newName) rgInfo.rfmInboundName = newName;
  product.rocketGrowthAdditionalInformation = rgInfo;

  const apiPath = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';
  if (DRY) {
    log(`[dry-run] POST ${apiPath} (복제 원본 ${srcId}, 옵션 ${items.length}개, 입고명 ${rgInfo.rfmInboundName})`);
    await finish(row.id, { status: 'queued', started_at: null, sent_body: product });
    return;
  }

  const r = await coupang('POST', apiPath, product);
  const ok = r.status === 200 && r.json && r.json.code === 'SUCCESS';
  /* 새 sellerProductId 는 data 에 온다. 형태를 단정하지 않고 숫자만 뽑는다 —
     문자열일 수도 객체일 수도 있어서 확인 전엔 가정하지 않는다(R-12). */
  let newId = null;
  if (ok && r.json) {
    const d = r.json.data;
    if (typeof d === 'number' || typeof d === 'string') newId = String(d);
    else if (d && d.sellerProductId != null) newId = String(d.sellerProductId);
  }
  log(`${ok ? '성공' : '실패'} 상품등록 (복제 ${srcId}) HTTP ${r.status} newId=${newId} ${r.text.slice(0, 200)}`);

  await finish(row.id, {
    status: ok ? 'done' : 'failed',
    http_status: r.status,
    response_body: r.text.slice(0, 2000),
    created_seller_product_id: newId,
    sent_body: product
  });

  /* 판단과 결과를 잇는다. 등록이 실패해도 판단은 남아 있고(웹이 먼저 넣는다),
     성공했을 때만 "이 판단으로 만든 상품이 저것"이 확정된다. */
  if (ok && newId && payload.sourcing_decision_id) {
    try {
      await sb('PATCH', `sourcing_decisions?id=eq.${payload.sourcing_decision_id}`,
        { seller_product_id: newId });
    } catch (e) { log(`소싱 판단 연결 실패(등록 자체는 성공): ${e.message}`); }
  }

  /* 등록된 상품을 바로 읽어 레지스트리에 넣는다 — 화면이 곧바로 볼 수 있게. */
  if (ok && newId) {
    await new Promise((s) => setTimeout(s, 1500));
    try {
      const fresh = await fetchProduct(newId);
      if (fresh) await storeProductJson(newId, fresh);
    } catch (e) { log(`등록 후 재조회 실패(등록 자체는 성공): ${e.message}`); }
  }
}

/* ── 카테고리 메타 (빈 양식 등록용) ────────────────────────────────────────
   웹은 쿠팡을 직접 못 부르므로 워커가 가져와 저장한다. 읽기 전용이라 안전하다. */
async function handleCategoryMeta(row) {
  const code = row.display_category_code;
  const r = await coupang('GET',
    `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`);
  if (r.status !== 200 || !r.json || !r.json.data) {
    await finish(row.id, { status: 'failed', http_status: r.status,
      response_body: r.text.slice(0, 1000) });
    return;
  }
  let path = null;
  try {
    const p = await coupang('GET',
      `/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories/${code}`);
    if (p.status === 200 && p.json && p.json.data) {
      path = p.json.data.categoryPath || p.json.data.name || null;
    }
  } catch (e) { /* 경로는 없어도 된다 */ }

  await sb('POST', 'coupang_category_meta?on_conflict=display_category_code',
    [{ display_category_code: String(code), category_path: path,
       raw: r.json.data, fetched_at: new Date().toISOString() }],
    'resolution=merge-duplicates,return=minimal');
  await finish(row.id, { status: 'done', http_status: 200,
    response_body: `카테고리 ${code} 메타 저장` });
}

/* ── 한 건 처리 ────────────────────────────────────────────────────────── */
async function handle(row) {
  if (!VERIFIED_KINDS.has(row.kind)) {
    /* 미검증 종류는 실행하지 않는다. 조용히 큐에 쌓아두면 나중에 누가 워커를 고쳤을 때
       한꺼번에 쏟아져 나간다 — 그게 더 위험하므로 여기서 명확히 실패로 닫는다. */
    log(`거부 ${row.id} kind=${row.kind} — 아직 실물로 확인되지 않은 동작이다`);
    await finish(row.id, {
      status: 'failed',
      response_body: `워커가 거부함: kind='${row.kind}'는 아직 실물 호출로 확인되지 않았다. `
        + `확인 후 coupang-write-worker.js 의 VERIFIED_KINDS에 추가할 것.`
    });
    return;
  }

  /* 가격 재조회 — 쿠팡에 쓰는 게 아니라 읽어서 우리 DB를 맞추는 일이다.
     대상이 없으면 전체(웹의 '가격 새로고침' 버튼), 있으면 그 하나만. */
  if (row.kind === 'price_sync') {
    if (row.vendor_item_id) {
      const res = await syncOne(row.vendor_item_id, 'sync', null);
      await finish(row.id, { status: res.ok ? 'done' : 'failed', http_status: res.ok ? 200 : null,
        response_body: res.ok ? (res.changed ? '값이 바뀌어 이력에 기록함' : '변동 없음') : '쿠팡 조회 실패' });
    } else {
      const s = await syncAll();
      await finish(row.id, { status: s.failed && !s.ok ? 'failed' : 'done', http_status: 200,
        response_body: `옵션 ${s.total}개 — 성공 ${s.ok} · 변동 ${s.changed} · 실패 ${s.failed}` });
    }
    return;
  }

  if (row.kind === 'product_fetch')  { await handleProductFetch(row);  return; }
  if (row.kind === 'category_meta') { await handleCategoryMeta(row); return; }
  /* 등록은 **되돌릴 수 없다.** 실패해도 재시도하지 않는다 —
     쿠팡이 SUCCESS를 늦게 주거나 우리가 응답을 놓친 경우 두 번 등록될 수 있다. */
  if (row.kind === 'product_create') { await handleProductCreate(row); return; }
  if (row.kind === 'product_update') { await handleProductUpdate(row); return; }

  const before = await readCurrentPrice(row.vendor_item_id);
  const after = Number(row.price_after);

  if (!Number.isFinite(after) || after <= 0) {
    await finish(row.id, { status: 'failed', price_before: before,
      response_body: `price_after 가 유효하지 않다: ${row.price_after}` });
    return;
  }

  /* 이미 그 값이면 쏘지 않는다. 쿠팡을 괜히 부르지 않고, 이력에는 "바꿀 게 없었다"로 남는다. */
  if (before != null && before === after) {
    log(`건너뜀 ${row.vendor_item_id} 이미 ${after}원`);
    await finish(row.id, { status: 'done', price_before: before, http_status: 200,
      response_body: '이미 같은 가격이라 호출하지 않음' });
    return;
  }

  const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${row.vendor_item_id}/prices/${after}`;

  if (DRY) {
    log(`[dry-run] PUT ${apiPath}   (현재 ${before}원 → ${after}원)`);
    await finish(row.id, { status: 'queued', price_before: before, started_at: null });
    return;
  }

  const r = await coupang('PUT', apiPath);
  /* 쿠팡은 HTTP 200이면서 code로 실패를 알리는 경우가 있다. 둘 다 봐야 한다. */
  const ok = r.status === 200 && (!r.json || r.json.code === 'SUCCESS');

  log(`${ok ? '성공' : '실패'} ${row.vendor_item_id} ${before}→${after} HTTP ${r.status} ${r.text.slice(0, 120)}`);

  if (!ok && (row.attempts || 1) < MAX_ATTEMPTS) {
    /* 다시 큐로 돌려놓는다 — 일시적인 네트워크·쿠팡 장애일 수 있다.
       attempts는 claim에서 이미 올렸으므로 상한에 걸리면 아래로 떨어진다. */
    await sb('PATCH', `coupang_write_queue?id=eq.${row.id}`,
      { status: 'queued', price_before: before, http_status: r.status, response_body: r.text.slice(0, 2000) });
    return;
  }

  await finish(row.id, {
    status: ok ? 'done' : 'failed',
    price_before: before,
    http_status: r.status,
    response_body: r.text.slice(0, 2000)
  });

  /* 성공했으면 곧바로 다시 읽어서 우리 DB를 맞춘다(2026-08-20 사용자 결정: 변경 후 자동).
     **쿠팡이 SUCCESS라고 답한 것과 실제로 그 값이 된 것은 다른 사실이다** —
     읽어서 확인해야 화면이 진실을 보여준다. 1초 두는 건 반영 지연 대비.
     여기서 실패해도 가격 변경 자체는 성공이므로 큐 상태를 뒤집지 않는다 —
     하루 1회 동기화가 어차피 다시 맞춘다. */
  if (ok) {
    /* 가격도 같은 이력 표에 넣는다(db/migrations/026). 분석 관점에서 가격 변경과
       썸네일 변경은 **같은 종류의 사건**이다 — 따로 두면 "가격도 내리고 썸네일도
       바꾼 날"을 못 보고, AI가 표 두 개를 각각 이해해야 한다.
       rocket_growth_item_price_history(024)는 그대로 둔다. 그쪽은 우리가 안 바꾼
       변동(WING에서 사람이 바꾼 것)까지 잡는 역할이라 목적이 다르다. */
    await recordChanges(row, [{ field: 'price', before, after }]);

    await new Promise((s) => setTimeout(s, 1000));
    try { await syncOne(row.vendor_item_id, 'our_write', row.id); }
    catch (e) { log(`변경 후 재조회 실패(가격 변경 자체는 성공): ${e.message}`); }
  }
}

/* ── 한 바퀴 ───────────────────────────────────────────────────────────── */
async function tick() {
  const rows = await sb('GET',
    'coupang_write_queue?status=eq.queued&order=requested_at.asc&limit=20&select=*');
  if (!rows.length) return 0;
  for (const row of rows) {
    const mine = await claim(row);
    if (!mine) continue;                       // 다른 워커가 먼저 집었다
    try {
      await handle(mine);
    } catch (e) {
      log('처리 중 오류', mine.id, e.message);
      await finish(mine.id, { status: 'failed', response_body: `워커 오류: ${e.message}` }).catch(() => {});
    }
    await new Promise((s) => setTimeout(s, 300));   // 연속 호출 간격
  }
  return rows.length;
}

async function main() {
  requireEnv();
  await login();
  log(`쿠팡 쓰기 워커 시작 (폴링 ${POLL_MS}ms${DRY ? ', dry-run' : ''}${ONCE ? ', 한 바퀴만' : ''})`);

  /* 하루 1회 크론이 부르는 모드. 큐를 거치지 않고 바로 전체를 훑는다 —
     크론은 이미 VPS에서 도는 것이라 큐라는 우회로가 필요 없다.
     로직은 웹 버튼과 같은 syncAll()을 쓴다(두 벌로 갈라지면 반드시 어긋난다). */
  if (process.argv.includes('--sync-prices')) { await syncAll(); return; }

  if (ONCE) { const n = await tick(); log(`처리 대상 ${n}건`); return; }

  /* 한 번의 오류로 프로세스가 죽으면 이후 요청이 전부 멈춘다. 잡고 계속 돈다 —
     대신 조용히 넘기지 않고 반드시 남긴다(R-13의 '조용한 실패' 교훈). */
  for (;;) {
    try { await tick(); }
    catch (e) { log('tick 실패(계속 진행):', e.message); }
    await new Promise((s) => setTimeout(s, POLL_MS));
  }
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
