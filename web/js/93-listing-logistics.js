/* ============================================================
   93-listing-logistics.js — 물류·바코드
   ------------------------------------------------------------
   WING 상품등록의 '로켓그로스 물류 입고 정보'와 같은 자리다.

   **skuInfo 는 주면 그 객체의 22개 항목이 전부 필수다**(2026-08-21 실측).
   그래서 빈칸을 남기면 등록이 깨진다 — 화면이 기본값을 미리 채워둔다.

   바코드: 기본은 **쿠팡 발급**(WING의 "상품 바코드가 없어요" = `originalBarcode: null`).
   상품 13건이 전부 그렇게 돼 있는 걸 확인했다. 우리 조인키가 쿠팡 발급 바코드라
   (D-02) 자체 바코드를 넣으면 번호가 두 벌이 된다.
   **자체 바코드 경로는 미검증**이다 — 그렇게 등록해본 적이 없다. 화면이 그렇게 말한다.

   유통기한: 카테고리 메타의 `isExpirationDateRequiredForRocketGrowth` 가 true 면
   그 카테고리는 유통기한이 필수다. 그 사실을 화면이 먼저 말한다.

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LG = { p: null, items: [], meta: null };

async function loadListingLogistics() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#lgBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#lgPicker'), rows);
  await lgLoadCurrent();
}

async function lgLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#lgBody').classList.add('hidden');
    $('#lgEmpty').classList.remove('hidden');
    $('#lgSteps').innerHTML = '';
    return;
  }
  $('#lgEmpty').classList.add('hidden');
  $('#lgBody').classList.remove('hidden');
  $('#lgItems').innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  const { p, items, prog } = await lstFetchOne(id);
  LG.p = p;
  LG.items = items;
  $('#lgSteps').innerHTML = lstStepBar(prog, 'logistics');
  lstGuardCategory(p, $('#lgBody'), items);

  /* 카테고리가 유통기한을 요구하는지. 카테고리를 아직 안 정했으면 알 수 없다(R-15). */
  LG.meta = null;
  if (p.display_category_code) {
    try {
      const rows = await api('coupang_category_meta?select=raw'
        + `&display_category_code=eq.${encodeURIComponent(p.display_category_code)}&limit=1`);
      LG.meta = (rows || [])[0] || null;
    } catch (e) { /* 029 미실행 */ }
  }
  const needExp = LG.meta && LG.meta.raw && LG.meta.raw.isExpirationDateRequiredForRocketGrowth === true;
  $('#lgCatNote').innerHTML = !p.display_category_code
    ? '카테고리를 아직 안 정해서 <b>유통기한이 필수인 카테고리인지 알 수 없습니다.</b>'
    : (LG.meta
        ? (needExp
            ? '<b class="neg">이 카테고리는 유통기한 입력이 필수입니다</b> — 소비기한 관리를 켜고 일수를 넣으세요.'
            : `카테고리 <b>${esc(p.category_path || p.display_category_code)}</b> — 유통기한은 필수가 아닙니다.`)
        : '카테고리 필수속성을 아직 안 받았습니다 — 카테고리 화면에서 [지금 받기]를 누르세요.');

  /* 상품 단위 입고 표기명(rfmInboundName)은 **따로 받지 않는다.** 등록 몸통을 만들 때
     상품명을 그대로 쓴다. 사람이 또 적게 하면 복제 원본 이름이 남는 사고(D-19)가
     이름만 바뀐 채로 반복된다. */
  $('#lgRfm').textContent = p.product_name || '(상품명 미정 — 상품명 화면에서 먼저 지으세요)';

  lgRender();

  const last = await lstLastNote(id, 'logistics');
  $('#lgNote').value = '';
  $('#lgNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';
}

const LG_SIZE_LABEL = { MINI: '극소형', SMALL: '소형', MEDIUM: '중형',
                        LARGE1: '대형1', LARGE2: '대형2', XLARGE: '특대형' };

