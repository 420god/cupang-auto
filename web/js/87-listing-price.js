/* ============================================================
   87-listing-price.js — 옵션·가격
   ------------------------------------------------------------
   **이 화면은 값을 처음 만드는 자리가 아니다.** 옵션 구성·판매가·1688 단가는
   원래 소싱 단계에서 판단이 끝나는 것들이다(사용자 확인 2026-08-21).
   다만 지금 소싱 화면에 그 값을 담을 칸이 아직 없어서, 당분간 여기서 직접 넣는다.
   소싱 쪽이 완성되면 같은 칸이 price_source='sourcing' 으로 채워져 들어오고
   사람은 확인만 하면 된다 — 표(031)는 이미 그 모양이다.

   **원가는 추정치다**(R-05). 여기 적는 1688 단가·개당 원가는 소싱 시점의 감이고,
   확정 원가는 발주 후 구매대행 청구서에서 온다(inventory_lots). 확정값이 나와도
   이 값을 덮지 않는다 — 덮으면 "내 추정이 얼마나 틀렸나"를 영영 못 본다.

   파일 순서 주의(D-17): 86 뒤, 90 앞. 86의 lstFetchOne·lstStepBar 를 쓴다.
   ============================================================ */

const LP = { p: null, items: [], removed: [], seq: 0, mandatory: [] };

const LP_SIZES = [['MINI', '극소형'], ['SMALL', '소형'], ['MEDIUM', '중형'],
                  ['LARGE1', '대형1'], ['LARGE2', '대형2'], ['XLARGE', '특대형']];

async function loadListingPrice() {
  /* 마진 계산에 필요한 상태(수수료율·입출고비 표·설정)를 기다린다.
     안 기다리면 첫 렌더가 전부 "수수료 정보 없음"으로 굳는다 — 2026-08-13에
     소싱 탭에서 실제로 났던 버그다. */
  const ready = state.readyForMargins || Promise.resolve();

  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#lpItems').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031_listing_pipeline.sql</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    $('#lpSteps').innerHTML = '';
    return;
  }

  lstFillPicker($('#lpPicker'), rows);
  await ready;
  await lpLoadCurrent();
}

