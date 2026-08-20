/* ===================== 요소 참조 ===================== */
const openWindowBtn = document.getElementById('openWindowBtn');
const checkBtn = document.getElementById('checkBtn');
const scanBtn = document.getElementById('scanBtn');
const exportCatBtn = document.getElementById('exportCatBtn');
const probeBtn = document.getElementById('probeBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const apiLogBtn = document.getElementById('apiLogBtn');
const templateBtn = document.getElementById('templateBtn');
const treeRawBtn = document.getElementById('treeRawBtn');
const diagCatBtn = document.getElementById('diagCatBtn');
const inspectBtn = document.getElementById('inspectBtn');
const consumerBtn = document.getElementById('consumerBtn');
const salesBtn = document.getElementById('salesBtn');
const insightBtn = document.getElementById('insightBtn');
const productProbeBtn = document.getElementById('productProbeBtn');
const urlTestBtn = document.getElementById('urlTestBtn');
const resetDetailBtn = document.getElementById('resetDetailBtn');
const resetRowsBtn = document.getElementById('resetRowsBtn');
const healthBtn = document.getElementById('healthBtn');
const imgTestBtn = document.getElementById('imgTestBtn');
const feeCaptureBtn = document.getElementById('feeCaptureBtn');
const feeCollectBtn = document.getElementById('feeCollectBtn');
const feeExportBtn = document.getElementById('feeExportBtn');
const feeForceRefreshEl = document.getElementById('feeForceRefresh');
const defaultSizeEl = document.getElementById('defaultSize');
const sbUrlEl = document.getElementById('sbUrl');
const sbKeyEl = document.getElementById('sbKey');
const sbEmailEl = document.getElementById('sbEmail');
const sbPasswordEl = document.getElementById('sbPassword');
const sbSaveBtn = document.getElementById('sbSaveBtn');
const sbTestBtn = document.getElementById('sbTestBtn');
const sbUploadBtn = document.getElementById('sbUploadBtn');
const sbFeeUploadBtn = document.getElementById('sbFeeUploadBtn');
const sbStatusEl = document.getElementById('sbStatus');
const sbCatUploadBtn = document.getElementById('sbCatUploadBtn');
const sbQueueStartBtn = document.getElementById('sbQueueStartBtn');
const sbQueueStopBtn = document.getElementById('sbQueueStopBtn');
const htmlViewBtn = document.getElementById('htmlViewBtn');
const imgSizeEl = document.getElementById('imgSize');
const cellImgSizeEl = document.getElementById('cellImgSize');
const imgModeEl = document.getElementById('imgMode');
const applyTopNToRowsEl = document.getElementById('applyTopNToRows');
const detailTestBtn = document.getElementById('detailTestBtn');
const prodIdEl = document.getElementById('prodId');
const detailStartBtn = document.getElementById('detailStartBtn');
const detailStopBtn = document.getElementById('detailStopBtn');
const detailFromDataBtn = document.getElementById('detailFromDataBtn');
const detailIdsEl = document.getElementById('detailIds');
const detailDownloadBtn = document.getElementById('detailDownloadBtn');
const detailDelayEl = document.getElementById('detailDelay');
const detailTopNEl = document.getElementById('detailTopN');
const detailPerOptionEl = document.getElementById('detailPerOption');
const detailEnabledEl = document.getElementById('detailEnabled');
const earlyStopEl = document.getElementById('earlyStop');
const startConcEl = document.getElementById('startConc');
const maxConcEl = document.getElementById('maxConc');
const rpmLimitEl = document.getElementById('rpmLimit');
const speedLogBtn = document.getElementById('speedLogBtn');
const calibrateEl = document.getElementById('calibrate');
const fRankMax = document.getElementById('fRankMax');
const fPvMin = document.getElementById('fPvMin');
const fPvMax = document.getElementById('fPvMax');
const fReviewMin = document.getElementById('fReviewMin');
const fReviewMax = document.getElementById('fReviewMax');
const fPriceMin = document.getElementById('fPriceMin');
const fPriceMax = document.getElementById('fPriceMax');
const fExcludeInvalid = document.getElementById('fExcludeInvalid');
const fSalesMin = document.getElementById('fSalesMin');
const fSalesMax = document.getElementById('fSalesMax');
const filterPreviewBtn = document.getElementById('filterPreviewBtn');

const statusEl = document.getElementById('status');
const codesEl = document.getElementById('codes');
const bar = document.getElementById('bar');
const barFill = document.getElementById('barFill');
const modeLabel = document.getElementById('modeLabel');
const crawlWarn = document.getElementById('crawlWarn');

const catBox = document.getElementById('catBox');
const catList = document.getElementById('catList');
const catCount = document.getElementById('catCount');
const catFilter = document.getElementById('catFilter');
const selAll = document.getElementById('selAll');
const selNone = document.getElementById('selNone');
const selLeaf = document.getElementById('selLeaf');

const CATEGORY_TREE_URL = 'https://wing.coupang.com/tenants/rfm-ss/api/cms/categories';

let collectedRows = [];
let categories = [];
let stopRequested = false;
let lastTreeRaw = '';
let codeFieldVerified = false;
let detailsMap = {};   // productId -> 상세정보
let detailStop = false;

/* ===================== 유틸 ===================== */
function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

async function getWingTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && tabs[0].url && tabs[0].url.includes('wing.coupang.com')) return tabs[0];
  tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/*' });
  if (tabs.length > 0) return tabs[0];
  throw new Error('쿠팡 윙(wing.coupang.com) 탭을 찾을 수 없습니다. 해당 탭을 열어두세요.');
}

/* ===================== 페이지 컨텍스트 함수들 ===================== */
function pageReadTemplate() {
  try {
    const body = sessionStorage.getItem('__cwc_template_body');
    const at = sessionStorage.getItem('__cwc_template_at');
    if (!body) return { ok: false };
    return { ok: true, at: at ? Number(at) : null };
  } catch (e) { return { ok: false }; }
}

function pageReadTemplateBody() {
  try {
    const body = sessionStorage.getItem('__cwc_template_body');
    const headers = sessionStorage.getItem('__cwc_template_headers');
    if (!body) return { ok: false };
    return { ok: true, body, headers };
  } catch (e) { return { ok: false }; }
}

function pageReadSalesCaptures() {
  try {
    const store = JSON.parse(sessionStorage.getItem('__cwc_sales_captures') || '{}');
    return { ok: true, store: store && typeof store === 'object' ? store : {} };
  } catch (e) { return { ok: true, store: {} }; }
}

/* 비즈니스 인사이트(판매분석) 캡처 읽기 — 경로별로 저장돼 있다 */
function pageReadInsightCaptures() {
  try {
    const store = JSON.parse(sessionStorage.getItem('__cwc_insight_captures') || '{}');
    return { ok: true, store: store && typeof store === 'object' ? store : {} };
  } catch (e) { return { ok: true, store: {} }; }
}

function pageReadApiLog() {
  try {
    const log = JSON.parse(sessionStorage.getItem('__cwc_api_log') || '[]');
    return { ok: true, log: Array.isArray(log) ? log : [] };
  } catch (e) { return { ok: true, log: [] }; }
}

/* 카테고리 트리를 직접 호출하고, 페이지 안에서 파싱까지 마친 뒤 결과만 반환합니다.
   (응답이 2MB를 넘으므로 원문을 그대로 넘기지 않습니다) */
async function pageFetchCategoryTree(url) {
  try {
    function getCookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function newRequestId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      let s = '';
      for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }

    const headers = {
      'accept': 'application/json, text/plain, */*',
      'x-cp-pt-locale': 'ko',
      'x-rfm-seller-success-request-id': newRequestId()
    };
    const xsrf = getCookie('XSRF-TOKEN');
    if (xsrf) headers['x-xsrf-token'] = xsrf;

    const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
    const text = await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, preview: text.slice(0, 800) };
    }

    let root;
    try {
      root = JSON.parse(text);
    } catch (e) {
      return {
        ok: false,
        status: res.status,
        parseError: true,
        size: text.length,
        preview: text.slice(0, 800)
      };
    }

    // 템플릿에서 기준값을 뽑아 어느 코드 필드가 맞는지 검증합니다
    let tplCode = null;
    let tplName = null;
    try {
      const tpl = JSON.parse(sessionStorage.getItem('__cwc_template_body') || 'null');
      if (tpl) {
        (function scan(node) {
          if (Array.isArray(node)) { node.forEach(scan); return; }
          if (node && typeof node === 'object') {
            if (typeof node.field === 'string' &&
                node.field.toUpperCase().indexOf('CATEGORY') !== -1 &&
                Array.isArray(node.values) && node.values.length) {
              tplCode = String(node.values[0]);
            }
            if (typeof node.query === 'string' && node.query.trim() !== '') {
              tplName = node.query.trim();
            }
            Object.keys(node).forEach((k) => scan(node[k]));
          }
        })(tpl);
      }
    } catch (e) { /* 무시 */ }

    // 트리 순회
    const nodes = [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;

      const dto = node.displayItemCategoryDto;
      const children = Array.isArray(node.child) ? node.child : [];

      if (dto && typeof dto.name === 'string') {
        const code = dto.displayItemCategoryCode;
        const id = dto.displayItemCategoryId;
        const path = typeof dto.categoryPath === 'string'
          ? dto.categoryPath.replace(/^ROOT>?/, '')
          : dto.name;

        // ROOT 자체는 제외
        if (dto.name !== 'ROOT' && (code !== 0 && code !== undefined && code !== null)) {
          nodes.push({
            code: String(code),
            altCode: id !== undefined && id !== null ? String(id) : null,
            name: dto.name,
            path,
            depth: path ? path.split('>').length : 1,
            isLeaf: children.length === 0,
            active: dto.status === 'ACTIVE'
          });
        }
      }

      children.forEach(walk);
    }

    walk(root);
    if (Array.isArray(root)) root.forEach(walk);

    // 코드 필드 검증: 템플릿의 이름과 일치하는 노드를 찾아
    // displayItemCategoryCode / displayItemCategoryId 중 어느 쪽이 맞는지 확인
    let codeFieldVerdict = 'unverified';
    if (tplCode && tplName) {
      const byName = nodes.filter((n) => n.name === tplName);
      if (byName.some((n) => n.code === tplCode)) {
        codeFieldVerdict = 'code';
      } else if (byName.some((n) => n.altCode === tplCode)) {
        codeFieldVerdict = 'altCode';
      } else if (byName.length > 0) {
        codeFieldVerdict = 'mismatch';
      } else {
        codeFieldVerdict = 'name-not-found';
      }
    }

    // altCode가 맞다고 판정되면 코드를 교체
    if (codeFieldVerdict === 'altCode') {
      nodes.forEach((n) => {
        const t = n.code;
        n.code = n.altCode;
        n.altCode = t;
      });
    }

    return {
      ok: true,
      status: res.status,
      size: text.length,
      nodes,
      tplCode,
      tplName,
      codeFieldVerdict,
      preview: text.slice(0, 800)
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

/* 카테고리 하나를 여러 방식으로 시험해서 무엇이 통하는지 알아냅니다 */
async function pageDiagnoseCategory(code, name, altCode) {
  function getCookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function newRequestId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let s = '';
    for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  const xsrf = getCookie('XSRF-TOKEN');

  function baseHeaders(extra) {
    const h = Object.assign({
      'accept': 'application/json, text/plain, */*',
      'x-cp-pt-locale': 'ko',
      'x-rfm-seller-success-request-id': newRequestId()
    }, extra || {});
    if (xsrf) h['x-xsrf-token'] = xsrf;
    return h;
  }

  const out = { code, name, altCode, info: null, variants: [] };

  /* 1) 카테고리 존재 여부 확인 */
  try {
    const res = await fetch(
      'https://wing.coupang.com/tenants/rfm-ss/api/info/category/' + encodeURIComponent(code),
      { method: 'GET', credentials: 'include', headers: baseHeaders() }
    );
    const t = await res.text();
    out.info = { status: res.status, preview: t.slice(0, 400) };
  } catch (e) {
    out.info = { status: 0, preview: String(e && e.message) };
  }

  /* 2) 검색 방식별 시험 */
  const templateBody = sessionStorage.getItem('__cwc_template_body');
  if (!templateBody) {
    out.error = '템플릿이 없습니다.';
    return out;
  }

  let savedHeaders = {};
  try {
    const h = sessionStorage.getItem('__cwc_template_headers');
    if (h) savedHeaders = JSON.parse(h) || {};
  } catch (e) { /* 무시 */ }

  function build(codeVal, queryVal) {
    const root = JSON.parse(templateBody);
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        if (typeof node.field === 'string' &&
            node.field.toUpperCase().indexOf('CATEGORY') !== -1 &&
            Array.isArray(node.values)) {
          node.values = [String(codeVal)];
        }
        if (typeof node.query === 'string') node.query = queryVal;
        if (typeof node.start === 'number' && typeof node.limit === 'number') {
          node.start = 0;
          node.limit = 100;
        }
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    })(root);
    return root;
  }

  const trials = [
    { label: '코드=' + code + ', 검색어=이름', codeVal: code, queryVal: name || '' }
  ];
  if (altCode && String(altCode) !== String(code)) {
    trials.push({ label: '코드=' + altCode + '(대체), 검색어=이름', codeVal: altCode, queryVal: name || '' });
  }

  for (const t of trials) {
    try {
      const headers = Object.assign({}, savedHeaders, baseHeaders({ 'content-type': 'application/json' }));
      delete headers['content-length'];
      delete headers['cookie'];
      delete headers['sentry-trace'];
      delete headers['baggage'];

      const res = await fetch('https://wing.coupang.com/tenants/rfm-ss/api/trends/search', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(build(t.codeVal, t.queryVal))
      });
      const raw = await res.text();

      let totalCount = null;
      let itemCount = null;
      try {
        const d = JSON.parse(raw);
        totalCount = typeof d.totalCount === 'number' ? d.totalCount : null;
        itemCount = Array.isArray(d.searchItems) ? d.searchItems.length : null;
      } catch (e) { /* 파싱 실패 */ }

      out.variants.push({
        label: t.label,
        status: res.status,
        totalCount,
        itemCount,
        preview: (totalCount === null ? raw.slice(0, 200) : '')
      });
    } catch (e) {
      out.variants.push({ label: t.label, status: 0, error: String(e && e.message) });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return out;
}

/* 상품 원본 필드 전체 + 정렬 관련 API 확인 */
async function pageInspectFields(code, name) {
  function getCookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function newRequestId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let s = '';
    for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  const xsrf = getCookie('XSRF-TOKEN');
  function baseHeaders(extra) {
    const h = Object.assign({
      'accept': 'application/json, text/plain, */*',
      'x-cp-pt-locale': 'ko',
      'x-rfm-seller-success-request-id': newRequestId()
    }, extra || {});
    if (xsrf) h['x-xsrf-token'] = xsrf;
    return h;
  }

  const out = {};

  /* 1) 정렬 옵션 API */
  try {
    const res = await fetch('https://wing.coupang.com/tenants/rfm-ss/api/trends/sort-by-sales-count', {
      method: 'GET', credentials: 'include', headers: baseHeaders()
    });
    const t = await res.text();
    out.sortApi = { status: res.status, body: t.slice(0, 1200) };
  } catch (e) {
    out.sortApi = { status: 0, body: String(e && e.message) };
  }

  /* 2) 검색 결과의 원본 필드 전체 */
  try {
    const templateBody = sessionStorage.getItem('__cwc_template_body');
    if (!templateBody) {
      out.itemError = '템플릿이 없습니다.';
      return out;
    }

    let savedHeaders = {};
    try {
      const h = sessionStorage.getItem('__cwc_template_headers');
      if (h) savedHeaders = JSON.parse(h) || {};
    } catch (e) { /* 무시 */ }

    const root = JSON.parse(templateBody);
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        if (typeof node.field === 'string' &&
            node.field.toUpperCase().indexOf('CATEGORY') !== -1 &&
            Array.isArray(node.values)) {
          node.values = [String(code)];
        }
        if (typeof node.query === 'string') node.query = name || '';
        if (typeof node.start === 'number' && typeof node.limit === 'number') {
          node.start = 0;
          node.limit = 2;
        }
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    })(root);

    const headers = Object.assign({}, savedHeaders, baseHeaders({ 'content-type': 'application/json' }));
    delete headers['content-length'];
    delete headers['cookie'];
    delete headers['sentry-trace'];
    delete headers['baggage'];

    const res = await fetch('https://wing.coupang.com/tenants/rfm-ss/api/trends/search', {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(root)
    });
    const raw = await res.text();
    const d = JSON.parse(raw);

    out.topLevelKeys = Object.keys(d);
    const first = Array.isArray(d.searchItems) && d.searchItems.length ? d.searchItems[0] : null;
    out.item = first;
    out.itemKeys = first ? Object.keys(first) : [];
  } catch (e) {
    out.itemError = (e && e.message) ? e.message : String(e);
  }

  return out;
}

/* 데이터 유무만 빠르게 확인 (1건만 요청) */
async function pageProbeCategory(code, name) {
  try {
    const templateBody = sessionStorage.getItem('__cwc_template_body');
    if (!templateBody) return { ok: false, error: '템플릿 없음' };

    let savedHeaders = {};
    try {
      const h = sessionStorage.getItem('__cwc_template_headers');
      if (h) savedHeaders = JSON.parse(h) || {};
    } catch (e) { /* 무시 */ }

    function getCookie(n) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function newRequestId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      let s = '';
      for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }

    const root = JSON.parse(templateBody);
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        if (typeof node.field === 'string' &&
            node.field.toUpperCase().indexOf('CATEGORY') !== -1 &&
            Array.isArray(node.values)) {
          node.values = [String(code)];
        }
        if (typeof node.query === 'string') node.query = name || '';
        if (typeof node.start === 'number' && typeof node.limit === 'number') {
          node.start = 0;
          node.limit = 1;
        }
        Object.keys(node).forEach((k) => walk(node[k]));
      }
    })(root);

    const headers = Object.assign({}, savedHeaders, {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'x-rfm-seller-success-request-id': newRequestId()
    });
    const x = getCookie('XSRF-TOKEN');
    if (x) headers['x-xsrf-token'] = x;
    delete headers['content-length'];
    delete headers['cookie'];
    delete headers['sentry-trace'];
    delete headers['baggage'];

    const res = await fetch('https://wing.coupang.com/tenants/rfm-ss/api/trends/search', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(root)
    });

    const raw = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };

    try {
      const d = JSON.parse(raw);
      return {
        ok: true,
        totalCount: typeof d.totalCount === 'number' ? d.totalCount : 0
      };
    } catch (e) {
      return { ok: false, error: '파싱 실패' };
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

/* 실제 수집: 캡처된 템플릿을 재사용하되 코드와 검색어를 함께 교체 */
async function pageCollectCategory(categoryCode, categoryName, altCode) {
  try {
    const templateBody = sessionStorage.getItem('__cwc_template_body');
    if (!templateBody) return { ok: false, error: '캡처된 요청 템플릿이 없습니다.' };

    let savedHeaders = {};
    try {
      const h = sessionStorage.getItem('__cwc_template_headers');
      if (h) savedHeaders = JSON.parse(h) || {};
    } catch (e) { /* 무시 */ }

    function getCookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }

    function newRequestId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      let s = '';
      for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }

    let baseLimit = 100;
    (function findLimit(node) {
      if (Array.isArray(node)) { node.forEach(findLimit); return; }
      if (node && typeof node === 'object') {
        if (typeof node.start === 'number' && typeof node.limit === 'number') baseLimit = node.limit;
        Object.keys(node).forEach((k) => findLimit(node[k]));
      }
    })(JSON.parse(templateBody));
    if (!baseLimit || baseLimit < 1) baseLimit = 100;

    const xsrfToken = getCookie('XSRF-TOKEN');

    function build(codeVal, queryVal, start, limit) {
      let replacedCat = 0;
      const root = JSON.parse(templateBody);
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node && typeof node === 'object') {
          if (typeof node.field === 'string' &&
              node.field.toUpperCase().indexOf('CATEGORY') !== -1 &&
              Array.isArray(node.values)) {
            node.values = [String(codeVal)];
            replacedCat++;
          }
          if (typeof node.query === 'string') node.query = queryVal;
          if (typeof node.start === 'number' && typeof node.limit === 'number') {
            node.start = start;
            node.limit = limit;
          }
          Object.keys(node).forEach((k) => walk(node[k]));
        }
      })(root);
      return { root, replacedCat };
    }

    async function requestPage(codeVal, queryVal, start, limit) {
      const built = build(codeVal, queryVal, start, limit);
      if (built.replacedCat === 0) {
        return { fatal: '템플릿에서 카테고리 필드를 찾지 못했습니다.' };
      }

      const headers = Object.assign({}, savedHeaders, {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*',
        'x-rfm-seller-success-request-id': newRequestId()
      });
      if (xsrfToken) headers['x-xsrf-token'] = xsrfToken;
      delete headers['content-length'];
      delete headers['cookie'];
      delete headers['host'];
      delete headers['sentry-trace'];
      delete headers['baggage'];

      const res = await fetch('https://wing.coupang.com/tenants/rfm-ss/api/trends/search', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(built.root)
      });

      const raw = await res.text();
      if (!res.ok) return { httpError: `HTTP ${res.status} ${raw.slice(0, 160)}` };
      if (!raw || raw.trim() === '') return { httpError: `빈 응답 (HTTP ${res.status})` };

      try {
        const d = JSON.parse(raw);
        return {
          totalCount: typeof d.totalCount === 'number' ? d.totalCount : null,
          items: Array.isArray(d.searchItems) ? d.searchItems : []
        };
      } catch (e) {
        return { httpError: `JSON 파싱 실패: ${raw.slice(0, 160)}` };
      }
    }

    // 진단 결과: 빈 검색어는 서버가 빈 응답으로 거부하므로 시도하지 않습니다.
    // 기본은 정규 코드 1회. 대체코드는 코드 체계가 검증되지 않았을 때만 추가 시도합니다.
    const attempts = [
      { code: categoryCode, query: categoryName || '', label: '기본' }
    ];
    if (altCode && String(altCode) !== String(categoryCode)) {
      attempts.push({ code: altCode, query: categoryName || '', label: '대체코드' });
    }

    let chosen = null;
    let firstPage = null;
    let lastError = null;

    for (const a of attempts) {
      const r = await requestPage(a.code, a.query, 0, baseLimit);
      if (r.fatal) return { ok: false, error: r.fatal };
      if (r.httpError) { lastError = r.httpError; continue; }

      if (r.items.length > 0) {
        chosen = a;
        firstPage = r;
        break;
      }
      lastError = '0건';
      await new Promise((res) => setTimeout(res, 250));
    }

    if (!chosen) {
      return {
        ok: true,
        categoryCode,
        totalCount: 0,
        items: [],
        empty: true,
        note: lastError || '모든 방식에서 0건'
      };
    }

    const items = firstPage.items.slice();
    let totalCount = firstPage.totalCount === null ? items.length : firstPage.totalCount;
    let start = baseLimit;
    let guard = 0;

    while (start < totalCount && guard < 300) {
      guard++;
      const r = await requestPage(chosen.code, chosen.query, start, baseLimit);
      if (r.fatal || r.httpError) break;
      if (r.items.length === 0) break;
      items.push(...r.items);
      if (r.totalCount !== null) totalCount = r.totalCount;
      start += baseLimit;
      await new Promise((res) => setTimeout(res, 300));
    }

    return {
      ok: true,
      categoryCode,
      usedCode: chosen.code,
      usedMode: chosen.label,
      totalCount,
      items
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}


