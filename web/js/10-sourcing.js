/* ============================================================
   10-sourcing.js — 소싱 목록 · 즐겨찾기 · 카테고리 · 수집 대기열
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 소싱 목록 ===================== */
function buildQuery() {
  const f = state.filters;
  const parts = [
    'select=product_id,product_name,brand_name,category_code,category_path,rep_image_path,' +
    'max_sales,sum_sales,min_price,max_price,option_count,has_rocket,pv_rank,pv_lower,pv_upper' +
    (state.hasDeliveryCol ? ',delivery_badges' : ''),
    'is_active=eq.true'
  ];

  if (state.search) parts.push(`product_name=ilike.*${encodeURIComponent(state.search)}*`);
  if (f.category)   parts.push(`category_code=eq.${f.category}`);
  if (f.root)       parts.push(`category_path=ilike.${encodeURIComponent(f.root)}*`);
  if (f.priceMin)   parts.push(`min_price=gte.${f.priceMin}`);
  if (f.priceMax)   parts.push(`min_price=lte.${f.priceMax}`);
  if (f.salesMin)   parts.push(`max_sales=gte.${f.salesMin}`);
  if (f.salesMax)   parts.push(`max_sales=lte.${f.salesMax}`);
  /* 옵션 중 하나라도 그 배송유형이면 걸린다 (배열 포함 검색, GIN 인덱스 사용) */
  if (f.delivery && state.hasDeliveryCol) {
    parts.push('delivery_badges=cs.' + encodeURIComponent(`{"${f.delivery}"}`));
  }

  if (f.favCatOnly && state.favCatCodes.size) {
    parts.push(`category_code=in.(${Array.from(state.favCatCodes).join(',')})`);
  }

  const sort = f.sort || 'max_sales';
  parts.push(`order=${sort}.${sort === 'min_price' || sort === 'pv_rank' ? 'asc' : 'desc'}.nullslast`);
  parts.push(`limit=${state.limit}`);
  parts.push(`offset=${state.offset}`);

  return 'products?' + parts.join('&');
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  $('#sourcingLoader').classList.remove('hidden');

  try {
    let rows;
    try {
      rows = await api(buildQuery());
    } catch (err) {
      /* 004 마이그레이션 전 DB에는 delivery_badges 컬럼이 없다 —
         한 번만 감지해서 예전 방식(has_rocket)으로 되돌리고 다시 시도한다. */
      if (state.hasDeliveryCol && /delivery_badges/.test(err.message)) {
        state.hasDeliveryCol = false;
        rows = await api(buildQuery());
      } else throw err;
    }
    if (!rows || rows.length < state.limit) state.done = true;

    if (rows && rows.length) {
      state.rows.push(...rows);
      renderRows(rows);
      state.offset += rows.length;
      loadRowMargins(rows);
    }

    $('#sourcingCount').textContent = `${state.rows.length}개 상품` + (state.done ? '' : ' (스크롤하면 더 불러옵니다)');
    $('#sourcingEmpty').classList.toggle('hidden', state.rows.length > 0);
    $('#sourcingEnd').classList.toggle('hidden', !(state.done && state.rows.length > 0));
  } catch (e) {
    toast('불러오기 실패: ' + e.message, 4000);
  } finally {
    state.loading = false;
    $('#sourcingLoader').classList.add('hidden');
  }
}

function resetAndLoad() {
  state.rows = []; state.offset = 0; state.done = false;
  state.openProducts.clear();
  $('#sourcingBody').innerHTML = '';
  $('#sourcingEnd').classList.add('hidden');
  loadMore();
}

