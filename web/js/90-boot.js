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

/* ===================== 시작 ===================== */
(async function init() {
  document.documentElement.dataset.theme =
    localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (localStorage.getItem('sidebarCollapsed') === '1') $('#sidebar').classList.add('collapsed');

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
