/* ============================================================
   20-sales.js — 판매현황 (매출·이익·정산 병합)
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
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

/* 상품별 실제 원가정보(개당 수수료/입출고비/보관비) 수동 갱신 — 정산 백필과 마찬가지로
   자동으로는 안 돈다(전체 상품을 페이지네이션으로 다 훑어야 해서 WING에 부담,
   extension/CLAUDE.md 참조). 덮어쓰지 않고 새 스냅샷을 쌓는 방식이라 여러 번 눌러도
   과거 기록이 지워지지 않는다 — 가격을 바꿀 때마다 눌러주면 그 시점 요율이 남는다.
   상품이 수백 개면 페이지가 많아 오래 걸릴 수 있어 타임아웃을 넉넉히 잡는다. */
async function refreshItemCosts() {
  const statusEl = $('#salesSyncStatus');
  const btn = $('#itemCostRefreshBtn');
  btn.disabled = true;
  statusEl.textContent = '상품 원가정보(개당 수수료·입출고비·보관비) 갱신 중… (상품 수가 많으면 오래 걸릴 수 있습니다)';
  statusEl.classList.remove('hidden');

  const resp = await extensionSendMessage({ type: 'SYNC_ITEM_COSTS' }, 300000);

  if (resp.ok) {
    statusEl.textContent = `상품 원가정보 갱신 완료 (${resp.rowCount}개 옵션)`;
    setTimeout(() => statusEl.classList.add('hidden'), 5000);
    const fromEl = $('#salesFrom');
    const toEl = $('#salesTo');
    if (fromEl.value && toEl.value) await fetchAndRenderSales(fromEl.value, toEl.value);
  } else if (resp.error === 'no-extension') {
    statusEl.textContent = '확장프로그램이 연결되지 않았습니다 — 설치·로그인 상태를 확인하세요.';
  } else {
    statusEl.textContent = `상품 원가정보 갱신 실패: ${resp.error}`;
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
/* ── 실제 매입원가(선입선출) ──────────────────────────────────
   발주 → 출고에서 확정된 로트 원가를 판매에 붙인다. 결과는 (날짜|옵션ID) 단위
   개당 원가 맵이고, 판매현황의 원가·영업이익이 이걸 쓴다.

   **왜 미리 계산해서 저장하지 않고 볼 때마다 계산하나**: 로트 원가는 출고 시점에
   작업비가 붙으면서 한 번 올라간다. 미리 저장해두면 그때 과거 이익을 소급 갱신하는
   로직이 필요해지는데, 매번 현재 로트 원가로 계산하면 그런 게 아예 필요 없다
   (사용자와 확인, 2026-08-18 — 작업비 청구서가 쿠팡 도착 전에 오므로 실무상 어긋날
   일도 거의 없다).

   **판매 이력 전체를 읽는 이유**: 선입선출은 처음부터 순서대로 소진시켜야 맞다.
   조회 기간만 읽으면 이미 팔려나간 옛 로트가 아직 남은 것처럼 계산돼 원가가 낮게 나온다.
   이 계정 규모(상품 수십 개)에선 전량 조회가 몇백 KB라 문제되지 않는다 — 나중에
   수천 SKU가 되어 느려지면 그때 cogs_allocations(016)에 확정분을 물질화할 것. */
async function loadLotCogs(vendorItemIds) {
  const out = new Map();
  if (!vendorItemIds.length) return out;

  const [listings, lots, wing, gross] = await Promise.all([
    apiAll('sku_channel_listings?select=sku_id,external_option_id&channel=eq.coupang_rg'),
    apiAll('inventory_lots?select=id,sku_id,qty_coupang,unit_cost_krw,arrived_coupang_at&arrived_coupang_at=not.is.null'),
    apiAll('rocket_growth_sales_wing_daily?select=sale_date,vendor_item_id,quantity'),
    apiAll('rocket_growth_sales_daily?select=sale_date,vendor_item_id,quantity')
  ]);
  if (!lots.length) return out;

  const skuByVid = new Map();
  listings.forEach((l) => { if (l.external_option_id) skuByVid.set(String(l.external_option_id), l.sku_id); });
  if (!skuByVid.size) return out;

  /* 로트를 SKU별 선입선출 대기열로. 쿠팡에 도착한 수량이 곧 팔 수 있는 수량이다
     (불량은 출고 전에 이미 빠졌고, 판매될 때 로트 수량을 깎지는 않는다). */
  const queues = new Map();
  lots.slice()
    .sort((a, b) => new Date(a.arrived_coupang_at) - new Date(b.arrived_coupang_at))
    .forEach((lot) => {
      const cap = Number(lot.qty_coupang) || 0;
      if (!lot.sku_id || cap <= 0) return;
      const q = queues.get(lot.sku_id) || [];
      q.push({ left: cap, unit: Number(lot.unit_cost_krw) || 0,
               arrivedAt: (lot.arrived_coupang_at || '').slice(0, 10) });
      queues.set(lot.sku_id, q);
    });

  /* 판매 이력 병합 — 그 날짜에 WING 행이 하나라도 있으면 그 날짜는 WING만 쓴다
     (fetchSalesRange()와 같은 규칙. 섞으면 반품 반영분이 이중 계상된다). */
  const wingDates = new Set(wing.map((r) => r.sale_date));
  const byDate = new Map();
  const push = (r) => {
    const arr = byDate.get(r.sale_date) || [];
    arr.push(r);
    byDate.set(r.sale_date, arr);
  };
  wing.forEach(push);
  gross.forEach((r) => { if (!wingDates.has(r.sale_date)) push(r); });

  const wanted = new Set(vendorItemIds.map(String));
  Array.from(byDate.keys()).sort().forEach((date) => {
    byDate.get(date).forEach((r) => {
      const vid = String(r.vendor_item_id);
      const skuId = skuByVid.get(vid);
      if (!skuId) return;
      const q = queues.get(skuId);
      if (!q) return;

      let qty = Number(r.quantity) || 0;
      const sold = qty;              // 원가를 나눌 기준(아래 주석 참조)
      if (qty <= 0) {
        /* 반품(음수)은 로트로 되돌린다 — 맨 앞 로트에 얹으면 다음 판매가 그 원가로 나간다 */
        if (qty < 0 && q.length) q[0].left += -qty;
        return;
      }
      let total = 0, taken = 0;
      for (const lot of q) {
        if (qty <= 0) break;
        /* **판매일보다 나중에 도착한 로트는 쓸 수 없다.** 이걸 안 막으면 시스템 도입
           전의 옛 판매가 최근 매입분을 끌어다 써서, 없던 원가가 생기고 정작 최근
           판매는 로트가 모자라게 된다(2026-08-18 검증 중 발견). 원가를 못 매긴
           수량은 short로 남겨 화면에서 "원가 없음"으로 보이게 한다. */
        if (lot.arrivedAt && lot.arrivedAt > date) break;
        const take = Math.min(lot.left, qty);
        if (take <= 0) continue;
        lot.left -= take; qty -= take; taken += take; total += take * lot.unit;
      }
      /* 조회 대상 옵션만 결과에 담는다(계산은 전체를 돌려야 순서가 맞다).

         **개당 원가는 "덮인 수량"이 아니라 그날 판매수량 전체로 나눈다** — 화면 계산이
         (개당원가 x 판매수량)으로 합계를 내기 때문이다. 로트가 모자라 일부만 덮인 날에
         덮인 부분의 평균을 그대로 넘기면 없는 원가가 부풀려진다(8개 팔렸는데 6개분
         원가만 아는데도 8개분으로 계산되는 식). 이렇게 하면 합계는 항상 실제로 아는
         원가와 정확히 같고, 모자란 만큼은 short로 남아 화면에서 구분된다. */
      if (taken > 0 && wanted.has(vid)) {
        out.set(`${date}|${vid}`, {
          qty: sold, covered: taken, total,
          unit: Math.round((total / sold) * 100) / 100,
          short: qty > 0 ? qty : 0   // 로트가 모자라 원가를 못 매긴 수량
        });
      }
    });
  });
  return out;
}

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
      // 옵션ID 클릭용 등록상품ID·상품ID는 여기 안 넣는다 — product_items는 카테고리
      // 소싱(마진 조사용으로 수집한 다른 상품 목록)이라 실제 판매된 vendor_item_id와는
      // 무관한 데이터라 여기서 조인하면 틀린 값이 나온다(2026-08-16 사용자 지적으로
      // 발견 — web/CLAUDE.md 참조). 대신 loadProductRegistry()가 실제 등록정보
      // 테이블(rocket_growth_product_registry)에서 따로 가져온다.
    };
  });
  return meta;
}

