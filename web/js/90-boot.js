/* ============================================================
   90-boot.js — 네비게이션 · 테마 · 시작
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 네비게이션 ===================== */
$$('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    const page = btn.dataset.page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.page').forEach((p) => p.classList.add('hidden'));
    $('#page-' + page).classList.remove('hidden');
    state.page = page;
    closeSidebar();

    if (page === 'po')         loadPOs();
    if (page === 'inbound')    loadInbound();
    if (page === 'deposit')    loadDeposits();
    if (page === 'stock')      loadStock();
    if (page === 'ship')       loadShip();
    if (page === 'skus')       loadSkus();
    if (page === 'product-edit') loadProductEdit();
    if (page === 'listing')    loadListing();
    if (page === 'listing-price') loadListingPrice();
    if (page === 'listing-name')  loadListingName();
    if (page === 'sales')      loadSales();
    if (page === 'favorites')  loadFavorites();
    if (page === 'categories') loadCategories();
    if (page === 'queue')      loadQueue();
  };
});

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
}
$('#menuBtn').onclick = () => {
  $('#sidebar').classList.toggle('open');
  $('#scrim').classList.toggle('on');
};
$('#scrim').onclick = closeSidebar;

/* 사이드바 접기(데스크톱 전용, 사용자 요청 2026-08-16) — 5개 탭 아이콘+텍스트가 항상
   펼쳐진 채로 공간을 차지해서, localStorage에 상태를 저장해 다음 방문에도 유지되게 했다.
   모바일은 오프캔버스(위 .sidebar.open)라 애초에 공간을 안 차지하므로 버튼 자체를 숨김
   (CSS .nav-collapse-btn { display:none } @860px 이하). */
$('#sidebarCollapseBtn').onclick = () => {
  const collapsed = $('#sidebar').classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
};

/* ===================== 테마 ===================== */
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
};


/* ===================== 지표 자동 동기화 =====================
   웹을 열면 **빠진 날이 있을 때만** 확장프로그램에 지표를 받아오라고 시킨다.

   왜 "하루 한 번"이 아니라 "빠진 날이 있을 때만"인가:
   브라우저 저장소에 마지막 실행일을 적어두면 브라우저마다 다르고 지우면 리셋된다.
   **coupang_metrics_sync_log 가 진실이다.** 며칠 못 열었으면 그만큼 메우고,
   이미 받았으면 아무것도 안 한다. 조회 한 번이라 매번 확인해도 싸다.

   왜 막지 않는가: 지표는 부가 정보지 이 화면의 본체가 아니다. 못 받았다고
   대시보드를 못 쓰게 하면 손해다. 배너로 알리고 [WING 열기]를 준다.

   **당일치는 대상이 아니다** — 쿠팡이 다음날 밤에 채운다(사용자 확인). */

const METRICS_SYNC = { checking: false, lastResult: null };

