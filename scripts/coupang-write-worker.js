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
const VERIFIED_KINDS = new Set(['price', 'price_sync']);

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

async function coupang(method, apiPath) {
  const res = await fetch(`${HOST}${apiPath}`, {
    method,
    headers: { Authorization: authHeader(method, apiPath, ''), 'Content-Type': 'application/json;charset=UTF-8' }
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
