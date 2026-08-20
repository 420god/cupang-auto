#!/usr/bin/env node
/* 쿠팡 상품 수정 정찰 2차 — 1차에서 못 푼 것만 좁혀서 확인한다.
   1차 결과(2026-08-20):
     · 빈 몸통 POST/PUT 모두 "업체코드는 반드시 입력되어야 합니다"에서 멈췄다
       → 쿠팡은 **필드를 순차로 검증**하고, 그 검증이 '상품 존재 확인'보다 먼저 온다
     · 카테고리 메타는 확보 (필수 속성 3개 + 고시정보 4종)
     · 이미지 업로드 경로는 /seller-products/images 만 400 — 진짜 경로인지 불명

   ── 이 스크립트가 안전한 이유 ─────────────────────────────────────────
   **대상 sellerProductId를 존재하지 않는 값(1)로 고정한다.**
   1차에서 필드 검증이 먼저 온다는 걸 확인했으므로, 몸통을 채워가며 검증을 통과시켜도
   마지막엔 "그런 상품 없음/권한 없음"으로 끝난다. 즉:
     · 실제 상품은 절대 수정되지 않는다 (대상이 존재하지 않으니까)
     · 신규 등록도 되지 않는다 (POST가 아니라 PUT만 쓴다)
   PUT만 쓰는 게 핵심이다. POST(등록)로 사다리를 타면 필수 항목을 다 채우는 순간
   **진짜로 상품이 등록돼 버린다.**

   실행:
     node scripts/coupang-product-probe2.js
*/

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
const HOST = 'https://api-gateway.coupang.com';
const BASE = '/v2/providers/seller_api/apis/api/v1/marketplace';

/* 존재하지 않는 상품ID. 실제 ID는 16318361249 처럼 11자리라 1은 확실히 우리 것이 아니다.
   설령 남의 상품이더라도 vendorId가 우리 것이라 권한에서 막힌다. */
const FAKE_PRODUCT_ID = 1;

function requireEnv() {
  const miss = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']
    .filter((k) => !process.env[k]);
  if (miss.length) { console.error('환경변수 누락:', miss.join(', ')); process.exit(1); }
}

