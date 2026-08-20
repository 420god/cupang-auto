#!/usr/bin/env node
/* 쿠팡 "쓰기" 정찰 스크립트 — GCP VPS(고정 IP)에서 실행한다.
   상품원장에서 가격·판매상태·상세페이지·대표이미지를 고치는 기능을 붙이기 전에,
   **실물 응답을 먼저 본다**(R-12). 이 시스템은 API 필드명을 기억으로 적었다가
   1년 가까이 조용히 0행을 넣은 적이 있다 → docs/api/coupang-open-api.md

   그래서 이 스크립트는 **필드명을 안다고 가정하지 않는다.**
   응답 전체를 재귀로 훑어서 가격·이미지·상세설명·판매상태처럼 보이는 키를
   스스로 찾아 "어느 경로에 무슨 값이 있는지"를 출력한다. 이름을 맞히는 게 아니라
   응답에게 물어보는 방식이다(R-14: 구조를 가정하지 말고 검산에 기댄다).

   실행:
     node scripts/coupang-write-probe.js                        # 읽기만. 안전.
     node scripts/coupang-write-probe.js --seller-product-id=123456
     node scripts/coupang-write-probe.js --write-test --vendor-item-id=123456

   --write-test 는 값을 바꾸지 않는다. 조회한 현재가를 그대로 다시 써서
   "이 엔드포인트가 우리 계정에서 실제로 통하는가"만 확인한다. 그래도 쓰기는 쓰기라
   플래그 없이는 절대 안 돈다. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
const HOST = 'https://api-gateway.coupang.com';

function requireEnv() {
  const missing = ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_VENDOR_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('환경변수 누락:', missing.join(', '));
    console.error('scripts/.env 를 확인할 것 (scripts/.env.example 참고)');
    process.exit(1);
  }
}

/* 서명은 rocket-growth-sync.js 와 동일한 규칙이다. 여기서 복사해 쓰는 이유:
   정찰 스크립트는 정찰이 끝나면 통째로 지울 것이라 기존 동기화 스크립트를 건드리지 않는다.
   서명 규칙이 바뀌면 두 곳을 같이 고쳐야 한다는 점만 기억할 것. */
function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function authHeader(method, apiPath, query) {
  const datetime = signedDate();
  const message = datetime + method + apiPath + query;
  const signature = crypto.createHmac('sha256', COUPANG_SECRET_KEY).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}

/* 응답을 절대 버리지 않는다(R-04). 실패해도 본문을 그대로 돌려준다 —
   쿠팡은 실패 사유를 본문에 담아 주고, 정찰에서는 그게 가장 값진 정보다.
   특히 WAF에 막히면 JSON이 아니라 HTML이 온다. 그것도 그대로 보여줘야 한다. */
async function call(method, apiPath, query, body) {
  const header = authHeader(method, apiPath, query || '');
  const url = `${HOST}${apiPath}` + (query ? `?${query}` : '');
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: header, 'Content-Type': 'application/json;charset=UTF-8' },
      body: body == null ? undefined : JSON.stringify(body)
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, text: `네트워크 오류: ${e.message}`, json: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML 등 — text로만 본다 */ }
  return { ok: res.ok, status: res.status, text, json };
}

/* ── 응답에서 "우리가 찾는 것"을 스스로 찾아낸다 ──────────────────────────────
   키 이름을 정면으로 맞히는 대신 패턴으로 긁는다. 쿠팡은 같은 개념을 엔드포인트마다
   다르게 쓴다(marketPlaceItemData vs marketplaceItemData) — 그래서 대소문자를 무시한다. */
