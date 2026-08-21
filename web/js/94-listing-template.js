/* ============================================================
   94-listing-template.js — 뼈대 (배송·반품지·과세·고시정보·인증)
   ------------------------------------------------------------
   **이미 등록에 성공한 상품에서 뜬다.** 새로 만드는 것보다 확실하다 —
   쿠팡이 받아준 실제 값이기 때문이다. 뜬 뒤에 고칠 수 있다(사용자 요청 2026-08-21).

   실측(2026-08-21)으로 확인한 뼈대의 구성:
     상품 단위  marketplaceShippingAndReturnInfo (18키) · bundleInfo ·
                registrationType · vendorUserId · requiredDocuments
     옵션 단위  taxType · adultOnly · pccNeeded · unitCount · offerCondition ·
                parallelImported · overseasPurchased · maximumBuy* ·
                outboundShippingTime(Day) · sameDayShipping · certifications ·
                notices(고시정보) · attributes(필수속성)

   **notices/attributes 는 값이 상품마다 다르다** — 품명은 상품명이고 색상은 옵션명이다.
   그래서 뼈대에는 **틀**로 들어가고, 등록할 때 준비 건의 값으로 덮어쓴다.
   여기서는 그 틀을 보고 고칠 수 있게만 한다.

   enum 코드값(CJGLS · SEQUENCIAL · TAX …)은 **우리가 목록을 모른다.** 그래서 select 로
   좁히지 않고 텍스트로 둔다 — 모르는 목록을 만들어 넣으면 쓸 수 있는 값을 막게 된다(R-14).

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LT = { list: [], cur: null, sources: [] };

/* 뼈대로 가져올 키 목록. **여기 없는 키는 템플릿에 안 담긴다** —
   상품마다 달라야 하는 값(이름·가격·이미지·바코드)이 딸려 들어오면 사고가 난다. */
const LT_PRODUCT_KEYS = ['marketplaceShippingAndReturnInfo', 'bundleInfo', 'registrationType',
                         'vendorUserId', 'requiredDocuments', 'productGroup', 'contributorType'];
const LT_ITEM_KEYS = ['taxType', 'adultOnly', 'pccNeeded', 'unitCount', 'offerCondition',
                      'offerDescription', 'parallelImported', 'overseasPurchased',
                      'maximumBuyCount', 'maximumBuyForPerson', 'maximumBuyForPersonPeriod',
                      'outboundShippingTime', 'outboundShippingTimeDay', 'sameDayShipping',
                      'certifications', 'notices', 'attributes'];

/* 폼으로 열어줄 것들. 나머지는 아래 [원문 편집]에서 고친다. */
const LT_SHIP_FIELDS = [
  ['deliveryCompanyCode', '택배사 코드', 'text'],
  ['deliveryMethod', '배송 방법', 'text'],
  ['deliveryChargeType', '배송비 종류', 'text'],
  ['deliveryCharge', '배송비', 'number'],
  ['freeShipOverAmount', '무료배송 기준액', 'number'],
  ['deliveryChargeOnReturn', '반품 시 배송비', 'number'],
  ['returnCharge', '반품비', 'number'],
  ['remoteAreaDeliverable', '도서산간 배송', 'text'],
  ['unionDeliveryType', '묶음배송', 'text'],
  ['outboundShippingPlaceCode', '출고지 코드', 'number'],
  ['returnCenterCode', '반품지 코드', 'text'],
  ['returnChargeName', '반품지 이름', 'text'],
  ['returnZipCode', '반품지 우편번호', 'text'],
  ['returnAddress', '반품지 주소', 'text'],
  ['returnAddressDetail', '반품지 상세주소', 'text'],
  ['companyContactNumber', '연락처', 'text']
];
const LT_ITEM_FIELDS = [
  ['taxType', '과세 유형', 'text'],
  ['adultOnly', '성인 전용', 'text'],
  ['offerCondition', '상품 상태', 'text'],
  ['unitCount', '수량(단위)', 'number'],
  ['outboundShippingTimeDay', '출고 소요일', 'number'],
  ['maximumBuyCount', '최대 구매수량', 'number'],
  ['maximumBuyForPerson', '1인 최대 구매', 'number'],
  ['maximumBuyForPersonPeriod', '1인 제한 기간(일)', 'number'],
  ['parallelImported', '병행수입', 'text'],
  ['overseasPurchased', '해외구매대행', 'text']
];

