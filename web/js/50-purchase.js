/* ============================================================
   50-purchase.js — 발주 · 예치금
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 발주 =====================
   원가가 태어나는 화면. 청구서를 인식해서 purchase_orders / purchase_order_lines /
   inventory_lots 세 테이블을 한 번에 만든다(db/migrations/016).

   저장 전 사람 확인 단계를 반드시 거친다 — 인식이 틀린 채로 저장되면 원가가 조용히
   어긋나고, 원가는 이 시스템 전체 이익 계산의 바닥이라 뒤늦게 발견하기 가장 어렵다. */
const PO = { list: [], parsed: null, skuByBarcode: new Map() };

async function loadPOs() {
  const el = $('#poRows');
  el.innerHTML = '<tr><td colspan="10" class="muted">불러오는 중…</td></tr>';
  try {
    const [orders, lines, skus, lots] = await Promise.all([
      apiAll('purchase_orders?select=*&order=requested_at.desc'),
      apiAll('purchase_order_lines?select=id,po_id,qty,line_cost_cny,line_cost_krw,sku_id'),
      /* 청구서의 바코드로 SKU를 찾기 위한 색인. 상품원장 탭을 안 거쳐도 발주가
         동작해야 하므로 여기서 따로 읽는다(두 탭이 서로를 전제하지 않게). */
      apiAll('my_skus?select=id,sku_name,barcode'),
      /* 로트 수를 목록에 같이 보여준다 — 청구서를 저장했는데 원가가 실제로 상품에
         붙었는지를 화면에서 바로 확인할 수 있어야 한다(로트가 0이면 원가가 떠 있는 상태). */
      apiAll('inventory_lots?select=po_line_id&po_line_id=not.is.null')
    ]);
    const lotLineIds = new Set(lots.map((l) => l.po_line_id));
    PO.skuByBarcode = new Map(
      skus.filter((s) => s.barcode).map((s) => [String(s.barcode), { sku: s }])
    );
    PO.allSkus = skus;   // 수동 연결(발주 상세)에서 고를 후보
    const empty = () => ({ n: 0, qty: 0, cny: 0, krw: 0, unmatched: 0, lots: 0 });
    const byPo = new Map();
    lines.forEach((l) => {
      const a = byPo.get(l.po_id) || empty();
      a.n++; a.qty += l.qty || 0;
      a.cny += Number(l.line_cost_cny) || 0;
      a.krw += Number(l.line_cost_krw) || 0;
      if (!l.sku_id) a.unmatched++;
      if (lotLineIds.has(l.id)) a.lots++;
      byPo.set(l.po_id, a);
    });
    PO.list = orders.map((o) => ({ o, agg: byPo.get(o.id) || empty() }));
    renderPOs();
  } catch (e) {
    el.innerHTML = `<tr><td colspan="10" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

/* 발주 진행 단계 — 사용자가 정해준 업무 순서 중 **발주 전체가 함께 움직이는 구간**만.
   순서 자체가 의미를 가지므로 바꾸지 말 것.

   왜 "작업비 청구 / 쿠팡 출고중 / 쿠팡센터 도착"이 여기 없나(2026-08-18 재설계):
   한 발주를 나눠서 한국에 보낼 수 있고(부분 출고), 제트 작업비 청구서는 여러 발주를
   가로질러 묶여서 온다("28일 주문분 + 29일 주문분을 묶어서, 없는 건 빼고"). 그래서
   그 세 단계는 발주 단위로는 참도 거짓도 아니다 — **출고 묶음(inbound_shipments)**
   단위로 따로 관리한다. 발주 화면에서는 "얼마나 나갔나"를 수량으로 보여준다.

   재고 수량도 더 이상 이 단계에서 파생시키지 않는다(예전엔 그랬음) — 부분 출고를
   지원하는 순간 "발주 전량이 같이 움직인다"는 전제가 깨지기 때문. */
const PO_STEPS = [
  { code: 'invoiced',    label: '청구서 수령' },
  { code: 'paid',        label: '결제완료' },
  { code: 'shipping_cn', label: '중국배대지 배송중' },
  { code: 'arrived_cn',  label: '중국배대지 도착' }
];
const PO_STEP_INDEX = new Map(PO_STEPS.map((s, i) => [s.code, i]));

/* 016 주석에 적어둔 옛 코드들 — 실제로 쓰인 적은 'invoiced'뿐이지만,
   과거 행이 남아 있어도 화면이 안 깨지도록 라벨만 남겨둔다. */
const PO_STATUS_LABEL = Object.assign(
  { requested: '요청', ordered: '발주', arrived_china: '중국배대지 도착',
    inbound_requested: '쿠팡 출고중', received: '쿠팡센터 도착', cancelled: '취소' },
  Object.fromEntries(PO_STEPS.map((s) => [s.code, s.label]))
);

function renderPOs() {
  const rows = PO.list;
  const totalKrw = rows.reduce((a, r) => a + r.agg.krw, 0);
  $('#poSummary').textContent = rows.length
    ? `발주 ${rows.length}건 · 누적 매입원가 ${Math.round(totalKrw).toLocaleString()}원`
    : '아직 등록된 발주가 없습니다. "청구서 넣기"로 시작하세요.';

  if (!rows.length) { $('#poRows').innerHTML = ''; return; }

  $('#poRows').innerHTML = rows.map((r) => {
    const o = r.o;
    const unmatched = r.agg.unmatched;
    return `<tr class="prow" data-po="${esc(o.id)}">
      <td>${esc((o.requested_at || '').slice(0, 10))}</td>
      <td>${esc(PO_STATUS_LABEL[o.status] || o.status)}</td>
      <td class="col-num">${r.agg.n}${unmatched ? ` <span class="muted">(미매칭 ${unmatched})</span>` : ''}</td>
      <td class="col-num">${r.agg.lots === r.agg.n && r.agg.n
          ? r.agg.lots
          : `<span class="warn-txt">${r.agg.lots}</span>`}</td>
      <td class="col-num">${cnt(r.agg.qty)}</td>
      <td class="col-num">${r.agg.cny ? r.agg.cny.toFixed(2) : '—'}</td>
      <td class="col-num">${o.rate_purchase == null ? '—' : Number(o.rate_purchase).toFixed(2)}</td>
      <td class="col-num">${won(Math.round(r.agg.krw))}</td>
      <td>${o.confirmed_by_user ? '확인됨' : '<span class="muted">미확인</span>'}</td>
      <td>${poPayCellHtml(o)}</td>
    </tr>`;
  }).join('');
}

/* ── 발주 상세 : 청구서 줄에 SKU 붙이기 ─────────────────────────
   왜 필요한가: 청구서의 바코드로 SKU를 자동 매칭하지만, 바코드를 안 넣고 발주한
   건(과거 청구서는 전부 NOBARCODE)은 매칭이 안 된다. 그러면 원가가 어느 상품
   것인지 이어지지 않아 그 줄은 죽은 데이터가 된다 — 여기서 손으로 붙인다.

   **로트는 SKU가 붙는 순간 만들어진다.** 청구서 저장 시점엔 매칭된 줄만 로트를
   만들었으므로, 여기서 뒤늦게 붙인 줄도 같은 규칙으로 로트를 만들어줘야
   선입선출 대기열에 들어간다. 이미 로트가 있는 줄은 건드리지 않는다(중복 방지). */
const POD = { poId: null, po: null, lines: [], lots: [], lotByLine: new Map(),
              picks: new Map(), bcEdits: new Map() };

/* 한글 상품명 비교는 단어 단위로는 잘 안 맞는다("도시락 말랑이" vs
   "덴넬 버터 스틱 말랑이 슬라임 스퀴시, 노랑 100g 2개"). 글자 2개씩 겹치는
   비율(Dice 계수)로 보면 표기가 달라도 같은 상품을 꽤 잘 찾아낸다. */
function bigramSet(s) {
  const t = String(s || '').replace(/[\s,·\-_()]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function diceScore(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach((g) => { if (b.has(g)) hit++; });
  return (2 * hit) / (a.size + b.size);
}
function suggestSkus(name, skus, limit) {
  const q = bigramSet(name);
  return skus
    .map((s) => ({ s, score: diceScore(q, bigramSet(s.sku_name)) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3);
}

/* 줄(=SKU) 단위 진행 상태. **발주 단계와 별개다.**
   한 발주 안에서도 어떤 SKU는 이미 쿠팡에 있고 어떤 건 아직 중국에 있을 수 있다
   (부분 출고 + 1688에서 일부만 먼저 도착하는 경우, 사용자 확인 2026-08-18).
   그래서 상태를 따로 저장하지 않고 **로트 수량에서 파생**시킨다 —
   저장된 상태와 실제 수량이 어긋날 일이 원천적으로 없다. */
function lineProgress(lots) {
  if (!lots.length) return { code: 'nolot', label: '미연결', cls: 'warn' };
  const n = (k) => lots.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const cn = n('qty_china'), tr = n('qty_transit'), cp = n('qty_coupang');
  if (cn + tr + cp === 0) return { code: 'empty', label: '재고 없음', cls: 'dim' };
  const places = [cn > 0, tr > 0, cp > 0].filter(Boolean).length;
  if (places > 1) return { code: 'partial', label: '일부 출고', cls: 'mid' };
  if (cn > 0) return { code: 'china', label: '중국창고', cls: 'dim' };
  if (tr > 0) return { code: 'transit', label: '쿠팡 출고중', cls: 'mid' };
  return { code: 'coupang', label: '쿠팡센터', cls: 'ok' };
}

async function openPoDetail(poId) {
  const entry = PO.list.find((r) => r.o.id === poId);
  if (!entry) return;
  POD.poId = poId;
  POD.po = entry.o;
  POD.picks = new Map();
  POD.bcEdits = new Map();
  
  $('#poDetailMsg').className = 'msg hidden';
  $('#poDetailTitle').textContent = `발주 상세 — ${(entry.o.requested_at || '').slice(0, 10)}`;
  $('#poDetailRows').innerHTML = '<tr><td colspan="6" class="muted">불러오는 중…</td></tr>';
  $('#poDetailModal').classList.remove('hidden');

  try {
    const [lines, lots] = await Promise.all([
      apiAll(`purchase_order_lines?select=*&po_id=eq.${encodeURIComponent(poId)}&order=line_no.asc`),
      /* 로트를 수량까지 통째로 읽는다 — 창고/운송중/쿠팡이 각각 몇 개인지
         화면에 보여줘야 부분 출고 뒤에도 상황이 파악된다. */
      apiAll('inventory_lots?select=*&po_line_id=not.is.null')
    ]);
    POD.lines = lines;
    POD.lots = lots.filter((lot) => lines.some((l) => l.id === lot.po_line_id));
    POD.lotByLine = new Map();
    POD.lots.forEach((lot) => {
      const arr = POD.lotByLine.get(lot.po_line_id) || [];
      arr.push(lot);
      POD.lotByLine.set(lot.po_line_id, arr);
    });

    /* 후보 목록은 datalist로 준다 — SKU가 수천 개가 돼도 브라우저가 알아서 걸러준다.
       select 태그였다면 수천 개 option을 그리느라 느려진다. */
    $('#skuPickList').innerHTML = (PO.allSkus || [])
      .map((s) => `<option value="${esc(skuPickLabel(s))}"></option>`).join('');

    renderPoDetail();
  } catch (e) {
    $('#poDetailRows').innerHTML = `<tr><td colspan="6" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

const skuPickLabel = (s) => `${s.sku_name} [${s.barcode || '바코드없음'}]`;

function renderPoDetail() {
  const po = POD.po;
  const rate = Number(po.rate_purchase) || 0;
  const skus = PO.allSkus || [];
  const byId = new Map(skus.map((s) => [s.id, s]));

  /* 아직 저장 안 한 선택(picks)도 반영해서 센다 — 안 그러면 화면에서 고르는데도
     "미연결 2/3"이 안 줄어들어서 반영이 안 된 것처럼 보인다. */
  const pickedOf = (l) => (POD.picks.has(String(l.id)) ? POD.picks.get(String(l.id)) : l.sku_id);
  const bcOf = (l) => (POD.bcEdits.has(String(l.id)) ? POD.bcEdits.get(String(l.id)) : l.barcode_text);
  const unmatched = POD.lines.filter((l) => !pickedOf(l)).length;
  $('#poDetailRo').innerHTML = [
    ['상태', PO_STATUS_LABEL[po.status] || po.status],
    ['환율', rate ? rate.toFixed(2) : '—'],
    ['합계(CNY)', po.total_cny != null ? Number(po.total_cny).toFixed(2) : '—'],
    ['미연결 줄', `${unmatched} / ${POD.lines.length}`]
  ].map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');

  /* 진행 단계 — 누르면 그 단계로 바꾼다. 되돌리기도 되게 했다(잘못 눌렀을 때
     방법이 없으면 안 되고, 수량은 단계에서 파생되므로 되돌려도 어긋나지 않는다). */
  const curIdx = PO_STEP_INDEX.has(po.status) ? PO_STEP_INDEX.get(po.status) : -1;
  $('#poSteps').innerHTML = PO_STEPS.map((s, i) => {
    const cls = i < curIdx ? 'done' : (i === curIdx ? 'now' : '');
    return `<button class="po-step ${cls}" data-step="${s.code}">
      <b>${i + 1}</b><span>${esc(s.label)}</span></button>`;
  }).join('');

  $('#poDetailHint').textContent = unmatched
    ? '연결할 SKU를 고르면 저장할 때 그 줄의 재고 로트가 만들어집니다. 상품명이 비슷한 후보를 아래에 추천해뒀습니다.'
    : '모든 줄이 SKU에 연결돼 있습니다.';

  $('#poDetailRows').innerHTML = POD.lines.map((l) => {
    /* picks의 키는 DOM dataset에서 와서 항상 문자열이고 l.id는 숫자다 —
       String()으로 맞추지 않으면 고른 값이 조용히 무시된다(2026-08-18에 실제로 겪음). */
    const picked = pickedOf(l);
    const cur = picked ? byId.get(picked) : null;
    const lots = POD.lotByLine.get(l.id) || [];
    const hasLot = lots.length > 0;
    const sum = (k) => lots.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const prog = lineProgress(lots);
    const unit = l.qty ? Math.round((l.line_cost_krw || 0) / l.qty) : 0;

    let cell;
    if (cur) {
      cell = `<div class="pick-on">
          <span>${esc(cur.sku_name)}</span>
          ${hasLot ? '<span class="muted sm">로트 생성됨</span>'
                   : '<button class="btn btn-sm btn-ghost pick-clear" data-line="' + esc(l.id) + '">해제</button>'}
        </div>`;
    } else {
      const sugg = suggestSkus(l.product_name_text, skus, 3);
      cell = `<div class="pick-off">
          <input class="pick-input" list="skuPickList" data-line="${esc(l.id)}" placeholder="SKU 검색…" />
          ${sugg.length ? '<div class="pick-sugg">' + sugg.map((x) =>
            `<button class="chip-btn pick-sugg-btn" data-line="${esc(l.id)}" data-sku="${esc(x.s.id)}"
               title="유사도 ${(x.score * 100).toFixed(0)}%">${esc(x.s.sku_name)}</button>`).join('') + '</div>' : ''}
        </div>`;
    }

    /* 바코드를 고칠 수 있게 한다 — 쿠플러스에 바코드를 안 넣고 발주한 건은 여기서
       나중에 채워 넣는 게 가장 자연스럽다. 고치면 그 바코드로 SKU를 찾아보고,
       있으면 자동 연결하고 없으면 원래처럼 검색·추천이 뜬다.
       청구서 원문은 purchase_order_lines.raw_line(jsonb)에 그대로 남아 있으므로
       이 칸을 고쳐도 원본을 잃지 않는다. */
    const bc = bcOf(l);
    return `<tr>
      <td><input class="bc-input" data-line="${esc(l.id)}" value="${esc(bc || '')}"
                 placeholder="바코드 없음" /></td>
      <td>${esc(l.product_name_text)}</td>
      <td class="col-num">${cnt(l.qty)}</td>
      <td class="col-num">${hasLot
          ? `<span class="prog prog-${prog.cls}">${esc(prog.label)}</span>
             <span class="prog-qty">${sum('qty_china')} · ${sum('qty_transit')} · ${sum('qty_coupang')}</span>`
          : `<span class="prog prog-${prog.cls}">${esc(prog.label)}</span>`}</td>
      <td class="col-num">${unit ? unit.toLocaleString() + '원' : '—'}</td>
      <td>${cell}</td>
    </tr>`;
  }).join('');
}

/* SKU를 고르면 왼쪽 바코드 칸도 그 SKU의 바코드로 맞춰준다(사용자 요청 2026-08-18) —
   둘이 다른 채로 저장되면 나중에 "이 줄이 왜 이 상품에 붙었지"를 추적할 수 없다.
   SKU에 바코드가 없으면(드묾) 기존 값을 지우지 않는다 — 있는 정보를 없애는 쪽이 더 나쁘다. */
function podPick(lineId, skuId) {
  POD.picks.set(lineId, skuId);
  const sku = (PO.allSkus || []).find((s) => s.id === skuId);
  if (sku && sku.barcode) POD.bcEdits.set(lineId, String(sku.barcode));
  renderPoDetail();
}

$('#poDetailRows').addEventListener('click', (ev) => {
  const sug = ev.target.closest('.pick-sugg-btn');
  if (sug) { podPick(sug.dataset.line, sug.dataset.sku); return; }
  const clr = ev.target.closest('.pick-clear');
  if (clr) { POD.picks.set(clr.dataset.line, null); renderPoDetail(); }
});
$('#poDetailRows').addEventListener('change', (ev) => {
  const inp = ev.target.closest('.pick-input');
  if (inp) {
    const hit = (PO.allSkus || []).find((s) => skuPickLabel(s) === inp.value);
    if (hit) podPick(inp.dataset.line, hit.id);
    return;
  }

  const bcInp = ev.target.closest('.bc-input');
  if (!bcInp) return;
  const lineId = bcInp.dataset.line;
  const line = POD.lines.find((l) => String(l.id) === String(lineId));
  const val = bcInp.value.trim() || null;
  POD.bcEdits.set(lineId, val);

  /* 바코드를 고치면 **먼저 그 바코드의 SKU가 있는지 본다.**
     있으면 자동으로 연결하고, 없으면 연결을 비워서 원래처럼 검색·추천이 뜨게 한다.
     단 이미 로트가 만들어진 줄은 연결을 건드리지 않는다 — 바꾸면 로트가 붕 뜬다.
     (바코드 글자 자체는 고쳐도 로트에 영향이 없으므로 수정은 허용한다) */
  if (line && !POD.lotByLine.has(line.id)) {
    const hit = val ? PO.skuByBarcode.get(String(val)) : null;
    POD.picks.set(lineId, hit ? hit.sku.id : null);
  }
  renderPoDetail();
});

$$('#poDetailModal [data-close]').forEach((b) => {
  b.onclick = () => $('#poDetailModal').classList.add('hidden');
});

/* 단계 변경은 이제 재고를 건드리지 않는다 — 재고 이동은 출고 묶음이 담당한다.
   '중국배대지 도착'만 로트에 도착 시각을 남긴다(리드타임 실측에 쓸 값이다). */
$('#poSteps').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.po-step');
  if (!btn || !POD.po) return;
  const code = btn.dataset.step;
  if (code === POD.po.status) return;

  const msg = $('#poDetailMsg');
  $$('#poSteps .po-step').forEach((b) => { b.disabled = true; });
  try {
    await api(`purchase_orders?id=eq.${encodeURIComponent(POD.po.id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: code }
    });
    POD.po.status = code;

    if (code === 'arrived_cn') {
      const now = new Date().toISOString();
      for (const lot of POD.lots.filter((l) => !l.arrived_china_at)) {
        await api(`inventory_lots?id=eq.${lot.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: { arrived_china_at: now }
        });
        lot.arrived_china_at = now;
      }
    }
    renderPoDetail();
    toast(`단계 변경 — ${PO_STATUS_LABEL[code] || code}`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '단계 변경 실패: ' + e.message;
  } finally {
    $$('#poSteps .po-step').forEach((b) => { b.disabled = false; });
  }
});