/* 등록상품ID·상품ID — rocket_growth_product_registry(db/migrations/014)에서 가져온다.
   GCP VPS의 rocket-growth-sync.js --products가 공식 Open API "상품 목록 페이징 조회"로
   채운 실제 등록정보다(docs/api-notes.md 4-7). product_items(소싱 DB)와는 완전히
   별개 — 그쪽은 카테고리 소싱(마진 조사용으로 수집한 다른 상품 목록)이라 실제로
   판매된 vendor_item_id와 무관하다(2026-08-16 사용자 지적). SKU ID는 이 API에
   없어서 안 채움(나중에 재고 페이지 만들 때 다시 조사하기로 함) — meta에 없는
   vendor_item_id는 그 옵션이 아직 이 계정에서 동기화 안 됐거나(레지스트리 동기화
   전) 로켓그로스 상품이 아닌 경우다. */
async function loadProductRegistry(vendorItemIds) {
  const out = {};
  if (!vendorItemIds.length) return out;
  let rows;
  try {
    // 마이그레이션 014 미실행이거나 --products 동기화를 아직 한 번도 안 돌렸으면
    // 테이블이 없거나 비어있을 수 있다 — 이 표 하나 때문에 판매현황 전체가
    // 멎으면 안 되므로 실패해도 조용히 빈 값으로 폴백한다(등록상품ID·쿠팡 링크만
    // "—"로 빠지고 나머지 화면은 항상 정상 동작해야 하는 기존 원칙과 동일).
    rows = await api(
      `rocket_growth_product_registry?select=vendor_item_id,seller_product_id,product_id` +
      `&vendor_item_id=in.(${vendorItemIds.map(encodeURIComponent).join(',')})`
    ) || [];
  } catch (e) {
    console.warn('[판매현황] 상품 등록정보 조회 실패(등록상품ID/링크만 빠짐):', e.message);
    return out;
  }
  rows.forEach((r) => {
    out[r.vendor_item_id] = { sellerProductId: r.seller_product_id, productId: r.product_id };
  });
  return out;
}

/* 하루치 옵션별 판매(items)를 확정 정산(confirmed, 있으면)과 합쳐 한 줄로 만든다.
   확정 정산에 있는 필드(수수료/입출고비/보관비/쿠폰/밀크런/순이익/매출)는 WING 확정값을
   그대로 쓰고, 없으면(주로 오늘 — 정산 인식이 D-1 지연) 옵션별 추정으로 채운다.
   추정은 renderSales()와 동일한 우선순위를 따른다 — 상품 원가정보 스냅샷(costSnapshots)이
   있으면 그 실제 개당 값을, 없는 상품만 카테고리 요율+요금표로 폴백(2026-08-16 개선:
   예전엔 항상 카테고리 폴백만 써서, 카테고리 매칭이 안 된 계정은 당일 수수료·입출고비·
   보관비·쿠폰비·순이익이 전부 0으로 보였다 — 매출·판매수량만 별도 경로라 정상이었음).
   광고비·밀크런은 정산현황 API에만 있는 값이라 추정 방법 자체가 없어 항상 0(사용자 확인:
   당일엔 몰라도 되는 값). 원가·배송/작업비·영업이익도 정산현황 API에 없는 필드라 항상
   옵션별 추정(user_items.cost_cny 등, calcMargin() 재사용)으로만 계산 — 확정/추정 여부와 무관. */