async function lpLoadCurrent() {
  const id = LISTING.currentId;
  const box = $('#lpItems');
  if (!id) {
    box.innerHTML = '<p class="muted">준비 중인 상품이 없습니다 — '
      + '소싱 → 즐겨찾기에서 [등록 준비]를 누르거나, 상품등록 화면에서 새로 만드세요.</p>';
    $('#lpSteps').innerHTML = '';
    $('#lpSummary').textContent = '—';
    return;
  }
  box.innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  const { p, items, prog } = await lstFetchOne(id);
  LP.p = p;
  LP.items = items;
  LP.removed = [];

  $('#lpSteps').innerHTML = lstStepBar(prog, 'price');
  lstGuardCategory(p, $('#lpItems'));

  /* 카테고리의 필수속성을 읽어둔다 — 옵션 칸과 옵션명이 여기서 나온다.
     카테고리가 없으면 빈 배열이고, 화면이 그 사실을 말한다(R-15). */
  LP.mandatory = [];
  if (p && p.display_category_code) {
    try {
      const m = (await api('coupang_category_meta?select=raw&display_category_code=eq.'
        + encodeURIComponent(p.display_category_code) + '&limit=1'))[0];
      LP.mandatory = (((m || {}).raw || {}).attributes || [])
        .filter((a) => a.required === 'MANDATORY');
    } catch (e) { /* 029 미실행 */ }
  }
  $('#lpSummary').textContent = (p && p.product_name)
    ? `${p.product_name} · 옵션 ${items.length}개`
    : `옵션 ${items.length}개`;

  /* 카테고리가 아직이면 마진을 못 낸다. **그 사실을 먼저 말한다**(R-15) —
     0원이나 빈칸으로 두면 사람이 "마진이 0인가 보다"라고 읽는다. */
  const cat = p && p.display_category_code;
  $('#lpHint').innerHTML = cat
    ? `카테고리 <b>${esc(p.category_path || cat)}</b> 기준으로 예상 마진을 계산합니다.`
    : '카테고리를 아직 안 정해서 <b>예상 마진을 계산할 수 없습니다</b> — '
      + '판매수수료와 입출고비가 카테고리에서 나옵니다. 카테고리 화면에서 정한 뒤 다시 보세요.';

  box.innerHTML = items.map((it) => lpItemCard(it)).join('');
  $$('#lpItems [data-lp]').forEach((row) => {
    lpCalc(row);
    /* 지금 저장된 속성으로 만들어지는 이름을 기억해둔다 — 이게 "자동으로 만든 이름"의
       기준이 된다. 사람이 다른 이름을 써두면 속성을 바꿔도 안 덮인다. */
    row.dataset.lastAuto = lpNameFromAttrs(row);
  });

  const last = await lstLastNote(id, 'price');
  $('#lpNote').value = '';
  $('#lpNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';
}

/* 카테고리의 **필수속성** 칸. 실측으로 확인한 것(2026-08-21):
   옵션명은 이 값들의 조합이다 — `색상=감자색 · 개당 중량=70g · 수량=1개` → "감자색 70g 1개".
   그래서 여기서 값을 받고 옵션명을 만들어준다. 그동안은 옵션명만 받고 등록할 때
   **추측으로**(색상←옵션명) 채웠는데, 그러면 복제 원본 값이 그대로 나가는 사고가 났다. */
function lpAttrFields(it) {
  if (!LP.mandatory.length) {
    return '<p class="muted sm">이 카테고리의 필수속성 목록을 아직 안 받았습니다 — '
      + '카테고리 화면에서 [지금 받기]를 누르면 여기에 칸이 생깁니다.</p>';
  }
  const cur = it.attributes || {};
  return '<div class="lf-grid">' + LP.mandatory.map((a) => {
    const nm = a.attributeTypeName;
    const raw = cur[nm] == null ? '' : String(cur[nm]);
    const units = (a.usableUnits && a.usableUnits.length) ? a.usableUnits
      : ((a.basicUnit && a.basicUnit !== '없음') ? [a.basicUnit] : []);
    let control;
    if (a.inputType === 'SELECT' && (a.inputValues || []).length) {
      control = `<select class="lp-attr" data-attr="${esc(nm)}">
        <option value="">선택안함</option>
        ${a.inputValues.map((x) => `<option${x === raw ? ' selected' : ''}>${esc(x)}</option>`).join('')}
      </select>`;
    } else if (units.length) {
      const m = raw.match(/^\s*([\d.]+)\s*(.*)$/);
      control = `<div class="range">
        <input class="lp-attr" data-attr="${esc(nm)}" type="number" step="any"
               value="${esc(m ? m[1] : '')}" placeholder="숫자" />
        <select class="lp-attr-unit" style="max-width:88px">
          ${units.map((u) => `<option${u === ((m && m[2]) || units[0]) ? ' selected' : ''}>${esc(u)}</option>`).join('')}
        </select></div>`;
    } else {
      control = `<input class="lp-attr" data-attr="${esc(nm)}" type="text" value="${esc(raw)}"
                        placeholder="직접 입력" />`;
    }
    return `<label class="field"><span>${esc(nm)} <span class="neg">·</span></span>${control}</label>`;
  }).join('') + '</div>';
}

/* 필수속성 값을 옵션명으로 합친다. 메타에 적힌 순서를 그대로 따른다 —
   실측 상품이 그 순서였다(색상 → 개당 중량 → 수량 = "감자색 70g 1개"). */
function lpNameFromAttrs(row) {
  const parts = [];
  LP.mandatory.forEach((a) => {
    const el = row.querySelector(`.lp-attr[data-attr="${a.attributeTypeName}"]`);
    if (!el) return;
    const v = (el.value || '').trim();
    if (!v) return;
    const unitEl = el.parentNode.querySelector('.lp-attr-unit');
    parts.push(unitEl ? v + unitEl.value : v);
  });
  return parts.join(' ');
}

function lpItemCard(it) {
  const k = 'lp' + (LP.seq++);
  const v = (x) => (x == null ? '' : esc(String(x)));
  return `<div class="lp-card" data-lp="${k}" data-id="${it.id ? esc(it.id) : ''}">
    <div class="lp-card-head">
      <input class="lp-name" type="text" placeholder="옵션명 (속성을 넣으면 자동으로 만들어집니다)"
             value="${v(it.item_name)}" />
      <button class="btn btn-sm lp-rename" title="필수속성으로 옵션명을 다시 만듭니다">이름 만들기</button>
      <button class="btn btn-sm btn-ghost lp-del" title="이 옵션을 지웁니다">삭제</button>
    </div>

    <h4 class="sku-sec">필수속성 <span class="muted sm">— 이 값들이 합쳐져 옵션명이 됩니다</span></h4>
    ${lpAttrFields(it)}

    <div class="two">
      <label class="field"><span>로켓그로스 판매가 (원)</span>
        <input class="lp-price" type="number" min="0" step="10" value="${v(it.sale_price)}" /></label>
      <label class="field"><span>판매자배송 판매가 (원) <span class="muted">없으면 비움</span></span>
        <input class="lp-mprice" type="number" min="0" step="10" value="${v(it.marketplace_sale_price)}" /></label>
    </div>

    <div class="two">
      <label class="field"><span>크기 등급 <span class="muted">입출고비 구간</span></span>
        <select class="lp-size">${LP_SIZES.map(([code, name]) =>
          `<option value="${code}"${(it.size_type || settings.size) === code ? ' selected' : ''}>${name}</option>`).join('')}</select></label>
      <label class="field"><span>MOQ (최소주문수량)</span>
        <input class="lp-moq" type="number" min="1" value="${v(it.supplier_moq)}" /></label>
    </div>

    <div class="two">
      <!-- 추정치임을 칸 이름에 적어둔다. 나중에 확정 원가와 나란히 볼 때 헷갈리면 안 된다 -->
      <label class="field"><span>1688 단가 (CNY) <span class="muted">추정</span></span>
        <input class="lp-cny" type="number" min="0" step="0.01" value="${v(it.supplier_price_cny)}" /></label>
      <label class="field"><span>추정 개당 원가 (원) <span class="muted">비우면 단가×환율</span></span>
        <input class="lp-cost" type="number" min="0" value="${v(it.est_unit_cost_krw)}" /></label>
    </div>

    <p class="sm lp-margin">—</p>

    <details class="lp-more"${it.supplier_offer_url ? ' open' : ''}>
      <summary>1688 공급처</summary>
      <label class="field"><span>상품 링크</span>
        <input class="lp-url" type="url" placeholder="https://detail.1688.com/offer/..."
               value="${v(it.supplier_offer_url)}" /></label>
      <div class="two">
        <label class="field"><span>옵션1 (중국어)</span>
          <input class="lp-cn1" type="text" value="${v(it.supplier_option1_cn)}" /></label>
        <label class="field"><span>옵션2 (중국어)</span>
          <input class="lp-cn2" type="text" value="${v(it.supplier_option2_cn)}" /></label>
      </div>
      <label class="field"><span>판매자 ID</span>
        <input class="lp-seller" type="text" value="${v(it.supplier_seller_id)}" /></label>
    </details>
  </div>`;
}

/* 예상 마진. **계산 못 하는 이유를 말한다** — 소싱 탭과 같은 규칙이다.
   전역 가정치로 때우지 않는다(수수료 정보 없음이면 그렇게 쓴다). */
function lpCalc(row) {
  const el = row.querySelector('.lp-margin');
  const price = Number(row.querySelector('.lp-price').value);
  const cat = LP.p && LP.p.display_category_code;

  if (!Number.isFinite(price) || price <= 0) { el.textContent = '판매가를 넣으면 예상 마진을 계산합니다'; el.className = 'sm lp-margin muted'; return; }
  if (!cat) { el.textContent = '카테고리 미정 — 예상 마진 계산 불가'; el.className = 'sm lp-margin muted'; return; }

  const commission = commissionFor(cat);
  if (commission === null) {
    el.textContent = '수수료 정보 없음 — 이 카테고리는 요율이 매칭되지 않았습니다';
    el.className = 'sm lp-margin muted';
    return;
  }

  const size = row.querySelector('.lp-size').value || settings.size;
  const fee = feeFor(cat, size, price);
  const costKrw = Number(row.querySelector('.lp-cost').value) || null;
  const costCny = Number(row.querySelector('.lp-cny').value) || null;

  const c = calcMargin({ price, commission, fulfillment: fee, costKrw, costCny });
  if (!c) { el.textContent = '계산 불가'; el.className = 'sm lp-margin muted'; return; }

  if (c.margin === null) {
    el.textContent = `수수료 ${won(c.commission)} · 입출고비 ${fee == null ? '표 없음' : won(c.fulfillment)}`
      + ' · 원가를 넣으면 마진이 나옵니다';
    el.className = 'sm lp-margin muted';
    return;
  }

  /* 입출고비 표가 없으면 0으로 계산된다 — 그러면 마진이 실제보다 **좋게** 나온다.
     조용히 넘기면 잘못된 판단으로 이어지므로 표시에 붙인다. */
  const feeTxt = fee == null ? '입출고비 표 없음(0으로 계산)' : `입출고비 ${won(c.fulfillment)}`;
  el.className = 'sm lp-margin ' + (c.rate >= 0 ? 'pos' : 'neg');
  el.textContent = `예상 마진 ${won(c.margin)} (${c.rate}%) · 수수료 ${won(c.commission)}`
    + ` · ${feeTxt} · 원가 ${won(c.cost)}${costKrw === null && costCny ? ` (단가×${settings.rate})` : ''}`
    + ` · 출고·작업비 ${won(c.shipWork)}`;
}

/* 값이 바뀌면 그 줄만 다시 계산한다 */
$('#lpItems').addEventListener('input', (ev) => {
  const row = ev.target.closest('[data-lp]');
  if (row) lpCalc(row);
});
$('#lpItems').addEventListener('change', (ev) => {
  const row = ev.target.closest('[data-lp]');
  if (!row) return;
  lpCalc(row);
  /* 속성을 건드렸으면 옵션명을 다시 만든다. **사람이 직접 쓴 이름은 안 건드린다** —
     비어 있거나, 직전 속성 조합과 똑같을 때만 갈아끼운다. */
  if (ev.target.matches('.lp-attr, .lp-attr-unit')) {
    const nameEl = row.querySelector('.lp-name');
    const cur = (nameEl.value || '').trim();
    if (!cur || cur === row.dataset.lastAuto) {
      const made = lpNameFromAttrs(row);
      nameEl.value = made;
      row.dataset.lastAuto = made;
    }
  }
});

/* [이름 만들기] — 사람이 고친 이름도 이 버튼을 누르면 속성 조합으로 덮는다 */
$('#lpItems').addEventListener('click', (ev) => {
  if (!ev.target.matches('.lp-rename')) return;
  const row = ev.target.closest('[data-lp]');
  const made = lpNameFromAttrs(row);
  if (!made) { toast('필수속성을 먼저 채우세요'); return; }
  row.querySelector('.lp-name').value = made;
  row.dataset.lastAuto = made;
});

/* 삭제는 화면에서만 빼고, 저장할 때 실제로 지운다 — 실수로 누른 걸 되돌릴 수 있게 */
$('#lpItems').addEventListener('click', (ev) => {
  if (!ev.target.closest('.lp-del')) return;
  const row = ev.target.closest('[data-lp]');
  const id = row.dataset.id;
  if ($$('#lpItems [data-lp]').length <= 1) {
    toast('옵션은 최소 하나 필요합니다');
    return;
  }
  if (id) LP.removed.push(id);
  row.remove();
});

$('#lpAddItem').onclick = () => {
  $('#lpItems').insertAdjacentHTML('beforeend', lpItemCard({}));
  const rows = $$('#lpItems [data-lp]');
  lpCalc(rows[rows.length - 1]);
};

$('#lpPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await lpLoadCurrent();
});