function pageReadProductPayloads() {
  try {
    const store = JSON.parse(sessionStorage.getItem('__cwc_product_payloads') || '{}');
    return { ok: true, store: store && typeof store === 'object' ? store : {} };
  } catch (e) { return { ok: true, store: {} }; }
}

async function getConsumerTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.coupang.com/*' });
  if (tabs.length === 0) {
    throw new Error('www.coupang.com 탭이 없습니다. 상품 페이지를 열어두고 다시 시도하세요.');
  }
  return tabs[0];
}


/* 인터셉터가 실제로 심어졌는지 확인 (MAIN world에서 실행되어야 함) */
function pageCheckInstalled() {
  return { installed: !!window.__cwc_installed, url: location.href };
}

/* 상품 페이지 HTML을 직접 받아서 필요한 정보가 들어있는지 점검 */
async function pageProbeProductPage(productId) {
  const url = 'https://www.coupang.com/vp/products/' + encodeURIComponent(productId);
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'include' });
    const text = await res.text();

    const markers = [
      '구매했어요', '로켓배송', '로켓', '판매자로켓', '판매자배송',
      '__NEXT_DATA__', 'PRELOADED_STATE', 'deliveryBadge', 'rocketMerchant',
      'salesCount', 'saleCount'
    ];

    const hits = [];
    markers.forEach((m) => {
      const idx = text.indexOf(m);
      if (idx !== -1) {
        hits.push({
          marker: m,
          index: idx,
          around: text.slice(Math.max(0, idx - 120), idx + 180).replace(/\s+/g, ' ')
        });
      }
    });

    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      size: text.length,
      isHtml: text.trim().slice(0, 200).toLowerCase().indexOf('<!doctype') !== -1 ||
              text.trim().charAt(0) === '<',
      hits,
      head: text.slice(0, 300).replace(/\s+/g, ' ')
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}




/* 능동 탐침: 가벼운 정적 리소스로 서버 상태를 미리 잽니다 */
async function pageProbeServer() {
  const targets = [
    'https://www.coupang.com/favicon.ico',
    'https://www.coupang.com/robots.txt'
  ];
  const url = targets[Math.floor(Math.random() * targets.length)] +
              '?_=' + Date.now();   // 캐시 회피
  try {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const res = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' });
    const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    await res.arrayBuffer();

    function readCookie(n) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
      return m ? m[1] : '';
    }

    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(t1 - t0),
      redirected: !!res.redirected,
      abck: readCookie('_abck').slice(0, 60)
    };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message) };
  }
}

/* ===================== 적응형 속도 제어 ===================== */
class RateGovernor {
  constructor(opts) {
    this.conc = opts.startConc || 2;
    this.minConc = 1;
    this.maxConc = opts.maxConc || 5;
    this.rpmLimit = opts.rpmLimit || 50;
    this.rpmCeiling = opts.rpmLimit || 50;   // 사용자가 정한 상한 (탐색 시 기준)
    this.baseDelay = opts.baseDelay || 1500;
    this.delayMultiplier = 1;

    this.okStreak = 0;
    this.responseTimes = [];
    this.ttfbTimes = [];
    this.probeTimes = [];
    this.stamps = [];
    this.lastAbck = '';

    this.log = [];
    this.alertCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    this.currentLevel = 0;
    this.sessionRequests = 0;

    /* 임계점 탐색 */
    this.calibrating = !!opts.calibrate;
    this.calSamples = [];       // {rpm, avgMs}
    this.calStep = 0;
    this.safeRpm = null;
  }

  addLog(level, category, detail, action) {
    this.log.push({
      t: Date.now(), level, category, detail, action,
      conc: this.conc, rpm: this.rpm(),
      baseline: this.baseline() ? Math.round(this.baseline()) : null
    });
    if (this.log.length > 400) this.log.shift();
  }

  baseline() {
    if (this.responseTimes.length < 8) return null;
    const s = this.responseTimes.slice(0, 25).slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  ttfbBaseline() {
    if (this.ttfbTimes.length < 8) return null;
    const s = this.ttfbTimes.slice(0, 25).slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  probeBaseline() {
    if (this.probeTimes.length < 3) return null;
    const s = this.probeTimes.slice(0, 8).slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }

  rpm() {
    const cut = Date.now() - 60000;
    this.stamps = this.stamps.filter((t) => t > cut);
    return this.stamps.length;
  }

  waitForSlot() {
    if (this.rpm() < this.rpmLimit) return 0;
    const cut = Date.now() - 60000;
    const oldest = this.stamps.filter((t) => t > cut)[0];
    return oldest ? Math.max(0, oldest + 60000 - Date.now()) : 1000;
  }

  markRequest() {
    this.stamps.push(Date.now());
    this.sessionRequests++;
  }

  recordProbe(p) {
    if (p && p.ok && typeof p.ms === 'number') this.probeTimes.push(p.ms);
  }

  /* ---------- 위협 평가: 5개 신호원을 종합해 0~4단계 판정 ---------- */
  assess(r) {
    const signals = [];
    const base = this.baseline();

    /* 신호 1: 응답시간 추세 */
    if (base && this.responseTimes.length >= 12) {
      const recent = this.responseTimes.slice(-10);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const ratio = avg / base;
      if (ratio >= 2.5) {
        signals.push({ lv: 3, cat: '응답추세', detail: `최근10건 평균이 기준의 ${ratio.toFixed(1)}배 (${Math.round(avg)}ms vs ${Math.round(base)}ms)` });
      } else if (ratio >= 1.8) {
        signals.push({ lv: 2, cat: '응답추세', detail: `최근10건 평균이 기준의 ${ratio.toFixed(1)}배` });
      } else if (ratio >= 1.4) {
        signals.push({ lv: 1, cat: '응답추세', detail: `최근10건 평균이 기준의 ${ratio.toFixed(1)}배 (완만한 상승)` });
      }

      /* 변동성 */
      const p95 = this.percentile(recent, 0.95);
      if (p95 > base * 3.5) {
        signals.push({ lv: 2, cat: '변동성', detail: `상위5% 응답이 기준의 ${(p95 / base).toFixed(1)}배 — 큐잉 의심` });
      }
    }

    /* 신호 2: TTFB (서버 처리 지연과 네트워크 지연 구분) */
    const tb = this.ttfbBaseline();
    if (tb && typeof r.ttfb === 'number' && r.ttfb > 0) {
      const tr = r.ttfb / tb;
      if (tr >= 3) {
        signals.push({ lv: 3, cat: 'TTFB', detail: `서버 첫응답이 기준의 ${tr.toFixed(1)}배 (${r.ttfb}ms) — 서버측 지연` });
      } else if (tr >= 2) {
        signals.push({ lv: 2, cat: 'TTFB', detail: `서버 첫응답이 기준의 ${tr.toFixed(1)}배 — 서버측 지연` });
      }
      this.ttfbTimes.push(r.ttfb);
    } else if (typeof r.ttfb === 'number' && r.ttfb > 0) {
      this.ttfbTimes.push(r.ttfb);
    }

    /* 신호 3: Akamai _abck 쿠키 상태 */
    if (r.abck) {
      const suspicious = /~[1-9]\d*~/.test(r.abck) && !/~0~/.test(r.abck);
      if (suspicious) {
        signals.push({ lv: 3, cat: '방어쿠키', detail: `_abck가 의심 상태로 전환 (${r.abck.slice(0, 24)}...)` });
      } else if (this.lastAbck && r.abck !== this.lastAbck && this.lastAbck.slice(0, 20) !== r.abck.slice(0, 20)) {
        signals.push({ lv: 1, cat: '방어쿠키', detail: '_abck 값이 갱신됨 (재평가 진행 중일 수 있음)' });
      }
      this.lastAbck = r.abck;
    }

    /* 신호 4: 리다이렉트 (챌린지 페이지) */
    if (r.redirected) {
      signals.push({ lv: 3, cat: '리다이렉트', detail: `최종 URL이 변경됨 — 챌린지 페이지 의심 (${(r.finalUrl || '').slice(0, 60)})` });
    }

    /* 신호 5: 능동 탐침 */
    const pb = this.probeBaseline();
    if (pb && this.probeTimes.length >= 4) {
      const lastProbe = this.probeTimes[this.probeTimes.length - 1];
      const pr = lastProbe / pb;
      if (pr >= 3) {
        signals.push({ lv: 3, cat: '탐침', detail: `탐침 응답이 기준의 ${pr.toFixed(1)}배 — 서버 전반 부하` });
      } else if (pr >= 1.8) {
        signals.push({ lv: 2, cat: '탐침', detail: `탐침 응답이 기준의 ${pr.toFixed(1)}배` });
      }

      /* 탐침은 빠른데 본 요청만 느리면 = 표적 견제 */
      if (base && r.ms && pr < 1.3 && r.ms > base * 2) {
        signals.push({ lv: 3, cat: '표적견제', detail: `탐침은 정상인데 수집 요청만 ${(r.ms / base).toFixed(1)}배 지연 — 선택적 제한 의심` });
      }
    }

    /* 신호 6: 명시적 차단 */
    if (r.status === 429) signals.push({ lv: 4, cat: 'HTTP', detail: 'HTTP 429 (요청 과다)' + (r.retryAfter ? ` · Retry-After ${r.retryAfter}s` : '') });
    if (r.status === 403) signals.push({ lv: 4, cat: 'HTTP', detail: 'HTTP 403 (접근 거부)' });
    if (r.blocked) signals.push({ lv: 4, cat: '차단응답', detail: '차단 페이지로 판단됨' });
    if (typeof r.size === 'number' && r.size > 0 && r.size < 20000) {
      signals.push({ lv: 4, cat: '응답과소', detail: `응답이 ${Math.round(r.size / 1024)}KB에 불과 — 정상 페이지 아님` });
    }

    if (typeof r.ms === 'number' && r.ms > 0) this.responseTimes.push(r.ms);

    let level = 0;
    signals.forEach((s) => { if (s.lv > level) level = s.lv; });
    return { level, signals };
  }

  /* ---------- 경보 단계별 대응 ---------- */
  react(assessment) {
    const { level, signals } = assessment;
    this.currentLevel = level;

    if (level === 0) {
      this.okStreak++;
      if (this.delayMultiplier > 1 && this.okStreak >= 15) {
        const before = this.delayMultiplier;
        this.delayMultiplier = Math.max(1, this.delayMultiplier - 0.25);
        this.addLog(0, '회복', `안정 지속 → 간격 배수 ${before.toFixed(2)}→${this.delayMultiplier.toFixed(2)}`, '간격 완화');
      }
      if (this.okStreak >= 20 && this.conc < this.maxConc && this.delayMultiplier <= 1) {
        const before = this.conc;
        this.conc++;
        this.okStreak = 0;
        this.addLog(0, '상승', `연속 20건 정상 → 동시 ${before}→${this.conc}`, '속도 상승');
        return { action: 'UP' };
      }
      return { action: 'OK' };
    }

    this.okStreak = 0;
    this.alertCounts[level] = (this.alertCounts[level] || 0) + 1;
    const detail = signals.map((s) => `${s.cat}: ${s.detail}`).join(' | ');

    if (level === 1) {
      const before = this.delayMultiplier;
      this.delayMultiplier = Math.min(3, this.delayMultiplier + 0.25);
      this.addLog(1, '주의', detail, `간격 배수 ${before.toFixed(2)}→${this.delayMultiplier.toFixed(2)}`);
      return { action: 'SLOWDOWN', level, signals };
    }

    if (level === 2) {
      const beforeC = this.conc;
      const beforeR = this.rpmLimit;
      this.conc = Math.max(this.minConc, this.conc - 1);
      this.rpmLimit = Math.max(5, Math.floor(this.rpmLimit * 0.8));
      this.delayMultiplier = Math.min(4, this.delayMultiplier + 0.5);
      this.addLog(2, '경고', detail,
        `동시 ${beforeC}→${this.conc} · 분당상한 ${beforeR}→${this.rpmLimit} · 간격 ${this.delayMultiplier.toFixed(2)}배`);
      return { action: 'THROTTLE', level, signals };
    }

    if (level === 3) {
      const beforeC = this.conc;
      const beforeR = this.rpmLimit;
      this.conc = this.minConc;
      this.rpmLimit = Math.max(5, Math.floor(this.rpmLimit * 0.5));
      this.delayMultiplier = Math.min(6, this.delayMultiplier + 1);
      this.addLog(3, '위험', detail,
        `동시 ${beforeC}→1 · 분당상한 ${beforeR}→${this.rpmLimit} · 60초 냉각`);
      return { action: 'COOLDOWN', level, signals, waitSec: 60 };
    }

    // level 4
    this.conc = this.minConc;
    this.rpmLimit = Math.max(5, Math.floor(this.rpmLimit * 0.4));
    this.delayMultiplier = Math.min(8, this.delayMultiplier + 2);
    const waitSec = Math.min(600, 60 * Math.pow(2, Math.min(4, this.alertCounts[4] - 1)));
    this.addLog(4, '차단', detail, `${waitSec}초 정지 · 분당상한 ${this.rpmLimit}로 축소`);
    return { action: 'PAUSE', level, signals, waitSec };
  }

  /* ---------- 임계점 탐색 ---------- */
  calibrateStep() {
    if (!this.calibrating) return null;
    const base = this.baseline();
    if (!base || this.responseTimes.length < 15) return null;

    const recent = this.responseTimes.slice(-10);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    this.calSamples.push({ rpm: this.rpmLimit, avgMs: Math.round(avg), conc: this.conc });

    // 응답시간이 기준의 1.3배를 넘으면 그 직전을 안전선으로 확정
    if (avg > base * 1.3) {
      const prev = this.calSamples.length >= 2 ? this.calSamples[this.calSamples.length - 2] : null;
      this.safeRpm = Math.max(5, Math.floor((prev ? prev.rpm : this.rpmLimit) * 0.75));
      this.rpmLimit = this.safeRpm;
      this.calibrating = false;
      this.addLog(0, '탐색완료', `응답 저하 시작 지점 감지 (평균 ${Math.round(avg)}ms vs 기준 ${Math.round(base)}ms)`,
        `안전 분당상한 ${this.safeRpm}으로 고정`);
      return { done: true, safeRpm: this.safeRpm };
    }

    // 아직 여유 → 한 단계 올림
    if (this.rpmLimit < this.rpmCeiling) {
      const before = this.rpmLimit;
      this.rpmLimit = Math.min(this.rpmCeiling, this.rpmLimit + Math.max(5, Math.floor(this.rpmCeiling * 0.15)));
      this.calStep++;
      this.addLog(0, '탐색', `평균 ${Math.round(avg)}ms (기준 ${Math.round(base)}ms) — 여유 있음`,
        `분당상한 ${before}→${this.rpmLimit} 시험`);
      return { done: false };
    }

    this.calibrating = false;
    this.safeRpm = this.rpmLimit;
    this.addLog(0, '탐색완료', `상한 ${this.rpmCeiling}까지 이상 없음`, `분당상한 ${this.rpmLimit} 유지`);
    return { done: true, safeRpm: this.safeRpm };
  }

  nextDelay() {
    const d = this.baseDelay * this.delayMultiplier;
    return Math.round(d * (0.7 + Math.random() * 0.6));
  }

  summary() {
    const lvName = ['정상', '주의', '경고', '위험', '차단'][this.currentLevel] || '정상';
    return `[${lvName}] 동시 ${this.conc}/${this.maxConc} · 분당 ${this.rpm()}/${this.rpmLimit} · ` +
           `간격 ${this.delayMultiplier.toFixed(2)}배` +
           (this.calibrating ? ' · 탐색중' : (this.safeRpm ? ` · 안전선 ${this.safeRpm}` : '')) +
           `\n경보 주의${this.alertCounts[1]} 경고${this.alertCounts[2]} 위험${this.alertCounts[3]} 차단${this.alertCounts[4]}`;
  }
}

let governor = null;

/* ===================== 상품 상세 보강 (소비자 페이지 파싱) ===================== */
async function pageFetchProductDetail(productId, itemId, vendorItemId, earlyStopEnabled) {
  function stripTags(t) {
    return t.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseHtml(html, usedUrl, status) {
    // 주의: '상품을 찾을 수 없습니다' 문구는 정상 페이지의 숨겨진 템플릿에도 존재합니다.
    // 따라서 먼저 파싱하고, 실제 데이터가 없을 때만 없는 상품으로 판정합니다.
    let salesText = '';
    let salesNumber = '';
    {
      // 태그가 중간에 끼어 있어도 잡히도록 HTML 원문에서 직접 찾습니다.
      // "한 달간<s>{v}</s>구매했어요" 같은 다국어 템플릿은 건너뜁니다.
      const re = /한 달간[\s\S]{0,300}?구매했어요/g;
      let m;
      let raw = null;
      while ((m = re.exec(html)) !== null) {
        if (m[0].indexOf('{v}') !== -1) continue;
        raw = m[0];
        break;
      }

      if (raw) {
        const decoded = raw.replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>');
        salesText = stripTags(decoded);
        const num = salesText.match(/([\d,]+)\s*(만|천)?\s*명/);
        if (num) {
          let n = parseInt(num[1].replace(/,/g, ''), 10);
          if (num[2] === '만') n = n * 10000;
          else if (num[2] === '천') n = n * 1000;
          salesNumber = n;
        }
      }
    }

    /* ---------- 배송 유형 분류 ----------
       우선순위: JSON 배지 라벨 > 배지 이미지 파일명 > 판매자/배송사 표기 */
    const dm = html.match(/deliveryBadgeLabel\\?"?\s*:\s*\\?"([^"\\]+)/);

    const imgFresh    = /logo_rocket_fresh/i.test(html);
    const imgMerchant = /logo_rocket_merchant/i.test(html);
    const imgGlobal   = /logo_rocket_global|logo_direct/i.test(html);
    const imgRocket   = /logo_rocket(?!_fresh|_merchant|_global)/i.test(html);

    const courierMatch = html.match(/배송사\s*:\s*([^<\n]{2,20})/);
    const courier = courierMatch ? courierMatch[1].trim() : '';
    const hasSellerLine = /판매자\s*:/.test(html) || /판매자<\/[^>]*>\s*:/.test(html);

    let deliveryBadge = '';
    let deliveryBasis = '';

    if (dm) {
      deliveryBadge = dm[1];
      deliveryBasis = '배지라벨';
    } else if (imgFresh) {
      deliveryBadge = '로켓프레시'; deliveryBasis = '배지이미지';
    } else if (imgMerchant) {
      deliveryBadge = '판매자로켓'; deliveryBasis = '배지이미지';
    } else if (imgGlobal) {
      deliveryBadge = '로켓직구'; deliveryBasis = '배지이미지';
    } else if (imgRocket) {
      deliveryBadge = '로켓배송'; deliveryBasis = '배지이미지';
    } else if (hasSellerLine || courier) {
      deliveryBadge = '판매자배송'; deliveryBasis = '판매자표기';
    } else {
      deliveryBadge = '판정불가'; deliveryBasis = '';
    }

    /* 배송비 형태 */
    let shippingFee = '';
    if (html.indexOf('착불배송') !== -1) {
      shippingFee = '착불배송';
    } else if (html.indexOf('무료배송') !== -1) {
      shippingFee = '무료배송';
    } else {
      const feeMatch = html.match(/배송비\s*([\d,]+)\s*원/);
      if (feeMatch) shippingFee = feeMatch[1] + '원';
    }

    /* 판매자명 */
    const sellerMatch = html.match(/판매자\s*:\s*(?:<[^>]*>)*\s*([^<\n]{1,40})/);
    const sellerName = sellerMatch ? sellerMatch[1].trim() : '';

    /* ---------- 가격 추출 ----------
       클래스명은 디자인 변경에 취약하므로 구조화 데이터를 우선합니다. */
    let salePrice = '';
    let priceBasis = '';
    let originPrice = '';
    {
      const cands = [];
      function pushPrice(v, basis, weight) {
        const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
        if (!isNaN(n) && n >= 10 && n <= 100000000) cands.push({ n, basis, weight });
      }

      let pm;
      pm = html.match(/"salePrice"\s*:\s*(\d+)/);   if (pm) pushPrice(pm[1], 'salePrice', 100);
      pm = html.match(/"finalPrice"\s*:\s*(\d+)/);  if (pm) pushPrice(pm[1], 'finalPrice', 98);
      pm = html.match(/"couponPrice"\s*:\s*(\d+)/); if (pm) pushPrice(pm[1], 'couponPrice', 95);

      pm = html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i);
      if (pm) pushPrice(pm[1], 'schema.org', 92);

      pm = html.match(/"@type"\s*:\s*"Offer"[\s\S]{0,300}?"price"\s*:\s*"?([\d.,]+)/);
      if (pm) pushPrice(pm[1], 'JSON-LD', 90);

      pm = html.match(/property=["']product:price:amount["'][^>]*content=["']([\d.,]+)["']/i);
      if (pm) pushPrice(pm[1], 'og:price', 88);

      pm = html.match(/"price"\s*:\s*(\d{2,9})\s*[,}]/);
      if (pm) pushPrice(pm[1], 'price', 80);

      // 화면에 크게 표시되는 빨간 가격
      pm = html.match(/twc-text-red-700[^>]*>\s*([\d,]+)\s*원/);
      if (pm) pushPrice(pm[1], '표시가격(red)', 70);

      pm = html.match(/twc-text-\[22px\][^>]*>\s*([\d,]+)\s*원/);
      if (pm) pushPrice(pm[1], '표시가격(22px)', 65);

      if (cands.length > 0) {
        cands.sort((a, b) => b.weight - a.weight);
        salePrice = cands[0].n;
        priceBasis = cands[0].basis;
      }

      // 정가(할인 전) — 있으면 참고용
      let om = html.match(/"originPrice"\s*:\s*(\d+)/) ||
               html.match(/"originalPrice"\s*:\s*(\d+)/);
      if (om) {
        const on = parseInt(om[1], 10);
        if (!isNaN(on) && on > 0) originPrice = on;
      }
    }

    const soldOut = html.indexOf('일시품절') !== -1 || html.indexOf('품절되었습니다') !== -1;

    // 페이지 제목으로 정상 상품 페이지인지 보조 확인
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '';

    const badgeFound = deliveryBadge !== '판정불가';
    const hasData = !!(salesText || badgeFound || salePrice !== '');

    // 쿠팡은 구매자 수가 100명 이상일 때만 표기합니다.
    // 정상 페이지인데 표기가 없으면 100명 미만으로 간주합니다.
    if (!salesText && badgeFound) {
      salesText = '100명 미만 추정';
      salesNumber = 0;
    }

    // 데이터가 하나도 없고 에러 문구가 있을 때만 없는 상품으로 판정
    const notFound = !hasData && html.indexOf('상품을 찾을 수 없습니다') !== -1;

    return {
      salesText, salesNumber,
      salePrice, originPrice, priceBasis,
      deliveryBadge, deliveryBasis, shippingFee, courier, sellerName,
      soldOut, pageTitle, usedUrl, status, size: html.length,
      hasData, notFound
    };
  }

  // URL 변형: 옵션 정보까지 붙인 형태를 먼저 시도합니다
  // 옵션(itemId)이 있으면 옵션 지정 URL을 우선 사용합니다.
  const base = 'https://www.coupang.com/vp/products/' + encodeURIComponent(productId);
  const variants = [];
  if (itemId) {
    variants.push(base + '?itemId=' + encodeURIComponent(itemId));
  }
  if (itemId && vendorItemId) {
    variants.push(base + '?itemId=' + encodeURIComponent(itemId) +
                  '&vendorItemId=' + encodeURIComponent(vendorItemId));
  }
  if (vendorItemId) {
    variants.push(base + '?vendorItemId=' + encodeURIComponent(vendorItemId));
  }
  variants.push(base);

  let last = null;

  for (const url of variants) {
    try {
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const _t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: controller ? controller.signal : undefined
      });
      const _ttfb = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - _t0;

      if (res.status === 429 || res.status === 403) {
        if (controller) { try { controller.abort(); } catch (e) {} }
        return { ok: false, blocked: true, status: res.status };
      }

      /* ---------- 조기 중단 다운로드 ----------
         필요한 정보를 모두 찾으면 나머지를 받지 않고 연결을 끊습니다.
         배송 판정이 확정되기 전에는 멈추지 않아 오분류를 막습니다. */
      let html = '';
      let earlyStopped = false;

      if (earlyStopEnabled && controller && res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        const MIN_BYTES = 50000;   // 최소 이만큼은 읽고 판단
        const MAX_BYTES = 400000;  // 이 이상은 어차피 필요 없음

        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;

            html += decoder.decode(chunk.value, { stream: true });

            if (html.length >= MIN_BYTES) {
              const salesOk = /한 달간[\s\S]{0,300}?구매했어요/.test(
                html.replace(/한 달간[\s\S]{0,80}?\{v\}[\s\S]{0,80}?구매했어요/g, '')
              );
              const badgeOk = /deliveryBadgeLabel/.test(html);
              const rocketOk = /logo_rocket/i.test(html);
              const sellerOk = /판매자\s*:/.test(html) && /배송사\s*:/.test(html);
              const deliveryResolved = badgeOk || rocketOk || sellerOk;

              const priceOk =
                /"salePrice"\s*:\s*\d+/.test(html) ||
                /"finalPrice"\s*:\s*\d+/.test(html) ||
                /itemprop=["']price["']/.test(html) ||
                /product:price:amount/.test(html) ||
                /twc-text-red-700[^>]*>\s*[\d,]+\s*원/.test(html);

              if ((salesOk && deliveryResolved && priceOk) || html.length >= MAX_BYTES) {
                earlyStopped = true;
                try { await reader.cancel(); } catch (e) {}
                try { controller.abort(); } catch (e) {}
                break;
              }
            }
          }
          html += decoder.decode();
        } catch (e) {
          // 스트리밍 실패 시 아래에서 통째로 다시 받습니다
          if (!html) html = '';
        }
      }

      if (!html) {
        html = await res.text();
      }

      if (html.length < 20000) {
        last = { ok: false, blocked: true, status: res.status, size: html.length, usedUrl: url };
        continue;
      }

      const parsed = parseHtml(html, url, res.status);
      // 방어 시스템 신호 수집
      function readCookie(n) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
        return m ? m[1] : '';
      }

      last = Object.assign(
        {
          ok: true, productId, itemId: itemId || '', earlyStopped,
          ttfb: Math.round(_ttfb),
          redirected: !!res.redirected,
          finalUrl: res.url,
          abck: readCookie('_abck').slice(0, 60),
          bmsv: readCookie('bm_sv') ? 'set' : '',
          retryAfter: res.headers.get('retry-after') || ''
        },
        parsed
      );

      // 실제 데이터를 얻었으면 종료
      if (parsed.hasData) return last;
    } catch (e) {
      last = { ok: false, error: (e && e.message) ? e.message : String(e), usedUrl: url };
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  return last || { ok: false, error: '모든 URL 변형 실패' };
}


/* URL 변형별로 어떤 응답이 오는지 개별 확인 */
async function pageTestUrlVariants(productId, itemId, vendorItemId) {
  const base = 'https://www.coupang.com/vp/products/' + encodeURIComponent(productId);
  const urls = [base];
  if (vendorItemId) urls.push(base + '?vendorItemId=' + encodeURIComponent(vendorItemId));
  if (itemId && vendorItemId) {
    urls.push(base + '?itemId=' + encodeURIComponent(itemId) +
              '&vendorItemId=' + encodeURIComponent(vendorItemId));
  }

  const results = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'include' });
      const html = await res.text();
      results.push({
        url,
        status: res.status,
        size: html.length,
        hasSold: html.indexOf('구매했어요') !== -1,
        hasBadge: html.indexOf('deliveryBadgeLabel') !== -1,
        notFound: html.indexOf('구매했어요') === -1 &&
                  html.indexOf('deliveryBadgeLabel') === -1 &&
                  html.indexOf('상품을 찾을 수 없습니다') !== -1,
        title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
      });
    } catch (e) {
      results.push({ url, error: (e && e.message) ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

/* ===================== 프레임 처리 ===================== */
async function runInAllFrames(tabId, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func,
    args: args || []
  });
}

async function findTemplateFrame(tabId) {
  const results = await runInAllFrames(tabId, pageReadTemplate);
  const hit = results.find((r) => r && r.result && r.result.ok);
  return {
    frameCount: results.length,
    frameId: hit ? hit.frameId : null,
    info: hit ? hit.result : null
  };
}

async function injectInterceptor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['interceptor.js']
    });
    return true;
  } catch (e) { return false; }
}

