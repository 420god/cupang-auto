// 페이지와 같은 JS 컨텍스트(MAIN world)에서 실행됩니다.
// 목적 1: trends/search 요청의 바디/헤더를 그대로 캡처 (구조를 추측하지 않기 위함)
// 목적 2: 모든 wing.coupang.com 요청을 기록하고, 카테고리로 보이는 응답은 본문까지 저장
(function () {
  try { window.__cwc_installed = true; } catch (e) {}
  const SEARCH_PATH = '/tenants/rfm-ss/api/trends/search';

  /* 요금(입출고비) 관련 API — 요청 바디와 응답을 함께 저장 */
  const FEE_PATHS = [
    '/tenants/rfm/accounting-fee/category/search',
    '/tenants/rfm/accounting-fee/revamp/warehousing-and-fulfillment-fee',
    '/tenants/rfm/accounting-fee/revamp/warehousing-fee',
    '/tenants/rfm/accounting-fee/revamp/fulfillment-fee',
    '/tenants/rfm/accounting-fee/lowasp/warehousing-and-fulfillment-fee',
    '/tenants/rfm/accounting-fee/lowasp/warehousing-fee',
    '/tenants/rfm/accounting-fee/lowasp/fulfillment-fee',
    '/tenants/rfm/accounting-fee/lowasp/policy-label',
    '/tenants/rfm/api/product/meta/category/',
    '/tenants/rfm/api/cms/categories'
  ];
  const K_FEE = '__cwc_fee_captures';

  function feePathOf(url) {
    const u = String(url || '');
    for (const p of FEE_PATHS) {
      if (u.indexOf(p) !== -1) return p;
    }
    return null;
  }

  function saveFeeCapture(url, method, reqBody, resText, headers) {
    try {
      const p = feePathOf(url);
      if (!p) return;

      let store = {};
      try { store = JSON.parse(ss(K_FEE) || '{}') || {}; } catch (e) { store = {}; }

      // meta/category/{code} 는 코드별로 따로 보관
      const key = (p === '/tenants/rfm/api/product/meta/category/')
        ? String(url).split('?')[0]
        : p;

      store[key] = {
        url: String(url).slice(0, 300),
        method: method,
        reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 4000) : null,
        headers: headers || null,
        resText: typeof resText === 'string' ? resText.slice(0, 300000) : null,
        at: Date.now()
      };

      if (!ssSet(K_FEE, JSON.stringify(store))) {
        // 용량 초과 시 응답 본문을 비우고 재시도
        Object.keys(store).forEach((k) => { if (store[k].resText) store[k].resText = store[k].resText.slice(0, 40000); });
        ssSet(K_FEE, JSON.stringify(store));
      }
      console.log('[수집기] 요금 API 캡처: ' + key);
    } catch (e) { /* 무시 */ }
  }

  /* 판매현황(재고현황 위젯) 반품 조사용 — 응답까지 저장 */
  const SALES_PATHS = [
    '/tenants/rfm-inventory/sales/today',
    '/tenants/rfm-inventory/sales/sold-vendor-item-list'
  ];
  const K_SALES = '__cwc_sales_captures';

  function salesPathOf(url) {
    const u = String(url || '');
    for (const p of SALES_PATHS) {
      if (u.indexOf(p) !== -1) return p;
    }
    return null;
  }

  function saveSalesCapture(url, method, reqBody, resText) {
    try {
      const p = salesPathOf(url);
      if (!p) return;

      let store = {};
      try { store = JSON.parse(ss(K_SALES) || '{}') || {}; } catch (e) { store = {}; }

      store[p] = {
        url: String(url).slice(0, 300),
        method: method,
        reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 4000) : null,
        resText: typeof resText === 'string' ? resText.slice(0, 300000) : null,
        at: Date.now()
      };
      ssSet(K_SALES, JSON.stringify(store));
      console.log('[수집기] 판매현황 API 캡처: ' + p);
    } catch (e) { /* 무시 */ }
  }

  const K_BODY = '__cwc_template_body';
  const K_HEADERS = '__cwc_template_headers';
  const K_AT = '__cwc_template_at';
  const K_LOG = '__cwc_api_log';
  const K_CAT = '__cwc_category_payloads';
  const K_SEEN = '__cwc_seen_categories';

  /* ---------- 저장 헬퍼 ---------- */
  function ss(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, val) {
    try { sessionStorage.setItem(key, val); return true; } catch (e) { return false; }
  }

  function saveTemplate(body, headers) {
    if (typeof body !== 'string' || body.trim() === '') return;
    ssSet(K_BODY, body);
    ssSet(K_AT, String(Date.now()));
    if (headers) ssSet(K_HEADERS, JSON.stringify(headers));
    console.log('[수집기] 검색 요청 템플릿 캡처 완료');
  }

  function logRequest(method, url, reqBody) {
    try {
      let log = [];
      try {
        log = JSON.parse(ss(K_LOG) || '[]');
        if (!Array.isArray(log)) log = [];
      } catch (e) { log = []; }

      const sig = method + ' ' + String(url).split('?')[0];
      if (log.some((x) => x.sig === sig)) return;

      log.push({
        sig,
        method,
        url: String(url).slice(0, 500),
        reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 1500) : null,
        at: Date.now()
      });
      if (log.length > 120) log.shift();
      ssSet(K_LOG, JSON.stringify(log));
    } catch (e) { /* 무시 */ }
  }

  // 응답 본문에 카테고리 코드처럼 보이는 필드가 있으면 저장
  function maybeSaveCategoryPayload(url, text) {
    try {
      if (!text || typeof text !== 'string') return;
      if (text.length > 3000000) return;

      const hasCategoryField =
        text.indexOf('categoryCode') !== -1 ||
        text.indexOf('displayCategoryCode') !== -1 ||
        text.indexOf('categoryName') !== -1 ||
        text.indexOf('subCategories') !== -1 ||
        text.indexOf('childCategories') !== -1;

      if (!hasCategoryField) return;
      // 상품 검색 결과 자체는 제외 (카테고리 트리가 아님)
      if (String(url).indexOf(SEARCH_PATH) !== -1) return;

      let store = {};
      try {
        store = JSON.parse(ss(K_CAT) || '{}') || {};
      } catch (e) { store = {}; }

      const key = String(url).split('?')[0];
      const prev = store[key];
      // 더 큰 응답이 오면 갱신 (트리 전체일 가능성이 높음)
      if (!prev || String(prev).length < text.length) {
        store[key] = text.slice(0, 900000);
        if (!ssSet(K_CAT, JSON.stringify(store))) {
          // 용량 초과 시 가장 작은 항목 제거 후 재시도
          const keys = Object.keys(store).sort((a, b) => String(store[a]).length - String(store[b]).length);
          if (keys.length > 1) {
            delete store[keys[0]];
            ssSet(K_CAT, JSON.stringify(store));
          }
        }
        console.log('[수집기] 카테고리 후보 응답 저장: ' + key + ' (' + text.length + 'bytes)');
      }
    } catch (e) { /* 무시 */ }
  }

  function headersToObject(h) {
    try {
      if (!h) return null;
      const out = {};
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k] = v; });
        return out;
      }
      if (Array.isArray(h)) {
        h.forEach((pair) => { if (pair && pair.length >= 2) out[pair[0]] = pair[1]; });
        return out;
      }
      if (typeof h === 'object') {
        Object.keys(h).forEach((k) => { out[k] = h[k]; });
        return out;
      }
    } catch (e) { /* 무시 */ }
    return null;
  }

  function isWingUrl(url) {
    const u = String(url || '');
    if (u.indexOf('coupang.com') !== -1) return true;
    // 상대 경로는 현재 도메인으로 간주
    return u.charAt(0) === '/' && u.indexOf('//') !== 0;
  }

  /* ---------- fetch 후킹 ---------- */
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    let method = 'GET';
    let reqBody = null;

    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
      method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      reqBody = init && typeof init.body === 'string' ? init.body : null;

      if (url.indexOf(SEARCH_PATH) !== -1 && reqBody) {
        saveTemplate(reqBody, headersToObject(init && init.headers));
      }
      if (isWingUrl(url)) logRequest(method, url, reqBody);

      if (feePathOf(url)) {
        const _hdrs = headersToObject(init && init.headers);
        const _body = reqBody;
        const _url = url;
        const _m = method;
        // 응답까지 받아서 저장
        setTimeout(function () { /* 아래 then에서 처리 */ }, 0);
        window.__cwc_pendingFee = { url: _url, method: _m, body: _body, headers: _hdrs };
      }
    } catch (e) { /* 무시 */ }

    const p = origFetch.apply(this, arguments);

    try {
      if (isWingUrl(url) && method === 'GET') {
        p.then((res) => {
          try {
            const ct = res.headers.get('content-type') || '';
            if (ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
            res.clone().text()
              .then((t) => { maybeSaveCategoryPayload(url, t); maybeSaveProductPayload(url, t); })
              .catch(() => {});
          } catch (e) { /* 무시 */ }
        }).catch(() => {});
      }

      // 판매현황 API는 GET/POST 모두 응답까지 저장
      if (salesPathOf(url)) {
        p.then((res) => {
          try {
            res.clone().text()
              .then((t) => saveSalesCapture(url, method, reqBody, t))
              .catch(() => {});
          } catch (e) { /* 무시 */ }
        }).catch(() => {});
      }

      // 요금 API는 GET/POST 모두 응답까지 저장
      if (feePathOf(url)) {
        const _pending = window.__cwc_pendingFee || {};
        p.then((res) => {
          try {
            res.clone().text()
              .then((t) => saveFeeCapture(url, method, reqBody, t, _pending.headers))
              .catch(() => {});
          } catch (e) { /* 무시 */ }
        }).catch(() => {});
      }
    } catch (e) { /* 무시 */ }

    return p;
  };

  /* ---------- XMLHttpRequest 후킹 ---------- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cwc_method = String(method || 'GET').toUpperCase();
    this.__cwc_url = url;
    this.__cwc_headers = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__cwc_headers) this.__cwc_headers[String(k).toLowerCase()] = v;
    } catch (e) { /* 무시 */ }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__cwc_url;
    const method = this.__cwc_method || 'GET';

    try {
      if (url && String(url).indexOf(SEARCH_PATH) !== -1 && typeof body === 'string') {
        saveTemplate(body, this.__cwc_headers);
      }
      if (isWingUrl(url)) {
        logRequest(method, url, typeof body === 'string' ? body : null);
      }
    } catch (e) { /* 무시 */ }

    try {
      this.addEventListener('load', function () {
        try {
          if (!isWingUrl(url)) return;
          const t = (this.responseType === '' || this.responseType === 'text')
            ? this.responseText
            : (typeof this.response === 'string' ? this.response : null);
          if (t) {
            maybeSaveCategoryPayload(url, t);
            maybeSaveProductPayload(url, t);
            if (feePathOf(url)) saveFeeCapture(url, method, typeof body === 'string' ? body : null, t, this.__cwc_headers);
            if (salesPathOf(url)) saveSalesCapture(url, method, typeof body === 'string' ? body : null, t);
          }
        } catch (e) { /* 무시 */ }
      });
    } catch (e) { /* 무시 */ }

    return origSend.apply(this, arguments);
  };

  /* ---------- 주소창의 카테고리 코드 자동 기록 ---------- */
  function recordCurrentCategory() {
    try {
      const params = new URLSearchParams(location.search);
      const code = params.get('categoryCode');
      if (!code) return;
      const name = params.get('categoryName') || '';

      let list = [];
      try {
        list = JSON.parse(ss(K_SEEN) || '[]');
        if (!Array.isArray(list)) list = [];
      } catch (e) { list = []; }

      if (!list.some((c) => String(c.code) === String(code))) {
        list.push({ code: String(code), name });
        ssSet(K_SEEN, JSON.stringify(list));
      }
    } catch (e) { /* 무시 */ }
  }

  recordCurrentCategory();
  setInterval(recordCurrentCategory, 1000);


  /* ---------- 소비자 상품 관련 응답 샘플 저장 ---------- */
  const K_PROD = '__cwc_product_payloads';

  function maybeSaveProductPayload(url, text) {
    try {
      if (!text || typeof text !== 'string') return;
      if (text.length > 400000) return;

      const u = String(url).toLowerCase();
      const looksProduct =
        u.indexOf('/vp/products') !== -1 ||
        u.indexOf('vendoritem') !== -1 ||
        u.indexOf('/products/') !== -1 ||
        u.indexOf('rocket') !== -1 ||
        u.indexOf('delivery') !== -1;
      if (!looksProduct) return;

      const trimmed = text.trim();
      if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return; // JSON만

      let store = {};
      try { store = JSON.parse(ss(K_PROD) || '{}') || {}; } catch (e) { store = {}; }

      const key = String(url).split('?')[0];
      if (Object.keys(store).length > 15 && !store[key]) return;

      store[key] = text.slice(0, 200000);
      if (!ssSet(K_PROD, JSON.stringify(store))) {
        const keys = Object.keys(store);
        if (keys.length > 1) { delete store[keys[0]]; ssSet(K_PROD, JSON.stringify(store)); }
      }
      console.log('[수집기] 상품 응답 저장: ' + key);
    } catch (e) { /* 무시 */ }
  }

  console.log('[수집기] 인터셉터 활성화 (fetch + XHR 감시)');
})();