/* ---------- 저장 ---------- */
$('#lpSave').onclick = async () => {
  if (!LP.p) return;
  const btn = $('#lpSave');
  const msg = $('#lpMsg');
  btn.disabled = true;
  msg.classList.remove('hidden');
  msg.textContent = '저장 중…';

  try {
    const rows = $$('#lpItems [data-lp]');
    const numOrNull = (el) => { const v = Number(el.value); return el.value === '' || !Number.isFinite(v) ? null : v; };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const body = {
        position: i,
        item_name: (row.querySelector('.lp-name').value || '').trim() || null,
        sale_price: numOrNull(row.querySelector('.lp-price')),
        marketplace_sale_price: numOrNull(row.querySelector('.lp-mprice')),
        size_type: row.querySelector('.lp-size').value || null,
        supplier_moq: numOrNull(row.querySelector('.lp-moq')),
        supplier_price_cny: numOrNull(row.querySelector('.lp-cny')),
        est_unit_cost_krw: numOrNull(row.querySelector('.lp-cost')),
        supplier_offer_url: (row.querySelector('.lp-url').value || '').trim() || null,
        supplier_option1_cn: (row.querySelector('.lp-cn1').value || '').trim() || null,
        supplier_option2_cn: (row.querySelector('.lp-cn2').value || '').trim() || null,
        supplier_seller_id: (row.querySelector('.lp-seller').value || '').trim() || null,
        /* 필수속성. 단위를 붙여서 담는다(실측 형태: "70g" · "1개") */
        attributes: (function () {
          const out = {};
          row.querySelectorAll('.lp-attr').forEach((el) => {
            const v = (el.value || '').trim();
            if (!v) return;
            const u = el.parentNode.querySelector('.lp-attr-unit');
            out[el.dataset.attr] = u ? v + u.value : v;
          });
          return out;
        })()
      };
      if (row.dataset.id) {
        await api(`listing_project_items?id=eq.${row.dataset.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body
        });
      } else {
        body.project_id = LP.p.id;
        const [made] = await api('listing_project_items', {
          method: 'POST', headers: { prefer: 'return=representation' }, body
        });
        row.dataset.id = made.id;
      }
    }

    for (const id of LP.removed) {
      await api(`listing_project_items?id=eq.${id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    }
    LP.removed = [];

    /* 근거는 적었을 때만 남긴다. 빈 행을 쌓으면 나중에 읽을 때 잡음이 된다. */
    const note = ($('#lpNote').value || '').trim();
    if (note) await lstAddNote(LP.p.id, 'price', note);

    msg.textContent = '저장했습니다.';
    toast('저장했습니다');
    await lpLoadCurrent();
  } catch (e) {
    msg.textContent = '저장 실패: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};
