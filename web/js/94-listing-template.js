/* ============================================================
   94-listing-template.js — 뼈대 (두 그룹)
   ------------------------------------------------------------
   035 로 뼈대가 두 종류가 됐다(사용자 결정 2026-08-21):
     shipping  배송 · 반품/교환            계정 공통에 가깝다. 한 벌이면 된다
     notice    상품정보제공고시 · 상품주요정보  상품군마다 다르다. 여러 벌이 생긴다

   나눈 이유: 하나로 묶으면 고시정보만 다른 상품군을 추가할 때 배송·반품지까지
   복사된다. 그러면 반품지가 바뀔 때 여러 벌을 다 고쳐야 한다.

   **WING 화면(2026-08-21 캡처)의 칸을 그대로 연다.** 화면 ↔ API 대응:
     제조사            → 상품 단위 manufacture (준비 건에 있다. 여기 아님)
     상품 구성          → bundleInfo.bundleType        (실측 SINGLE)
     인증정보           → certifications[]             (실측 PRESENTED_IN_DETAIL_PAGE)
     병행수입           → parallelImported             (실측 NOT_PARALLEL_IMPORTED)
     구매 연령          → adultOnly                    (실측 EVERYONE)
     인당 최대구매수량   → maximumBuyForPerson(+Period)  (실측 0 / 1)
     판매기간           → saleStartedAt · saleEndedAt
     부가세            → taxType                      (실측 TAX)
     고시정보 표        → notices[{noticeCategoryName, noticeCategoryDetailName, content}]
     "상품 상세페이지 참조" 체크 → content 를 "상품 상세페이지 참조" 로 넣는다
        ↑ 추측이 아니다. 실측 상품의 '인증/허가 사항' 값이 정확히 그 문자열이었다.

   **반대쪽 코드값(면세·성인전용·병행수입·혼합구성)은 실물을 못 봤다.** 우리 상품이
   전부 한쪽이라 확인할 방법이 없었다. 그래서 추정값을 넣되 **고칠 수 있는 칸**으로
   두고 "미검증"이라고 적는다 — 목록을 지어내 select 로 막으면 못 쓰는 값이 생긴다(R-14).

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LT = { list: [], kind: 'shipping', cur: {}, sources: [], noticeCats: {} };

const LT_KIND_LABEL = { shipping: '배송 · 반품/교환', notice: '고시정보 · 상품주요정보' };

/* 어느 키가 어느 그룹으로 가는가. **목록에 없는 키는 안 담는다** —
   상품마다 달라야 하는 값(이름·가격·이미지·바코드)이 딸려 오면 그게 사고다. */
const LT_KEYS = {
  shipping: {
    product: ['marketplaceShippingAndReturnInfo', 'registrationType', 'vendorUserId', 'requiredDocuments'],
    item: ['outboundShippingTime', 'outboundShippingTimeDay', 'sameDayShipping']
  },
  notice: {
    product: ['bundleInfo', 'productGroup', 'contributorType', 'saleStartedAt', 'saleEndedAt'],
    item: ['taxType', 'adultOnly', 'pccNeeded', 'unitCount', 'offerCondition', 'offerDescription',
           'parallelImported', 'overseasPurchased', 'maximumBuyCount', 'maximumBuyForPerson',
           'maximumBuyForPersonPeriod', 'certifications', 'notices', 'attributes']
  }
};

const LT_DETAIL_REF = '상품 상세페이지 참조';

