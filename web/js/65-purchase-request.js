/* ============================================================
   65-purchase-request.js — 구매요청 (쿠플러스에 넣기 전 단계)
   ------------------------------------------------------------
   **청구서 앞에 있던 빈 칸을 메우는 화면이다.** 지금까지 시스템은 청구서부터
   시작했고, 그 앞의 구매요청은 쿠플러스 웹에서 사람이 치고 아무 데도 안 남았다.
   그래서 "요청한 것"과 "온 청구서"를 맞춰볼 근거가 없었다.

   단위가 두 개다(2026-08-22 캡처로 확정, docs/api/couplus.md):
     쿠플러스 요청 1건 = SKU 1개(옵션 하나)   → purchase_request_lines
     구매대행 청구서 1장 = 여러 요청을 묶은 것 → purchase_orders (016)

   **우리가 쿠플러스에 자동으로 넣을 수는 없다** — 확장프로그램은 쿠팡만 다루고,
   요청은 사람이 사이트 폼에 친다. 그래서 이 화면의 목적은 하나다:
   **옮겨 적을 때 손이 덜 가게 한다.** 칸마다 복사 버튼을 두고, 모달의 항목 순서를
   쿠플러스 모달과 똑같이 맞춘다. 순서가 다르면 옮겨 적을 때 눈이 미끄러진다.

   파일 순서 주의(D-17): **60 뒤여야 한다** — 권장 수량을 재고 화면과 같은 계산
   (60-inbound.js 의 loadStock·STOCK.rows)으로 낸다. 두 화면이 다른 수를 말하면
   어느 쪽을 믿어야 할지 모르게 된다.
   ============================================================ */

const PRQ = { list: [], cur: null, lines: [], line: null, addSrc: 'stock', newRows: null };

/* 쿠플러스 모달의 토글 7개. **화면이 이 배열 하나만 읽는다** — 폼이 바뀌면 여기만 고친다.
   비용을 같이 들고 있는 이유: 켜는 순간 개당 원가가 달라지는데, 그걸 모달에서
   바로 보여주지 않으면 "왜 청구서가 더 나왔지"를 나중에 역산하게 된다. */
const PRQ_PACK_OPTS = [
  { key: 'basic_inspection', label: '기본검수/분류/포장/포장자재', fee: 200,  unit: '개당', def: true },
  { key: 'barcode_label',    label: '바코드라벨 (Made in China·한글표시사항 포함)', fee: 100, unit: '개당', def: true },
  { key: 'cn_masking',       label: '중국어 마스킹', fee: 0, unit: '무료', def: false },
  { key: 'aircap',           label: '에어캡 포장', fee: null, unit: '실비', def: false },
  { key: 'origin_sewing',    label: '원산지라벨 봉제', fee: 6000, unit: '시간당', def: false,
    note: '의류 수입 시 필수' },
  { key: 'origin_stamp',     label: '원산지 도장', fee: 6000, unit: '시간당', def: false,
    note: '신발류는 봉제 또는 도장 필수' },
  { key: 'origin_tag',       label: '원산지 택(태그)', fee: 6000, unit: '시간당', def: false,
    note: '가방류는 봉제 또는 택 필수' }
];

const PRQ_STATUS = { draft: '만드는 중', submitted: '쿠플러스에 넣음',
                     invoiced: '청구서 받음', cancelled: '취소' };
const PRQ_DEST = { coupang_center: '쿠팡센터', owner: '화주' };
const PRQ_PACKING = { delegate: '포장 방법 위임', no_repack: '재포장 생략',
                      opp: '투명 OPP 봉투', ldpe: '불투명 LDPE 봉투' };

/* 한글표시사항 10항목 중 8개가 my_skus 의 label_*. 앞의 둘(바코드·제품명)은
   SKU 자체에 있다 — 그래서 여기 목록은 8개고, 모달에서 앞에 둘을 붙여 보여준다. */
