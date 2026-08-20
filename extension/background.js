/* 백그라운드 서비스워커 (MV3).
   목적: 웹(sourcing-web2.vercel.app)이 "반품 포함 판매현황 동기화"를 요청하면,
   WING 내부 API(로그인 세션 기반, HMAC 아님)를 대신 호출해서 Supabase에 올린다.
   공식 Open API(rg/orders)엔 반품 데이터가 없어서 이 경로가 필요함
   (docs/api-notes.md 4-4-1/4-4-2 참조).

   팝업과 별개 컨텍스트이므로 Supabase 인증/업로드는 supabase.js를 그대로 재사용한다
   (importScripts — 로직 중복 금지, web/CLAUDE.md의 "하나로 통일" 원칙과 같은 이유). */
importScripts('supabase.js');

const WING_ORIGIN = 'https://wing.coupang.com';
const MAX_DAYS = 31;

async function waitForTabComplete(tabId, timeoutMs) {
  const t = await chrome.tabs.get(tabId);
  if (t.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('탭 로딩 시간초과'));
    }, timeoutMs || 20000);
    function onUpdated(tId, info) {
      if (tId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function kstDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateRange(fromStr, toStr) {
  const out = [];
  const cur = new Date(fromStr + 'T00:00:00+09:00');
  const end = new Date(toStr + 'T00:00:00+09:00');
  while (cur <= end) {
    out.push(kstDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

async function getOrOpenWingTab() {
  const existing = await chrome.tabs.query({ url: WING_ORIGIN + '/*' });
  if (existing.length) return existing[0];

  const tab = await chrome.tabs.create({ url: WING_ORIGIN + '/', active: false });
  await waitForTabComplete(tab.id);
  return tab;
}

/* 페이지(WING) 컨텍스트에서 실행됨 — 쿠키는 same-origin fetch가 자동으로 붙인다 */
function pageFetchSoldVendorItems(dateStr) {
  return (async () => {
    try {
      const items = [];
      let pageNumber = 0;
      const pageSize = 10; // WING 위젯 자체가 보내는 값 그대로(더 큰 값은 400 남, 실측 확인됨)
      for (let i = 0; i < 20; i++) {
        const res = await fetch('/tenants/rfm-inventory/sales/sold-vendor-item-list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            startDate: { date: dateStr, timeZone: 'Asia/Seoul' },
            endDate: { date: dateStr, timeZone: 'Asia/Seoul' },
            pageNumber, pageSize, sortBy: 'GMV', sortOrder: 'DESC'
          })
        });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch (e) { return { ok: false, notLoggedIn: true }; }
        if (!res.ok || !body || !Array.isArray(body.soldVendorItems)) {
          return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
        }
        items.push(...body.soldVendorItems);
        const totalPages = (body.pagination && body.pagination.totalPages) || 1;
        pageNumber++;
        if (pageNumber >= totalPages) break;
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })();
}

/* 페이지(WING) 컨텍스트에서 실행됨. dateStr(KST 'YYYY-MM-DD') 하루치 확정 정산 조회.
   session 쿠키만으론 부족하고 x-xsrf-token 헤더가 필수다(쿠키 XSRF-TOKEN 값을
   그대로 echo하는 CSRF 이중제출 패턴, 실측 확인) — 이게 없으면 서버가
   helpseller.coupang.com/access/logout으로 리다이렉트시키고, 그 리다이렉트가
   CORS 없이 오다 보니 그냥 "Failed to fetch"로만 보였다(docs/api-notes.md 4-4-4).
   쿠키는 페이지 컨텍스트에서만 읽을 수 있어서(document.cookie) 백그라운드에서
   직접 fetch하는 방식(더 간단해 보였던)은 포기하고 페이지 주입으로 되돌아왔다.
   recognitionDateFrom/To는 둘 다 "(dateStr-1)일 T15:00:00.000Z"로 같은 값을 넣는다
   (2026-08-15, WING 정산현황 위젯에서 하루만 선택했을 때 실제로 보내는 요청을 캡처해서
   확인 — 처음엔 "전날 T15:00Z ~ 당일 T15:00Z"로 반나절 뒤 값을 recognitionDateTo에
   넣었었는데, 그러면 다음날 데이터까지 같이 잡혀서 하루치 조회가 이틀치로 부풀었다.
   원인 추정: 서버가 두 타임스탬프를 KST 캘린더 날짜로 변환해서 그 날짜 범위를
   inclusive하게 조회하는 것으로 보이는데, "당일 T15:00Z"는 KST로 변환하면 이미
   다음날 00:00:00 정각이라 다음날 날짜로 잡혀버림. recognitionDateTo를
   recognitionDateFrom과 완전히 같은 값으로 맞추면(둘 다 "dateStr일 KST 00:00 정각"에
   해당하는 UTC 시각) 그 날짜 하나만 잡힌다 — WING 자체 프론트가 쓰는 방식 그대로.
   자세한 발견 경위는 docs/api-notes.md 4-4-5. */
function pageFetchProfitStatus(dateStr) {
  return (async () => {
    try {
      function getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
      }
      const xsrfToken = getCookie('XSRF-TOKEN');

      const d = new Date(dateStr + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      const fromDateStr = d.toISOString().slice(0, 10);

      const headers = { 'content-type': 'application/json' };
      if (xsrfToken) headers['x-xsrf-token'] = xsrfToken;

      const res = await fetch('/tenants/rfm/v2/settlements/profit-status/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          recognitionDateFrom: `${fromDateStr}T15:00:00.000Z`,
          recognitionDateTo: `${fromDateStr}T15:00:00.000Z`
        })
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { return { ok: false, notLoggedIn: true }; }
      if (!res.ok || typeof json.profitAmount === 'undefined') {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })();
}

/* 페이지(WING) 컨텍스트에서 실행됨 — 재고현황의 상품별 실제 개당 수수료/입출고비/보관비
   조회(docs/api-notes.md 4-4-6). pageSize는 WING 프론트가 실제 보내는 값(10) 그대로 —
   더 크게 하면 거부당할 수 있어 임의로 늘리지 말 것(절대 바꾸지 말 것 규칙 1과 같은 이유).
   searchAfterSortValues는 이전 응답의 paginationResponse에서 그대로 이어받는 커서. */
function pageFetchInventoryHealth(pageNumber, searchAfterSortValues) {
  return (async () => {
    try {
      function getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
      }
      const xsrfToken = getCookie('XSRF-TOKEN');
      const headers = { 'content-type': 'application/json' };
      if (xsrfToken) headers['x-xsrf-token'] = xsrfToken;

      const res = await fetch('/tenants/rfm-inventory/inventory-health-dashboard/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          paginationRequest: { pageSize: 10, pageNumber, searchAfterSortValues: searchAfterSortValues || null },
          hiddenStatus: 'VISIBLE',
          sort: [{ sortParameter: 'ORDERABLE_QUANTITY', sortDirection: 'DESCENDING' }],
          rrqContext: { source: 'IHD', eventType: 'RRQ_SEEN', metadata: '{}' }
        })
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { return { ok: false, notLoggedIn: true }; }
      if (!res.ok || !Array.isArray(json.viProperties)) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })();
}

/* 전체 상품을 페이지당 10개씩 끝까지 순회해서 상품별 실제 원가정보를 스냅샷으로 쌓는다
   (덮어쓰지 않음 — db/migrations/012 참조, 가격 변경 전/후 요율을 둘 다 남겨야 해서).
   상품이 수백 개가 되면 그만큼 오래 걸린다 — MAX_ITEM_COST_PAGES는 안전장치일 뿐 정상
   범위에선 totalNumberOfElements를 다 채우면 그 전에 루프가 끝난다. */
const MAX_ITEM_COST_PAGES = 60; // pageSize 10 기준 최대 600개 상품까지 커버

async function syncItemCosts(tab) {
  const rows = [];
  const capturedAt = new Date().toISOString();
  let pageNumber = 0;
  let cursor = null;

  for (let i = 0; i < MAX_ITEM_COST_PAGES; i++) {
    const r = await execWithRetry(tab.id, pageFetchInventoryHealth, [pageNumber, cursor]);
    if (!r || !r.ok) {
      if (r && r.notLoggedIn) {
        throw new Error('WING 로그인이 필요합니다. WING 탭에서 로그인한 뒤 다시 시도하세요.');
      }
      throw new Error((r && r.error) || '상품 원가정보 조회 실패');
    }
    const d = r.data;
    (d.viProperties || []).forEach((vi) => {
      const ss = vi.settlementStatistics || {};
      const inv = vi.inventoryDetails || {};
      const pr2 = vi.pricing || {};
      rows.push({
        vendor_item_id: String(vi.vendorItemId),
        captured_at: capturedAt,
        commission_amount: Math.round(Number(ss.takeRateAmount && ss.takeRateAmount.amount) || 0),
        fulfillment_amount: Math.round(
          (Number(ss.fulfillmentFee && ss.fulfillmentFee.amount) || 0) +
          (Number(ss.warehousingFee && ss.warehousingFee.amount) || 0)
        ),
        monthly_storage_fee_amount: Math.round(
          Number(inv.storageFee && inv.storageFee.monthlyStorageFeeAmount && inv.storageFee.monthlyStorageFeeAmount.amount) || 0
        ),
        // 판매자 부담 쿠폰(개당) — 확정 정산의 totalSellerInstantDiscountAmount+
        // totalSellerDownloadDiscountAmount와 같은 개념·명명 규칙(docs/api-notes.md 4-4-6).
        coupon_amount: Math.round(
          (Number(pr2.allMemberInstantDiscount && pr2.allMemberInstantDiscount.amount) || 0) +
          (Number(pr2.allMemberDownloadableDiscount && pr2.allMemberDownloadableDiscount.amount) || 0)
        ),
        trigger_source: 'manual_refresh'
      });
    });

    const pr = d.paginationResponse || {};
    const total = pr.totalNumberOfElements || 0;
    const nextCursor = pr.searchAfterSortValues;
    if (!nextCursor || rows.length >= total || !d.viProperties || d.viProperties.length === 0) break;
    cursor = nextCursor;
    pageNumber++;
  }

  if (rows.length) await sbInsertIgnore('rocket_growth_item_cost_snapshots', rows);
  return { rowCount: rows.length };
}

async function syncSalesForDates(tab, dates) {
  const rows = [];
  const failed = [];
  for (const dateStr of dates) {
    const r = await execWithRetry(tab.id, pageFetchSoldVendorItems, [dateStr]);
    if (!r || !r.ok) {
      if (r && r.notLoggedIn) {
        throw new Error('WING 로그인이 필요합니다. WING 탭에서 로그인한 뒤 다시 시도하세요.');
      }
      failed.push({ date: dateStr, error: (r && r.error) || '알 수 없음' });
      continue; // 하루 실패는 건너뛰고 나머지는 계속(전체를 막지 않음)
    }
    r.items.forEach((it) => {
      rows.push({
        sale_date: dateStr,
        vendor_item_id: String(it.vendorItemId),
        product_id: it.productId != null ? String(it.productId) : null,
        product_name: [it.vendorInventoryName, it.vendorInventoryItemName].filter(Boolean).join(' '),
        quantity: it.unitsSold,
        revenue: Math.round(Number((it.gmv && it.gmv.amount) || 0))
      });
    });
  }
  if (rows.length) await sbUpsert('rocket_growth_sales_wing_daily', rows, 'sale_date,vendor_item_id');
  return { rowCount: rows.length, failed };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* 판매/정산 조회 공용 — 실제 앱이 iframe 안에 떠 있을 수 있어(popup.js의 다른
   캡처들도 전부 allFrames:true를 쓴다) 모든 프레임에 주입하고, 그중 성공
   (ok:true)한 프레임의 결과를 쓴다. executeScript 자체가 실패하면(예: 탭이 막
   리로드 중이라 "Frame with ID N was removed") 잠깐 쉬었다가 한 번 재시도한다. */
async function execWithRetry(tabId, func, args) {
  let injected;
  try {
    injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  } catch (e) {
    await sleep(1500);
    injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  }
  const results = (injected || []).map((fr) => fr && fr.result).filter(Boolean);
  return results.find((r) => r.ok) || results[0] || null;
}

async function syncProfitForDates(tab, dates) {
  const rows = [];
  const failed = [];
  for (const dateStr of dates) {
    const r = await execWithRetry(tab.id, pageFetchProfitStatus, [dateStr]);
    if (!r || !r.ok) {
      if (r && r.notLoggedIn) {
        throw new Error('WING 로그인이 필요합니다. WING 탭에서 로그인한 뒤 다시 시도하세요.');
      }
      const reason = (r && r.error) || '알 수 없음';
      console.warn(`[정산 동기화] ${dateStr} 건너뜀 — 원인: ${reason}`);
      failed.push({ date: dateStr, error: reason });
      continue; // 정산 미확정(D-1 지연 등)일 수 있으니 실패해도 건너뛰고 계속
    }
    const d = r.data;
    const det = d.profitStatusDeductionDetail || {};
    // WING이 아직 그 날짜를 인식 안 했을 때도 HTTP 200 + profitAmount:0인 "빈" 응답을
    // 준다(필드는 다 있지만 전부 0) — 주로 당일(정산 인식 D-1 지연) 자정 직후 자동
    // 동기화에서 겪음(2026-08-16 실사용 중 발견: totalSalesAmount/totalDeductionAmount
    // 둘 다 0인 행이 그대로 저장돼 웹의 buildDailyRow()가 이걸 "확정"으로 믿고 실제
    // 판매(수량 2건)가 있는데도 매출·수수료·순이익을 전부 0으로 덮어썼다). 이 신호를
    // 실패와 동일하게 취급해 저장을 건너뛴다 — 실제 0원 정산일도 있을 수 있지만, 그런
    // 날은 애초에 판매 자체가 없어 웹의 옵션별 추정 폴백도 똑같이 0을 보여주므로
    // 안전하다.
    if (!Number(d.totalSalesAmount) && !Number(d.totalDeductionAmount)) {
      console.warn(`[정산 동기화] ${dateStr} 건너뜀 — 원인: 정산 미인식(빈 응답)`);
      failed.push({ date: dateStr, error: '정산 미인식(D-1 지연 등)' });
      continue;
    }
    rows.push({
      sale_date: dateStr,
      total_sales_amount: Math.round(Number(d.totalSalesAmount) || 0),
      total_refunded_sales_amount: Math.round(Number(d.totalRefundedSalesAmount) || 0),
      net_sales_amount: Math.round(Number(d.totalSalesAmountWithRefund) || 0),
      total_deduction_amount: Math.round(Number(d.totalDeductionAmount) || 0),
      commission_amount: Math.round(Number(det.totalTakeRateAmountWithVat) || 0),
      fulfillment_amount: Math.round(Number(det.totalCfsAmountWithVat) || 0),
      storage_amount: Math.round(Number(det.totalStorageFeeAmount) || 0),
      coupon_amount: Math.round(Number(det.totalSellerDiscountAmount) || 0),
      ad_amount: Math.round(Number(det.totalAdDeduction) || 0),
      milkrun_amount: Math.round(Number(det.totalMilkrunDeduction) || 0),
      profit_amount: Math.round(Number(d.profitAmount) || 0),
      profit_to_sales_ratio: d.profitToSalesRatio != null ? Number(d.profitToSalesRatio) : null
    });
  }
  if (rows.length) await sbUpsert('rocket_growth_profit_daily', rows, 'sale_date');
  return { rowCount: rows.length, failed };
}

/* 실패 목록을 응답에 그대로 실어서(2026-08-15 추가) 화면에서 바로 원인을 볼 수 있게 한다 —
   전에는 console.warn으로만 남아서 사용자가 개발자도구를 열어야만 왜 특정 날짜가
   안 채워졌는지 알 수 있었다(실사용 중 "백필해도 계속 안 맞는다"는 혼란의 원인이었음). */
async function syncSales(dateFrom, dateTo) {
  const dates = dateRange(dateFrom, dateTo);
  if (!dates.length) throw new Error('날짜 범위가 올바르지 않습니다.');
  if (dates.length > MAX_DAYS) throw new Error(`범위가 너무 넓습니다(최대 ${MAX_DAYS}일).`);

  const tab = await getOrOpenWingTab();

  await sbLoadConfig();
  if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 확장프로그램 팝업에서 먼저 로그인하세요.');

  const salesResult = await syncSalesForDates(tab, dates);

  // 실패해도(정산 미확정 등) 판매 동기화 결과는 그대로 반환한다.
  let profitRowCount = 0;
  let profitFailed = [];
  try {
    const profitResult = await syncProfitForDates(tab, dates);
    profitRowCount = profitResult.rowCount;
    profitFailed = profitResult.failed;
  } catch (e) {
    console.warn('[정산 동기화] 전체 실패, 판매 동기화 결과만 반환:', e && e.message);
    profitFailed = dates.map((d) => ({ date: d, error: (e && e.message) || '전체 실패' }));
  }

  return {
    days: dates.length, rowCount: salesResult.rowCount, profitRowCount,
    salesFailed: salesResult.failed, profitFailed
  };
}

/* 팝업(같은 확장프로그램)에서 부르는 통로. onMessageExternal 은 웹 전용이라
   팝업 메시지는 안 받는다 — 둘이 다른 리스너다. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'SYNC_METRICS') return false;
  (async () => {
    try {
      await sbLoadConfig();
      if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 팝업에서 먼저 로그인하세요.');
      const r = await syncMetricsBackfill(message.days || 14);
      sendResponse({ ok: true, result: r });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  })();
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'SYNC_SALES') {
    (async () => {
      try {
        const result = await syncSales(message.dateFrom, message.dateTo);
        sendResponse({
          ok: true, days: result.days, rowCount: result.rowCount, profitRowCount: result.profitRowCount,
          salesFailed: result.salesFailed, profitFailed: result.profitFailed
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true; // sendResponse를 비동기로 나중에 호출하겠다는 표시
  }

  /* 웹 대시보드가 열릴 때 부른다 — 이게 "자동"의 실질이다.
     확장프로그램은 브라우저가 켜져 있을 때만 도니까, 사람이 화면을 여는 순간을
     동기화 시점으로 삼는다. 이미 받은 날짜는 건너뛰므로 여러 번 불려도 싸다. */
  if (message.type === 'SYNC_METRICS') {
    (async () => {
      try {
        await sbLoadConfig();
        if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 확장프로그램 팝업에서 먼저 로그인하세요.');
        const r = await syncMetricsBackfill(message.days || 14);
        sendResponse({ ok: true, result: r });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'SYNC_ITEM_COSTS') {
    (async () => {
      try {
        const tab = await getOrOpenWingTab();
        await sbLoadConfig();
        if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 확장프로그램 팝업에서 먼저 로그인하세요.');
        const result = await syncItemCosts(tab);
        sendResponse({ ok: true, rowCount: result.rowCount });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true;
  }

  return false;
});

/* ===================== 비즈니스 인사이트 지표 동기화 =====================
   WING 판매분석 화면이 쓰는 API를 그대로 부른다(2026-08-20 실물 캡처로 확인,
   docs/api/wing-internal.md). **엑셀을 받아 파싱하지 않는다** — 화면이 이미
   JSON을 받고 있어서 엑셀은 그걸 포장한 결과일 뿐이다.

   왜 확장프로그램인가: WING은 로그인 세션 기반이라 VPS가 못 부른다.
   순매출·확정정산·재고현황과 같은 이유이고, 이게 네 번째다.

   당일 데이터는 다음날 밤에 채워진다(사용자 확인) — 그래서 **어제까지만** 받는다. */

const INSIGHT_BASE = '/tenants/rfm-ss/api';

/* 페이지 컨텍스트에서 실행됨. 하루치 옵션별 지표를 **끝까지** 받는다.
   pageSize는 화면이 쓰는 20 그대로 둔다 — 이 저장소엔 이미 교훈이 있다.
   sold-vendor-item-list에서 pageSize를 키웠다가 400이 났다(실측). 미검증 변형은
   만들지 않는다(R-14). 대신 pageNumber를 올려가며 전부 받는다. */
function pageFetchInsightItems(dateStr) {
  return (async () => {
    try {
      /* **세션 쿠키만으론 부족한 엔드포인트가 있다.** profit-status/search 가 그랬고,
         그때 증상은 "Failed to fetch" 뿐이라 원인을 한참 못 찾았다
         (docs/api/wing-internal.md 함정 1). XSRF-TOKEN 쿠키를 헤더로 되돌려주는
         CSRF 이중제출 패턴이다. 쿠키는 페이지 컨텍스트에서만 읽힌다.
         필요 없는 엔드포인트에 붙여도 무해하므로 기본으로 넣는다. */
      function insightHeaders() {
        const h = { 'content-type': 'application/json', 'accept': 'application/json, text/plain, */*',
                    'x-cp-pt-locale': 'ko' };
        const m = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
        if (m) h['x-xsrf-token'] = decodeURIComponent(m[1]);
        return h;
      }
      const out = [];
      let pages = 0;
      for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
        const res = await fetch('/tenants/rfm-ss/api/business-insight/vi-detail-search', {
          method: 'POST', credentials: 'include',
          headers: insightHeaders(),
          body: JSON.stringify({
            startDate: dateStr, endDate: dateStr,          // 같은 날 = 하루치
            registrationTypes: ['NORMAL', 'RFM'],          // 판매자배송 + 로켓그로스
            pageNumber, pageSize: 20,
            sortBy: 'GMV', sortOrder: 'DESC', includeSoldVICount: true
          })
        });
        const text = await res.text();
        let body;
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
        try { body = JSON.parse(text); }
        catch (e) {
          /* JSON이 아니면 로그인 리다이렉트(HTML)일 가능성이 크지만 단정하지 않는다.
             본문 앞부분을 같이 돌려줘야 원인을 알 수 있다. */
          return { ok: false, error: `JSON이 아닌 응답 (HTTP ${res.status}): ${text.slice(0, 300)}` };
        }
        const list = (body && body.vendorItems) || [];
        pages++;
        out.push(...list);
        /* 총 페이지 수를 주는 필드를 못 봤다(응답 앞부분만 캡처됨). 그래서
           **빈 페이지가 오면 끝난 것으로 본다** — 총계 필드를 추측하는 것보다 안전하다. */
        if (list.length < 20) break;
      }
      return { ok: true, items: out, pages };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })();
}

/* 유입경로. **판매자 전체 단위다**(요청에 vendorItemIds가 없다).
   옵션별 인과는 못 가르지만 "그날 광고 유입이 있었나"는 확실히 알 수 있고,
   그게 없으면 광고 효과를 썸네일 효과로 오독한다. */
function pageFetchInsightTraffic(dateStr) {
  return (async () => {
    try {
      /* **세션 쿠키만으론 부족한 엔드포인트가 있다.** profit-status/search 가 그랬고,
         그때 증상은 "Failed to fetch" 뿐이라 원인을 한참 못 찾았다
         (docs/api/wing-internal.md 함정 1). XSRF-TOKEN 쿠키를 헤더로 되돌려주는
         CSRF 이중제출 패턴이다. 쿠키는 페이지 컨텍스트에서만 읽힌다.
         필요 없는 엔드포인트에 붙여도 무해하므로 기본으로 넣는다. */
      function insightHeaders() {
        const h = { 'content-type': 'application/json', 'accept': 'application/json, text/plain, */*',
                    'x-cp-pt-locale': 'ko' };
        const m = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
        if (m) h['x-xsrf-token'] = decodeURIComponent(m[1]);
        return h;
      }
      const res = await fetch(
        '/tenants/rfm-ss/api/traffic-insight/distribution/summary/without-subscription?withVariance=true', {
          method: 'POST', credentials: 'include',
          headers: insightHeaders(),
          body: JSON.stringify({
            startDate: dateStr, endDate: dateStr,
            metrics: ['unit_sold_contribution'],
            trafficSources: ['search', 'recommendation', 'promotion', 'product_list_pages',
                             'mycoupang', 'brandstore', 'live', 'other', 'ADS'],
            registrationTypes: ['NORMAL', 'RFM'],
            isRecentlyListed: false
          })
        });
      const text = await res.text();
      let body;
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
      try { body = JSON.parse(text); }
      catch (e) { return { ok: false, error: `JSON이 아닌 응답: ${text.slice(0, 300)}` }; }
      return { ok: true, rows: Array.isArray(body) ? body : [] };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  })();
}

/* 옵션별 광고 캠페인 상태. 화면의 "광고 중지" 배지가 여기서 온다.
   한 번에 20개씩 보내는 걸 캡처했으므로 그 크기를 지킨다. */
function pageFetchAdStatus(vendorItemIds) {
  return (async () => {
    try {
      /* **세션 쿠키만으론 부족한 엔드포인트가 있다.** profit-status/search 가 그랬고,
         그때 증상은 "Failed to fetch" 뿐이라 원인을 한참 못 찾았다
         (docs/api/wing-internal.md 함정 1). XSRF-TOKEN 쿠키를 헤더로 되돌려주는
         CSRF 이중제출 패턴이다. 쿠키는 페이지 컨텍스트에서만 읽힌다.
         필요 없는 엔드포인트에 붙여도 무해하므로 기본으로 넣는다. */
      function insightHeaders() {
        const h = { 'content-type': 'application/json', 'accept': 'application/json, text/plain, */*',
                    'x-cp-pt-locale': 'ko' };
        const m = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
        if (m) h['x-xsrf-token'] = decodeURIComponent(m[1]);
        return h;
      }
      const out = {};
      for (let i = 0; i < vendorItemIds.length; i += 20) {
        const chunk = vendorItemIds.slice(i, i + 20);
        const res = await fetch('/tenants/cmg-wing-card/wing/one-click-setup/condition', {
          method: 'POST', credentials: 'include',
          headers: insightHeaders(),
          body: JSON.stringify({
            type: 'WING_SALES_ANALYSIS_CAMPAIGN_STATUS',
            items: chunk.map((id) => ({ vendorItemId: Number(id) }))
          })
        });
        if (!res.ok) continue;               // 광고 상태는 부가 정보다. 실패해도 지표는 넣는다
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch (e) { continue; }
        (Array.isArray(body) ? body : []).forEach((r) => {
          const ex = r.extra || {};
          out[String(r.vendorItemId)] = {
            status: ex.representingCampaignServingStatus || null,
            count: ex.campaignCount == null ? null : Number(ex.campaignCount)
          };
        });
      }
      return { ok: true, byItem: out };
    } catch (e) {
      return { ok: true, byItem: {} };       // 여기 실패로 전체를 멈추지 않는다
    }
  })();
}

/* 하루치를 받아 Supabase에 넣는다. 이 함수가 동기화의 본체다. */
async function syncMetricsForDate(dateStr) {
  const tab = await getOrOpenWingTab();

  const itemsRes = await execWithRetry(tab.id, pageFetchInsightItems, [dateStr]);
  if (!itemsRes || !itemsRes.ok) {
    throw new Error(`옵션 지표 조회 실패: ${(itemsRes && itemsRes.error)
      || '응답 없음 (WING 탭에 주입이 안 됐을 수 있습니다 — 로그인 상태를 확인하세요)'}`);
  }

  const vids = itemsRes.items
    .map((x) => x.vendorItemDetails && x.vendorItemDetails.vendorItemId)
    .filter(Boolean).map(String);
  const adRes = await execWithRetry(tab.id, pageFetchAdStatus, [vids]);
  const adBy = (adRes && adRes.byItem) || {};

  /* 응답 → 우리 표. **단위를 여기서 통일한다** — pvToOrder는 비율(0.0171)이고
     엑셀의 "1.71%"와 다르다. 원본 그대로 담고 화면에서 곱한다(db/migrations/027). */
  const itemRows = itemsRes.items.map((x) => {
    const d = x.vendorItemDetails || {};
    const m = x.businessInsightsMetricsResponse || {};
    const ad = adBy[String(d.vendorItemId)] || {};
    const n = (v) => (v == null ? null : Number(v));
    const i = (v) => (v == null ? null : Math.round(Number(v)));
    return {
      metric_date: dateStr,
      vendor_item_id: String(d.vendorItemId),
      seller_product_id: d.inventoryId == null ? null : String(d.inventoryId),
      item_name: d.itemName || null,
      product_name: d.productName || null,
      category: Array.isArray(d.categoryPath) ? d.categoryPath[d.categoryPath.length - 1] : null,
      category_path: Array.isArray(d.categoryPath) ? d.categoryPath.join(' > ') : null,
      sales_method: d.registrationType === 'RFM' ? '로켓그로스' : '판매자배송',
      registration_type: d.registrationType || null,

      revenue: i(m.totalGmv),
      orders: i(m.totalOrders),
      sold_qty: i(m.totalUnitsSold),
      visitors: i(m.totalUniqueVisitor),
      views: i(m.totalPageViews),
      cart_adds: i(m.totalAddToCart),
      conversion_rate: n(m.pvToOrder),        // 비율 그대로

      search_volume: n(m.searchVolume),
      srp_click: n(m.srpClick),
      srp_click_share: n(m.srpClickShare),

      is_item_winner: d.isItemWinner == null ? null : !!d.isItemWinner,
      is_oos: d.isOOS == null ? null : !!d.isOOS,
      has_badge: d.hasBadge == null ? null : !!d.hasBadge,
      rating_count: i(d.ratingCount),
      rating_review: n(d.ratingReview),
      image_path: d.imagePath || null,

      ad_campaign_status: ad.status || null,
      ad_campaign_count: ad.count == null ? null : ad.count,

      raw: x
    };
  });

  const trafRes = await execWithRetry(tab.id, pageFetchInsightTraffic, [dateStr]);
  const trafficRows = ((trafRes && trafRes.rows) || []).map((t) => ({
    metric_date: dateStr,
    traffic_source: t.trafficSourceName,
    traffic_group: t.trafficSourceGroup || null,
    registration_types: 'NORMAL,RFM',
    impression: t.impression == null ? null : Math.round(t.impression),
    glance_views: t.glanceViews == null ? null : Math.round(t.glanceViews),
    add_to_cart: t.addToCart == null ? null : Math.round(t.addToCart),
    orders: t.order == null ? null : Math.round(t.order),
    units_sold: t.unitSold == null ? null : Math.round(t.unitSold),
    gmv: t.gmv == null ? null : Math.round(t.gmv),
    conversion_rate: t.conversionRate == null ? null : Number(t.conversionRate),
    glance_views_mix: t.glanceViewsMixPercentage == null ? null : Number(t.glanceViewsMixPercentage),
    unit_sold_contrib: t.unitSoldContributionPercentage == null ? null : Number(t.unitSoldContributionPercentage),
    raw: t
  }));

  /* 같은 날짜를 다시 받으면 덮어쓴다 — 쿠팡이 나중에 값을 보정하는 경우가 있어서
     최신값이 이기는 게 맞다(확정 정산에서 이미 겪은 패턴). */
  if (itemRows.length) await sbUpsert('coupang_item_metrics_daily', itemRows, 'metric_date,vendor_item_id');
  if (trafficRows.length) await sbUpsert('coupang_traffic_daily', trafficRows, 'metric_date,traffic_source');
  await sbUpsert('coupang_metrics_sync_log', [{
    metric_date: dateStr,
    synced_at: new Date().toISOString(),
    item_rows: itemRows.length,
    traffic_rows: trafficRows.length,
    pages: itemsRes.pages || null,
    note: trafRes && trafRes.ok ? null : '유입경로 조회 실패'
  }], 'metric_date');

  return { date: dateStr, items: itemRows.length, traffic: trafficRows.length, pages: itemsRes.pages };
}

/* **빠진 날을 메운다.** 확장프로그램은 브라우저가 켜져 있을 때만 도니까 구멍이 생긴다.
   이미 받은 날짜를 로그에서 확인하고 없는 날만 받는다 — 그래서 며칠 WING을 안 열어도
   다음에 열면 밀린 게 다 들어온다.
   **오늘은 안 받는다** — 당일 데이터는 다음날 밤에 채워진다(사용자 확인). */
async function syncMetricsBackfill(maxDays) {
  const days = [];
  for (let i = 1; i <= (maxDays || 14); i++) days.push(kstDateStr(new Date(Date.now() - i * 86400000)));

  let have = {};
  try {
    const rows = await sbRequest(
      `coupang_metrics_sync_log?select=metric_date&metric_date=in.(${days.join(',')})`);
    (rows || []).forEach((r) => { have[r.metric_date] = 1; });
  } catch (e) { /* 로그를 못 읽으면 전부 다시 받는다 — 덮어쓰기라 안전하다 */ }

  const todo = days.filter((d) => !have[d]).sort();   // 오래된 날부터
  const done = [];
  for (const d of todo) {
    try {
      done.push(await syncMetricsForDate(d));
    } catch (e) {
      /* 실패해도 **같은 모양**으로 돌려준다. skipped 를 빼먹었더니 팝업이
         "받을 게 없음" 분기로 빠져서 진짜 실패 이유를 감췄다(2026-08-20 실제로 겪음). */
      return { done, todo: todo.length, skipped: days.length - todo.length,
               stoppedAt: d, error: e.message };
    }
    await new Promise((r) => setTimeout(r, 800));     // WING에 몰아치지 않는다
  }
  return { done, todo: todo.length, skipped: days.length - todo.length };
}