/* **순서가 의미를 가진다** — 아래에서 첫 매칭 하나에만 넣는다.
   패턴이 겹치기 때문이다: salePrice는 price(가격)와 sale(판매상태)에 둘 다 걸리고,
   noticeCategoryDetailName은 detail(상세설명)과 notice(고시정보)에 둘 다 걸린다.
   양쪽에 다 넣으면 같은 필드가 두 번 나와 목록이 지저분해진다.
   그래서 **더 좁고 확실한 것을 위에** 둔다: 가격 → 이미지 → 고시정보 → 상세설명 → 판매상태.
   판매상태를 맨 뒤로 보낸 건 sale/state 패턴이 가장 헐거워서다. */
const PATTERNS = [
  ['가격',     /price|amount|가격/i],
  ['이미지',   /image|img|photo|picture|cdn|thumbnail/i],
  ['고시정보', /notice|attribute|certif|고시|인증/i],
  ['상세설명', /content|detail|description|html|editor|상세/i],
  ['판매상태', /status|state|sale|selling|stop|resume|판매/i],
  ['식별자',   /vendorItemId|sellerProductId|sellerProductItemId|productId|itemId|barcode/i]
];

function walk(node, cb, trail) {
  trail = trail || '';
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    /* 배열은 앞 2개만 본다 — 옵션이 수십 개면 출력이 쓸모없어진다.
       구조만 알면 되고, 전체는 어차피 파일에 덤프된다. */
    node.slice(0, 2).forEach((v, i) => walk(v, cb, `${trail}[${i}]`));
    return;
  }
  if (typeof node === 'object') {
    Object.keys(node).forEach((k) => walk(node[k], cb, trail ? `${trail}.${k}` : k));
    return;
  }
  cb(trail, node);
}

function preview(v) {
  const s = String(v);
  return s.length <= 90 ? s : s.slice(0, 90) + ` … (총 ${s.length}자)`;
}

function report(label, data) {
  console.log(`\n──────── ${label} — 찾아낸 필드 ────────`);
  const buckets = new Map(PATTERNS.map(([name]) => [name, []]));
  walk(data, (trail, value) => {
    if (value === '' || value === null) return;   // 빈 값은 "없음"으로 본다(바코드 사례)
    /* 마지막 키 조각만 본다 — 경로 전체로 매칭하면 상위 키 하나 때문에
       그 아래 필드가 전부 딸려 들어와 목록이 무의미해진다. */
    const leaf = trail.split('.').pop().replace(/\[\d+\]$/, '');
    const hit = PATTERNS.find(([, re]) => re.test(leaf));   // 첫 매칭 하나만 (위 주석 참고)
    if (hit) buckets.get(hit[0]).push([trail, value]);
  });
  let found = false;
  buckets.forEach((rows, name) => {
    if (!rows.length) return;
    found = true;
    console.log(`\n  [${name}]`);
    /* 같은 구조가 옵션마다 반복되므로 경로에서 인덱스를 지운 뒤 중복을 접는다 */
    const seen = new Set();
    rows.forEach(([t, v]) => {
      const key = t.replace(/\[\d+\]/g, '[]');
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`    ${key}`);
      console.log(`        = ${preview(v)}`);
    });
  });
  if (!found) console.log('  (해당 패턴에 걸리는 필드가 없음 — 응답 자체가 비었을 수 있다)');
}