function buildDailyRow(date, items, meta, confirmed, costSnapshots, lotCogs) {
  let quantity = 0, itemRevenue = 0;
  let estCommission = 0, estFulfillment = 0, estCoupon = 0, estStorage = 0, estSettlement = 0;
  let cost = 0, shipWork = 0, opProfit = 0, costedQty = 0;

  items.forEach((it) => {
    quantity += it.quantity;
    itemRevenue += it.revenue;
    const m = meta[it.vendor_item_id] || {};
    const avgPrice = it.quantity ? it.revenue / it.quantity : 0;

    const snapResult = snapshotAsOf(costSnapshots && costSnapshots[it.vendor_item_id], date);
    let commissionRate, fee, coupon;
    if (snapResult) {
      // 수수료는 그 자체로 부가세 포함 확정값과 대응되는 독립 항목이라 여기서 바로
      // 보정한다(withSnapshotVat, 2026-08-17 실측 검증됨). 입출고비는 다르다 — WING
      // 자신의 "풀필먼트서비스 비용" 상세(사용자 스크린샷)를 보면 부가세는 입출고비
      // 하나가 아니라 "입출고비+보관비를 합친 금액의 10%"로 계산된다. 그래서 여기서는
      // fee를 세전 원값 그대로 두고, 보관비까지 합산한 뒤 아래에서 부가세를 한 번에
      // 계산한다 — withSnapshotVat을 fee에 바로 곱하면 보관비 몫의 부가세가 빠진다.
      commissionRate = avgPrice > 0 ? (withSnapshotVat(snapResult.snap.commission_amount) / avgPrice * 100) : 0;
      fee = snapResult.snap.fulfillment_amount;
      coupon = snapResult.snap.coupon_amount || 0;
    } else {
      commissionRate = commissionFor(m.catCode);
      fee = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
      coupon = 0; // 카테고리 요율표엔 쿠폰 개념이 없어 추정 불가
    }
    if (commissionRate == null) return;
    estCoupon += coupon * it.quantity;
    const storageInfo = storageAllocationForItem(costSnapshots && costSnapshots[it.vendor_item_id], 1);
    if (storageInfo) estStorage += storageInfo.allocated;

    const lc = lotCogs && lotCogs.get(`${date}|${it.vendor_item_id}`);
    const c = calcMargin({
      price: avgPrice, commission: commissionRate, fulfillment: fee,
      costKrw: lc ? lc.unit : null,
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

  // WING 정산현황 페이지 자체가 "오늘" 날짜는 절대 안 보여준다(항상 D-1까지만,
  // 사용자 확인 2026-08-17) — 그런데 profit-status/search API는 오늘 날짜로 조회해도
  // 가끔 필드가 채워진(0이 아닌) 응답을 준다. 처음엔 "전부 0이면 빈 응답"으로만
  // 걸렀는데(바로 아래 looksEmpty, 2026-08-16), 그건 놓치는 경우가 있었다 — 실사용
  // 사례(2026-08-17): 오늘 실제 판매 0건인데 profit-status가 fulfillment_amount:6470,
  // storage_amount:1282(0이 아님)를 줘서 "빈 응답" 필터를 통과해버렸고, 순이익 -6,470원이
  // "확정"으로 화면에 떴다. 보관비 같은 항목은 판매 이벤트 없이도(창고에 쌓인 재고
  // 기준으로) 매일 누적되는 비용이라 이런 식으로 부분 데이터가 먼저 채워질 수 있는
  // 것으로 보인다 — 즉 "0이 아니다"가 "그날 정산이 최종 확정됐다"를 보장하지 않는다.
  // **그래서 날짜 자체가 오늘(KST)이면 confirmed 내용과 무관하게 항상 확정으로 안 믿는다**
  // — WING 자신도 오늘 날짜는 화면에 아예 안 보여주는 것과 원칙을 맞춘 것. 옵션별
  // 추정으로 폴백해서 "정보 없음"보다야 낫지만, 이것도 결국 추정치일 뿐이라는 걸
  // 감안할 것.
  const isToday = date === kstDateStr(new Date());
  const looksEmpty = confirmed && !confirmed.total_sales_amount && !confirmed.total_deduction_amount;
  const hasConfirmed = !!confirmed && !isToday && !(looksEmpty && quantity > 0);
  const revenue = hasConfirmed ? confirmed.net_sales_amount : itemRevenue;
  // 풀필먼트서비스 부가세 — WING 자신의 "수익 현황" 화면(사용자 스크린샷, 2026-08-17)에서
  // "부가가치세는 조회된 기간에 발생한 요금의 10%로 계산"됨을 확인, 실측 검산(9,336원)까지
  // 정확히 일치했다. 확정일은 WING이 이미 "배송비+입출고비+보관비+부가세"를 fulfillment_amount
  // 하나로 합쳐서 주므로(별도 필드 없음), 총액÷11 = 그 안에 포함된 부가세와 수학적으로 완전히
  // 같다(총액=세전×1.1 이므로 세전=총액÷1.1, 부가세=총액−세전=총액÷11). 추정일(오늘 등)은
  // 우리가 직접 세전 입출고비+보관비를 만들었으니 그 합의 10%로 계산 — 어느 쪽이든 "보관비"
  // 컬럼(참고용, 이미 입출고비 안에 포함된 서브셋)과 별개로 하나 더 참고용 컬럼을 추가한다.
  const vat = hasConfirmed ? Math.round(confirmed.fulfillment_amount / 11) : Math.round((estFulfillment + estStorage) * 0.1);
  // 순이익 = 매출 − 수수료 − 입출고비 − 보관비 − 쿠폰비 − 광고비 − 부가세(사용자 확정,
  // 2026-08-17) — 확정일은 WING의 profit_amount에 이미 다 반영돼 있어 그대로 쓰고,
  // 추정일만 직접 이 여섯 항목을 다 뺀다(광고비는 추정 방법이 없어 0으로 고정).
  const estNetProfit = estSettlement - estCoupon - estStorage - vat;
  const netProfit = hasConfirmed ? confirmed.profit_amount : estNetProfit;
  const hasCost = costedQty > 0;

  return {
    date, quantity, revenue,
    commission: hasConfirmed ? confirmed.commission_amount : estCommission,
    fulfillment: hasConfirmed ? confirmed.fulfillment_amount : estFulfillment,
    storage: hasConfirmed ? confirmed.storage_amount : estStorage,
    vat,
    coupon: hasConfirmed ? confirmed.coupon_amount : estCoupon,
    ad: hasConfirmed ? confirmed.ad_amount : 0,
    milkrun: hasConfirmed ? confirmed.milkrun_amount : 0,
    netProfit,
    cost: hasCost ? cost : null,
    shipWork: hasCost ? shipWork : null,
    operatingProfit: hasCost ? (netProfit - cost - shipWork) : null,
    // itemRevenue와 같은 이유로, hasConfirmed 여부와 무관하게 옵션별 추정치를
    // 그대로 같이 들고 있는다 — renderReconcileNote()가 확정값과 대조할 때 씀
    // (2026-08-17, 수수료+입출고비·순이익도 매출처럼 대조하기 위해 추가).
    confirmed: hasConfirmed, itemRevenue,
    itemFeeCombined: estCommission + estFulfillment, itemNetProfit: estNetProfit
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
      `rocket_growth_profit_daily?select=sale_date,total_sales_amount,total_deduction_amount,net_sales_amount,` +
      `commission_amount,fulfillment_amount,storage_amount,coupon_amount,ad_amount,milkrun_amount,profit_amount` +
      `&sale_date=gte.${fromDate}&sale_date=lte.${toDate}`
    )
  ]);

  /* 날짜 단위로 병합한다(항목별 병합 아님, 2026-08-16 수정) — WING의
     sold-vendor-item-list는 그 날짜를 동기화했다면 "순매출이 있는 항목 전체"를
     완전한 목록으로 준다. 그런데 당일 매입+반품으로 순매출이 정확히 0이 된 항목은
     그 목록 자체에서 빠진다(0을 보여주는 게 아니라 아예 없음). 예전엔 항목별로
     "WING에 있으면 WING, 없으면 Open API" 식으로 병합해서, 이런 순제로 항목이
     Open API의 반품 반영 전 값 그대로 남아 매출이 과다 계상되는 버그가 있었다
     (실사용 중 발견: 2026-08-15에 "덴넬 빅치즈...510g"가 당일 매입+반품으로 WING
     목록엔 없는데 Open API엔 12,900원으로 남아있어 그만큼 이중 계상됨).
     그래서 "이 날짜에 WING 데이터가 하나라도 있으면 그 날짜는 WING만 쓰고
     Open API는 통째로 무시"로 바꿨다 — WING이 그 날짜를 동기화했다면 원래
     완전한 목록이라 섞을 필요가 없다. WING이 아예 동기화 안 된 날짜만
     Open API로 폴백한다(반품 미반영이라 부정확할 수 있지만 없는 것보단 낫다). */
  const wingDates = new Set((wingRows || []).map((r) => r.sale_date));
  const byDate = {};
  (grossRows || []).forEach((r) => {
    if (wingDates.has(r.sale_date)) return; // 이 날짜는 WING이 완전한 진실 — Open API 무시
    (byDate[r.sale_date] = byDate[r.sale_date] || []).push(r);
  });
  (wingRows || []).forEach((r) => {
    (byDate[r.sale_date] = byDate[r.sale_date] || []).push(r);
  });

  const profitByDate = {};
  (profitRows || []).forEach((r) => { profitByDate[r.sale_date] = r; });

  const vendorItemIds = Array.from(new Set(
    Object.values(byDate).flat().map((r) => r.vendor_item_id)
  ));

  return { byDate, profitByDate, vendorItemIds, hasWing: wingDates.size > 0 };
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

/* 조회 기간(salesFrom~salesTo)만 표시하는 일별 상세표. 날짜가 2개 이상이면 맨 위에
   합계 행을 고정 표시한다(사용자 요청, 2026-08-16) — 날짜 정렬과 무관하게 항상 맨 위. */
function renderDailyTable(dailyByDate, fromDate, toDate) {
  const dates = dateRangeList(fromDate, toDate).slice().reverse(); // 최신 날짜가 위로
  const rows = dates.map((d) => dailyByDate[d]).filter(Boolean);

  $('#dailyEmpty').classList.toggle('hidden', rows.length > 0);
  const totalHtml = rows.length > 1 ? dailyRowHtml(sumDailyFullRows(rows), '합계', true) : '';
  $('#dailyBody').innerHTML = totalHtml + rows.map((r) => dailyRowHtml(r, r.date, false)).join('');
}

/* 일별 상세표 한 줄 렌더러 — 날짜별 행과 맨 위 합계 행이 이 함수 하나를 공유한다. */
function dailyRowHtml(r, dateLabel, isTotal) {
  return `
<tr class="${isTotal ? 'daily-total-row' : ''}">
  <td data-label="날짜">${dateLabel}</td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(r.commission)}</td>
  <td class="col-num" data-label="입출고비">${won(r.fulfillment)}</td>
  <td class="col-num" data-label="보관비">${won(r.storage)}</td>
  <td class="col-num" data-label="부가세">${won(r.vat)}</td>
  <td class="col-num" data-label="쿠폰비">${won(r.coupon)}</td>
  <td class="col-num" data-label="광고비">${won(r.ad)}</td>
  <td class="col-num" data-label="밀크런">${won(r.milkrun)}</td>
  <td class="col-num" data-label="순이익"><span class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${r.netProfit.toLocaleString()}원</span></td>
  <td class="col-num" data-label="원가">${r.cost != null ? won(r.cost) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="배송·작업비">${r.shipWork != null ? won(r.shipWork) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="영업이익">${
    r.operatingProfit != null
      ? `<span class="${r.operatingProfit >= 0 ? 'pos' : 'neg'}">${r.operatingProfit.toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
}

/* renderDailyTable() 합계 행 전용 — sumDailyRows()(상단 카드용, 매출/순이익/영업이익 3개만)와
   달리 일별 상세표의 모든 칸을 채워야 해서 별도로 둔다. cost/shipWork/operatingProfit은
   원가 입력된 날짜만 골라 합산(부분 계산 허용 관례, buildDailyRow()와 동일). */
function sumDailyFullRows(rows) {
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const costedRows = rows.filter((r) => r.cost != null);
  return {
    quantity: sum('quantity'), revenue: sum('revenue'), commission: sum('commission'),
    fulfillment: sum('fulfillment'), storage: sum('storage'), vat: sum('vat'), coupon: sum('coupon'),
    ad: sum('ad'), milkrun: sum('milkrun'), netProfit: sum('netProfit'),
    cost: costedRows.length ? costedRows.reduce((s, r) => s + r.cost, 0) : null,
    shipWork: costedRows.length ? costedRows.reduce((s, r) => s + r.shipWork, 0) : null,
    operatingProfit: costedRows.length ? costedRows.reduce((s, r) => s + r.operatingProfit, 0) : null
  };
}

/* 정산현황 API는 계정 전체 합계만 주고 어떤 상품이 팔렸는지는 없다(docs/api-notes.md 4-4-4) —
   그래서 상품별 합산과 정산 매출을 서로 다른 소스에서 각각 만들 수밖에 없고, 둘이 구조적으로
   100% 일치할 보장이 없다. 조회 기간 안에 확정 정산이 있는 날짜만 골라 매출·수수료+입출고비·
   순이익 세 가지를 대조해서 보여준다(2026-08-17, 원래 매출만 보던 걸 확장 — 사용자가 8/16
   수수료+입출고비·순이익이 다르다고 지적해서 원인을 조사했고, 그 결과를 매번 수동으로 찾을
   필요 없이 화면에서 바로 보이게 함).

   **알려진 구조적 원인 두 가지(2026-08-17 조사, docs/decisions.md 참조)**:
   1. 상품별 수수료·입출고비 추정은 WING 재고현황의 "예상(개당)" 값(부가세 별도)에
      ×1.1(부가세)을 보정해서 쓴다(`withSnapshotVat()`) — 이걸로 수수료 쪽 차이는
      거의 없어짐(8/16 실측: 정확히 일치).
   2. 입출고비는 보정해도 차이가 남을 수 있다 — 당일 매입+당일 반품으로 순수량이
      정확히 0이 된 옵션은 WING 판매목록(`sold-vendor-item-list`) 자체에서 빠져서
      (0으로 안 찍히고 아예 없음) 그 옵션의 반품처리비가 상품별 어디에도 안 잡힌다.
      이건 코드로 못 고치는 한계 — WING에 반품만 따로 보여주는 API가 있는지 별도
      조사 중(2026-08-17 착수). */
function renderReconcileNote(dailyByDate, fromDate, toDate) {
  const note = $('#salesReconcileNote');
  const rows = dateRangeList(fromDate, toDate).map((d) => dailyByDate[d]).filter((r) => r && r.confirmed);
  if (!rows.length) { note.classList.add('hidden'); return; }

  const sums = {
    revenue: [rows.reduce((s, r) => s + r.itemRevenue, 0), rows.reduce((s, r) => s + r.revenue, 0), '매출'],
    fee: [rows.reduce((s, r) => s + r.itemFeeCombined, 0), rows.reduce((s, r) => s + r.commission + r.fulfillment, 0), '수수료+입출고비'],
    profit: [rows.reduce((s, r) => s + r.itemNetProfit, 0), rows.reduce((s, r) => s + r.netProfit, 0), '순이익']
  };

  const lines = Object.values(sums)
    .map(([itemSum, settleSum, label]) => ({ itemSum, settleSum, label, diff: itemSum - settleSum }))
    .filter((x) => Math.abs(x.diff) >= 1);
  if (!lines.length) { note.classList.add('hidden'); return; }

  note.innerHTML =
    `대조: 확정 정산이 있는 ${rows.length}일 기준 — 옵션별 합산 vs 정산현황(둘 다 부가세 보정 반영):<br>` +
    lines.map((x) => `${x.label} ${x.itemSum.toLocaleString()}원 vs ${x.settleSum.toLocaleString()}원 (차이 ${x.diff.toLocaleString()}원)`).join(' · ') +
    `<br><span class="dim xs">수수료+입출고비·순이익 차이는 주로 당일 매입+당일 반품으로 순수량이 0이 된 옵션의 반품처리비가 WING 판매목록 자체에서 빠지기 때문(구조적 한계, web/CLAUDE.md 참조)</span>`;
  note.classList.remove('hidden');
}

/* 상품별 실제 원가정보(개당 수수료/입출고비/보관비) — WING 재고현황 API 기반(docs/api-notes.md 4-4-6).
   덮어쓰지 않고 스냅샷으로 쌓이므로(db/migrations/012), 조회하는 날짜 이전 중 가장 최근
   스냅샷을 골라 써야 "가격 바뀌기 전에 팔린 건 바뀌기 전 요율로" 계산된다. */
async function loadItemCostSnapshots(vendorItemIds) {
  const out = {};
  if (!vendorItemIds.length) return out;
  // 조회 기간 끝 날짜로 필터링하지 않는다 — 예전엔 "captured_at <= 조회기간 끝"으로
  // 걸렀는데, 스냅샷이 전부 조회기간보다 나중에 찍혔으면(예: 오늘 막 처음 갱신했는데
  // "어제"만 조회) 그 필터가 스냅샷을 통째로 걸러내서 snapshotAsOf()의 참고용 폴백
  // (그 상품에 있는 것 중 가장 이른 스냅샷 사용)까지 같이 막아버리는 버그가 있었다
  // (2026-08-16 실사용 중 발견). snapshotAsOf() 자체가 이미 "그 날짜 이전 것 우선,
  // 없으면 가장 이른 것"을 골라내므로 여기서는 전체를 다 가져오기만 하면 된다.
  const rows = await api(
    `rocket_growth_item_cost_snapshots?select=vendor_item_id,captured_at,commission_amount,fulfillment_amount,coupon_amount,monthly_storage_fee_amount` +
    `&vendor_item_id=in.(${vendorItemIds.map(encodeURIComponent).join(',')})` +
    `&order=vendor_item_id.asc,captured_at.asc`
  ) || [];
  rows.forEach((r) => { (out[r.vendor_item_id] = out[r.vendor_item_id] || []).push(r); });
  return out; // 이미 captured_at 오름차순 — 아이템별 배열
}

/* 상품별 원가 스냅샷(commission_amount/fulfillment_amount)은 WING 재고현황의
   "예상(개당)" 툴팁 값 — 부가세 별도. 반면 확정 정산(rocket_growth_profit_daily)의
   commission_amount/fulfillment_amount는 필드명 자체가 totalTakeRateAmountWithVat/
   totalCfsAmountWithVat, 즉 부가세 포함이다. 2026-08-17 실사용 대조로 확인:
   8/16 스냅샷 기반 수수료 합(3,758원)×1.1=4,134원이 그날 확정 수수료(4,134원)와
   정확히 일치 — 부가세 차이였다는 걸 산술로 검증함(`docs/decisions.md` 참조).
   **카테고리 요율 폴백(commissionFor/feeFor)에는 이 보정을 적용하지 않는다** —
   그쪽은 부가세 포함 여부를 검증한 적이 없어서(요율표·요금표 출처가 다름), 근거
   없이 같은 보정을 씌우면 오히려 새로운 오차를 만들 수 있다. 쿠폰비(coupon_amount)도
   보정 대상 아님 — 8/16 대조에서 쿠폰비는 보정 없이 이미 정확히 일치했다. */
const SNAPSHOT_VAT_RATE = 1.1;
function withSnapshotVat(amount) {
  return amount == null ? amount : Math.round(amount * SNAPSHOT_VAT_RATE);
}

/* dateStr 하루 끝(KST) 시점에 유효했던 가장 최근 스냅샷. 시각 비교는 오프셋이 서로 다른
   ISO 문자열(DB는 +00:00, 여기선 +09:00)이라 문자열 비교가 아니라 epoch ms로 해야 한다. */
function snapshotAsOf(snapshots, dateStr) {
  if (!snapshots || !snapshots.length) return null;
  const cutoffMs = new Date(`${dateStr}T23:59:59.999+09:00`).getTime();
  let picked = null;
  for (const s of snapshots) {
    if (new Date(s.captured_at).getTime() <= cutoffMs) picked = s; else break;
  }
  if (picked) return { snap: picked, exact: true };
  // 그 날짜 이전 스냅샷이 없으면(스냅샷을 도입하기 전에 팔린 과거 판매 — 예: 처음
  // "상품 원가정보 갱신"을 누르기 전 날짜들) 그 상품에 있는 것 중 가장 이른 스냅샷을
  // 참고값으로 쓴다. 그 날짜의 진짜 요율이 아닐 수 있다는 걸 알고 쓸 것 — 사용자가
  // "정산현황과 맞는지 검증해보려고" 과거 날짜도 빈칸 대신 값을 채워달라고 요청함
  // (2026-08-16). renderSales()에서 이 경우만 exact:false로 구분해 표시한다.
  return { snap: snapshots[0], exact: false };
}

/* 보관비는 "이번 달 누적" 스냅샷 하나뿐이라 일별로 못 쪼갠다(사용자 확인, 2026-08-16) —
   가장 최근 스냅샷의 누적액을 그 스냅샷 시점까지의 이번 달 경과일수로 나눠 일평균을 낸 뒤
   조회 기간 일수만큼 곱해 참고용으로 배분한다. 영업이익 계산엔 포함하지 않는다(사용자 명시). */
function storageAllocationForItem(snapshots, rangeDayCount) {
  if (!snapshots || !snapshots.length) return null;
  const latest = snapshots[snapshots.length - 1];
  const dayOfMonth = parseInt(kstDateStr(new Date(latest.captured_at)).split('-')[2], 10);
  if (!dayOfMonth) return null;
  const dailyRate = latest.monthly_storage_fee_amount / dayOfMonth;
  return {
    monthly: latest.monthly_storage_fee_amount,
    allocated: Math.round(dailyRate * rangeDayCount)
  };
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
    // 상단 카드·일별 상세표의 추정치도 상품/옵션별 상세표와 같은 실제 개당 원가 스냅샷을
    // 우선 쓰도록 여기서 한 번만 불러와 공유한다(2026-08-16 개선, 아래 buildDailyRow 참조) —
    // 조회 범위 전체(fetchFrom~fetchTo)를 커버하니 뒤에서 renderSales()용으로 다시 불러올
    // 필요 없다.
    const costSnapshots = await loadItemCostSnapshots(vendorItemIds);
    // 발주·출고에서 확정된 실제 매입원가(선입선출) — 원가·영업이익이 이걸 우선 쓴다
    const lotCogs = await loadLotCogs(vendorItemIds);
    // 등록상품ID·상품ID(옵션ID 클릭용) — meta에 병합해서 renderSales()가 그대로 씀.
    const registry = await loadProductRegistry(vendorItemIds);
    vendorItemIds.forEach((vid) => {
      if (registry[vid]) Object.assign(meta[vid], registry[vid]);
    });

    const dailyByDate = {};
    dateRangeList(fetchFrom, fetchTo).forEach((d) => {
      dailyByDate[d] = buildDailyRow(d, byDate[d] || [], meta, profitByDate[d], costSnapshots, lotCogs);
    });

    renderPeriodCards(dailyByDate, todayStr);
    renderDailyTable(dailyByDate, fromDate, toDate);
    renderReconcileNote(dailyByDate, fromDate, toDate);

    const rangeTxt = fromDate === toDate ? fromDate : `${fromDate} ~ ${toDate}`;
    $('#salesSummary').textContent = `${rangeTxt} 기준 (로켓그로스 Open API${hasWing ? ' + WING 반품 반영' : ''})`;

    // 상품/옵션별 표는 선택한 기간(fromDate~toDate)만 다루되, 날짜별로 묶어서 보여준다
    // — 아래 renderSales() 참조.
    const rangeDates = dateRangeList(fromDate, toDate);
    const hasAnyInRange = rangeDates.some((d) => (byDate[d] || []).length);

    if (!hasAnyInRange) {
      $('#salesEmpty').classList.remove('hidden');
      return;
    }

    renderSales(rangeDates, byDate, meta, costSnapshots, profitByDate, lotCogs);
  } catch (e) {
    $('#salesMsg').textContent = '판매현황을 불러오지 못했습니다: ' + e.message;
    $('#salesMsg').classList.remove('hidden');
  } finally {
    $('#salesLoader').classList.add('hidden');
    $('#dailyLoader').classList.add('hidden');
  }
}

function mdFmt(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/* 쿠팡 실제 판매 페이지 URL(옵션ID 클릭 시 이동, 사용자 요청 2026-08-16) — 등록정보
   레지스트리(rocket_growth_product_registry)에 그 옵션이 아직 없으면(동기화 전이거나
   로켓그로스 상품이 아님) null 반환, 호출부에서 링크 없이 표시. itemId는 지금 안 받아오므로
   (SKU ID 보류, 위 loadProductRegistry 참조) 빼고 productId+vendorItemId만으로 연결한다
   — docs/api-notes.md 2-5에 정리된 URL 시도 순서 중 "?vendorItemId=" 패턴, 실사용 확인됨. */
function coupangProductUrl(m, vid) {
  if (!m || !m.productId) return null;
  return `https://www.coupang.com/vp/products/${encodeURIComponent(m.productId)}?vendorItemId=${encodeURIComponent(vid)}`;
}

/* 상품/옵션별 상세표 — 2026-08-16 오후 재개편(날짜별 그룹핑, docs/decisions.md 참조)에
   이어 2026-08-17에 부가세·보관비 처리를 다시 손봤다.
   **수수료/입출고비는 다시 별도 컬럼이다**(2026-08-16엔 "수수료 및 입출고비" 하나로
   합쳤었는데, 사용자가 다시 나눠달라고 요청 — 개별 상품 행까지 전부 적용).
   **보관비는 더 이상 옵션 단위로 안 나온다** — WING 자신도 "고정 보관비"는 그날 팔린
   특정 주문에 묶이지 않은, 재고 전체 기준 하루치 총액이라(사용자 확인) 개별 옵션에
   배분하는 게 억지 정밀도였다. 그래서 옵션 행은 보관비를 "—"로 두고, **날짜 그룹
   헤더(합계 행)에서만** 그 날짜의 확정 정산(`rocket_growth_profit_daily.storage_amount`)을
   그대로 가져와 보여준다(`profitByDate` 필요) — 확정 정산이 없는 날(예: 오늘)은 "—".
   **부가세도 새로 추가됨** — WING "수익 현황" 화면(사용자 스크린샷, 2026-08-17)에서
   "부가가치세 = 조회 기간 요금의 10%"임을 확인했다. 옵션 행은 그 옵션의 입출고비만
   기준으로 10%(보관비를 옵션 단위로 안 다루니 여기엔 보관비 몫이 없음), 날짜 합계
   행은 옵션별 부가세 합 + 그 날짜 고정 보관비의 10%까지 더해서 완전하게 계산한다.
   **순이익 = 매출 − 수수료 − 입출고비 − 보관비 − 쿠폰비 − 광고비 − 부가세**
   (사용자 확정 공식, 2026-08-17) — 옵션 행은 보관비 항이 없어 6개 항만 빼고, 날짜
   합계 행에서 그 날짜의 고정 보관비와 그 부가세를 추가로 뺀다. */
function renderSales(rangeDates, byDate, meta, costSnapshots, profitByDate, lotCogs) {
  let costedCount = 0, noCommissionCount = 0, estimatedCount = 0, approxCount = 0, rowCount = 0;

  const sections = rangeDates.slice().reverse().map((date) => {
    const rows = (byDate[date] || []).map((r) => {
      const vid = r.vendor_item_id;
      const m = meta[vid] || {};
      const avgPrice = r.quantity ? r.revenue / r.quantity : 0;
      const snapResult = snapshotAsOf(costSnapshots[vid], date);

      let commissionRate, fulfillmentAmt, couponAmt, hasApprox = false, hasEstimate = false;
      if (snapResult) {
        if (!snapResult.exact) hasApprox = true; // 그 날짜 이전 스냅샷이 없어 이후 스냅샷을 대신 씀
        commissionRate = avgPrice > 0 ? (withSnapshotVat(snapResult.snap.commission_amount) / avgPrice * 100) : 0;
        fulfillmentAmt = snapResult.snap.fulfillment_amount; // 세전 원값 — 부가세는 아래서 따로 계산
        couponAmt = snapResult.snap.coupon_amount || 0;
      } else {
        hasEstimate = true;
        commissionRate = commissionFor(m.catCode);
        fulfillmentAmt = m.catCode ? feeFor(m.catCode, m.size, avgPrice) : null;
        couponAmt = 0; // 카테고리 요율표엔 쿠폰 개념이 없어 추정 불가
      }

      rowCount++;
      const url = coupangProductUrl(m, vid);
      if (commissionRate == null) {
        noCommissionCount++;
        return {
          vid, name: r.product_name, url, productId: m.productId, sellerProductId: m.sellerProductId,
          quantity: r.quantity, revenue: r.revenue, noCommission: true
        };
      }
      if (hasEstimate) estimatedCount++;
      else if (hasApprox) approxCount++;

      const lc = lotCogs && lotCogs.get(`${date}|${vid}`);
      const c = calcMargin({
        price: avgPrice, commission: commissionRate, fulfillment: fulfillmentAmt,
        costKrw: lc ? lc.unit : null,
        costCny: m.costCny, rate: m.exchangeRate, outbound: m.outboundFee, work: m.workFee
      });
      const commission = c ? c.commission * r.quantity : 0;
      const fulfillment = (c && fulfillmentAmt != null) ? fulfillmentAmt * r.quantity : 0;
      const coupon = couponAmt * r.quantity;
      const settlement = c ? c.settlement * r.quantity : 0;
      const vat = Math.round(fulfillment * 0.1); // 보관비 몫은 옵션 단위가 아니라 날짜 합계에서 더함
      // storageAllocationForItem은 이제 순이익에 안 쓰지만, "이번달 누적보관비" 참고용
      // 표시(상세 펼치기)엔 여전히 씀 — 그 상품 자체의 보관비 규모를 가늠하는 용도.
      const storageInfo = storageAllocationForItem(costSnapshots[vid], 1);
      const netProfit = settlement - coupon - vat;
      const hasCost = !!(c && c.margin != null);
      if (hasCost) costedCount++;

      return {
        vid, name: r.product_name, url, productId: m.productId, sellerProductId: m.sellerProductId,
        quantity: r.quantity, revenue: r.revenue,
        commission, fulfillment, vat, coupon,
        storageMonthly: storageInfo ? storageInfo.monthly : null,
        netProfit,
        cost: hasCost ? c.cost * r.quantity : null,
        shipWork: hasCost ? c.shipWork * r.quantity : null,
        operatingProfit: hasCost ? (netProfit - c.cost * r.quantity - c.shipWork * r.quantity) : null,
        // 우선순위: 카테고리 추정을 쓰면 "(추정)", 아니면 스냅샷은 있는데 그 날짜 이전 게
        // 아니라 이후 것(참고용)을 쓰면 "(참고용)", 둘 다 없으면 라벨 없음.
        label: hasEstimate ? '(추정)' : (hasApprox ? '(참고용)' : '')
      };
    });
    const confirmedStorage = profitByDate[date] ? profitByDate[date].storage_amount : null;
    return { date, rows, confirmedStorage };
  }).filter((sec) => sec.rows.length);

  const uncosted = rowCount - costedCount - noCommissionCount;
  const notes = [];
  if (uncosted > 0) notes.push(`원가 미입력 ${uncosted}건`);
  if (noCommissionCount > 0) notes.push(`수수료 정보 없는 판매 ${noCommissionCount}건`);
  if (estimatedCount > 0) notes.push(`상품 원가정보 스냅샷 없어 카테고리 추정을 쓴 판매 ${estimatedCount}건`);
  if (approxCount > 0) notes.push(`판매 시점 이전 스냅샷이 없어 이후 스냅샷(참고용)을 쓴 판매 ${approxCount}건`);
  $('#salesTableNote').textContent = notes.length ? `${notes.join(' · ')}` : '';

  $('#salesBody').innerHTML = sections.map((sec) => {
    const headHtml = dateGroupHeadHtml(sec.date, sec.rows, sec.confirmedStorage);
    const rowsHtml = sec.rows.map((r) => salesRowHtml(r)).join('');
    return headHtml + rowsHtml;
  }).join('');
}

/* 등록상품ID·옵션ID를 WING 상품 목록 화면과 같은 순서·구분자("·")로 보여준다
   (사용자가 WING 화면 스크린샷으로 요청, 2026-08-16) — WING도 옵션ID(=vendorItemId)에만
   외부링크 아이콘을 붙여 클릭 가능하게 하므로 우리도 옵션ID만 <a>로 감싼다.
   등록상품ID=rocket_growth_product_registry.seller_product_id(공식 Open API "상품 목록
   페이징 조회"로 채움, docs/api-notes.md 4-7) — 그 옵션이 레지스트리 동기화 전이면 "—".
   **SKU ID는 뺐다(2026-08-16 사용자 결정)** — 공식 Open API 세 개(상품목록/상품조회/
   재고) 어디에도 WING이 보여주는 8자리 SKU ID와 자릿수가 맞는 필드가 없어서, 나중에
   재고 페이지를 만들 때 WING 내부 API 캡처로 다시 조사하기로 함. */
function optionSubtitle(r) {
  const pid = r.sellerProductId ? esc(r.sellerProductId) : '—';
  const vidHtml = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" title="옵션ID — 쿠팡 판매 페이지로 이동" onclick="event.stopPropagation()">${esc(r.vid)}</a>`
    : `<span title="옵션ID">${esc(r.vid)}</span>`;
  return `<div class="psub"><span title="등록상품ID">${pid}</span> · ${vidHtml}</div>`;
}

/* 그 날짜의 상품/옵션 행들을 합산 — 일별 상세표의 같은 날짜 행(확정 정산 또는 추정)과
   나란히 비교하기 쉽게 하려고 둠(사용자 요청, 2026-08-17). 두 표는 애초에 서로 다른
   API에서 나온 값이라(일별 상세표는 계정 전체 합계인 확정 정산 or 옵션별 추정, 이 표는
   상품마다 실제 스냅샷/카테고리 추정을 항목별로 더한 것) 100% 일치를 보장 못 한다 —
   `renderReconcileNote()`가 이미 매출 기준으로 이 구조적 차이를 안내하고 있음, 여기서는
   나머지 항목도 한눈에 비교할 수 있게 보여주기만 한다.

   보관비·부가세는 옵션별 합이 아니다 — confirmedStorage(그 날짜의 확정 고정 보관비,
   없으면 null)를 여기서 한 번만 반영한다: 옵션별 부가세 합에 "고정 보관비의 10%"를
   더하고, 순이익에서도 옵션별 순이익 합에서 고정 보관비와 그 부가세를 추가로 뺀다
   (옵션 행 각각은 보관비 항이 아예 없어서 이렇게 날짜 합계 단계에서만 반영 가능). */
function sumSalesRows(rows, confirmedStorage) {
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const costedRows = rows.filter((r) => r.cost != null);
  const storage = confirmedStorage != null ? confirmedStorage : null;
  const storageVat = storage != null ? Math.round(storage * 0.1) : 0;
  return {
    quantity: sum('quantity'), revenue: sum('revenue'),
    commission: sum('commission'), fulfillment: sum('fulfillment'),
    storage, vat: sum('vat') + storageVat, coupon: sum('coupon'),
    netProfit: sum('netProfit') - (storage || 0) - storageVat,
    operatingProfit: costedRows.length ? costedRows.reduce((s, r) => s + r.operatingProfit, 0) : null
  };
}

function dateGroupHeadHtml(date, rows, confirmedStorage) {
  const s = sumSalesRows(rows, confirmedStorage);
  return `
<tr class="date-group-head">
  <td>${date} (${mdFmt(date)}) <span class="muted xs">${rows.length}건</span></td>
  <td class="col-num" data-label="판매수량">${cnt(s.quantity)}</td>
  <td class="col-num" data-label="매출">${won(s.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(Math.round(s.commission))}</td>
  <td class="col-num" data-label="입출고비">${won(Math.round(s.fulfillment))}</td>
  <td class="col-num" data-label="보관비">${s.storage != null ? won(s.storage) : '<span class="dim">—</span>'}</td>
  <td class="col-num" data-label="부가세">${won(s.vat)}</td>
  <td class="col-num" data-label="광고비"><span class="dim">—</span></td>
  <td class="col-num" data-label="쿠폰비">${won(Math.round(s.coupon))}</td>
  <td class="col-num" data-label="순이익"><span class="${s.netProfit >= 0 ? 'pos' : 'neg'}">${Math.round(s.netProfit).toLocaleString()}원</span></td>
  <td class="col-num" data-label="영업이익">${
    s.operatingProfit != null
      ? `<span class="${s.operatingProfit >= 0 ? 'pos' : 'neg'}">${Math.round(s.operatingProfit).toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>`;
}

function salesRowHtml(r) {
  const name = esc(r.name || '(이름 없음)');
  // 광고비는 계정 전체 합계로만 나와 상품별로 못 구한다(WING 정산현황·재고현황 둘 다 항목
  // 단위 데이터 없음, 2026-08-16 확인) — 나중에 외부 연동이 생기면 채울 자리만 미리 만들어둠.
  const adCell = '<span class="dim" title="상품별 광고비는 아직 연동된 데이터 소스가 없습니다(추후 연동 예정)">—</span>';
  if (r.noCommission) {
    return `
<tr>
  <td>
    <div class="pname"><span>${name}</span></div>
    ${optionSubtitle(r)}
  </td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="입출고비"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="보관비"><span class="dim">—</span></td>
  <td class="col-num" data-label="부가세"><span class="dim">—</span></td>
  <td class="col-num" data-label="광고비">${adCell}</td>
  <td class="col-num" data-label="쿠폰비"><span class="dim">—</span></td>
  <td class="col-num" data-label="순이익"><span class="dim">수수료 정보 없음</span></td>
  <td class="col-num" data-label="영업이익"><span class="dim">수수료 정보 없음</span></td>
</tr>`;
  }
  const est = r.label ? ` <span class="dim xs">${r.label}</span>` : '';
  return `
<tr class="prow">
  <td>
    <div class="pname"><svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><span>${name}</span></div>
    ${optionSubtitle(r)}
  </td>
  <td class="col-num" data-label="판매수량">${cnt(r.quantity)}</td>
  <td class="col-num" data-label="매출">${won(r.revenue)}</td>
  <td class="col-num" data-label="수수료">${won(Math.round(r.commission))}${est}</td>
  <td class="col-num" data-label="입출고비">${won(Math.round(r.fulfillment))}${est}</td>
  <td class="col-num" data-label="보관비"><span class="dim" title="이 옵션 하나에만 귀속되지 않는 재고 전체 기준 비용이라 날짜 합계 행에서만 보여줍니다">—</span></td>
  <td class="col-num" data-label="부가세">${won(r.vat)}</td>
  <td class="col-num" data-label="광고비">${adCell}</td>
  <td class="col-num" data-label="쿠폰비">${won(Math.round(r.coupon))}${est}</td>
  <td class="col-num" data-label="순이익"><span class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${Math.round(r.netProfit).toLocaleString()}원</span></td>
  <td class="col-num" data-label="영업이익">${
    r.operatingProfit != null
      ? `<span class="${r.operatingProfit >= 0 ? 'pos' : 'neg'}">${Math.round(r.operatingProfit).toLocaleString()}원</span>`
      : '<span class="dim">원가 입력 필요</span>'
  }</td>
</tr>
<tr class="detail hidden"><td colspan="11"><div class="detail-inner">
  <div class="kv-grid">
    <div class="kv"><span class="kv-k">이번달 누적보관비</span><span class="kv-v">${r.storageMonthly != null ? won(r.storageMonthly) : '<span class="dim">—</span>'}</span></div>
    <div class="kv"><span class="kv-k">원가</span><span class="kv-v">${r.cost != null ? won(Math.round(r.cost)) : '<span class="dim">원가 입력 필요</span>'}</span></div>
    <div class="kv"><span class="kv-k">배송·작업비</span><span class="kv-v">${r.shipWork != null ? won(Math.round(r.shipWork)) : '<span class="dim">—</span>'}</span></div>
  </div>
</div></td></tr>`;
}

$('#salesRefresh').onclick = loadSales;
$('#salesBackfillBtn').onclick = backfillSales;
$('#itemCostRefreshBtn').onclick = refreshItemCosts;

/* 상품/옵션별 상세표 행 펼치기 — 소싱 탭(.prow/.detail)과 같은 패턴이지만, 필요한
   값을 renderSales()가 이미 다 계산해서 HTML에 심어뒀으므로 추가 조회 없이 보이기만
   전환한다(사용자 요청, 2026-08-16 — 컬럼이 13개라 상품명 칸이 압착되던 문제 해결).
   detail 행은 항상 그 prow 바로 다음 형제로 붙인다(nextElementSibling으로 찾음) —
   날짜별 그룹핑 이후 같은 vendor_item_id가 여러 날짜 섹션에 중복해서 나올 수 있어서
   (2026-08-16 오후) id로 매칭하면 첫 번째 행만 계속 찾게 되는 버그가 생김. */
$('#salesBody').addEventListener('click', (ev) => {
  const row = ev.target.closest('tr.prow');
  if (!row) return;
  const detail = row.nextElementSibling;
  if (!detail || !detail.classList.contains('detail')) return;
  const open = !detail.classList.contains('hidden');
  detail.classList.toggle('hidden', open);
  row.classList.toggle('open', !open);
});