function renderRows(rows) {
  const tb = $('#sourcingBody');
  const html = rows.map((p) => {
    const root = (p.category_path || '').split('>')[0] || '—';
    const leaf = (p.category_path || '').split('>').pop() || '—';
    const priceTxt = (p.min_price === p.max_price)
      ? won(p.min_price)
      : `${won(p.min_price)}~`;
    const pv = (p.pv_lower || p.pv_upper)
      ? `${p.pv_lower ? p.pv_lower.toLocaleString() : ''}~${p.pv_upper ? p.pv_upper.toLocaleString() : ''}`
      : '—';

    return `
<tr class="prow" data-pid="${esc(p.product_id)}" data-cat="${esc(p.category_code || '')}">
  <td class="col-img">
    <img class="thumb" loading="lazy" src="${esc(imageUrl(p.rep_image_path, 120))}" alt="" onerror="this.style.visibility='hidden'" />
  </td>
  <td class="col-name">
    <div class="pname">
      <svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      <span>${esc(p.product_name || '(이름 없음)')}</span>
    </div>
    <div class="psub">${esc(p.brand_name || '')} · 옵션 ${p.option_count || 0}개</div>
  </td>
  <td class="col-num" data-label="판매량">${cnt(p.max_sales)}</td>
  <td class="col-num" data-label="가격">${priceTxt}</td>
  <td class="col-num" data-label="조회수">${pv}</td>
  <td class="col-num margin-rate" data-label="마진율"><span class="dim">—</span></td>
  <td class="col-num margin-amt"  data-label="마진액"><span class="dim">—</span></td>
  <td class="col-delivery" data-label="배송">${deliveryCell(p)}</td>
  <td class="col-mid" data-label="대분류">${esc(root)}</td>
  <td class="col-mid" data-label="말단">${esc(leaf)}</td>
  <td class="col-fav"></td>
</tr>
<tr class="detail hidden" data-detail="${esc(p.product_id)}"><td colspan="11"><div class="detail-inner">불러오는 중…</div></td></tr>`;
  }).join('');

  tb.insertAdjacentHTML('beforeend', html);
}

/* 클릭(옵션 펼치기) 없이도 이미 입력해 둔 원가로 상품 목록에 최고 마진율을 채운다 */
async function loadRowMargins(rows) {
  const pids = rows.map((p) => p.product_id).filter(Boolean);
  if (!pids.length) return;

  try {
    const [, costedRaw] = await Promise.all([
      state.readyForMargins,
      api(
        'user_items?select=item_id,product_id,cost_cny,want_price,exchange_rate,outbound_fee,work_fee' +
        `&product_id=in.(${pids.map(encodeURIComponent).join(',')})&cost_cny=not.is.null`
      )
    ]);
    const costed = costedRaw || [];
    if (!costed.length) return;

    costed.forEach((u) => { state.userItems[u.item_id] = Object.assign(state.userItems[u.item_id] || {}, u); });

    const needPrice = costed.filter((u) => u.want_price == null).map((u) => u.item_id);
    const priceMap = {};
    if (needPrice.length) {
      const items = await api(
        `product_items?select=item_id,current_price&item_id=in.(${needPrice.map(encodeURIComponent).join(',')})`
      ) || [];
      items.forEach((it) => { priceMap[it.item_id] = it.current_price; });
    }

    const byProduct = {};
    costed.forEach((u) => { (byProduct[u.product_id] = byProduct[u.product_id] || []).push(u); });

    rows.forEach((p) => {
      const items = byProduct[p.product_id];
      if (!items) return;

      let best = null, bestAmt = null;
      items.forEach((u) => {
        const price = num(u.want_price) ?? num(priceMap[u.item_id]);
        const size = u.size_type || settings.size;
        const fee = feeFor(p.category_code, size, price);
        const c = calcMargin({
          price, commission: commissionFor(p.category_code), fulfillment: fee,
          costCny: u.cost_cny, rate: u.exchange_rate,
          outbound: u.outbound_fee, work: u.work_fee
        });
        if (c && c.margin !== null && (best === null || c.rate > best)) {
          best = c.rate; bestAmt = c.margin;
        }
      });

      if (best !== null) {
        const prow = document.querySelector(`tr.prow[data-pid="${CSS.escape(p.product_id)}"]`);
        if (!prow) return;
        const cls = best >= 0 ? 'pos' : 'neg';
        prow.querySelector('.margin-rate').innerHTML = `<span class="${cls}">${best}%</span>`;
        prow.querySelector('.margin-amt').innerHTML = `<span class="${cls}">${bestAmt.toLocaleString()}</span>`;
      }
    });
  } catch (e) { /* 목록 표시는 계속 정상 동작해야 하므로 조용히 무시 */ }
}

