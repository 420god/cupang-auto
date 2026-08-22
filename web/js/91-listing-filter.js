/* ============================================================
   91-listing-filter.js — 검색필터 (카테고리 속성)
   ------------------------------------------------------------
   WING 상품등록의 '검색필터' 칸이다. **카테고리를 정해야 목록이 나온다** —
   카테고리마다 항목이 완전히 다르다.

   쿠팡 API 는 필수속성과 검색필터를 **한 배열(items[].attributes)** 로 받는다.
   화면만 나뉘어 있을 뿐이다. 그래서 여기서 채운 값도 등록할 때 그 배열에 합친다.

   **확정됐다(2026-08-21, WING 캡처 대조).** 검색필터 = 카테고리 메타의 속성 중
   `required !== 'MANDATORY'` 인 것들이다. 103112 캡처의 항목(캐릭터·최소 연령·
   본품/리필·클레이 놀이구성·색상종류·선물포장 타입·…·GTIN)이 우리 목록 25개와 같았다.
   필수 3개(색상·개당 중량·수량)는 WING에서 **옵션 화면** 쪽에 있다.

   입력 방식도 메타가 알려준다: `inputType`(SELECT/INPUT) · `inputValues`(고를 값) ·
   `usableUnits`(단위). 그래서 드롭다운을 우리가 지어내지 않고 그대로 그린다.

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

/* 입력 방식은 **메타가 알려준다**(2026-08-21 실물 확인):
     inputType SELECT → inputValues 중에서 고른다 (예: 선물포장 타입 = 바구니·보자기·…)
     inputType INPUT + usableUnits → 숫자 + 단위 (예: 개당 중량 = 70 + g)
     inputType INPUT + 단위 없음   → 자유 입력
   값은 단위를 붙여 저장한다 — 실측 상품의 값이 "70g" · "1개" 형태였다. */
function lfRender() {
  if (!LF.attrs.length) {
    $('#lfRows').innerHTML = '<p class="muted">이 카테고리에는 선택 속성이 없습니다.</p>';
    return;
  }
  $('#lfRows').innerHTML = '<div class="lf-grid">' + LF.attrs.map((a) => {
    const nm = a.attributeTypeName;
    const raw = LF.values[nm] == null ? '' : String(LF.values[nm]);
    const isDefault = !((LF.p.search_filters || {})[nm]) && LF.defaults[nm];
    const units = a.usableUnits && a.usableUnits.length ? a.usableUnits
      : ((a.basicUnit && a.basicUnit !== '없음') ? [a.basicUnit] : []);

    let control;
    if (a.inputType === 'SELECT' && (a.inputValues || []).length) {
      control = `<select class="lf-v">
        <option value="">선택안함</option>
        ${a.inputValues.map((v) => `<option${v === raw ? ' selected' : ''}>${esc(v)}</option>`).join('')}
      </select>`;
    } else if (units.length) {
      /* 저장된 값에서 숫자와 단위를 떼어낸다("70g" → 70 · g) */
      const m = raw.match(/^\s*([\d.]+)\s*(.*)$/);
      const num = m ? m[1] : '';
      const unit = (m && m[2]) || units[0];
      control = `<div class="range">
        <input class="lf-v" type="number" step="any" value="${esc(num)}" placeholder="숫자" />
        <select class="lf-unit" style="max-width:90px">
          ${units.map((u) => `<option${u === unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}
        </select></div>`;
    } else {
      control = `<input class="lf-v" type="text" value="${esc(raw)}" placeholder="직접 입력" />`;
    }

    return `<label class="field lf-row" data-lf="${esc(nm)}">
      <span>${esc(nm)}${isDefault ? ' <span class="prog prog-dim">설정 기본값</span>' : ''}</span>
      ${control}</label>`;
  }).join('') + '</div>';
}

/* 화면의 값을 모은다. **빈 칸은 담지 않는다** — 빈 문자열을 보내면 쿠팡이
   "값이 있는데 비었다"로 받을 수 있어 안 보내는 것과 다르다.
   숫자+단위는 실측 형태("70g")대로 붙여서 담는다. */
function lfCollect() {
  const out = {};
  $$('#lfRows .lf-row').forEach((row) => {
    const el = row.querySelector('.lf-v');
    const v = (el.value || '').trim();
    if (!v) return;
    const unitEl = row.querySelector('.lf-unit');
    out[row.dataset.lf] = unitEl ? (v + unitEl.value) : v;
  });
  return out;
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
    const out = lfCollect();
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
    const out = lfCollect();
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