/* ===================== 목록 렌더링 ===================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function matchesFilter(c, q) {
  if (!q) return true;
  return (c.name + ' ' + c.code + ' ' + (c.path || '')).toLowerCase().indexOf(q) !== -1;
}

function renderCategories() {
  const q = catFilter.value.trim().toLowerCase();
  catList.innerHTML = '';

  let shown = 0;
  categories.forEach((c, idx) => {
    if (!matchesFilter(c, q)) return;
    if (shown >= 800) return; // 너무 많으면 렌더링 제한
    shown++;

    const row = document.createElement('label');
    row.className = 'cat';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.selected === true;
    cb.addEventListener('change', () => {
      categories[idx].selected = cb.checked;
      updateCatCount();
    });

    const span = document.createElement('span');
    const probeTag = (c.probeCount === undefined)
      ? ''
      : (c.probeCount > 0
          ? ' <span class="code">· 상품 ' + c.probeCount + '</span>'
          : ' <span class="code">· 데이터없음</span>');

    span.innerHTML =
      escapeHtml(c.name) +
      (c.isLeaf ? '' : ' <span class="code">[상위]</span>') +
      ' <span class="code">' + escapeHtml(c.code) + '</span>' +
      probeTag +
      (c.path && c.path !== c.name
        ? '<br /><span class="code">' + escapeHtml(c.path) + '</span>'
        : '');

    row.appendChild(cb);
    row.appendChild(span);
    catList.appendChild(row);
  });

  if (shown >= 800) {
    const note = document.createElement('div');
    note.className = 'cat';
    note.innerHTML = '<span class="code">…목록이 많아 800개까지만 표시했습니다. 검색으로 좁혀보세요. (선택 상태는 그대로 유지됩니다)</span>';
    catList.appendChild(note);
  }

  updateCatCount();
}

function updateCatCount() {
  const sel = categories.filter((c) => c.selected === true).length;
  const leaves = categories.filter((c) => c.isLeaf).length;
  catCount.textContent = `선택 ${sel} / 전체 ${categories.length} (말단 ${leaves})`;
  crawlWarn.style.display = sel > 30 ? 'block' : 'none';
}

function getSelected() {
  const list = categories.filter((c) => c.selected === true)
    .map((c) => ({
      code: String(c.code),
      name: c.name,
      altCode: codeFieldVerified ? null : (c.altCode || null)
    }));

  const manual = codesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
  manual.forEach((m) => {
    if (!list.some((x) => x.code === m)) {
      const known = categories.find((c) => String(c.code) === m);
      list.push({
        code: m,
        name: known ? known.name : '',
        altCode: known ? (known.altCode || null) : null
      });
    }
  });
  return list;
}



/* CDN 후보를 실제로 요청해 어떤 형식이 유효한지 확인 */
async function pageTestImageUrls(path, candidates) {
  const results = [];
  for (const tpl of candidates) {
    const url = tpl.replace('{size}', '212x212ex').replace('{path}', path);
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      let bytes = 0;
      if (res.ok) {
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
      }
      results.push({
        url, status: res.status, ok: res.ok,
        isImage: /image\//i.test(type), bytes, type
      });
    } catch (e) {
      results.push({ url, status: 0, ok: false, error: String(e && e.message) });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return results;
}


/* 캡처된 요금 API 정보 읽기 */
function pageReadFeeCaptures() {
  try {
    const store = JSON.parse(sessionStorage.getItem('__cwc_fee_captures') || '{}');
    return { ok: true, store: store && typeof store === 'object' ? store : {} };
  } catch (e) { return { ok: true, store: {} }; }
}


/* ===================== 입출고비(요금표) ===================== */
const CAPACITY_LABELS = {
  MINI: '극소형', SMALL: '소형', MEDIUM: '중형',
  LARGE1: '대형1', LARGE2: '대형2', XLARGE: '특대형',
  LARGE_1: '대형1', LARGE_2: '대형2', EXTRA_LARGE: '특대형'
};
const CAPACITY_ORDER = ['MINI', 'SMALL', 'MEDIUM', 'LARGE1', 'LARGE2', 'XLARGE'];

/* feeTables:    { "Apparel|Women Clothes": { MINI:[{minPrice,base,final}], ... } }  정가/할인가 표
   feeTablesLow: 같은 구조, 저가 상품 전용 할인가(전용할인가) 표 — 일부 카테고리만 있음
   catUnitMap:   { "8699": {unit1, unit2, kanName, fullPath} }                     */
let feeTables = {};
let feeTablesLow = {};
let catUnitMap = {};

function feeUnitKey(u1, u2) { return String(u1 || '') + '|' + String(u2 || ''); }

function parseFeeResponse(json) {
  const out = {};
  const list = (json && json.feeRatesBySingleCategoryResponseV1) || [];
  list.forEach((entry) => {
    const fees = (entry.calculatedFeesAfterPromotion && entry.calculatedFeesAfterPromotion.calculatedFees)
              || entry.calculatedFees || [];
    fees.forEach((f) => {
      if (!f || !f.capacityType) return;
      const tiers = (f.feeByMinPrice || []).map((t) => ({
        minPrice: parseInt((t.minPrice && t.minPrice.amount) || 0, 10) || 0,
        base: parseInt((t.configuredFee && t.configuredFee.amount && t.configuredFee.amount.amount) || 0, 10) || 0,
        final: parseInt((t.configuredFee && t.configuredFee.finalAmount && t.configuredFee.finalAmount.amount) || 0, 10) || 0
      })).sort((a, b) => a.minPrice - b.minPrice);
      if (tiers.length) out[f.capacityType] = tiers;
    });
  });
  return out;
}

function lookupFee(unitKey, capacity, price) {
  const table = feeTables[unitKey];
  if (!table) return null;
  const tiers = table[capacity];
  if (!tiers || !tiers.length) return null;
  const p = Number(price) || 0;
  let hit = tiers[0];
  for (const t of tiers) {
    if (p >= t.minPrice) hit = t; else break;
  }
  return hit;
}

/* 페이지에서 실행: KAN 카테고리 -> unit1/unit2 조회 */
async function pageFetchUnitCategory(kanId) {
  function getCookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  try {
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json'
    };
    const x = getCookie('XSRF-TOKEN');
    if (x) headers['x-xsrf-token'] = x;

    const res = await fetch('https://wing.coupang.com/tenants/rfm/accounting-fee/category/search', {
      method: 'POST', credentials: 'include', headers, body: String(kanId)
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, preview: text.slice(0, 300) };
    const d = JSON.parse(text);
    return {
      ok: true,
      kanId: String(kanId),
      unit1: d.unit1 || '',
      unit2: d.unit2 || '',
      kanName: d.kanCategoryName || '',
      fullPath: d.fullPathName || ''
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

/* 페이지에서 실행: unit1/unit2 -> 요금표 조회 */
async function pageFetchFeeTable(unit1, unit2, useLowAsp) {
  function getCookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  try {
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json'
    };
    const x = getCookie('XSRF-TOKEN');
    if (x) headers['x-xsrf-token'] = x;

    const path = useLowAsp
      ? '/tenants/rfm/accounting-fee/lowasp/warehousing-and-fulfillment-fee'
      : '/tenants/rfm/accounting-fee/revamp/warehousing-and-fulfillment-fee';

    const body = {
      agreementScope: 'PRODUCTION',
      leafKanCategoryIds: [],
      unit1Unit2CategoryNames: [{ unit1CategoryName: unit1, unit2CategoryName: unit2 }]
    };

    const res = await fetch('https://wing.coupang.com' + path, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, preview: text.slice(0, 300) };
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

/* ===================== 이미지 · 링크 URL ===================== */
const CDN_CANDIDATES = [
  'https://thumbnail6.coupangcdn.com/thumbnails/remote/{size}/image/{path}',
  'https://thumbnail7.coupangcdn.com/thumbnails/remote/{size}/image/{path}',
  'https://thumbnail9.coupangcdn.com/thumbnails/remote/{size}/image/{path}',
  'https://image6.coupangcdn.com/image/{path}',
  'https://static.coupangcdn.com/image/{path}'
];

let cdnTemplate = CDN_CANDIDATES[0];   // 진단으로 검증되면 교체됩니다


/* IMAGE 수식 생성
   주의: 엑셀과 구글시트는 인자 순서가 다릅니다.
     구글시트 IMAGE(url, mode, height, width)          — mode 4 = 사용자지정
     엑셀     IMAGE(source, alt, sizing, height, width) — sizing 3 = 사용자지정
   호환 모드는 인자 없이 넣어 양쪽 모두에서 셀 크기에 맞춰 표시됩니다. */
function imageFormula(url) {
  const mode = imgModeEl ? imgModeEl.value : 'compat';
  const px = cellImgSizeEl ? parseInt(cellImgSizeEl.value, 10) : 0;

  if (mode === 'sheets' && px >= 20) {
    return `=IMAGE("${url}",4,${px},${px})`;
  }
  if (mode === 'excel' && px >= 20) {
    return `=IMAGE("${url}","상품",3,${px},${px})`;
  }
  return `=IMAGE("${url}")`;
}

function currentImageSize() {
  const v = imgSizeEl ? parseInt(imgSizeEl.value, 10) : 400;
  const n = (!v || v < 60) ? 400 : Math.min(1000, v);
  return n + 'x' + n + 'ex';
}

function toImageUrl(p, size) {
  if (!p) return '';
  let path = String(p).trim();
  if (/^https?:\/\//i.test(path)) return path;
  path = path.replace(/^\/+/, '');
  return cdnTemplate
    .replace('{size}', size || currentImageSize())
    .replace('{path}', path);
}

function toProductUrl(pid, iid, vid) {
  if (!pid) return '';
  const base = 'https://www.coupang.com/vp/products/' + pid;
  const q = [];
  if (iid) q.push('itemId=' + iid);
  if (vid) q.push('vendorItemId=' + vid);
  return q.length ? base + '?' + q.join('&') : base;
}

/* ===================== CSV ===================== */

/* Long 최솟값/최댓값은 "경계 없음"을 뜻하므로 정리합니다 */
function cleanPv(v) {
  if (typeof v !== 'number') return '';
  if (Math.abs(v) > 1e15) return '';
  return v;
}

function pvRangeText(lower, upper) {
  const lo = cleanPv(lower);
  const hi = cleanPv(upper);
  if (lo === '' && hi === '') return '';
  if (lo === '') return `~${hi.toLocaleString()}`;
  if (hi === '') return `${lo.toLocaleString()}~`;
  return `${lo.toLocaleString()}~${hi.toLocaleString()}`;
}


function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const CSV_HEADERS = [
  'image', 'productLink', 'imageUrl',
  'categoryCode', 'categoryName', 'categoryHierarchy', 'productName', 'itemName',
  'brandName', 'manufacture', 'salesPrice', 'rating', 'ratingCount', 'pvLast28dRank',
  'pvRange', 'lowerPvLast28d', 'upperPvLast28d', 'listingEligibility',
  'itemId', 'productId', 'vendorItemId',
  'salesText', 'salesNumber', 'currentPrice', 'originPrice', 'priceBasis',
  'wantPrice', 'sizeType', 'fulfillmentFee', 'feeCategory',
  'deliveryBadge', 'deliveryBasis',
  'shippingFee', 'courier', 'sellerName', 'soldOut'
];


/* 카테고리별 상위 N개로 행을 추립니다 (CSV 출력용) */
function applyTopNFilter(rows) {
  if (!applyTopNToRowsEl || !applyTopNToRowsEl.checked) return rows;
  const topN = detailTopNEl ? (parseInt(detailTopNEl.value, 10) || 0) : 0;
  if (topN <= 0) return rows;

  const perOption = detailPerOptionEl ? detailPerOptionEl.checked : true;
  const byCat = {};
  rows.forEach((r) => {
    const c = r.categoryCode || '';
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(r);
  });

  const out = [];
  Object.keys(byCat).forEach((c) => {
    const sorted = byCat[c].slice().sort((a, b) => {
      const ra = typeof a.pvLast28dRank === 'number' ? a.pvLast28dRank : 99999;
      const rb = typeof b.pvLast28dRank === 'number' ? b.pvLast28dRank : 99999;
      return ra - rb;
    });
    const seen = new Set();
    for (const r of sorted) {
      const k = detailKey(r.productId, r.itemId, perOption);
      if (seen.has(k)) {
        // 같은 상품의 다른 옵션은 이미 센 것으로 보고 함께 포함
        out.push(r);
        continue;
      }
      if (seen.size >= topN) break;
      seen.add(k);
      out.push(r);
    }
  });
  return out;
}

/* 컬럼 문자(A, B, ...) 매핑 — 수식에서 셀을 참조하기 위해 필요 */
function colLetter(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const CSV_COL = (function () {
  const m = {};
  CSV_HEADERS.forEach((h, i) => { m[h] = colLetter(i); });
  return m;
})();

function buildCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  let csvRowIndex = 0;
  for (const r of rows) {
    const d = detailsMap[String(r.productId) + '_' + String(r.itemId)] ||
              detailsMap[String(r.productId)] || {};
    const imgUrl = toImageUrl(r.imagePath);
    const prodUrl = toProductUrl(r.productId, r.itemId, r.vendorItemId);

    // 입출고비: wantPrice와 sizeType을 참조하는 수식으로 생성
    const unit = catUnitMap[String(r.categoryId)];
    const unitKey = unit ? feeUnitKey(unit.unit1, unit.unit2) : '';
    const price = (d.salePrice !== undefined && d.salePrice !== '') ? d.salePrice : (r.salesPrice || 0);
    const defSize = defaultSizeEl ? defaultSizeEl.value : 'MINI';

    const rowNo = csvRowIndex + 2;   // 헤더가 1행이므로
    const colWant = CSV_COL.wantPrice;
    const colSize = CSV_COL.sizeType;

    // 요금표 시트를 참조해 가격구간 중 가장 큰 하한을 찾습니다
    const feeFormula = unitKey
      ? `=IFERROR(LOOKUP(2,1/((요금표!$A:$A=$${CSV_COL.feeCategory}${rowNo})*(요금표!$D:$D=$${colSize}${rowNo})*(요금표!$F:$F<=$${colWant}${rowNo})),요금표!$H:$H),"")`
      : '';

    const merged = Object.assign({}, r, {
      image: imgUrl ? imageFormula(imgUrl) : '',
      imageUrl: imgUrl,
      productLink: prodUrl ? `=HYPERLINK("${prodUrl}","상품보기")` : '',
      wantPrice: price || '',
      sizeType: defSize,
      feeCategory: unitKey,
      fulfillmentFee: feeFormula,
      salesText: d.salesText || '',
      salesNumber: (d.salesNumber === undefined || d.salesNumber === '') ? '' : d.salesNumber,
      currentPrice: (d.salePrice === undefined || d.salePrice === '') ? '' : d.salePrice,
      originPrice: (d.originPrice === undefined || d.originPrice === '') ? '' : d.originPrice,
      priceBasis: d.priceBasis || '',
      deliveryBadge: d.deliveryBadge || '',
      deliveryBasis: d.deliveryBasis || '',
      shippingFee: d.shippingFee || '',
      courier: d.courier || '',
      sellerName: d.sellerName || '',
      soldOut: d.soldOut === undefined ? '' : (d.soldOut ? 'Y' : 'N')
    });
    lines.push(CSV_HEADERS.map((h) => toCsvValue(merged[h])).join(','));
    csvRowIndex++;
  }
  return lines.join('\n');
}

async function saveProgress() {
  try { await chrome.storage.local.set({ cwc_rows: collectedRows }); } catch (e) { /* 무시 */ }
}

async function loadProgress() {
  try {
    const ft = await chrome.storage.local.get(['cwc_feeTables', 'cwc_feeTablesLow', 'cwc_catUnitMap']);
    if (ft.cwc_feeTables) feeTables = ft.cwc_feeTables;
    if (ft.cwc_feeTablesLow) feeTablesLow = ft.cwc_feeTablesLow;
    if (ft.cwc_catUnitMap) catUnitMap = ft.cwc_catUnitMap;

    const { cwc_details } = await chrome.storage.local.get('cwc_details');
    if (cwc_details && typeof cwc_details === 'object') {
      detailsMap = cwc_details;
      if (Object.keys(detailsMap).length > 0) detailDownloadBtn.style.display = 'block';
    }

    const { cwc_rows } = await chrome.storage.local.get('cwc_rows');
    if (Array.isArray(cwc_rows) && cwc_rows.length > 0) {
      collectedRows = cwc_rows;
      downloadBtn.style.display = 'block';
      setStatus(`이전에 수집한 ${collectedRows.length}개 데이터가 남아 있습니다. 바로 CSV로 받을 수 있습니다.`);
    }
  } catch (e) { /* 무시 */ }
}

/* ===================== 버튼들 ===================== */
openWindowBtn.addEventListener('click', () => {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html?windowed=1'),
    type: 'popup',
    width: 560,
    height: 820
  });
});

checkBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);

    if (found.frameId !== null) {
      const when = found.info.at ? new Date(found.info.at).toLocaleTimeString('ko-KR') : '알 수 없음';
      setStatus(
        `✅ 요청 템플릿 준비 완료 (캡처 ${when})\n다음으로 "② 전체 카테고리 불러오기"를 누르세요.`
      );
      return;
    }

    const injected = await injectInterceptor(tab.id);
    setStatus(
      `❌ 캡처된 요청이 없습니다. (검사 프레임 ${found.frameCount}개)\n\n` +
      (injected ? '인터셉터를 방금 심었습니다.\n\n' : '') +
      '1) "쿠팡 인기 상품 검색" 열기\n2) 카테고리 선택 후 검색 (상품 목록이 떠야 함)\n3) 이 버튼 다시 누르기',
      true
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

scanBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    setStatus('전체 카테고리 목록을 불러오는 중... (응답이 수 MB라 몇 초 걸릴 수 있습니다)');

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFetchCategoryTree,
      args: [CATEGORY_TREE_URL]
    });

    const r = res && res.result;
    if (!r) {
      setStatus('❌ 응답을 받지 못했습니다.', true);
      return;
    }

    lastTreeRaw = r.preview || '';

    if (!r.ok) {
      setStatus(
        `❌ 카테고리 목록 불러오기 실패 (HTTP ${r.status || '?'})\n` +
        (r.parseError ? `응답 크기 ${r.size}bytes, JSON 파싱 실패\n` : '') +
        (r.error ? r.error + '\n' : '') +
        `\n미리보기:\n${(r.preview || '').slice(0, 500)}`,
        true
      );
      return;
    }

    if (!r.nodes || r.nodes.length === 0) {
      setStatus(
        `❌ 응답은 받았지만 카테고리를 추출하지 못했습니다. (크기 ${r.size}bytes)\n\n미리보기:\n${(r.preview || '').slice(0, 500)}`,
        true
      );
      return;
    }

    // 비활성 카테고리는 제외
    const usable = r.nodes.filter((n) => n.active !== false);

    categories = usable.map((c) => Object.assign({}, c, { selected: c.isLeaf }));
    catBox.style.display = 'block';
    renderCategories();

    const leaves = categories.filter((c) => c.isLeaf).length;

    codeFieldVerified = (r.codeFieldVerdict === 'code' || r.codeFieldVerdict === 'altCode');

    let verdictMsg = '';
    if (r.codeFieldVerdict === 'code') {
      verdictMsg = `\n✔ 코드 필드 검증 통과 (기준: ${r.tplName} = ${r.tplCode})`;
    } else if (r.codeFieldVerdict === 'altCode') {
      verdictMsg = `\n✔ 코드 필드를 displayItemCategoryId로 자동 보정했습니다 (기준: ${r.tplName} = ${r.tplCode})`;
    } else if (r.codeFieldVerdict === 'mismatch') {
      verdictMsg =
        `\n⚠ 주의: 템플릿 기준값(${r.tplName} = ${r.tplCode})과 트리의 코드가 일치하지 않습니다.\n` +
        `   먼저 2~3개만 선택해서 결과가 맞는지 확인해보세요.`;
    } else if (r.codeFieldVerdict === 'name-not-found') {
      verdictMsg = `\n⚠ 템플릿 검색어(${r.tplName})와 같은 이름의 카테고리를 트리에서 못 찾아 검증을 못 했습니다.`;
    }

    setStatus(
      `✅ 카테고리 ${categories.length}개 로드 완료 (말단 ${leaves}개, 응답 ${Math.round(r.size / 1024)}KB)` +
      verdictMsg +
      `\n\n기본으로 말단 카테고리만 선택되어 있습니다.\n` +
      `검색창으로 걸러낸 뒤 "전체선택 / 전체해제"를 누르면 걸러진 것만 일괄 처리됩니다.\n\n` +
      `⚠ 말단이 ${leaves}개면 전체 수집에 매우 오래 걸립니다.\n` +
      `   먼저 "전체해제" 후 몇 개만 골라 시험해보시고, 잘 되면 범위를 넓히세요.`
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

catFilter.addEventListener('input', renderCategories);

selAll.addEventListener('click', (e) => {
  e.preventDefault();
  const q = catFilter.value.trim().toLowerCase();
  categories.forEach((c) => { if (matchesFilter(c, q)) c.selected = true; });
  renderCategories();
});

selNone.addEventListener('click', (e) => {
  e.preventDefault();
  const q = catFilter.value.trim().toLowerCase();
  categories.forEach((c) => { if (matchesFilter(c, q)) c.selected = false; });
  renderCategories();
});

selLeaf.addEventListener('click', (e) => {
  e.preventDefault();
  categories.forEach((c) => { c.selected = c.isLeaf; });
  catFilter.value = '';
  renderCategories();
});

stopBtn.addEventListener('click', () => {
  stopRequested = true;
  detailStop = true;   // 상세 보강 단계도 함께 중지
  stopBtn.disabled = true;
  setStatus(statusEl.textContent + '\n\n중지 요청됨... 현재 카테고리를 마치고 멈춥니다.');
});

/* 카테고리 하나를 상세수집 → 요금표 자동수집 → DB 업로드까지 끝까지 처리한다.
   수동 "카테고리 수집"과 대기열 processJob이 이 함수를 공유한다 — 카테고리 하나가
   끝날 때마다 곧바로 업로드하는 방식이라, 전체를 다 모았다가 마지막에 한 번에
   올리는 것보다 중간에 중단돼도 이미 끝난 카테고리는 안전하게 저장돼 있다.
   rows: 이 카테고리의 1단계 결과(상품 행들). tab: 이미 열어둔 윙 탭(있으면 재사용). */
async function finishCategoryPipeline(catCode, rows, opts) {
  opts = opts || {};
  const withDetail = opts.withDetail !== false;
  const statusFn = opts.statusFn || setStatus;
  const label = opts.label || catCode;
  const tab = opts.tab;

  let detailDone = false;
  if (withDetail && rows.length) {
    const topN = parseInt(detailTopNEl.value, 10) || 0;
    const perOption = detailPerOptionEl.checked;
    const idLines = uniqueProductIdsFromRows(topN, perOption, rows);

    if (idLines.length > 0) {
      try {
        await getConsumerTab();
        const r2 = await runDetailCollection(idLines);
        detailDone = !!(r2 && r2.ok && !r2.stopped);
      } catch (e) {
        statusFn(`${label} — 상세 보강 생략 (${e.message})`);
      }
    }
  }

  if (detailDone) {
    const feeKanIds = Array.from(new Set(
      rows.map((r) => r.categoryId).filter((v) => v !== undefined && v !== null && v !== '')
    )).map(String);
    if (feeKanIds.length) {
      statusFn(`${label} — 입출고비 요금표 확인 중...`);
      try {
        await collectFeeDataForCategories(feeKanIds, { statusFn, tab });
      } catch (e) {
        statusFn(`${label} — 요금표 수집 생략 (${e.message})`);
      }
    }
  }

  if (!sbConfigured()) return { detailDone, uploaded: false };

  try {
    await sbEnsureAuth();
    statusFn(`${label} — 데이터베이스 업로드 중...`);
    const up = buildSupabasePayload(rows, detailsMap, catUnitMap);

    for (const st of [
      { t: 'categories',    r: up.categories, c: 'category_code' },
      { t: 'products',      r: up.products,   c: 'product_id' },
      { t: 'product_items', r: up.items,      c: 'item_id' }
    ]) {
      for (const part of chunk(st.r, 500)) await sbUpsert(st.t, part, st.c);
    }
    for (const part of chunk(up.history, 500)) {
      try { await sbInsertIgnore('item_history', part); } catch (e) { /* 중복 무시 */ }
    }

    const feeRows = buildFeeRows(feeTables, false).concat(buildFeeRows(feeTablesLow, true));
    for (const part of chunk(feeRows, 500)) {
      await sbUpsert('fulfillment_fees', part, 'unit1,unit2,capacity_type,min_price,is_low_asp');
    }

    if (detailDone) {
      try { await sbMarkCategoryCollected(catCode, 'detail'); } catch (e) { /* 무시 */ }
    }

    return {
      detailDone, uploaded: true,
      productCount: up.products.length, itemCount: up.items.length
    };
  } catch (e) {
    statusFn(`${label} — 업로드 실패 (${e.message})`);
    return { detailDone, uploaded: false, error: e.message };
  }
}

async function runCategoryCollection(withDetail) {
  const targets = getSelected();
  if (targets.length === 0) {
    setStatus('수집할 카테고리가 없습니다. "② 전체 카테고리 불러오기"를 하거나 코드를 직접 입력하세요.', true);
    return { ok: false };
  }

  stopRequested = false;
  startBtn.disabled = true;
  stopBtn.style.display = 'block';
  stopBtn.disabled = false;
  downloadBtn.style.display = 'none';
  collectedRows = [];
  bar.style.display = 'block';
  barFill.style.width = '0%';

  const failures = [];
  const emptyCats = [];
  const pipelineFails = [];
  let detailDoneCount = 0;
  let uploadedCount = 0;
  const startedAt = Date.now();

  /* withDetail이면 카테고리마다 곧바로 2단계(상세)→요금표→업로드까지 끝낸다.
     소비자 탭이 아예 없으면 카테고리마다 반복 실패하므로 미리 한 번만 확인해둔다. */
  let canDetail = !!withDetail;
  if (canDetail) {
    try {
      await getConsumerTab();
    } catch (e) {
      canDetail = false;
      setStatus(
        `❌ 2단계를 실행할 수 없어 1단계(목록)만 진행합니다.\n${e.message}\n\n` +
        `www.coupang.com 탭을 하나 열어둔 뒤 "상세 보강 단독 실행"에서 이어서 진행하세요.`,
        true
      );
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  try {
    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);
    if (found.frameId === null) {
      throw new Error('요청 템플릿이 없습니다. "① 요청 템플릿 확인"을 먼저 수행하세요.');
    }
    const frameId = found.frameId;

    for (let i = 0; i < targets.length; i++) {
      if (stopRequested) break;

      const t = targets[i];
      const label = t.name ? `${t.name} (${t.code})` : t.code;

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const perItem = i > 0 ? elapsed / i : 0;
      const remain = perItem > 0 ? Math.round(perItem * (targets.length - i)) : null;

      setStatus(
        `(${i + 1}/${targets.length}) ${label} 수집 중...\n` +
        `누적 ${collectedRows.length}개 · 경과 ${elapsed}초` +
        (remain !== null ? ` · 예상 잔여 약 ${Math.ceil(remain / 60)}분` : '') +
        (emptyCats.length ? `\n데이터 없음 ${emptyCats.length}건` : '') +
        (failures.length ? `\n실패 ${failures.length}건` : '')
      );

      let payload = null;
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          func: pageCollectCategory,
          args: [t.code, t.name || '', t.altCode || null]
        });
        payload = r && r.result;
      } catch (e) {
        payload = { ok: false, error: e.message };
      }

      const catRows = [];
      if (!payload || !payload.ok) {
        failures.push(`${label}: ${payload ? payload.error : '알 수 없는 오류'}`);
      } else if (payload.empty) {
        emptyCats.push(label);
      } else {
        for (const it of payload.items) {
          const hierarchy = it.displayCategoryInfos && it.displayCategoryInfos[0]
            ? it.displayCategoryInfos[0].categoryHierarchy
            : '';
          const row = {
            categoryCode: t.code,
            categoryName: t.name || '',
            categoryHierarchy: hierarchy,
            imagePath: it.imagePath || '',
            categoryId: it.categoryId || '',
            productName: it.productName,
            itemName: it.itemName,
            brandName: it.brandName,
            manufacture: it.manufacture,
            salesPrice: it.salesPrice ? it.salesPrice.amount : '',
            rating: it.rating,
            ratingCount: it.ratingCount,
            pvLast28dRank: it.pvLast28dRank,
            pvRange: pvRangeText(it.lowerPvLast28d, it.upperPvLast28d),
            lowerPvLast28d: cleanPv(it.lowerPvLast28d),
            upperPvLast28d: cleanPv(it.upperPvLast28d),
            listingEligibility: it.listingEligibility,
            itemId: it.itemId,
            productId: it.productId,
            vendorItemId: it.vendorItemId
          };
          collectedRows.push(row);
          catRows.push(row);
        }
      }

      barFill.style.width = Math.round(((i + 1) / targets.length) * 100) + '%';
      await saveProgress();
      if (sbConfigured() && catRows.length) {
        try { await sbMarkCategoryCollected(t.code, 'list'); } catch (e) { /* 무시 */ }
      }

      if (canDetail && catRows.length && !stopRequested) {
        try {
          const r = await finishCategoryPipeline(t.code, catRows, { statusFn: setStatus, label, tab });
          if (r.detailDone) detailDoneCount++;
          if (r.uploaded) uploadedCount++;
          else if (r.error) pipelineFails.push(`${label}: ${r.error}`);
        } catch (e) {
          pipelineFails.push(`${label}: ${e.message}`);
        }
      }

      if (i < targets.length - 1 && !stopRequested) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    await saveProgress();

    let summary = stopRequested
      ? `중지되었습니다. 총 ${collectedRows.length}개 수집.`
      : `완료! 총 ${collectedRows.length}개 상품 수집.`;
    if (canDetail) {
      summary += `\n상세 보강 완료 카테고리 ${detailDoneCount}건`;
      if (sbConfigured()) summary += ` · DB 업로드 완료 ${uploadedCount}건`;
    }
    if (emptyCats.length) {
      summary += `\n\n데이터 없음 ${emptyCats.length}건 (카테고리는 있으나 인기상품 데이터가 없음):\n` +
        emptyCats.slice(0, 10).join('\n');
      if (emptyCats.length > 10) summary += `\n...외 ${emptyCats.length - 10}건`;
    }
    if (failures.length) {
      summary += `\n\n수집 실패 ${failures.length}건:\n` + failures.slice(0, 12).join('\n');
      if (failures.length > 12) summary += `\n...외 ${failures.length - 12}건`;
    }
    if (pipelineFails.length) {
      summary += `\n\n상세보강/업로드 실패 ${pipelineFails.length}건:\n` + pipelineFails.slice(0, 12).join('\n');
      if (pipelineFails.length > 12) summary += `\n...외 ${pipelineFails.length - 12}건`;
    }
    setStatus(summary, collectedRows.length === 0);

    if (collectedRows.length > 0) downloadBtn.style.display = 'block';

    const detailCount = Object.keys(detailsMap).length;
    if (detailCount > 0) detailDownloadBtn.style.display = 'block';
    if (canDetail) {
      const topN = parseInt(detailTopNEl.value, 10) || 0;
      const perOption = detailPerOptionEl.checked;
      detailIdsEl.value = uniqueProductIdsFromRows(topN, perOption).join('\n');
    }
  } catch (err) {
    setStatus('오류: ' + err.message, true);
    if (collectedRows.length > 0) {
      await saveProgress();
      downloadBtn.style.display = 'block';
    }
  } finally {
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  }

  return { ok: true, stopped: stopRequested, rows: collectedRows.length };
}


/* ===================== 통합 실행 =====================
   2단계(상세 보강)를 켜두면 카테고리 하나가 끝날 때마다 그 안에서 곧바로
   상세수집 → 요금표 확인 → DB 업로드까지 끝낸다(runCategoryCollection 내부).
   그래서 여기서는 그냥 실행하고 결과를 보여주기만 하면 된다. */
startBtn.addEventListener('click', async () => {
  const withDetail = detailEnabledEl.checked;
  const r1 = await runCategoryCollection(withDetail);
  if (!r1 || !r1.ok) return;
  downloadBtn.style.display = collectedRows.length > 0 ? 'block' : 'none';
});

detailStartBtn.addEventListener('click', async () => {
  await runDetailCollection();
});

downloadBtn.addEventListener('click', () => {
  const px = cellImgSizeEl ? (parseInt(cellImgSizeEl.value, 10) || 150) : 150;
  const outRows = applyTopNFilter(collectedRows);
  const csv = '\uFEFF' + buildCsv(outRows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `coupang_products_${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: true
  });

  setStatus(
    `CSV를 저장합니다. (${outRows.length}행` +
    (outRows.length !== collectedRows.length ? ` · 전체 ${collectedRows.length}행에서 상위 N개로 추림` : '') +
    `)\n\n` +
    `[엑셀에서 이미지가 잘려 보일 때]\n` +
    `A열 너비와 전체 행 높이를 이미지 크기(${px}px)보다 크게 조정하세요.\n` +
    `  · 행 높이: 전체 선택(Ctrl+A) → 행 머리글 우클릭 → 행 높이 → 약 ${Math.round(px * 0.78)}\n` +
    `  · 열 너비: A열 머리글 우클릭 → 열 너비 → 약 ${Math.round(px / 7)}\n\n` +
    `구글 시트를 쓰시면 이미지 크기에 맞춰 자동 조정됩니다.`
  );
});

/* ===================== ③ 카테고리 목록 내보내기 ===================== */
const CATEGORY_CSV_HEADERS = [
  'categoryCode', 'categoryName', 'categoryPath', 'depth', 'isLeaf', 'selected'
];

function buildCategoryCsv(list) {
  const lines = [
    ['카테고리코드', '대체코드', '카테고리명', '전체경로', '단계', '말단여부', '현재선택', '점검_상품수'].join(',')
  ];
  for (const c of list) {
    lines.push([
      toCsvValue(c.code),
      toCsvValue(c.altCode || ''),
      toCsvValue(c.name),
      toCsvValue(c.path),
      toCsvValue(c.depth),
      toCsvValue(c.isLeaf ? 'Y' : 'N'),
      toCsvValue(c.selected ? 'Y' : 'N'),
      toCsvValue(c.probeCount === undefined ? '' : c.probeCount)
    ].join(','));
  }
  return lines.join('\n');
}

exportCatBtn.addEventListener('click', () => {
  if (!categories || categories.length === 0) {
    setStatus('먼저 "② 전체 카테고리 불러오기"를 실행해주세요.', true);
    return;
  }

  const leaves = categories.filter((c) => c.isLeaf);
  if (leaves.length === 0) {
    setStatus('말단 카테고리가 없습니다.', true);
    return;
  }

  const csv = '\uFEFF' + buildCategoryCsv(leaves);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: `coupang_categories_${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: true
  });

  setStatus(
    `말단 카테고리 ${leaves.length}개를 CSV로 내보냅니다.\n` +
    `컬럼: 카테고리코드 / 대체코드 / 이름 / 전체경로 / 단계 / 말단여부 / 현재선택 / 점검_상품수`
  );
});

/* ===================== 빠른 점검 (데이터 없는 카테고리 자동 해제) ===================== */
probeBtn.addEventListener('click', async () => {
  const targets = categories.filter((c) => c.selected === true);
  if (targets.length === 0) {
    setStatus('점검할 선택된 카테고리가 없습니다.', true);
    return;
  }

  stopRequested = false;
  probeBtn.disabled = true;
  startBtn.disabled = true;
  stopBtn.style.display = 'block';
  stopBtn.disabled = false;
  bar.style.display = 'block';
  barFill.style.width = '0%';

  let withData = 0;
  let empty = 0;
  let errors = 0;
  const startedAt = Date.now();

  try {
    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);
    if (found.frameId === null) throw new Error('요청 템플릿이 없습니다. ①을 먼저 수행하세요.');

    for (let i = 0; i < targets.length; i++) {
      if (stopRequested) break;
      const c = targets[i];

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const perItem = i > 0 ? elapsed / i : 0;
      const remain = perItem > 0 ? Math.ceil(perItem * (targets.length - i) / 60) : null;

      setStatus(
        `빠른 점검 (${i + 1}/${targets.length}) ${c.name}\n` +
        `데이터 있음 ${withData} · 없음 ${empty} · 오류 ${errors}` +
        (remain !== null ? `\n예상 잔여 약 ${remain}분` : '')
      );

      let r = null;
      try {
        const [x] = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [found.frameId] },
          func: pageProbeCategory,
          args: [c.code, c.name || '']
        });
        r = x && x.result;
      } catch (e) { r = { ok: false }; }

      if (!r || !r.ok) {
        errors++;
      } else if (r.totalCount > 0) {
        withData++;
        c.probeCount = r.totalCount;
      } else {
        empty++;
        c.selected = false;
        c.probeCount = 0;
      }

      barFill.style.width = Math.round(((i + 1) / targets.length) * 100) + '%';
      await new Promise((res) => setTimeout(res, 250));
    }

    renderCategories();
    setStatus(
      (stopRequested ? '점검 중지됨.\n\n' : '빠른 점검 완료.\n\n') +
      `데이터 있음 ${withData}개 (선택 유지)\n` +
      `데이터 없음 ${empty}개 (자동으로 체크 해제됨)\n` +
      `오류 ${errors}개\n\n` +
      `이제 "수집 시작"을 누르면 데이터가 있는 카테고리만 수집합니다.`
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  } finally {
    probeBtn.disabled = false;
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
});

