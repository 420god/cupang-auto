/* ============================================================
   70-outbound.js — 출고
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 출고 =====================
   중국 배대지 창고에 있는 것을 골라 한국(쿠팡센터)으로 보내는 화면.

   **왜 발주가 아니라 여기서 다루나**(2026-08-18 재설계): 부분 출고가 실제로 있고,
   제트 작업비 청구서는 여러 발주를 가로질러 묶여서 온다. 그래서 출고는 발주와
   독립된 단위(inbound_shipments)이고, SKU 기준으로 모아서 보여준다 —
   실무에서 "이 상품 보내주세요"라고 하지 "6월 26일 발주분 보내주세요"라고 하지 않는다.

   **로트를 쪼개는 이유**: 100개 중 60개만 보내면 그 60개엔 작업비가 붙고 남은 40개는
   안 붙어서 한 로트가 두 개의 개당 원가를 갖게 된다. 그래서 나가는 만큼을 새 로트로
   떼어내고(split_from_lot_id) 거기에만 작업비를 얹는다.

   **여러 발주에서 온 같은 SKU는 오래된 것부터 내보낸다**(사용자 확인) —
   실제 창고 운영과 같고, 선입선출 원가 계산과도 맞는다. */
const SHIP = { skus: [], lots: [], byPoLine: new Map(), poById: new Map(), hist: [], picks: new Map() };

/* 예전엔 "도착 예정 vs 창고에 있음"을 발주 단계로 갈랐는데, 020부터 **로트가 직접
   실제 도착 수량을 갖는다**(qty_arrived). 1688에서 일부만 먼저 오는 일이 실제로 있어서
   발주 단위 상태로는 표현이 안 됐다. 이제 미도착 = 발주수량 − 도착수량이고,
   창고에 실제로 있는 건 qty_china 하나뿐이라 우회 판정이 필요 없다. */
function lotIncoming(lot) {
  return Math.max(0, (Number(lot.qty_ordered) || 0)
    - (Number(lot.qty_arrived) || 0)
    - (Number(lot.qty_cancelled) || 0));   // 취소분은 영영 안 온다(022)
}

function skuWorkFee(sku) {
  const it = (sku && sku.work_fee_items) || {};
  return ['inspect', 'barcode', 'extra'].reduce((a, k) => a + (Number(it[k]) || 0), 0);
}

