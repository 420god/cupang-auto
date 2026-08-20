/* ============================================================
   60-inbound.js — 입고(중국 배대지) · 재고/재발주 · 제트 작업비 파서
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 입고 (중국 배대지) =====================
   물건의 **물리적 상태**를 관리하는 화면. 발주 상세가 "원가와 SKU 연결"을 맡는다면
   여기는 "실제로 몇 개가 왔고 몇 개가 불량인가"를 맡는다.
   같은 걸 두 군데서 고칠 수 있으면 반드시 헷갈리므로 불량 입력은 여기로 일원화했다
   (발주 상세에서는 뺐음, 2026-08-18 사용자 동의).

   **도착은 SKU(로트) 단위다** — 1688에서 일부만 먼저 오는 일이 실제로 있어서
   발주 단위로는 표현이 안 된다. 한 발주 안에서도 상품마다 도착 시점이 다르다.
   그 발주의 모든 줄이 다 도착하면 발주 단계를 자동으로 '중국배대지 도착'으로 올린다. */
const INB = { lots: [], lines: [], skuById: new Map(), lineById: new Map(), poById: new Map() };

async function loadInbound() {
  $('#inboundWaitRows').innerHTML = '<tr><td colspan="9" class="muted">불러오는 중…</td></tr>';
  try {
    const [lots, skus, lines, orders] = await Promise.all([
      apiAll('inventory_lots?select=*'),
      apiAll('my_skus?select=id,sku_name,barcode'),
      apiAll('purchase_order_lines?select=id,po_id,sku_id,qty,product_name_text,barcode_text,'
             + 'group_key,group_shipping_cny,line_cost_cny,allocated_shipping_cny'),
      apiAll('purchase_orders?select=id,status,requested_at')
    ]);
    INB.lots = lots;
    INB.lines = lines;
    INB.skuById = new Map(skus.map((s) => [s.id, s]));
    INB.lineById = new Map(lines.map((l) => [l.id, l]));
    INB.poById = new Map(orders.map((o) => [o.id, o]));
    renderInbound();
  } catch (e) {
    $('#inboundWaitRows').innerHTML = `<tr><td colspan="9" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const inbPoDate = (lot) => {
  const line = INB.lineById.get(lot.po_line_id);
  const po = line && INB.poById.get(line.po_id);
  return po ? String(po.requested_at || '').slice(0, 10) : '—';
};
/* SKU가 아직 없는 로트(상품 등록 전 발주, 021)는 청구서에 적힌 상품명으로 보여준다 —
   물건은 실재하므로 입고·불량 관리는 그대로 되어야 한다. */
const inbSkuName = (lot) => {
  const s = INB.skuById.get(lot.sku_id);
  if (s) return s.sku_name;
  const line = INB.lineById.get(lot.po_line_id);
  return (line && line.product_name_text) || '(이름 없음)';
};
const inbSkuBarcode = (lot) => {
  const s = INB.skuById.get(lot.sku_id);
  if (s) return s.barcode || '바코드 없음';
  return 'SKU 미정 — 출고 전에 연결 필요';
};

function renderInbound() {
  /* 취소된 로트도 목록에 남긴다 — 안 그러면 전량 취소한 순간 행이 사라져서
     실수로 눌렀을 때 되돌릴 방법이 없다(사용자가 되돌리기를 요청, 2026-08-18). */
  const waiting = INB.lots
    .filter((l) => lotIncoming(l) > 0 || (Number(l.qty_cancelled) || 0) > 0)
    .sort((a, b) => String(inbPoDate(a)).localeCompare(String(inbPoDate(b))));
  const inStock = INB.lots
    .filter((l) => (Number(l.qty_china) || 0) > 0)
    .sort((a, b) => String(inbPoDate(a)).localeCompare(String(inbPoDate(b))));

  const waitQty = waiting.reduce((a, l) => a + lotIncoming(l), 0);
  const stockQty = inStock.reduce((a, l) => a + (Number(l.qty_china) || 0), 0);
  const defectQty = INB.lots.reduce((a, l) => a + (Number(l.qty_defect) || 0), 0);
  $('#inboundSummary').textContent =
    `도착 대기 ${waitQty}개 · 중국창고 ${stockQty}개 · 누적 불량 ${defectQty}개`;

  /* **이 화면은 로트만 보여준다** — SKU가 연결 안 된 청구서 줄은 로트가 없어서
     아무 데도 안 나온다. 그러면 "발주했는데 입고에 아무것도 없다"로 보이고 원인을
     알 길이 없다(2026-08-18 사용자가 실제로 겪음). 그래서 그 줄들을 여기서 짚어준다. */
  const lotLineIds = new Set(INB.lots.map((l) => l.po_line_id));
  const orphans = (INB.lines || []).filter((ln) => {
    if (lotLineIds.has(ln.id)) return false;
    const po = INB.poById.get(ln.po_id);
    return po && po.status !== 'cancelled';
  });
  const noSku = INB.lots.filter((l) => !l.sku_id &&
    ((Number(l.qty_china) || 0) > 0 || lotIncoming(l) > 0));

  const warn = $('#inboundOrphan');
  const notes = [];
  if (orphans.length) {
    const names = orphans.slice(0, 5).map((o) => esc(o.product_name_text || '(이름없음)')).join(', ');
    notes.push(`재고 로트가 아예 없는 청구서 줄이 <b>${orphans.length}개</b> 있습니다 — ` +
      '입고·출고·원가 어디에도 잡히지 않습니다. <b>발주</b> 탭에서 그 발주를 열어 SKU를 연결하세요.<br>' +
      `<span class="muted">${names}${orphans.length > 5 ? ' 외' : ''}</span>`);
  }
  if (noSku.length) {
    /* 상품 등록 전에 발주한 경우다 — 입고·불량 관리는 여기서 그대로 되지만,
       쿠팡으로 출고하려면 상품을 등록하고 바코드를 받아 SKU를 연결해야 한다. */
    notes.push(`SKU가 아직 안 정해진 물량이 <b>${noSku.length}건</b> 있습니다 — ` +
      '입고·불량 관리는 여기서 그대로 하시면 되고, <b>쿠팡으로 출고하기 전에</b> ' +
      '상품을 등록하고 바코드를 받아 <b>발주</b> 탭에서 SKU를 연결하세요.');
  }
  if (notes.length) { warn.className = 'msg'; warn.innerHTML = notes.join('<br><br>'); }
  else { warn.className = 'msg hidden'; }

  $('#inboundWaitRows').innerHTML = waiting.length ? waiting.map((l) => {
    const left = lotIncoming(l);
    return `<tr>
      <td>${esc(inbPoDate(l))}</td>
      <td>${esc(inbSkuName(l))}<span class="sku-name-sub">${esc(inbSkuBarcode(l))}</span></td>
      <td class="col-num">${l.qty_ordered || 0}</td>
      <td class="col-num">${l.qty_arrived || 0}${l.qty_cancelled
          ? `<span class="sku-name-sub">취소 ${l.qty_cancelled}</span>` : ''}</td>
      <td class="col-num"><b>${left}</b></td>
      <td class="col-num"><input type="number" class="inb-arrive defect-input" min="0" max="${left}"
            data-lot="${esc(l.id)}" value="${left}" /></td>
      <td class="col-num"><input type="number" class="inb-defect defect-input" min="0"
            data-lot="${esc(l.id)}" value="0" /></td>
      <td><button class="btn btn-sm btn-primary inb-receive" data-lot="${esc(l.id)}" ${left ? '' : 'disabled'}>도착 처리</button></td>
      <td>${(Number(l.qty_cancelled) || 0) > 0
          ? `<button class="btn btn-sm btn-ghost inb-uncancel" data-lot="${esc(l.id)}">취소 되돌리기</button>`
          : `<button class="btn btn-sm inb-cancel" data-lot="${esc(l.id)}">취소</button>`}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="muted">도착 대기 중인 물량이 없습니다. (발주한 물량이 전부 도착했거나, 아직 SKU가 연결되지 않아 로트가 없는 상태입니다)</td></tr>';

  $('#inboundStockRows').innerHTML = inStock.length ? inStock.map((l) => `<tr>
      <td>${esc(inbPoDate(l))}</td>
      <td>${esc(inbSkuName(l))}<span class="sku-name-sub">${esc(inbSkuBarcode(l))}</span></td>
      <td class="col-num"><b>${l.qty_china}</b></td>
      <td class="col-num">${l.qty_defect || 0}${l.defect_disposition
          ? `<span class="sku-name-sub">${l.defect_disposition === 'refund' ? '환불' : '손실'}</span>` : ''}</td>
      <td class="col-num"><input type="number" class="inb-adddefect defect-input" min="0" max="${l.qty_china}"
            data-lot="${esc(l.id)}" value="0" /></td>
      <td><select class="inb-disp ship-filter" data-lot="${esc(l.id)}">
            <option value="refund">예치금 환불</option>
            <option value="loss">손실 처리</option>
          </select></td>
      <td><button class="btn btn-sm inb-defect-apply" data-lot="${esc(l.id)}">불량 반영</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">중국창고에 있는 물량이 없습니다. (아직 도착 처리를 안 했거나, 이미 한국으로 출고된 상태입니다)</td></tr>';
}

/* 그 발주의 모든 줄이 다 도착했으면 발주 단계를 '중국배대지 도착'으로 올린다.
   줄마다 따로 도착하므로 발주 단계는 "전부 왔는가"의 요약일 뿐이다. */
async function inbMaybeAdvancePo(lot) {
  const line = INB.lineById.get(lot.po_line_id);
  const po = line && INB.poById.get(line.po_id);
  if (!po || po.status === 'arrived_cn') return;
  const lineIds = new Set(
    Array.from(INB.lineById.values()).filter((l) => l.po_id === po.id).map((l) => l.id)
  );
  const siblings = INB.lots.filter((l) => lineIds.has(l.po_line_id));
  if (siblings.some((l) => lotIncoming(l) > 0)) return;   // 아직 안 온 게 남았다
  await api(`purchase_orders?id=eq.${encodeURIComponent(po.id)}`, {
    method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'arrived_cn' }
  });
  po.status = 'arrived_cn';
}

$('#inboundWaitRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.inb-receive');
  if (!btn) return;
  const lotId = btn.dataset.lot;
  const lot = INB.lots.find((l) => String(l.id) === String(lotId));
  if (!lot) return;
  const val = (sel) => {
    const el = document.querySelector(`.${sel}[data-lot="${CSS.escape(lotId)}"]`);
    return Math.max(0, parseInt(el && el.value, 10) || 0);
  };
  const arrive = Math.min(lotIncoming(lot), val('inb-arrive'));
  const defect = Math.min(arrive, val('inb-defect'));
  const msg = $('#inboundMsg');
  if (arrive <= 0) { msg.className = 'msg err'; msg.textContent = '도착 수량을 입력하세요.'; return; }

  btn.disabled = true;
  try {
    /* 증분으로 더한다 — 나중에 나머지가 또 도착해도 그때 다시 눌러 쌓을 수 있다.
       창고 수량은 (도착 − 불량)만큼 늘린다. 이미 나간 수량은 건드리지 않는다. */
    const body = {
      qty_arrived: (Number(lot.qty_arrived) || 0) + arrive,
      qty_defect: (Number(lot.qty_defect) || 0) + defect,
      qty_china: (Number(lot.qty_china) || 0) + (arrive - defect)
    };
    if (!lot.arrived_china_at) body.arrived_china_at = new Date().toISOString();
    await api(`inventory_lots?id=eq.${encodeURIComponent(lotId)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(lot, body);
    await inbMaybeAdvancePo(lot);
    msg.className = 'msg hidden';
    toast(`도착 ${arrive}개 처리${defect ? ` (불량 ${defect}개 제외)` : ''}`);
    renderInbound();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '도착 처리 실패: ' + e.message;
    btn.disabled = false;
  }
});

/* ── 발주 취소 ────────────────────────────────────────────────
   판매자가 못 팔겠다고 하는 경우다. 취소분은 영영 안 오므로 미도착에서 빼고,
   금액은 예치금으로 돌아온다.

   **환불액은 추정만 하고 사람이 고친다**(사용자 확인 2026-08-18):
     배송 전 취소 -> 배송비까지 돌아온다
     배송 후 취소 -> 판매자에 따라 다르다(배송비를 내가 부담하는 경우도 있다)
   그래서 상품가만/전액 두 값을 참고로 보여주고 입력칸은 열어둔다. */
const CANCEL = { lot: null };

$('#inboundWaitRows').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.inb-cancel');
  if (!btn) return;
  const lot = INB.lots.find((l) => String(l.id) === String(btn.dataset.lot));
  if (!lot) return;
  CANCEL.lot = lot;

  const left = lotIncoming(lot);
  const purchase = Number(lot.unit_purchase_cost_krw != null
    ? lot.unit_purchase_cost_krw : lot.unit_cost_krw) || 0;
  const bd = lot.cost_breakdown || {};
  const rate = Number(bd.rate_purchase) || 0;
  /* 상품가만 = 개당 원가에서 배송비 배분분을 뺀 값. 청구서의 CNY 배분액에 환율을 곱해 되돌린다. */
  const shipPerUnit = (rate && bd.cny_shipping_alloc && lot.qty_ordered)
    ? Math.round((Number(bd.cny_shipping_alloc) / lot.qty_ordered) * rate) : 0;
  const goodsOnly = Math.max(0, purchase - shipPerUnit);

  $('#cancelTitle').textContent = `발주 취소 — ${inbSkuName(lot)}`;
  $('#cancelRo').innerHTML = [
    ['발주', `${lot.qty_ordered || 0}개`],
    ['이미 도착', `${lot.qty_arrived || 0}개`],
    ['취소 가능', `${left}개`],
    ['개당 원가', `${Math.round(purchase).toLocaleString()}원`]
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  $('#cancelQty').value = left;
  $('#cancelQty').max = left;
  $('#cancelReason').value = 'seller_unavailable';
  $('#cancelMemo').value = '';
  $('#cancelDeposit').value = 'yes';
  $('#cancelMsg').className = 'msg hidden';
  CANCEL.goodsOnly = goodsOnly;
  CANCEL.full = Math.round(purchase);
  cancelRefreshHint();
  $('#cancelModal').classList.remove('hidden');
});

