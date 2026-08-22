/* ============================================================
   91-listing-filter.js — 검색필터 (카테고리 속성)
   ------------------------------------------------------------
   WING 상품등록의 '검색필터' 칸이다. **카테고리를 정해야 목록이 나온다** —
   카테고리마다 항목이 완전히 다르다.

   쿠팡 API 는 필수속성과 검색필터를 **한 배열(items[].attributes)** 로 받는다.
   화면만 나뉘어 있을 뿐이다. 그래서 여기서 채운 값도 등록할 때 그 배열에 합친다.

   **어느 속성이 검색필터인지는 아직 실물로 확정 못 했다**(R-14).
   카테고리 메타의 `required` 가 MANDATORY 가 아닌 것을 검색필터로 본다:
     103112 → 전체 28개 = 필수 3 + 선택 25
   그런데 WING 캡처에는 '사이즈 + 더보기(16)'로 나왔고 '사이즈'는 우리 목록에 없다.
   **그 캡처는 다른 카테고리 화면으로 보인다.** 같은 카테고리에서 대조해봐야 확정된다.
   그때까지 화면이 "추정"이라고 말한다.

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LF = { p: null, attrs: [], values: {}, defaults: {} };

async function loadListingFilter() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#lfBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#lfPicker'), rows);
  await lfLoadCurrent();
}

async function lfLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#lfBody').classList.add('hidden');
    $('#lfEmpty').classList.remove('hidden');
    $('#lfSteps').innerHTML = '';
    return;
  }
  $('#lfEmpty').classList.add('hidden');
  $('#lfBody').classList.remove('hidden');
  $('#lfRows').innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  const { p, prog } = await lstFetchOne(id);
  LF.p = p;
  $('#lfSteps').innerHTML = lstStepBar(prog, 'category');

  /* 카테고리가 먼저다 — 여기가 그 규칙이 가장 뚜렷한 화면이다.
     카테고리 없이는 **보여줄 항목 자체가 없다.** */
  if (!lstGuardCategory(p, $('#lfBody'))) {
    $('#lfRows').innerHTML = '<p class="muted">카테고리를 정하면 그 카테고리의 필터 항목이 나옵니다.</p>';
    return;
  }

  const code = String(p.display_category_code);
  let meta = null;
  let settingsRow = null;
  try {
    const [m, s] = await Promise.all([
      api(`coupang_category_meta?select=raw&display_category_code=eq.${encodeURIComponent(code)}&limit=1`),
      api('listing_settings?select=filter_defaults&id=eq.1&limit=1').catch(() => [])
    ]);
    meta = (m || [])[0] || null;
    settingsRow = (s || [])[0] || null;
  } catch (e) { /* 029/037 미실행 */ }

  if (!meta) {
    $('#lfRows').innerHTML = '<p class="msg err">이 카테고리의 속성 목록을 아직 안 받았습니다 — '
      + '카테고리 화면에서 [지금 받기]를 누르세요.</p>';
    return;
  }

  const all = (meta.raw || {}).attributes || [];
  LF.attrs = all.filter((a) => a.required !== 'MANDATORY');
  LF.defaults = ((settingsRow || {}).filter_defaults || {})[code] || {};
  LF.values = Object.assign({}, LF.defaults, p.search_filters || {});

  const mandatory = all.filter((a) => a.required === 'MANDATORY');
  $('#lfNote').innerHTML =
    `카테고리 <b>${esc(p.category_path || code)}</b> · 필터 ${LF.attrs.length}개`
    + (mandatory.length
        ? ` <span class="muted">(필수속성 ${mandatory.length}개(${
            esc(mandatory.map((a) => a.attributeTypeName).join(', '))})는 등록할 때 자동으로 채웁니다)</span>`
        : '');

  lfRender();
}

function lfRender() {
  if (!LF.attrs.length) {
    $('#lfRows').innerHTML = '<p class="muted">이 카테고리에는 선택 속성이 없습니다.</p>';
    return;
  }
  $('#lfRows').innerHTML = LF.attrs.map((a) => {
    const nm = a.attributeTypeName;
    const unit = (a.basicUnit && a.basicUnit !== '없음') ? a.basicUnit : '';
    const v = LF.values[nm] == null ? '' : LF.values[nm];
    const isDefault = !((LF.p.search_filters || {})[nm]) && LF.defaults[nm];
    return `<label class="field lf-row" data-lf="${esc(nm)}">
      <span>${esc(nm)}
        <span class="muted xs">${esc(a.dataType || '')}${unit ? ' · ' + esc(unit) : ''}</span>
        ${isDefault ? '<span class="prog prog-dim">설정 기본값</span>' : ''}</span>
      <input class="lf-v" type="${a.dataType === 'NUMBER' ? 'number' : 'text'}"
             value="${esc(v)}" placeholder="${esc(unit ? unit + ' 단위 숫자' : '비워두면 안 보냅니다')}" /></label>`;
  }).join('');
}

$('#lfPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await lfLoadCurrent();
});

$('#lfSave').onclick = async () => {
  if (!LF.p) return;
  const btn = $('#lfSave');
  const msg = $('#lfMsg');
  btn.disabled = true;
  msg.classList.remove('hidden');
  msg.textContent = '저장 중…';
  try {
    /* **빈 칸은 저장하지 않는다.** 빈 문자열을 보내면 쿠팡이 "값이 있는데 비었다"로
       받을 수 있다 — 안 보내는 것과 다르다. */
    const out = {};
    $$('#lfRows .lf-row').forEach((row) => {
      const v = (row.querySelector('.lf-v').value || '').trim();
      if (v) out[row.dataset.lf] = v;
    });
    await api(`listing_projects?id=eq.${LF.p.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { search_filters: out }
    });
    msg.textContent = `저장했습니다 (${Object.keys(out).length}개).`;
    toast('저장했습니다');
    await lfLoadCurrent();
  } catch (e) {
    msg.textContent = /search_filters/.test(e.message)
      ? '저장 실패: db/migrations/037_listing_settings.sql 을 아직 실행하지 않았습니다.'
      : '저장 실패: ' + e.message;
  } finally { btn.disabled = false; }
};

/* 지금 값을 이 카테고리의 기본값으로 저장한다 — 다음 상품부터 미리 채워진다.
   사용자 결정(2026-08-21): 기본값도 두고 상품별로도 고친다. */
$('#lfSaveDefault').onclick = async () => {
  if (!LF.p) return;
  const code = String(LF.p.display_category_code);
  const btn = $('#lfSaveDefault');
  btn.disabled = true;
  try {
    const cur = (await api('listing_settings?select=filter_defaults&id=eq.1&limit=1'))[0] || {};
    const all = cur.filter_defaults || {};
    const out = {};
    $$('#lfRows .lf-row').forEach((row) => {
      const v = (row.querySelector('.lf-v').value || '').trim();
      if (v) out[row.dataset.lf] = v;
    });
    all[code] = out;
    await api('listing_settings?id=eq.1', {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { filter_defaults: all, updated_by: AUTH.userId || null }
    });
    toast(`이 카테고리의 기본값으로 저장했습니다 (${Object.keys(out).length}개)`);
    await lfLoadCurrent();
  } catch (e) {
    toast(/listing_settings/.test(e.message)
      ? 'db/migrations/037 을 아직 실행하지 않았습니다'
      : '저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
};