async function loadShip() {
  const el = $('#shipRows');
  el.innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  try {
    const [skus, lots, lines, orders, shipments, shipLines] = await Promise.all([
      apiAll('my_skus?select=id,sku_name,barcode,work_fee_items&order=sku_name.asc'),
      apiAll('inventory_lots?select=*'),
      apiAll('purchase_order_lines?select=id,po_id,sku_id'),
      apiAll('purchase_orders?select=id,status,requested_at'),
      apiAll('inbound_shipments?select=*&order=requested_at.desc'),
      apiAll('inbound_shipment_lines?select=shipment_id,qty')
    ]);
    SHIP.skus = skus;
    SHIP.lots = lots;
    SHIP.byPoLine = new Map(lines.map((l) => [l.id, l]));
    SHIP.poById = new Map(orders.map((o) => [o.id, o]));

    const agg = new Map();
    shipLines.forEach((l) => {
      const a = agg.get(l.shipment_id) || { n: 0, qty: 0 };
      a.n++; a.qty += l.qty || 0;
      agg.set(l.shipment_id, a);
    });
    SHIP.hist = shipments.map((s) => ({ s, agg: agg.get(s.id) || { n: 0, qty: 0 } }));

    renderShip();
    renderShipHist();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

/* SKU별로 로트를 모아 위치별 수량을 낸다. 도착 예정과 창고는 같은 qty_china지만
   발주 단계로 갈라서 보여준다(사용자 요청: 둘 다 보고 싶다). */
function shipBuckets() {
  const bySku = new Map();
  SHIP.lots.forEach((lot) => {
    if (!lot.sku_id) return;
    const b = bySku.get(lot.sku_id) || { incoming: 0, china: 0, transit: 0, coupang: 0, lots: [], cost: null };
    b.china += Number(lot.qty_china) || 0;
    b.incoming += lotIncoming(lot);
    b.transit += Number(lot.qty_transit) || 0;
    b.coupang += Number(lot.qty_coupang) || 0;
    b.lots.push(lot);
    if (b.cost == null && lot.unit_cost_krw != null) b.cost = Number(lot.unit_cost_krw);
    bySku.set(lot.sku_id, b);
  });
  return bySku;
}

function renderShip() {
  const f = $('#shipFilter').value;
  const bySku = shipBuckets();
  const skuById = new Map(SHIP.skus.map((s) => [s.id, s]));

  const noSkuQty = SHIP.lots.filter((l) => !l.sku_id)
    .reduce((a, l) => a + (Number(l.qty_china) || 0), 0);

  const rows = [];
  bySku.forEach((b, skuId) => {
    const sku = skuById.get(skuId);
    if (!sku) return;
    if (f === 'china' && b.china <= 0) return;
    if (f === 'incoming' && b.incoming <= 0) return;
    if (f === 'transit' && b.transit <= 0) return;
    if (f === 'coupang' && b.coupang <= 0) return;
    if (f === 'all' && (b.incoming + b.china + b.transit + b.coupang) <= 0) return;
    rows.push({ sku, b });
  });
  rows.sort((a, b) => a.sku.sku_name.localeCompare(b.sku.sku_name, 'ko'));

  const tot = rows.reduce((a, r) => ({
    incoming: a.incoming + r.b.incoming, china: a.china + r.b.china,
    transit: a.transit + r.b.transit, coupang: a.coupang + r.b.coupang
  }), { incoming: 0, china: 0, transit: 0, coupang: 0 });
  $('#shipSummary').textContent = (rows.length
    ? `도착예정 ${tot.incoming} · 중국창고 ${tot.china} · 출고중 ${tot.transit} · 쿠팡센터 ${tot.coupang}`
    : '표시할 재고가 없습니다.')
    /* SKU가 없는 물량은 출고 대상이 아니다(바코드가 없으면 쿠팡에 못 보낸다) —
       그래도 창고엔 실재하므로 숨기지 말고 왜 안 보이는지 알려준다. */
    + (noSkuQty ? ` · SKU 미정 ${noSkuQty}개(출고 불가 — 입고 탭 참조)` : '');

  $('#shipRows').innerHTML = rows.length ? rows.map((r) => `<tr>
      <td>${esc(r.sku.sku_name)}<span class="sku-name-sub">${esc(r.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${r.b.incoming || '—'}</td>
      <td class="col-num">${r.b.china ? `<b>${r.b.china}</b>` : '—'}</td>
      <td class="col-num">${r.b.transit || '—'}</td>
      <td class="col-num">${r.b.coupang || '—'}</td>
      <td class="col-num">${r.b.cost == null ? '—' : Math.round(r.b.cost).toLocaleString() + '원'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">표시할 재고가 없습니다.</td></tr>';
}
$('#shipFilter').onchange = () => renderShip();

const SHIP_METHOD_LABEL = { milkrun_parcel: '밀크런 택배', pallet: '파렛트', direct_parcel: '택배 직납' };

function renderShipHist() {
  $('#shipHistRows').innerHTML = SHIP.hist.length ? SHIP.hist.map((h) => {
    const s = h.s;
    const arrived = !!s.arrived_at;
    return `<tr>
      <td>${esc((s.requested_at || '').slice(0, 10))}<span class="sku-name-sub">${esc(SHIP_METHOD_LABEL[s.shipping_method] || '')}</span></td>
      <td class="col-num">${h.agg.n}</td>
      <td class="col-num">${cnt(h.agg.qty)}</td>
      <td class="col-num">${s.computed_work_fee_krw == null ? '—' : Math.round(s.computed_work_fee_krw).toLocaleString() + '원'}</td>
      <td class="col-num">${s.work_fee_total_krw == null ? '<span class="muted">없음</span>' : Math.round(s.work_fee_total_krw).toLocaleString() + '원'}</td>
      <td><span class="prog prog-${arrived ? 'ok' : 'mid'}">${arrived ? '쿠팡센터 도착' : '출고중'}</span></td>
      <td>${arrived ? '' : `<button class="btn btn-sm ship-arrive" data-ship="${esc(s.id)}">도착 처리</button>`}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">아직 출고 이력이 없습니다.</td></tr>';
}

/* 도착 처리 — 그 출고의 로트들을 운송중에서 쿠팡으로 옮긴다.
   arrived_coupang_at은 선입선출 정렬 기준이라 여기서 꼭 남긴다. */
$('#shipHistRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.ship-arrive');
  if (!btn) return;
  btn.disabled = true;
  try {
    const id = btn.dataset.ship;
    const lines = await apiAll(`inbound_shipment_lines?select=lot_id,qty&shipment_id=eq.${encodeURIComponent(id)}`);
    const now = new Date().toISOString();
    for (const ln of lines) {
      if (!ln.lot_id) continue;
      const lot = SHIP.lots.find((l) => l.id === ln.lot_id);
      const transit = lot ? (Number(lot.qty_transit) || 0) : (ln.qty || 0);
      await api(`inventory_lots?id=eq.${ln.lot_id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { qty_transit: 0, qty_coupang: transit, arrived_coupang_at: now }
      });
    }
    await api(`inbound_shipments?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { arrived_at: now }
    });
    toast('쿠팡센터 도착 처리 완료');
    loadShip();
  } catch (e) {
    toast('도착 처리 실패: ' + e.message, 4000);
  } finally {
    btn.disabled = false;
  }
});

/* ── 출고 만들기 ── */
$('#shipNewBtn').onclick = () => {
  const bySku = shipBuckets();
  const skuById = new Map(SHIP.skus.map((s) => [s.id, s]));
  SHIP.picks = new Map();
  bySku.forEach((b, skuId) => {
    const sku = skuById.get(skuId);
    if (!sku || b.china <= 0) return;
    /* 기본값은 전량 — 사용자가 "왠만하면 전량 출고"라고 확인(2026-08-18) */
    SHIP.picks.set(skuId, { sku, avail: b.china, qty: b.china, fee: skuWorkFee(sku), on: true });
  });
  $('#shipDate').value = new Date().toISOString().slice(0, 10);
  $('#shipInvoiceTotal').value = '';
  $('#shipMsg').className = 'msg hidden';
  $('#shipInvoiceInfo').className = 'msg hidden';
  $('#shipFile').value = '';
  SHIP.invoice = null;
  renderShipPicks();
  $('#shipModal').classList.remove('hidden');
};
$$('#shipModal [data-close]').forEach((b) => { b.onclick = () => $('#shipModal').classList.add('hidden'); });

function renderShipPicks() {
  const rows = Array.from(SHIP.picks.entries());
  if (!rows.length) {
    $('#shipPickRows').innerHTML = '<tr><td colspan="6" class="muted">중국 창고에 보낼 재고가 없습니다. 발주를 "중국배대지 도착"으로 바꾸면 여기 나타납니다.</td></tr>';
    $('#shipComputed').value = '';
    return;
  }
  $('#shipPickRows').innerHTML = rows.map(([skuId, p]) => `<tr>
      <td><input type="checkbox" class="ship-on" data-sku="${esc(skuId)}" ${p.on ? 'checked' : ''} /></td>
      <td>${esc(p.sku.sku_name)}<span class="sku-name-sub">${esc(p.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${p.avail}</td>
      <td class="col-num"><input type="number" class="ship-qty defect-input" min="0" max="${p.avail}"
            data-sku="${esc(skuId)}" value="${p.qty}" ${p.on ? '' : 'disabled'} /></td>
      <td class="col-num"><input type="number" class="ship-fee defect-input" min="0"
            data-sku="${esc(skuId)}" value="${p.fee}" ${p.on ? '' : 'disabled'} /></td>
      <td class="col-num">${p.on ? (p.qty * p.fee).toLocaleString() + '원' : '—'}</td>
    </tr>`).join('');

  const computed = rows.reduce((a, [, p]) => a + (p.on ? p.qty * p.fee : 0), 0);
  $('#shipComputed').value = computed;

  const inv = Number($('#shipInvoiceTotal').value);
  const el = $('#shipCheck');
  if (!inv) {
    el.className = 'muted sm';
    el.textContent = '청구서 총액을 넣으면 우리 계산과 대조합니다. 비워두면 SKU 기본 작업비로 추정 저장됩니다.';
  } else if (Math.abs(inv - computed) < 1) {
    el.className = 'muted sm';
    el.textContent = `청구서와 정확히 일치합니다 (${computed.toLocaleString()}원).`;
  } else {
    el.className = 'warn-txt sm';
    el.textContent = `청구서 ${inv.toLocaleString()}원 vs 우리 계산 ${computed.toLocaleString()}원 — ` +
      `${(inv - computed > 0 ? '+' : '')}${(inv - computed).toLocaleString()}원 차이. 개당 작업비를 확인하세요.`;
  }
}

$('#shipPickRows').addEventListener('change', (ev) => {
  const on = ev.target.closest('.ship-on');
  if (on) { SHIP.picks.get(on.dataset.sku).on = on.checked; renderShipPicks(); return; }
  const q = ev.target.closest('.ship-qty');
  if (q) {
    const p = SHIP.picks.get(q.dataset.sku);
    p.qty = Math.max(0, Math.min(p.avail, parseInt(q.value, 10) || 0));
    renderShipPicks(); return;
  }
  const f = ev.target.closest('.ship-fee');
  if (f) {
    SHIP.picks.get(f.dataset.sku).fee = Math.max(0, parseInt(f.value, 10) || 0);
    renderShipPicks();
  }
});
$('#shipInvoiceTotal').oninput = () => renderShipPicks();

/* 작업비 청구서 업로드 — PDF와 같은 엔드포인트를 쓰고 응답의 kind로 갈린다.
   읽는 건 총액·부가세뿐이고, 상품별 배분은 화면의 SKU 작업비가 담당한다. */
$('#shipDrop').onclick = () => $('#shipFile').click();
$('#shipDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#shipDrop').classList.add('over'); });
$('#shipDrop').addEventListener('dragleave', () => $('#shipDrop').classList.remove('over'));
$('#shipDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#shipDrop').classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) shipHandleFile(f);
});
$('#shipFile').onchange = (e) => { const f = e.target.files[0]; if (f) shipHandleFile(f); };