/* ---------- 옵션 펼치기 ---------- */
$('#sourcingBody').addEventListener('click', async (ev) => {
  const star = ev.target.closest('.star');
  if (star) { ev.stopPropagation(); await toggleFavorite(star); return; }

  const row = ev.target.closest('tr.prow');
  if (!row) return;

  const pid = row.dataset.pid;
  const detail = document.querySelector(`tr[data-detail="${CSS.escape(pid)}"]`);
  const open = !detail.classList.contains('hidden');

  if (open) {
    detail.classList.add('hidden');
    row.classList.remove('open');
    state.openProducts.delete(pid);
    return;
  }

  detail.classList.remove('hidden');
  row.classList.add('open');
  state.openProducts.add(pid);

  if (!detail.dataset.loaded) {
    await loadOptions(pid, row.dataset.cat, detail);
    detail.dataset.loaded = '1';
  }
});

async function loadOptions(pid, catCode, detailEl) {
  const box = detailEl.querySelector('.detail-inner');
  try {
    /* user_items를 따로 조회하지 않고 product_items에 PostgREST 리소스 임베딩으로
       한 번에 묶어서 받는다(FK: user_items.item_id -> product_items.item_id).
       예전엔 두 요청을 Promise.all로 동시에 보냈는데, 그래도 요청 2개 자체의
       왕복 오버헤드(연결·헤더 등)는 남아있었다 — 1개로 줄이면 그만큼 더 빨라진다.
       RLS가 이미 user_items를 본인 것만 보이게 걸러주므로 item당 최대 1개만 온다.

       readyForMargins도 같이 기다린다(네트워크 요청과 동시에 — 이미 끝나 있으면
       비용 0). 이게 없으면 페이지 열자마자 바로 클릭했을 때 카테고리 로딩이
       아직 안 끝나 commissionFor()/feeFor()가 전부 null을 주고, detail은 한 번
       열리면 dataset.loaded로 캐시돼서 다시 안 그려지니 "수수료 정보 없음"이
       영영 안 고쳐진다(소싱 목록의 loadRowMargins도 같은 이유로 이걸 기다림). */
    const [items] = await Promise.all([
      api(
        `product_items?select=item_id,vendor_item_id,item_name,image_path,current_price,` +
        `sales_number,sales_text,delivery_badge,shipping_fee,seller_name,is_soldout,user_items(*)` +
        `&product_id=eq.${encodeURIComponent(pid)}&is_active=eq.true&order=sales_number.desc.nullslast`
      ),
      state.readyForMargins
    ]);

    (items || []).forEach((it) => {
      const mine = it.user_items && it.user_items[0];
      if (mine) state.userItems[it.item_id] = mine;
    });

    box.innerHTML = renderOptions(items || [], pid, catCode);
    updateProductMargin(pid);
  } catch (e) {
    box.innerHTML = `<p class="muted sm">옵션을 불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

function renderOptions(items, pid, catCode) {
  if (!items.length) return '<p class="muted sm">옵션이 없습니다</p>';

  const rows = items.map((it) => {
    const u = state.userItems[it.item_id] || {};
    const size = u.size_type || settings.size;
    const price = num(u.want_price) ?? num(it.current_price);
    const fee = feeFor(catCode, size, price);
    const commissionRate = commissionFor(catCode);
    const c = commissionRate != null ? calcMargin({
      price, commission: commissionRate, fulfillment: fee,
      costCny: u.cost_cny, rate: u.exchange_rate,
      outbound: u.outbound_fee, work: u.work_fee
    }) : null;

    const noCommissionTxt = '<span class="dim">수수료 정보 없음</span>';
    const marginTxt = commissionRate == null ? noCommissionTxt
      : (c && c.margin !== null)
        ? `<span class="${c.margin >= 0 ? 'pos' : 'neg'}">${c.margin.toLocaleString()}원 · ${c.rate}%</span>`
        : '<span class="dim">원가 입력 필요</span>';

    const fav = state.userItems[it.item_id] && state.userItems[it.item_id].is_favorite;

    return `
<tr data-iid="${esc(it.item_id)}" data-pid="${esc(pid)}" data-cat="${esc(catCode || '')}">
  <td data-label="옵션">
    <a href="${esc(productUrl(pid, it.item_id, it.vendor_item_id))}" target="_blank" rel="noopener">
      ${esc(it.item_name || '기본')}
    </a>
    ${it.is_soldout ? ' <span class="tag tag-seller">품절</span>' : ''}
  </td>
  <td data-label="판매량">${cnt(it.sales_number)}</td>
  <td data-label="현재가">${won(it.current_price)}</td>
  <td data-label="배송">${deliveryTag(it.delivery_badge)}</td>
  <td data-label="원가(¥)">
    <input type="number" class="w-cost in-cost" step="0.01" min="0" max="${MAX_COST_CNY}" placeholder="0"
           value="${u.cost_cny != null ? u.cost_cny : ''}" />
  </td>
  <td data-label="희망가">
    <input type="number" class="w-price in-want" min="0" max="${MAX_WANT_PRICE}" placeholder="현재가"
           value="${u.want_price != null ? u.want_price : ''}" />
  </td>
  <td data-label="사이즈">
    <select class="w-size in-size">
      ${['MINI','SMALL','MEDIUM','LARGE1','LARGE2','XLARGE'].map((s) =>
        `<option value="${s}"${s === size ? ' selected' : ''}>${
          {MINI:'극소형',SMALL:'소형',MEDIUM:'중형',LARGE1:'대형1',LARGE2:'대형2',XLARGE:'특대형'}[s]
        }</option>`).join('')}
    </select>
  </td>
  <td data-label="입출고비" class="calc-out out-fulfillment">${fee != null ? won(fee) : '<span class="dim">요금표 없음</span>'}</td>
  <td data-label="수수료" class="calc-out out-commission">${commissionRate == null ? noCommissionTxt : (c ? `${won(c.commission)} (${commissionRate}%)` : '—')}</td>
  <td data-label="정산" class="calc-out out-settle">${commissionRate == null ? noCommissionTxt : (c ? won(c.settlement) : '—')}</td>
  <td data-label="마진" class="calc-out out-margin">${marginTxt}</td>
  <td data-label="즐겨찾기">
    <button class="star ${fav ? 'on' : ''}" data-iid="${esc(it.item_id)}" data-pid="${esc(pid)}">
      <svg viewBox="0 0 24 24"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>
    </button>
  </td>
</tr>`;
  }).join('');

  return `
<table class="opt-table">
  <thead><tr>
    <th>옵션</th><th>판매량</th><th>현재가</th><th>배송</th>
    <th>원가(¥)</th><th>희망가</th><th>사이즈</th><th>입출고비</th><th>수수료</th><th>정산예상</th><th>실마진</th><th></th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/* ---------- 옵션 입력 → 즉시 재계산 + 저장 ---------- */
const saveUserItem = debounceKeyed(async (iid, pid, patch) => {
  try {
    await api('user_items?on_conflict=user_id,item_id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [Object.assign({ user_id: AUTH.userId, item_id: iid, product_id: pid }, patch)]
    });
  } catch (e) {
    toast('저장 실패: ' + e.message, 3500);
  }
}, 600);

$('#sourcingBody').addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-iid]');
  if (!tr) return;
  if (!ev.target.matches('.in-cost, .in-want, .in-size')) return;
  recalcRow(tr, true);
});
$('#sourcingBody').addEventListener('change', (ev) => {
  const tr = ev.target.closest('tr[data-iid]');
  if (tr && ev.target.matches('.in-size')) recalcRow(tr, true);
});

