#!/usr/bin/env node
/* 쿠팡 "상품 등록·수정" 정찰 — GCP VPS(고정 IP)에서 실행한다.
   2단계(상세페이지·대표이미지·상품명·검색어 수정 + 신규 상품 등록)를 붙이기 전에
   **실물로 스펙을 확인한다**(R-12).
   가격 때도 이렇게 해서 rg_open_api가 아니라 marketplace 계열이라는 걸 알았다.

   ── 이 스크립트가 안전한 이유 ─────────────────────────────────────────
   상품 수정이 '부분 수정'인지 '전체를 되보내야 하는지'는 PUT을 쏴봐야 안다.
   그런데 **실제 상품에 쏘면 심사 대기로 들어가 판매가 멈출 수 있다.**
   그래서 여기서는 **대상 상품을 아예 지정하지 않는다.**
   빈 몸통·불완전한 몸통을 보내 쿠팡의 검증 단계에서 튕기게 하고,
   그 에러 메시지에서 "무엇이 필수인지"를 읽어낸다.
   → 어떤 상품도 수정되지 않는다. 등록도 되지 않는다.

   실행:
     node scripts/coupang-product-probe.js
     node scripts/coupang-product-probe.js --category=63955   # 특정 카테고리 메타만
*/

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
const HOST = 'https://api-gateway.coupang.com';
const BASE = '/v2/providers/seller_api/apis/api/v1/marketplace';

function requireEnv() {
  const missing = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) { console.error('환경변수 누락:', missing.join(', ')); process.exit(1); }
}

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

async function call(method, apiPath, query, body) {
  const url = `${HOST}${apiPath}` + (query ? `?${query}` : '');
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: authHeader(method, apiPath, query || ''),
                 'Content-Type': 'application/json;charset=UTF-8' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    text = await res.text();
  } catch (e) {
    return { status: 0, text: `네트워크 오류: ${e.message}`, json: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML(WAF) 등 */ }
  return { status: res.status, text, json };
}

function dump(name, obj) {
  const p = path.join(__dirname, `_probe_${name}.json`);
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); console.log(`  → ${p} 에 저장`); }
  catch (e) { console.log(`  → 저장 실패(계속): ${e.message}`); }
}

/* 응답 전체를 훑어 우리가 찾는 키를 스스로 찾아낸다. 필드명을 안다고 가정하지 않는다
   — 이 프로젝트는 기억으로 필드명을 적었다가 1년간 0행을 넣은 적이 있다(R-12/R-14). */
const PATTERNS = [
  ['필수여부', /required|mandatory|필수/i],
  ['이미지',   /image|img|photo|picture|cdn|thumbnail|upload/i],
  ['고시정보', /notice|attribute|certif|고시|인증/i],
  ['상세설명', /content|detail|description|html|editor|상세/i],
  ['이름·검색어', /name|title|tag|keyword|search/i]
];

function walk(node, cb, trail) {
  trail = trail || '';
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.slice(0, 3).forEach((v, i) => walk(v, cb, `${trail}[${i}]`));
    return;
  }
  if (typeof node === 'object') {
    Object.keys(node).forEach((k) => walk(node[k], cb, trail ? `${trail}.${k}` : k));
    return;
  }
  cb(trail, node);
}

function report(label, data) {
  console.log(`\n──────── ${label} — 찾아낸 필드 ────────`);
  const buckets = new Map(PATTERNS.map(([n]) => [n, []]));
  walk(data, (trail, value) => {
    if (value === '' || value === null) return;
    const leaf = trail.split('.').pop().replace(/\[\d+\]$/, '');
    const hit = PATTERNS.find(([, re]) => re.test(leaf));
    if (hit) buckets.get(hit[0]).push([trail, value]);
  });
  let found = false;
  buckets.forEach((rows, n) => {
    if (!rows.length) return;
    found = true;
    console.log(`\n  [${n}]`);
    const seen = new Set();
    rows.forEach(([t, v]) => {
      const key = t.replace(/\[\d+\]/g, '[]');
      if (seen.has(key)) return;
      seen.add(key);
      const s = String(v);
      console.log(`    ${key} = ${s.length <= 80 ? s : s.slice(0, 80) + ` … (총 ${s.length}자)`}`);
    });
  });
  if (!found) console.log('  (패턴에 걸리는 필드 없음)');
}

/* ── 1. 상품 하나에서 카테고리 코드를 얻는다 (읽기만) ───────────────────── */
async function pickCategory(given) {
  if (given) return { code: given, from: '인자' };
  console.log('\n[1] 기존 상품에서 카테고리 코드를 가져온다');
  const q = `vendorId=${COUPANG_VENDOR_ID}&businessTypes=rocketGrowth&maxPerPage=1`;
  const r = await call('GET', `${BASE}/seller-products`, q);
  if (r.status !== 200 || !r.json || !(r.json.data || []).length) {
    console.log(`  상품 목록 실패 (HTTP ${r.status}) — 카테고리 메타는 건너뛴다`);
    return null;
  }
  const id = r.json.data[0].sellerProductId;
  const d = await call('GET', `${BASE}/seller-products/${id}`, '');
  if (d.status !== 200 || !d.json || !d.json.data) { console.log('  단건 조회 실패'); return null; }
  const code = d.json.data.displayCategoryCode;
  console.log(`  sellerProductId=${id} · displayCategoryCode=${code}`);
  return { code, from: '기존 상품' };
}