async function loadListingTemplate() {
  try {
    LT.list = await api('listing_templates?select=*&order=is_default.desc,updated_at.desc') || [];
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#ltList').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }

  /* 뼈대를 뜰 수 있는 상품 = 원문을 받아둔 상품. 안 받아둔 건 고를 수 없다(R-15). */
  try {
    const regs = await api('rocket_growth_product_registry?select=seller_product_id,product_json'
      + '&product_json=not.is.null') || [];
    const seen = {};
    LT.sources = regs.filter((r) => {
      if (seen[r.seller_product_id]) return false;
      seen[r.seller_product_id] = 1;
      return true;
    });
  } catch (e) { LT.sources = []; }

  $('#ltSource').innerHTML = LT.sources.length
    ? LT.sources.map((r) => `<option value="${esc(r.seller_product_id)}">${
        esc((r.product_json.sellerProductName || r.seller_product_id).slice(0, 40))}</option>`).join('')
    : '<option value="">원문을 받아둔 상품이 없습니다</option>';

  ltRenderList();
  /* 고른 게 있으면 그걸, 없으면 첫 번째를 연다. **다시 불러온 뒤에도 열려 있어야 한다** —
     저장하고 나면 편집칸이 사라지는 것처럼 보인다. */
  const keep = LT.list.some((t) => t.id === LT.cur) ? LT.cur : (LT.list[0] && LT.list[0].id);
  if (keep) ltOpen(keep);
  else {
    LT.cur = null;
    $('#ltEdit').innerHTML =
      '<p class="muted">아직 뼈대가 없습니다. 위에서 기존 상품을 고르고 [이 상품에서 뼈대 뜨기]를 누르세요.</p>';
  }

  /* 지금 작업 중인 준비 건에 어떤 뼈대가 붙어 있는지 */
  await ltRenderTarget();
}

function ltRenderList() {
  $('#ltList').innerHTML = LT.list.length
    ? LT.list.map((t) => `<button class="btn btn-sm lt-open ${LT.cur === t.id ? 'btn-primary' : ''}"
        data-id="${esc(t.id)}">${esc(t.name)}${t.is_default ? ' ★' : ''}</button>`).join(' ')
    : '<span class="muted sm">뼈대 없음</span>';
}

/* ---------- 뼈대 뜨기 ---------- */
$('#ltMake').onclick = async () => {
  const spid = $('#ltSource').value;
  if (!spid) return;
  const src = LT.sources.find((r) => String(r.seller_product_id) === String(spid));
  if (!src) return;
  const pj = src.product_json;
  const it = (pj.items || [])[0] || {};

  const payload = { product: {}, item: {} };
  LT_PRODUCT_KEYS.forEach((k) => { if (pj[k] !== undefined) payload.product[k] = pj[k]; });
  LT_ITEM_KEYS.forEach((k) => { if (it[k] !== undefined) payload.item[k] = it[k]; });

  const name = ($('#ltName').value || '').trim()
    || `${(pj.sellerProductName || '').slice(0, 16)} 뼈대`;
  const btn = $('#ltMake');
  btn.disabled = true;
  try {
    const [made] = await api('listing_templates', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: { name, source_seller_product_id: String(spid), payload,
              is_default: LT.list.length === 0, created_by: AUTH.userId || null }
    });
    $('#ltName').value = '';
    toast('뼈대를 떴습니다 — 값을 확인하고 고치세요');
    LT.cur = made.id;
    await loadListingTemplate();
  } catch (e) {
    toast('만들지 못했습니다: ' + e.message);
  } finally { btn.disabled = false; }
};

$('#ltList').addEventListener('click', (ev) => {
  const b = ev.target.closest('.lt-open');
  if (b) ltOpen(b.dataset.id);
});