function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function authHeader(method, apiPath, query) {
  const dt = signedDate();
  const sig = crypto.createHmac('sha256', COUPANG_SECRET_KEY)
    .update(dt + method + apiPath + (query || '')).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${dt}, signature=${sig}`;
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
  } catch (e) { return { status: 0, text: `네트워크 오류: ${e.message}` }; }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML 등 */ }
  return { status: res.status, text, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (r) => (r.json && (r.json.message || r.json.code)) || r.text.slice(0, 200);

/* ── A. 이미지 경로가 진짜인지 가른다 ─────────────────────────────────────
   1차에서 /seller-products/images 가 400이었다. 두 해석이 가능하다:
     ① 진짜 엔드포인트인데 인자가 틀림
     ② images 를 sellerProductId로 해석했는데 숫자가 아니라서 400
   **아무 의미 없는 문자열도 똑같이 400이면 ②다.** 그걸로 가른다. */
async function probeImagePath() {
  console.log('\n[A] /seller-products/images 가 진짜 엔드포인트인가');
  const cases = [
    ['images (1차에서 400이 났던 것)', `${BASE}/seller-products/images`],
    ['zzznotanendpoint (대조군)',      `${BASE}/seller-products/zzznotanendpoint`],
    ['0 (숫자지만 없는 상품)',          `${BASE}/seller-products/0`]
  ];
  const out = [];
  for (const [label, p] of cases) {
    const r = await call('GET', p, '');
    out.push([label, r.status, msgOf(r)]);
    console.log(`  ${String(r.status).padEnd(4)} ${label}`);
    console.log(`       ${msgOf(r)}`);
    await sleep(300);
  }
  const [a, b] = out;
  console.log('\n  판정: ' + (a[1] === b[1] && a[2] === b[2]
    ? '**대조군과 응답이 같다 → images는 엔드포인트가 아니다.** 경로 파라미터로 먹힌 것.'
    : '대조군과 다르다 → images가 특별하게 취급된다. 진짜 경로일 수 있다.'));
}

/* ── B. 상품 수정이 부분인가 전체인가 ─────────────────────────────────────
   **이게 2단계 설계를 가르는 질문이다.**
   몸통을 조금씩 키워가며 PUT을 던지고, 에러 메시지가 어떻게 바뀌는지 본다.
   대상은 존재하지 않는 상품이라 무엇도 바뀌지 않는다.

   읽는 법:
     · 계속 "OO는 필수입니다"가 이어지면 → **전체를 되보내야 한다**
       (이미지 하나 바꾸려고 상품 전체를 다시 써야 한다는 뜻)
     · 어느 순간 "상품을 찾을 수 없다/권한 없음"으로 바뀌면 → 거기까지가 필수다
       (그 앞까지만 채우면 되므로 부분 수정에 가깝다) */
async function probeUpdateShape(sample) {
  console.log('\n[B] 상품 수정 필수 항목 사다리 (대상 = 존재하지 않는 상품)');

  /* 단계별로 몸통을 키운다. 값은 실제 상품(sample)에서 가져와 형식이 틀려서 나는
     오류를 배제한다 — 우리가 알고 싶은 건 '무엇이 빠졌나'지 '형식이 틀렸나'가 아니다. */
  const steps = [
    ['① 업체코드만', {
      vendorId: COUPANG_VENDOR_ID
    }],
    ['② + 상품ID', {
      vendorId: COUPANG_VENDOR_ID,
      sellerProductId: FAKE_PRODUCT_ID
    }],
    ['③ + 상품명·카테고리', {
      vendorId: COUPANG_VENDOR_ID,
      sellerProductId: FAKE_PRODUCT_ID,
      sellerProductName: sample.sellerProductName,
      displayCategoryCode: sample.displayCategoryCode
    }],
    ['④ + 판매기간·업체사용자', {
      vendorId: COUPANG_VENDOR_ID,
      sellerProductId: FAKE_PRODUCT_ID,
      sellerProductName: sample.sellerProductName,
      displayCategoryCode: sample.displayCategoryCode,
      saleStartedAt: sample.saleStartedAt,
      saleEndedAt: sample.saleEndedAt,
      vendorUserId: sample.vendorUserId,
      displayProductName: sample.displayProductName,
      generalProductName: sample.generalProductName,
      productGroup: sample.productGroup,
      brand: sample.brand
    }],
    ['⑤ 실제 상품 전체 (ID만 가짜)', Object.assign({}, sample, {
      sellerProductId: FAKE_PRODUCT_ID
    })]
  ];

  for (const [label, body] of steps) {
    const r = await call('PUT', `${BASE}/seller-products`, '', body);
    console.log(`\n  ── ${label} (키 ${Object.keys(body).length}개) → HTTP ${r.status}`);
    console.log(`     ${msgOf(r)}`);
    /* 혹시라도 성공하면 즉시 멈춘다. 존재하지 않는 상품이라 성공할 리 없지만,
       "없으면 새로 만든다" 같은 동작이 있다면 여기서 상품이 생겨버린다. */
    if (r.json && r.json.code === 'SUCCESS') {
      console.log('\n  *** 성공 응답이 왔다. 즉시 중단한다 — 예상과 다르다.');
      console.log('  *** WING에서 상품이 새로 생기지 않았는지 확인할 것.');
      return;
    }
    await sleep(500);
  }

  console.log('\n  읽는 법:');
  console.log('   · 끝까지 "OO 필수"가 이어졌다 → 전체를 되보내야 한다(무거운 방식)');
  console.log('   · 중간에 "상품 없음/권한 없음"으로 바뀌었다 → 그 직전 단계까지가 필수다');
}

async function main() {
  requireEnv();
  console.log('쿠팡 상품 수정 정찰 2차 — PUT만 쓰고 대상은 존재하지 않는 상품이다.');
  console.log('**상품이 수정되거나 등록되지 않는다.**');

  console.log('\n[0] 형식 참고용으로 실제 상품 하나를 읽는다 (읽기만)');
  const q = `vendorId=${COUPANG_VENDOR_ID}&businessTypes=rocketGrowth&maxPerPage=1`;
  const list = await call('GET', `${BASE}/seller-products`, q);
  if (list.status !== 200 || !list.json || !(list.json.data || []).length) {
    console.error(`  상품 목록 실패 (HTTP ${list.status})`); process.exit(1);
  }
  const id = list.json.data[0].sellerProductId;
  const det = await call('GET', `${BASE}/seller-products/${id}`, '');
  if (det.status !== 200 || !det.json || !det.json.data) {
    console.error('  단건 조회 실패'); process.exit(1);
  }
  const sample = det.json.data;
  console.log(`  sellerProductId=${id} · 최상위 키 ${Object.keys(sample).length}개`);
  fs.writeFileSync(path.join(__dirname, '_probe_sample_product.json'),
    JSON.stringify(sample, null, 2));
  console.log(`  → scripts/_probe_sample_product.json 에 저장 (수정 요청 형식 참고용)`);

  await probeImagePath();
  await probeUpdateShape(sample);

  console.log('\n끝. 출력 전체를 그대로 보내주면 2단계 설계를 확정한다.');
}

main().catch((e) => { console.error('실패:', e); process.exit(1); });