function metricsBanner(html, kind) {
  let el = $('#metricsBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'metricsBanner';
    el.className = 'msg';
    el.style.margin = '8px 12px';
    const main = document.querySelector('.main');
    if (main) main.insertBefore(el, main.firstChild);
    else return;
  }
  if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = 'msg' + (kind === 'err' ? ' err' : '');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

/* 어제까지 며칠이 비었는지 센다. 로그가 진실의 원천이다(R-15 — "안 받은 날"과
   "받았는데 0인 날"은 다르다. 로그에 행이 있으면 받은 것이다). */
async function missingMetricDays(maxDays) {
  const days = [];
  for (let i = 1; i <= (maxDays || 14); i++) {
    days.push(kstDateStr(new Date(Date.now() - i * 86400000)));
  }
  let have = {};
  try {
    const rows = await api(`coupang_metrics_sync_log?select=metric_date`
      + `&metric_date=in.(${days.join(',')})`) || [];
    rows.forEach((r) => { have[r.metric_date] = 1; });
  } catch (e) {
    /* 027 미실행이면 404다. 그때는 자동 동기화를 조용히 접는다 —
       화면 본체와 무관한 기능이 화면을 어지럽히면 안 된다. */
    return null;
  }
  return days.filter((d) => !have[d]).sort();
}

async function autoSyncMetrics() {
  if (METRICS_SYNC.checking) return;
  METRICS_SYNC.checking = true;
  try {
    const missing = await missingMetricDays(14);
    if (missing === null) return;             // 027 미실행 — 아무것도 안 한다
    if (!missing.length) { metricsBanner(''); return; }

    metricsBanner(`지표 ${missing.length}일치를 받는 중입니다… `
      + `<span class="muted">(${missing[0]} ~ ${missing[missing.length - 1]})</span>`);

    const resp = await extensionSendMessage({ type: 'SYNC_METRICS', days: 14 });
    METRICS_SYNC.lastResult = resp;

    if (resp.ok) {
      const r = resp.result || {};
      const done = (r.done || []).length;
      if (r.error) { showMetricsProblem(r.error, r.stoppedAt); return; }
      metricsBanner(done
        ? `지표 ${done}일치를 받았습니다.`
        : '');
      if (done) setTimeout(() => metricsBanner(''), 5000);
      return;
    }
    if (resp.error === 'no-extension') {
      /* 확장프로그램이 없으면 조용히 넘긴다. 이 브라우저에서는 원래 못 받는다. */
      metricsBanner('');
      return;
    }
    showMetricsProblem(resp.error, null);
  } finally {
    METRICS_SYNC.checking = false;
  }
}

/* 실패를 **원인별로 다르게 말한다.** "실패했습니다"만 띄우면 무엇을 해야 할지 모른다.
   로그인이 끊긴 경우가 압도적으로 흔하므로 그 길을 바로 열어준다. */
function showMetricsProblem(err, stoppedAt) {
  const msg = String(err || '');
  /* 로그인이 끊기면 JSON 대신 로그인 페이지 HTML이 온다. 실제 응답이
     <!DOCTYPE html> 로 시작하므로 doctype 도 함께 본다 — <html 만 보면 놓친다. */
  const looksLogin = /로그인|login|doctype|<html|302|401|403|helpseller/i.test(msg);
  if (looksLogin) {
    metricsBanner(
      '<b>지표를 받지 못했습니다 — 쿠팡 WING 로그인이 필요합니다.</b> '
      + '<button id="metricsOpenWing" class="btn btn-sm">WING 열기</button> '
      + '<button id="metricsRetry" class="btn btn-sm">다시 시도</button>'
      + '<div class="muted sm">로그인한 뒤 [다시 시도]를 누르세요. 대시보드는 그대로 쓰실 수 있습니다.</div>',
      'err');
  } else {
    metricsBanner(
      `<b>지표를 받지 못했습니다.</b>${stoppedAt ? ` (${stoppedAt} 처리 중)` : ''} `
      + '<button id="metricsRetry" class="btn btn-sm">다시 시도</button>'
      + `<div class="muted sm">${esc(msg.slice(0, 300))}</div>`,
      'err');
  }
  const open = $('#metricsOpenWing');
  if (open) open.onclick = () => window.open('https://wing.coupang.com/', '_blank');
  const retry = $('#metricsRetry');
  if (retry) retry.onclick = () => { metricsBanner('다시 시도 중…'); autoSyncMetrics(); };
}

/* ===================== 시작 ===================== */
(async function init() {
  document.documentElement.dataset.theme =
    localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (localStorage.getItem('sidebarCollapsed') === '1') $('#sidebar').classList.add('collapsed');

  /* 로그인이 끝난 뒤 지표 동기화를 배경에서 돌린다. enterApp 안이 아니라 여기서
     거는 이유: enterApp은 여러 경로에서 불리고 중간에 return 하기도 해서,
     한 곳에 걸어두는 게 빠뜨리지 않는 방법이다.
     **await 하지 않는다** — 지표를 기다리느라 대시보드가 늦게 뜨면 안 된다. */
  window.addEventListener('cwc-app-ready', () => { autoSyncMetrics(); }, { once: true });

  $('#loginView').classList.add('hidden');

  loadCfg();
  $('#cfgUrl').value = CFG.url;
  $('#cfgKey').value = CFG.key;

  if (CFG.url && CFG.key && AUTH.refresh) {
    try {
      await ensureAuth();
      await enterApp();
      return;
    } catch (e) { /* 세션 만료 - 관리자 자동 로그인으로 진행 */ }
  }

  if (CFG.url && CFG.key) {
    try {
      const d = await authRequest('token?grant_type=password', {
        email: ADMIN_EMAIL, password: ADMIN_PASSWORD
      });
      applySession(d);
      await enterApp();
      return;
    } catch (e) {
      showLoginMsg('자동 로그인 실패: ' + e.message, true);
    }
  }

  $('#loginView').classList.remove('hidden');
  if (!CFG.url) $('.cfg').setAttribute('open', '');
})();