/* ===================== 진단 ===================== */
apiLogBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const results = await runInAllFrames(tab.id, pageReadApiLog);
    // 프레임 간 sessionStorage가 공유되므로 중복 제거
    const seen = new Set();
    const lines = [];
    results.forEach((fr) => {
      if (!fr || !fr.result) return;
      fr.result.log.forEach((e) => {
        const key = e.method + ' ' + e.url.split('?')[0];
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(`${e.method} ${e.url}`);
      });
    });
    setStatus(
      lines.length
        ? `캡처된 API 호출 ${lines.length}건 (중복 제거):\n\n` + lines.join('\n')
        : '캡처된 API 호출이 없습니다.',
      lines.length === 0
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

templateBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const results = await runInAllFrames(tab.id, pageReadTemplateBody);
    const hit = results.find((r) => r && r.result && r.result.ok);
    if (!hit) {
      setStatus('캡처된 템플릿이 없습니다.', true);
      return;
    }
    let pretty = hit.result.body;
    try { pretty = JSON.stringify(JSON.parse(hit.result.body), null, 2); } catch (e) { /* 원문 */ }
    setStatus(`[요청 바디]\n${pretty}`);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

treeRawBtn.addEventListener('click', () => {
  if (!lastTreeRaw) {
    setStatus('아직 카테고리 응답이 없습니다. "② 전체 카테고리 불러오기"를 먼저 눌러주세요.', true);
    return;
  }
  setStatus(`[카테고리 응답 원문 앞부분]\n\n` + lastTreeRaw);
});

diagCatBtn.addEventListener('click', async () => {
  try {
    const manual = codesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
    let target = null;

    if (manual.length > 0) {
      const known = categories.find((c) => String(c.code) === manual[0]);
      target = {
        code: manual[0],
        name: known ? known.name : '',
        altCode: known ? (known.altCode || null) : null
      };
    } else {
      const sel = getSelected();
      if (sel.length > 0) target = sel[0];
    }

    if (!target) {
      setStatus('진단할 카테고리가 없습니다. "직접 입력" 칸에 코드를 한 줄 넣거나 목록에서 하나 선택하세요.', true);
      return;
    }

    setStatus(`카테고리 ${target.code} 진단 중... (여러 방식으로 시험합니다)`);

    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);
    if (found.frameId === null) {
      setStatus('요청 템플릿이 없습니다. "① 요청 템플릿 확인"을 먼저 수행하세요.', true);
      return;
    }

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [found.frameId] },
      func: pageDiagnoseCategory,
      args: [target.code, target.name || '', target.altCode || null]
    });

    const r = res && res.result;
    if (!r) {
      setStatus('진단 결과를 받지 못했습니다.', true);
      return;
    }

    const lines = [];
    lines.push(`[진단 대상] 코드 ${r.code}` + (r.name ? ` / 이름 "${r.name}"` : ' / 이름 없음'));
    if (r.altCode) lines.push(`[대체 코드] ${r.altCode}`);
    lines.push('');

    if (r.info) {
      lines.push(`[카테고리 존재 확인] /api/info/category/${r.code} → HTTP ${r.info.status}`);
      lines.push(r.info.status === 200
        ? `  응답: ${r.info.preview}`
        : `  이 코드는 인기상품 시스템에 없는 카테고리일 수 있습니다.`);
      lines.push('');
    }

    lines.push('[검색 방식별 결과]');
    r.variants.forEach((v) => {
      if (v.error) {
        lines.push(`  ${v.label} → 오류: ${v.error}`);
      } else {
        lines.push(
          `  ${v.label} → HTTP ${v.status}, totalCount=${v.totalCount}, 반환=${v.itemCount}` +
          (v.preview ? `\n     응답: ${v.preview}` : '')
        );
      }
    });

    const win = r.variants.find((v) => v.itemCount > 0);
    lines.push('');
    lines.push(win
      ? `✅ "${win.label}" 방식에서 결과가 나옵니다. 수집 시 이 방식이 자동 선택됩니다.`
      : `❌ 모든 방식에서 0건입니다. 이 카테고리에는 인기상품 데이터 자체가 없을 가능성이 높습니다.`);

    setStatus(lines.join('\n'), !win);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