async function loadListingTemplate() {
  try {
    LT.list = await api('listing_templates?select=*&order=kind.asc,is_default.desc,updated_at.desc') || [];
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    const kindMiss = /kind/.test(e.message);
    $('#ltList').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031</b> 을 실행하지 않았습니다.'
      : (kindMiss ? '아직 <b>db/migrations/035_template_kinds.sql</b> 을 실행하지 않았습니다.'
                  : '불러오지 못했습니다: ' + esc(e.message))}</p>`;
    return;
  }

  /* 뼈대를 뜰 수 있는 상품 = 원문을 받아둔 상품 */
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

  /* 고시 종류 목록은 카테고리마다 다르다. 받아둔 카테고리 메타에서 모아 쓴다. */
  try {
    const metas = await api('coupang_category_meta?select=display_category_code,raw') || [];
    LT.noticeCats = {};
    metas.forEach((m) => {
      ((m.raw || {}).noticeCategories || []).forEach((nc) => {
        LT.noticeCats[nc.noticeCategoryName] =
          (nc.noticeCategoryDetailNames || []).map((d) => d.noticeCategoryDetailName);
      });
    });
  } catch (e) { LT.noticeCats = {}; }

  ltRenderTabs();
  ltRenderList();
  ltOpenCurrent();
  await ltRenderTarget();
}

function ltRenderTabs() {
  $$('#ltTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === LT.kind));
}

function ltOfKind() { return LT.list.filter((t) => t.kind === LT.kind); }

function ltRenderList() {
  const rows = ltOfKind();
  $('#ltList').innerHTML = rows.length
    ? rows.map((t) => `<button class="btn btn-sm lt-open ${LT.cur[LT.kind] === t.id ? 'btn-primary' : ''}"
        data-id="${esc(t.id)}">${esc(t.name)}${t.is_default ? ' ★' : ''}</button>`).join(' ')
    : '<span class="muted sm">이 그룹의 뼈대가 없습니다</span>';
}

function ltOpenCurrent() {
  const rows = ltOfKind();
  const keep = rows.some((t) => t.id === LT.cur[LT.kind]) ? LT.cur[LT.kind] : (rows[0] && rows[0].id);
  if (keep) { LT.cur[LT.kind] = keep; ltOpen(keep); }
  else {
    LT.cur[LT.kind] = null;
    $('#ltEdit').innerHTML = '<p class="muted">이 그룹의 뼈대가 없습니다. '
      + '위에서 기존 상품을 고르고 [이 상품에서 뼈대 뜨기]를 누르면 <b>두 그룹이 한 번에</b> 만들어집니다.</p>';
  }
}

$('#ltTabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  LT.kind = t.dataset.kind;
  ltRenderTabs();
  ltRenderList();
  ltOpenCurrent();
  ltRenderTarget();
});

/* ---------- 뼈대 뜨기 — 한 번에 두 그룹 ---------- */
$('#ltMake').onclick = async () => {
  const spid = $('#ltSource').value;
  if (!spid) return;
  const src = LT.sources.find((r) => String(r.seller_product_id) === String(spid));
  if (!src) return;
  const pj = src.product_json;
  const it = (pj.items || [])[0] || {};
  const base = ($('#ltName').value || '').trim() || (pj.sellerProductName || '').slice(0, 16);

  const btn = $('#ltMake');
  btn.disabled = true;
  try {
    for (const kind of ['shipping', 'notice']) {
      const payload = { product: {}, item: {} };
      LT_KEYS[kind].product.forEach((k) => { if (pj[k] !== undefined) payload.product[k] = pj[k]; });
      LT_KEYS[kind].item.forEach((k) => { if (it[k] !== undefined) payload.item[k] = it[k]; });
      const already = LT.list.filter((t) => t.kind === kind).length;
      const [made] = await api('listing_templates', {
        method: 'POST', headers: { prefer: 'return=representation' },
        body: { name: `${base} · ${kind === 'shipping' ? '배송' : '고시'}`,
                kind, source_seller_product_id: String(spid), payload,
                is_default: already === 0, created_by: AUTH.userId || null }
      });
      LT.cur[kind] = made.id;
    }
    $('#ltName').value = '';
    toast('두 그룹을 떴습니다 — 값을 확인하고 고치세요');
    await loadListingTemplate();
  } catch (e) {
    toast('만들지 못했습니다: ' + e.message);
  } finally { btn.disabled = false; }
};

$('#ltList').addEventListener('click', (ev) => {
  const b = ev.target.closest('.lt-open');
  if (!b) return;
  LT.cur[LT.kind] = b.dataset.id;
  ltRenderList();
  ltOpen(b.dataset.id);
  ltRenderTarget();
});

/* ---------- 편집 ---------- */
function ltOpen(id) {
  const t = LT.list.find((x) => x.id === id);
  if (!t) return;
  const head = `<div class="lp-card">
    <div class="lp-card-head">
      <input id="ltRename" type="text" value="${esc(t.name)}" style="flex:1;font-weight:600" />
      <label class="chk"><input type="checkbox" id="ltDefault" ${t.is_default ? 'checked' : ''} />
        <span>기본</span></label>
      <button id="ltSave" class="btn btn-sm btn-primary">저장</button>
      <button id="ltDelete" class="btn btn-sm btn-ghost">삭제</button>
    </div>
    <p class="muted sm">${esc(LT_KIND_LABEL[t.kind])} · 출처 상품 ${esc(t.source_seller_product_id || '—')}
      · ${esc(String(t.created_at).slice(0, 10))}</p>`;

  const body = t.kind === 'shipping' ? ltShippingForm(t) : ltNoticeForm(t);

  const tail = `<details style="margin-top:12px">
      <summary class="muted sm">원문 편집 (고급) — 폼에 없는 필드까지 전부</summary>
      <textarea id="ltRaw" rows="14" style="width:100%;font-family:monospace;font-size:12px">${
        esc(JSON.stringify(t.payload, null, 1))}</textarea>
      <p class="muted sm">여기서 고치면 <b>원문이 폼보다 우선</b>합니다. JSON이 깨져 있으면 저장하지 않습니다.</p>
    </details>
    <div id="ltMsg" class="msg hidden"></div></div>`;

  $('#ltEdit').innerHTML = head + body + tail;
  $('#ltSave').onclick = () => ltSave(t);
  $('#ltDelete').onclick = () => ltDelete(t);
  if (t.kind === 'notice') ltBindNotice(t);
  else ltBindShipping();
}

/* 라디오를 누르면 옆의 코드칸을 채운다. 저장은 코드칸만 읽으므로
   **화면과 저장되는 값이 갈릴 일이 없다.** */
function ltBindShipping() {
  $('#ltEdit').addEventListener('change', (ev) => {
    if (!ev.target.matches('.lt-sr')) return;
    const key = ev.target.dataset.target;
    const box = $$(`#ltEdit .lt-f[data-key="${key}"]`)[0];
    if (box) box.value = ev.target.value;
  });
}