$('#poDetailSave').onclick = async () => {
  const btn = $('#poDetailSave');
  const msg = $('#poDetailMsg');
  /* 연결과 바코드를 따로 저장하지 않는다 — 한 줄에 둘 다 바뀌었으면 PATCH 한 번으로 끝낸다 */
  const touched = new Set([...POD.picks.keys(), ...POD.bcEdits.keys()]);
  const changes = Array.from(touched).map((lineId) => {
    const line = POD.lines.find((l) => String(l.id) === String(lineId));
    if (!line) return null;
    const skuId = POD.picks.has(lineId) ? POD.picks.get(lineId) : line.sku_id;
    const bc = POD.bcEdits.has(lineId) ? POD.bcEdits.get(lineId) : line.barcode_text;
    const patch = {};
    if ((line.sku_id || null) !== (skuId || null)) patch.sku_id = skuId;
    if ((line.barcode_text || null) !== (bc || null)) patch.barcode_text = bc;
    return Object.keys(patch).length ? { line, skuId, patch } : null;
  }).filter(Boolean);

  if (!changes.length) { msg.className = 'msg'; msg.textContent = '바뀐 내용이 없습니다.'; return; }

  btn.disabled = true;
  try {
    const rate = Number(POD.po.rate_purchase) || 0;
    let lotsMade = 0;
    for (const { line, skuId, patch } of changes) {
      await api(`purchase_order_lines?id=eq.${encodeURIComponent(line.id)}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: patch
      });
      Object.assign(line, patch);

      /* 021부터 로트는 SKU 없이도 만들어져 있다 — 그러면 **새로 만드는 게 아니라
         기존 로트에 sku_id를 채운다.** 새로 만들면 같은 물건이 두 번 잡힌다.
         (021 이전에 만들어진 발주엔 로트가 아예 없을 수 있어서 생성 경로도 남겨둔다) */
      if (skuId && POD.lotByLine.has(line.id)) {
        for (const lot of POD.lotByLine.get(line.id)) {
          if (!lot.id || lot.sku_id) continue;
          await api(`inventory_lots?id=eq.${lot.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: { sku_id: skuId }
          });
          lot.sku_id = skuId;
        }
      } else if (skuId && !POD.lotByLine.has(line.id)) {
        await api('inventory_lots', {
          method: 'POST', headers: { prefer: 'return=minimal' },
          body: [{
            sku_id: skuId,
            po_line_id: line.id,
            qty_ordered: line.qty,
            qty_china: 0,      // 아직 중국 창고에 없다 (020 참조)
            qty_arrived: 0,
            unit_cost_krw: line.qty ? Math.round((line.line_cost_krw / line.qty) * 100) / 100 : 0,
            unit_purchase_cost_krw: line.qty ? Math.round((line.line_cost_krw / line.qty) * 100) / 100 : 0,
            unit_work_fee_krw: 0,     // 배대지 작업비는 출고할 때 확정된다
            cost_status: 'estimated',
            cost_breakdown: {
              cny_line: line.line_cost_cny,
              cny_unit: line.unit_price_cny,
              cny_shipping_alloc: line.allocated_shipping_cny,
              rate_purchase: rate,
              linked_manually: true      // 바코드가 아니라 사람이 붙인 연결임을 남긴다
            },
            ordered_at: POD.po.requested_at
          }]
        });
        POD.lotByLine.set(line.id, [{ po_line_id: line.id, qty_china: line.qty }]);
        lotsMade++;
      }
    }
    POD.picks = new Map();
    POD.bcEdits = new Map();
    renderPoDetail();
    toast(`${changes.length}줄 저장 · 로트 ${lotsMade}개 생성`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

$('#poRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-po]');
  if (tr) openPoDetail(tr.dataset.po);
});