function cancelRefreshHint() {
  const qty = Math.max(0, parseInt($('#cancelQty').value, 10) || 0);
  const a = CANCEL.goodsOnly * qty, b = CANCEL.full * qty;
  $('#cancelHint').innerHTML =
    `참고: 상품가만 <b>${a.toLocaleString()}원</b> · 배송비 포함 <b>${b.toLocaleString()}원</b><br>` +
    '<span class="muted">기본값은 <b>상품가만</b>입니다 — 같은 판매자의 다른 SKU가 남아 있으면 ' +
    '배송비는 그쪽이 나눠 지도록 자동으로 다시 계산됩니다. 그 판매자 물건을 전부 취소해서 ' +
    '배송비까지 돌려받으면 금액을 직접 올리세요.</span>';
  /* 기본은 **상품가만** — 사용자 확인(2026-08-18): 한 SKU만 취소하면 배송비는
     남은 SKU들이 나눠 지므로 환불 대상이 아니다. */
  $('#cancelRefund').value = a;
}
$('#cancelQty').oninput = () => cancelRefreshHint();
$$('#cancelModal [data-close]').forEach((b) => { b.onclick = () => $('#cancelModal').classList.add('hidden'); });

/* 취소 되돌리기 — 취소 수량을 0으로 돌리고, 그 로트로 만들어진 환불 기록을 void로 바꾼다.
   기록을 지우지 않고 void로 남기는 이유: "취소했다가 되돌렸다"도 사실이고, 예치금을
   실제 입금과 맞출 때 지워진 기록보다 무효 표시된 기록이 훨씬 추적하기 쉽다. */