inspectBtn.addEventListener('click', async () => {
  try {
    const manual = codesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
    let target = null;
    if (manual.length > 0) {
      const known = categories.find((c) => String(c.code) === manual[0]);
      target = { code: manual[0], name: known ? known.name : '' };
    } else {
      const sel = getSelected();
      if (sel.length > 0) target = sel[0];
    }
    if (!target) {
      setStatus('먼저 카테고리를 하나 선택하거나 "직접 입력"에 코드를 넣어주세요.', true);
      return;
    }

    setStatus('상품 원본 필드를 확인하는 중...');

    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);
    if (found.frameId === null) {
      setStatus('요청 템플릿이 없습니다. ①을 먼저 수행하세요.', true);
      return;
    }

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [found.frameId] },
      func: pageInspectFields,
      args: [target.code, target.name || '']
    });

    const r = res && res.result;
    if (!r) { setStatus('결과를 받지 못했습니다.', true); return; }

    const lines = [];
    lines.push('[정렬 옵션 API] /trends/sort-by-sales-count');
    lines.push(`  HTTP ${r.sortApi ? r.sortApi.status : '?'}`);
    lines.push(`  응답: ${r.sortApi ? r.sortApi.body : ''}`);
    lines.push('');

    if (r.itemError) {
      lines.push('[상품 원본] 오류: ' + r.itemError);
    } else {
      lines.push('[응답 최상위 키] ' + (r.topLevelKeys || []).join(', '));
      lines.push('');
      lines.push('[상품 1건의 전체 필드]');
      lines.push((r.itemKeys || []).join(', '));
      lines.push('');
      lines.push('[상품 1건 원본 JSON]');
      lines.push(JSON.stringify(r.item, null, 2));
    }

    setStatus(lines.join('\n'));
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


salesBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const results = await runInAllFrames(tab.id, pageReadSalesCaptures);
    const store = {};
    results.forEach((fr) => {
      if (!fr || !fr.result || !fr.result.store) return;
      Object.assign(store, fr.result.store);
    });
    const entries = Object.entries(store);
    if (!entries.length) {
      setStatus('캡처된 판매현황 API가 없습니다. WING 재고현황 페이지를 새로고침한 뒤 다시 시도하세요.', true);
      return;
    }
    const text = entries.map(([path, c]) =>
      `--- ${c.method} ${c.url}\n[요청 헤더]\n${c.headers ? JSON.stringify(c.headers, null, 2) : '(없음)'}\n[요청 바디]\n${c.reqBody || '(없음)'}\n[응답]\n${c.resText || '(없음)'}`
    ).join('\n\n');
    setStatus(text);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

/* 판매분석 화면이 어떤 API를 부르는지 실물로 본다. 이 화면에 방문자·조회·장바구니·
   주문과 광고 성과·유입경로가 다 있어서, 엑셀을 받지 않고 그대로 가져올 수 있다.
   **응답이 크므로 경로별 요약을 먼저 보여준다** — 전문은 각 항목 앞부분만 낸다. */
/* 판매분석 화면이 어떤 API를 부르는지 실물로 본다. 이 화면에 방문자·조회·장바구니·
   주문과 유입경로가 다 있어서, 엑셀을 받지 않고 그대로 가져올 수 있다.
   광고비는 여기서 '요약'만 나오므로 참고용이다 — 상세 내역은 별도 데이터로 받는다.
   **응답이 크므로 경로별로 앞부분만 낸다.** */
insightBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const results = await runInAllFrames(tab.id, pageReadInsightCaptures);
    const store = {};
    results.forEach((fr) => {
      if (!fr || !fr.result || !fr.result.store) return;
      Object.assign(store, fr.result.store);
    });
    const entries = Object.entries(store);
    if (!entries.length) {
      /* 접두사를 잘못 짚었을 수 있다. 그때는 **모든 WING 요청 기록**을 대신 보여준다 —
         interceptor가 coupang.com 요청을 전부 기록하고 있으므로 진짜 경로가 반드시
         이 안에 있다. 추측으로 접두사를 또 바꾸느니 실물 목록에서 고르는 게 빠르다. */
      const logRes = await runInAllFrames(tab.id, pageReadApiLog);
      const seen = {};
      const urls = [];
      logRes.forEach(function (fr) {
        if (!fr || !fr.result || !fr.result.log) return;
        fr.result.log.forEach(function (e) {
          if (seen[e.sig]) return;
          seen[e.sig] = 1;
          urls.push(e.method + ' ' + e.url
            + (e.reqBody ? '\n      [바디] ' + e.reqBody.slice(0, 300) : ''));
        });
      });
      if (!urls.length) {
        setStatus('캡처가 없습니다.\n'
          + '판매 분석 페이지를 **새로 열어야** 합니다 — 수집기는 페이지가 열릴 때 붙습니다.\n'
          + '(확장프로그램을 새로고침했다면 열려 있던 WING 탭도 새로고침하세요.)', true);
        return;
      }
      setStatus('비즈니스 인사이트 경로로 잡힌 건 없습니다.\n'
        + '대신 이 탭이 부른 요청 ' + urls.length + '건을 그대로 보여줍니다 — 여기서 실제 경로를 찾습니다.\n\n'
        + urls.join('\n'));
      return;
    }
    const parts = entries.map(function (e) {
      const path = e[0], c = e[1];
      return '--- ' + c.method + ' ' + path
        + '\n' + '[전체 URL] ' + c.url
        + '\n' + '[요청 바디] ' + (c.reqBody || '(없음)')
        + '\n' + '[응답 앞부분]' + '\n' + (c.resText || '(없음)').slice(0, 6000);
    });
    setStatus('캡처된 엔드포인트 ' + entries.length + '개\n\n' + parts.join('\n\n'));
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

consumerBtn.addEventListener('click', async () => {
  try {
    const tab = await getConsumerTab();

    const logResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageReadApiLog
    });
    const payloadResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageReadProductPayloads
    });

    const seen = new Set();
    const urls = [];
    logResults.forEach((fr) => {
      if (!fr || !fr.result) return;
      fr.result.log.forEach((e) => {
        const k = e.method + ' ' + e.url.split('?')[0];
        if (seen.has(k)) return;
        seen.add(k);
        urls.push(`${e.method} ${e.url}`);
      });
    });

    const payloads = [];
    const seenP = new Set();
    payloadResults.forEach((fr) => {
      if (!fr || !fr.result || !fr.result.store) return;
      Object.entries(fr.result.store).forEach(([url, text]) => {
        if (seenP.has(url)) return;
        seenP.add(url);
        payloads.push(`--- ${url} (${text.length}bytes)\n${String(text).slice(0, 900)}`);
      });
    });

    setStatus(
      `[현재 탭] ${tab.url}\n\n` +
      `[캡처된 요청 ${urls.length}건]\n` + (urls.join('\n') || '(없음)') +
      `\n\n[상품 관련 JSON 응답 ${payloads.length}건]\n` +
      (payloads.join('\n\n') || '(없음 — 상품 페이지를 새로고침한 뒤 다시 시도하세요)')
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


productProbeBtn.addEventListener('click', async () => {
  try {
    const pid = (prodIdEl.value || '').trim();
    if (!pid) {
      setStatus('점검할 productId를 입력하세요. (예: 23464171617)', true);
      return;
    }

    const tab = await getConsumerTab();
    setStatus('상품 페이지를 점검하는 중...');

    // 1) 인터셉터 설치 여부
    let installed = null;
    try {
      const [chk] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: pageCheckInstalled
      });
      installed = chk && chk.result;
    } catch (e) {
      installed = { installed: false, error: e.message };
    }

    // 2) 상품 페이지 원문 점검
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageProbeProductPage,
      args: [pid]
    });
    const r = res && res.result;

    const lines = [];
    lines.push('[인터셉터 설치 상태]');
    lines.push(installed && installed.installed
      ? '  ✅ 설치됨 (페이지 후킹 가능)'
      : '  ❌ 설치 안 됨 — 이 사이트는 페이지 후킹이 차단됩니다. HTML 직접 파싱 방식으로 가야 합니다.');
    lines.push('');

    if (!r || !r.ok) {
      lines.push('[페이지 요청 실패] ' + (r ? r.error : '결과 없음'));
      setStatus(lines.join('\n'), true);
      return;
    }

    lines.push('[페이지 요청 결과]');
    lines.push(`  HTTP ${r.status} / 크기 ${(r.size / 1024).toFixed(0)}KB / HTML여부 ${r.isHtml ? 'Y' : 'N'}`);
    lines.push(`  최종 URL: ${r.finalUrl}`);
    lines.push(`  앞부분: ${r.head}`);
    lines.push('');

    lines.push(`[찾은 단서 ${r.hits.length}개]`);
    if (r.hits.length === 0) {
      lines.push('  없음 — 봇 차단 페이지이거나, 정보가 별도 요청으로 채워집니다.');
    } else {
      r.hits.forEach((h) => {
        lines.push(`  · "${h.marker}" (위치 ${h.index})`);
        lines.push(`    ...${h.around}...`);
      });
    }

    setStatus(lines.join('\n'), r.hits.length === 0);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});



/* ===================== 사전 필터 (페이지 받기 전 대상 축소) ===================== */
function readPreFilter() {
  function num(el) {
    if (!el) return 0;
    const v = parseInt(el.value, 10);
    return isNaN(v) || v < 0 ? 0 : v;
  }
  return {
    rankMax: num(fRankMax),
    pvMin: num(fPvMin),
    pvMax: num(fPvMax),
    reviewMin: num(fReviewMin),
    reviewMax: num(fReviewMax),
    priceMin: num(fPriceMin),
    priceMax: num(fPriceMax),
    excludeSoldOut: fExcludeInvalid ? fExcludeInvalid.checked : false
  };
}

function passesPreFilter(r, f) {
  if (f.rankMax > 0) {
    const rk = typeof r.pvLast28dRank === 'number' ? r.pvLast28dRank : 99999;
    if (rk > f.rankMax) return false;
  }
  // 조회수는 구간으로 오므로 겹치는지로 판단합니다
  if (f.pvMin > 0) {
    const up = typeof r.upperPvLast28d === 'number' ? r.upperPvLast28d : 0;
    if (up > 0 && up < f.pvMin) return false;
  }
  if (f.pvMax > 0) {
    const lo = typeof r.lowerPvLast28d === 'number' ? r.lowerPvLast28d : 0;
    if (lo > f.pvMax) return false;
  }
  if (f.reviewMin > 0 && (r.ratingCount || 0) < f.reviewMin) return false;
  if (f.reviewMax > 0 && (r.ratingCount || 0) > f.reviewMax) return false;
  if (f.priceMin > 0 && (Number(r.salesPrice) || 0) < f.priceMin) return false;
  if (f.priceMax > 0 && (Number(r.salesPrice) || 0) > f.priceMax) return false;
  if (f.excludeSoldOut && r.listingEligibility && r.listingEligibility !== 'VALID') return false;
  return true;
}

/* 사후 필터: 판매량은 페이지를 받아야 알 수 있으므로 저장 단계에서 걸러냅니다 */
function readSalesFilter() {
  const mn = fSalesMin ? parseInt(fSalesMin.value, 10) : NaN;
  const mx = fSalesMax ? parseInt(fSalesMax.value, 10) : NaN;
  return {
    min: isNaN(mn) || mn < 0 ? 0 : mn,
    max: isNaN(mx) || mx < 0 ? 0 : mx,
    enabled: (!isNaN(mn) && mn > 0) || (!isNaN(mx) && mx > 0)
  };
}

function passesSalesFilter(detail, f) {
  if (!f.enabled) return true;
  const n = typeof detail.salesNumber === 'number' ? detail.salesNumber : 0;
  if (f.min > 0 && n < f.min) return false;
  if (f.max > 0 && n > f.max) return false;
  return true;
}

/* ===================== ④ 상품 상세 보강 ===================== */
function detailKey(pid, iid, perOption) {
  return perOption && iid ? String(pid) + '_' + String(iid) : String(pid);
}