const PRQ_LABEL_FIELDS = [
  ['label_importer', '수입원/판매원'], ['label_manufacturer', '제조원'],
  ['label_origin_country', '제조국'], ['label_volume', '내용량'],
  ['label_material', '원료명및성분명(재질)'], ['label_product_type', '상품유형'],
  ['label_caution', '사용시주의사항'], ['label_usage_standard', '사용기준']
];

/* ---------- 묶음 목록 ---------- */

async function loadPurchaseRequests() {
  const body = $('#prqRows');
  body.innerHTML = '<tr><td colspan="7"><div class="loader"><div class="spinner"></div>불러오는 중…</div></td></tr>';
  let reqs, lines, pos;
  try {
    [reqs, lines, pos] = await Promise.all([
      api('purchase_requests?select=*&order=created_at.desc&limit=200'),
      api('purchase_request_lines?select=request_id,qty'),
      api('purchase_orders?select=id,requested_at').catch(() => [])
    ]);
  } catch (e) {
    /* 039 미실행이면 404다. 화면을 깨뜨리지 말고 무엇을 해야 하는지 말한다(R-15). */
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    body.innerHTML = `<tr><td colspan="7" class="muted">${miss
      ? '아직 <b>db/migrations/039_purchase_requests.sql</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</td></tr>`;
    $('#prqSummary').textContent = '—';
    return;
  }

  const agg = {};
  (lines || []).forEach((l) => {
    const a = agg[l.request_id] || (agg[l.request_id] = { n: 0, qty: 0 });
    a.n += 1; a.qty += (l.qty || 0);
  });
  const poDate = {};
  (pos || []).forEach((o) => { poDate[o.id] = String(o.requested_at || '').slice(0, 10); });

  PRQ.list = (reqs || []).map((r) => ({ r, a: agg[r.id] || { n: 0, qty: 0 }, po: poDate[r.po_id] }));

  const open = PRQ.list.filter((x) => x.r.status === 'draft' || x.r.status === 'submitted').length;
  $('#prqSummary').textContent = `${PRQ.list.length}건` + (open ? ` · 진행 중 ${open}건` : '');

  body.innerHTML = PRQ.list.length ? PRQ.list.map(({ r, a, po }) => `<tr data-prq="${esc(r.id)}">
    <td>${esc(r.title || '(이름 없음)')}<div class="psub">${esc((r.memo || '').slice(0, 40))}</div></td>
    <td><span class="prog ${r.status === 'invoiced' ? 'prog-ok' : 'prog-dim'}">${
      esc(PRQ_STATUS[r.status] || r.status)}</span></td>
    <td class="col-num">${a.n}</td>
    <td class="col-num">${cnt(a.qty)}</td>
    <td class="sm">${po ? esc(po) : '<span class="muted">—</span>'}</td>
    <td class="sm">${esc(String(r.created_at || '').slice(0, 10))}</td>
    <td class="col-mid"><button class="btn btn-sm prq-open">열기</button></td>
  </tr>`).join('')
    : '<tr><td colspan="7" class="muted">아직 요청 묶음이 없습니다 — [새 요청 묶음]을 누르세요.</td></tr>';
}

$('#prqRows').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-prq]');
  if (!tr || !ev.target.closest('.prq-open')) return;
  prqOpen(tr.dataset.prq);
});

$('#prqNew').onclick = async () => {
  const today = kstDateStr(new Date());
  try {
    const [made] = await api('purchase_requests', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: { title: `${today} 요청분`, created_by: AUTH.userId || null }
    });
    await loadPurchaseRequests();
    prqOpen(made.id);
  } catch (e) {
    toast('만들지 못했습니다: ' + e.message);
  }
};

$('#prqBack').onclick = () => {
  PRQ.cur = null;
  $('#prqDetail').classList.add('hidden');
  $('#prqListWrap').classList.remove('hidden');
  $('#prqBack').classList.add('hidden');
  loadPurchaseRequests();
};

/* ---------- 묶음 상세 ---------- */

