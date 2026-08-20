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
  el.innerHTML = '<tr><td colspan="9" class="muted">불러오는 중…</td></tr>';
  try {
    const [skus, products, listings, suppliers, reg, lots, pending] = await Promise.all([
      apiAll('my_skus?select=*&order=sku_name.asc'),
      apiAll('my_products?select=id,name,status'),
      apiAll('sku_channel_listings?select=sku_id,channel,external_option_id,external_product_id'),
      apiAll('sku_suppliers?select=*'),
      /* 쿠팡 판매가·판매여부·재고(db/migrations/024). 이 시스템은 원래 판매가를 몰랐다 —
         판매현황이 쓰는 값은 매출÷수량으로 역산한 평균 실현가라 안 팔린 SKU는 알 수가 없다. */
      /* .catch(()=>[])가 붙은 이유: 마이그레이션 024 전에는 이 컬럼들이 없어서 400이 온다.
         Promise.all은 하나만 깨져도 전부 깨지므로, 그러면 **상품원장 자체가 안 뜬다.**
         가격은 부가 정보지 이 화면의 본체가 아니다 — 없으면 "미조회"로 보이면 된다. */
      apiAll('rocket_growth_product_registry?select=vendor_item_id,sale_price,on_sale,amount_in_stock,price_checked_at')
        .catch(() => []),
      /* 마진 미리보기에 쓸 개당 매입원가. 쿠팡에 도착한 로트만, 최근 도착 순.
         **"다음에 나갈 로트"가 아니라 "가장 최근 입고분"을 쓴다** — 앞으로 팔 물건은
         최근 원가로 채워지고, 가격을 정할 때 보고 싶은 건 그쪽이기 때문이다.
         선입선출 정확 계산(loadLotCogs)은 과거 판매의 이익을 매기는 용도라 목적이 다르다. */
      apiAll('inventory_lots?select=sku_id,unit_cost_krw,arrived_coupang_at'
             + '&arrived_coupang_at=not.is.null&order=arrived_coupang_at.desc'),
      /* 아직 쿠팡에 반영 안 된 가격 변경 요청. 화면이 "요청됨"을 보여줘야
         사용자가 같은 버튼을 두 번 누르지 않는다. */
      apiAll('coupang_write_queue?select=*&kind=eq.price&status=in.(queued,running)')
        .catch(() => [])   // 마이그레이션 023 전에는 테이블이 없다(404). 위와 같은 이유.
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

    const regByVid = new Map(reg.map((x) => [String(x.vendor_item_id), x]));
    const pendingByVid = new Map(pending.map((x) => [String(x.vendor_item_id), x]));
    /* 로트는 최근 도착 순으로 왔으므로 SKU당 **처음 만난 것**이 가장 최근 입고분이다 */
    const costBySku = new Map();
    lots.forEach((l) => {
      if (!l.sku_id || costBySku.has(l.sku_id)) return;
      const u = Number(l.unit_cost_krw);
      if (Number.isFinite(u) && u > 0) costBySku.set(l.sku_id, u);
    });

    SKUS.rows = skus.map((s) => {
      const listing = listBySku.get(s.id) || null;
      const vid = listing && listing.external_option_id ? String(listing.external_option_id) : null;
      return {
        sku: s,
        product: prodById.get(s.product_id) || null,
        listing,
        supplier: supBySku.get(s.id) || null,
        vid,
        reg: vid ? (regByVid.get(vid) || null) : null,
        pending: vid ? (pendingByVid.get(vid) || null) : null,
        costKrw: costBySku.get(s.id) || null,
        snap: null   // 수수료 스냅샷은 아래에서 옵션ID가 있는 것만 따로 받는다
      };
    });

    /* 수수료·입출고비 스냅샷(WING 재고현황에서 수집). 마진 미리보기에 필요하다.
       이미 있는 로더를 그대로 쓴다 — 판매현황과 다른 방식으로 읽으면 두 화면 숫자가 갈린다. */
    const vids = SKUS.rows.map((r) => r.vid).filter(Boolean);
    if (vids.length) {
      try {
        const snaps = await loadItemCostSnapshots(vids);
        SKUS.rows.forEach((r) => {
          const arr = r.vid ? snaps[r.vid] : null;
          if (arr && arr.length) r.snap = arr[arr.length - 1];   // captured_at 오름차순 → 마지막이 최신
        });
      } catch (e) { /* 스냅샷이 없어도 목록은 떠야 한다. 마진만 "정보 없음"이 된다 */ }
    }

    SKUS.byId = new Map(SKUS.rows.map((r) => [r.sku.id, r]));
    renderSkus();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="9" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
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
      '<tr><td colspan="9" class="muted">해당하는 SKU가 없습니다.</td></tr>';
    return;
  }

  /* "가격을 한 번도 안 읽었다"와 "가격이 없다"를 구분해서 알린다 —
     파생 화면은 원본이 없을 때 그 사실을 말해야 한다(R-15). 예전에 입고 화면이
     SKU 미연결 때문에 빈 화면만 보여줘서 원인을 못 찾은 적이 있다. */
  const withVid = SKUS.rows.filter((r) => r.vid).length;
  const checked = SKUS.rows.filter((r) => r.reg && r.reg.price_checked_at).length;
  const note = $('#skuPriceNote');
  if (note) {
    if (!withVid) note.textContent = '옵션ID가 연결된 SKU가 없어 판매가를 읽을 수 없습니다.';
    else if (!checked) note.textContent =
      '판매가를 아직 한 번도 읽지 않았습니다 — [가격 새로고침]을 누르면 쿠팡에서 가져옵니다.';
    else if (checked < withVid) note.textContent =
      `판매가를 읽은 SKU ${checked}/${withVid}개. 나머지는 [가격 새로고침] 후 채워집니다.`;
    else note.textContent = '';
  }

  $('#skuRows').innerHTML = list.map((r) => {
    const s = r.sku;
    const optId = r.listing ? r.listing.external_option_id : null;
    const hasSup = !!(r.supplier && r.supplier.offer_url);
    const reg = r.reg;
    /* 값이 없을 때 무엇이 없는지를 다르게 쓴다: 옵션ID가 없으면 애초에 읽을 대상이 없고,
       읽은 적이 없으면 "미조회"다. 둘 다 '—'로 뭉뚱그리면 원인을 못 찾는다. */
    const priceCell = !r.vid ? '<span class="muted">옵션ID 없음</span>'
      : (!reg || reg.sale_price == null) ? '<span class="muted">미조회</span>'
      : `${Number(reg.sale_price).toLocaleString()}원`
        + (reg.on_sale === false ? '<span class="sku-name-sub">판매중지</span>' : '')
        + (r.pending ? `<span class="sku-name-sub">→ ${Number(r.pending.price_after).toLocaleString()}원 요청됨</span>` : '');
    const stockCell = !reg || reg.amount_in_stock == null
      ? '<span class="muted">—</span>' : cnt(reg.amount_in_stock);

    return `<tr class="prow" data-sku="${esc(s.id)}">
      <td class="sku-bc">${s.barcode ? esc(s.barcode) : '<span class="muted">없음</span>'}</td>
      <td>${esc(s.sku_name)}</td>
      <td class="sku-bc">${optId ? esc(optId) : '<span class="muted">—</span>'}</td>
      <td class="col-num">${priceCell}</td>
      <td class="col-num">${stockCell}</td>
      <td>${hasSup
          ? '<span class="badge">연결됨</span>'
          : '<span class="muted">미연결</span>'}</td>
      <td class="col-num">${cnt(s.moq)}</td>
      <td class="col-num">${s.lead_time_days == null ? '—' : s.lead_time_days + '일'}</td>
      <td>${esc(SKU_STATUS_LABEL[s.status] || s.status)}</td>
    </tr>`;
  }).join('');
}

/* ── 가격 변경 ────────────────────────────────────────────────────────────
   **웹은 쿠팡을 직접 못 부른다**(고정 IP 화이트리스트, D-16). 그래서 여기서는
   coupang_write_queue에 한 행 넣기만 하고, VPS 워커가 집어서 실제로 쏜다.
   화면에는 "요청됨 → 반영됨"으로 보인다. */

/* 이 SKU의 수수료율(%). 스냅샷은 '금액'이라 그때의 판매가로 나눠 율로 되돌린다.
   판매현황이 쓰는 방식과 같다(web/js/20-sales.js) — 다르게 계산하면 두 화면이 갈린다.
   부가세 보정(withSnapshotVat)도 그쪽과 동일하게 적용한다. */
function skuCommissionRate(r) {
  if (!r.snap || !r.reg || !(Number(r.reg.sale_price) > 0)) return null;
  return withSnapshotVat(r.snap.commission_amount) / Number(r.reg.sale_price) * 100;
}

/* 마진 계산은 반드시 calcMargin()을 거친다 — 계산식을 여기서 새로 쓰지 않는다
   (web/CLAUDE.md '절대 바꾸지 말 것'). */
function skuMarginAt(r, price) {
  const rate = skuCommissionRate(r);
  if (rate === null) return null;
  return calcMargin({
    price,
    commission: rate,
    fulfillment: r.snap ? r.snap.fulfillment_amount : null,
    costKrw: r.costKrw
  });
}

function renderMarginLive() {
  const r = SKUS.editing;
  const el = $('#skuMarginLive');
  if (!r || !el) return;
  const price = Number($('#skuPriceNew').value);
  if (!Number.isFinite(price) || price <= 0) {
    el.textContent = '가격을 입력하면 그 가격의 마진이 여기 표시됩니다.';
    el.className = 'sm muted';
    return;
  }
  if (skuCommissionRate(r) === null) {
    el.textContent = '수수료 정보가 없어 마진을 계산할 수 없습니다 — 판매현황에서 [상품별 원가 갱신]을 먼저 돌리세요.';
    el.className = 'sm muted';
    return;
  }
  const m = skuMarginAt(r, price);
  if (!m || m.margin === null) {
    el.textContent = '매입원가가 없어 마진을 계산할 수 없습니다 — 이 SKU는 아직 입고된 로트가 없습니다.';
    el.className = 'sm muted';
    return;
  }
  /* 손해면 눈에 띄게 한다. 0 하나 빠뜨리면 여기가 크게 음수로 뜬다 — 변경 폭 경고 대신
     이걸 쓰기로 했다(2026-08-20 사용자 결정). pos/neg는 이 프로젝트의 기존 관례다. */
  const cls = m.margin >= 0 ? 'pos' : 'neg';
  el.innerHTML = `이 가격이면 <span class="${cls}">마진 ${m.rate}% · 개당 ${m.margin.toLocaleString()}원</span>`
    + `<br><span class="muted">수수료 ${m.commission.toLocaleString()} · 입출고비 ${m.fulfillment.toLocaleString()}`
    + ` · 매입원가 ${m.cost.toLocaleString()} · 출고/작업 ${m.shipWork.toLocaleString()} (최근 입고분 기준)</span>`;
  el.className = 'sm';
}

async function renderPriceSection(r) {
  const cur = r.reg && r.reg.sale_price != null ? Number(r.reg.sale_price) : null;
  $('#skuPriceNow').value = !r.vid ? '옵션ID가 없어 가격을 다룰 수 없습니다'
    : cur === null ? '아직 조회 안 됨'
    : `${cur.toLocaleString()}원` + (r.reg.on_sale === false ? ' (판매중지)' : '')
      + (r.reg.price_checked_at ? ` · ${r.reg.price_checked_at.slice(0, 16).replace('T', ' ')} 확인` : '');
  $('#skuPriceNew').value = '';
  $('#skuPriceReason').value = '';
  $('#skuPriceApply').disabled = !r.vid;
  $('#skuPriceState').textContent = r.pending
    ? `${Number(r.pending.price_after).toLocaleString()}원으로 변경 요청됨 — 아직 반영 전입니다.`
    : '';
  renderMarginLive();

  const box = $('#skuPriceHistory');
  box.innerHTML = '';
  if (!r.vid) return;
  try {
    /* 가격 궤적은 두 곳에 나뉘어 있지 않다 — 우리가 바꾼 것도, WING에서 사람이 바꾼 것도
       전부 rocket_growth_item_price_history에 모인다(source로 구분, db/migrations/024). */
    const rows = await api(`rocket_growth_item_price_history?select=*`
      + `&vendor_item_id=eq.${encodeURIComponent(r.vid)}&order=changed_at.desc&limit=10`) || [];
    if (!rows.length) { box.innerHTML = '<span class="muted">가격 변동 기록이 아직 없습니다.</span>'; return; }
    box.innerHTML = '<div class="muted" style="margin-top:8px"><b>가격 변동</b></div>' + rows.map((h) => {
      const from = h.prev_sale_price == null ? '—' : Number(h.prev_sale_price).toLocaleString();
      const to = h.sale_price == null ? '—' : Number(h.sale_price).toLocaleString();
      const who = h.source === 'our_write' ? '여기서 변경' : 'WING/쿠팡에서 변경됨';
      return `<div class="muted">${esc(h.changed_at.slice(0, 16).replace('T', ' '))}`
        + ` · ${from}원 → ${to}원 · ${who}</div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<span class="muted">변동 기록을 불러오지 못했습니다 (마이그레이션 024 미실행일 수 있습니다).</span>';
  }
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

  /* 가격 절은 이력을 따로 받아오므로 비동기다. 모달을 먼저 띄우고 나중에 채운다 —
     기다렸다 띄우면 클릭이 먹통인 것처럼 보인다. */
  renderPriceSection(r);
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

/* ── 가격 관련 이벤트 ─────────────────────────────────────────────────────
   이 줄들은 로드 시점에 실행된다. 여기서 부르는 함수들은 모두 **이 파일 안**에
   function 선언으로 있어서 호이스팅된다 — 다른 파일로 옮기면 조용히 깨진다(D-17). */

$('#skuPriceNew').addEventListener('input', renderMarginLive);

$('#skuPriceApply').onclick = async () => {
  const r = SKUS.editing;
  if (!r || !r.vid) return;
  const price = Number($('#skuPriceNew').value);
  if (!Number.isFinite(price) || price <= 0) {
    $('#skuPriceState').textContent = '바꿀 가격을 입력하세요.';
    return;
  }
  const cur = r.reg && r.reg.sale_price != null ? Number(r.reg.sale_price) : null;
  if (cur !== null && price === cur) {
    $('#skuPriceState').textContent = '지금 가격과 같습니다.';
    return;
  }

  const m = skuMarginAt(r, price);
  /* 손해가 나는 가격은 한 번 더 묻는다. 마진율을 띄워두긴 했지만 사람은 안 보고 누른다.
     막지는 않는다 — 청산·미끼상품처럼 일부러 손해를 보는 경우가 실제로 있다. */
  if (m && m.margin !== null && m.margin < 0) {
    if (!confirm(`이 가격이면 개당 ${Math.abs(m.margin).toLocaleString()}원 손해입니다(마진 ${m.rate}%).\n그래도 진행할까요?`)) return;
  }

  const btn = $('#skuPriceApply');
  btn.disabled = true;
  try {
    /* 판단 근거를 요청과 함께 박제한다 — 원가는 계속 바뀌므로 나중에 다시 계산하면
       "그때 왜 이 가격으로 정했나"를 복원할 수 없다(db/migrations/023). */
    await api('coupang_write_queue', {
      method: 'POST',
      body: {
        kind: 'price',
        vendor_item_id: r.vid,
        sku_id: r.sku.id,
        price_after: Math.round(price),
        margin_rate_at_request: m ? m.rate : null,
        unit_cost_krw_at_request: r.costKrw,
        reason: ($('#skuPriceReason').value || '').trim() || null,
        requested_by: AUTH.userId || null
      }
    });
    $('#skuPriceState').textContent =
      `${Math.round(price).toLocaleString()}원으로 요청했습니다 — VPS가 쿠팡에 반영합니다(보통 몇 초).`;
    /* 화면에도 바로 "요청됨"이 뜨도록 목록을 다시 그린다. 실제 반영 확인은
       워커가 registry를 갱신한 뒤 [가격 새로고침]이나 다음 조회에서 보인다. */
    r.pending = { price_after: Math.round(price) };
    renderSkus();
  } catch (e) {
    $('#skuPriceState').textContent = `요청 실패: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};

/* 전체 가격 새로고침. 웹이 쿠팡을 직접 못 부르므로 큐에 넣고 워커가 대신 물어본다.
   vendor_item_id를 비워두면 '전체'라는 뜻이다(db/migrations/024의 check 제약). */
$('#skuPriceSync').onclick = async () => {
  const btn = $('#skuPriceSync');
  btn.disabled = true;
  const note = $('#skuPriceNote');
  try {
    await api('coupang_write_queue', {
      method: 'POST',
      body: { kind: 'price_sync', requested_by: AUTH.userId || null }
    });
    note.textContent = '쿠팡에 가격을 다시 물어보는 중입니다 — VPS가 처리하며, 끝나면 이 화면을 새로고침하세요.';
  } catch (e) {
    note.textContent = `가격 새로고침 요청 실패: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};