async function shipHandleFile(file) {
  const info = $('#shipInvoiceInfo');
  info.className = 'msg';
  info.textContent = '청구서 읽는 중…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/parse-invoice', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    if (d.kind !== 'xlsx') throw new Error('엑셀 청구서만 자동 인식됩니다. PDF면 총액을 직접 넣어주세요.');

    const z = parseZetInvoice(d.rows);
    if (z.error) throw new Error(z.error);

    SHIP.invoice = z;
    $('#shipInvoiceTotal').value = z.totalKrw;

    const lines = [
      `<b>청구 금액 합계 ${z.totalKrw.toLocaleString()}원</b>` +
      (z.vatKrw != null ? ` · 부가세 ${z.vatKrw.toLocaleString()}원` : '') +
      (z.grandTotalKrw != null ? ` · 총액 ${z.grandTotalKrw.toLocaleString()}원` : '')
    ];
    z.items.forEach((it) => {
      lines.push(`${esc(it.name)} — ${it.unit.toLocaleString()}원 × ${it.count.toLocaleString()}건 = ${it.amount.toLocaleString()}원`);
    });
    if (z.itemMismatch) {
      lines.push(`<span class="warn-txt">항목 합계가 청구 금액 합계와 ${z.itemMismatch > 0 ? '+' : ''}${z.itemMismatch.toLocaleString()}원 차이 — 못 읽은 항목이 있을 수 있습니다.</span>`);
    }
    if (z.rateNote) {
      lines.push(`<span class="muted">구매대행 적용 환율 ${z.rateNote.rate} (청구서 비고란)</span>`);
    }
    info.className = 'msg';
    info.innerHTML = lines.join('<br>');
    renderShipPicks();
  } catch (e) {
    SHIP.invoice = null;
    info.className = 'msg err';
    info.textContent = '청구서 인식 실패: ' + e.message;
  }
}
$('#shipAll').onchange = (ev) => {
  SHIP.picks.forEach((p) => { p.on = ev.target.checked; });
  renderShipPicks();
};