$('#inboundWaitRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.inb-uncancel');
  if (!btn) return;
  const lot = INB.lots.find((l) => String(l.id) === String(btn.dataset.lot));
  if (!lot) return;
  btn.disabled = true;
  try {
    await api(`inventory_lots?id=eq.${encodeURIComponent(lot.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { qty_cancelled: 0, cancel_reason: null, cancel_memo: null }
    });
    await api(`supplier_deposits?lot_id=eq.${encodeURIComponent(lot.id)}&reason=eq.cancel&status=eq.expected`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'void' }
    });
    lot.qty_cancelled = 0; lot.cancel_reason = null;
    toast('취소를 되돌렸습니다 — 환불 기록도 무효 처리했습니다');
    renderInbound();
  } catch (e) {
    toast('되돌리기 실패: ' + e.message, 4000);
    btn.disabled = false;
  }
});

/* 같은 1688 주문 묶음의 배송비를 남은 SKU들이 다시 나눠 지게 한다(사용자 확인 2026-08-18).
   같은 판매자에게서 여러 옵션을 사면 배송비가 하나로 붙는데, 그중 하나가 취소돼도
   판매자는 나머지를 여전히 보내므로 **배송비는 그대로 나가고 남은 것들이 부담한다.**
   그래서 환불은 상품가만 하고, 남은 줄들의 개당 원가는 올라간다.

   취소는 물건이 오기 전에 일어나므로(아직 출고·판매 전) 원가를 다시 계산해도
   과거 이익이 흔들리지 않는다 — 이 시점이 아니면 고칠 기회가 없다. */
async function cancelRedistributeShipping(lot) {
  const line = INB.lineById.get(lot.po_line_id);
  if (!line || !line.group_key) return 0;
  const groupShip = Number(line.group_shipping_cny) || 0;
  if (!groupShip) return 0;

  const rate = Number((lot.cost_breakdown || {}).rate_purchase) || 0;
  if (!rate) return 0;

  const lotByLine = new Map();
  INB.lots.forEach((l) => { if (!lotByLine.has(l.po_line_id)) lotByLine.set(l.po_line_id, l); });

  const members = INB.lines
    .filter((l) => l.po_id === line.po_id && l.group_key === line.group_key)
    .map((l) => {
      const lt = lotByLine.get(l.id);
      const eff = Math.max(0, (Number(l.qty) || 0) - (lt ? (Number(lt.qty_cancelled) || 0) : 0));
      return { l, lt, eff };
    });
  const totalEff = members.reduce((a, m) => a + m.eff, 0);
  if (!totalEff) return 0;

  let changed = 0;
  for (const m of members) {
    if (!m.lt || m.eff <= 0) continue;
    /* 상품가 개당(CNY)은 청구서 원값에서 되돌린다 — unit_price_cny는 총액에서 역산된
       소수점 5자리라 믿지 않는다는 파서 원칙 그대로. */
    const goodsCny = ((Number(m.l.line_cost_cny) || 0) - (Number(m.l.allocated_shipping_cny) || 0))
      / Math.max(1, Number(m.l.qty) || 1);
    const alloc = groupShip * m.eff / totalEff;
    const unitPurchase = Math.round((goodsCny + alloc / m.eff) * rate * 100) / 100;
    const work = Number(m.lt.unit_work_fee_krw) || 0;
    if (Math.abs(unitPurchase - (Number(m.lt.unit_purchase_cost_krw) || 0)) < 0.01) continue;

    await api(`inventory_lots?id=eq.${encodeURIComponent(m.lt.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: {
        unit_purchase_cost_krw: unitPurchase,
        unit_cost_krw: Math.round((unitPurchase + work) * 100) / 100,
        cost_breakdown: Object.assign({}, m.lt.cost_breakdown || {}, {
          cny_shipping_alloc: Math.round(alloc * 100) / 100,
          shipping_recalculated_at: new Date().toISOString()
        })
      }
    });
    m.lt.unit_purchase_cost_krw = unitPurchase;
    m.lt.unit_cost_krw = Math.round((unitPurchase + work) * 100) / 100;
    changed++;
  }
  return changed;
}