function uniqueProductIdsFromRows(topN, perOption, sourceRows) {
  // 사전 필터를 먼저 적용해 페이지를 받을 대상 자체를 줄입니다.
  // sourceRows를 넘기면(카테고리 하나씩 처리할 때) 전체 collectedRows 대신 그 부분집합만 쓴다.
  const pf = readPreFilter();
  const filtered = (sourceRows || collectedRows).filter((r) => passesPreFilter(r, pf));

  const byCat = {};
  filtered.forEach((r) => {
    const cat = r.categoryCode || '';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(r);
  });

  const picked = [];
  Object.keys(byCat).forEach((cat) => {
    const rows = byCat[cat].slice().sort((a, b) => {
      const ra = typeof a.pvLast28dRank === 'number' ? a.pvLast28dRank : 99999;
      const rb = typeof b.pvLast28dRank === 'number' ? b.pvLast28dRank : 99999;
      return ra - rb;
    });
    const limit = topN > 0 ? topN : rows.length;
    const seenInCat = new Set();
    for (const r of rows) {
      if (!r.productId) continue;
      const k = detailKey(r.productId, r.itemId, perOption);
      if (seenInCat.has(k)) continue;
      seenInCat.add(k);
      picked.push([r.productId, r.itemId || '', r.vendorItemId || ''].join(','));
      if (seenInCat.size >= limit) break;
    }
  });

  const seenAll = new Set();
  return picked.filter((line) => {
    const p = line.split(',');
    const k = detailKey(p[0], p[1], perOption);
    if (seenAll.has(k)) return false;
    seenAll.add(k);
    return true;
  });
}

detailFromDataBtn.addEventListener('click', () => {
  if (collectedRows.length === 0) {
    setStatus('먼저 상품 수집을 하거나, productId를 직접 입력하세요.', true);
    return;
  }
  const topN = parseInt(detailTopNEl.value, 10) || 0;
  const perOption = detailPerOptionEl.checked;
  const ids = uniqueProductIdsFromRows(topN, perOption);
  detailIdsEl.value = ids.join('\n');

  const totalRows = collectedRows.length;
  const allUnique = new Set(
    collectedRows.map((r) => detailKey(r.productId, r.itemId, perOption))
  ).size;
  setStatus(
    `수집 데이터 ${totalRows}행 → 고유 ${perOption ? '옵션' : '상품'} ${allUnique}개\n` +
    (topN > 0 ? `카테고리별 상위 ${topN}개만 추림 → ` : '전체 → ') +
    `대상 ${ids.length}개\n\n` +
    `예상 트래픽 약 ${(ids.length * 0.3).toFixed(0)}MB, ` +
    `예상 시간 약 ${Math.ceil(ids.length * ((parseInt(detailDelayEl.value, 10) || 1500) / 1000) / 60)}분`
  );
});

detailStopBtn.addEventListener('click', () => {
  detailStop = true;
  detailStopBtn.disabled = true;
});

async function runDetailCollection(idLines) {
  const source = Array.isArray(idLines) ? idLines : detailIdsEl.value.split('\n');
  const ids = source.map((s) => String(s).trim()).filter(Boolean)
    .map((line) => {
      const p = line.split(',').map((x) => x.trim());
      return { pid: p[0], iid: p[1] || '', vid: p[2] || '' };
    })
    .filter((x) => x.pid);

  if (ids.length === 0) {
    setStatus('대상 productId가 없습니다.', true);
    return { ok: false };
  }

  const perOptionRun = detailPerOptionEl.checked;
  const earlyStopRun = earlyStopEl.checked;
  const salesFilter = readSalesFilter();

  const doCalibrate = calibrateEl && calibrateEl.checked;
  const ceilingRpm = Math.max(5, parseInt(rpmLimitEl.value, 10) || 50);

  governor = new RateGovernor({
    startConc: Math.max(1, parseInt(startConcEl.value, 10) || 2),
    maxConc: Math.max(1, parseInt(maxConcEl.value, 10) || 5),
    // 탐색 모드면 낮게 시작해 서서히 올립니다
    rpmLimit: doCalibrate ? Math.max(5, Math.floor(ceilingRpm * 0.3)) : ceilingRpm,
    baseDelay: Math.max(200, parseInt(detailDelayEl.value, 10) || 1500),
    calibrate: doCalibrate
  });
  governor.rpmCeiling = ceilingRpm;
  if (doCalibrate) {
    governor.addLog(0, '탐색시작', `분당 ${governor.rpmLimit}에서 시작해 ${ceilingRpm}까지 단계적으로 시험합니다`, '임계점 탐색 개시');
  }

  let lastProbeAt = 0;

  detailStop = false;
  detailStartBtn.disabled = true;
  stopBtn.style.display = 'block';
  stopBtn.disabled = false;
  detailStopBtn.style.display = 'block';
  detailStopBtn.disabled = false;
  bar.style.display = 'block';
  barFill.style.width = '0%';

  let done = 0;
  let fail = 0;
  let blocked = 0;
  let notFoundCount = 0;
  let bytesTotal = 0;
  let earlyCount = 0;
  let processed = 0;
  let filteredOut = 0;
  let consecutivePause = 0;
  let aborted = false;

  const startedAt = Date.now();
  let tab;

  try {
    tab = await getConsumerTab();
  } catch (err) {
    setStatus('오류: ' + err.message, true);
    detailStartBtn.disabled = false;
    stopBtn.style.display = 'none';
    detailStopBtn.style.display = 'none';
    return { ok: false };
  }

  // 순서를 섞어 패턴을 흐립니다 (같은 카테고리 연속 조회 방지)
  const queue = ids.slice();
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
  }

  let cursor = 0;

  function updateStatus(current) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const per = processed > 0 ? elapsed / processed : 0;
    const remainMin = per > 0 ? Math.ceil(per * (ids.length - processed) / 60) : null;

    setStatus(
      `상세 수집 (${processed}/${ids.length})` + (current ? ` · 현재 ${current}` : '') + `\n` +
      `성공 ${done} · 없는상품 ${notFoundCount} · 실패 ${fail} · 차단의심 ${blocked}` +
      (filteredOut > 0 ? ` · 필터제외 ${filteredOut}` : '') + `\n` +
      `조기중단 ${earlyCount}건 · 전송 ${(bytesTotal / 1048576).toFixed(1)}MB` +
      (done > 0 ? ` (평균 ${Math.round(bytesTotal / 1024 / Math.max(done, 1))}KB)` : '') + `\n` +
      governor.summary() +
      (remainMin !== null ? `\n예상 잔여 약 ${remainMin}분` : '')
    );
  }

  /* 한 건 처리 */
  async function processOne(item) {
    const key = detailKey(item.pid, item.iid, perOptionRun);
    if (detailsMap[key]) {
      processed++;
      return;
    }

    // 분당 상한 대기
    const wait = governor.waitForSlot();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    governor.markRequest();
    const t0 = Date.now();

    let r = null;
    try {
      const [x] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageFetchProductDetail,
        args: [item.pid, item.iid, item.vid, earlyStopRun]
      });
      r = x && x.result;
    } catch (e) {
      r = { ok: false, error: e.message };
    }

    const ms = Date.now() - t0;
    processed++;

    if (r && r.ok) {
      if (typeof r.size === 'number') bytesTotal += r.size;
      if (r.earlyStopped) earlyCount++;

      if (r.notFound) {
        detailsMap[key] = r;
        notFoundCount++;
      } else if (passesSalesFilter(r, salesFilter)) {
        detailsMap[key] = r;
        done++;
      } else {
        filteredOut++;   // 판매량 조건에 안 맞아 저장하지 않음
      }
    } else if (r && r.blocked) {
      blocked++;
    } else {
      fail++;
    }

    // 위협 평가 (5개 신호원 종합)
    const assessment = governor.assess({
      ok: !!(r && r.ok),
      status: r ? r.status : 0,
      size: r ? r.size : 0,
      blocked: !!(r && r.blocked),
      notFound: !!(r && r.notFound),
      ttfb: r ? r.ttfb : null,
      redirected: r ? r.redirected : false,
      finalUrl: r ? r.finalUrl : '',
      abck: r ? r.abck : '',
      retryAfter: r ? r.retryAfter : '',
      ms
    });

    const verdict = governor.react(assessment);

    if (verdict.action === 'COOLDOWN' || verdict.action === 'PAUSE') {
      const isBlock = verdict.action === 'PAUSE';
      if (isBlock) consecutivePause++; 

      const waitSec = verdict.waitSec || 60;
      const lvName = ['정상', '주의', '경고', '위험', '차단'][verdict.level];

      setStatus(
        `${isBlock ? '🛑' : '⚠'} [${lvName}] 경보 — ${waitSec}초 냉각 후 재개\n\n` +
        verdict.signals.map((sg) => `· ${sg.cat}: ${sg.detail}`).join('\n') +
        `\n\n대응: 동시 ${governor.conc} · 분당상한 ${governor.rpmLimit} · 간격 ${governor.delayMultiplier.toFixed(2)}배\n` +
        `진행 ${processed}/${ids.length} · 성공 ${done}`
      );

      if (consecutivePause >= 4) {
        aborted = true;
        return;
      }

      for (let w = 0; w < waitSec && !detailStop; w++) {
        await new Promise((rr) => setTimeout(rr, 1000));
      }

      // 카나리: 탐침으로 회복 여부를 먼저 확인
      try {
        const [pr] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: pageProbeServer
        });
        const p = pr && pr.result;
        governor.recordProbe(p);
        if (p && p.ok) {
          governor.addLog(0, '회복확인', `탐침 정상 (${p.ms}ms)`, '수집 재개');
        } else {
          governor.addLog(3, '회복실패', `탐침 실패 (status ${p ? p.status : '?'})`, '추가 대기');
          for (let w = 0; w < 60 && !detailStop; w++) {
            await new Promise((rr) => setTimeout(rr, 1000));
          }
        }
      } catch (e) { /* 무시 */ }
    } else if (verdict.action === 'OK' || verdict.action === 'UP') {
      consecutivePause = 0;
    }

    /* 주기적 능동 탐침 (90초마다) */
    if (Date.now() - lastProbeAt > 90000) {
      lastProbeAt = Date.now();
      try {
        const [pr] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: pageProbeServer
        });
        governor.recordProbe(pr && pr.result);
      } catch (e) { /* 무시 */ }
    }

    /* 임계점 탐색 진행 */
    if (governor.calibrating && processed > 0 && processed % 15 === 0) {
      governor.calibrateStep();
    }

    barFill.style.width = Math.round((processed / ids.length) * 100) + '%';

    if (processed % 5 === 0) updateStatus(item.pid);
    if (processed % 20 === 0) {
      try { await chrome.storage.local.set({ cwc_details: detailsMap }); } catch (e) {}
    }

    // 요청 간격
    await new Promise((r) => setTimeout(r, governor.nextDelay()));
  }

  /* 워커: 큐에서 하나씩 꺼내 처리 */
  async function worker(id) {
    while (true) {
      if (detailStop || aborted) return;
      if (cursor >= queue.length) return;   // 큐 소진 시 먼저 종료

      // 현재 동시 허용치를 넘는 워커는 잠시 쉼
      if (id >= governor.conc) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const item = queue[cursor++];
      try {
        await processOne(item);
      } catch (e) {
        fail++;
        processed++;
      }
    }
  }

  try {
    const workers = [];
    for (let i = 0; i < governor.maxConc; i++) workers.push(worker(i));
    await Promise.all(workers);

    try { await chrome.storage.local.set({ cwc_details: detailsMap }); } catch (e) {}

    let msg;
    if (aborted) {
      msg = `❌ 반복적인 차단 신호로 중단했습니다.\n\n` +
            `진행 ${processed}/${ids.length} · 성공 ${done}\n` +
            `잠시 뒤(30분 이상 권장) 다시 시작하면 받은 것은 건너뜁니다.\n` +
            `재시작 시 시작 동시 수를 1로, 간격을 3000ms 이상으로 올리세요.`;
    } else if (detailStop) {
      msg = `중지되었습니다.\n진행 ${processed}/${ids.length} · 성공 ${done}`;
    } else {
      msg = (done === 0 && notFoundCount === 0
        ? `⚠ 상세 수집 결과가 0건입니다.\n` +
          `대상 ${ids.length}건 중 실제 요청 ${processed}건 · 실패 ${fail} · 차단의심 ${blocked}\n` +
          (processed === 0
            ? `\n모두 이미 저장된 데이터라 건너뛰었습니다.\n진단 → "저장된 상세 데이터 초기화" 후 다시 시도하세요.\n\n`
            : `\n진단 → "상품 1건 상세 파싱 테스트"로 개별 확인해보세요.\n\n`)
        : `상세 수집 완료.\n`) +
            `성공 ${done} · 없는상품 ${notFoundCount} · 실패 ${fail} · 차단의심 ${blocked}` +
            (filteredOut > 0 ? ` · 판매량필터 제외 ${filteredOut}` : '') + `\n` +
            `조기중단 ${earlyCount}건 · 총 전송 ${(bytesTotal / 1048576).toFixed(1)}MB ` +
            `(평균 ${Math.round(bytesTotal / 1024 / Math.max(done, 1))}KB/건)\n` +
            `소요 ${Math.round((Date.now() - startedAt) / 60000)}분 · ${governor.summary()}\n\n` +
            `"CSV 다운로드"로 받거나 "수집 결과 검증 리포트"로 상태를 확인하세요.`;
    }
    setStatus(msg, aborted);

    if (Object.keys(detailsMap).length > 0) detailDownloadBtn.style.display = 'block';
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  } finally {
    detailStartBtn.disabled = false;
    detailStopBtn.style.display = 'none';
    stopBtn.style.display = 'none';
  }

  return { ok: true, done, fail, blocked, notFound: notFoundCount, stopped: detailStop || aborted };
}

detailDownloadBtn.addEventListener('click', () => {
  const rows = Object.values(detailsMap);
  const headers = ['productId', 'salesText', 'salesNumber', 'deliveryBadge', 'soldOut', 'notFound'];
  const lines = [['상품ID', '옵션ID', '상품명', '판매량표기', '판매량숫자', '현재가격', '정가', '가격근거', '배송유형', '판정근거', '배송비', '택배사', '판매자', '품절', '없는상품', '사용URL'].join(',')];
  rows.forEach((r) => {
    lines.push([
      toCsvValue(r.productId),
      toCsvValue(r.itemId || ''),
      toCsvValue((r.pageTitle || '').replace(/\s*[-|]\s*쿠팡!?\s*$/, '')),
      toCsvValue(r.salesText || ''),
      toCsvValue(r.salesNumber === '' || r.salesNumber === undefined ? '' : r.salesNumber),
      toCsvValue(r.salePrice === '' || r.salePrice === undefined ? '' : r.salePrice),
      toCsvValue(r.originPrice === '' || r.originPrice === undefined ? '' : r.originPrice),
      toCsvValue(r.priceBasis || ''),
      toCsvValue(r.deliveryBadge || ''),
      toCsvValue(r.deliveryBasis || ''),
      toCsvValue(r.shippingFee || ''),
      toCsvValue(r.courier || ''),
      toCsvValue(r.sellerName || ''),
      toCsvValue(r.soldOut ? 'Y' : 'N'),
      toCsvValue(r.notFound ? 'Y' : 'N'),
      toCsvValue(r.usedUrl || '')
    ].join(','));
  });

  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `coupang_product_details_${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: true
  });
});


urlTestBtn.addEventListener('click', async () => {
  try {
    const raw = (prodIdEl.value || '').trim();
    if (!raw) {
      setStatus('productId를 입력하세요. 옵션까지 시험하려면 "productId,itemId,vendorItemId" 형식으로 넣으세요.', true);
      return;
    }
    const p = raw.split(',').map((x) => x.trim());
    const tab = await getConsumerTab();

    setStatus('URL 변형을 시험하는 중...');

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageTestUrlVariants,
      args: [p[0], p[1] || '', p[2] || '']
    });

    const list = res && res.result;
    if (!list) { setStatus('결과 없음', true); return; }

    const lines = ['[URL 변형별 결과]'];
    list.forEach((r) => {
      if (r.error) {
        lines.push(`\n· ${r.url}\n  오류: ${r.error}`);
      } else {
        lines.push(
          `\n· ${r.url}\n` +
          `  HTTP ${r.status} / ${(r.size / 1024).toFixed(0)}KB / ` +
          `없는상품 ${r.notFound ? 'Y' : 'N'} / 판매량 ${r.hasSold ? 'Y' : 'N'} / 배송배지 ${r.hasBadge ? 'Y' : 'N'}\n` +
          `  title: ${r.title}`
        );
      }
    });

    const win = list.find((r) => !r.error && !r.notFound && (r.hasSold || r.hasBadge));
    lines.push('');
    lines.push(win
      ? `✅ 이 형식이 작동합니다: ${win.url}`
      : `❌ 모든 형식에서 상품 정보를 얻지 못했습니다. 판매종료된 상품일 가능성이 큽니다.`);

    setStatus(lines.join('\n'), !win);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


resetDetailBtn.addEventListener('click', async () => {
  const n = Object.keys(detailsMap).length;
  detailsMap = {};
  try { await chrome.storage.local.remove('cwc_details'); } catch (e) {}
  detailDownloadBtn.style.display = 'none';
  setStatus(`저장된 상세 데이터 ${n}건을 삭제했습니다. 다시 수집하면 새로 받아옵니다.`);
});

resetRowsBtn.addEventListener('click', async () => {
  const n = collectedRows.length;
  collectedRows = [];
  try { await chrome.storage.local.remove('cwc_rows'); } catch (e) {}
  downloadBtn.style.display = 'none';
  setStatus(`저장된 상품 수집 데이터 ${n}행을 삭제했습니다.`);
});


/* ===================== 수집 결과 검증 리포트 ===================== */
healthBtn.addEventListener('click', () => {
  const details = Object.values(detailsMap);
  const lines = [];

  lines.push('=== 1단계: 상품 수집 ===');
  lines.push(`총 ${collectedRows.length}행`);
  if (collectedRows.length > 0) {
    const cats = new Set(collectedRows.map((r) => r.categoryCode));
    const pids = new Set(collectedRows.map((r) => String(r.productId)));
    const iids = new Set(collectedRows.map((r) => String(r.productId) + '_' + String(r.itemId)));
    const noPid = collectedRows.filter((r) => !r.productId).length;
    lines.push(`카테고리 ${cats.size}개 · 고유 상품 ${pids.size}개 · 고유 옵션 ${iids.size}개`);
    if (noPid > 0) lines.push(`⚠ productId 없는 행 ${noPid}건`);
  }

  lines.push('');
  lines.push('=== 2단계: 상세 보강 ===');
  lines.push(`총 ${details.length}건`);

  if (details.length === 0) {
    lines.push('(아직 보강 데이터가 없습니다)');
    setStatus(lines.join('\n'), true);
    return;
  }

  // 배송 유형 분포
  const byType = {};
  const byBasis = {};
  let noSales = 0;
  let under100 = 0;
  let notFound = 0;
  let unknownType = 0;
  let noPriceCount = 0;

  details.forEach((d) => {
    const t = d.deliveryBadge || '(없음)';
    byType[t] = (byType[t] || 0) + 1;
    const b = d.deliveryBasis || '(없음)';
    byBasis[b] = (byBasis[b] || 0) + 1;
    if (d.notFound) notFound++;
    if (!d.salesText) noSales++;
    if (d.salesNumber === 0) under100++;
    if (d.deliveryBadge === '판정불가') unknownType++;
    if (!d.salePrice && !d.notFound) noPriceCount++;
  });

  lines.push('');
  lines.push('[배송 유형 분포]');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const pct = ((v / details.length) * 100).toFixed(1);
    lines.push(`  ${k}: ${v}건 (${pct}%)`);
  });

  lines.push('');
  lines.push('[판정 근거 분포]');
  Object.entries(byBasis).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    lines.push(`  ${k}: ${v}건`);
  });

  lines.push('');
  lines.push('[판매량]');
  lines.push(`  표기 있음: ${details.length - noSales}건`);
  lines.push(`  100명 미만 추정: ${under100}건`);
  const nums = details.map((d) => d.salesNumber).filter((n) => typeof n === 'number' && n > 0);
  if (nums.length > 0) {
    nums.sort((a, b) => b - a);
    lines.push(`  최대 ${nums[0].toLocaleString()}명 · 중앙값 ${nums[Math.floor(nums.length / 2)].toLocaleString()}명`);
  }

  // 전송량 통계
  const sizes = details.map((d) => d.size).filter((n) => typeof n === 'number' && n > 0);
  if (sizes.length > 0) {
    const total = sizes.reduce((a, b) => a + b, 0);
    const early = details.filter((d) => d.earlyStopped).length;
    lines.push('');
    lines.push('[전송량]');
    lines.push(`  총 ${(total / 1048576).toFixed(1)}MB · 평균 ${Math.round(total / sizes.length / 1024)}KB/건`);
    lines.push(`  조기중단 적용 ${early}/${details.length}건`);
    const saved = (560 * sizes.length - total / 1024) / 1024;
    if (saved > 0) lines.push(`  절감 추정 약 ${saved.toFixed(0)}MB (미적용 시 대비)`);
  }

  // 가격 통계
  const prices = details.map((d) => d.salePrice).filter((n) => typeof n === 'number' && n > 0);
  const noPrice = details.filter((d) => !d.salePrice).length;
  lines.push('');
  lines.push('[가격]');
  lines.push(`  추출 성공 ${prices.length}건 · 실패 ${noPrice}건`);
  if (prices.length > 0) {
    const sorted = prices.slice().sort((a, b) => a - b);
    lines.push(`  최저 ${sorted[0].toLocaleString()}원 · 중앙값 ${sorted[Math.floor(sorted.length / 2)].toLocaleString()}원 · 최고 ${sorted[sorted.length - 1].toLocaleString()}원`);
    const pBasis = {};
    details.forEach((d) => { if (d.priceBasis) pBasis[d.priceBasis] = (pBasis[d.priceBasis] || 0) + 1; });
    lines.push('  근거 분포: ' + Object.entries(pBasis).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`).join(' · '));
  }

  lines.push('');
  lines.push('[이상 항목]');
  lines.push(notFound > 0 ? `  ⚠ 없는 상품 ${notFound}건` : '  없는 상품 0건');
  lines.push(unknownType > 0 ? `  ⚠ 배송유형 판정불가 ${unknownType}건` : '  배송유형 판정불가 0건');
  lines.push(noPriceCount > 0 ? `  ⚠ 가격 추출 실패 ${noPriceCount}건` : '  가격 추출 실패 0건');

  // 판정불가 샘플 제시
  if (unknownType > 0) {
    lines.push('');
    lines.push('[판정불가 샘플 (최대 5건)]');
    details.filter((d) => d.deliveryBadge === '판정불가').slice(0, 5).forEach((d) => {
      lines.push(`  productId ${d.productId} · ${d.pageTitle || ''} · ${d.usedUrl || ''}`);
    });
  }

  // 종합 판정
  lines.push('');
  const badRate = (notFound + unknownType + noPriceCount) / details.length;
  if (badRate === 0) {
    lines.push('✅ 이상 없음. 데이터가 정상적으로 수집되었습니다.');
  } else if (badRate < 0.1) {
    lines.push(`⚠ 이상 비율 ${(badRate * 100).toFixed(1)}% — 대체로 정상입니다.`);
  } else {
    lines.push(`❌ 이상 비율 ${(badRate * 100).toFixed(1)}% — 원인 확인이 필요합니다.`);
  }

  setStatus(lines.join('\n'), badRate >= 0.1);
});