$('#shipSave').onclick = async () => {
  const btn = $('#shipSave');
  const msg = $('#shipMsg');
  const picks = Array.from(SHIP.picks.values()).filter((p) => p.on && p.qty > 0);
  if (!picks.length) { msg.className = 'msg err'; msg.textContent = '보낼 상품을 고르세요.'; return; }

  btn.disabled = true;
  try {
    const computed = picks.reduce((a, p) => a + p.qty * p.fee, 0);
    const invoiceTotal = Number($('#shipInvoiceTotal').value) || null;
    const shipment = (await api('inbound_shipments', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: [{
        requested_at: ($('#shipDate').value || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z',
        shipping_method: $('#shipMethod').value,
        computed_work_fee_krw: computed,
        work_fee_total_krw: invoiceTotal,
        vat_krw: SHIP.invoice ? SHIP.invoice.vatKrw : null,
        grand_total_krw: SHIP.invoice ? SHIP.invoice.grandTotalKrw : null,
        /* 총액이 파일에서 온 건지 손으로 넣은 건지 남긴다 — 나중에 신뢰도를 판단하려면
           출처가 필요하다(프로젝트 원칙: 근거 데이터 소스를 추적 가능하게). */
        invoice_source: SHIP.invoice ? 'xlsx' : (invoiceTotal ? 'manual' : 'none'),
        confirmed_by_user: true
      }]
    }))[0];

    const shipLines = [];
    for (const p of picks) {
      /* 오래된 로트부터 뺀다(사용자 확인) — 창고 운영 순서이자 선입선출 원가와도 맞는다.
         도착 시각이 없으면(아직 안 찍힘) 발주 시각으로 정렬한다. */
      const lots = SHIP.lots
        .filter((l) => l.sku_id === p.sku.id && (Number(l.qty_china) || 0) > 0)
        .sort((a, b) => new Date(a.arrived_china_at || a.ordered_at || 0) - new Date(b.arrived_china_at || b.ordered_at || 0));

      let left = p.qty;
      for (const lot of lots) {
        if (left <= 0) break;
        const have = Number(lot.qty_china) || 0;
        const take = Math.min(have, left);
        left -= take;

        const purchase = Number(lot.unit_purchase_cost_krw != null ? lot.unit_purchase_cost_krw : lot.unit_cost_krw) || 0;
        const unitCost = Math.round((purchase + p.fee) * 100) / 100;

        let targetLotId = lot.id;
        if (take === have) {
          /* 통째로 나가면 그 로트를 그대로 옮기고 작업비를 얹는다 */
          await api(`inventory_lots?id=eq.${lot.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: {
              qty_china: 0, qty_transit: take,
              unit_work_fee_krw: p.fee, unit_cost_krw: unitCost, cost_status: 'confirmed',
              cost_breakdown: Object.assign({}, lot.cost_breakdown || {}, { work_fee: p.fee })
            }
          });
          lot.qty_china = 0; lot.qty_transit = take;
        } else {
          /* 일부만 나가면 나가는 만큼을 새 로트로 떼어낸다 —
             남은 수량은 다음에 다른 작업비로 나갈 수 있어 개당 원가가 달라진다 */
          const made = (await api('inventory_lots', {
            method: 'POST', headers: { prefer: 'return=representation' },
            body: [{
              sku_id: lot.sku_id, po_line_id: lot.po_line_id, split_from_lot_id: lot.id,
              qty_ordered: take, qty_china: 0, qty_transit: take,
              unit_purchase_cost_krw: purchase, unit_work_fee_krw: p.fee, unit_cost_krw: unitCost,
              cost_status: 'confirmed',
              cost_breakdown: Object.assign({}, lot.cost_breakdown || {}, { work_fee: p.fee, split_from: lot.id }),
              ordered_at: lot.ordered_at, arrived_china_at: lot.arrived_china_at
            }]
          }))[0];
          await api(`inventory_lots?id=eq.${lot.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: { qty_china: have - take }
          });
          lot.qty_china = have - take;
          targetLotId = made.id;
        }

        shipLines.push({
          shipment_id: shipment.id, lot_id: targetLotId, sku_id: p.sku.id, qty: take,
          work_fee_per_unit_krw: p.fee, unit_extra_cost_krw: p.fee
        });
      }
      if (left > 0) throw new Error(`${p.sku.sku_name}: 창고 수량이 부족합니다(${left}개 모자람).`);
    }
    if (shipLines.length) {
      await api('inbound_shipment_lines', { method: 'POST', headers: { prefer: 'return=minimal' }, body: shipLines });
    }

    $('#shipModal').classList.add('hidden');
    toast(`출고 저장 — ${picks.length}개 상품, 작업비 ${computed.toLocaleString()}원`);
    loadShip();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