function lgRender() {
  if (!LG.items.length) {
    $('#lgItems').innerHTML = '<p class="muted">옵션이 없습니다 — 옵션·가격 화면에서 먼저 만드세요.</p>';
    return;
  }
  const v = (x) => (x == null ? '' : esc(String(x)));
  const prodName = (LG.p.product_name || '').trim();

  $('#lgItems').innerHTML = LG.items.map((it) => {
    const nm = (it.item_name || '').trim() || `옵션 ${it.position + 1}`;
    /* 입고 표기명은 비어 있으면 '상품명 + 옵션명'을 제안한다. 창고에 붙는 이름표라
       비워두면 복제 원본 이름이 그대로 간다(D-19에서 실제로 겪은 함정). */
    const suggest = [prodName, (it.item_name || '').trim()].filter(Boolean).join(' ');
    return `<div class="lp-card" data-lg="${esc(it.id)}">
      <div class="lp-card-head"><b style="flex:1">${esc(nm)}</b>
        <span class="prog prog-dim">크기 등급 ${esc(LG_SIZE_LABEL[it.size_type] || it.size_type || '미정')}
          <span class="muted">· 옵션·가격 화면에서</span></span></div>

      <label class="field"><span>입고 표기명 <span class="muted">창고에 붙는 이름표</span></span>
        <div class="range">
          <input class="lg-inbound" type="text" value="${v(it.inbound_name)}"
                 placeholder="${esc(suggest || '예: 덴넬 수제 딸기 슬라임 레드')}" />
          ${suggest ? '<button class="btn btn-sm lg-fill">상품명+옵션명으로</button>' : ''}
        </div></label>

      <div class="two">
        <label class="field"><span>가로 (mm)</span>
          <input class="lg-w" type="number" min="0" value="${v(it.sku_width)}" /></label>
        <label class="field"><span>세로 (mm)</span>
          <input class="lg-l" type="number" min="0" value="${v(it.sku_length)}" /></label>
      </div>
      <div class="two">
        <label class="field"><span>높이 (mm)</span>
          <input class="lg-h" type="number" min="0" value="${v(it.sku_height)}" /></label>
        <label class="field"><span>무게 (g) <span class="muted">포장 포함</span></span>
          <input class="lg-wt" type="number" min="0" value="${v(it.sku_weight)}" /></label>
      </div>
      <label class="field"><span>내용물 무게 (g) <span class="muted">모르면 비움</span></span>
        <input class="lg-nwt" type="number" min="0" value="${v(it.sku_net_weight)}" /></label>

      <h4 class="sku-sec">바코드</h4>
      <label class="chk"><input type="radio" name="bc-${esc(it.id)}" class="lg-bc-coupang"
        ${it.barcode_mode !== 'own' ? 'checked' : ''} />
        <span>상품 바코드가 없어요 — <b>쿠팡이 발급</b>합니다 (기본)</span></label>
      <label class="chk" style="margin-left:14px"><input type="radio" name="bc-${esc(it.id)}" class="lg-bc-own"
        ${it.barcode_mode === 'own' ? 'checked' : ''} />
        <span>자체 바코드를 씁니다</span></label>
      <input class="lg-bc-value ${it.barcode_mode === 'own' ? '' : 'hidden'}" type="text"
             placeholder="바코드 번호" value="${v(it.own_barcode)}" style="margin-top:6px" />
      <p class="muted sm">자체 바코드는 <b>아직 실물로 검증되지 않은 경로</b>입니다 —
        이 계정 상품 13건은 전부 쿠팡 발급을 쓰고 있습니다.
        우리 시스템의 조인키도 쿠팡 발급 바코드입니다.</p>

      <h4 class="sku-sec">포장·날짜</h4>
      <label class="chk"><input type="checkbox" class="lg-fragile" ${it.fragile ? 'checked' : ''} />
        <span>깨지거나 샐 수 있는 상품입니다 <span class="muted">유리병·액체류</span></span></label>
      <label class="chk"><input type="checkbox" class="lg-exp" ${it.expired_at_managed ? 'checked' : ''} />
        <span>소비기한(유통기한)을 관리하는 상품입니다</span></label>
      <label class="field" style="margin-top:6px"><span>유통기한 (일) <span class="muted">없으면 0</span></span>
        <input class="lg-dp" type="number" min="0" value="${it.distribution_period == null ? 0 : it.distribution_period}" /></label>
      <div class="two">
        <label class="chk"><input type="checkbox" class="lg-prod" ${it.produced_at_managed ? 'checked' : ''} />
          <span>제조일 관리 <span class="muted">producedAtManaged</span></span></label>
        <label class="chk"><input type="checkbox" class="lg-manu" ${it.manufactured_at_managed ? 'checked' : ''} />
          <span>생산일 관리 <span class="muted">manufacturedAtManaged</span></span></label>
      </div>
      <p class="muted sm">쿠팡 응답에 날짜 플래그가 <b>셋</b>입니다. WING 화면의
        "제조일이 적혀 있나요?"가 위 둘 중 어느 쪽인지는 <b>아직 확인 못 했습니다</b> —
        실측 13건이 전부 false 라 구분할 근거가 없었습니다. 모르면 둘 다 꺼두세요.</p>
    </div>`;
  }).join('');
}