/* 배송 분류를 실제 페이지로 검증 */
detailTestBtn.addEventListener('click', async () => {
  try {
    const raw = (prodIdEl.value || '').trim();
    if (!raw) {
      setStatus('진단 입력칸에 productId 또는 "productId,itemId"를 넣어주세요.', true);
      return;
    }
    const p = raw.split(',').map((x) => x.trim());

    const tab = await getConsumerTab();
    setStatus('상품 상세를 파싱하는 중...');

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFetchProductDetail,
      args: [p[0], p[1] || '', p[2] || '', earlyStopEl.checked]
    });

    const r = res && res.result;
    if (!r) { setStatus('결과 없음', true); return; }
    if (!r.ok) {
      setStatus('실패: ' + (r.error || ('HTTP ' + r.status) + (r.blocked ? ' (차단 의심)' : '')), true);
      return;
    }

    setStatus(
      `[파싱 결과]\n` +
      `상품명: ${r.pageTitle || ''}\n` +
      `사용 URL: ${r.usedUrl}\n` +
      `페이지 크기: ${(r.size / 1024).toFixed(0)}KB` +
      (r.earlyStopped ? ' (조기중단 적용)' : ' (전체 수신)') + `\n\n` +
      `판매량 표기: ${r.salesText || '(없음)'}\n` +
      `판매량 숫자: ${r.salesNumber === '' ? '(없음)' : r.salesNumber}\n\n` +
      `현재 가격: ${r.salePrice === '' ? '(없음)' : Number(r.salePrice).toLocaleString() + '원'}  ← 근거: ${r.priceBasis || '(없음)'}\n` +
      `정가: ${r.originPrice === '' ? '(없음)' : Number(r.originPrice).toLocaleString() + '원'}\n\n` +
      `배송 유형: ${r.deliveryBadge}  ← 판정근거: ${r.deliveryBasis || '(없음)'}\n` +
      `배송비: ${r.shippingFee || '(없음)'}\n` +
      `택배사: ${r.courier || '(없음)'}\n` +
      `판매자: ${r.sellerName || '(없음)'}\n` +
      `품절: ${r.soldOut ? 'Y' : 'N'}\n` +
      `없는상품: ${r.notFound ? 'Y' : 'N'}`
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


speedLogBtn.addEventListener('click', () => {
  if (!governor) {
    setStatus('아직 상세 수집을 실행하지 않았습니다.', true);
    return;
  }

  const g = governor;
  const lines = [];

  lines.push('==== 현재 상태 ====');
  lines.push(g.summary());
  lines.push(`총 요청 ${g.sessionRequests}건`);

  const b = g.baseline();
  const tb = g.ttfbBaseline();
  const pb = g.probeBaseline();
  lines.push('');
  lines.push('==== 기준선 ====');
  lines.push(`  전체 응답: ${b ? Math.round(b) + 'ms' : '(수집 중)'}`);
  lines.push(`  서버 첫응답(TTFB): ${tb ? Math.round(tb) + 'ms' : '(수집 중)'}`);
  lines.push(`  탐침: ${pb ? Math.round(pb) + 'ms' : '(수집 중)'} · 표본 ${g.probeTimes.length}건`);

  if (g.responseTimes.length >= 10) {
    const recent = g.responseTimes.slice(-10);
    const avg = recent.reduce((a, x) => a + x, 0) / recent.length;
    lines.push(`  최근 10건 평균: ${Math.round(avg)}ms` + (b ? ` (기준의 ${(avg / b).toFixed(2)}배)` : ''));
    lines.push(`  최근 10건 p95: ${Math.round(g.percentile(recent, 0.95))}ms`);
  }

  if (g.calSamples.length > 0) {
    lines.push('');
    lines.push('==== 임계점 탐색 기록 ====');
    g.calSamples.forEach((c, i) => {
      lines.push(`  ${i + 1}단계) 분당 ${c.rpm} · 동시 ${c.conc} -> 평균 ${c.avgMs}ms`);
    });
    if (g.safeRpm) lines.push(`  => 확정된 안전 분당상한: ${g.safeRpm}`);
  }

  lines.push('');
  lines.push(`==== 경보 이력 (총 ${g.log.length}건) ====`);
  if (g.log.length === 0) {
    lines.push('  (없음 — 이상 신호가 감지되지 않았습니다)');
  } else {
    const icons = ['·', '△', '▲', '■', 'X'];
    const names = ['정상', '주의', '경고', '위험', '차단'];
    g.log.slice(-40).forEach((e) => {
      const t = new Date(e.t).toLocaleTimeString('ko-KR');
      lines.push('');
      lines.push(`  ${t} ${icons[e.level] || '·'} [${e.category}] ${names[e.level]}`);
      lines.push(`     경위: ${e.detail}`);
      if (e.action) lines.push(`     대응: ${e.action}`);
      lines.push(`     당시 동시 ${e.conc} · 분당 ${e.rpm}` + (e.baseline ? ` · 기준 ${e.baseline}ms` : ''));
    });
    if (g.log.length > 40) lines.push(`\n  ...앞선 ${g.log.length - 40}건 생략`);
  }

  lines.push('');
  lines.push('==== 종합 판단 ====');
  const a = g.alertCounts;
  if (a[4] > 0) {
    lines.push('  [차단] 분당 상한과 동시 수를 크게 낮추고, 시간을 두고 재시도하세요.');
  } else if (a[3] > 0) {
    lines.push('  [위험] 현재 설정이 한계에 가깝습니다. 분당 상한을 20~30% 낮추세요.');
  } else if (a[2] > 2) {
    lines.push('  [경고 반복] 분당 상한을 조금 낮추는 것이 좋습니다.');
  } else if (a[1] > 0) {
    lines.push('  [주의] 자동 조절로 충분히 관리되는 수준입니다.');
  } else {
    lines.push('  [정상] 이상 없음. 여유가 있다면 분당 상한을 올려도 됩니다.');
  }

  setStatus(lines.join('\n'), a[3] > 0 || a[4] > 0);
});


imgTestBtn.addEventListener('click', async () => {
  if (collectedRows.length === 0) {
    setStatus('먼저 상품 수집을 실행하세요. (이미지 경로가 필요합니다)', true);
    return;
  }
  const withImg = collectedRows.find((r) => r.imagePath);
  if (!withImg) {
    setStatus('수집 데이터에 이미지 경로가 없습니다.\n이전 버전으로 수집한 데이터라면 다시 수집해야 합니다.', true);
    return;
  }

  try {
    const tab = await getWingTab();
    setStatus('CDN 주소 형식을 시험하는 중...');

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageTestImageUrls,
      args: [withImg.imagePath, CDN_CANDIDATES]
    });

    const list = res && res.result;
    if (!list) { setStatus('결과 없음', true); return; }

    const lines = [`[테스트 경로]\n${withImg.imagePath}\n`];
    let winner = null;
    list.forEach((r, i) => {
      const okMark = (r.ok && r.isImage && r.bytes > 500) ? '✅' : '❌';
      if (!winner && r.ok && r.isImage && r.bytes > 500) winner = CDN_CANDIDATES[i];
      lines.push(
        `${okMark} ${r.url.slice(0, 78)}\n` +
        `   HTTP ${r.status}` +
        (r.bytes ? ` · ${(r.bytes / 1024).toFixed(0)}KB · ${r.type}` : '') +
        (r.error ? ` · ${r.error}` : '')
      );
    });

    if (winner) {
      cdnTemplate = winner;
      lines.push('');
      lines.push(`✅ 유효한 형식을 찾아 적용했습니다.\n   ${winner}`);
      lines.push('\n이제 CSV를 다운로드하면 이미지가 정상 표시됩니다.');
    } else {
      lines.push('');
      lines.push('❌ 유효한 형식을 찾지 못했습니다.');
      lines.push('쿠팡 윙에서 상품 이미지를 우클릭 → "이미지 주소 복사"한 값을 알려주시면 맞춰드리겠습니다.');
    }

    setStatus(lines.join('\n'), !winner);
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});

/* HTML 갤러리 뷰어 */
htmlViewBtn.addEventListener('click', () => {
  if (collectedRows.length === 0) {
    setStatus('먼저 상품 수집을 실행하세요.', true);
    return;
  }

  const galleryPx = Math.max(60, Math.min(400, parseInt(cellImgSizeEl.value, 10) || 150));
  const rows = applyTopNFilter(collectedRows).slice(0, 3000);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const body = rows.map((r) => {
    const d = detailsMap[String(r.productId) + '_' + String(r.itemId)] ||
              detailsMap[String(r.productId)] || {};
    const img = toImageUrl(r.imagePath);
    const link = toProductUrl(r.productId, r.itemId, r.vendorItemId);
    return `<tr>
<td>${img ? `<a href="${esc(link)}" target="_blank"><img src="${esc(img)}" loading="lazy" /></a>` : ''}</td>
<td><a href="${esc(link)}" target="_blank"><b>${esc(r.productName)}</b></a>
<div class="sub">${esc(r.itemName)} · ${esc(r.brandName)}</div>
<div class="sub">${esc(r.categoryHierarchy)}</div></td>
<td class="num">${d.salePrice ? Number(d.salePrice).toLocaleString() + '원' : (r.salesPrice || '')}</td>
<td>${esc(d.deliveryBadge || '')}<div class="sub">${esc(d.shippingFee || '')}</div></td>
<td class="num">${esc(d.salesText || '')}</td>
<td class="num">${esc(r.rating || '')} <span class="sub">(${esc(r.ratingCount || 0)})</span></td>
<td class="num">${esc(r.pvLast28dRank || '')}</td>
</tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8" />
<title>쿠팡 수집 결과 (${rows.length}건)</title>
<style>
body{font-family:-apple-system,"Malgun Gothic",sans-serif;margin:16px;background:#fafbfc;}
h1{font-size:17px;}
input{padding:8px;width:320px;font-size:13px;margin-bottom:10px;}
table{border-collapse:collapse;width:100%;background:#fff;}
th,td{border:1px solid #e3e6ea;padding:7px 9px;font-size:12.5px;vertical-align:top;}
th{background:#f5f7fa;position:sticky;top:0;z-index:1;}
img{width:${galleryPx}px;height:${galleryPx}px;object-fit:contain;background:#fff;}
.sub{color:#888;font-size:11px;margin-top:3px;}
.num{text-align:right;white-space:nowrap;}
a{color:#2b5cb8;text-decoration:none;}
a:hover{text-decoration:underline;}
</style></head><body>
<h1>쿠팡 수집 결과 — ${rows.length}건${collectedRows.length > 3000 ? ` (전체 ${collectedRows.length}건 중 앞 3000건)` : ''}</h1>
<input type="text" id="q" placeholder="상품명 · 브랜드 · 카테고리로 걸러내기" />
<table><thead><tr>
<th>이미지</th><th>상품</th><th>가격</th><th>배송</th><th>판매량</th><th>평점</th><th>순위</th>
</tr></thead><tbody id="tb">
${body}
</tbody></table>
<script>
document.getElementById('q').addEventListener('input', function(){
  var v = this.value.toLowerCase();
  var rows = document.querySelectorAll('#tb tr');
  for (var i=0;i<rows.length;i++){
    rows[i].style.display = rows[i].textContent.toLowerCase().indexOf(v) !== -1 ? '' : 'none';
  }
});
<\/script>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `coupang_gallery_${new Date().toISOString().slice(0, 10)}.html`,
    saveAs: true
  });

  setStatus(
    `HTML 갤러리를 저장합니다. (${rows.length}건)\n` +
    `브라우저로 열면 이미지와 함께 볼 수 있고, 상단 검색창으로 걸러낼 수 있습니다.\n` +
    `상품명이나 이미지를 클릭하면 쿠팡 상품 페이지로 이동합니다.`
  );
});


feeCaptureBtn.addEventListener('click', async () => {
  try {
    const tab = await getWingTab();
    const results = await runInAllFrames(tab.id, pageReadFeeCaptures);

    const merged = {};
    results.forEach((fr) => {
      if (!fr || !fr.result || !fr.result.store) return;
      Object.entries(fr.result.store).forEach(([k, v]) => {
        if (!merged[k] || (v.resText && v.resText.length > (merged[k].resText || '').length)) merged[k] = v;
      });
    });

    const keys = Object.keys(merged);
    if (keys.length === 0) {
      setStatus(
        '캡처된 요금 API가 없습니다.\n\n' +
        '1) 정산 > 수수료 상세 페이지를 열고 F5로 새로고침\n' +
        '   https://wing.coupang.com/tenants/rfm/settlements/fee-details#warehousing-and-fulfillment-fee\n' +
        '2) 카테고리를 하나 선택해 요금표가 화면에 뜨게 하기\n' +
        '3) 이 버튼을 다시 누르기',
        true
      );
      return;
    }

    const lines = [`캡처된 요금 API ${keys.length}건\n`];
    keys.forEach((k) => {
      const v = merged[k];
      lines.push(`──────────────────────────`);
      lines.push(`[${v.method}] ${v.url}`);
      if (v.reqBody) {
        let pretty = v.reqBody;
        try { pretty = JSON.stringify(JSON.parse(v.reqBody), null, 2); } catch (e) {}
        lines.push(`요청 바디:\n${pretty.slice(0, 800)}`);
      }
      if (v.resText) {
        let pretty = v.resText;
        try { pretty = JSON.stringify(JSON.parse(v.resText), null, 2); } catch (e) {}
        lines.push(`응답(앞부분):\n${pretty.slice(0, 1500)}`);
      }
      lines.push('');
    });

    setStatus(lines.join('\n'));
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  }
});


/* ===================== 요금표 수집 =====================
   카테고리(KAN ID) 목록을 받아 unit1/unit2 매핑 → 요금표(극소형~특대형)를 채운다.
   정가/할인가 표(feeTables)와 저가 상품 전용 할인가 표(feeTablesLow)를 항상 둘 다 시도한다 —
   전용할인가가 있으면 그게 실제 최종 청구액이라 항상 우선해야 하고, 없는 카테고리도 많아서
   (일부 카테고리 전용) 그건 실패로 치지 않는다.
   force가 아니면 로컬 캐시뿐 아니라 DB에도 이미 있으면 건너뛴다 — 같은 카테고리를
   수집할 때마다 매번 다시 받지 않기 위함. */
async function collectFeeDataForCategories(kanIds, opts) {
  opts = opts || {};
  const statusFn = opts.statusFn || setStatus;
  const summary = {
    unitOk: 0, unitFail: 0, unitSkipped: 0,
    tableOk: 0, tableFail: 0, tableSkipped: 0,
    lowTableOk: 0, lowTableSkipped: 0,
    failLog: []
  };

  kanIds = Array.from(new Set((kanIds || []).map(String))).filter(Boolean);
  if (!kanIds.length) return summary;

  const force = !!(feeForceRefreshEl && feeForceRefreshEl.checked);

  let dbState = { catMap: {}, feeSet: new Set() };
  if (!force) {
    try { dbState = await sbFetchKnownFeeState(); } catch (e) { /* DB 조회 실패해도 API로 계속 진행 */ }
  }

  const tab = opts.tab || await getWingTab();

  /* 1) KAN -> unit1/unit2 */
  for (let i = 0; i < kanIds.length; i++) {
    const id = kanIds[i];
    if (!force && catUnitMap[id]) { summary.unitOk++; continue; }
    if (!force && dbState.catMap[id]) {
      catUnitMap[id] = dbState.catMap[id];
      summary.unitOk++; summary.unitSkipped++;
      continue;
    }

    statusFn(`요금 카테고리 조회 (${i + 1}/${kanIds.length}) · KAN ${id}\n성공 ${summary.unitOk} · 실패 ${summary.unitFail}`);

    let r = null;
    try {
      const [x] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: pageFetchUnitCategory, args: [id]
      });
      r = x && x.result;
    } catch (e) { r = { ok: false, error: e.message }; }

    if (r && r.ok && r.unit1) {
      catUnitMap[id] = { unit1: r.unit1, unit2: r.unit2, kanName: r.kanName, fullPath: r.fullPath };
      summary.unitOk++;
    } else {
      summary.unitFail++;
      summary.failLog.push(`KAN ${id}: ${r ? (r.error || ('HTTP ' + r.status)) : '실패'}`);
    }
    await new Promise((rr) => setTimeout(rr, 250));
  }

  /* 2) 고유 unit 조합별 요금표 (이번 호출의 카테고리에 해당하는 것만) — 정가/할인가 + 전용할인가 둘 다 */
  const unitKeys = {};
  kanIds.forEach((id) => {
    const v = catUnitMap[id];
    if (v && v.unit1) unitKeys[feeUnitKey(v.unit1, v.unit2)] = { unit1: v.unit1, unit2: v.unit2 };
  });
  const keys = Object.keys(unitKeys);
  const variants = [
    { low: false, store: feeTables },
    { low: true, store: feeTablesLow }
  ];

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const u = unitKeys[k];

    for (const variant of variants) {
      if (!force && variant.store[k]) {
        if (variant.low) summary.lowTableOk++; else summary.tableOk++;
        continue;
      }
      if (!force && dbState.feeSet.has(`${u.unit1}|${u.unit2}|${variant.low ? 1 : 0}`)) {
        if (variant.low) { summary.lowTableOk++; summary.lowTableSkipped++; }
        else { summary.tableOk++; summary.tableSkipped++; }
        continue;
      }

      statusFn(
        `요금표 조회 (${i + 1}/${keys.length}) · ${u.unit1} / ${u.unit2}` +
        (variant.low ? ' (전용할인가)' : '') + `\n` +
        `카테고리 매핑 ${summary.unitOk}건 · 요금표 ${summary.tableOk}건 · 전용할인가 ${summary.lowTableOk}건`
      );

      let r = null;
      try {
        const [x] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: pageFetchFeeTable, args: [u.unit1, u.unit2, variant.low]
        });
        r = x && x.result;
      } catch (e) { r = { ok: false, error: e.message }; }

      if (r && r.ok) {
        const parsed = parseFeeResponse(r.json);
        if (Object.keys(parsed).length > 0) {
          variant.store[k] = parsed;
          if (variant.low) summary.lowTableOk++; else summary.tableOk++;
        } else if (!variant.low) {
          // 전용할인가는 일부 카테고리에만 있으므로 데이터가 없는 게 정상 — 실패로 세지 않는다
          summary.tableFail++;
          summary.failLog.push(`${k}: 요금 데이터 없음`);
        }
      } else if (!variant.low) {
        summary.tableFail++;
        summary.failLog.push(`${k}: ${r ? (r.error || ('HTTP ' + r.status)) : '실패'}`);
      }
      await new Promise((rr) => setTimeout(rr, 400));
    }
  }

  try {
    await chrome.storage.local.set({
      cwc_feeTables: feeTables, cwc_feeTablesLow: feeTablesLow, cwc_catUnitMap: catUnitMap
    });
  } catch (e) { /* 무시 */ }

  return summary;
}

feeCollectBtn.addEventListener('click', async () => {
  if (collectedRows.length === 0) {
    setStatus('먼저 상품 수집을 실행하세요. (카테고리 정보가 필요합니다)', true);
    return;
  }

  // 수집 데이터에서 KAN 카테고리 ID 추출 (상품 응답의 categoryId가 곧 KAN ID)
  const kanIds = Array.from(new Set(
    collectedRows.map((r) => r.categoryId).filter((v) => v !== undefined && v !== null && v !== '')
  )).map(String);

  if (kanIds.length === 0) {
    setStatus(
      '수집 데이터에 카테고리 ID가 없습니다.\n' +
      '이전 버전으로 수집한 데이터라면 다시 수집해야 합니다.',
      true
    );
    return;
  }

  feeCollectBtn.disabled = true;
  try {
    const summary = await collectFeeDataForCategories(kanIds, { statusFn: setStatus });

    const sizes = new Set();
    Object.values(feeTables).forEach((t) => Object.keys(t).forEach((c) => sizes.add(c)));

    setStatus(
      `요금표 수집 완료\n\n` +
      `카테고리 매핑: 성공 ${summary.unitOk}(DB에 이미 있음 ${summary.unitSkipped}) · 실패 ${summary.unitFail}\n` +
      `요금표(정가/할인가): 성공 ${summary.tableOk}(DB에 이미 있음 ${summary.tableSkipped}) · 실패 ${summary.tableFail}\n` +
      `전용할인가(저가 상품): ${summary.lowTableOk}건(DB에 이미 있음 ${summary.lowTableSkipped}) · 없는 카테고리는 정상\n` +
      `사이즈 유형: ${Array.from(sizes).map((c) => CAPACITY_LABELS[c] || c).join(', ')}\n` +
      (summary.failLog.length ? `\n[실패 내역]\n${summary.failLog.slice(0, 10).join('\n')}` : '') +
      `\n\n"수집 데이터 업로드"를 누르면 요금표도 함께 올라갑니다.`,
      summary.tableOk === 0 && summary.tableSkipped === 0
    );
  } catch (err) {
    setStatus('오류: ' + err.message, true);
  } finally {
    feeCollectBtn.disabled = false;
  }
});

/* 요금표를 별도 CSV로 내보내기 (엑셀 수식 참조용) */
feeExportBtn.addEventListener('click', () => {
  const keys = Object.keys(feeTables);
  if (keys.length === 0) {
    setStatus('먼저 "요금표 수집"을 실행하세요.', true);
    return;
  }

  const lines = [['요금카테고리', 'unit1', 'unit2', '사이즈코드', '사이즈', '가격하한', '정가', '할인가'].join(',')];
  keys.forEach((k) => {
    const [u1, u2] = k.split('|');
    const table = feeTables[k];
    CAPACITY_ORDER.forEach((cap) => {
      const tiers = table[cap];
      if (!tiers) return;
      tiers.forEach((t) => {
        lines.push([
          toCsvValue(k), toCsvValue(u1), toCsvValue(u2),
          toCsvValue(cap), toCsvValue(CAPACITY_LABELS[cap] || cap),
          toCsvValue(t.minPrice), toCsvValue(t.base), toCsvValue(t.final)
        ].join(','));
      });
    });
  });

  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `coupang_fee_table_${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: true
  });

  setStatus(
    `요금표 CSV를 저장합니다. (${lines.length - 1}행)\n\n` +
    `상품 CSV의 입출고비 수식이 이 표를 참조하도록 하려면,\n` +
    `두 파일을 같은 엑셀 통합문서의 시트로 합치고 시트 이름을 "요금표"로 지정하세요.`
  );
});


/* ===================== Supabase 업로드 ===================== */
function sbSetStatus(msg, isError) {
  if (!sbStatusEl) return;
  sbStatusEl.textContent = msg;
  sbStatusEl.style.color = isError ? '#c0392b' : '#2a7d4f';
}

sbSaveBtn.addEventListener('click', async () => {
  try {
    SB.url = (sbUrlEl.value || '').trim().replace(/\/+$/, '');
    SB.key = (sbKeyEl.value || '').trim();

    if (!SB.url || !SB.key) {
      sbSetStatus('URL과 키를 모두 입력하세요.', true);
      return;
    }
    if (SB.key.indexOf('secret') !== -1 || SB.key.indexOf('service_role') !== -1) {
      sbSetStatus('⚠ secret / service_role 키는 사용할 수 없습니다. publishable 키를 넣으세요.', true);
      return;
    }

    const email = (sbEmailEl.value || '').trim();
    const pw = sbPasswordEl.value || '';
    if (!email || !pw) {
      sbSetStatus('관리자 이메일과 비밀번호를 입력하세요.', true);
      return;
    }

    sbSetStatus('로그인 중...');
    await sbLogin(email, pw);
    sbPasswordEl.value = '';   // 비밀번호는 화면에 남기지 않습니다

    // 관리자 권한 확인
    const prof = await sbRequest('profiles?select=email,is_admin');
    const me = Array.isArray(prof) && prof.length ? prof[0] : null;

    if (!me) {
      sbSetStatus('로그인은 됐지만 프로필을 찾을 수 없습니다.', true);
      return;
    }
    if (!me.is_admin) {
      sbSetStatus(
        `로그인 성공 (${me.email})\n` +
        `⚠ 관리자 권한이 없어 업로드할 수 없습니다.\n` +
        `SQL Editor에서 실행하세요:\n` +
        `update profiles set is_admin = true where email = '${me.email}';`,
        true
      );
      return;
    }

    sbSetStatus(`✅ 로그인 성공 · 관리자 확인됨 (${me.email})`);
    loginExpiredNotified = false;
    startKeepAlive();
  } catch (err) {
    sbSetStatus('오류: ' + err.message, true);
  }
});

sbTestBtn.addEventListener('click', async () => {
  try {
    sbSetStatus('연결 확인 중...');
    await sbEnsureAuth();

    const counts = {};
    for (const t of ['products', 'product_items', 'item_history', 'categories', 'fulfillment_fees']) {
      try {
        const res = await fetch(`${SB.url}/rest/v1/${t}?select=*&limit=1`, {
          headers: {
            'apikey': SB.key,
            'authorization': 'Bearer ' + SB.accessToken,
            'prefer': 'count=exact',
            'range': '0-0'
          }
        });
        const cr = res.headers.get('content-range') || '';
        counts[t] = cr.split('/')[1] || '?';
      } catch (e) { counts[t] = '오류'; }
    }

    sbSetStatus(
      '✅ 연결 정상\n' +
      Object.entries(counts).map(([k, v]) => `  ${k}: ${v}행`).join('\n')
    );
  } catch (err) {
    sbSetStatus('오류: ' + err.message, true);
  }
});

sbUploadBtn.addEventListener('click', async () => {
  if (collectedRows.length === 0) {
    sbSetStatus('업로드할 수집 데이터가 없습니다.', true);
    return;
  }

  sbUploadBtn.disabled = true;
  try {
    await sbEnsureAuth();

    sbSetStatus('데이터 변환 중...');
    const payload = buildSupabasePayload(collectedRows, detailsMap, catUnitMap);

    const steps = [
      { name: '카테고리',  table: 'categories',    rows: payload.categories, conflict: 'category_code' },
      { name: '상품',      table: 'products',      rows: payload.products,   conflict: 'product_id' },
      { name: '옵션',      table: 'product_items', rows: payload.items,      conflict: 'item_id' }
    ];

    const CHUNK = 500;
    for (const st of steps) {
      const parts = chunk(st.rows, CHUNK);
      for (let i = 0; i < parts.length; i++) {
        sbSetStatus(`${st.name} 업로드 중... (${i + 1}/${parts.length}) · ${st.rows.length}행`);
        await sbUpsert(st.table, parts[i], st.conflict);
      }
    }

    // 이력은 중복 무시로 삽입 (같은 날 재수집해도 안전)
    const hParts = chunk(payload.history, CHUNK);
    for (let i = 0; i < hParts.length; i++) {
      sbSetStatus(`변경 이력 기록 중... (${i + 1}/${hParts.length})`);
      try {
        await sbInsertIgnore('item_history', hParts[i]);
      } catch (e) {
        // 같은 날 중복은 정상이므로 무시하고 계속
      }
    }

    // 입출고비 요금표 (신규로 수집된 것만 남아있음 — 이미 DB에 있던 건 자동 수집 단계에서 건너뜀)
    const feeRows = buildFeeRows(feeTables, false).concat(buildFeeRows(feeTablesLow, true));
    const fParts = chunk(feeRows, CHUNK);
    for (let i = 0; i < fParts.length; i++) {
      sbSetStatus(`요금표 업로드 중... (${i + 1}/${fParts.length}) · ${feeRows.length}행`);
      await sbUpsert('fulfillment_fees', fParts[i], 'unit1,unit2,capacity_type,min_price,is_low_asp');
    }

    sbSetStatus(
      `✅ 업로드 완료\n` +
      `  카테고리 ${payload.categories.length}건\n` +
      `  상품 ${payload.products.length}건\n` +
      `  옵션 ${payload.items.length}건\n` +
      `  이력 ${payload.history.length}건 (같은 날 중복은 자동 제외)\n` +
      `  요금표 ${feeRows.length}행`
    );
  } catch (err) {
    sbSetStatus('오류: ' + err.message, true);
  } finally {
    sbUploadBtn.disabled = false;
  }
});

sbFeeUploadBtn.addEventListener('click', async () => {
  if (Object.keys(feeTables).length === 0 && Object.keys(feeTablesLow).length === 0) {
    sbSetStatus('먼저 "요금표 수동 수집"을 실행하세요.', true);
    return;
  }

  sbFeeUploadBtn.disabled = true;
  try {
    await sbEnsureAuth();
    const rows = buildFeeRows(feeTables, false).concat(buildFeeRows(feeTablesLow, true));

    const parts = chunk(rows, 500);
    for (let i = 0; i < parts.length; i++) {
      sbSetStatus(`요금표 업로드 중... (${i + 1}/${parts.length}) · ${rows.length}행`);
      await sbUpsert('fulfillment_fees', parts[i], 'unit1,unit2,capacity_type,min_price,is_low_asp');
    }

    // 카테고리에 unit 매핑도 반영
    const catRows = [];
    Object.keys(catUnitMap).forEach((kanId) => {
      const u = catUnitMap[kanId];
      collectedRows.forEach((r) => {
        if (String(r.categoryId) === kanId && r.categoryCode) {
          if (!catRows.some((c) => c.category_code === String(r.categoryCode))) {
            catRows.push({
              category_code: String(r.categoryCode),
              name: r.categoryName || '',
              kan_category_id: kanId,
              unit1: u.unit1,
              unit2: u.unit2
            });
          }
        }
      });
    });
    if (catRows.length) {
      await sbUpsert('categories', catRows, 'category_code');
    }

    sbSetStatus(`✅ 요금표 ${rows.length}행 · 카테고리 매핑 ${catRows.length}건 업로드 완료`);
  } catch (err) {
    sbSetStatus('오류: ' + err.message, true);
  } finally {
    sbFeeUploadBtn.disabled = false;
  }
});


/* ===================== 카테고리 전체 업로드 ===================== */
sbCatUploadBtn.addEventListener('click', async () => {
  if (!categories || categories.length === 0) {
    sbSetStatus('먼저 "② 전체 카테고리 불러오기"를 실행하세요.', true);
    return;
  }

  sbCatUploadBtn.disabled = true;
  try {
    await sbEnsureAuth();
    const rows = buildCategoryRows(categories);
    const parts = chunk(rows, 500);

    for (let i = 0; i < parts.length; i++) {
      sbSetStatus(`카테고리 업로드 중... (${i + 1}/${parts.length}) · 전체 ${rows.length}개`);
      await sbUpsert('categories', parts[i], 'category_code');
    }

    const leaves = rows.filter((r) => r.is_leaf).length;
    sbSetStatus(
      `✅ 카테고리 ${rows.length}개 업로드 완료\n` +
      `  말단 ${leaves}개 · 상위 ${rows.length - leaves}개\n\n` +
      `이제 웹사이트 카테고리 화면에서 전체 목록을 볼 수 있습니다.`
    );
  } catch (err) {
    sbSetStatus('오류: ' + err.message, true);
  } finally {
    sbCatUploadBtn.disabled = false;
  }
});

/* ===================== 대기열 자동 처리 ===================== */
let queueTimer = null;
let queueRunning = false;
let queueStop = false;

function setQueueUI(on) {
  sbQueueStartBtn.classList.toggle('hidden', on);
  sbQueueStopBtn.classList.toggle('hidden', !on);
}

sbQueueStartBtn.addEventListener('click', async () => {
  try {
    await sbEnsureAuth();
  } catch (e) {
    sbSetStatus('먼저 로그인하세요: ' + e.message, true);
    return;
  }

  queueStop = false;
  setQueueUI(true);
  sbSetStatus('대기열 감시를 시작했습니다. 새 요청이 오면 자동으로 수집합니다.');

  const tick = async () => {
    if (queueStop || queueRunning) return;
    try {
      const job = await sbFetchNextJob();
      if (!job) {
        const n = await sbCountPending();
        sbSetStatus(`대기열 감시 중... (대기 ${n}건) · ${new Date().toLocaleTimeString('ko-KR')}`);
        return;
      }
      await processJob(job);
    } catch (e) {
      sbSetStatus('대기열 확인 실패: ' + e.message, true);
    }
  };

  await tick();
  queueTimer = setInterval(tick, 30000);   // 30초마다 확인
});

sbQueueStopBtn.addEventListener('click', () => {
  queueStop = true;
  detailStop = true;
  stopRequested = true;
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  setQueueUI(false);
  sbSetStatus('대기열 감시를 중지했습니다.');
});

/* 작업 하나를 처리합니다 */
async function processJob(job) {
  queueRunning = true;
  const label = job.category_name || job.category_code;

  try {
    await sbUpdateJob(job.id, { status: 'running', started_at: new Date().toISOString() });
    sbSetStatus(`[대기열] ${label} 수집 시작...`);

    /* 1단계: 카테고리 상품 목록 */
    const tab = await getWingTab();
    const found = await findTemplateFrame(tab.id);
    if (found.frameId === null) {
      throw new Error('요청 템플릿이 없습니다. 쿠팡 윙에서 인기 상품 검색을 한 번 실행하세요.');
    }

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [found.frameId] },
      func: pageCollectCategory,
      args: [job.category_code, job.category_name || '', null]
    });
    const payload = res && res.result;

    if (!payload || !payload.ok) {
      throw new Error(payload ? payload.error : '수집 실패');
    }

    if (payload.empty || payload.items.length === 0) {
      await sbMarkCategoryCollected(job.category_code, 'list');
      await sbUpdateJob(job.id, {
        status: 'done',
        finished_at: new Date().toISOString(),
        result_count: 0,
        worker_note: '데이터 없음'
      });
      sbSetStatus(`[대기열] ${label} — 수집할 상품이 없습니다.`);
      return;
    }

    /* 수집 결과를 collectedRows 형식으로 변환 */
    collectedRows = [];
    for (const it of payload.items) {
      const hierarchy = it.displayCategoryInfos && it.displayCategoryInfos[0]
        ? it.displayCategoryInfos[0].categoryHierarchy : '';
      collectedRows.push({
        categoryCode: job.category_code,
        categoryName: job.category_name || '',
        categoryHierarchy: hierarchy,
        imagePath: it.imagePath || '',
        categoryId: it.categoryId || '',
        productName: it.productName,
        itemName: it.itemName,
        brandName: it.brandName,
        manufacture: it.manufacture,
        salesPrice: it.salesPrice ? it.salesPrice.amount : '',
        rating: it.rating,
        ratingCount: it.ratingCount,
        pvLast28dRank: it.pvLast28dRank,
        pvRange: pvRangeText(it.lowerPvLast28d, it.upperPvLast28d),
        lowerPvLast28d: cleanPv(it.lowerPvLast28d),
        upperPvLast28d: cleanPv(it.upperPvLast28d),
        listingEligibility: it.listingEligibility,
        itemId: it.itemId,
        productId: it.productId,
        vendorItemId: it.vendorItemId
      });
    }

    await saveProgress();
    await sbMarkCategoryCollected(job.category_code, 'list');
    sbSetStatus(`[대기열] ${label} — 상품 ${collectedRows.length}건 수집 · 상세 보강 시작...`);

    /* 2단계(상세)→요금표 자동수집→DB 업로드까지 수동 "카테고리 수집"과 같은 함수를 공유한다.
       job_type이 'list'면 상세 보강 없이 목록만 업로드한다. */
    const r = await finishCategoryPipeline(job.category_code, collectedRows, {
      statusFn: sbSetStatus,
      label: `[대기열] ${label}`,
      withDetail: job.job_type !== 'list',
      tab
    });

    await sbUpdateJob(job.id, {
      status: 'done',
      finished_at: new Date().toISOString(),
      result_count: r.itemCount != null ? r.itemCount : collectedRows.length,
      worker_note: r.detailDone ? '전체 완료' : '목록만 완료'
    });

    sbSetStatus(
      `✅ [대기열] ${label} 완료\n` +
      `  상품 ${r.productCount != null ? r.productCount : '?'}건 · 옵션 ${r.itemCount != null ? r.itemCount : collectedRows.length}건` +
      (r.detailDone ? ' · 상세 보강 완료' : ' · 목록만') +
      (r.uploaded ? '' : ' · ⚠ 업로드 실패')
    );
  } catch (err) {
    try {
      await sbUpdateJob(job.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: String(err.message).slice(0, 300)
      });
    } catch (e) { /* 무시 */ }
    sbSetStatus(`❌ [대기열] ${label} 실패: ${err.message}`, true);
  } finally {
    queueRunning = false;
  }
}

