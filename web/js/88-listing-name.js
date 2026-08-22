/* ============================================================
   88-listing-name.js — 상품명·검색어
   ------------------------------------------------------------
   **이름을 짓는 자리다.** 등록 화면에서 고치지 않는다(D-21).

   왜 검색어를 상품명과 같은 화면에 두는가: 둘 다 **유입(조회·방문자)**을 노리는
   같은 종류의 작업이라, 따로 두면 같은 낱말을 두 번 고민하게 된다.
   등록 후 판정할 때도 같은 지표를 본다(026 PRIMARY_METRICS: views·visitors).

   경쟁사 상품명은 **참고로만** 보여준다. 자동으로 채우지 않는다 —
   채워두면 그게 초안이 되어 남의 이름을 그대로 쓰게 된다.

   파일 순서 주의(D-17): 86 뒤, 90 앞. 86의 lstFetchOne·lstStepBar 를 쓴다.
   ============================================================ */

const LN = { p: null, items: [], settings: null };

async function loadListingName() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#lnBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031_listing_pipeline.sql</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#lnPicker'), rows);
  await lnLoadCurrent();
}

async function lnLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#lnBody').classList.add('hidden');
    $('#lnEmpty').classList.remove('hidden');
    $('#lnSteps').innerHTML = '';
    return;
  }
  $('#lnEmpty').classList.add('hidden');
  $('#lnBody').classList.remove('hidden');

  const { p, items, prog } = await lstFetchOne(id);
  LN.p = p;
  LN.items = items || [];

  $('#lnSteps').innerHTML = lstStepBar(prog, 'name');
  lstGuardCategory(p, $('#lnBody'));
  $('#lnName').value = p.product_name || '';
  $('#lnDisplayName').value = p.display_product_name || '';
  $('#lnBrand').value = p.brand || '';
  $('#lnManufacture').value = p.manufacture || '';
  $('#lnTags').value = (p.search_tags || []).join(', ');
  await lnShowManufactureFrom();

  /* 소싱 때 본 상품. **판단의 출발점이라 늘 옆에 보여준다** — 이름을 지을 때
     "무엇과 경쟁하는 이름인가"가 안 보이면 그냥 예쁜 이름이 된다. */
  const s = p.source_snapshot || {};
  $('#lnRef').innerHTML = (s.product_name || s.item_name)
    ? `<div class="kv-grid">
         <span class="kv"><span class="kv-k">소싱 때 본 상품</span>
           <span class="kv-v">${esc(s.product_name || '')}</span></span>
         ${s.brand_name ? `<span class="kv"><span class="kv-k">브랜드</span>
           <span class="kv-v">${esc(s.brand_name)}</span></span>` : ''}
         ${s.current_price ? `<span class="kv"><span class="kv-k">그때 가격</span>
           <span class="kv-v">${won(s.current_price)}</span></span>` : ''}
       </div>
       <p class="muted sm">참고용입니다. 그대로 쓰지 마세요 — 같은 이름은 검색에서 밀립니다.</p>`
    : '<p class="muted sm">소싱에서 넘어온 참고 상품이 없습니다.</p>';

  const last = await lstLastNote(id, 'name');
  $('#lnNote').value = '';
  $('#lnNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';

  lnRender();
}

/* 검색어를 칩으로 보여준다. 쉼표로만 받으면 몇 개인지·중복인지 눈에 안 들어온다. */
function lnTags() {
  const raw = ($('#lnTags').value || '').split(',').map((t) => t.trim()).filter(Boolean);
  const seen = new Set();
  const uniq = [];
  const dup = [];
  raw.forEach((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) { dup.push(t); return; }
    seen.add(k);
    uniq.push(t);
  });
  return { uniq, dup };
}

function lnRender() {
  const name = ($('#lnName').value || '').trim();
  const { uniq, dup } = lnTags();

  $('#lnNameCount').textContent = name ? `${name.length}자` : '';

  /* 상품명에 이미 들어 있는 낱말을 짚어준다. **"넣지 마라"고 단정하지 않는다** —
     쿠팡이 중복을 어떻게 취급하는지 우리가 실물로 확인한 적이 없다(R-14).
     사실만 보여주고 판단은 사람이 한다. */
  const lower = name.toLowerCase();
  const inName = uniq.filter((t) => t.length > 1 && lower.includes(t.toLowerCase()));

  /* **쿠팡은 상품명 뒤에 옵션명을 붙여서 노출한다**(2026-08-21 실측):
       sellerProductName "덴넬 수제 쿠마 말랑이 슬랑이 슬라임 PVC"
       + itemName "바나나쿠마 200g 1개"
     그래서 상품명만 보고 지으면 실제로 보이는 길이를 못 가늠한다. 합쳐서 보여준다. */
  const shown = (LN.items || []).filter((it) => (it.item_name || '').trim());
  $('#lnPreview').innerHTML = !name
    ? '<span class="muted sm">상품명을 넣으면 실제 노출 형태를 보여줍니다.</span>'
    : (shown.length
        ? shown.slice(0, 4).map((it) => `<div class="sm">${esc(name)}<span class="muted">, ${
            esc(it.item_name.trim().split(/\s+/).join(', '))}</span>
            <span class="muted xs">(${name.length + it.item_name.length}자)</span></div>`).join('')
          + (shown.length > 4 ? `<div class="muted xs">…외 ${shown.length - 4}개 옵션</div>` : '')
        : `<div class="sm">${esc(name)}<span class="muted">, (옵션명이 아직 없습니다)</span></div>`);

  $('#lnTagChips').innerHTML = uniq.length
    ? uniq.map((t) => `<span class="prog ${inName.indexOf(t) >= 0 ? 'prog-dim' : 'prog-mid'}">${esc(t)}</span>`).join('')
    : '<span class="muted sm">검색어가 없습니다 — 이 단계는 검색어가 하나 이상 있어야 완료됩니다.</span>';

  const notes = [];
  notes.push(`검색어 ${uniq.length}개`);
  if (dup.length) notes.push(`중복 ${dup.length}개는 저장할 때 하나로 합칩니다 (${esc(dup.join(', '))})`);
  if (inName.length) notes.push(`상품명에 이미 들어 있는 낱말: ${esc(inName.join(', '))}`);
  $('#lnTagNote').innerHTML = notes.join(' · ');
}

