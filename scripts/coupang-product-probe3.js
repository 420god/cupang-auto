#!/usr/bin/env node
/* 쿠팡 상품 수정 정찰 3차 — legalAgreement 확인.
   2차에서 전체 몸통을 보냈더니 이 에러에서 멈췄다:
     "로켓그로스 입고 불가 조건을 확인하시고 동의해주세요."
   공식 문서(developers.coupang.com, 상품 생성 로켓그로스)가 답을 줬다 —
   필수 최상위 필드에 rocketGrowthAdditionalInformation(rfmInboundName, legalAgreement)가 있다.
   **조회 응답에는 rfmInboundName만 있고 legalAgreement는 없다 = 쓰기 전용 필드다.**

   문서는 가설이지 확정이 아니다(R-12 — 이 프로젝트는 문서에 적힌 필드명을 믿고
   1년간 0행을 넣은 적이 있다). 그래서 실물로 확인한다.
   **값의 형태를 모르므로 후보를 나란히 던지고 에러 메시지가 어떻게 바뀌는지 본다.**

   ── 안전 ──────────────────────────────────────────────────────────────
   2차와 같다. PUT만 쓰고 대상 sellerProductId는 존재하지 않는 값(1)이다.
   검증을 다 통과해도 마지막엔 "상품 없음"으로 끝난다. 등록(POST)은 쓰지 않는다.

   실행:
     node scripts/coupang-product-probe3.js
*/

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
const HOST = 'https://api-gateway.coupang.com';
const BASE = '/v2/providers/seller_api/apis/api/v1/marketplace';
const FAKE_PRODUCT_ID = 1;

function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function call(method, apiPath, query, body) {
  const url = `${HOST}${apiPath}` + (query ? `?${query}` : '');
  const dt = signedDate();
  const sig = crypto.createHmac('sha256', COUPANG_SECRET_KEY)
    .update(dt + method + apiPath + (query || '')).digest('hex');
  const auth = `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${dt}, signature=${sig}`;
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json;charset=UTF-8' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    text = await res.text();
  } catch (e) { return { status: 0, text: `네트워크 오류: ${e.message}` }; }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML 등 */ }
  return { status: res.status, text, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (r) => (r.json && (r.json.message || r.json.code)) || r.text.slice(0, 250);

async function main() {
  const miss = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']
    .filter((k) => !process.env[k]);
  if (miss.length) { console.error('환경변수 누락:', miss.join(', ')); process.exit(1); }

  console.log('쿠팡 상품 수정 정찰 3차 — legalAgreement 값 형태 확인');
  console.log('**PUT만 쓰고 대상은 존재하지 않는 상품이다. 상품이 수정·등록되지 않는다.**');

  console.log('\n[0] 형식 참고용 실제 상품 읽기');
  const q = `vendorId=${COUPANG_VENDOR_ID}&businessTypes=rocketGrowth&maxPerPage=1`;
  const list = await call('GET', `${BASE}/seller-products`, q);
  if (list.status !== 200 || !(((list.json || {}).data) || []).length) {
    console.error(`  목록 실패 (HTTP ${list.status})`); process.exit(1);
  }
  const id = list.json.data[0].sellerProductId;
  const det = await call('GET', `${BASE}/seller-products/${id}`, '');
  if (det.status !== 200 || !det.json || !det.json.data) { console.error('  단건 실패'); process.exit(1); }
  const sample = det.json.data;
  const rg = sample.rocketGrowthAdditionalInformation || {};
  console.log(`  sellerProductId=${id}`);
  console.log(`  조회 응답의 rocketGrowthAdditionalInformation = ${JSON.stringify(rg)}`);
  console.log('  ↑ legalAgreement가 없으면 "쓰기 전용 필드"라는 문서 설명과 일치한다');

  /* 값의 형태를 모른다. 문서엔 이름만 나와 있고 타입이 없다.
     불리언·문자열 후보를 나란히 던져 **에러 메시지가 바뀌는지**로 판별한다:
       · 여전히 "동의해주세요"  → 그 값은 안 먹힌다
       · 다른 메시지로 넘어감    → 그 값이 받아들여졌고 검증이 다음 단계로 갔다 = 정답 */
  const candidates = [
    ['불리언 true', true],
    ['문자열 "AGREE"', 'AGREE'],
    ['문자열 "Y"', 'Y'],
    ['문자열 "true"', 'true']
  ];

  console.log('\n[1] legalAgreement 값 후보 시험 (대상 = 존재하지 않는 상품)');
  console.log('    기준선: 2차에서 이 몸통은 "입고 불가 조건에 동의해주세요"에서 멈췄다.\n');

  for (const [label, value] of candidates) {
    const body = Object.assign({}, sample, {
      sellerProductId: FAKE_PRODUCT_ID,
      rocketGrowthAdditionalInformation: Object.assign({}, rg, { legalAgreement: value })
    });
    const r = await call('PUT', `${BASE}/seller-products`, '', body);
    const msg = msgOf(r);
    const stillSame = /동의/.test(msg);
    console.log(`  ── legalAgreement = ${label} → HTTP ${r.status}`);
    console.log(`     ${msg}`);
    console.log(`     판정: ${stillSame ? '아직 동의 단계 (이 값은 아니다)' : '**검증이 넘어갔다 — 이 값이 받아들여졌다**'}`);

    if (r.json && r.json.code === 'SUCCESS') {
      console.log('\n  *** 성공 응답. 즉시 중단한다 — 존재하지 않는 상품이라 예상 밖이다.');
      console.log('  *** WING에서 상품이 새로 생기지 않았는지 확인할 것.');
      return;
    }
    console.log('');
    await sleep(600);
  }

  console.log('  넷 다 "동의" 메시지가 그대로면, 값 문제가 아니라 **계정 동의가 아직 안 된 것**이다:');
  console.log('    WING > 판매자정보 > 추가정보 > "OPEN API key 발급" 영역 >');
  console.log('    "로켓그로스 상품 생성 API 이용 및 심사 기준 동의"');
  console.log('  그걸 누른 뒤 이 스크립트를 다시 돌리면 갈린다.');

  console.log('\n끝. 출력 전체를 보내주면 2단계 설계를 확정한다.');
}

main().catch((e) => { console.error('실패:', e); process.exit(1); });
