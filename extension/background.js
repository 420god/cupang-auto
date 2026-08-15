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
      const pageSize = 100;
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
          return { ok: false, error: 'HTTP ' + res.status };
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

async function syncSales(dateFrom, dateTo) {
  const dates = dateRange(dateFrom, dateTo);
  if (!dates.length) throw new Error('날짜 범위가 올바르지 않습니다.');
  if (dates.length > MAX_DAYS) throw new Error(`범위가 너무 넓습니다(최대 ${MAX_DAYS}일).`);

  const tab = await getOrOpenWingTab();

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
      throw new Error(`판매현황 조회 실패(${dateStr}): ${(r && r.error) || '알 수 없는 오류'}`);
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

  await sbLoadConfig();
  if (!sbConfigured()) throw new Error('Supabase 설정이 없습니다. 확장프로그램 팝업에서 먼저 로그인하세요.');
  await sbUpsert('rocket_growth_sales_wing_daily', rows, 'sale_date,vendor_item_id');

  return { days: dates.length, rowCount: rows.length };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'SYNC_SALES') return false;
  (async () => {
    try {
      const result = await syncSales(message.dateFrom, message.dateTo);
      sendResponse({ ok: true, days: result.days, rowCount: result.rowCount });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  })();
  return true; // sendResponse를 비동기로 나중에 호출하겠다는 표시
});