/* 발주한 물량이 전부 취소되면 발주 자체를 취소로 바꾼다(사용자 요청 2026-08-18) */
async function cancelMaybeCancelPo(lot) {
  const line = INB.lineById.get(lot.po_line_id);
  const po = line && INB.poById.get(line.po_id);
  if (!po || po.status === 'cancelled') return false;
  const lineIds = new Set(INB.lines.filter((l) => l.po_id === po.id).map((l) => l.id));
  const lots = INB.lots.filter((l) => lineIds.has(l.po_line_id));
  if (!lots.length) return false;
  const allGone = lots.every((l) =>
    (Number(l.qty_arrived) || 0) === 0 &&
    (Number(l.qty_cancelled) || 0) >= (Number(l.qty_ordered) || 0));
  if (!allGone) return false;
  await api(`purchase_orders?id=eq.${encodeURIComponent(po.id)}`, {
    method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'cancelled' }
  });
  po.status = 'cancelled';
  return true;
}

$('#cancelSave').onclick = async () => {
  const lot = CANCEL.lot;
  if (!lot) return;
  const btn = $('#cancelSave');
  const msg = $('#cancelMsg');
  const left = lotIncoming(lot);
  const qty = Math.min(left, Math.max(0, parseInt($('#cancelQty').value, 10) || 0));
  if (qty <= 0) { msg.className = 'msg err'; msg.textContent = '취소 수량을 입력하세요.'; return; }

  btn.disabled = true;
  try {
    const reason = $('#cancelReason').value;
    const memo = $('#cancelMemo').value.trim() || null;
    await api(`inventory_lots?id=eq.${encodeURIComponent(lot.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: {
        qty_cancelled: (Number(lot.qty_cancelled) || 0) + qty,
        cancel_reason: reason,
        cancel_memo: memo
      }
    });
    lot.qty_cancelled = (Number(lot.qty_cancelled) || 0) + qty;
    lot.cancel_reason = reason;

    if ($('#cancelDeposit').value === 'yes') {
      const refund = Math.max(0, Math.round(Number($('#cancelRefund').value) || 0));
      const line = INB.lineById.get(lot.po_line_id);
      /* status='expected' — 아직 실제로 입금된 게 아니다. 예치금은 그때그때 들어오므로
         나중에 실제 입금과 맞춰본 뒤 confirmed로 바꾼다(사용자 확인). */
      await api('supplier_deposits', {
        method: 'POST', headers: { prefer: 'return=minimal' },
        body: [{
          occurred_at: new Date().toISOString(),
          type: 'refund',
          reason: 'cancel',
          amount_krw: refund,
          estimated_amount_krw: CANCEL.full * qty,
          status: 'expected',
          lot_id: lot.id,
          sku_id: lot.sku_id || null,
          qty,
          po_id: line ? line.po_id : null,
          memo: `발주 취소 — ${inbSkuName(lot)} ${qty}개 (${$('#cancelReason').selectedOptions[0].text})`
            + (memo ? ` / ${memo}` : '')
        }]
      });
    }

    const moved = await cancelRedistributeShipping(lot);
    const poCancelled = await cancelMaybeCancelPo(lot);

    $('#cancelModal').classList.add('hidden');
    toast(`취소 ${qty}개 처리`
      + ($('#cancelDeposit').value === 'yes' ? ' · 예치금 환불 예정' : '')
      + (moved ? ` · 배송비 재배분 ${moved}건` : '')
      + (poCancelled ? ' · 발주 전체 취소됨' : ''));
    renderInbound();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '취소 처리 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

$('#inboundStockRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.inb-defect-apply');
  if (!btn) return;
  const lotId = btn.dataset.lot;
  const lot = INB.lots.find((l) => String(l.id) === String(lotId));
  if (!lot) return;
  const addEl = document.querySelector(`.inb-adddefect[data-lot="${CSS.escape(lotId)}"]`);
  const dispEl = document.querySelector(`.inb-disp[data-lot="${CSS.escape(lotId)}"]`);
  const add = Math.min(Number(lot.qty_china) || 0, Math.max(0, parseInt(addEl && addEl.value, 10) || 0));
  const msg = $('#inboundMsg');
  if (add <= 0) { msg.className = 'msg err'; msg.textContent = '뺄 불량 수량을 입력하세요.'; return; }

  btn.disabled = true;
  try {
    /* 창고에서 빼고 불량 누계에 더한다. **개당 원가는 건드리지 않는다** —
       불량분은 환불받거나 손실로 털지, 남은 정상품 원가를 올리지 않는다. */
    const body = {
      qty_defect: (Number(lot.qty_defect) || 0) + add,
      qty_china: (Number(lot.qty_china) || 0) - add,
      defect_disposition: dispEl ? dispEl.value : 'refund'
    };
    await api(`inventory_lots?id=eq.${encodeURIComponent(lotId)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(lot, body);

    /* 환불로 처리하기로 했으면 예치금 기록도 같이 남긴다(사용자 요청 2026-08-18).
       금액은 개당 원가 x 수량으로 추정하고, status='expected'로 둔다 —
       불량 환불도 판매자마다 달라서 실제 입금과 맞춰본 뒤 확정해야 한다. */
    if (body.defect_disposition === 'refund') {
      const unit = Number(lot.unit_purchase_cost_krw != null
        ? lot.unit_purchase_cost_krw : lot.unit_cost_krw) || 0;
      const line = INB.lineById.get(lot.po_line_id);
      await api('supplier_deposits', {
        method: 'POST', headers: { prefer: 'return=minimal' },
        body: [{
          occurred_at: new Date().toISOString(),
          type: 'refund', reason: 'defect',
          amount_krw: Math.round(unit * add),
          estimated_amount_krw: Math.round(unit * add),
          status: 'expected',
          lot_id: lot.id, sku_id: lot.sku_id || null, qty: add,
          po_id: line ? line.po_id : null,
          memo: `불량 ${add}개 — ${inbSkuName(lot)}`
        }]
      });
    }

    msg.className = 'msg hidden';
    toast(`불량 ${add}개 반영 — ${body.defect_disposition === 'refund' ? '예치금 환불 예정으로 기록' : '손실 처리'}`);
    renderInbound();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '불량 반영 실패: ' + e.message;
    btn.disabled = false;
  }
});

/* ===================== 재고 · 재발주 제안 =====================
   다품종 소량에서 가장 큰 손실은 적자가 아니라 **품절**이다(팔릴 물건이 없는 것).
   반대로 너무 많이 사두면 재고에 현금이 묶인다. 사용자 방침(2026-08-18):
   "최대한 타이트하되 품절은 안 나도록, 판매 추이 보면서 발주량을 점증/점감."

   ── 계산 방식 (표준 공식으로 시작해서 나중에 튜닝) ──────────────
   일평균  = 최근 7일 평균 x 0.6 + 최근 28일 평균 x 0.4
     추이를 자동으로 따라간다. 최근에 잘 팔리면 7일 평균이 올라가 발주량이 늘고,
     시들해지면 자연히 준다 — 사용자가 원한 "점증/점감"이 별도 규칙 없이 나온다.
     28일만 쓰면 반응이 느리고, 7일만 쓰면 하루 튄 값에 휘둘린다.

   재주문점 = 일평균 x (리드타임 + 안전일수)
     리드타임 동안 팔릴 양 + 여유분. 쿠팡 재고가 이 밑으로 내려가면 조치가 필요하다.

   권장 수량 = 일평균 x (리드타임 + 안전일수 + 보충주기) - (쿠팡+운송중+중국창고)
     이미 파이프라인에 있는 물량을 빼야 이중 발주가 안 된다. MOQ 이상으로 올림.

   ── 판정 ────────────────────────────────────────────────────
   쿠팡 재고로 버틸 날이 (리드타임+안전일수)보다 짧으면 조치 필요.
     중국 창고에 재고가 있으면 -> **입고요청**(새로 사는 것보다 훨씬 빠르다)
     없으면 -> **발주 필요**
   판매 이력이 14일 미만인 SKU는 "데이터 부족"으로 표시하고 수량을 제안하지 않는다 —
   근거 없는 숫자를 자신 있게 내미는 것이 아무 말 안 하는 것보다 나쁘다. */
const STOCK = { rows: [], defaults: { leadTime: 14, safetyDays: 5, reviewCycle: 14, historyDays: 28 } };

async function loadStock() {
  const el = $('#stockRows');
  el.innerHTML = '<tr><td colspan="9" class="muted">불러오는 중…</td></tr>';
  try {
    const today = kstDateStr(new Date());
    const from = addDaysStr(today, -(STOCK.defaults.historyDays - 1));
    const [skus, listings, lots, wing, gross, poLines, orders] = await Promise.all([
      apiAll('my_skus?select=id,sku_name,barcode,moq,lead_time_days,safety_days,status'),
      apiAll('sku_channel_listings?select=sku_id,external_option_id&channel=eq.coupang_rg'),
      apiAll('inventory_lots?select=id,sku_id,po_line_id,qty_ordered,qty_arrived,qty_cancelled,qty_china,qty_transit,qty_coupang,arrived_coupang_at'),
      apiAll(`rocket_growth_sales_wing_daily?select=sale_date,vendor_item_id,quantity&sale_date=gte.${from}`),
      apiAll(`rocket_growth_sales_daily?select=sale_date,vendor_item_id,quantity&sale_date=gte.${from}`),
      apiAll('purchase_order_lines?select=id,po_id,sku_id'),
      apiAll('purchase_orders?select=id,requested_at')
    ]);

    const vidBySku = new Map();
    listings.forEach((l) => {
      if (!l.external_option_id) return;
      const arr = vidBySku.get(l.sku_id) || [];
      arr.push(String(l.external_option_id));
      vidBySku.set(l.sku_id, arr);
    });

    /* 판매 병합 규칙은 판매현황과 같다 — 그 날짜에 WING이 있으면 WING만 쓴다 */
    const wingDates = new Set(wing.map((r) => r.sale_date));
    const salesByVid = new Map();
    const addSale = (r) => {
      const key = String(r.vendor_item_id);
      const m = salesByVid.get(key) || new Map();
      m.set(r.sale_date, (m.get(r.sale_date) || 0) + (Number(r.quantity) || 0));
      salesByVid.set(key, m);
    };
    wing.forEach(addSale);
    gross.forEach((r) => { if (!wingDates.has(r.sale_date)) addSale(r); });

    /* 리드타임 실측: 발주 요청일 → 그 로트가 쿠팡에 도착한 날.
       예측(설정값)과 실측을 나란히 두는 게 이 프로젝트의 "복리" 방식이다
       (docs/decisions.md 2026-08-18 "예측을 저장한다"). */
    const poById = new Map(orders.map((o) => [o.id, o]));
    const lineById = new Map(poLines.map((l) => [l.id, l]));
    const leadBySku = new Map();
    lots.forEach((lot) => {
      if (!lot.arrived_coupang_at || !lot.sku_id) return;
      const line = lineById.get(lot.po_line_id);
      const po = line && poById.get(line.po_id);
      if (!po || !po.requested_at) return;
      const days = (new Date(lot.arrived_coupang_at) - new Date(po.requested_at)) / 86400000;
      if (!(days > 0 && days < 200)) return;
      const arr = leadBySku.get(lot.sku_id) || [];
      arr.push(days);
      leadBySku.set(lot.sku_id, arr);
    });

    const qtyBySku = new Map();
    lots.forEach((lot) => {
      if (!lot.sku_id) return;
      const q = qtyBySku.get(lot.sku_id) || { china: 0, transit: 0, coupang: 0, incoming: 0 };
      /* 아직 중국에도 안 온 물량(발주수량 − 도착수량)도 파이프라인이다 —
         이걸 빼먹으면 이미 주문한 걸 또 발주하게 된다(020). */
      q.incoming += Math.max(0, (Number(lot.qty_ordered) || 0)
        - (Number(lot.qty_arrived) || 0) - (Number(lot.qty_cancelled) || 0));
      q.china += Number(lot.qty_china) || 0;
      q.transit += Number(lot.qty_transit) || 0;
      q.coupang += Number(lot.qty_coupang) || 0;
      qtyBySku.set(lot.sku_id, q);
    });

    const d7from = addDaysStr(today, -6);
    STOCK.rows = skus.map((sku) => {
      const vids = vidBySku.get(sku.id) || [];
      let sum7 = 0, sum28 = 0, days = new Set();
      vids.forEach((vid) => {
        const m = salesByVid.get(vid);
        if (!m) return;
        m.forEach((q, date) => {
          days.add(date);
          sum28 += q;
          if (date >= d7from) sum7 += q;
        });
      });
      /* 판매가 아예 없는 날은 행이 없다 — 0으로 치고 기간 전체로 나눈다 */
      const avg7 = sum7 / 7;
      const avg28 = sum28 / STOCK.defaults.historyDays;
      const daily = Math.round((avg7 * 0.6 + avg28 * 0.4) * 100) / 100;

      const q = qtyBySku.get(sku.id) || { china: 0, transit: 0, coupang: 0, incoming: 0 };
      const measured = leadBySku.get(sku.id);
      const measuredLead = measured && measured.length
        ? Math.round((measured.reduce((a, x) => a + x, 0) / measured.length) * 10) / 10 : null;
      const lead = num(sku.lead_time_days) ?? measuredLead ?? STOCK.defaults.leadTime;
      const safety = num(sku.safety_days) ?? STOCK.defaults.safetyDays;

      const coverDays = daily > 0 ? q.coupang / daily : null;
      const pipeline = q.coupang + q.transit + q.china + q.incoming;
      const target = daily * (lead + safety + STOCK.defaults.reviewCycle);
      const moq = num(sku.moq) ?? 1;
      let need = Math.max(0, Math.ceil(target - pipeline));
      if (need > 0 && need < moq) need = moq;

      const enoughHistory = days.size >= 14 || sum28 > 0;
      let verdict = 'ok';
      if (sku.status && sku.status !== 'active') verdict = 'inactive';
      else if (!enoughHistory) verdict = 'nodata';
      else if (daily <= 0) verdict = 'nosale';
      else if (coverDays != null && coverDays < lead + safety) {
        verdict = q.china > 0 ? 'inbound' : 'order';
      }

      return { sku, q, daily, avg7, avg28, coverDays, lead, measuredLead, safety, need, moq, verdict, pipeline };
    });

    renderStock();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="9" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const STOCK_VERDICT = {
  order:    { label: '발주 필요',   cls: 'warn' },
  inbound:  { label: '입고요청',    cls: 'mid' },
  ok:       { label: '정상',        cls: 'dim' },
  nosale:   { label: '판매 없음',   cls: 'dim' },
  nodata:   { label: '데이터 부족', cls: 'dim' },
  inactive: { label: '판매중지',    cls: 'dim' }
};

function renderStock() {
  const f = $('#stockFilter').value;
  const q = ($('#stockSearch').value || '').trim().toLowerCase();

  const rows = STOCK.rows.filter((r) => {
    if (q) {
      const hay = `${r.sku.sku_name} ${r.sku.barcode || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f === 'action') return r.verdict === 'order' || r.verdict === 'inbound';
    if (f === 'order') return r.verdict === 'order';
    if (f === 'inbound') return r.verdict === 'inbound';
    return true;
  }).sort((a, b) => {
    const rank = (x) => ({ order: 0, inbound: 1, ok: 2 }[x.verdict] ?? 3);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.coverDays ?? 9999) - (b.coverDays ?? 9999);
  });

  const nOrder = STOCK.rows.filter((r) => r.verdict === 'order').length;
  const nInbound = STOCK.rows.filter((r) => r.verdict === 'inbound').length;
  $('#stockSummary').textContent =
    `발주 필요 ${nOrder} · 입고요청 ${nInbound} · 전체 SKU ${STOCK.rows.length}`;
  $('#stockNote').textContent =
    `일평균 = 최근 7일 평균×0.6 + 최근 ${STOCK.defaults.historyDays}일 평균×0.4 · ` +
    `재주문점 = 일평균×(리드타임+안전 ${STOCK.defaults.safetyDays}일) · ` +
    `권장 수량 = 일평균×(리드타임+안전+보충 ${STOCK.defaults.reviewCycle}일) − 이미 가진 물량, MOQ 이상 올림`;

  $('#stockRows').innerHTML = rows.length ? rows.map((r) => {
    const v = STOCK_VERDICT[r.verdict] || STOCK_VERDICT.ok;
    const cover = r.coverDays == null ? '—'
      : (r.coverDays < 999 ? `${Math.floor(r.coverDays)}일` : '—');
    const leadTxt = `${r.lead}일` + (r.measuredLead != null && num(r.sku.lead_time_days) == null
      ? '<span class="sku-name-sub">실측</span>' : '');
    return `<tr>
      <td>${esc(r.sku.sku_name)}<span class="sku-name-sub">${esc(r.sku.barcode || '바코드 없음')}</span></td>
      <td class="col-num">${r.q.coupang || '—'}</td>
      <td class="col-num">${r.q.transit || '—'}</td>
      <td class="col-num">${r.q.china || '—'}</td>
      <td class="col-num">${r.daily > 0 ? r.daily.toFixed(1) : '—'}</td>
      <td class="col-num ${r.verdict === 'order' || r.verdict === 'inbound' ? 'warn-txt' : ''}">${cover}</td>
      <td class="col-num">${leadTxt}</td>
      <td><span class="prog prog-${v.cls}">${esc(v.label)}</span></td>
      <td class="col-num">${(r.verdict === 'order' || r.verdict === 'inbound') && r.need > 0
          ? `<b>${r.need.toLocaleString()}</b>${r.need === r.moq ? '<span class="sku-name-sub">MOQ</span>' : ''}`
          : '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="muted">해당하는 SKU가 없습니다.</td></tr>';
}
$('#stockFilter').onchange = () => renderStock();
$('#stockSearch').oninput = () => renderStock();

/* ===================== 배대지(제트) 작업비 청구서 파서 =====================
   구매대행 청구서(PDF)와 완전히 다른 문서다. **어떤 상품이 몇 개인지가 아예 없고**
   작업 항목별 단가·건수·금액과 총액만 있다. 그래서 여기서 읽는 건 검산용 총액뿐이고,
   상품별 배분은 화면에서 SKU 기본 작업비로 계산한 값을 쓴다(사용자와 확인, 2026-08-18).

   실제 구조(2026-07-31 청구서 기준, 0-based 열):
     3열=단가, 4열=건수, 5열=청구금액
     "입고분류/검수/포장"  200원 x 447건 = 89,400원
     "바코드작업/원산지작업" 100원 x 894건 = 89,400원
     ...
     "청구 금액 합계"  178,800
     "부가세"           17,880
     "총 금액 합계"    196,680

   **빈 칸이 null이 아니라 공백 두 개('  ')나 '-'로 오는 칸이 많다** — 숫자인지부터
   확인해야 한다. 항목 행은 "단가·건수·금액이 모두 숫자이고 금액이 0보다 큰" 것만 고른다
   (금액 0인 행은 요금표에만 있고 이번에 청구되지 않은 항목이다). */
function parseZetInvoice(rows) {
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, '');

  let totalKrw = null, vatKrw = null, grandTotalKrw = null, rateNote = null;
  const items = [];

  (rows || []).forEach((r) => {
    if (!Array.isArray(r)) return;
    const label = norm(r[0]);
    const amount = r.find((c, i) => i >= 5 && isNum(c));

    if (label === '청구금액합계' && isNum(amount)) totalKrw = amount;
    else if (label === '부가세' && isNum(amount)) vatKrw = amount;
    else if (label === '총금액합계' && isNum(amount)) grandTotalKrw = amount;

    /* 구매대행 환율이 비고란에 문장으로 적혀 있다("... x 270 일괄적용").
       계산에 쓰진 않지만 화면에 보여주면 환율이 바뀐 걸 눈치챌 수 있다. */
    if (!rateNote) {
      const joined = r.map((c) => (c == null ? '' : String(c))).join(' ');
      const m = joined.match(/x\s*(\d{2,4})\s*일괄적용/);
      if (m) rateNote = { rate: Number(m[1]), text: joined.trim() };
    }

    if (isNum(r[3]) && isNum(r[4]) && isNum(r[5]) && r[5] > 0) {
      items.push({ name: String(r[1] || r[0] || '').trim(), unit: r[3], count: r[4], amount: r[5] });
    }
  });

  const itemSum = items.reduce((a, x) => a + x.amount, 0);
  return {
    totalKrw, vatKrw, grandTotalKrw, items, rateNote, itemSum,
    /* 항목 합과 "청구 금액 합계"가 다르면 우리가 못 읽은 항목이 있다는 뜻이다 */
    itemMismatch: (totalKrw != null && Math.abs(itemSum - totalKrw) > 1) ? itemSum - totalKrw : 0,
    error: totalKrw == null ? '청구 금액 합계를 찾지 못했습니다.' : null
  };
}