/* ── 2. 카테고리 메타 (읽기만) ────────────────────────────────────────────
   등록·수정에 무엇이 필수인지가 여기 들어 있을 것으로 본다. 경로는 추정이라
   후보를 나란히 던지고 HTTP 코드로 가른다. 404=없음 / 200=있음 */
async function probeCategoryMeta(code) {
  console.log(`\n[2] 카테고리 메타 후보 (displayCategoryCode=${code})`);
  const candidates = [
    ['카테고리 부가정보', `${BASE}/meta/category-related-metas/display-category-codes/${code}`],
    ['카테고리 단건',     `${BASE}/meta/display-categories/${code}`],
    ['고시정보 목록',     `${BASE}/meta/notice-categories`]
  ];
  let best = null;
  for (const [label, p] of candidates) {
    const r = await call('GET', p, '');
    console.log(`  ${String(r.status).padEnd(4)} ${label}\n       ${p}`);
    if (r.status === 200 && r.json && r.json.data && !best) best = { label, data: r.json.data };
    await new Promise((s) => setTimeout(s, 300));
  }
  if (best) { dump('category_meta', best.data); report(`카테고리 메타 (${best.label})`, best.data); }
  else console.log('  200이 없다 — 필수 항목은 아래 [4] 검증 오류로 역산해야 한다.');
}

/* ── 3. 이미지 업로드 경로가 따로 있나 (읽기만) ───────────────────────────
   상품 응답의 vendorPath는 URL이 아니라 파일명이었다(2026-08-20 확인).
   그래서 "우리가 공개 URL을 주면 쿠팡이 가져간다"는 추정이 확인되지 않았다.
   업로드 전용 엔드포인트가 있는지 먼저 본다.
   **405(Method Not Allowed)가 뜨면 그 경로는 존재한다는 뜻**이라 404와 구분해야 한다. */
async function probeImageEndpoints() {
  console.log('\n[3] 이미지 업로드 전용 경로가 있나 (GET으로 존재 여부만 확인)');
  const candidates = [
    `${BASE}/media/images`,
    `${BASE}/images`,
    `${BASE}/seller-products/images`,
    '/v2/providers/marketplace_openapi/apis/api/v1/image/upload'
  ];
  for (const p of candidates) {
    const r = await call('GET', p, '');
    const verdict = r.status === 404 ? '없음'
      : r.status === 405 ? '**경로는 있음** (GET이 아닌 다른 메서드)'
      : r.status === 200 ? '있음'
      : '있을 수 있음(인자·권한 문제)';
    console.log(`  ${String(r.status).padEnd(4)} ${verdict}\n       ${p}`);
    await new Promise((s) => setTimeout(s, 300));
  }
}

/* ── 4. 등록·수정 스펙을 '검증 오류'로 역산한다 ───────────────────────────
   **여기가 이 스크립트의 핵심이다.**
   대상 상품을 지정하지 않고 빈 몸통을 보낸다. 쿠팡이 검증 단계에서 튕기면서
   무엇이 필수인지 알려준다 — 그러면 실제 상품을 건드리지 않고 스펙을 얻는다.

   POST(등록)와 PUT(수정)의 응답을 나란히 보는 게 중요하다.
   PUT이 "sellerProductId가 필요하다"만 말하고 끝나면 부분 수정일 가능성이 있고,
   POST와 똑같이 긴 필수 목록을 뱉으면 **전체를 되보내야 한다는 뜻**이다.
   이걸 알아야 2단계 설계가 갈린다(이미지 하나 바꾸려고 상품 전체를 다시 쓰는가?). */
async function probeWriteSpec() {
  console.log('\n[4] 등록·수정 필수 항목을 검증 오류로 역산 (대상 상품 없음 — 아무것도 안 바뀐다)');
  const cases = [
    ['등록(POST) · 빈 몸통', 'POST', {}],
    ['수정(PUT) · 빈 몸통',  'PUT',  {}],
    ['수정(PUT) · 상품명만', 'PUT',  { sellerProductName: '정찰용-실제요청아님' }]
  ];
  for (const [label, method, body] of cases) {
    const r = await call(method, `${BASE}/seller-products`, '', body);
    console.log(`\n  ── ${label} → HTTP ${r.status}`);
    /* 본문을 넉넉히 보여준다. 필수 필드 목록이 길게 오는 게 우리가 원하는 결과다. */
    console.log('  ' + r.text.slice(0, 1500).replace(/\n/g, '\n  '));
    await new Promise((s) => setTimeout(s, 500));
  }
  console.log('\n  ※ 위 셋 다 실패해야 정상이다. 하나라도 성공(SUCCESS)했다면 즉시 알려줄 것 —');
  console.log('    빈 몸통이 통과한다는 뜻이라 설계를 다시 봐야 한다.');
}

function arg(n) {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : null;
}

async function main() {
  requireEnv();
  console.log('쿠팡 상품 등록·수정 정찰 — **어떤 상품도 등록·수정되지 않는다.**');
  console.log('대상을 지정하지 않고 검증 오류만 유도해서 스펙을 읽는다.');

  const cat = await pickCategory(arg('category'));
  if (cat) await probeCategoryMeta(cat.code);
  await probeImageEndpoints();
  await probeWriteSpec();

  console.log('\n끝. 출력 전체와 scripts/_probe_category_meta.json 을 그대로 보내주면 설계를 확정한다.');
}

main().catch((e) => { console.error('실패:', e); process.exit(1); });
