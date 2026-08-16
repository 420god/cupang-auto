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