$('#lnName').addEventListener('input', lnRender);
$('#lnTags').addEventListener('input', lnRender);

$('#lnPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await lnLoadCurrent();
});

$('#lnSave').onclick = async () => {
  if (!LN.p) return;
  const name = ($('#lnName').value || '').trim();
  const msg = $('#lnMsg');
  msg.classList.remove('hidden');

  if (!name) { msg.textContent = '상품명을 입력하세요.'; return; }

  const btn = $('#lnSave');
  btn.disabled = true;
  msg.textContent = '저장 중…';
  try {
    const { uniq } = lnTags();
    await api(`listing_projects?id=eq.${LN.p.id}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: {
        product_name: name,
        display_product_name: ($('#lnDisplayName').value || '').trim() || null,
        brand: ($('#lnBrand').value || '').trim() || null,
        manufacture: ($('#lnManufacture').value || '').trim() || null,
        search_tags: uniq
      }
    });
    const note = ($('#lnNote').value || '').trim();
    if (note) await lstAddNote(LN.p.id, 'name', note);

    msg.textContent = '저장했습니다.';
    toast('저장했습니다');
    await lnLoadCurrent();
    /* 이름이 바뀌면 준비 건 선택 목록의 이름도 바뀐다 — 다시 채운다 */
    try { lstFillPicker($('#lnPicker'), await lstFetchOpenProjects()); } catch (e) { /* 무시 */ }
  } catch (e) {
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};


/* 제조사는 **비었을 때 무엇이 나가는지**를 눈으로 보여준다.
   ------------------------------------------------------------
   등록 몸통의 manufacture 는 `준비 건 → 등록 설정 기본값 → 브랜드명` 순으로 정해진다
   (86-listing.js lstBuildPayload). 그 순서를 사람이 모르면 빈 칸을 "안 나간다"로 읽는다.

   이 칸이 없어서 카탈로그 매칭이 넣은 경쟁 상품 제조사가 그대로 등록된 적이 있다
   (2026-08-22 첫 등록: 제조사 "루모아"). 그래서 카탈로그에서 온 값이면 그렇게 말한다. */
async function lnShowManufactureFrom() {
  const el = $('#lnManuFrom');
  if (!el) return;
  const p = LN.p || {};
  const cur = ($('#lnManufacture').value || '').trim();

  if (cur) {
    /* 카탈로그 스냅샷의 제조사와 같으면 남의 값일 가능성이 높다. 조용히 넘기지 않는다. */
    const snapManu = ((p.catalog_snapshot || {}).manufacture || '').trim();
    el.innerHTML = (snapManu && snapManu === cur)
      ? `지금 값은 <b>카탈로그 매칭에서 본 상품의 제조사</b>입니다 — 우리 제조사가 맞는지 확인하세요.`
      : '';
    el.classList.toggle('neg', !!(snapManu && snapManu === cur));
    return;
  }

  if (LN.settings === null) {
    try { LN.settings = (await api('listing_settings?select=*&id=eq.1&limit=1'))[0] || {}; }
    catch (e) { LN.settings = {}; }
  }
  const def = (LN.settings.default_manufacture || '').trim();
  const brand = ($('#lnBrand').value || '').trim();
  el.textContent = def ? `비워두면 등록 설정의 "${def}"이(가) 나갑니다`
    : (brand ? `비워두면 브랜드명 "${brand}"이(가) 나갑니다 (쿠팡 안내와 같은 방식)`
             : '비워두면 등록할 때 제조사가 비어 경고가 뜹니다');
  el.classList.remove('neg');
}

/* 타이핑하는 동안에도 안내가 따라간다 */
$('#lnManufacture').addEventListener('input', () => lnShowManufactureFrom());
$('#lnBrand').addEventListener('input', () => {
  if (!($('#lnManufacture').value || '').trim()) lnShowManufactureFrom();
});