function ltOpen(id) {
  LT.cur = id;
  ltRenderList();
  const t = LT.list.find((x) => x.id === id);
  if (!t) return;
  const ship = (t.payload.product || {}).marketplaceShippingAndReturnInfo || {};
  const item = t.payload.item || {};
  const notices = item.notices || [];
  const certs = item.certifications || [];
  const attrs = item.attributes || [];

  const field = (obj, [k, label, type]) => `<label class="field"><span>${esc(label)}
      <span class="muted xs">${esc(k)}</span></span>
      <input class="lt-f" data-scope="${obj}" data-key="${esc(k)}" type="${type}"
             value="${obj === 'ship' ? esc(ship[k] == null ? '' : ship[k]) : esc(item[k] == null ? '' : item[k])}" /></label>`;

  $('#ltEdit').innerHTML = `
    <div class="lp-card">
      <div class="lp-card-head">
        <input id="ltRename" class="lt-name" type="text" value="${esc(t.name)}" style="flex:1;font-weight:600" />
        <label class="chk"><input type="checkbox" id="ltDefault" ${t.is_default ? 'checked' : ''} />
          <span>기본 뼈대</span></label>
        <button id="ltSave" class="btn btn-sm btn-primary">저장</button>
        <button id="ltDelete" class="btn btn-sm btn-ghost">삭제</button>
      </div>
      <p class="muted sm">출처: 상품 ${esc(t.source_seller_product_id || '—')} ·
        만든 날 ${esc(String(t.created_at).slice(0, 10))}</p>

      <h4 class="sku-sec">배송 · 반품지</h4>
      <div class="two">${LT_SHIP_FIELDS.map((f) => field('ship', f)).join('')}</div>

      <h4 class="sku-sec">옵션 공통</h4>
      <div class="two">${LT_ITEM_FIELDS.map((f) => field('item', f)).join('')}</div>
      <p class="muted sm">코드값(<code>CJGLS</code> · <code>SEQUENCIAL</code> · <code>TAX</code> …)은
        쿠팡이 정한 것입니다. <b>우리가 전체 목록을 모르니 모르면 그대로 두세요.</b></p>

      <h4 class="sku-sec">고시정보 <span class="muted sm">${esc((notices[0] || {}).noticeCategoryName || '')}</span></h4>
      ${notices.length ? notices.map((n, i) => `<label class="field">
          <span>${esc(n.noticeCategoryDetailName)}</span>
          <input class="lt-notice" data-i="${i}" type="text" value="${esc(n.content || '')}" /></label>`).join('')
        : '<p class="muted sm">고시정보가 비어 있습니다.</p>'}
      <p class="muted sm">품명·제조국·제조자는 <b>등록할 때 준비 건의 값으로 덮어씁니다</b> —
        여기 값은 다른 항목(소비자상담 전화번호 등)의 기본값으로만 씁니다.</p>

      <h4 class="sku-sec">인증</h4>
      ${certs.length ? certs.map((c, i) => `<label class="field">
          <span>인증 종류 <span class="muted xs">certificationType</span></span>
          <input class="lt-cert" data-i="${i}" type="text" value="${esc(c.certificationType || '')}" /></label>`).join('')
        : '<p class="muted sm">인증 정보가 없습니다.</p>'}

      <h4 class="sku-sec">필수속성 <span class="muted sm">${attrs.length}개</span></h4>
      <p class="muted sm"><b>필수속성은 카테고리마다 다릅니다.</b> 이 뼈대는 원본 상품의
        카테고리 기준이라, 카테고리가 다르면 안 맞습니다 — 등록할 때 카테고리 메타로 대조합니다.</p>
      <div class="kv-grid">${attrs.slice(0, 12).map((a) => `<span class="kv">
        <span class="kv-k">${esc(a.attributeTypeName)}</span>
        <span class="kv-v">${esc(a.attributeValueName || '—')}</span></span>`).join('')}</div>

      <details style="margin-top:12px">
        <summary class="muted sm">원문 편집 (고급) — 위 폼에 없는 필드까지 전부</summary>
        <textarea id="ltRaw" rows="14" style="width:100%;font-family:monospace;font-size:12px">${
          esc(JSON.stringify(t.payload, null, 1))}</textarea>
        <p class="muted sm">여기서 고치고 [저장]을 누르면 <b>원문이 폼보다 우선</b>합니다.
          JSON이 깨져 있으면 저장하지 않습니다.</p>
      </details>
      <div id="ltMsg" class="msg hidden"></div>
    </div>`;

  $('#ltSave').onclick = () => ltSave(t);
  $('#ltDelete').onclick = () => ltDelete(t);
}