/* 라디오 + 코드칸을 같이 보여준다. 라디오를 누르면 코드칸이 채워지고, 코드칸을 직접
   고칠 수도 있다 — **우리가 모르는 코드값이 있을 수 있어서** 라디오만 두면 막힌다. */
function ltShipRadio(label, key, cur, opts, note) {
  return `<label class="field"><span>${esc(label)} <span class="muted xs">${esc(key)}</span></span>
    <div class="range">
      ${opts.map(([v, l]) => `<label class="chk"><input type="radio" name="lt-s-${key}"
        class="lt-sr" data-target="${key}" value="${esc(v)}" ${cur === v ? 'checked' : ''} />
        <span>${esc(l)}</span></label>`).join('')}
      <input class="lt-f" data-scope="ship" data-key="${esc(key)}" type="text" style="width:190px"
             value="${esc(cur == null ? '' : cur)}" />
    </div>
    ${note ? `<span class="muted sm">${note}</span>` : ''}</label>`;
}

/* WING '배송' + '반품/교환' 화면(2026-08-21 캡처) 그대로.
   화면 ↔ 코드 대응은 우리가 이미 가진 상품 원문으로 대부분 확인됐다:
     제주/도서산간 불가능 = N · 택배사 CJ대한통운 = CJGLS · 일반배송 = SEQUENCIAL
     묶음배송 불가능 = NOT_UNION_DELIVERY · 유료배송 = NOT_FREE · 기본배송비 = deliveryCharge
     반품배송비(편도) = returnCharge
   **반대쪽 코드(가능·무료배송·묶음가능)는 실물을 못 봤다.** 그래서 라디오 옆에
   코드칸을 같이 두고 고칠 수 있게 한다(R-14). */
