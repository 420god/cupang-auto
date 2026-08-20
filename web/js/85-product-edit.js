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