async function prqOpen(id) {
  const entry = PRQ.list.find((x) => x.r.id === id);
  const r = entry ? entry.r : (await api(`purchase_requests?select=*&id=eq.${id}&limit=1`))[0];
  if (!r) { toast('묶음을 찾지 못했습니다'); return; }
  PRQ.cur = r;

  $('#prqListWrap').classList.add('hidden');
  $('#prqDetail').classList.remove('hidden');
  $('#prqBack').classList.remove('hidden');
  $('#prqAddBox').classList.add('hidden');

  $('#prqTitle').value = r.title || '';
  $('#prqStatus').value = r.status || 'draft';
  $('#prqMemo').value = r.memo || '';
  $('#prqHeadMsg').textContent = '';

  await prqLoadLines();
}

$('#prqSaveHead').onclick = async () => {
  if (!PRQ.cur) return;
  const btn = $('#prqSaveHead');
  btn.disabled = true;
  try {
    const body = {
      title: ($('#prqTitle').value || '').trim() || null,
      status: $('#prqStatus').value,
      memo: ($('#prqMemo').value || '').trim() || null
    };
    /* 상태를 '넣음'으로 바꾸는 순간을 박아둔다 — 나중에 "언제 요청했는데 청구서가
       언제 왔나"가 리드타임의 출발점이 된다. */
    if (body.status === 'submitted' && !PRQ.cur.submitted_at) body.submitted_at = new Date().toISOString();
    await api(`purchase_requests?id=eq.${PRQ.cur.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(PRQ.cur, body);
    $('#prqHeadMsg').textContent = '저장했습니다.';
  } catch (e) {
    $('#prqHeadMsg').textContent = '저장 실패: ' + e.message;
  } finally { btn.disabled = false; }
};

async function prqLoadLines() {
  const body = $('#prqLineRows');
  body.innerHTML = '<tr><td colspan="7"><div class="loader"><div class="spinner"></div>불러오는 중…</div></td></tr>';
  PRQ.lines = await api('purchase_request_lines?select=*'
    + `&request_id=eq.${PRQ.cur.id}&order=created_at.asc`) || [];
  prqRenderLines();
}

function prqRenderLines() {
  const body = $('#prqLineRows');
  if (!PRQ.lines.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">'
      + '줄이 없습니다 — [+ SKU 추가]로 살 것을 고르세요.</td></tr>';
    return;
  }
  body.innerHTML = PRQ.lines.map((l) => {
    /* 사람이 권장값을 고쳤으면 그 사실을 보여준다. 조용히 두면 나중에
       "계산이 얼마나 맞았나"를 볼 때 무엇이 사람 판단인지 구별이 안 된다. */
    const moved = l.qty_suggested != null && l.qty !== l.qty_suggested;
    return `<tr data-line="${l.id}">
      <td>
        <div class="pname">${esc(l.sku_name_text || '(이름 없음)')}</div>
        <div class="psub">${l.barcode_text
          ? `${esc(l.barcode_text)} <button class="btn btn-sm btn-ghost prq-copy" data-v="${esc(l.barcode_text)}">복사</button>`
          : '<span class="muted">바코드 없음(NOBARCODE)</span>'}</div>
      </td>
      <td class="sm">${l.offer_url
        ? `<a href="${esc(l.offer_url)}" target="_blank" rel="noopener">링크</a>
           <button class="btn btn-sm btn-ghost prq-copy" data-v="${esc(l.offer_url)}">복사</button>`
        : '<span class="muted">—</span>'}</td>
      <td class="sm">${[l.option1_cn, l.option2_cn].filter(Boolean).map((o) =>
        `${esc(o)} <button class="btn btn-sm btn-ghost prq-copy" data-v="${esc(o)}">복사</button>`)
        .join('<br />') || '<span class="muted">—</span>'}</td>
      <td class="col-num">${cnt(l.qty)}
        <button class="btn btn-sm btn-ghost prq-copy" data-v="${l.qty}">복사</button>
        ${moved ? `<div class="psub">권장 ${cnt(l.qty_suggested)}에서 고침</div>` : ''}</td>
      <td class="sm">${esc(PRQ_PACKING[l.packing_method] || l.packing_method)}
        · ${esc(PRQ_DEST[l.destination] || l.destination)}
        ${l.warehouse_note ? '<div class="psub">작업요청 있음</div>' : ''}</td>
      <td class="col-mid"><label class="chk"><input type="checkbox" class="prq-entered"
        ${l.entered_at ? 'checked' : ''} /><span class="muted sm">${
          l.entered_at ? String(l.entered_at).slice(5, 10) : '아직'}</span></label></td>
      <td class="col-mid">
        <button class="btn btn-sm prq-edit">요청등록</button>
        <button class="btn btn-sm btn-ghost prq-del">삭제</button>
      </td>
    </tr>`;
  }).join('');
}

$('#prqLineRows').addEventListener('click', async (ev) => {
  const tr = ev.target.closest('tr[data-line]');
  if (!tr) return;
  const id = Number(tr.dataset.line);
  const line = PRQ.lines.find((l) => l.id === id);

  const cp = ev.target.closest('.prq-copy');
  if (cp) {
    try { await navigator.clipboard.writeText(cp.dataset.v || ''); toast('복사했습니다'); }
    catch (e) { toast('복사하지 못했습니다 — 직접 선택해 주세요'); }
    return;
  }
  if (ev.target.closest('.prq-edit')) { prqOpenLine(line); return; }
  if (ev.target.closest('.prq-del')) {
    if (!confirm('이 줄을 지울까요?')) return;
    await api(`purchase_request_lines?id=eq.${id}`,
      { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await prqLoadLines();
  }
});

/* 넣었는지 체크. **줄마다 따로 본다** — 한 묶음을 나눠 넣다 끊기는 일이 실제로 있다. */
$('#prqLineRows').addEventListener('change', async (ev) => {
  const box = ev.target.closest('.prq-entered');
  if (!box) return;
  const tr = ev.target.closest('tr[data-line]');
  const id = Number(tr.dataset.line);
  const at = box.checked ? new Date().toISOString() : null;
  await api(`purchase_request_lines?id=eq.${id}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { entered_at: at } });
  const line = PRQ.lines.find((l) => l.id === id);
  if (line) line.entered_at = at;
  prqRenderLines();
});