/* ===================== 접속 유지 =====================
   별도 창을 오래 열어둬도 로그인이 끊기지 않도록 주기적으로 토큰을 미리 갱신한다.
   비밀번호는 저장하지 않으므로(보안상 의도적으로), 리프레시 토큰 자체가 만료되는
   드문 경우엔 자동 복구가 불가능하다 — 그 경우만 재시도 3번 후 알림을 띄운다. */
const NOTIF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQ0AAAgEoCtjMuNbwhbOBxsBSPW8EiEhISEhISEhISEhISEhISEhISEhISEhISGhOwsQ7wvEcqrbYwAAAABJRU5ErkJggg==';
const KEEPALIVE_INTERVAL_MS = 20 * 60 * 1000; // 20분마다 미리 갱신
let keepAliveTimer = null;
let loginExpiredNotified = false;

function notifyLoginExpired(detail) {
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create('cwc-login-expired-' + Date.now(), {
        type: 'basic',
        iconUrl: NOTIF_ICON,
        title: '쿠팡 소싱 — 로그인이 끊겼습니다',
        message: '자동 재연결에 3번 실패했습니다. 확장프로그램을 열어 비밀번호로 다시 로그인해주세요.',
        priority: 2
      });
    }
  } catch (e) { /* 알림이 안 떠도 앱 동작엔 지장 없어야 함 */ }
  sbSetStatus('⚠ 로그인이 끊겼습니다. 비밀번호를 입력해 다시 로그인하세요. (' + detail + ')', true);
}

/* 리프레시를 최대 3번(즉시 → 3초 후 → 8초 후) 시도하고, 그래도 안 되면 알린다. */
async function sbKeepAliveTick() {
  if (!sbConfigured() || !SB.refreshToken) return;
  const delays = [0, 3000, 8000];
  let lastErr = null;
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d));
    try {
      await sbRefresh();
      loginExpiredNotified = false;
      return;
    } catch (e) { lastErr = e; }
  }
  if (!loginExpiredNotified) {
    loginExpiredNotified = true;
    notifyLoginExpired(lastErr ? lastErr.message : '알 수 없는 오류');
  }
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(sbKeepAliveTick, KEEPALIVE_INTERVAL_MS);
}

/* ===================== 초기화 ===================== */
(function init() {
  const isWindowed = new URLSearchParams(location.search).get('windowed') === '1';
  if (isWindowed) {
    document.body.classList.add('windowed');
    openWindowBtn.style.display = 'none';
    modeLabel.textContent = '별도 창 모드 — 이 창을 열어두면 장시간 수집이 중단되지 않습니다.';
  } else {
    modeLabel.textContent = '팝업 모드 — 오래 걸리는 수집은 "별도 창으로 열기"를 권장합니다.';
  }
  loadProgress();

  // Supabase 설정 복원 — 로그인이 만료돼 있어도 리프레시 토큰이 있으면 바로 재연결을 시도한다
  sbLoadConfig().then(async () => {
    if (sbUrlEl) sbUrlEl.value = SB.url;
    if (sbKeyEl) sbKeyEl.value = SB.key;
    if (sbEmailEl) sbEmailEl.value = SB.email;
    if (!sbConfigured()) return;

    if (!sbLoggedIn() && SB.refreshToken) {
      sbSetStatus('설정됨 · 재연결 중...');
      try { await sbRefresh(); } catch (e) { /* 아래에서 상태 표시 */ }
    }

    sbSetStatus(sbLoggedIn()
      ? `설정됨 · 로그인 상태 (${SB.email})`
      : '설정됨 · 로그인이 만료되었습니다. 비밀번호를 입력해 다시 로그인하세요.');

    startKeepAlive();
  });
})();
