/* ============================================================
   80-products.js — 상품원장
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 상품원장 =====================
   my_skus가 이 시스템의 축이다(db/migrations/015). 목록 자체는 사람이 안 만든다 —
   scripts/rocket-growth-sync.js --skus 가 쿠팡 Open API에서 바코드까지 자동 적재한다.
   이 화면이 하는 일은 **쿠팡이 줄 수 없는 것만 사람이 채우는 것**이다:
   1688 링크·옵션(중국어)·MOQ·리드타임·한글표시사항.

   왜 조인을 클라이언트에서 하나: SKU 수천 개까지 가도 몇백 KB라 한 번에 받아서
   JS로 합치는 게 PostgREST 중첩 조인보다 단순하고 빠르다(소싱 탭이 8000행을
   같은 방식으로 다루고 있어 관례도 일치). */
const SKUS = { rows: [], byId: new Map(), editing: null };

async function loadSkus() {
  const el = $('#skuRows');
  el.innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  try {
    const [skus, products, listings, suppliers] = await Promise.all([
      apiAll('my_skus?select=*&order=sku_name.asc'),
      apiAll('my_products?select=id,name,status'),
      apiAll('sku_channel_listings?select=sku_id,channel,external_option_id,external_product_id'),
      apiAll('sku_suppliers?select=*')
    ]);

    const prodById = new Map(products.map((p) => [p.id, p]));
    /* 채널 매핑은 SKU당 여러 개일 수 있다(나중에 스마트스토어 등) — 지금은 쿠팡만 쓴다 */
    const listBySku = new Map();
    listings.forEach((l) => {
      if (l.channel !== 'coupang_rg') return;
      if (!listBySku.has(l.sku_id)) listBySku.set(l.sku_id, l);
    });
    /* 공급처도 복수 가능(같은 상품을 여러 1688 판매자에게서 산다) — is_primary 우선 */
    const supBySku = new Map();
    suppliers.forEach((s) => {
      const cur = supBySku.get(s.sku_id);
      if (!cur || (s.is_primary && !cur.is_primary)) supBySku.set(s.sku_id, s);
    });

    SKUS.rows = skus.map((s) => ({
      sku: s,
      product: prodById.get(s.product_id) || null,
      listing: listBySku.get(s.id) || null,
      supplier: supBySku.get(s.id) || null
    }));
    SKUS.byId = new Map(SKUS.rows.map((r) => [r.sku.id, r]));
    renderSkus();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const SKU_STATUS_LABEL = {
  active: '판매중', paused: '판매중지', liquidating: '청산중', discontinued: '단종'
};

function skuMatches(r, q) {
  if (!q) return true;
  const hay = [
    r.sku.sku_name, r.sku.barcode,
    r.listing && r.listing.external_option_id,
    r.listing && r.listing.external_product_id
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function renderSkus() {
  const q = ($('#skuSearch').value || '').trim().toLowerCase();
  const needSupplier = $('#skuNeedSupplier').checked;

  const list = SKUS.rows.filter((r) => {
    if (!skuMatches(r, q)) return false;
    if (needSupplier && r.supplier && r.supplier.offer_url) return false;
    return true;
  });

  const linked = SKUS.rows.filter((r) => r.supplier && r.supplier.offer_url).length;
  $('#skuSummary').textContent =
    `SKU ${SKUS.rows.length.toLocaleString()}개 · 1688 연결 ${linked}개` +
    (list.length !== SKUS.rows.length ? ` · 표시 ${list.length}개` : '');

  if (!list.length) {
    $('#skuRows').innerHTML =
      '<tr><td colspan="7" class="muted">해당하는 SKU가 없습니다.</td></tr>';
    return;
  }

  $('#skuRows').innerHTML = list.map((r) => {
    const s = r.sku;
    const optId = r.listing ? r.listing.external_option_id : null;
    const hasSup = !!(r.supplier && r.supplier.offer_url);
    return `<tr class="prow" data-sku="${esc(s.id)}">
      <td class="sku-bc">${s.barcode ? esc(s.barcode) : '<span class="muted">없음</span>'}</td>
      <td>${esc(s.sku_name)}</td>
      <td class="sku-bc">${optId ? esc(optId) : '<span class="muted">—</span>'}</td>
      <td>${hasSup
          ? '<span class="badge">연결됨</span>'
          : '<span class="muted">미연결</span>'}</td>
      <td class="col-num">${cnt(s.moq)}</td>
      <td class="col-num">${s.lead_time_days == null ? '—' : s.lead_time_days + '일'}</td>
      <td>${esc(SKU_STATUS_LABEL[s.status] || s.status)}</td>
    </tr>`;
  }).join('');
}

$('#skuSearch').oninput = () => renderSkus();
$('#skuNeedSupplier').onchange = () => renderSkus();

$('#skuRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-sku]');
  if (tr) openSkuModal(tr.dataset.sku);
});

function openSkuModal(skuId) {
  const r = SKUS.byId.get(skuId);
  if (!r) return;
  SKUS.editing = r;
  const s = r.sku, sup = r.supplier || {};

  $('#skuModalTitle').textContent = s.sku_name;
  /* 쿠팡에서 온 값은 편집 대상이 아니다 — 고쳐봐야 다음 동기화에 덮이거나
     조인이 깨진다. 읽기전용으로 보여주기만 한다. */
  $('#skuRo').innerHTML = [
    ['바코드', s.barcode || '없음'],
    ['옵션ID', r.listing ? r.listing.external_option_id : '—'],
    ['등록상품ID', r.listing ? r.listing.external_product_id : '—'],
    ['등록상품명', r.product ? r.product.name : '—']
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  const set = (id, v) => { $(id).value = v == null ? '' : v; };
  set('#skuOfferUrl', sup.offer_url);
  set('#skuOpt1', sup.option1_cn);
  set('#skuOpt2', sup.option2_cn);
  set('#skuPriceCny', sup.last_price_cny);
  set('#skuSellerId', sup.seller_1688_id);
  set('#skuMoq', s.moq);
  set('#skuLeadTime', s.lead_time_days);
  set('#skuSafetyDays', s.safety_days);
  set('#skuLabImporter', s.label_importer);
  set('#skuLabManufacturer', s.label_manufacturer);
  set('#skuLabOrigin', s.label_origin_country);
  set('#skuLabVolume', s.label_volume);
  set('#skuLabMaterial', s.label_material);
  set('#skuLabType', s.label_product_type);
  set('#skuLabCaution', s.label_caution);
  set('#skuLabUsage', s.label_usage_standard);
  set('#skuStatus', s.status || 'active');
  set('#skuMemo', s.memo);

  $('#skuMsg').className = 'msg hidden';
  $('#skuModal').classList.remove('hidden');
}

function closeSkuModal() {
  $('#skuModal').classList.add('hidden');
  SKUS.editing = null;
}
$$('#skuModal [data-close]').forEach((b) => { b.onclick = closeSkuModal; });

/* 빈 문자열은 null로 넣는다 — ''와 null이 섞이면 "값이 없다"를 두 가지로
   표현하게 되고, 나중에 AI가 스키마만 보고 쿼리를 짤 때 함정이 된다
   (프로젝트 원칙: 컬럼 의미가 코드 없이도 통해야 한다). */
const nz = (id) => { const v = $(id).value.trim(); return v === '' ? null : v; };
const nzNum = (id) => { const v = nz(id); return v === null ? null : Number(v); };

$('#skuSave').onclick = async () => {
  const r = SKUS.editing;
  if (!r) return;
  const btn = $('#skuSave');
  const msg = $('#skuMsg');
  btn.disabled = true;
  try {
    const patch = {
      moq: nzNum('#skuMoq'),
      lead_time_days: nzNum('#skuLeadTime'),
      safety_days: nzNum('#skuSafetyDays'),
      label_importer: nz('#skuLabImporter'),
      label_manufacturer: nz('#skuLabManufacturer'),
      label_origin_country: nz('#skuLabOrigin'),
      label_volume: nz('#skuLabVolume'),
      label_material: nz('#skuLabMaterial'),
      label_product_type: nz('#skuLabType'),
      label_caution: nz('#skuLabCaution'),
      label_usage_standard: nz('#skuLabUsage'),
      status: $('#skuStatus').value,
      memo: nz('#skuMemo'),
      updated_at: new Date().toISOString()
    };
    /* MOQ를 사람이 고치면 출처를 manual로 바꾼다 — 다음에 쿠플러스에서 자동으로
       긁어올 때 사람이 정한 값을 덮어쓰지 않기 위한 표시(015 설계 의도). */
    if (patch.moq !== r.sku.moq) patch.moq_source = 'manual';

    await api(`my_skus?id=eq.${encodeURIComponent(r.sku.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: patch
    });
    Object.assign(r.sku, patch);

    const supPatch = {
      offer_url: nz('#skuOfferUrl'),
      option1_cn: nz('#skuOpt1'),
      option2_cn: nz('#skuOpt2'),
      last_price_cny: nzNum('#skuPriceCny'),
      seller_1688_id: nz('#skuSellerId')
    };
    const hasSupInput = Object.values(supPatch).some((v) => v !== null);

    if (r.supplier) {
      await api(`sku_suppliers?id=eq.${r.supplier.id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: supPatch
      });
      Object.assign(r.supplier, supPatch);
    } else if (hasSupInput) {
      /* 첫 공급처는 자동으로 primary — 두 번째부터는 나중에 공급처 관리 화면에서 고른다 */
      const created = await api('sku_suppliers', {
        method: 'POST', headers: { prefer: 'return=representation' },
        body: [Object.assign({ sku_id: r.sku.id, is_primary: true }, supPatch)]
      });
      r.supplier = created[0];
    }

    /* offer_url에서 offerId를 뽑아둔다 — 나중에 1688 자동수집·재발주에서
       링크 문자열을 다시 파싱하지 않으려고 저장 시점에 한 번만 한다. */
    if (r.supplier && r.supplier.offer_url && !r.supplier.offer_id) {
      const m = r.supplier.offer_url.match(/offer\/(\d+)/);
      if (m) {
        await api(`sku_suppliers?id=eq.${r.supplier.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { offer_id: m[1] }
        });
        r.supplier.offer_id = m[1];
      }
    }

    renderSkus();
    closeSkuModal();
    toast('저장했습니다');
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
