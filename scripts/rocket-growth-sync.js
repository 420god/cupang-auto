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
*/

const crypto = require('crypto');
require('dotenv').config();

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

async function main() {
  requireEnv();
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 2;
  const dates = recentDates(days); // 최신순
  const toDate = dates[0];
  const fromDate = dates[dates.length - 1];

  console.log(`[${new Date().toISOString()}] 조회 범위: ${fromDate} ~ ${toDate}`);
  const orders = await fetchOrders(fromDate, toDate);
  console.log(`주문 ${orders.length}건 조회됨`);

  const rows = groupByDay(orders);
  console.log(`upsert 대상: ${rows.length}행`);

  const accessToken = await supabaseLogin();
  await upsertRows(accessToken, rows);
  console.log('완료');
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
