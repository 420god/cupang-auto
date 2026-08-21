/* ============================================================
   85-product-edit.js — 상품수정
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다**(D-17). 이 파일은 80-products.js 뒤에 온다 —
   SKUS(목록 데이터)와 편집 함수들이 거기 있고, 여기서 그걸 그대로 쓴다.

   왜 상품원장에서 떼어냈나: 단순히 정리하려는 게 아니다.
   **고치는 곳과 고친 결과를 보는 곳을 같은 화면에 두려는 것**이다 —
   썸네일을 바꾸려고 들어오면 지난번에 바꿨을 때 어땠는지가 바로 보인다.
   상품원장은 내부 관리(공급처·발주 파라미터·한글표시사항)로 남는다.
   ============================================================ */

/* 목록에 "최근 7일 조회"를 같이 보여준다. 어느 상품을 손봐야 하는지 고르는 게
   이 화면의 첫 일인데, 조회가 없는 상품은 썸네일을 바꿔도 확인할 방법이 없다. */
const PE = { views7: new Map(), lastChange: new Map() };

async function loadProductEdit() {
  const el = $('#peRows');
  el.innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';

  /* 상품원장 데이터를 그대로 쓴다 — 같은 SKU 목록을 두 벌로 만들면 어긋난다. */
  if (!SKUS.rows.length) {
    try { await loadSkus(); } catch (e) { /* 아래에서 빈 목록으로 처리 */ }
  }

  const since = kstDateStr(new Date(Date.now() - 7 * 86400000));
  PE.views7 = new Map();
  PE.lastChange = new Map();
  try {
    const rows = await apiAll(`coupang_item_metrics_daily?select=vendor_item_id,views`
      + `&metric_date=gte.${since}`) || [];
    rows.forEach((r) => {
      const k = String(r.vendor_item_id);
      PE.views7.set(k, (PE.views7.get(k) || 0) + (Number(r.views) || 0));
    });
  } catch (e) { /* 027 미실행이면 없음으로 둔다 */ }
  try {
    const rows = await apiAll('product_change_history?select=vendor_item_id,field,changed_at'
      + '&order=changed_at.desc&limit=500') || [];
    rows.forEach((r) => {
      const k = String(r.vendor_item_id);
      if (!PE.lastChange.has(k)) PE.lastChange.set(k, r);
    });
  } catch (e) { /* 026 미실행 */ }

  renderProductEdit();
}

const PE_FIELD_LABEL = {
  thumbnail: '대표이미지', detail_page: '상세페이지', search_tags: '검색어',
  product_name: '상품명', item_name: '옵션명', price: '가격', sale_status: '판매상태'
};

function renderProductEdit() {
  const q = ($('#peSearch').value || '').trim().toLowerCase();
  /* 옵션ID가 없으면 쿠팡에 쏠 대상이 없다 — 이 화면에서는 아예 뺀다.
     상품원장은 그런 SKU도 보여줘야 하지만(공급처 관리는 되니까) 여기선 할 일이 없다. */
  const list = SKUS.rows.filter((r) => r.vid && skuMatches(r, q));

  /* **지표에 잡힌 옵션 수를 같이 보여준다.** 조회가 0인 옵션은 WING 목록에
     아예 안 나와서 우리 지표 표에도 행이 없다 — 그런 옵션은 썸네일을 바꿔도
     확인할 방법이 없다. 몇 개가 그런 상태인지 한눈에 보여야 손볼 대상을 고른다. */
  const withMetrics = list.filter((r) => PE.views7.has(r.vid)).length;
  $('#peSummary').textContent =
    `쿠팡 연결 ${SKUS.rows.filter((r) => r.vid).length}개`
    + ` · 최근 7일 지표 있는 옵션 ${withMetrics}개`
    + (q ? ` · 표시 ${list.length}개` : '');

  const note = $('#peNote');
  if (note) {
    note.textContent = PE.views7.size
      ? ''
      : '최근 7일 지표가 없습니다 — 지표 동기화가 아직 안 됐거나 마이그레이션 027이 미실행입니다.';
  }

  if (!list.length) {
    el4('#peRows', '<tr><td colspan="6" class="muted">해당하는 상품이 없습니다.</td></tr>');
    return;
  }

  $('#peRows').innerHTML = list.map((r) => {
    const reg = r.reg;
    const v7 = PE.views7.get(r.vid);
    const ch = PE.lastChange.get(r.vid);
    const price = !reg || reg.sale_price == null
      ? '<span class="muted">미조회</span>'
      : `${Number(reg.sale_price).toLocaleString()}원`
        + (reg.on_sale === false ? '<span class="sku-name-sub">판매중지</span>' : '');
    return `<tr class="prow" data-sku="${esc(r.sku.id)}">
      <td>${esc(r.sku.sku_name)}</td>
      <td class="sku-bc">${esc(r.vid)}</td>
      <td class="col-num">${price}</td>
      <td class="col-num">${!reg || reg.amount_in_stock == null
          ? '<span class="muted">—</span>' : cnt(reg.amount_in_stock)}</td>
      <td class="col-num">${v7 == null
          ? '<span class="muted">—</span>' : cnt(v7)}</td>
      <td>${ch
          ? `${esc(PE_FIELD_LABEL[ch.field] || ch.field)} <span class="sku-name-sub">${esc(ch.changed_at.slice(0, 10))}</span>`
          : '<span class="muted">없음</span>'}</td>
    </tr>`;
  }).join('');
}