/* ---------- SKU 추가 — 재고 화면과 같은 계산 ---------- */

$('#prqAddOpen').onclick = async () => {
  const box = $('#prqAddBox');
  box.classList.toggle('hidden');
  if (box.classList.contains('hidden')) return;
  await prqLoadSource();
};

/* 담을 곳이 두 갈래다.
     재고에서 — 이미 파는 SKU의 **재발주**. 판매 추이가 있어 권장 수량이 나온다
     신규    — 아직 SKU가 없는 **첫 구매**. 등록 준비 건에서 가져온다
   신규를 SKU 목록에서 찾을 수 없는 이유: 바코드가 쿠팡 발급이라 등록·동기화 뒤에야
   my_skus 행이 생긴다. 그전에도 사야 하므로(첫 물량) 준비 건이 출처가 된다. */
$$('#prqAddBox .prq-src').forEach((b) => {
  b.onclick = async () => {
    PRQ.addSrc = b.dataset.src;
    $$('#prqAddBox .prq-src').forEach((x) => x.classList.toggle('btn-primary', x === b));
    await prqLoadSource();
  };
});

async function prqLoadSource() {
  const cols = PRQ.addSrc === 'stock' ? 6 : 5;
  $('#prqAddRows').innerHTML = `<tr><td colspan="${cols}"><div class="loader"><div class="spinner"></div>`
    + '불러오는 중…</div></td></tr>';
  try {
    if (PRQ.addSrc === 'stock') {
      /* **재고 화면의 계산을 그대로 부른다.** 여기서 다시 계산하면 두 화면이
         다른 수를 말하게 되고, 어느 쪽을 믿을지 모르게 된다. */
      await loadStock();
    } else if (!PRQ.newRows) {
      await prqLoadNewRows();
    }
    prqRenderAdd();
  } catch (e) {
    $('#prqAddRows').innerHTML = `<tr><td colspan="${cols}" class="muted">불러오지 못했습니다: ${esc(e.message)}</td></tr>`;
  }
}

