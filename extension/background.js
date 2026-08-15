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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('WING 탭 로딩 시간초과'));
    }, 20000);
    function onUpdated(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
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
   recognitionDateFrom/To는 UTC "T15:00:00.000Z"가 KST 자정 경계다(실측 확인,
   docs/api-notes.md 4-4-4) — dateStr 하루를 감싸려면 전날 T15:00Z ~ 당일 T15:00Z. */
function pageFetchProfitStatus(dateStr) {
  return (async () => {
    try {
      const d = new Date(dateStr + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      const fromDateStr = d.toISOString().slice(0, 10);

      const res = await fetch('/tenants/rfm/v2/settlements/profit-status/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recognitionDateFrom: `${fromDateStr}T15:00:00.000Z`,
          recognitionDateTo: `${dateStr}T15:00:00.000Z`
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

async function syncSalesForDates(tab, dates) {
  const rows = [];
  for (const dateStr of dates) {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFetchSoldVendorItems,
      args: [dateStr]
    });
    const r = injected && injected[0] && injected[0].result;
    if (!r || !r.ok) {
      if (r && r.notLoggedIn) {
        throw new Error('WING 로그인이 필요합니다. WING 탭에서 로그인한 뒤 다시 시도하세요.');
      }
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
  return { rowCount: rows.length };
}

async function syncProfitForDates(tab, dates) {
  const rows = [];
  for (const dateStr of dates) {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFetchProfitStatus,
      args: [dateStr]
    });
    const r = injected && injected[0] && injected[0].result;
    if (!r || !r.ok) {
      if (r && r.notLoggedIn) {
        throw new Error('WING 로그인이 필요합니다. WING 탭에서 로그인한 뒤 다시 시도하세요.');
      }
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
      coupon_amount: Math.round(Number(det.totalSellerDiscountAmount) || 0),
      ad_amount: Math.round(Number(det.totalAdDeduction) || 0),
      milkrun_amount: Math.round(Number(det.totalMilkrunDeduction) || 0),
      profit_amount: Math.round(Number(d.profitAmount) || 0),
      profit_to_sales_ratio: d.profitToSalesRatio != null ? Number(d.profitToSalesRatio) : null
    });
  }
  if (rows.length) await sbUpsert('rocket_growth_profit_daily', rows, 'sale_date');
  return { rowCount: rows.length };
}

async function syncSales(dateFrom, dateTo) {
  const dates = dateRange(dateFrom, dateTo);
  if (!dates.length) throw new Error('날짜 범위가 올바르지 않습니다.');
  if (dates.length > MAX_DAYS) throw new Error(`범위가 너무 넓습니다(최대 ${MAX_DAYS}일).`);

  const tab = await getOrOpenWingTab();

  await sbLoadConfig();
  if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 확장프로그램 팝업에서 먼저 로그인하세요.');

  const salesResult = await syncSalesForDates(tab, dates);
  const profitResult = await syncProfitForDates(tab, dates);

  return { days: dates.length, rowCount: salesResult.rowCount, profitRowCount: profitResult.rowCount };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'SYNC_SALES') return false;
  (async () => {
    try {
      const result = await syncSales(message.dateFrom, message.dateTo);
      sendResponse({
        ok: true, days: result.days, rowCount: result.rowCount, profitRowCount: result.profitRowCount
      });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  })();
  return true; // sendResponse를 비동기로 나중에 호출하겠다는 표시
});