function recalcRow(tr, save) {
  const iid = tr.dataset.iid, pid = tr.dataset.pid, cat = tr.dataset.cat;
  const costEl = tr.querySelector('.in-cost');
  const wantEl = tr.querySelector('.in-want');
  const sizeEl = tr.querySelector('.in-size');

  const cost = costEl.value === '' ? null : parseFloat(costEl.value);
  const want = wantEl.value === '' ? null : parseInt(wantEl.value, 10);
  const size = sizeEl.value;

  /* DB 컬럼 한도를 넘는 값은 저장이 매번 400으로 실패해서 헛돌기만 하므로
     여기서 걸러서 계산·저장 둘 다 건너뛴다 (실수로 자릿수를 잘못 입력했을 때 보호) */
  const costTooBig = cost !== null && (cost > MAX_COST_CNY || cost < 0);
  const wantTooBig = want !== null && (want > MAX_WANT_PRICE || want < 0);
  costEl.classList.toggle('input-invalid', costTooBig);
  wantEl.classList.toggle('input-invalid', wantTooBig);

  if (costTooBig || wantTooBig) {
    const label = wantTooBig ? '희망가' : '원가';
    const limit = wantTooBig ? MAX_WANT_PRICE : MAX_COST_CNY;
    tr.querySelector('.out-fulfillment').innerHTML = '<span class="dim">—</span>';
    tr.querySelector('.out-commission').textContent = '—';
    tr.querySelector('.out-settle').textContent = '—';
    tr.querySelector('.out-margin').innerHTML =
      `<span class="neg">${label}는 ${limit.toLocaleString()} 이하로 입력하세요</span>`;
    return;
  }

  const cur = state.userItems[iid] || {};
  const basePrice = num(want) ?? num(cur._current_price) ?? currentPriceOf(tr);
  const fee = feeFor(cat, size, basePrice);
  const commissionRate = commissionFor(cat);

  const c = commissionRate != null ? calcMargin({
    price: basePrice, commission: commissionRate, fulfillment: fee,
    costCny: cost, rate: cur.exchange_rate ?? settings.rate,
    outbound: cur.outbound_fee, work: cur.work_fee
  }) : null;

  tr.querySelector('.out-fulfillment').innerHTML = fee != null ? won(fee) : '<span class="dim">요금표 없음</span>';
  if (commissionRate == null) {
    tr.querySelector('.out-commission').innerHTML = '<span class="dim">수수료 정보 없음</span>';
    tr.querySelector('.out-settle').textContent = '—';
    tr.querySelector('.out-margin').innerHTML = '<span class="dim">수수료 정보 없음</span>';
  } else {
    tr.querySelector('.out-commission').textContent = c ? `${won(c.commission)} (${commissionRate}%)` : '—';
    tr.querySelector('.out-settle').textContent = c ? won(c.settlement) : '—';
    tr.querySelector('.out-margin').innerHTML = (c && c.margin !== null)
      ? `<span class="${c.margin >= 0 ? 'pos' : 'neg'}">${c.margin.toLocaleString()}원 · ${c.rate}%</span>`
      : '<span class="dim">원가 입력 필요</span>';
  }

  state.userItems[iid] = Object.assign(cur, {
    cost_cny: cost, want_price: want, size_type: size,
    exchange_rate: cur.exchange_rate ?? settings.rate
  });

  if (save) {
    saveUserItem(iid, pid, {
      cost_cny: cost, want_price: want,
      exchange_rate: cur.exchange_rate ?? settings.rate
    });
  }
  updateProductMargin(pid);
}