function ltShippingForm(t) {
  const ship = (t.payload.product || {}).marketplaceShippingAndReturnInfo || {};
  const item = t.payload.item || {};
  const sameDay = (item.sameDayShipping || {}).active === true;
  const num = (k, label) => `<label class="field"><span>${esc(label)}
      <span class="muted xs">${esc(k)}</span></span>
      <input class="lt-f" data-scope="ship" data-key="${esc(k)}" type="number"
             value="${esc(ship[k] == null ? '' : ship[k])}" /></label>`;
  const txt = (k, label, ph) => `<label class="field"><span>${esc(label)}
      <span class="muted xs">${esc(k)}</span></span>
      <input class="lt-f" data-scope="ship" data-key="${esc(k)}" type="text"
             placeholder="${esc(ph || '')}" value="${esc(ship[k] == null ? '' : ship[k])}" /></label>`;

  return `<h4 class="sku-sec">배송</h4>

    <div class="filter-panel" style="margin-bottom:12px">
      <b class="sm">상품출고지</b>
      <div class="sm">[출고지] ${esc(ship.returnAddress ? '' : '')}
        <span class="muted">코드로 지정합니다 — WING 주소록의 출고지 코드입니다</span></div>
      <label class="field" style="margin-top:8px"><span>출고지 코드
        <span class="muted xs">outboundShippingPlaceCode</span></span>
        <input class="lt-f" data-scope="ship" data-key="outboundShippingPlaceCode" type="number"
               value="${esc(ship.outboundShippingPlaceCode == null ? '' : ship.outboundShippingPlaceCode)}" /></label>
    </div>

    ${ltShipRadio('제주/도서산간 배송여부', 'remoteAreaDeliverable', ship.remoteAreaDeliverable,
      [['Y', '가능'], ['N', '불가능']], '불가능 = <code>N</code> 은 실측 확인. 가능 = <code>Y</code> 는 추정입니다.')}

    ${ltShipRadio('택배사', 'deliveryCompanyCode', ship.deliveryCompanyCode,
      [['CJGLS', 'CJ대한통운']], '다른 택배사의 코드는 <b>목록을 모릅니다</b> — 오른쪽 칸에 직접 넣으세요.')}

    ${ltShipRadio('배송방법', 'deliveryMethod', ship.deliveryMethod,
      [['SEQUENCIAL', '일반배송']], '다른 배송방법 코드는 미확인입니다.')}

    ${ltShipRadio('묶음배송', 'unionDeliveryType', ship.unionDeliveryType,
      [['UNION_DELIVERY', '가능'], ['NOT_UNION_DELIVERY', '불가능']],
      '불가능 = <code>NOT_UNION_DELIVERY</code> 는 실측. 가능 쪽 코드는 <b>추정</b>입니다.')}

    ${ltShipRadio('배송비 종류', 'deliveryChargeType', ship.deliveryChargeType,
      [['FREE', '무료배송'], ['NOT_FREE', '유료배송'], ['CONDITIONAL_FREE', '조건부 무료']],
      '유료배송 = <code>NOT_FREE</code> 만 실측 확인. 나머지 둘은 <b>추정</b>입니다.')}

    <div class="two">
      ${num('deliveryCharge', '기본배송비')}
      ${num('freeShipOverAmount', '무료배송 기준액')}
    </div>

    <h4 class="sku-sec">출고 소요일</h4>
    <div class="range">
      <label class="field" style="max-width:200px"><span>일 <span class="muted xs">outboundShippingTimeDay</span></span>
        <input class="lt-f" data-scope="item" data-key="outboundShippingTimeDay" type="number"
               value="${esc(item.outboundShippingTimeDay == null ? '' : item.outboundShippingTimeDay)}" /></label>
      <label class="chk"><input type="checkbox" id="ltSameDay" ${sameDay ? 'checked' : ''} />
        <span>당일출고 <span class="muted xs">sameDayShipping.active</span></span></label>
    </div>
    <p class="muted sm">화면의 [구매 옵션별로 입력]은 옵션마다 출고일이 다를 때 씁니다 —
      지금은 <b>기본 입력만</b> 지원합니다. 필요해지면 옵션 표에 칸을 답니다.</p>

    <h4 class="sku-sec">반품 / 교환</h4>
    <div class="filter-panel" style="margin-bottom:12px">
      <b class="sm">반품/교환지</b>
      <div class="muted sm">코드로 지정하고, 주소는 표시용으로 같이 담습니다.</div>
    </div>
    <div class="two">
      ${txt('returnCenterCode', '반품지 코드')}
      ${txt('returnChargeName', '반품지 이름')}
    </div>
    <div class="two">
      ${txt('returnZipCode', '반품지 우편번호')}
      ${txt('companyContactNumber', '연락처')}
    </div>
    ${txt('returnAddress', '반품지 주소')}
    ${txt('returnAddressDetail', '반품지 상세주소')}
    <div class="two">
      ${num('returnCharge', '반품배송비(편도)')}
      ${num('deliveryChargeOnReturn', '반품 시 배송비')}
    </div>

    <h4 class="sku-sec">A/S <span class="muted sm">화면에는 없지만 응답에 있는 칸</span></h4>
    <div class="two">
      ${txt('afterServiceInformation', 'A/S 안내')}
      ${txt('afterServiceContactNumber', 'A/S 전화번호')}
    </div>`;
}