function el4(sel, html) { const e = $(sel); if (e) e.innerHTML = html; }

$('#peSearch').oninput = () => renderProductEdit();
$('#pePriceSync').onclick = () => $('#skuPriceSync').click();   // 같은 동작을 두 벌로 만들지 않는다

$('#peRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-sku]');
  if (tr) openProdEditModal(tr.dataset.sku);
});

/* 편집 모달. 안의 절들은 원래 상품원장 모달에 있던 것을 그대로 옮긴 것이라
   ID가 같고, 그래서 renderPriceSection/renderProductSection 이 손대지 않고 돈다. */
function openProdEditModal(skuId) {
  const r = SKUS.byId.get(skuId);
  if (!r) return;
  SKUS.editing = r;
  const s = r.sku;

  $('#peModalTitle').textContent = s.sku_name;
  $('#peRo').innerHTML = [
    ['바코드', s.barcode || '없음'],
    ['옵션ID', r.vid || '—'],
    ['등록상품ID', r.listing ? r.listing.external_product_id : '—']
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  $('#prodEditModal').classList.remove('hidden');
  renderPriceSection(r);
  renderProductSection(r);
  renderExperiments(r);
}

function closeProdEditModal() {
  $('#prodEditModal').classList.add('hidden');
  SKUS.editing = null;
}
$$('#prodEditModal [data-close]').forEach((b) => { b.onclick = closeProdEditModal; });

/* 이 옵션의 실험 기록. v_product_experiments(db/migrations/028)를 그대로 읽는다 —
   계산식을 화면에서 다시 쓰지 않는다. AI가 읽는 것과 **같은 잣대**여야 한다. */
async function renderExperiments(r) {
  const box = $('#peExperiments');
  box.innerHTML = '<span class="muted">불러오는 중…</span>';
  if (!r.vid) { box.innerHTML = '<span class="muted">옵션ID가 없습니다.</span>'; return; }
  try {
    const rows = await api(`v_product_experiments?select=*`
      + `&vendor_item_id=eq.${encodeURIComponent(r.vid)}`
      + `&order=changed_at.desc&limit=10`) || [];
    if (!rows.length) {
      box.innerHTML = '<span class="muted">아직 변경 기록이 없습니다. '
        + '여기서 바꾸면 전후 지표가 자동으로 붙습니다.</span>';
      return;
    }
    box.innerHTML = rows.map((x) => {
      const pct = (v) => v == null ? '—'
        : `<span class="${Number(v) >= 0 ? 'pos' : 'neg'}">${Number(v) > 0 ? '+' : ''}${v}%</span>`;
      /* **판단 가능 여부를 먼저 보여준다.** 숫자를 먼저 보면 사람도 AI도 과신한다.
         verdict 는 뷰가 계산한다 — 화면이 따로 판단하면 기준이 갈린다. */
      const ok = x.verdict === '비교 가능';
      return `<div style="margin:10px 0;padding:8px 0;border-top:1px solid var(--line)">
        <div><b>${esc(PE_FIELD_LABEL[x.field] || x.field)}</b>
             <span class="muted">${esc(String(x.changed_at).slice(0, 10))}</span>
             ${x.source === 'sync' ? '<span class="muted">· WING에서 변경됨</span>' : ''}</div>
        ${x.hypothesis ? `<div class="muted">가설: ${esc(x.hypothesis)}</div>` : ''}
        <div class="${ok ? 'muted' : 'neg'}">${esc(x.verdict)}</div>
        ${ok ? `<div>조회 ${pct(x.views_change_pct)} ·
                     주문 ${pct(x.orders_change_pct)} ·
                     전환율 ${pct(x.conv_change_pct)}
                <span class="muted">(전 ${x.days_before}일 / 후 ${x.days_after}일)</span></div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<span class="muted">실험 기록을 불러오지 못했습니다 '
      + '(마이그레이션 028 미실행일 수 있습니다).</span>';
  }
}

/* ===================== 신규 상품 등록 (복제 기반) =====================
   최상위 23키 + 옵션 23키를 사람이 다 채우면 WING에서 하는 것과 다를 게 없다.
   비슷한 기존 상품을 복제하면 배송·반품지·과세유형·고시정보·필수속성이 그대로
   따라오고, 사람은 이름·가격·이미지·검색어만 바꾸면 된다.
   **다품종 소량이라 비슷한 상품이 계속 나오는 구조**에 이게 맞다.

   실제 복제(식별자 제거·이미지 이관)는 워커가 한다 — 웹은 "무엇을 만들지"만 담는다.
   식별자를 안 지우면 "중복된 바코드가 존재합니다"로 막힌다(정찰에서 실제로 겪음). */

const PN = { rows: 1 };

/* **가격 칸이 둘이다.** 이 계정의 상품은 로켓그로스와 판매자배송을 동시에 운영하고,
   두 채널의 가격이 일부러 다르다(실측 원본: 로켓그로스 7,500 / 판매자배송 13,000).
   한 칸만 받아 양쪽에 같은 값을 넣으면 판매자배송 가격이 의도와 다르게 등록된다. */
function pnItemRow(i) {
  return `<div data-pn-item="${i}" style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px">
    <label class="field"><span>옵션명 ${i}</span>
      <input class="pn-item-name" type="text" placeholder="예: 딸기, 100g, 1개" /></label>
    <div class="two">
      <label class="field"><span>로켓그로스 판매가 (원)</span>
        <input class="pn-item-price" type="number" min="0" step="10" /></label>
      <label class="field"><span>판매자배송 판매가 (원)</span>
        <input class="pn-item-mprice" type="number" min="0" step="10" /></label>
    </div>
    <label class="field"><span>대표이미지 <span class="muted">비우면 복제 원본 것을 씁니다</span></span>
      <input class="pn-item-image" type="file" accept="image/*" /></label>

    <!-- 로켓그로스 물류 입고 정보(skuInfo). **비우면 복제 원본 값이 그대로 간다** —
         새 상품 크기가 다르면 틀린 규격으로 등록되므로 확인해야 한다.
         단위는 문서 확인: 가로·세로·높이 mm, 무게 g. -->
    <div class="muted sm" style="margin-top:4px">물류 입고 정보
      <span data-pn-srcsku></span></div>
    <div class="two">
      <label class="field"><span>가로 (mm)</span>
        <input class="pn-sku-w" type="number" min="0" /></label>
      <label class="field"><span>세로 (mm)</span>
        <input class="pn-sku-l" type="number" min="0" /></label>
    </div>
    <div class="two">
      <label class="field"><span>높이 (mm)</span>
        <input class="pn-sku-h" type="number" min="0" /></label>
      <label class="field"><span>무게 (g)</span>
        <input class="pn-sku-wt" type="number" min="0" /></label>
    </div>
    <label class="field"><span>유통기한 (일) <span class="muted">없으면 0</span></span>
      <input class="pn-sku-dp" type="number" min="0" /></label>
  </div>`;
}

/* 복제 원본의 skuInfo 를 칸에 채워 넣고 원본 값을 옆에 적어준다.
   **비워두면 원본 값이 그대로 등록된다** — 새 상품 크기가 다르면 그게 곧 오류다.
   그래서 빈 칸으로 두지 않고 원본 값을 미리 넣어 "이대로 갈 거다"를 보이게 한다. */
function pnFillSkuInfo() {
  const src = $('#pnSource').value;
  const row0 = SKUS.rows.find((r) => r.reg && String(r.reg.seller_product_id) === String(src)
    && r.reg.product_json);
  const it = row0 && (row0.reg.product_json.items || [])[0];
  const sku = it && it.rocketGrowthItemData && it.rocketGrowthItemData.skuInfo;

  $$('#pnItems [data-pn-item]').forEach((row) => {
    const note = row.querySelector('[data-pn-srcsku]');
    if (!sku) {
      note.textContent = '— 복제 원본의 값을 못 읽어 직접 입력해야 합니다';
      return;
    }
    note.textContent = `— 복제 원본: ${sku.width}×${sku.length}×${sku.height}mm · ${sku.weight}g`;
    const set = (cls, v) => {
      const el = row.querySelector(cls);
      if (el && el.dataset.touched !== '1') el.value = (v == null ? '' : v);
    };
    set('.pn-sku-w', sku.width);
    set('.pn-sku-l', sku.length);
    set('.pn-sku-h', sku.height);
    set('.pn-sku-wt', sku.weight);
    set('.pn-sku-dp', sku.distributionPeriod);
  });
}

/* 복제 원본이 **어느 채널을 쓰는지** 본다.
   상품마다 다르다(2026-08-20 실측): 정찰에서 본 상품은 로켓그로스 7,500 /
   판매자배송 13,000의 이중 채널이었는데, 다른 상품은 marketplaceItemData 가
   **null** 인 로켓그로스 전용이었다.
   판매자배송 가격을 무조건 필수로 요구하면 단일 채널 상품을 복제할 수 없다. */
function pnSourceChannels() {
  const src = $('#pnSource').value;
  const known = { unknown: true, hasRG: true, hasMP: true, ratio: null, rg: null, mp: null };
  if (!src) return known;
  const row = SKUS.rows.find((r) => r.reg && String(r.reg.seller_product_id) === String(src)
    && r.reg.product_json);
  const it = row && (row.reg.product_json.items || [])[0];
  if (!it) return known;   // 원문을 아직 안 받았으면 모르는 것으로 둔다(R-15)

  const rgD = it.rocketGrowthItemData && it.rocketGrowthItemData.priceData;
  const mpD = it.marketplaceItemData && it.marketplaceItemData.priceData;
  const out = { unknown: false, hasRG: !!rgD, hasMP: !!mpD, ratio: null,
                rg: rgD ? Number(rgD.salePrice) : null,
                mp: mpD ? Number(mpD.salePrice) : null };
  if (out.rg > 0 && out.mp > 0) out.ratio = out.mp / out.rg;
  return out;
}

/* 이름은 예전 것을 유지한다 — 부르는 곳이 여럿이라. 비율이 있을 때만 값을 준다. */
function pnSourcePriceRatio() {
  const c = pnSourceChannels();
  return c.ratio ? c : null;
}

/* 채널 구성에 맞춰 판매자배송 칸을 켜고 끈다.
   **없는 채널의 칸을 남겨두면 사람이 값을 넣고 그게 조용히 버려진다.** */
function pnApplyChannels() {
  const c = pnSourceChannels();
  $$('#pnItems [data-pn-item]').forEach((row) => {
    const lab = row.querySelector('.pn-item-mprice').closest('.field');
    const on = c.unknown || c.hasMP;
    lab.classList.toggle('hidden', !on);
    if (!on) row.querySelector('.pn-item-mprice').value = '';
  });
  $('#pnSourceHint').textContent = c.unknown
    ? '이 상품의 원문을 아직 안 받아서 채널 구성을 모릅니다 — 값을 직접 확인하세요.'
    : c.hasMP
      ? (c.ratio
          ? `이 상품은 로켓그로스 ${c.rg.toLocaleString()}원 · 판매자배송 ${c.mp.toLocaleString()}원으로`
            + ` 운영 중입니다 (${c.ratio.toFixed(2)}배). 아래 판매자배송 칸을 이 비율로 채워드립니다 — 확인하고 고치세요.`
          : '이 상품은 판매자배송도 함께 운영합니다. 판매자배송 가격을 직접 입력하세요.')
      : '이 상품은 로켓그로스 전용입니다 — 판매자배송 가격은 받지 않습니다.';
}

/* 로켓그로스 가격을 치면 판매자배송 칸을 원본 비율로 채워준다.
   **이미 사람이 손댄 칸은 건드리지 않는다** — 제안이지 강제가 아니다. */
function pnSuggestMarketPrice(row) {
  const r = pnSourcePriceRatio();
  const mEl = row.querySelector('.pn-item-mprice');
  if (!r || mEl.dataset.touched === '1') return;
  const rg = Number(row.querySelector('.pn-item-price').value);
  if (!Number.isFinite(rg) || rg <= 0) { mEl.value = ''; return; }
  mEl.value = Math.round(rg * r.ratio / 10) * 10;
}

function pnRenderItems() {
  $('#pnItems').innerHTML = Array.from({ length: PN.rows }, (_, i) => pnItemRow(i + 1)).join('');
}

$('#pnAddItem').onclick = () => { PN.rows++; pnRenderItems(); pnApplyChannels(); pnFillSkuInfo(); };

$('#pnItems').addEventListener('input', (ev) => {
  const row = ev.target.closest('[data-pn-item]');
  if (!row) return;
  if (ev.target.classList.contains('pn-item-mprice')) ev.target.dataset.touched = '1';
  if (/pn-sku-/.test(ev.target.className)) ev.target.dataset.touched = '1';
  if (ev.target.classList.contains('pn-item-price')) pnSuggestMarketPrice(row);
});

/* 복제 원본을 바꾸면 비율이 달라진다 — 사람이 안 건드린 칸을 다시 제안한다. */
$('#pnSource').addEventListener('change', () => {
  pnApplyChannels();
  pnFillSkuInfo();
  $$('#pnItems [data-pn-item]').forEach((row) => pnSuggestMarketPrice(row));
});

$('#peNewBtn').onclick = () => {
  /* 복제 원본은 **상품 원문을 이미 받아둔 것만** 고를 수 있다. 원문이 없으면
     워커가 조회해서 쓰긴 하지만, 사람이 "무엇이 복제되는지" 모르는 채 고르게 된다. */
  const cands = SKUS.rows.filter((r) => r.reg && r.reg.seller_product_id);
  const seen = new Set();
  const opts = [];
  cands.forEach((r) => {
    const id = String(r.reg.seller_product_id);
    if (seen.has(id)) return;
    seen.add(id);
    opts.push(`<option value="${esc(id)}">${esc(r.sku.sku_name.slice(0, 50))}</option>`);
  });
  $('#pnSource').innerHTML = opts.length
    ? opts.join('')
    : '<option value="">복제할 상품이 없습니다</option>';

  ['#pnProductName', '#pnSearchTags', '#pnExpQty', '#pnExpCost', '#pnExpPrice',
   '#pnExpMargin', '#pnReason'].forEach((id) => { $(id).value = ''; });
  $('#pnRequested').checked = false;
  $('#pnDetailImages').value = '';
  $('#pnDetailPreview').innerHTML = '';
  $('#pnMsg').textContent = '';
  PN.rows = 1;
  PN.draftId = null;
  PN.loaded = null;
  pnRenderItems();
  pnApplyChannels();
  pnFillSkuInfo();
  $('#prodNewModal').classList.remove('hidden');
  pnLoadDrafts();
};

$$('#prodNewModal [data-close]').forEach((b) => {
  b.onclick = () => $('#prodNewModal').classList.add('hidden');
});

$('#pnDetailImages').addEventListener('change', () => {
  const fs = Array.from($('#pnDetailImages').files || []);
  $('#pnDetailPreview').innerHTML = fs.length
    ? `<div class="muted">${fs.length}장으로 상세페이지를 만듭니다 (왼쪽부터 순서)</div>`
      + fs.map((f, i) => localPreview(f, 70) + `<span class="muted sm">${i + 1}</span>`).join('')
    : '';
});

/* 폼 → 저장할 값. **초안 저장과 등록이 같은 함수를 쓴다** —
   두 벌로 만들면 "초안에서는 되는데 등록하면 다르다"가 생긴다. */
function pnCollect(strict) {
  const src = $('#pnSource').value;
  const name = ($('#pnProductName').value || '').trim();
  if (!name) return { err: '상품명을 입력하세요.' };
  if (strict && !src) return { err: '복제할 상품을 고르세요.' };

  const items = [];
  for (const row of $$('#pnItems [data-pn-item]')) {
    const nm = (row.querySelector('.pn-item-name').value || '').trim();
    const pr = Number(row.querySelector('.pn-item-price').value);
    const mp = Number(row.querySelector('.pn-item-mprice').value);
    /* 판매자배송 칸이 숨겨져 있으면(원본이 로켓그로스 전용) 요구하지 않는다 —
       없는 채널의 값을 강요하면 등록 자체를 못 한다. */
    const needMp = !row.querySelector('.pn-item-mprice').closest('.field').classList.contains('hidden');
    if (strict) {
      if (!nm) return { err: '옵션명을 모두 입력하세요.' };
      if (!Number.isFinite(pr) || pr <= 0) return { err: '로켓그로스 판매가를 모두 입력하세요.' };
      if (needMp && (!Number.isFinite(mp) || mp <= 0)) return { err: '판매자배송 판매가를 모두 입력하세요.' };
    }
    /* 물류 규격. **부분만 보내면 안 된다** — 문서상 skuInfo 를 주면 그 객체의 모든
       항목이 필수다. 그래서 여기서는 '덮어쓸 값'만 모으고, 워커가 복제 원본의
       skuInfo 에 얹는다. 그러면 나머지 항목은 원본 값이 그대로 남는다. */
    const n2 = (cls) => { const v = Number(row.querySelector(cls).value); return Number.isFinite(v) && v >= 0 ? Math.round(v) : null; };
    const skuOverride = { width: n2('.pn-sku-w'), length: n2('.pn-sku-l'),
                          height: n2('.pn-sku-h'), weight: n2('.pn-sku-wt'),
                          distributionPeriod: n2('.pn-sku-dp') };
    if (strict) {
      const miss = ['width', 'length', 'height', 'weight']
        .filter((k) => skuOverride[k] === null || skuOverride[k] === 0);
      if (miss.length) return { err: '물류 입고 정보(가로·세로·높이·무게)를 모두 입력하세요.' };
    }
    items.push({ el: row, itemName: nm,
                 salePrice: Number.isFinite(pr) && pr > 0 ? Math.round(pr) : null,
                 marketplaceSalePrice: Number.isFinite(mp) && mp > 0 ? Math.round(mp) : null,
                 skuInfo: skuOverride });
  }
  const num = (id) => { const v = ($(id).value || '').trim(); return v === '' ? null : Number(v); };
  return {
    src, name, items,
    tags: ($('#pnSearchTags').value || '').split(',').map((t) => t.trim()).filter(Boolean),
    requested: $('#pnRequested').checked === true,
    decision: {
      expected_monthly_qty: num('#pnExpQty'),
      expected_unit_cost_krw: num('#pnExpCost'),
      expected_sell_price: num('#pnExpPrice'),
      expected_margin_rate: num('#pnExpMargin'),
      reason_memo: ($('#pnReason').value || '').trim() || null
    }
  };
}

/* 초안 저장. **쿠팡에는 아무것도 보내지 않는다.**
   이미지는 지금 올린다 — 파일은 나중에 다시 못 집어오기 때문이다(파일 입력은
   초안을 다시 열었을 때 비어 있다). 올려두면 URL로 남아 초안에 실린다. */
$('#pnDraftSave').onclick = async () => {
  const f = pnCollect(false);
  if (f.err) { $('#pnMsg').textContent = f.err; return; }
  const btn = $('#pnDraftSave');
  btn.disabled = true;
  $('#pnMsg').textContent = '초안을 저장하는 중…';
  try {
    const payload = await pnBuildPayload(f);
    await api('product_drafts', {
      method: 'POST',
      body: {
        name: f.name,
        source_seller_product_id: f.src || null,
        payload,
        decision: f.decision,
        created_by: AUTH.userId || null
      }
    });
    $('#pnMsg').textContent = '초안으로 저장했습니다 — 쿠팡에는 아무것도 보내지 않았습니다.';
    await pnLoadDrafts();
  } catch (e) {
    $('#pnMsg').textContent = `초안 저장 실패: ${e.message}`;
  } finally { btn.disabled = false; }
};

/* 이미지 업로드까지 끝낸 payload 를 만든다. 초안·등록이 공유한다. */
async function pnBuildPayload(f) {
  const folder = 'new/' + kstDateStr(new Date());
  const detailFiles = Array.from($('#pnDetailImages').files || []);
  let contents;
  if (detailFiles.length) {
    const urls = [];
    for (const file of detailFiles) urls.push(await uploadProductImage(file, folder));
    contents = urls.map((u) => ({
      contentsType: 'IMAGE_NO_SPACE',
      contentDetails: [{ content: u, detailType: 'IMAGE' }]
    }));
  }
  const items = [];
  for (const it of f.items) {
    const one = { itemName: it.itemName, salePrice: it.salePrice,
                  marketplaceSalePrice: it.marketplaceSalePrice,
                  skuInfo: it.skuInfo };
    if (f.tags.length) one.searchTags = f.tags;
    const file = it.el ? it.el.querySelector('.pn-item-image').files[0] : null;
    if (file) {
      const u = await uploadProductImage(file, folder);
      one.images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: u }];
    } else if (it.images) {
      one.images = it.images;          // 초안에서 불러온 것
    }
    if (contents) one.contents = contents;
    else if (it.contents) one.contents = it.contents;
    items.push(one);
  }
  return {
    source_seller_product_id: f.src || null,
    product: { sellerProductName: f.name, displayProductName: f.name },
    items,
    requested: f.requested
  };
}

/* 저장해둔 초안 목록. 등록 모달을 열 때마다 새로 읽는다. */
async function pnLoadDrafts() {
  const box = $('#pnDraftBox');
  if (!box) return;
  try {
    const rows = await api('product_drafts?select=*&status=eq.draft&order=updated_at.desc&limit=20') || [];
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<h4 class="sku-sec">저장해둔 초안</h4>'
      + rows.map((d) => `<div style="display:flex;gap:6px;align-items:center;margin:4px 0">
          <span style="flex:1">${esc(d.name)}
            <span class="muted sm">옵션 ${((d.payload || {}).items || []).length}개 ·
            ${esc(String(d.updated_at).slice(0, 10))}</span></span>
          <button class="btn btn-sm" data-draft-load="${esc(d.id)}">불러오기</button>
          <button class="btn btn-sm" data-draft-drop="${esc(d.id)}">삭제</button>
        </div>`).join('');
  } catch (e) {
    box.innerHTML = '<p class="muted sm">초안 목록을 불러오지 못했습니다 '
      + '(마이그레이션 030 미실행일 수 있습니다).</p>';
  }
}

$('#pnDraftBox').addEventListener('click', async (ev) => {
  const load = ev.target.closest('[data-draft-load]');
  const drop = ev.target.closest('[data-draft-drop]');
  if (load) { await pnFillFromDraft(load.dataset.draftLoad); return; }
  if (drop) {
    if (!confirm('이 초안을 삭제할까요?')) return;
    try {
      await api(`product_drafts?id=eq.${drop.dataset.draftDrop}`,
        { method: 'PATCH', body: { status: 'discarded' } });
      await pnLoadDrafts();
    } catch (e) { $('#pnMsg').textContent = `삭제 실패: ${e.message}`; }
  }
});

/* 초안을 폼에 되채운다. **파일 입력은 되채울 수 없다**(브라우저 보안) —
   대신 이미 올려둔 이미지 URL이 payload 에 있으므로 그대로 쓴다. */
async function pnFillFromDraft(id) {
  try {
    const rows = await api(`product_drafts?select=*&id=eq.${id}`) || [];
    const d = rows[0];
    if (!d) return;
    PN.draftId = d.id;
    PN.loaded = d.payload || {};
    const p = PN.loaded;
    $('#pnSource').value = d.source_seller_product_id || '';
    $('#pnProductName').value = (p.product && p.product.sellerProductName) || d.name || '';
    const first = (p.items || [])[0] || {};
    $('#pnSearchTags').value = (first.searchTags || []).join(', ');
    $('#pnRequested').checked = p.requested === true;
    const dec = d.decision || {};
    $('#pnExpQty').value = dec.expected_monthly_qty ?? '';
    $('#pnExpCost').value = dec.expected_unit_cost_krw ?? '';
    $('#pnExpPrice').value = dec.expected_sell_price ?? '';
    $('#pnExpMargin').value = dec.expected_margin_rate ?? '';
    $('#pnReason').value = dec.reason_memo || '';

    PN.rows = Math.max(1, (p.items || []).length);
    pnRenderItems();
    $$('#pnItems [data-pn-item]').forEach((row, i) => {
      const it = (p.items || [])[i] || {};
      row.querySelector('.pn-item-name').value = it.itemName || '';
      row.querySelector('.pn-item-price').value = it.salePrice ?? '';
      const m = row.querySelector('.pn-item-mprice');
      m.value = it.marketplaceSalePrice ?? '';
      if (m.value) m.dataset.touched = '1';   // 불러온 값을 자동 제안이 덮지 않게
      const sk = it.skuInfo || {};
      const put = (cls, v) => {
        const el = row.querySelector(cls);
        if (!el || v == null) return;
        el.value = v; el.dataset.touched = '1';
      };
      put('.pn-sku-w', sk.width); put('.pn-sku-l', sk.length);
      put('.pn-sku-h', sk.height); put('.pn-sku-wt', sk.weight);
      put('.pn-sku-dp', sk.distributionPeriod);
    });
    $('#pnMsg').textContent = '초안을 불러왔습니다. 이미지는 저장해둔 것이 그대로 쓰입니다.';
  } catch (e) {
    $('#pnMsg').textContent = `초안을 불러오지 못했습니다: ${e.message}`;
  }
}

$('#pnSave').onclick = async () => {
  /* 초안 저장과 **같은 수집 함수**를 쓴다 — 두 벌로 만들면
     "초안에서는 되는데 등록하면 다르다"가 생긴다. strict=true 로 필수값을 강제한다. */
  const f = pnCollect(true);
  if (f.err) { $('#pnMsg').textContent = f.err; return; }

  /* 되돌리기 어려운 일이라 한 번 더 묻는다. 등록되면 지우기가 까다롭다.
     확인 창에 **두 채널 가격을 옵션별로 다 보여준다** — 눈으로 볼 마지막 자리다. */
  const summary = f.items.map((it) =>
    `  · ${it.itemName} — 로켓그로스 ${Number(it.salePrice).toLocaleString()}원`
    + (it.marketplaceSalePrice ? ` / 판매자배송 ${Number(it.marketplaceSalePrice).toLocaleString()}원` : '')
    + `\n      물류: ${it.skuInfo.width}×${it.skuInfo.length}×${it.skuInfo.height}mm · ${it.skuInfo.weight}g`
  ).join('\n');
  if (!confirm(`"${f.name}" 을(를) 아래 ${f.items.length}개 옵션으로 등록합니다.\n\n${summary}\n\n`
      + `등록은 되돌리기 어렵습니다. 진행할까요?`)) return;

  const btn = $('#pnSave');
  btn.disabled = true;
  $('#pnMsg').textContent = '이미지를 올리는 중…';
  try {
    const payload = await pnBuildPayload(f);

    /* **판단을 먼저 남긴다.** 등록이 실패해도 "이걸 하려 했다"는 기록은 남아야 한다.
       성공하면 워커가 seller_product_id 를 채워 판단과 상품을 잇는다. */
    let decisionId = null;
    const dec = f.decision || {};
    const anyExpected = Object.keys(dec).some((k) => dec[k] !== null && dec[k] !== '');
    if (anyExpected) {
      try {
        const made = await api('sourcing_decisions', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: Object.assign({ method: 'manual_register' }, dec)
        });
        if (Array.isArray(made) && made[0]) decisionId = made[0].id;
      } catch (e) { /* 판단 기록 실패로 등록을 막지 않는다 */ }
    }
    payload.sourcing_decision_id = decisionId;

    $('#pnMsg').textContent = '등록 요청을 넣는 중…';
    await api('coupang_write_queue', {
      method: 'POST',
      body: { kind: 'product_create', payload, requested_by: AUTH.userId || null }
    });

    /* 초안에서 올린 것이면 그 초안을 닫는다 — 같은 걸 두 번 올리지 않도록. */
    if (PN.draftId) {
      try {
        await api(`product_drafts?id=eq.${PN.draftId}`,
          { method: 'PATCH', body: { status: 'submitted' } });
      } catch (e) { /* 초안 정리 실패로 등록을 되돌리지 않는다 */ }
      PN.draftId = null;
    }
    $('#pnMsg').textContent = '등록을 요청했습니다 — VPS가 쿠팡에 올립니다(보통 몇 초).';
    setTimeout(() => $('#prodNewModal').classList.add('hidden'), 2500);
  } catch (e) {
    $('#pnMsg').textContent = `실패: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};