function dump(name, obj) {
  const p = path.join(__dirname, `_probe_${name}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    console.log(`  → 전체 응답을 ${p} 에 저장`);
  } catch (e) {
    console.log(`  → 덤프 저장 실패(무시하고 계속): ${e.message}`);
  }
}

/* ── 1단계: 상품 하나를 고른다 ─────────────────────────────────────────────── */
async function pickProduct(givenId) {
  if (givenId) return { sellerProductId: givenId };
  console.log('\n[1] 로켓그로스 상품 목록에서 첫 상품을 고른다');
  const query = `vendorId=${COUPANG_VENDOR_ID}&businessTypes=rocketGrowth&maxPerPage=10`;
  const r = await call('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', query);
  if (!r.ok) {
    console.error(`  목록 조회 실패 (HTTP ${r.status}): ${r.text.slice(0, 400)}`);
    /* 여기서 막히면 뒤는 볼 필요가 없다. IP 화이트리스트 문제일 가능성이 가장 크다. */
    console.error('  ↑ 403이면 이 서버 IP가 WING에 등록돼 있는지부터 확인할 것.');
    process.exit(1);
  }
  const list = (r.json && r.json.data) || [];
  if (!list.length) { console.error('  로켓그로스 상품이 0건이다.'); process.exit(1); }
  const p = list[0];
  console.log(`  ${list.length}건 중 첫 상품: ${p.sellerProductName || '(이름없음)'} (sellerProductId=${p.sellerProductId})`);
  return { sellerProductId: p.sellerProductId };
}

/* ── 2단계: 상품 단건 조회 — 상세설명·이미지가 여기 있을 것으로 본다 ───────── */
async function probeProductDetail(sellerProductId) {
  console.log(`\n[2] 상품 단건 조회 (sellerProductId=${sellerProductId})`);
  const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
  const r = await call('GET', apiPath, '');
  console.log(`  HTTP ${r.status}`);
  if (!r.ok) { console.log(`  본문: ${r.text.slice(0, 500)}`); return null; }
  /* 200인데 JSON이 아닌 경우가 실제로 있다 — WAF가 쿠팡 로고 박힌 HTML을 돌려준 전례
     (docs/archive/2026-08-18-decisions.md). r.json.data 로 바로 들어가면 그때 죽는다. */
  if (!r.json || !r.json.data) {
    console.log('  200이지만 예상한 JSON이 아니다. 본문 앞부분:');
    console.log(`  ${r.text.slice(0, 500)}`);
    return null;
  }
  const data = r.json.data;
  dump('product_detail', data);
  report('상품 단건', data);

  /* 상품 수정(PUT)이 "전체를 되보내는" 구조인지 판단할 근거를 남긴다.
     최상위 키 개수와 이름을 보여주면 얼마나 큰 객체를 되보내야 하는지가 보인다. */
  console.log(`\n  최상위 키 ${Object.keys(data).length}개:`);
  console.log('    ' + Object.keys(data).join(', '));
  const items = data.items || [];
  console.log(`  옵션(items) ${items.length}개`
    + (items.length ? `, 옵션 최상위 키: ${Object.keys(items[0]).join(', ')}` : ''));
  return data;
}

/* ── 3단계: 옵션(vendorItem) 조회 ────────────────────────────────────────────
   **어느 엔드포인트가 맞는지 모른다.** 그래서 후보를 나란히 던지고 HTTP 코드로 가른다.
   404 = 그런 길이 없음 / 200 = 있음 / 그 외 = 있는데 인자·권한 문제(= 존재 자체는 확인) */
async function probeVendorItem(vendorItemId) {
  console.log(`\n[3] 옵션 단건 조회 — 후보 엔드포인트를 나란히 시험 (vendorItemId=${vendorItemId})`);
  const candidates = [
    ['마켓플레이스 옵션 단건', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}`],
    ['옵션 재고',             `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`],
    ['로켓그로스 계열(추정)',  `/v2/providers/rg_open_api/apis/api/v1/rg/vendor-items/${vendorItemId}`]
  ];
  const results = [];
  let best = null;
  for (const [label, apiPath] of candidates) {
    const r = await call('GET', apiPath, '');
    results.push([label, apiPath, r.status]);
    if (r.ok && r.json && r.json.data && !best) best = { label, data: r.json.data };
    await new Promise((s) => setTimeout(s, 300));   // 연속 호출 사이 간격
  }
  console.log('\n  결과');
  results.forEach(([label, p, code]) => {
    const verdict = code === 200 ? '있음'
      : code === 404 ? '없음'
      : code === 403 ? 'IP/권한'
      : '있으나 인자 문제일 수 있음';
    console.log(`    ${String(code).padEnd(4)} ${verdict.padEnd(22)} ${label}`);
    console.log(`         ${p}`);
  });
  if (best) { dump('vendor_item', best.data); report(`옵션 단건 (${best.label})`, best.data); }
  else console.log('\n  200이 하나도 없다 — 가격·판매상태는 상품 단건 응답 안에서 찾아야 한다([2] 출력 참고).');
  return best ? best.data : null;
}