/* 등록 준비 건의 옵션 = 아직 SKU가 안 생긴 상품. 공급처도 여기 있다(옵션·가격 화면). */
async function prqLoadNewRows() {
  const [projects, items] = await Promise.all([
    api('listing_projects?select=id,product_name,status,created_seller_product_id'
      + '&status=neq.discarded&order=updated_at.desc&limit=200'),
    api('listing_project_items?select=*&order=position.asc')
  ]);
  const byId = {};
  (projects || []).forEach((p) => { byId[p.id] = p; });
  PRQ.newRows = (items || [])
    .filter((it) => byId[it.project_id])
    .map((it) => ({ it, p: byId[it.project_id] }));
}

$('#prqAddSearch').oninput = debounce(() => prqRenderAdd(), 200);

function prqRenderAdd() {
  if (PRQ.addSrc === 'new') { prqRenderAddNew(); return; }
  $('#prqAddHead').innerHTML = '<th>SKU</th><th>판정</th><th class="col-num">일평균</th>'
    + '<th class="col-num">가진 물량</th><th class="col-num">권장</th><th></th>';
  const q = ($('#prqAddSearch').value || '').trim().toLowerCase();
  const already = new Set(PRQ.lines.map((l) => l.sku_id).filter(Boolean));

  const rows = (STOCK.rows || [])
    .filter((r) => !already.has(r.sku.id))
    .filter((r) => !q || (r.sku.sku_name || '').toLowerCase().includes(q)
                      || String(r.sku.barcode || '').includes(q))
    /* 발주 필요 → 입고요청 → 나머지. 필요한 것부터 눈에 들어와야 한다 */
    .sort((a, b) => {
      const w = (v) => (v === 'order' ? 0 : v === 'inbound' ? 1 : 2);
      return w(a.verdict) - w(b.verdict) || b.need - a.need;
    })
    .slice(0, 60);

  $('#prqAddRows').innerHTML = rows.length ? rows.map((r) => {
    const v = STOCK_VERDICT[r.verdict] || { label: r.verdict, cls: 'dim' };
    return `<tr data-add="${esc(r.sku.id)}">
      <td><div class="pname">${esc(r.sku.sku_name || '')}</div>
        <div class="psub">${esc(r.sku.barcode || '바코드 없음')}</div></td>
      <td><span class="prog prog-${v.cls === 'warn' ? 'dim' : (v.cls === 'mid' ? 'mid' : 'dim')}">${esc(v.label)}</span></td>
      <td class="col-num">${r.daily}</td>
      <td class="col-num">${cnt(r.pipeline)}</td>
      <td class="col-num">${cnt(r.need)}${r.need === r.moq && r.moq > 1 ? '<div class="psub">MOQ</div>' : ''}</td>
      <td class="col-mid"><button class="btn btn-sm btn-primary prq-add">담기</button></td>
    </tr>`;
  }).join('')
    : '<tr><td colspan="6" class="muted">고를 SKU가 없습니다.</td></tr>';
}

/* 신규 목록. **권장 수량이 없다** — 판매 이력이 없으니 계산할 게 없다.
   여기서 숫자를 지어내면 그게 근거처럼 보인다(R-15). 그래서 MOQ나 1로 두고
   "첫 구매라 계산 근거가 없다"고 줄에 남긴다. */