async function ltSave(t) {
  const msg = $('#ltMsg');
  msg.classList.remove('hidden');
  msg.textContent = '저장 중…';
  try {
    /* 원문을 건드렸으면 그걸 쓴다 — 폼은 일부만 열어놨으므로 원문이 더 넓다. */
    let payload;
    const raw = ($('#ltRaw').value || '').trim();
    const original = JSON.stringify(t.payload, null, 1);
    if (raw && raw !== original) {
      try { payload = JSON.parse(raw); }
      catch (e) { msg.textContent = 'JSON이 깨져 있어 저장하지 않았습니다: ' + e.message; return; }
    } else {
      payload = JSON.parse(JSON.stringify(t.payload));
      payload.product = payload.product || {};
      payload.item = payload.item || {};
      payload.product.marketplaceShippingAndReturnInfo =
        payload.product.marketplaceShippingAndReturnInfo || {};

      $$('#ltEdit .lt-f').forEach((el) => {
        const target = el.dataset.scope === 'ship'
          ? payload.product.marketplaceShippingAndReturnInfo : payload.item;
        const v = el.value;
        /* 빈칸은 null 로 둔다 — 빈 문자열과 null 을 섞으면 쿠팡이 다르게 받는다 */
        target[el.dataset.key] = (v === '') ? null : (el.type === 'number' ? Number(v) : v);
      });
      $$('#ltEdit .lt-notice').forEach((el) => {
        const i = Number(el.dataset.i);
        if (payload.item.notices && payload.item.notices[i]) payload.item.notices[i].content = el.value;
      });
      $$('#ltEdit .lt-cert').forEach((el) => {
        const i = Number(el.dataset.i);
        if (payload.item.certifications && payload.item.certifications[i]) {
          payload.item.certifications[i].certificationType = el.value;
        }
      });
    }

    const isDefault = $('#ltDefault').checked;
    /* 기본은 하나뿐이어야 한다 — 둘이면 어느 게 붙는지 사람이 모른다 */
    if (isDefault) {
      for (const other of LT.list) {
        if (other.id !== t.id && other.is_default) {
          await api(`listing_templates?id=eq.${other.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { is_default: false } });
        }
      }
    }
    await api(`listing_templates?id=eq.${t.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { name: ($('#ltRename').value || '').trim() || t.name, payload, is_default: isDefault }
    });
    msg.textContent = '저장했습니다.';
    toast('저장했습니다');
    await loadListingTemplate();
  } catch (e) {
    msg.textContent = '저장 실패: ' + e.message;
  }
}

async function ltDelete(t) {
  /* 쓰고 있는 준비 건이 있으면 못 지운다 — 지우면 그 준비 건의 뼈대가 사라진다 */
  const used = await api(`listing_projects?select=id,product_name&template_id=eq.${t.id}&limit=5`) || [];
  if (used.length) {
    toast(`이 뼈대를 쓰는 준비 건이 ${used.length}건 있어 지울 수 없습니다`);
    return;
  }
  if (!confirm(`뼈대 "${t.name}"를 지울까요?`)) return;
  await api(`listing_templates?id=eq.${t.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  LT.cur = null;
  toast('지웠습니다');
  await loadListingTemplate();
}

/* ---------- 준비 건에 붙이기 ---------- */
async function ltRenderTarget() {
  const box = $('#ltTarget');
  const id = LISTING.currentId;
  if (!id) { box.innerHTML = '<p class="muted sm">작업 중인 준비 건이 없습니다.</p>'; return; }
  const { p } = await lstFetchOne(id);
  if (!p) { box.innerHTML = ''; return; }
  const cur = LT.list.find((t) => t.id === p.template_id);
  box.innerHTML = `<div class="kv-grid">
      <span class="kv"><span class="kv-k">작업 중인 준비 건</span>
        <span class="kv-v">${esc(p.product_name || '(이름 미정)')}</span></span>
      <span class="kv"><span class="kv-k">지금 붙은 뼈대</span>
        <span class="kv-v">${cur ? esc(cur.name)
          : (p.clone_seller_product_id ? `복제 원본 ${esc(p.clone_seller_product_id)}`
            : '<span class="neg">없음</span>')}</span></span>
    </div>
    ${LT.cur ? `<button id="ltApply" class="btn btn-sm btn-primary" style="margin-top:8px">
      고른 뼈대를 이 준비 건에 쓰기</button>` : ''}`;

  const btn = $('#ltApply');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const t = LT.list.find((x) => x.id === LT.cur);
      await api(`listing_projects?id=eq.${id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { template_id: LT.cur, clone_seller_product_id: t ? t.source_seller_product_id : null }
      });
      await lstAddNote(id, 'skeleton', `뼈대 "${t ? t.name : ''}" 적용`
        + (t && t.source_seller_product_id ? ` (출처 상품 ${t.source_seller_product_id})` : ''));
      toast('뼈대를 붙였습니다');
      await ltRenderTarget();
    } catch (e) {
      toast('저장 실패: ' + e.message);
    } finally { btn.disabled = false; }
  };
}
