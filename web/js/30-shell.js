/* ============================================================
   30-shell.js — 필터·검색 · 내보내기 · 설정 모달
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 필터 · 검색 ===================== */
$('#filterToggle').onclick = () => $('#filterPanel').classList.toggle('hidden');

$('#filterApply').onclick = () => {
  state.filters = {
    root:      $('#fRoot').value,
    category:  $('#fCategory').value,
    delivery:  $('#fDelivery').value,
    priceMin:  $('#fPriceMin').value,
    priceMax:  $('#fPriceMax').value,
    salesMin:  $('#fSalesMin').value,
    salesMax:  $('#fSalesMax').value,
    marginMin: $('#fMarginMin').value,
    marginMax: $('#fMarginMax').value,
    sort:      $('#fSort').value,
    favCatOnly: $('#fFavCatOnly').checked
  };
  const n = Object.values(state.filters).filter((v) => v !== '' && v !== false && v !== 'max_sales').length;
  const b = $('#filterCount');
  b.textContent = n; b.classList.toggle('hidden', n === 0);
  resetAndLoad();
};

$('#filterReset').onclick = () => {
  ['fRoot','fCategory','fDelivery','fPriceMin','fPriceMax','fSalesMin','fSalesMax','fMarginMin','fMarginMax']
    .forEach((id) => { $('#' + id).value = ''; });
  $('#fSort').value = 'max_sales';
  $('#fFavCatOnly').checked = false;
  state.filters = {};
  $('#filterCount').classList.add('hidden');
  resetAndLoad();
};

$('#searchInput').addEventListener('input', debounce((ev) => {
  state.search = ev.target.value.trim();
  if (state.page === 'sourcing') resetAndLoad();
}, 400));

/* 무한 스크롤 — 스크롤 이벤트는 초당 수십 번 오므로 엘리먼트를 매번 찾지 않는다 */
const MAIN_EL = $('.main');
MAIN_EL.addEventListener('scroll', () => {
  if (state.page !== 'sourcing' || state.loading || state.done) return;
  if (MAIN_EL.scrollTop + MAIN_EL.clientHeight >= MAIN_EL.scrollHeight - 320) loadMore();
}, { passive: true });

/* ===================== 내보내기 ===================== */
$('#exportBtn').onclick = () => {
  if (!state.rows.length) return toast('내보낼 데이터가 없습니다');
  const head = ['상품ID','상품명','브랜드','최대판매량','합계판매량','최저가','최고가','옵션수','순위','배송유형','카테고리'];
  const lines = [head.join(',')];
  state.rows.forEach((p) => {
    lines.push([
      p.product_id, p.product_name, p.brand_name, p.max_sales, p.sum_sales,
      p.min_price, p.max_price, p.option_count, p.pv_rank,
      Array.isArray(p.delivery_badges) ? p.delivery_badges.join(' / ') : '',
      p.category_path
    ].map((v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sourcing_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast(`${state.rows.length}건을 내보냈습니다`);
};

/* ===================== 설정 모달 ===================== */
$('#settingsBtn').onclick = () => {
  $('#setRate').value = settings.rate;
  $('#setOutbound').value = settings.outbound;
  $('#setWork').value = settings.work;
  $('#setSize').value = settings.size;
  $('#settingsMsg').textContent = '';
  $('#settingsModal').classList.remove('hidden');
};

$$('[data-close]').forEach((el) => {
  el.onclick = () => $('#settingsModal').classList.add('hidden');
});

$('#settingsSave').onclick = async () => {
  settings.rate = parseFloat($('#setRate').value) || settings.rate;
  settings.outbound = parseInt($('#setOutbound').value, 10) || 0;
  settings.work = parseInt($('#setWork').value, 10) || 0;
  settings.size = $('#setSize').value;

  try {
    // 개인 설정으로 저장 (공통 settings는 관리자만 수정 가능)
    await api(`profiles?id=eq.${AUTH.userId}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { prefs: settings }
    });
    $('#settingsModal').classList.add('hidden');
    toast('설정을 저장했습니다');
    if (state.page === 'sourcing') resetAndLoad();
  } catch (e) {
    const el = $('#settingsMsg');
    el.className = 'msg err';
    el.textContent = '저장 실패: ' + e.message;
  }
};