/* ── 4단계(선택): 쓰기 시험 — 값을 바꾸지 않는다 ─────────────────────────────
   현재가를 그대로 다시 쓴다. 성공하면 "이 경로로 가격을 바꿀 수 있다"가 증명되고,
   실패하면 사유가 본문에 온다. 어느 쪽이든 실제 판매가는 그대로다. */
async function probeWrite(vendorItemId, currentPrice) {
  console.log(`\n[4] 쓰기 시험 — 현재가(${currentPrice})를 '같은 값'으로 다시 쓴다. 값은 안 바뀐다.`);
  const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/prices/${currentPrice}`;
  const r = await call('PUT', apiPath, '');
  console.log(`  가격 변경: HTTP ${r.status}`);
  console.log(`    ${apiPath}`);
  console.log(`    ${r.text.slice(0, 400)}`);
  console.log('\n  ※ 판매상태(중지/재개)는 여기서 시험하지 않는다 — 실패하면 실제로 상품이 내려간다.');
  console.log('    가격이 통하면 같은 계열일 가능성이 높다. 그때 한 건만 따로 시험할 것.');
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}

async function main() {
  requireEnv();
  console.log('쿠팡 쓰기 정찰 — 읽기 위주. --write-test 없이는 아무것도 바꾸지 않는다.');

  const { sellerProductId } = await pickProduct(arg('seller-product-id'));
  const detail = await probeProductDetail(sellerProductId);

  /* vendorItemId는 응답에서 뽑는다. 철자가 엔드포인트마다 달라 세 곳을 다 본다
     (docs/api/coupang-open-api.md "엔드포인트 간 대소문자가 다르다"). */
  let vendorItemId = arg('vendor-item-id');
  if (!vendorItemId && detail) {
    const it = (detail.items || [])[0] || {};
    vendorItemId = (it.rocketGrowthItemData && it.rocketGrowthItemData.vendorItemId)
      || (it.marketplaceItemData && it.marketplaceItemData.vendorItemId)
      || (it.marketPlaceItemData && it.marketPlaceItemData.vendorItemId)
      || it.vendorItemId || null;
    if (vendorItemId) console.log(`\n  응답에서 vendorItemId=${vendorItemId} 를 뽑았다`);
  }
  if (!vendorItemId) { console.log('\n  vendorItemId를 못 찾았다 — 여기서 멈춘다.'); return; }

  const vi = await probeVendorItem(String(vendorItemId));

  if (process.argv.includes('--write-test')) {
    /* 가격은 반드시 **조회한 값**이어야 한다. 인자로 받지 않는다 —
       사람이 숫자를 타이핑하는 순간 실수로 실제 판매가가 바뀔 수 있다. */
    let cur = null;
    walk(vi || detail, (trail, value) => {
      const leaf = trail.split('.').pop();
      if (cur == null && /^salePrice$|^price$/i.test(leaf) && Number(value) > 0) cur = Number(value);
    });
    if (cur == null) {
      console.log('\n[4] 건너뜀 — 응답에서 현재가를 못 찾았다. [2]/[3]의 [가격] 목록을 보고');
      console.log('    필드 경로를 알려주면 그 값을 쓰도록 고치겠다. 추측으로 쓰지 않는다.');
    } else {
      await probeWrite(String(vendorItemId), cur);
    }
  } else {
    console.log('\n[4] 쓰기 시험은 건너뜀. 하려면 --write-test 를 붙일 것.');
  }

  console.log('\n끝. scripts/_probe_*.json 파일을 그대로 보내주면 설계를 확정한다.');
}

main().catch((e) => { console.error('실패:', e); process.exit(1); });
