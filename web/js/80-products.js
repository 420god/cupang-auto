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
    const [skus, products, listings, suppliers, reg, pending] = await Promise.all([
      apiAll('my_skus?select=*&order=sku_name.asc'),
      apiAll('my_products?select=id,name,status'),
      apiAll('sku_channel_listings?select=sku_id,channel,external_option_id,external_product_id'),
      apiAll('sku_suppliers?select=*'),
      /* 쿠팡 판매가·판매여부·재고(db/migrations/024). 이 시스템은 원래 판매가를 몰랐다 —
         판매현황이 쓰는 값은 매출÷수량으로 역산한 평균 실현가라 안 팔린 SKU는 알 수가 없다. */
      /* .catch(()=>[])가 붙은 이유: 마이그레이션 024 전에는 이 컬럼들이 없어서 400이 온다.
         Promise.all은 하나만 깨져도 전부 깨지므로, 그러면 **상품원장 자체가 안 뜬다.**
         가격은 부가 정보지 이 화면의 본체가 아니다 — 없으면 "미조회"로 보이면 된다. */
      apiAll('rocket_growth_product_registry?select=vendor_item_id,seller_product_id,sale_price,'
             + 'on_sale,amount_in_stock,price_checked_at,product_json,product_fetched_at')
        /* 025 전에는 product_json이 없어 400이 온다. 그때는 가격 컬럼만이라도 받는다 —
           상품 정보 편집만 못 하고 나머지 화면은 그대로 돌아야 한다. */
        .catch(() => apiAll('rocket_growth_product_registry?select=vendor_item_id,seller_product_id,'
             + 'sale_price,on_sale,amount_in_stock,price_checked_at').catch(() => [])),
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
        /* 아래 loadLotCogs()로 채운다 — 선입선출로 다 팔고 남은 로트가 기준이다 */
        costKrw: null,     // 지금 나갈 로트의 개당 원가
        nextCost: null,    // 그 로트가 떨어진 뒤 나갈 로트의 개당 원가
        remainQty: null,   // 지금 나갈 로트에 남은 수량
        ourStock: null,    // 우리 기록상 창고 총 잔량(모든 로트 합)
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

      /* 선입선출 잔량. 판매현황이 쓰는 loadLotCogs()를 그대로 부른다 —
         같은 계산을 두 벌로 만들면 두 화면의 원가가 조용히 어긋난다. */
      try {
        const cogs = await loadLotCogs(vids);
        const remaining = cogs.remainingBySku;   // 로트가 없으면 undefined일 수 있다
        if (remaining) {
          SKUS.rows.forEach((r) => {
            const q = (remaining.get(r.sku.id) || []).filter((l) => l.left > 0);
            if (!q.length) return;
            r.costKrw = q[0].unit;
            r.remainQty = q[0].left;
            r.nextCost = q[1] ? q[1].unit : null;
            r.ourStock = q.reduce((a, l) => a + l.left, 0);
          });
        }
      } catch (e) { /* 원가를 못 구해도 목록·가격은 떠야 한다 */ }
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
    /* **워커가 안 돌면 큐에 쌓이기만 하고 아무 일도 안 일어난다.** 그런데 화면은
       "요청됨"만 보여주므로 사용자는 영원히 기다리게 된다(2026-08-20 실제로 겪음).
       요청이 2분 넘게 안 처리되면 그 사실을 말해준다 — "없음"과 "안 돌고 있음"은 다르다(R-15). */
    const stuck = SKUS.rows.filter((r) => r.pending && r.pending.requested_at
      && (Date.now() - new Date(r.pending.requested_at).getTime()) > 2 * 60 * 1000).length;
    if (stuck) {
      note.innerHTML = `<span class="neg">가격 변경 요청 ${stuck}건이 2분 넘게 처리되지 않고 있습니다.</span>`
        + ' VPS의 쓰기 워커가 멈춰 있을 수 있습니다 —'
        + ' <code>systemctl status coupang-write-worker</code> 로 확인하세요.';
    }
    else if (!withVid) note.textContent = '옵션ID가 연결된 SKU가 없어 판매가를 읽을 수 없습니다.';
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
function skuMarginAt(r, price, costKrw) {
  const rate = skuCommissionRate(r);
  if (rate === null) return null;
  return calcMargin({
    price,
    commission: rate,
    fulfillment: r.snap ? r.snap.fulfillment_amount : null,
    costKrw: costKrw === undefined ? r.costKrw : costKrw
  });
}

function marginLine(label, m) {
  const cls = m.margin >= 0 ? 'pos' : 'neg';
  return `${label} <span class="${cls}">마진 ${m.rate}% · 개당 ${m.margin.toLocaleString()}원</span>`
    + ` <span class="muted">(원가 ${m.cost.toLocaleString()})</span>`;
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
    el.textContent = '매입원가가 없어 마진을 계산할 수 없습니다 — 창고에 남은 로트가 없습니다.';
    el.className = 'sm muted';
    return;
  }

  /* **로트마다 원가가 다르므로 마진도 하나가 아니다.** 지금 나갈 로트가 20개 남았으면
     그 20개는 그 원가로 팔리고, 그 뒤부터 다음 로트 원가가 된다(2026-08-20 사용자 확인).
     가격은 한 번 정하면 오래 유지되므로, 잔량이 얼마 안 남았을 땐 **다음 로트 쪽이 사실상
     더 중요하다** — 하나만 보여주면 몇 개 팔고 마진이 반토막 나는 걸 못 본다.
     손해면 pos/neg로 눈에 띈다. 0 하나 빠뜨리면 여기가 크게 음수로 뜬다. */
  const lines = [marginLine(
    r.remainQty != null ? `지금 나갈 ${r.remainQty.toLocaleString()}개 —` : '이 가격이면', m)];

  if (r.nextCost != null) {
    const mn = skuMarginAt(r, price, r.nextCost);
    if (mn && mn.margin !== null) lines.push(marginLine('그다음 로트 —', mn));
  }

  el.innerHTML = lines.join('<br>')
    + `<br><span class="muted">수수료 ${m.commission.toLocaleString()} · 입출고비 ${m.fulfillment.toLocaleString()}`
    + ` · 출고/작업 ${m.shipWork.toLocaleString()} (선입선출 기준)</span>`;
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

  /* 우리가 계산한 잔량과 쿠팡이 말하는 실재고를 나란히 둔다. 차이가 나는 건 버그가 아니라
     대개 **실제 사건**이다 — 불량 폐기, 분실, 쿠팡 자체 처리, 그리고 아직 거칠게 다루는 반품.
     가리면 원가 계산을 어디까지 믿을지 알 수 없으므로 드러내 놓는다(R-05: 추정과 확정을 구분). */
  const coupangStock = r.reg && r.reg.amount_in_stock != null ? Number(r.reg.amount_in_stock) : null;
  if (r.ourStock != null && coupangStock != null) {
    const diff = r.ourStock - coupangStock;
    box.innerHTML = diff === 0
      ? `<div class="muted">재고 ${coupangStock.toLocaleString()}개 — 우리 기록과 쿠팡이 일치합니다.</div>`
      : `<div><span class="neg">재고가 안 맞습니다</span>`
        + ` <span class="muted">— 우리 기록 ${r.ourStock.toLocaleString()}개 vs 쿠팡 ${coupangStock.toLocaleString()}개`
        + ` (차이 ${diff > 0 ? '+' : ''}${diff.toLocaleString()}). 불량 폐기·분실·반품 처리 때문일 수 있어`
        + ` 원가가 실제와 다를 수 있습니다.</span></div>`;
  } else if (coupangStock != null && r.ourStock == null) {
    box.innerHTML = `<div class="muted">쿠팡 재고 ${coupangStock.toLocaleString()}개.`
      + ` 우리 쪽엔 남은 로트 기록이 없어 원가를 매길 수 없습니다.</div>`;
  }
  try {
    /* 가격 궤적은 두 곳에 나뉘어 있지 않다 — 우리가 바꾼 것도, WING에서 사람이 바꾼 것도
       전부 rocket_growth_item_price_history에 모인다(source로 구분, db/migrations/024). */
    const rows = await api(`rocket_growth_item_price_history?select=*`
      + `&vendor_item_id=eq.${encodeURIComponent(r.vid)}&order=changed_at.desc&limit=10`) || [];
    if (!rows.length) { box.innerHTML += '<div class="muted">가격 변동 기록이 아직 없습니다.</div>'; return; }
    box.innerHTML += '<div class="muted" style="margin-top:8px"><b>가격 변동</b></div>' + rows.map((h) => {
      const from = h.prev_sale_price == null ? '—' : Number(h.prev_sale_price).toLocaleString();
      const to = h.sale_price == null ? '—' : Number(h.sale_price).toLocaleString();
      const who = h.source === 'our_write' ? '여기서 변경' : 'WING/쿠팡에서 변경됨';
      return `<div class="muted">${esc(h.changed_at.slice(0, 16).replace('T', ' '))}`
        + ` · ${from}원 → ${to}원 · ${who}</div>`;
    }).join('');
  } catch (e) {
    box.innerHTML += '<div class="muted">변동 기록을 불러오지 못했습니다 (마이그레이션 024 미실행일 수 있습니다).</div>';
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
  /* 상품 정보 절은 이미 받아둔 registry.product_json만 읽으므로 동기다. */
  renderProductSection(r);
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

/* ── 쿠팡 상품 정보 (상품명·검색어·대표이미지·상세페이지) ──────────────────
   **쿠팡 상품 수정은 부분 수정이 안 된다** — 전체 몸통을 PUT해야 하고 빠뜨린 필드는
   지워진다(2026-08-20 정찰). 그래서 웹은 "무엇을 바꿀지"만 큐에 담고, 워커가 쏘기
   직전에 최신 상품을 조회해 거기에 얹어 보낸다. 우리 사본을 보내면 그 사이 WING에서
   바뀐 게 통째로 덮인다.

   그래서 화면도 '지금 값'을 보고 편집해야 한다 — 깜깜이 편집은 전체 PUT에서 곧 사고다.
   현재 값은 워커가 가져다 놓은 registry.product_json 에서 읽는다(db/migrations/025). */

/* 이 SKU가 속한 상품 원문에서 이 옵션(items[])을 찾아낸다.
   철자가 엔드포인트마다 달라 세 곳을 다 본다(docs/api/coupang-open-api.md). */
function findProductItem(product, vid) {
  if (!product || !vid) return null;
  return (product.items || []).find((it) => [
    it.rocketGrowthItemData && it.rocketGrowthItemData.vendorItemId,
    it.marketplaceItemData && it.marketplaceItemData.vendorItemId,
    it.marketPlaceItemData && it.marketPlaceItemData.vendorItemId,
    it.vendorItemId
  ].filter((x) => x != null).map(String).includes(String(vid))) || null;
}

/* 쿠팡 이미지 경로는 상대 경로로 온다(vendor_inventory/de96/....png).
   미리보기로 띄우려면 CDN 호스트를 붙여야 하는데 **그 주소는 미검증이다**
   (STATUS.md "이미지 CDN 주소 미검증"). 그래서 그림이 깨질 수 있고,
   경로 문자열도 같이 보여줘서 최소한 무엇이 걸려 있는지는 알 수 있게 한다. */
function coupangImageUrl(p) {
  if (!p) return null;
  if (/^https?:\/\//.test(p)) return p;
  return `https://image1.coupangcdn.com/image/${p}`;
}

function renderProductSection(r) {
  releasePreviewUrls();   // 이전에 만든 미리보기 URL 정리 (아래 localPreview 참조)
  const prod = r.reg && r.reg.product_json ? r.reg.product_json : null;
  const item = findProductItem(prod, r.vid);
  const has = !!prod;
  const spid = r.reg ? r.reg.seller_product_id : null;

  const st = $('#skuProdState');
  if (!r.vid || !spid) {
    st.innerHTML = '<span class="muted">옵션ID 또는 등록상품ID가 없어 상품 정보를 다룰 수 없습니다.</span>';
  } else if (!has) {
    /* 원본이 없으면 그 사실을 말한다(R-15). 빈 칸만 보여주면 "값이 없다"로 오해하고
       그대로 저장해서 멀쩡한 값을 지울 수 있다 — 전체 PUT이라 특히 위험하다. */
    st.innerHTML = '<span class="neg">현재 정보를 아직 안 가져왔습니다.</span>'
      + ' 먼저 [쿠팡에서 현재 정보 불러오기]를 누르세요 — 지금 값을 모르는 채로 저장하면'
      + ' 쿠팡은 전체 덮어쓰기라 기존 내용이 지워질 수 있습니다.';
  } else {
    st.innerHTML = '<span class="muted">'
      + (r.reg.product_fetched_at
          ? esc(r.reg.product_fetched_at.slice(0, 16).replace('T', ' ')) + ' 기준 · ' : '')
      + '등록상품ID ' + esc(spid)
      + ' · 옵션 ' + (prod.items || []).length + '개</span>';
  }

  const canEdit = has && !!item;
  ['#skuProdName', '#skuItemName', '#skuSearchTags', '#skuRepImage',
   '#skuDetailImages', '#skuProdRequested', '#skuProdSave', '#skuProdHypothesis'].forEach((id) => {
    $(id).disabled = !canEdit;
  });
  $('#skuProdFetch').disabled = !(r.vid && spid);

  $('#skuProdName').value = prod ? (prod.sellerProductName || '') : '';
  $('#skuItemName').value = item ? (item.itemName || '') : '';
  $('#skuSearchTags').value = item && Array.isArray(item.searchTags) ? item.searchTags.join(', ') : '';
  $('#skuRepImage').value = '';
  $('#skuDetailImages').value = '';
  $('#skuProdRequested').checked = false;
  $('#skuProdHypothesis').value = '';
  $('#skuProdMsg').textContent = '';
  if ($('#skuProdMetricHint')) $('#skuProdMetricHint').textContent = '';

  const rep = item && (item.images || []).find((im) => im.imageType === 'REPRESENTATION');
  const repPath = rep ? (rep.cdnPath || rep.vendorPath || '') : '';
  $('#skuRepPreview').innerHTML = rep
    ? '<div>현재 대표이미지</div>'
      + '<img src="' + esc(coupangImageUrl(repPath)) + '" alt=""'
      + ' style="max-width:120px;border-radius:6px;margin-top:4px" />'
      + '<div class="muted" style="word-break:break-all">' + esc(repPath) + '</div>'
    : (canEdit ? '<span class="muted">대표이미지가 없습니다.</span>' : '');

  const paths = [];
  (item ? (item.contents || []) : []).forEach((c) => {
    (c.contentDetails || []).forEach((d) => { if (d.content) paths.push(d.content); });
  });
  $('#skuDetailPreview').innerHTML = paths.length
    ? '<div>현재 상세페이지 ' + paths.length + '장</div>'
      + paths.slice(0, 6).map((p) => '<img src="' + esc(coupangImageUrl(p)) + '" alt=""'
          + ' style="max-width:80px;border-radius:4px;margin:4px 4px 0 0" />').join('')
    : (canEdit ? '<span class="muted">상세페이지 이미지가 없습니다.</span>' : '');
}

/* Supabase Storage에 올리고 **공개 URL**을 돌려준다.
   쿠팡은 images[].vendorPath에 http로 시작하는 URL을 주면 직접 내려받는다(80·443 포트만).
   Supabase는 https(443)라 조건을 만족한다. 업로드 API가 따로 없어서 이 방식뿐이다. */
async function uploadProductImage(file, skuId) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  /* 경로에 시각을 넣어 덮어쓰기를 피한다 — 옛 이미지를 남겨야 "이걸로 바꿨더니 어땠나"를
     나중에 되짚을 수 있다(R-04). 쿠팡 CDN에만 있으면 그 비교가 불가능하다. */
  const p = skuId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const res = await fetch(CFG.url + '/storage/v1/object/product-images/' + p, {
    method: 'POST',
    headers: {
      apikey: CFG.key,
      Authorization: 'Bearer ' + AUTH.token,
      'content-type': file.type || 'application/octet-stream'
    },
    body: file
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('이미지 업로드 실패 (' + res.status + '): ' + t.slice(0, 200));
  }
  return CFG.url + '/storage/v1/object/public/product-images/' + p;
}

$('#skuProdFetch').onclick = async () => {
  const r = SKUS.editing;
  if (!r || !r.reg || !r.reg.seller_product_id) return;
  const btn = $('#skuProdFetch');
  btn.disabled = true;
  try {
    await api('coupang_write_queue', {
      method: 'POST',
      body: { kind: 'product_fetch', seller_product_id: r.reg.seller_product_id,
              vendor_item_id: r.vid, sku_id: r.sku.id, requested_by: AUTH.userId || null }
    });
    $('#skuProdState').textContent =
      '쿠팡에서 상품 정보를 가져오는 중입니다 — 몇 초 뒤 이 화면을 새로고침하면 값이 채워집니다.';
  } catch (e) {
    $('#skuProdState').textContent = '요청 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

$('#skuProdSave').onclick = async () => {
  const r = SKUS.editing;
  if (!r || !r.vid || !r.reg || !r.reg.product_json) return;
  const btn = $('#skuProdSave');
  const msg = $('#skuProdMsg');
  const prod = r.reg.product_json;
  const item = findProductItem(prod, r.vid);
  if (!item) { msg.textContent = '이 옵션을 상품 안에서 찾지 못했습니다.'; return; }

  btn.disabled = true;
  msg.textContent = '';
  try {
    /* **바뀐 것만 담는다.** 안 바꾼 필드를 payload에 넣으면 워커가 그 값으로 덮어쓰는데,
       화면이 들고 있는 값이 낡았으면 그게 곧 되돌림이 된다. */
    const patch = {};
    const productPatch = {};
    const name = ($('#skuProdName').value || '').trim();
    const itemName = ($('#skuItemName').value || '').trim();
    const tagsRaw = ($('#skuSearchTags').value || '').trim();
    const curTags = Array.isArray(item.searchTags) ? item.searchTags.join(', ') : '';

    if (name && name !== (prod.sellerProductName || '')) productPatch.sellerProductName = name;
    if (itemName && itemName !== (item.itemName || '')) patch.itemName = itemName;
    if (tagsRaw !== curTags) {
      patch.searchTags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    }

    /* 이미지: 새로 고른 게 있을 때만 손댄다. 대표이미지는 그 한 장만 바꾸고
       나머지(DETAIL 등)는 원본을 그대로 살려 보낸다 — 빠뜨리면 지워진다. */
    const repFile = $('#skuRepImage').files[0];
    if (repFile) {
      msg.textContent = '대표이미지 올리는 중…';
      const url = await uploadProductImage(repFile, r.sku.id);
      const others = (item.images || []).filter((im) => im.imageType !== 'REPRESENTATION');
      patch.images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: url }]
        .concat(others.map((im, i) => Object.assign({}, im, { imageOrder: i + 1 })));
    }

    const detFiles = Array.from($('#skuDetailImages').files || []);
    if (detFiles.length) {
      msg.textContent = '상세페이지 이미지 ' + detFiles.length + '장 올리는 중…';
      const urls = [];
      for (const f of detFiles) urls.push(await uploadProductImage(f, r.sku.id));
      /* 기존 상세페이지 구조를 그대로 따라간다(실측: contentsType IMAGE_NO_SPACE +
         detailType IMAGE, 한 장당 contents 원소 하나). 구조를 새로 지어내지 않는다. */
      patch.contents = urls.map((u) => ({
        contentsType: 'IMAGE_NO_SPACE',
        contentDetails: [{ content: u, detailType: 'IMAGE' }]
      }));
    }

    if (!Object.keys(patch).length && !Object.keys(productPatch).length) {
      msg.textContent = '바뀐 내용이 없습니다.';
      btn.disabled = false;
      return;
    }

    const payload = { items: {} };
    payload.items[r.vid] = patch;
    if (Object.keys(productPatch).length) payload.product = productPatch;
    if ($('#skuProdRequested').checked) payload.requested = true;

    await api('coupang_write_queue', {
      method: 'POST',
      body: {
        kind: 'product_update',
        seller_product_id: r.reg.seller_product_id,
        vendor_item_id: r.vid,
        sku_id: r.sku.id,
        payload: payload,
        hypothesis: ($('#skuProdHypothesis').value || '').trim() || null,
        requested_by: AUTH.userId || null
      }
    });
    msg.textContent = '변경을 요청했습니다 — VPS가 쿠팡에 반영합니다(보통 몇 초).'
      + ($('#skuProdRequested').checked ? ' 승인 요청도 함께 올립니다.' : '');
  } catch (e) {
    msg.textContent = '실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* 파일을 고르면 **고른 그림을 바로 보여준다.**
   안 그러면 "현재 대표이미지"만 계속 떠 있어서 무엇으로 바뀌는지 확인할 방법이 없다.
   업로드 전이라 서버 왕복 없이 브라우저가 들고 있는 파일을 그대로 그린다.

   createObjectURL은 명시적으로 놓아주지 않으면 탭이 닫힐 때까지 메모리에 남는다.
   상세페이지를 여러 장씩 반복해서 고르면 쌓이므로, 다시 그릴 때 이전 것을 먼저 지운다. */
const PROD_PREVIEW_URLS = [];
function releasePreviewUrls() {
  while (PROD_PREVIEW_URLS.length) URL.revokeObjectURL(PROD_PREVIEW_URLS.pop());
}
function localPreview(file, size) {
  const u = URL.createObjectURL(file);
  PROD_PREVIEW_URLS.push(u);
  return `<img src="${u}" alt="" style="max-width:${size}px;border-radius:6px;margin:4px 4px 0 0" />`;
}

$('#skuRepImage').addEventListener('change', () => {
  const f = $('#skuRepImage').files[0];
  if (!f) { renderProductSection(SKUS.editing); return; }
  $('#skuRepPreview').innerHTML =
    '<div><b>이걸로 바꿉니다</b></div>' + localPreview(f, 120)
    + `<div class="muted">${esc(f.name)} · ${Math.round(f.size / 1024).toLocaleString()}KB</div>`;
});

$('#skuDetailImages').addEventListener('change', () => {
  const fs = Array.from($('#skuDetailImages').files || []);
  if (!fs.length) { renderProductSection(SKUS.editing); return; }
  /* 상세페이지는 **고른 것으로 전부 대체**된다. 순서가 곧 노출 순서라 번호를 붙여
     보여준다 — 파일 탐색기에서 고른 순서와 다를 수 있어서 눈으로 확인해야 한다. */
  $('#skuDetailPreview').innerHTML =
    `<div><b>이 ${fs.length}장으로 전부 대체합니다</b> (왼쪽부터 노출 순서)</div>`
    + fs.map((f, i) => `<span style="display:inline-block;text-align:center">`
        + localPreview(f, 80) + `<div class="muted">${i + 1}</div></span>`).join('');
});

/* 무엇을 바꾸느냐에 따라 **봐야 할 지표가 다르다.** 지표가 깔때기 단계별로 있어서,
   썸네일을 바꿨는데 전환율만 보면 아무 결론도 못 낸다(2026-08-20 실측 데이터로 확인).
   고르는 순간 화면이 알려주면 가설을 그 지표에 맞춰 쓰게 된다 —
   나중에 AI가 판정할 때 가설과 지표가 어긋나 있으면 판정 자체가 불가능하다.
   워커의 PRIMARY_METRICS와 같은 표다. 어긋나면 화면과 기록이 갈린다. */
const CHANGE_METRIC_HINT = {
  thumbnail:    '대표이미지를 바꾸면 <b>조회·방문자</b>가 움직여야 맞습니다 (클릭을 좌우하므로).',
  detail_page:  '상세페이지를 바꾸면 <b>구매전환율·장바구니</b>가 움직여야 맞습니다. 조회는 안 변하는 게 정상입니다.',
  search_tags:  '검색어를 바꾸면 <b>조회·방문자</b>가 움직여야 맞습니다 (검색 노출 → 유입).',
  product_name: '상품명을 바꾸면 <b>조회·방문자</b>가 움직여야 맞습니다.',
  item_name:    '옵션명을 바꾸면 <b>조회·방문자</b>가 움직여야 맞습니다.'
};

/* 지금 무엇을 바꾸려는 상태인지 보고 힌트를 띄운다. 여러 개를 한 번에 바꾸면
   **원인을 못 가린다**는 것도 같이 알린다 — 나중에 분석에서 빼야 할 사례다. */
function updateMetricHint() {
  const el = $('#skuProdMetricHint');
  if (!el) return;
  const r = SKUS.editing;
  const prod = r && r.reg && r.reg.product_json;
  const item = prod ? findProductItem(prod, r.vid) : null;
  if (!item) { el.textContent = ''; return; }

  const fields = [];
  if ($('#skuRepImage').files[0]) fields.push('thumbnail');
  if (($('#skuDetailImages').files || []).length) fields.push('detail_page');
  const tagsRaw = ($('#skuSearchTags').value || '').trim();
  const curTags = Array.isArray(item.searchTags) ? item.searchTags.join(', ') : '';
  if (tagsRaw !== curTags) fields.push('search_tags');
  const name = ($('#skuProdName').value || '').trim();
  if (name && name !== (prod.sellerProductName || '')) fields.push('product_name');
  const iname = ($('#skuItemName').value || '').trim();
  if (iname && iname !== (item.itemName || '')) fields.push('item_name');

  if (!fields.length) { el.textContent = ''; return; }
  const lines = fields.map((f) => '· ' + CHANGE_METRIC_HINT[f]).join('<br>');
  el.innerHTML = lines + (fields.length > 1
    ? '<br><span class="neg">한 번에 여러 가지를 바꾸면 어느 것이 효과였는지 가릴 수 없습니다.</span>'
      + ' 하나씩 바꾸는 편이 나중에 배울 게 많습니다.'
    : '');
}

['#skuRepImage', '#skuDetailImages', '#skuSearchTags', '#skuProdName', '#skuItemName']
  .forEach((id) => {
    $(id).addEventListener('change', updateMetricHint);
    $(id).addEventListener('input', updateMetricHint);
  });