/* 결제완료 버튼 — 누르면 결제 시각을 남기고 **바로 "중국배대지 배송중"으로 넘긴다**
   (사용자 요청 2026-08-18). 결제하면 쿠플러스가 1688에 주문을 넣고 물건이 움직이기
   시작하므로, "결제완료"에 머무는 시간이 실무에 사실상 없다. 그래서 단계를 하나
   건너뛰는 게 아니라, 결제라는 사건이 곧 배송 시작이라는 뜻이다.
   paid_at은 따로 남기므로 "언제 결제했나"는 잃지 않는다. */
function poPayCellHtml(o) {
  const idx = PO_STEP_INDEX.has(o.status) ? PO_STEP_INDEX.get(o.status) : -1;
  if (o.status === 'cancelled') return '';
  if (idx <= PO_STEP_INDEX.get('invoiced')) {
    return `<button class="btn btn-sm btn-primary po-pay" data-po="${esc(o.id)}">결제완료</button>`;
  }
  return o.paid_at
    ? `<span class="muted sm">결제 ${esc(String(o.paid_at).slice(0, 10))}</span>`
    : '';
}

$('#poRows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.po-pay');
  if (!btn) return;
  ev.stopPropagation();          // 행 클릭(상세 열기)과 겹치지 않게
  btn.disabled = true;
  try {
    const now = new Date().toISOString();
    await api(`purchase_orders?id=eq.${encodeURIComponent(btn.dataset.po)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { status: 'shipping_cn', paid_at: now }
    });
    toast('결제완료 — 중국배대지 배송중으로 넘겼습니다');
    loadPOs();
  } catch (e) {
    toast('실패: ' + e.message, 4000);
    btn.disabled = false;
  }
});

function poOpenModal() {
  PO.parsed = null;
  $('#poStep1').classList.remove('hidden');
  $('#poStep2').classList.add('hidden');
  $('#poSave').classList.add('hidden');
  $('#poBack').classList.add('hidden');
  $('#poMsg').className = 'msg hidden';
  $('#poText').value = '';
  $('#poModal').classList.remove('hidden');
}
function poCloseModal() { $('#poModal').classList.add('hidden'); }

$('#poNewBtn').onclick = poOpenModal;
$$('#poModal [data-close]').forEach((b) => { b.onclick = poCloseModal; });
$('#poBack').onclick = () => {
  $('#poStep1').classList.remove('hidden');
  $('#poStep2').classList.add('hidden');
  $('#poSave').classList.add('hidden');
  $('#poBack').classList.add('hidden');
};

$('#poDrop').onclick = () => $('#poFile').click();
$('#poDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('#poDrop').classList.add('over'); });
$('#poDrop').addEventListener('dragleave', () => $('#poDrop').classList.remove('over'));
$('#poDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#poDrop').classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) poHandleFile(f);
});
$('#poFile').onchange = (e) => { const f = e.target.files[0]; if (f) poHandleFile(f); };
$('#poParseText').onclick = () => poShowParsed(parseCouplusInvoice($('#poText').value), null);

/* PDF에서 텍스트를 뽑는 일만 서버리스 함수에 맡긴다(브라우저에 PDF 라이브러리를
   넣지 않기 위함 — 프론트엔드 무의존 원칙, web/CLAUDE.md).
   텍스트→줄 구조 변환은 브라우저에서 한다: 로직이 한 곳에 있고 테스트가 쉽다. */
async function poHandleFile(file) {
  const msg = $('#poMsg');
  msg.className = 'msg';
  msg.textContent = 'PDF 읽는 중…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/parse-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: buf
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    msg.className = 'msg hidden';
    PO.method = d.method || null;
    poShowParsed(parseCouplusInvoice(d.text), d.text);
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = 'PDF 인식 실패: ' + e.message +
      ' — 아래 "텍스트로 직접 붙여넣기"를 쓰시면 됩니다.';
  }
}

function poShowParsed(parsed, rawText) {
  if (parsed.error || !parsed.rows.length) {
    const msg = $('#poMsg');
    msg.className = 'msg err';
    msg.textContent = parsed.error || '인식된 줄이 없습니다.';
    return;
  }
  PO.parsed = parsed;
  PO.rawText = rawText || $('#poText').value || null;

  $('#poDate').value = parsed.date || '';
  $('#poRate').value = parsed.totals.rate || '';
  $('#poTotalCny').value = parsed.totals.sumCny ? parsed.totals.sumCny.toFixed(2) : '';
  $('#poTotalKrw').value = parsed.totals.totalKrw || '';
  $('#poRateNote').textContent = parsed.totals.rate
    ? `환율은 청구서에 안 적혀 있어 합계로 역산했습니다 (${parsed.totals.totalKrw.toLocaleString()}원 ÷ ${parsed.totals.sumCny.toFixed(2)} CNY). 다르면 직접 고치세요.`
    : '환율을 역산할 수 없었습니다 — 직접 입력하세요.';

  $('#poRaw').value = PO.rawText || '';
  $('#poMethod').textContent = PO.method
    ? (PO.method === 'position' ? '(좌표 기반 추출)' : '(기본 추출 — 공백이 뭉개졌을 수 있음)')
    : '';

  poRenderLines();
  $('#poStep1').classList.add('hidden');
  $('#poStep2').classList.remove('hidden');
  $('#poSave').classList.remove('hidden');
  $('#poBack').classList.remove('hidden');
}

function poRenderLines() {
  const rate = Number($('#poRate').value) || 0;
  const bc = PO.skuByBarcode;
  let unmatched = 0;

  $('#poLineRows').innerHTML = PO.parsed.rows.map((l, i) => {
    const hit = l.barcode ? bc.get(String(l.barcode)) : null;
    if (!hit) unmatched++;
    const unitKrw = l.qty ? (l.lineCny / l.qty) * rate : 0;
    return `<tr data-i="${i}">
      <td class="sku-bc">${l.barcode ? esc(l.barcode) : '<span class="muted">없음</span>'}</td>
      <td>${esc(l.name)}</td>
      <td>${hit ? esc(hit.sku.sku_name) : '<span class="warn-txt">매칭 안 됨</span>'}</td>
      <td class="col-num">${cnt(l.qty)}</td>
      <td class="col-num">${l.unitCny == null ? '—' : l.unitCny}</td>
      <td class="col-num">${l.allocShipCny ? l.allocShipCny.toFixed(2) : '0'}</td>
      <td class="col-num">${rate ? Math.round(unitKrw).toLocaleString() + '원' : '—'}</td>
    </tr>`;
  }).join('');

  const notes = [];
  /* 숫자 개수가 7(그룹 머리)·3(구성원)·1(수량만) 중 어느 것도 아니면 텍스트 추출이
     깨졌을 가능성이 크다 — 2026-08-18에 pdf-parse 기본 추출기가 칸 사이 공백을
     버려서 "세알2069.8129.868128" 같은 토큰이 만들어진 적이 있다. 그때 화면엔
     아무 경고도 안 떠서 사용자가 눈으로 보고서야 알았다. 다시는 조용히 넘어가지 않게 한다. */
  const odd = PO.parsed.rows.filter((l) =>
    ![1, 3, 7].includes(l.raw.length) ||
    /* 수량은 반드시 양의 정수다. 소수가 나왔다면 두 칸이 붙어버린 것
       (실제 사례: "16 5.7"이 "165.7"로 붙어 수량 14196.4가 만들어졌다). */
    !Number.isInteger(l.qty) || l.qty <= 0
  ).length;
  if (odd) {
    notes.push(`숫자 구조가 예상과 다른 줄 ${odd}개 — PDF 텍스트 추출이 깨졌을 수 있습니다. ` +
      '아래 "인식된 원문 보기"에서 칸이 공백으로 제대로 나뉘었는지 확인하세요.');
  }
  if (unmatched) notes.push(`바코드로 SKU를 못 찾은 줄 ${unmatched}개 — 그대로 저장하면 원가가 어느 상품 것인지 이어지지 않습니다.`);
  PO.parsed.groups.forEach((g, i) => {
    if (g.leftover) {
      notes.push(`${i + 1}번 묶음: 어느 총금액과도 맞아떨어지지 않은 줄이 ${g.lines.length}개 남았습니다 — 배송비 배분이 안 된 상태입니다.`);
    } else if (g.diffCny != null && Math.abs(g.diffCny) > 0.05) {
      notes.push(`${i + 1}번 묶음 합계가 청구서와 ${g.diffCny > 0 ? '+' : ''}${g.diffCny} CNY 차이납니다.`);
    }
  });
  if (PO.parsed.unusedMarkers > 0) {
    notes.push(`쓰이지 못한 묶음 총금액이 ${PO.parsed.unusedMarkers}개 있습니다 — 줄을 일부 못 읽었을 수 있습니다.`);
  }
  const w = $('#poWarn');
  if (notes.length) { w.className = 'msg err'; w.innerHTML = notes.map(esc).join('<br>'); }
  else { w.className = 'msg hidden'; }
}
$('#poRate').oninput = () => { if (PO.parsed) poRenderLines(); };

$('#poSave').onclick = async () => {
  if (!PO.parsed) return;
  const btn = $('#poSave');
  const msg = $('#poMsg');
  const rate = Number($('#poRate').value) || null;
  if (!rate) {
    msg.className = 'msg err';
    msg.textContent = '환율이 없으면 원가를 원화로 못 만듭니다. 환율을 입력하세요.';
    return;
  }
  btn.disabled = true;
  try {
    const t = PO.parsed.totals;
    const po = (await api('purchase_orders', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: [{
        requested_at: ($('#poDate').value || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z',
        status: 'invoiced',
        rate_purchase: rate,
        rate_source: t.rate && Math.abs(t.rate - rate) < 0.01 ? 'derived_from_invoice' : 'manual',
        invoice_raw_text: PO.rawText,
        parsed_at: new Date().toISOString(),
        parse_method: 'regex',
        confirmed_by_user: true,
        total_cny: t.sumCny || null,
        total_krw: t.totalKrw || null,
        vat_krw: t.vatKrw || null,
        grand_total_krw: t.grandKrw || null
      }]
    }))[0];

    const lineBody = PO.parsed.rows.map((l, i) => {
      const hit = l.barcode ? PO.skuByBarcode.get(String(l.barcode)) : null;
      return {
        po_id: po.id,
        line_no: i + 1,
        sku_id: hit ? hit.sku.id : null,
        barcode_text: l.barcode,
        product_name_text: l.name,
        qty: l.qty,
        group_key: 'G' + (l.groupIndex + 1),
        unit_price_cny: l.unitCny,
        group_shipping_cny: PO.parsed.groups[l.groupIndex].shippingCny,
        group_total_cny: PO.parsed.groups[l.groupIndex].totalCny,
        allocated_shipping_cny: l.allocShipCny,
        line_cost_cny: l.lineCny,
        line_cost_krw: Math.round(l.lineCny * rate),
        raw_line: { nums: l.raw, date: l.date }
      };
    });
    const savedLines = await api('purchase_order_lines', {
      method: 'POST', headers: { prefer: 'return=representation' }, body: lineBody
    });

    /* **모든 줄에 로트를 만든다 — SKU가 아직 없어도.** (021)
       상품 등록 전에 먼저 발주하는 경우가 있어서다(사용자 확인 2026-08-18):
       물건은 실제로 중국에 도착하는데 SKU가 없다고 로트를 안 만들면 그 물건은
       시스템에 존재하지 않게 되고, 입고도 재고 확인도 못 한다.
       SKU는 나중에(쿠팡 보내기 전 바코드 작업할 때) 발주 상세에서 붙인다. */
    const lots = savedLines.map((l) => ({
      sku_id: l.sku_id || null,
      po_line_id: l.id,
      qty_ordered: l.qty,
      qty_china: 0,          // 아직 중국 창고에 없다 — 입고 페이지에서 도착 처리해야 생긴다
      qty_arrived: 0,
      unit_cost_krw: l.qty ? Math.round((l.line_cost_krw / l.qty) * 100) / 100 : 0,
      unit_purchase_cost_krw: l.qty ? Math.round((l.line_cost_krw / l.qty) * 100) / 100 : 0,
      unit_work_fee_krw: 0,
      cost_status: 'estimated',   // 배대지 작업비(개당 300원 수준)가 아직 안 붙었다
      cost_breakdown: {
        cny_line: l.line_cost_cny,
        cny_unit: l.unit_price_cny,
        cny_shipping_alloc: l.allocated_shipping_cny,
        rate_purchase: rate
      },
      ordered_at: po.requested_at
    }));
    if (lots.length) {
      await api('inventory_lots', { method: 'POST', headers: { prefer: 'return=minimal' }, body: lots });
    }

    poCloseModal();
    toast(`청구서 저장 완료 — ${savedLines.length}줄, 로트 ${lots.length}개`);
    loadPOs();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

/* ===================== 예치금 =====================
   구매대행사(쿠플러스)에 맡겨둔 돈. 발주 결제로 빠지고, 취소·불량 환불로 들어온다.

   **가장 정확한 값은 결국 사용자가 넣는 것이다**(사용자 확인 2026-08-18) —
   대행사가 잔액을 사진으로 알려주고, 예치금은 그때그때 들어온다. 그래서 시스템은
   "돌려받을 예정"까지만 자동으로 만들고, 실제 입금 확인은 사람이 한다:

     expected   시스템이 만든 환불 예정 (취소·불량)
     confirmed  실제로 들어온 걸 확인함
     void       취소를 되돌려서 무효

   추정액(estimated_amount_krw)과 인정 금액(amount_krw)을 나란히 남겨서,
   나중에 "우리 추정이 실제와 얼마나 달랐나"를 볼 수 있게 했다. */
const DEP = { rows: [] };

const DEP_TYPE_LABEL = { charge: '입금', spend: '차감', refund: '환불', balance: '잔액 확인' };
const DEP_REASON_LABEL = { cancel: '발주 취소', defect: '불량' };
const DEP_STATUS = {
  expected: { label: '확인 대기', cls: 'mid' },
  confirmed: { label: '확정', cls: 'ok' },
  void: { label: '무효', cls: 'dim' }
};

async function loadDeposits() {
  $('#depRows').innerHTML = '<tr><td colspan="8" class="muted">불러오는 중…</td></tr>';
  try {
    DEP.rows = await apiAll('supplier_deposits?select=*&order=occurred_at.desc');
    renderDeposits();
  } catch (e) {
    $('#depRows').innerHTML = `<tr><td colspan="8" class="muted">불러오기 실패: ${esc(e.message)}</td></tr>`;
  }
}

function renderDeposits() {
  const f = $('#depFilter').value;
  const rows = DEP.rows.filter((r) => {
    if (f === 'open') return r.status === 'expected';
    if (f === 'confirmed') return r.status === 'confirmed';
    if (f === 'void') return r.status === 'void';
    return true;
  });

  const sum = (pred) => DEP.rows.filter(pred).reduce((a, r) => a + (Number(r.amount_krw) || 0), 0);
  const expected = sum((r) => r.status === 'expected' && r.type === 'refund');
  const confirmedIn = sum((r) => r.status === 'confirmed' && (r.type === 'refund' || r.type === 'charge'));
  const spent = sum((r) => r.status !== 'void' && r.type === 'spend');
  /* 시스템 계산 잔액 = 확정 입금·환불 − 차감. 대행사가 알려준 실제 잔액과 나란히 보여준다. */
  const lastBalance = DEP.rows.find((r) => r.balance_manual_krw != null);

  $('#depSummary').textContent =
    `환불 예정 ${Math.round(expected).toLocaleString()}원 · ` +
    `확정 입금 ${Math.round(confirmedIn).toLocaleString()}원 · ` +
    `차감 ${Math.round(spent).toLocaleString()}원 · ` +
    `계산 잔액 ${Math.round(confirmedIn - spent).toLocaleString()}원` +
    (lastBalance ? ` · 대행사 통보 잔액 ${Math.round(lastBalance.balance_manual_krw).toLocaleString()}원 (${String(lastBalance.occurred_at).slice(0, 10)})` : '');

  $('#depNote').textContent =
    '"확인 대기"는 아직 실제로 들어온 게 아닙니다 — 대행사가 알려준 금액과 맞으면 [확정]을 누르세요. ' +
    '금액이 다르면 인정 금액을 고친 뒤 확정하면 됩니다. 추정과 인정 금액을 둘 다 남겨두니 나중에 비교할 수 있습니다.';

  $('#depRows').innerHTML = rows.length ? rows.map((r) => {
    const st = DEP_STATUS[r.status] || DEP_STATUS.expected;
    const what = [DEP_REASON_LABEL[r.reason] || '', r.memo || ''].filter(Boolean).join(' · ');
    return `<tr>
      <td>${esc(String(r.occurred_at || '').slice(0, 10))}</td>
      <td>${esc(DEP_TYPE_LABEL[r.type] || r.type)}</td>
      <td>${esc(what || '—')}${r.balance_manual_krw != null
          ? `<span class="sku-name-sub">통보 잔액 ${Math.round(r.balance_manual_krw).toLocaleString()}원</span>` : ''}</td>
      <td class="col-num">${r.qty == null ? '—' : r.qty}</td>
      <td class="col-num">${r.estimated_amount_krw == null ? '—' : Math.round(r.estimated_amount_krw).toLocaleString()}</td>
      <td class="col-num">${r.status === 'expected'
          ? `<input type="number" class="dep-amt defect-input" data-id="${esc(r.id)}" value="${Math.round(Number(r.amount_krw) || 0)}" />`
          : Math.round(Number(r.amount_krw) || 0).toLocaleString() + '원'}</td>
      <td><span class="prog prog-${st.cls}">${esc(st.label)}</span></td>
      <td>${r.status === 'expected'
          ? `<button class="btn btn-sm btn-primary dep-confirm" data-id="${esc(r.id)}">확정</button>
             <button class="btn btn-sm btn-ghost dep-void" data-id="${esc(r.id)}">무효</button>`
          : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="muted">기록이 없습니다.</td></tr>';
}
$('#depFilter').onchange = () => renderDeposits();

$('#depRows').addEventListener('click', async (ev) => {
  const conf = ev.target.closest('.dep-confirm');
  const vd = ev.target.closest('.dep-void');
  const btn = conf || vd;
  if (!btn) return;
  const id = btn.dataset.id;
  const row = DEP.rows.find((r) => String(r.id) === String(id));
  btn.disabled = true;
  try {
    const body = vd
      ? { status: 'void' }
      : {
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          /* 화면에서 고친 금액을 확정값으로 삼는다 — 추정은 estimated에 그대로 남는다 */
          amount_krw: Math.round(Number(
            (document.querySelector(`.dep-amt[data-id="${CSS.escape(id)}"]`) || {}).value
          ) || (Number(row && row.amount_krw) || 0))
        };
    await api(`supplier_deposits?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    if (row) Object.assign(row, body);
    toast(vd ? '무효 처리했습니다' : '확정했습니다');
    renderDeposits();
  } catch (e) {
    toast('실패: ' + e.message, 4000);
    btn.disabled = false;
  }
});

$('#depAddBtn').onclick = () => {
  $('#depDate').value = new Date().toISOString().slice(0, 10);
  $('#depAmount').value = '';
  $('#depBalance').value = '';
  $('#depMemo').value = '';
  $('#depModalMsg').className = 'msg hidden';
  $('#depModal').classList.remove('hidden');
};
$$('#depModal [data-close]').forEach((b) => { b.onclick = () => $('#depModal').classList.add('hidden'); });

$('#depSave').onclick = async () => {
  const btn = $('#depSave');
  const msg = $('#depModalMsg');
  const type = $('#depType').value;
  const amount = Math.round(Number($('#depAmount').value) || 0);
  const balance = $('#depBalance').value === '' ? null : Math.round(Number($('#depBalance').value) || 0);
  if (type !== 'balance' && amount <= 0) {
    msg.className = 'msg err'; msg.textContent = '금액을 입력하세요.'; return;
  }
  btn.disabled = true;
  try {
    await api('supplier_deposits', {
      method: 'POST', headers: { prefer: 'return=minimal' },
      body: [{
        occurred_at: ($('#depDate').value || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z',
        type,
        /* 사람이 직접 넣은 기록은 곧 확정이다 — 확인 대기로 둘 이유가 없다 */
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
        amount_krw: amount,
        balance_manual_krw: balance,
        memo: $('#depMemo').value.trim() || null
      }]
    });
    $('#depModal').classList.add('hidden');
    toast('기록했습니다');
    loadDeposits();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