function currentPriceOf(tr) {
  const td = tr.querySelector('td[data-label="현재가"]');
  const n = parseInt((td ? td.textContent : '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/* 상품 행에 옵션 중 최고 마진율 표시 */
function updateProductMargin(pid) {
  const detail = document.querySelector(`tr[data-detail="${CSS.escape(pid)}"]`);
  const prow = document.querySelector(`tr.prow[data-pid="${CSS.escape(pid)}"]`);
  if (!detail || !prow) return;

  let best = null, bestAmt = null;
  detail.querySelectorAll('tr[data-iid]').forEach((tr) => {
    const txt = tr.querySelector('.out-margin').textContent;
    const m = txt.match(/(-?[\d,]+)원\s*·\s*(-?[\d.]+)%/);
    if (m) {
      const r = parseFloat(m[2]);
      if (best === null || r > best) { best = r; bestAmt = parseInt(m[1].replace(/,/g, ''), 10); }
    }
  });

  const rc = prow.querySelector('.margin-rate');
  const ac = prow.querySelector('.margin-amt');
  if (best === null) {
    rc.innerHTML = '<span class="dim">—</span>';
    ac.innerHTML = '<span class="dim">—</span>';
  } else {
    const cls = best >= 0 ? 'pos' : 'neg';
    rc.innerHTML = `<span class="${cls}">${best}%</span>`;
    ac.innerHTML = `<span class="${cls}">${bestAmt.toLocaleString()}</span>`;
  }
}

/* ---------- 즐겨찾기 ---------- */
async function toggleFavorite(btn) {
  const iid = btn.dataset.iid, pid = btn.dataset.pid;
  const on = !btn.classList.contains('on');
  btn.classList.toggle('on', on);

  try {
    await api('user_items?on_conflict=user_id,item_id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [{ user_id: AUTH.userId, item_id: iid, product_id: pid, is_favorite: on }]
    });
    const cur = state.userItems[iid] || {};
    cur.is_favorite = on;
    state.userItems[iid] = cur;
    toast(on ? '즐겨찾기에 추가했습니다' : '즐겨찾기에서 제거했습니다');
  } catch (e) {
    btn.classList.toggle('on', !on);
    toast('실패: ' + e.message, 3500);
  }
}

/* ===================== 즐겨찾기 페이지 ===================== */
let favStatus = '';

async function loadFavorites() {
  const box = $('#favList');
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  try {
    let q = 'v_favorites?select=*&order=updated_at.desc&limit=300';
    if (favStatus) q += `&status=eq.${encodeURIComponent(favStatus)}`;
    const rows = await api(q) || [];

    $('#favCount').textContent = `${rows.length}건`;
    $('#favEmpty').classList.toggle('hidden', rows.length > 0);

    box.innerHTML = rows.map((r) => `
<div class="fav-card" data-iid="${esc(r.item_id)}">
  <img loading="lazy" src="${esc(imageUrl(r.image_path, 200))}" alt="" onerror="this.style.visibility='hidden'" />
  <div class="fav-main">
    <div class="fav-title">
      <a href="${esc(productUrl(r.product_id, r.item_id))}" target="_blank" rel="noopener">
        ${esc(r.product_name || '')}
      </a>
    </div>
    <div class="muted sm">${esc(r.item_name || '')} · ${esc(r.brand_name || '')}</div>
    <div class="fav-meta">
      <span>현재가 ${won(r.current_price)}</span>
      <span>판매량 ${cnt(r.sales_number)}</span>
      <span>${r.delivery_badge ? esc(r.delivery_badge) : '—'}</span>
      ${r.cur_margin_rate != null
        ? `<span class="${r.cur_margin_rate >= 0 ? 'pos' : 'neg'}">마진 ${r.cur_margin_rate}%</span>` : ''}
    </div>
    <div class="fav-tools">
      <select class="fav-status">
        ${['검토중','소싱대기','소싱완료','구매완료','판매중','보류'].map((s) =>
          `<option${s === (r.status || '검토중') ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <textarea class="fav-memo" placeholder="메모">${esc(r.memo || '')}</textarea>
      <button class="btn btn-sm btn-ghost fav-remove">해제</button>
    </div>
  </div>
</div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#statusTabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  $$('#statusTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  favStatus = t.dataset.status || '';
  loadFavorites();
});

$('#favList').addEventListener('change', async (ev) => {
  const card = ev.target.closest('.fav-card');
  if (!card) return;
  const iid = card.dataset.iid;

  if (ev.target.matches('.fav-status')) {
    await patchUserItem(iid, { status: ev.target.value });
    toast('상태를 변경했습니다');
  }
});

const saveFavMemo = debounceKeyed(async (iid, memo) => {
  await patchUserItem(iid, { memo });
}, 800);

$('#favList').addEventListener('input', (ev) => {
  const card = ev.target.closest('.fav-card');
  if (!card || !ev.target.matches('.fav-memo')) return;
  saveFavMemo(card.dataset.iid, ev.target.value);
});

$('#favList').addEventListener('click', async (ev) => {
  if (!ev.target.matches('.fav-remove')) return;
  const card = ev.target.closest('.fav-card');
  await patchUserItem(card.dataset.iid, { is_favorite: false });
  card.remove();
  toast('즐겨찾기에서 제거했습니다');
});

async function patchUserItem(iid, patch) {
  try {
    await api(`user_items?item_id=eq.${encodeURIComponent(iid)}&user_id=eq.${AUTH.userId}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: patch
    });
  } catch (e) {
    toast('저장 실패: ' + e.message, 3500);
  }
}

/* ===================== 카테고리 ===================== */
const selectedCats = new Set();

async function loadCategories(force) {
  const box = $('#catGroups');
  if (!force && state.catStatusRows) { renderCategories(); return; }
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  try {
    const rows = await apiAll('categories?select=category_code,name,full_path,root_name,last_list_at,last_detail_at&order=full_path') || [];
    const today = kstDateStr(new Date());
    rows.forEach((r) => { r.status = catStatus(r, today); });
    state.catStatusRows = rows;
    renderCategories();
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

function renderCategories() {
  const box = $('#catGroups');
  try {
    const rows = state.catStatusRows || [];
    const favOnly = $('#catFavOnly').checked;
    const list = favOnly ? rows.filter((r) => state.favCatCodes.has(r.category_code)) : rows;

    const groups = {};
    list.forEach((r) => {
      const g = r.root_name || (r.full_path || '').split('>')[0] || '기타';
      (groups[g] = groups[g] || []).push(r);
    });

    const counts = { collected: 0, partial: 0, stale: 0, never: 0 };
    list.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    $('#catSummary').textContent =
      `전체 ${list.length}개 · 오늘 완료 ${counts.collected} · 목록만 ${counts.partial} · 과거 ${counts.stale} · 미수집 ${counts.never}`;

    box.innerHTML = Object.keys(groups).sort().map((g) => {
      const items = groups[g];
      const c = items.filter((x) => x.status === 'collected').length;
      return `
<div class="cat-group">
  <div class="cat-group-head">
    <svg class="caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
    <h3>${esc(g)}</h3>
    <div class="cat-stat">
      <span>${items.length}개</span>
      <span class="pos">완료 ${c}</span>
    </div>
  </div>
  <div class="cat-items">
    ${items.map((r) => `
    <div class="cat-chip" data-code="${esc(r.category_code)}" data-name="${esc(r.name)}">
      <i class="dot s-${r.status}"></i>
      <div class="cat-name">
        <div class="ellipsis">${esc(r.name)}</div>
        <div class="cat-path" title="${esc(r.full_path || '')}">${esc(r.full_path || '')}</div>
        <div class="cat-date">${
          r.last_detail_at ? new Date(r.last_detail_at).toLocaleDateString('ko-KR')
          : (r.last_list_at ? new Date(r.last_list_at).toLocaleDateString('ko-KR') + ' (목록)' : '미수집')
        }</div>
      </div>
      <button class="star cat-star ${state.favCatCodes.has(r.category_code) ? 'on' : ''}" data-code="${esc(r.category_code)}" title="즐겨찾기">
        <svg viewBox="0 0 24 24"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>
      </button>
      ${AUTH.isAdmin ? `<button class="icon-btn cat-del" data-code="${esc(r.category_code)}" data-name="${esc(r.name)}" title="삭제">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>
      </button>` : ''}
    </div>`).join('')}
  </div>
</div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#catGroups').addEventListener('click', async (ev) => {
  const star = ev.target.closest('.cat-star');
  if (star) {
    ev.stopPropagation();
    const code = star.dataset.code;
    const on = !star.classList.contains('on');
    star.classList.toggle('on', on);
    try {
      if (on) {
        await api('user_category_favorites', {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
          body: [{ user_id: AUTH.userId, category_code: code }]
        });
        state.favCatCodes.add(code);
      } else {
        await api(`user_category_favorites?category_code=eq.${encodeURIComponent(code)}&user_id=eq.${AUTH.userId}`,
                  { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        state.favCatCodes.delete(code);
      }
    } catch (e) {
      star.classList.toggle('on', !on);
      toast('실패: ' + e.message, 3500);
    }
    return;
  }

  const del = ev.target.closest('.cat-del');
  if (del) {
    ev.stopPropagation();
    const code = del.dataset.code, name = del.dataset.name;
    if (!confirm(`"${name}" 카테고리를 삭제하시겠습니까?\n\n이 카테고리로 수집된 상품 데이터도 함께 삭제됩니다.`)) return;
    try {
      await api(`categories?category_code=eq.${encodeURIComponent(code)}`, {
        method: 'DELETE', headers: { prefer: 'return=minimal' }
      });
      del.closest('.cat-chip').remove();
      selectedCats.delete(code);
      if (state.catStatusRows) state.catStatusRows = state.catStatusRows.filter((r) => r.category_code !== code);
      toast(`"${name}" 카테고리를 삭제했습니다`);
    } catch (e) {
      toast('삭제 실패: ' + e.message, 4000);
    }
    return;
  }

  const head = ev.target.closest('.cat-group-head');
  if (head) { head.parentElement.classList.toggle('open'); return; }

  const chip = ev.target.closest('.cat-chip');
  if (chip) {
    const code = chip.dataset.code;
    if (selectedCats.has(code)) { selectedCats.delete(code); chip.classList.remove('sel'); }
    else { selectedCats.add(code); chip.classList.add('sel'); }
    $('#catSelCount').textContent = selectedCats.size;
    const none = selectedCats.size === 0;
    $('#catQueueBtn').classList.toggle('hidden', none);
    $('#catDeleteBtn').classList.toggle('hidden', none || !AUTH.isAdmin);
  }
});

$('#catFavOnly').onchange = renderCategories;

$('#catDeleteBtn').onclick = async () => {
  if (!selectedCats.size) return;
  const n = selectedCats.size;
  if (!confirm(`선택한 ${n}개 카테고리를 삭제하시겠습니까?\n\n해당 카테고리로 수집된 상품 데이터도 함께 삭제됩니다.`)) return;
  try {
    const codes = Array.from(selectedCats).map(encodeURIComponent).join(',');
    await api(`categories?category_code=in.(${codes})`, {
      method: 'DELETE', headers: { prefer: 'return=minimal' }
    });
    selectedCats.clear();
    $('#catSelCount').textContent = '0';
    $('#catQueueBtn').classList.add('hidden');
    $('#catDeleteBtn').classList.add('hidden');
    toast(`${n}개 카테고리를 삭제했습니다`);
    loadCategories(true);
  } catch (e) {
    toast('삭제 실패: ' + e.message, 4000);
  }
};

$('#catQueueBtn').onclick = async () => {
  if (!selectedCats.size) return;
  try {
    const chips = Array.from(selectedCats).map((code) => {
      const el = document.querySelector(`.cat-chip[data-code="${CSS.escape(code)}"]`);
      return {
        requested_by: AUTH.userId,
        category_code: code,
        category_name: el ? el.dataset.name : '',
        job_type: 'full'
      };
    });
    await api('collect_queue', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: chips
    });
    toast(`${chips.length}건을 수집 대기열에 등록했습니다`);
    selectedCats.clear();
    $$('.cat-chip.sel').forEach((c) => c.classList.remove('sel'));
    $('#catQueueBtn').classList.add('hidden');
  } catch (e) {
    toast('등록 실패: ' + e.message, 4000);
  }
};

/* ===================== 대기열 ===================== */
async function loadQueue() {
  const box = $('#queueList');
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';
  try {
    const rows = await api('collect_queue?select=*&order=status,priority.desc,requested_at&limit=200') || [];
    const pend = rows.filter((r) => r.status === 'pending').length;
    $('#queueSummary').textContent = `전체 ${rows.length}건 · 대기 ${pend}건`;

    if (!rows.length) { box.innerHTML = '<div class="empty"><p>대기열이 비어 있습니다</p></div>'; return; }

    const label = { pending: '대기', running: '진행중', done: '완료', failed: '실패', cancelled: '취소' };
    box.innerHTML = rows.map((r) => `
<div class="queue-item">
  <span class="q-status q-${r.status}">${label[r.status] || r.status}</span>
  <div style="flex:1;min-width:0">
    <div class="ellipsis">${esc(r.category_name || r.category_code)}</div>
    <div class="muted xs">${new Date(r.requested_at).toLocaleString('ko-KR')}${
      r.result_count != null ? ` · ${r.result_count}건 수집` : ''}${
      r.error_message ? ` · ${esc(r.error_message)}` : ''}</div>
  </div>
  ${r.status === 'pending'
    ? `<button class="btn btn-sm btn-ghost q-cancel" data-id="${r.id}">취소</button>` : ''}
</div>`).join('');
  } catch (e) {
    box.innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
  }
}

$('#queueList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.q-cancel');
  if (!btn) return;
  try {
    await api(`collect_queue?id=eq.${btn.dataset.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { status: 'cancelled' }
    });
    loadQueue();
  } catch (e) { toast('취소 실패: ' + e.message, 3500); }
});

$('#queueRefresh').onclick = loadQueue;