/* WING '상품 주요 정보' + '상품정보제공고시' 화면 그대로 */
function ltNoticeForm(t) {
  const item = t.payload.item || {};
  const prod = t.payload.product || {};
  const bundle = (prod.bundleInfo || {}).bundleType || 'SINGLE';
  const certs = item.certifications || [];
  const notices = item.notices || [];
  const noticeCat = (notices[0] || {}).noticeCategoryName || '';
  const perPerson = Number(item.maximumBuyForPerson || 0) > 0;
  const salePeriod = !!(prod.saleStartedAt || prod.saleEndedAt);

  /* 인증 방식은 certifications 의 내용으로 되읽는다.
     NOT_REQUIRED / PRESENTED_IN_DETAIL_PAGE 는 카테고리 메타의 목록에 있는 실제 값이다. */
  const certMode = !certs.length ? 'NOT_REQUIRED'
    : (certs.length === 1 && certs[0].certificationType === 'PRESENTED_IN_DETAIL_PAGE') ? 'PRESENTED_IN_DETAIL_PAGE'
    : (certs.length === 1 && certs[0].certificationType === 'NOT_REQUIRED') ? 'NOT_REQUIRED'
    : 'TARGET';

  const certOptions = ltCertOptions();

  return `<h4 class="sku-sec">상품 주요 정보</h4>

    <label class="field"><span>상품 구성 <span class="muted xs">bundleInfo.bundleType</span></span>
      <div class="range">
        <label class="chk"><input type="radio" name="lt-bundle" class="lt-bundle" value="SINGLE"
          ${bundle === 'SINGLE' ? 'checked' : ''} /><span>동일한 상품으로 구성됨</span></label>
        <label class="chk"><input type="radio" name="lt-bundle" class="lt-bundle" value="OTHER"
          ${bundle !== 'SINGLE' ? 'checked' : ''} /><span>다양한 상품이 혼합되어 구성됨</span></label>
        <input id="ltBundleCode" type="text" class="${bundle === 'SINGLE' ? 'hidden' : ''}"
               value="${esc(bundle === 'SINGLE' ? '' : bundle)}" placeholder="혼합 구성의 코드값" style="width:180px" />
      </div></label>
    <p class="muted sm">혼합 구성의 코드값은 <b>실물로 확인 못 했습니다</b> — 우리 상품이 전부
      <code>SINGLE</code>입니다. 쓰시려면 코드를 직접 넣어야 합니다.</p>

    <label class="field"><span>인증정보 <span class="muted xs">certifications</span></span>
      <div>
        <label class="chk"><input type="radio" name="lt-cert" class="lt-certmode" value="TARGET"
          ${certMode === 'TARGET' ? 'checked' : ''} /><span>인증·신고 대상</span></label>
        <label class="chk"><input type="radio" name="lt-cert" class="lt-certmode" value="PRESENTED_IN_DETAIL_PAGE"
          ${certMode === 'PRESENTED_IN_DETAIL_PAGE' ? 'checked' : ''} /><span>상세페이지 별도표기</span></label>
        <label class="chk"><input type="radio" name="lt-cert" class="lt-certmode" value="NOT_REQUIRED"
          ${certMode === 'NOT_REQUIRED' ? 'checked' : ''} /><span>인증·신고 대상 아님</span></label>
      </div></label>
    <div id="ltCertRows" class="${certMode === 'TARGET' ? '' : 'hidden'}">
      ${(certMode === 'TARGET' ? certs : []).map((c, i) => ltCertRow(c, i, certOptions)).join('')
        || ltCertRow({}, 0, certOptions)}
      <button id="ltCertAdd" class="btn btn-sm">+ 인증 추가</button>
      <p class="muted sm">종류 목록은 <b>받아둔 카테고리 메타에서</b> 가져옵니다
        (${certOptions.length}개). 카테고리를 정하고 필수속성을 받아두면 더 정확해집니다.</p>
    </div>

    ${ltRadioPair('병행수입', 'parallelImported', item.parallelImported || 'NOT_PARALLEL_IMPORTED',
      'NOT_PARALLEL_IMPORTED', '병행수입 아님', 'PARALLEL_IMPORTED', '병행수입', true)}
    ${ltRadioPair('구매 연령', 'adultOnly', item.adultOnly || 'EVERYONE',
      'EVERYONE', '전체 연령', 'ADULT_ONLY', '성인 전용(19세 이상)', false)}
    ${ltRadioPair('부가세', 'taxType', item.taxType || 'TAX',
      'TAX', '과세', 'FREE', '면세', false)}

    <label class="field"><span>인당 최대구매수량</span>
      <div class="range">
        <label class="chk"><input type="radio" name="lt-pp" class="lt-pp" value="off"
          ${perPerson ? '' : 'checked'} /><span>설정안함</span></label>
        <label class="chk"><input type="radio" name="lt-pp" class="lt-pp" value="on"
          ${perPerson ? 'checked' : ''} /><span>설정함</span></label>
        <input id="ltPpCount" type="number" min="0" placeholder="수량" style="width:100px"
               class="${perPerson ? '' : 'hidden'}" value="${esc(item.maximumBuyForPerson || '')}" />
        <input id="ltPpDays" type="number" min="1" placeholder="기간(일)" style="width:110px"
               class="${perPerson ? '' : 'hidden'}" value="${esc(item.maximumBuyForPersonPeriod || 1)}" />
      </div></label>

    <label class="field"><span>판매기간 <span class="muted xs">saleStartedAt · saleEndedAt</span></span>
      <div class="range">
        <label class="chk"><input type="radio" name="lt-sp" class="lt-sp" value="off"
          ${salePeriod ? '' : 'checked'} /><span>설정안함</span></label>
        <label class="chk"><input type="radio" name="lt-sp" class="lt-sp" value="on"
          ${salePeriod ? 'checked' : ''} /><span>설정함</span></label>
        <input id="ltSaleFrom" type="text" placeholder="시작 (원문 형식 그대로)" style="width:200px"
               class="${salePeriod ? '' : 'hidden'}" value="${esc(prod.saleStartedAt || '')}" />
        <input id="ltSaleTo" type="text" placeholder="종료" style="width:200px"
               class="${salePeriod ? '' : 'hidden'}" value="${esc(prod.saleEndedAt || '')}" />
      </div></label>

    <h4 class="sku-sec">상품정보제공고시</h4>
    <div class="range" style="margin-bottom:8px">
      <select id="ltNoticeCat" style="max-width:280px">
        ${ltNoticeCatOptions(noticeCat)}
      </select>
      <label class="chk"><input type="checkbox" id="ltNoticeAllRef" />
        <span>전체 상품 상세페이지 참조</span></label>
    </div>
    <div class="table-wrap"><table class="grid"><thead><tr>
      <th style="width:200px">고시정보 명</th><th>내용</th><th style="width:150px">상세페이지 참조</th>
    </tr></thead><tbody id="ltNoticeRows">${ltNoticeRows(notices)}</tbody></table></div>
    <p class="muted sm"><b>품명 및 모델명은 상품명이 자동으로 들어갑니다</b> —
      여기 값은 쓰지 않습니다(사용자 결정 2026-08-21).
      "상세페이지 참조"를 켜면 내용이 <code>${esc(LT_DETAIL_REF)}</code> 로 들어갑니다.</p>

    <h4 class="sku-sec">필수속성 <span class="muted sm">${(item.attributes || []).length}개</span></h4>
    <p class="muted sm"><b>카테고리마다 다릅니다.</b> 이 뼈대는 원본 상품의 카테고리 기준이라
      카테고리가 다르면 안 맞습니다 — 등록할 때 카테고리 메타로 대조합니다.</p>
    <div class="kv-grid">${(item.attributes || []).slice(0, 12).map((a) => `<span class="kv">
      <span class="kv-k">${esc(a.attributeTypeName)}</span>
      <span class="kv-v">${esc(a.attributeValueName || '—')}</span></span>`).join('')}</div>`;
}