function prqRenderAddNew() {
  $('#prqAddHead').innerHTML = '<th>준비 건</th><th>옵션</th><th>공급처</th><th>상태</th><th></th>';
  const q = ($('#prqAddSearch').value || '').trim().toLowerCase();
  const already = new Set(PRQ.lines.map((l) => (l.sku_name_text || '').trim()).filter(Boolean));

  const rows = (PRQ.newRows || []).filter(({ it, p }) => {
    const nm = `${p.product_name || ''} ${it.item_name || ''}`.toLowerCase();
    return !q || nm.includes(q);
  }).slice(0, 80);

  $('#prqAddRows').innerHTML = rows.length ? rows.map(({ it, p }, i) => {
    const label = [p.product_name, it.item_name].filter(Boolean).join(', ');
    const dup = already.has(label.trim());
    const sup = it.supplier_offer_url || it.supplier_option1_cn || it.supplier_seller_id;
    return `<tr data-new="${i}">
      <td><div class="pname">${esc(p.product_name || '(상품명 미정)')}</div>
        <div class="psub">${p.created_seller_product_id
          ? '등록됨 · 상품ID ' + esc(p.created_seller_product_id) : '아직 등록 전'}</div></td>
      <td class="sm">${esc(it.item_name || '(옵션명 없음)')}</td>
      <td class="sm">${sup ? '있음' : '<span class="neg">없음</span>'}</td>
      <!-- 86-listing.js 는 이 파일보다 **뒤에** 로드된다(D-17). 클릭 시점이라 실제로는
           정의돼 있지만, 규칙을 눈으로 지키려고 있을 때만 쓴다. -->
      <td class="sm">${esc((typeof LISTING_STATUS_LABEL !== 'undefined'
        && LISTING_STATUS_LABEL[p.status]) || p.status || '')}</td>
      <td class="col-mid">${dup
        ? '<span class="muted sm">담김</span>'
        : '<button class="btn btn-sm btn-primary prq-add-new">담기</button>'}</td>
    </tr>`;
  }).join('')
    : '<tr><td colspan="5" class="muted">등록 준비 건이 없습니다.</td></tr>';
}

$('#prqAddRows').addEventListener('click', async (ev) => {
  const trNew = ev.target.closest('tr[data-new]');
  if (trNew && ev.target.closest('.prq-add-new')) {
    const entry = (PRQ.newRows || [])[Number(trNew.dataset.new)];
    if (!entry) return;
    ev.target.disabled = true;
    const { it, p } = entry;
    try {
      await api('purchase_request_lines', {
        method: 'POST', headers: { prefer: 'return=minimal' },
        body: {
          request_id: PRQ.cur.id,
          /* SKU는 아직 없다. 바코드도 없다(쿠플러스 폼이 "없으면 생략"을 허용한다).
             동기화가 SKU를 만든 뒤에 이 줄을 SKU에 잇는 일은 아직 안 한다 — 미해결. */
          sku_id: null,
          barcode_text: null,
          sku_name_text: [p.product_name, it.item_name].filter(Boolean).join(', ') || null,
          offer_url: it.supplier_offer_url || null,
          option1_cn: it.supplier_option1_cn || null,
          option2_cn: it.supplier_option2_cn || null,
          qty: 1,
          qty_suggested: null,
          qty_reason: { source: 'listing_project', project_id: p.id,
                        note: '첫 구매 — 판매 이력이 없어 권장 수량 없음' }
        }
      });
      await prqLoadLines();
      prqRenderAddNew();
    } catch (e) {
      toast('담지 못했습니다: ' + e.message);
    } finally { ev.target.disabled = false; }
    return;
  }

  const tr = ev.target.closest('tr[data-add]');
  if (!tr || !ev.target.closest('.prq-add')) return;
  const r = (STOCK.rows || []).find((x) => x.sku.id === tr.dataset.add);
  if (!r) return;
  ev.target.disabled = true;

  try {
    /* 공급처를 같이 박아둔다(R-04). 나중에 링크가 바뀌어도 **그때 무엇을 보고
       요청했나**는 남아야 한다. */
    const sup = (await api('sku_suppliers?select=offer_url,option1_cn,option2_cn'
      + `&sku_id=eq.${r.sku.id}&order=is_primary.desc&limit=1`) || [])[0] || {};

    await api('purchase_request_lines', {
      method: 'POST', headers: { prefer: 'return=minimal' },
      body: {
        request_id: PRQ.cur.id,
        sku_id: r.sku.id,
        barcode_text: r.sku.barcode || null,
        sku_name_text: r.sku.sku_name || null,
        offer_url: sup.offer_url || null,
        option1_cn: sup.option1_cn || null,
        option2_cn: sup.option2_cn || null,
        qty: Math.max(1, r.need || r.moq || 1),
        qty_suggested: r.need || null,
        /* 왜 그 수량인지를 같이 남긴다 — 숫자만 남기면 나중에 되짚을 수 없다 */
        qty_reason: { daily_avg: r.daily, lead_time: r.lead, safety: r.safety,
                      on_hand: r.pipeline, moq: r.moq, verdict: r.verdict,
                      review_cycle: STOCK.defaults.reviewCycle }
      }
    });
    await prqLoadLines();
    prqRenderAdd();
  } catch (e) {
    toast('담지 못했습니다: ' + e.message);
  } finally { ev.target.disabled = false; }
});