/* 입고 표기명 자동 채우기 */
$('#lgItems').addEventListener('click', (ev) => {
  if (!ev.target.matches('.lg-fill')) return;
  const card = ev.target.closest('[data-lg]');
  const it = LG.items.find((x) => x.id === card.dataset.lg);
  const suggest = [(LG.p.product_name || '').trim(), (it.item_name || '').trim()].filter(Boolean).join(' ');
  card.querySelector('.lg-inbound').value = suggest;
});

/* 바코드 방식에 따라 입력칸을 켜고 끈다 — 안 쓰는 칸을 남겨두면 값을 넣고 버려진다 */
$('#lgItems').addEventListener('change', (ev) => {
  if (!ev.target.matches('.lg-bc-coupang, .lg-bc-own')) return;
  const card = ev.target.closest('[data-lg]');
  const own = card.querySelector('.lg-bc-own').checked;
  card.querySelector('.lg-bc-value').classList.toggle('hidden', !own);
});

$('#lgPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await lgLoadCurrent();
});

/* ---------- 저장 ---------- */
$('#lgSave').onclick = async () => {
  if (!LG.p) return;
  const btn = $('#lgSave');
  const msg = $('#lgMsg');
  btn.disabled = true;
  msg.classList.remove('hidden');
  msg.textContent = '저장 중…';
  try {
    const numOrNull = (el) => { const n = Number(el.value); return el.value === '' || !Number.isFinite(n) ? null : Math.round(n); };
    for (const card of $$('#lgItems [data-lg]')) {
      const own = card.querySelector('.lg-bc-own').checked;
      await api(`listing_project_items?id=eq.${card.dataset.lg}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: {
          inbound_name: (card.querySelector('.lg-inbound').value || '').trim() || null,
          sku_width: numOrNull(card.querySelector('.lg-w')),
          sku_length: numOrNull(card.querySelector('.lg-l')),
          sku_height: numOrNull(card.querySelector('.lg-h')),
          sku_weight: numOrNull(card.querySelector('.lg-wt')),
          sku_net_weight: numOrNull(card.querySelector('.lg-nwt')),
          barcode_mode: own ? 'own' : 'coupang',
          own_barcode: own ? ((card.querySelector('.lg-bc-value').value || '').trim() || null) : null,
          fragile: card.querySelector('.lg-fragile').checked,
          expired_at_managed: card.querySelector('.lg-exp').checked,
          distribution_period: numOrNull(card.querySelector('.lg-dp')) || 0,
          produced_at_managed: card.querySelector('.lg-prod').checked,
          manufactured_at_managed: card.querySelector('.lg-manu').checked
        }
      });
    }
    const note = ($('#lgNote').value || '').trim();
    if (note) await lstAddNote(LG.p.id, 'logistics', note);

    msg.textContent = '저장했습니다.';
    toast('저장했습니다');
    await lgLoadCurrent();
  } catch (e) {
    /* 034 미실행이면 여기서 걸린다 — 무엇을 해야 하는지 말한다 */
    msg.textContent = /produced_at_managed|manufactured_at_managed/.test(e.message)
      ? '저장 실패: db/migrations/034_sku_date_flags.sql 을 아직 실행하지 않았습니다.'
      : '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