/* 실측된 쪽을 왼쪽에 두고, 반대쪽은 **미검증**이라고 적는다 */
function ltRadioPair(label, key, cur, vA, lA, vB, lB, bVerified) {
  return `<label class="field"><span>${esc(label)} <span class="muted xs">${esc(key)}</span></span>
    <div class="range">
      <label class="chk"><input type="radio" name="lt-${key}" class="lt-enum" data-key="${key}"
        value="${vA}" ${cur === vA ? 'checked' : ''} /><span>${esc(lA)}</span></label>
      <label class="chk"><input type="radio" name="lt-${key}" class="lt-enum" data-key="${key}"
        value="${vB}" ${cur === vB ? 'checked' : ''} /><span>${esc(lB)}${
          bVerified ? '' : ' <span class="muted">(코드 미검증)</span>'}</span></label>
      <input class="lt-enum-code" data-key="${key}" type="text" style="width:190px"
             placeholder="코드를 직접 넣으려면" value="${
               (cur !== vA && cur !== vB) ? esc(cur) : ''}" />
    </div></label>`;
}

function ltCertOptions() {
  const set = new Set();
  Object.keys(LT.noticeCats); // (고시 목록과 별개 — 인증은 아래에서 모은다)
  return LT._certTypes || [];
}

function ltNoticeCatOptions(cur) {
  const names = Object.keys(LT.noticeCats);
  if (cur && names.indexOf(cur) === -1) names.unshift(cur);
  return names.length
    ? names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')
    : `<option selected>${esc(cur || '(카테고리 메타를 받아야 목록이 나옵니다)')}</option>`;
}

function ltNoticeRows(notices) {
  if (!notices.length) return '<tr><td colspan="3" class="muted">고시정보가 없습니다 — 위에서 종류를 고르세요.</td></tr>';
  return notices.map((n, i) => {
    const auto = /품명/.test(n.noticeCategoryDetailName || '');
    const ref = (n.content || '') === LT_DETAIL_REF;
    return `<tr data-lt-n="${i}">
      <td>${esc(n.noticeCategoryDetailName)}</td>
      <td>${auto
        ? '<span class="muted">상품명이 자동으로 들어갑니다</span>'
        : `<textarea class="lt-nc" rows="2" style="width:100%">${esc(n.content || '')}</textarea>`}</td>
      <td>${auto ? '' : `<label class="chk"><input type="checkbox" class="lt-nref" ${ref ? 'checked' : ''} />
        <span>상세페이지 참조</span></label>`}</td>
    </tr>`;
  }).join('');
}

function ltCertRow(c, i, options) {
  return `<div class="range lt-cert-row" style="margin-bottom:6px">
    <input class="lt-ct" type="text" list="ltCertList" style="flex:1"
           placeholder="인증 종류 코드" value="${esc(c.certificationType || '')}" />
    <input class="lt-cc" type="text" placeholder="인증번호" style="width:200px"
           value="${esc(c.certificationCode || '')}" />
    <button class="btn btn-sm btn-ghost lt-cert-del">✕</button>
  </div>`;
}