/* ---------- 줄 하나의 요청사항 (쿠플러스 모달과 같은 순서) ---------- */

async function prqOpenLine(line) {
  if (!line) return;
  PRQ.line = line;
  $('#prqLineModal').classList.remove('hidden');
  $('#prqLineTitle').textContent = line.sku_name_text || '요청사항';
  $('#prqLineMsg').classList.add('hidden');

  $('#prqLineRo').innerHTML = [
    ['바코드 번호', line.barcode_text || 'NOBARCODE'],
    ['제품명', line.sku_name_text || '—'],
    ['구매링크', line.offer_url || '—']
  ].map(([k, v]) => `<span class="kv"><span class="kv-k">${k}</span>`
    + `<span class="kv-v">${esc(String(v))}</span></span>`).join('');

  $('#prqQty').value = line.qty;
  $('#prqBundleQty').value = line.sale_bundle_qty || 1;
  $('#prqIsBundle').checked = line.is_bundle === true;
  $('#prqDest').value = line.destination || 'coupang_center';
  $('#prqPacking').value = line.packing_method || 'delegate';
  $('#prqWhNote').value = line.warehouse_note || '';
  $('#prqSellerNote').value = line.seller_note || '';

  /* 쿠플러스가 화면에서 MOQ와 1688 재고를 알려준다. 우리는 MOQ만 안다 —
     **모르는 건 모른다고 둔다**(R-15). 재고를 지어내면 그걸 믿고 요청하게 된다. */
  const reason = line.qty_reason || {};
  $('#prqMoqNote').textContent = reason.moq ? `최소주문 ${reason.moq}개`
    + (line.qty_suggested != null ? ` · 권장 ${line.qty_suggested}개` : '') : '';

  const opts = line.packing_options || {};
  $('#prqPackOpts').innerHTML = PRQ_PACK_OPTS.map((o) => {
    const on = opts[o.key] === undefined ? o.def : opts[o.key] === true;
    const fee = o.fee === 0 ? '무료' : (o.fee == null ? '실비' : `${o.fee.toLocaleString()}원/${o.unit === '개당' ? '개' : '시간'}`);
    return `<label class="chk" style="display:flex;margin:3px 0"><input type="checkbox" class="prq-pk"
      data-key="${o.key}" ${on ? 'checked' : ''} />
      <span>${esc(o.label)} <span class="muted">(${fee})</span>${
        o.note ? ` <span class="neg sm">— ${esc(o.note)}</span>` : ''}</span></label>`;
  }).join('');

  prqPackFee();
  prqFillLabels(line);
}

/* 개당 얼마가 붙는지 지금 보여준다. 청구서를 받고 역산하면 늦다. */
function prqPackFee() {
  const on = {};
  $$('#prqPackOpts .prq-pk').forEach((c) => { on[c.dataset.key] = c.checked; });
  const per = PRQ_PACK_OPTS.filter((o) => on[o.key] && o.unit === '개당')
    .reduce((a, o) => a + (o.fee || 0), 0);
  const hourly = PRQ_PACK_OPTS.filter((o) => on[o.key] && o.unit === '시간당').map((o) => o.label);
  $('#prqPackFee').innerHTML = `개당 <b>${per.toLocaleString()}원</b>`
    + (hourly.length
        ? ` + <b class="neg">시간당 6,000원</b> 작업(${esc(hourly.join(', '))}) — `
          + '개당 원가로 안 떨어집니다. 청구서에서 따로 확인하세요'
        : ' — 제트 청구서에서 실측한 값과 같습니다');
}
$('#prqPackOpts').addEventListener('change', () => prqPackFee());