/* 고시 종류를 바꾸면 항목이 통째로 달라진다 — 그때 표를 다시 그린다 */
function ltBindNotice(t) {
  /* 인증 종류 목록: 받아둔 카테고리 메타의 certifications 를 모은다 */
  api('coupang_category_meta?select=raw').then((metas) => {
    const set = new Set();
    (metas || []).forEach((m) => ((m.raw || {}).certifications || []).forEach((c) => {
      set.add(typeof c === 'string' ? c : (c.certificationType || c.name));
    }));
    LT._certTypes = [...set].filter(Boolean);
    const dl = $('#ltCertList');
    if (dl) dl.innerHTML = LT._certTypes.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }).catch(() => {});

  const sel = $('#ltNoticeCat');
  if (sel) sel.onchange = () => {
    const names = LT.noticeCats[sel.value] || [];
    if (!names.length) { toast('그 고시 종류의 항목 목록이 없습니다 — 카테고리 메타를 먼저 받으세요'); return; }
    const notices = names.map((d) => ({ noticeCategoryName: sel.value, noticeCategoryDetailName: d, content: '' }));
    $('#ltNoticeRows').innerHTML = ltNoticeRows(notices);
    LT._noticeDraft = notices;
  };

  const all = $('#ltNoticeAllRef');
  if (all) all.onchange = () => {
    $$('#ltNoticeRows .lt-nref').forEach((cb) => { cb.checked = all.checked; });
    $$('#ltNoticeRows tr[data-lt-n]').forEach((tr) => {
      const ta = tr.querySelector('.lt-nc');
      if (ta && all.checked) ta.value = LT_DETAIL_REF;
    });
  };

  $('#ltNoticeRows').addEventListener('change', (ev) => {
    if (!ev.target.matches('.lt-nref')) return;
    const ta = ev.target.closest('tr').querySelector('.lt-nc');
    if (ta && ev.target.checked) ta.value = LT_DETAIL_REF;
  });

  /* 라디오에 딸린 입력칸 켜고 끄기 */
  $('#ltEdit').addEventListener('change', (ev) => {
    if (ev.target.matches('.lt-bundle')) {
      $('#ltBundleCode').classList.toggle('hidden', ev.target.value === 'SINGLE');
    }
    if (ev.target.matches('.lt-certmode')) {
      $('#ltCertRows').classList.toggle('hidden', ev.target.value !== 'TARGET');
    }
    if (ev.target.matches('.lt-pp')) {
      const on = ev.target.value === 'on';
      $('#ltPpCount').classList.toggle('hidden', !on);
      $('#ltPpDays').classList.toggle('hidden', !on);
    }
    if (ev.target.matches('.lt-sp')) {
      const on = ev.target.value === 'on';
      $('#ltSaleFrom').classList.toggle('hidden', !on);
      $('#ltSaleTo').classList.toggle('hidden', !on);
    }
  });

  $('#ltEdit').addEventListener('click', (ev) => {
    if (ev.target.id === 'ltCertAdd') {
      $('#ltCertAdd').insertAdjacentHTML('beforebegin', ltCertRow({}, 0, LT._certTypes || []));
    }
    if (ev.target.matches('.lt-cert-del')) ev.target.closest('.lt-cert-row').remove();
  });
}