/* 한글표시사항은 **여기서 고치지 않는다** — SKU 고정값이라 상품원장이 원본이다.
   여기서 고치게 하면 요청마다 달라져서 "이 SKU의 표시사항"이 무엇인지 모르게 된다. */
function prqFillLabels(line) {
  const el = $('#prqLabels');
  if (!line.sku_id) {
    el.innerHTML = '<p class="muted sm">SKU와 연결되지 않은 줄이라 표시사항을 못 가져옵니다.</p>';
    return;
  }
  el.innerHTML = '<p class="muted sm">불러오는 중…</p>';
  api(`my_skus?select=barcode,sku_name,${PRQ_LABEL_FIELDS.map(([k]) => k).join(',')}`
    + `&id=eq.${line.sku_id}&limit=1`).then((rows) => {
    const s = (rows || [])[0];
    if (!s) { el.innerHTML = '<p class="muted sm">SKU를 찾지 못했습니다.</p>'; return; }
    const all = [['바코드 번호', s.barcode || 'NOBARCODE'], ['제품명', s.sku_name || '']]
      .concat(PRQ_LABEL_FIELDS.map(([k, label]) => [label, s[k] || '']));
    const empty = all.filter(([, v]) => !String(v).trim()).length;
    el.innerHTML = all.map(([k, v]) => `<div class="kv" style="display:flex;gap:8px;margin:2px 0">
        <span class="kv-k" style="min-width:130px">${esc(k)}</span>
        <span class="kv-v">${v ? esc(String(v)) : '<span class="muted">비어 있음</span>'}</span>
        ${v ? `<button class="btn btn-sm btn-ghost prq-copy2" data-v="${esc(String(v))}">복사</button>` : ''}
      </div>`).join('')
      + `<button class="btn btn-sm prq-copy-all" style="margin-top:6px">10항목 한 번에 복사</button>`
      + (empty ? `<p class="msg err sm">${empty}개 항목이 비어 있습니다 — `
          + '상품원장에서 채우세요. 빈 채로 요청하면 배대지가 라벨을 못 만듭니다.</p>' : '');
    el.dataset.all = JSON.stringify(all);
  }).catch((e) => { el.innerHTML = `<p class="muted sm">불러오지 못했습니다: ${esc(e.message)}</p>`; });
}

$('#prqLabels').addEventListener('click', async (ev) => {
  const one = ev.target.closest('.prq-copy2');
  const all = ev.target.closest('.prq-copy-all');
  if (!one && !all) return;
  let text = '';
  if (one) text = one.dataset.v || '';
  else {
    const rows = JSON.parse($('#prqLabels').dataset.all || '[]');
    text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  }
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); }
  catch (e) { toast('복사하지 못했습니다 — 직접 선택해 주세요'); }
});

$('#prqLineModal').addEventListener('click', (ev) => {
  if (ev.target.matches('[data-close], .modal-backdrop')) $('#prqLineModal').classList.add('hidden');
});

$('#prqLineSave').onclick = async () => {
  const line = PRQ.line;
  if (!line) return;
  const btn = $('#prqLineSave');
  btn.disabled = true;
  try {
    const packing_options = {};
    $$('#prqPackOpts .prq-pk').forEach((c) => { packing_options[c.dataset.key] = c.checked; });
    const body = {
      qty: Math.max(1, Number($('#prqQty').value) || 1),
      sale_bundle_qty: Math.max(1, Number($('#prqBundleQty').value) || 1),
      is_bundle: $('#prqIsBundle').checked,
      destination: $('#prqDest').value,
      packing_method: $('#prqPacking').value,
      packing_options,
      warehouse_note: ($('#prqWhNote').value || '').trim() || null,
      seller_note: ($('#prqSellerNote').value || '').trim() || null
    };
    await api(`purchase_request_lines?id=eq.${line.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });
    Object.assign(line, body);
    $('#prqLineModal').classList.add('hidden');
    prqRenderLines();
    toast('저장했습니다');
  } catch (e) {
    $('#prqLineMsg').classList.remove('hidden');
    $('#prqLineMsg').textContent = '저장 실패: ' + e.message;
  } finally { btn.disabled = false; }
};