/* ---------- 저장 ---------- */
async function ltSave(t) {
  const msg = $('#ltMsg');
  msg.classList.remove('hidden');
  msg.textContent = '저장 중…';
  try {
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

      if (t.kind === 'shipping') {
        payload.product.marketplaceShippingAndReturnInfo =
          payload.product.marketplaceShippingAndReturnInfo || {};
        $$('#ltEdit .lt-f').forEach((el) => {
          const target = el.dataset.scope === 'ship'
            ? payload.product.marketplaceShippingAndReturnInfo : payload.item;
          const v = el.value;
          target[el.dataset.key] = (v === '') ? null : (el.type === 'number' ? Number(v) : v);
        });
        /* 당일출고. **객체를 통째로 갈아끼우지 않는다** — cutOffTime* 같은 항목이
           같이 지워지면 등록 때 빈 값이 나간다. */
        const sd = $('#ltSameDay');
        if (sd) {
          payload.item.sameDayShipping = Object.assign(
            { cutOffTimeHour: null, cutOffTimeZone: null, cutOffTimeMinute: null },
            payload.item.sameDayShipping, { active: sd.checked });
        }
        /* 출고 소요시간(시간 단위)은 화면에서 안 받는다 — 일수에서 만든다.
           실측이 7일=168시간이라 24배다. 둘이 어긋나면 어느 쪽이 쓰일지 모른다. */
        const day = Number(payload.item.outboundShippingTimeDay);
        if (Number.isFinite(day) && day > 0) payload.item.outboundShippingTime = day * 24;
      } else {
        /* 상품 구성 */
        const bundleSel = $$('#ltEdit .lt-bundle').find((r) => r.checked);
        const bundleVal = (bundleSel && bundleSel.value === 'SINGLE')
          ? 'SINGLE' : (($('#ltBundleCode').value || '').trim() || null);
        payload.product.bundleInfo = Object.assign({}, payload.product.bundleInfo, { bundleType: bundleVal });

        /* 라디오 3쌍 (직접 넣은 코드가 있으면 그게 이긴다) */
        $$('#ltEdit .lt-enum-code').forEach((el) => {
          const key = el.dataset.key;
          const typed = (el.value || '').trim();
          if (typed) { payload.item[key] = typed; return; }
          const sel = $$(`#ltEdit .lt-enum[data-key="${key}"]`).find((r) => r.checked);
          if (sel) payload.item[key] = sel.value;
        });

        /* 인당 최대구매수량 */
        const ppOn = ($$('#ltEdit .lt-pp').find((r) => r.checked) || {}).value === 'on';
        payload.item.maximumBuyForPerson = ppOn ? Number($('#ltPpCount').value || 0) : 0;
        payload.item.maximumBuyForPersonPeriod = ppOn ? Number($('#ltPpDays').value || 1) : 1;

        /* 판매기간 */
        const spOn = ($$('#ltEdit .lt-sp').find((r) => r.checked) || {}).value === 'on';
        payload.product.saleStartedAt = spOn ? (($('#ltSaleFrom').value || '').trim() || null) : null;
        payload.product.saleEndedAt = spOn ? (($('#ltSaleTo').value || '').trim() || null) : null;

        /* 인증 */
        const mode = ($$('#ltEdit .lt-certmode').find((r) => r.checked) || {}).value;
        if (mode === 'TARGET') {
          payload.item.certifications = $$('#ltEdit .lt-cert-row').map((row) => ({
            certificationType: (row.querySelector('.lt-ct').value || '').trim(),
            certificationCode: (row.querySelector('.lt-cc').value || '').trim(),
            certificationAttachments: []
          })).filter((c) => c.certificationType);
        } else {
          payload.item.certifications = [{ certificationType: mode, certificationCode: '', certificationAttachments: [] }];
        }

        /* 고시정보 — 화면에 그려진 행을 그대로 읽는다 */
        const catName = $('#ltNoticeCat').value;
        const base = LT._noticeDraft || payload.item.notices || [];
        const rows = $$('#ltNoticeRows tr[data-lt-n]');
        if (rows.length) {
          payload.item.notices = rows.map((tr) => {
            const i = Number(tr.dataset.ltN);
            const src = base[i] || {};
            const ta = tr.querySelector('.lt-nc');
            return {
              noticeCategoryName: catName || src.noticeCategoryName,
              noticeCategoryDetailName: src.noticeCategoryDetailName,
              /* 품명 행은 등록할 때 상품명으로 채운다 — 여기선 빈 값으로 둔다 */
              content: ta ? ta.value : ''
            };
          });
        }
      }
    }

    const isDefault = $('#ltDefault').checked;
    if (isDefault) {
      for (const other of LT.list) {
        if (other.id !== t.id && other.kind === t.kind && other.is_default) {
          await api(`listing_templates?id=eq.${other.id}`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { is_default: false } });
        }
      }
    }
    await api(`listing_templates?id=eq.${t.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { name: ($('#ltRename').value || '').trim() || t.name, payload, is_default: isDefault }
    });
    LT._noticeDraft = null;
    msg.textContent = '저장했습니다.';
    toast('저장했습니다');
    await loadListingTemplate();
  } catch (e) {
    msg.textContent = '저장 실패: ' + e.message;
  }
}

async function ltDelete(t) {
  const col = t.kind === 'shipping' ? 'shipping_template_id' : 'notice_template_id';
  const used = await api(`listing_projects?select=id&${col}=eq.${t.id}&limit=5`) || [];
  if (used.length) {
    toast(`이 뼈대를 쓰는 준비 건이 ${used.length}건 있어 지울 수 없습니다`);
    return;
  }
  if (!confirm(`뼈대 "${t.name}"를 지울까요?`)) return;
  await api(`listing_templates?id=eq.${t.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  LT.cur[t.kind] = null;
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
  const ship = LT.list.find((t) => t.id === p.shipping_template_id);
  const note = LT.list.find((t) => t.id === p.notice_template_id);
  box.innerHTML = `<div class="kv-grid">
      <span class="kv"><span class="kv-k">작업 중인 준비 건</span>
        <span class="kv-v">${esc(p.product_name || '(이름 미정)')}</span></span>
      <span class="kv"><span class="kv-k">배송·반품</span>
        <span class="kv-v">${ship ? esc(ship.name) : '<span class="neg">없음</span>'}</span></span>
      <span class="kv"><span class="kv-k">고시·주요정보</span>
        <span class="kv-v">${note ? esc(note.name) : '<span class="neg">없음</span>'}</span></span>
    </div>
    ${LT.cur[LT.kind] ? `<button id="ltApply" class="btn btn-sm btn-primary" style="margin-top:8px">
      고른 [${esc(LT_KIND_LABEL[LT.kind])}] 뼈대를 이 준비 건에 쓰기</button>` : ''}`;

  const btn = $('#ltApply');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const t = LT.list.find((x) => x.id === LT.cur[LT.kind]);
      const body = {};
      body[LT.kind === 'shipping' ? 'shipping_template_id' : 'notice_template_id'] = t.id;
      if (t.source_seller_product_id) body.clone_seller_product_id = t.source_seller_product_id;
      await api(`listing_projects?id=eq.${id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body });
      await lstAddNote(id, 'skeleton', `[${LT_KIND_LABEL[t.kind]}] 뼈대 "${t.name}" 적용`
        + (t.source_seller_product_id ? ` (출처 상품 ${t.source_seller_product_id})` : ''));
      toast('뼈대를 붙였습니다');
      await ltRenderTarget();
    } catch (e) {
      toast('저장 실패: ' + e.message);
    } finally { btn.disabled = false; }
  };
}
