/* ============================================================
   89-listing-category.js — 카테고리
   ------------------------------------------------------------
   카테고리가 정해져야 **판매수수료·입출고비·필수속성·고시정보**가 정해진다.
   그래서 이 단계가 늦어지면 마진도 못 내고 등록 몸통도 못 만든다.

   **우리 DB의 categories 를 그대로 쓴다.** 소싱 수집용 코드와 쿠팡 등록용
   displayCategoryCode 가 같은 체계임을 실물로 확인했다(2026-08-21):
   등록된 상품 product_json.displayCategoryCode=62902 ↔ categories.category_code='62902'
   (가전/디지털>…>파우치). **표본이 1건**이라 어긋나는 사례가 나오면 여기를 의심할 것.

   카테고리를 확정하면 `category_meta` 큐를 넣어 워커가 그 카테고리의 필수속성·
   고시정보를 받아온다(029). 그게 있어야 뼈대·물류 단계에서 빠진 필드 없이 등록된다.

   파일 순서 주의(D-17): 86 뒤, 90 앞.
   ============================================================ */

const LC = { p: null, results: [], picked: null };

async function loadListingCategory() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#lcBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031_listing_pipeline.sql</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#lcPicker'), rows);
  await lcLoadCurrent();
}

async function lcLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#lcBody').classList.add('hidden');
    $('#lcEmpty').classList.remove('hidden');
    $('#lcSteps').innerHTML = '';
    return;
  }
  $('#lcEmpty').classList.add('hidden');
  $('#lcBody').classList.remove('hidden');

  const { p, prog } = await lstFetchOne(id);
  LC.p = p;
  LC.picked = null;

  $('#lcSteps').innerHTML = lstStepBar(prog, 'category');
  await lcRenderCurrent();
  /* 카탈로그 매칭이 이 화면 안에서 산다(사용자 결정 2026-08-21) */
  lkAttach(p);

  const last = await lstLastNote(id, 'category');
  $('#lcNote').value = '';
  $('#lcNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';
}

/* 지금 정해진 카테고리와 **그래서 무엇이 정해졌는지**를 같이 보여준다.
   코드만 보여주면 잘 골랐는지 알 수가 없다. */
async function lcRenderCurrent() {
  const p = LC.p;
  const box = $('#lcCurrent');
  if (!p || !p.display_category_code) {
    box.innerHTML = '<p class="muted">아직 카테고리를 정하지 않았습니다. '
      + '아래에서 검색하거나 코드를 직접 넣으세요.</p>';
    return;
  }
  const code = String(p.display_category_code);
  const commission = commissionFor(code);
  const u = state.catUnits[code] || {};

  /* 필수속성·고시정보를 받아왔는지. 없으면 큐에 넣어달라고 말한다 —
     이게 없으면 뼈대·물류 단계에서 빠진 필드가 생겨 등록이 실패한다. */
  let meta = null;
  try {
    const rows = await api('coupang_category_meta?select=display_category_code,category_path,fetched_at'
      + `&display_category_code=eq.${encodeURIComponent(code)}&limit=1`);
    meta = (rows || [])[0] || null;
  } catch (e) { /* 029 미실행이면 조용히 넘어간다 */ }

  box.innerHTML = `
    <div class="kv-grid">
      <span class="kv"><span class="kv-k">카테고리</span>
        <span class="kv-v">${esc(p.category_path || '(경로 없음)')}</span></span>
      <span class="kv"><span class="kv-k">코드</span><span class="kv-v">${esc(code)}</span></span>
      <span class="kv"><span class="kv-k">판매수수료</span>
        <span class="kv-v">${commission == null
          ? '<span class="neg">정보 없음</span>' : commission + '%'}</span></span>
      <span class="kv"><span class="kv-k">입출고비 요금표</span>
        <span class="kv-v">${u.unit1 ? '있음' : '<span class="neg">없음</span>'}</span></span>
    </div>
    <p class="muted sm">${commission == null
      ? '수수료율이 매칭되지 않은 카테고리라 <b>예상 마진을 계산할 수 없습니다</b>.'
      : '옵션·가격 화면에서 이 요율로 예상 마진이 계산됩니다.'}</p>
    <p class="sm">필수속성·고시정보: ${meta
      ? `받아둠 <span class="muted">(${esc(String(meta.fetched_at).slice(0, 10))})</span>`
      : '<span class="neg">아직 없음</span> — <button id="lcMetaFetch" class="btn btn-sm">지금 받기</button>'
        + ' <span class="muted sm">VPS 워커가 쿠팡에서 받아옵니다 (몇 초)</span>'}</p>
    <p class="muted sm" id="lcMetaState"></p>`;

  const btn = $('#lcMetaFetch');
  if (btn) btn.onclick = () => lcQueueMeta(code);
}

/* 웹은 쿠팡을 직접 못 부른다(D-16). 큐에 넣고 워커가 가져온다.
   **워커가 안 떠 있으면 쌓이기만 한다** — 그래서 기다리라고만 하지 않고 그 사실을 말한다. */
async function lcQueueMeta(code) {
  const st = $('#lcMetaState');
  try {
    await api('coupang_write_queue', {
      method: 'POST',
      body: { kind: 'category_meta', display_category_code: code, requested_by: AUTH.userId || null }
    });
    st.textContent = '요청했습니다 — 몇 초 뒤 새로고침하면 받아온 것이 보입니다. '
      + '2분이 지나도 그대로면 VPS 워커가 꺼져 있는 것입니다.';
  } catch (e) {
    st.textContent = '요청 실패: ' + e.message;
  }
}

/* ---------- 검색 ---------- */
/* 이름과 전체 경로를 같이 본다 — "파우치"만 쳐도 어느 파우치인지는 경로를 봐야 안다.
   쉼표·괄호는 PostgREST의 or() 문법을 깨뜨리므로 지운다. */
async function lcSearch() {
  const q = ($('#lcQuery').value || '').trim().replace(/[(),*]/g, ' ').trim();
  const box = $('#lcResults');
  if (q.length < 2) { box.innerHTML = '<p class="muted sm">두 글자 이상 입력하세요.</p>'; return; }

  box.innerHTML = '<div class="loader"><div class="spinner"></div>찾는 중…</div>';
  try {
    const enc = encodeURIComponent(`*${q}*`);
    const rows = await api('categories?select=category_code,name,full_path,commission_rate,unit1'
      + `&or=(name.ilike.${enc},full_path.ilike.${enc})&order=full_path.asc&limit=60`) || [];
    LC.results = rows;
    lcRenderResults(rows, `"${q}" 검색 결과 ${rows.length}건`);
  } catch (e) {
    box.innerHTML = `<p class="muted">검색 실패: ${esc(e.message)}</p>`;
  }
}

/* 코드를 직접 아는 경우(WING에서 보고 옮겨 적을 때) */
async function lcFindByCode() {
  const code = ($('#lcCode').value || '').trim();
  const box = $('#lcResults');
  if (!code) return;
  box.innerHTML = '<div class="loader"><div class="spinner"></div>찾는 중…</div>';
  try {
    const rows = await api('categories?select=category_code,name,full_path,commission_rate,unit1'
      + `&category_code=eq.${encodeURIComponent(code)}&limit=1`) || [];
    LC.results = rows;
    lcRenderResults(rows, rows.length ? `코드 ${code}` : `코드 ${code} — 우리 DB에 없는 코드입니다`);
  } catch (e) {
    box.innerHTML = `<p class="muted">조회 실패: ${esc(e.message)}</p>`;
  }
}

function lcRenderResults(rows, title) {
  const box = $('#lcResults');
  if (!rows.length) {
    box.innerHTML = `<p class="muted sm">${esc(title)}</p>`;
    return;
  }
  box.innerHTML = `<p class="muted sm">${esc(title)} — 고를 것을 누르세요</p>`
    + '<div class="table-wrap"><table class="grid"><thead><tr>'
    + '<th>카테고리 경로</th><th>코드</th><th class="col-num">수수료</th><th>요금표</th><th></th>'
    + '</tr></thead><tbody>'
    + rows.map((r) => `<tr>
        <td>${esc(r.full_path || r.name)}</td>
        <td class="col-mid">${esc(r.category_code)}</td>
        <td class="col-num">${r.commission_rate == null
          ? '<span class="neg">없음</span>' : r.commission_rate + '%'}</td>
        <td class="col-mid">${r.unit1 ? '있음' : '<span class="muted">없음</span>'}</td>
        <td class="col-mid"><button class="btn btn-sm lc-pick"
          data-code="${esc(r.category_code)}"
          data-path="${esc(r.full_path || r.name)}">이걸로</button></td>
      </tr>`).join('')
    + '</tbody></table></div>';
}

$('#lcSearchBtn').onclick = lcSearch;
$('#lcQuery').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') lcSearch(); });
$('#lcCodeBtn').onclick = lcFindByCode;
$('#lcCode').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') lcFindByCode(); });

/* 고르는 즉시 저장한다. **되돌리기 쉬운 값**이라 확인 단계를 하나 더 두면
   오히려 안 고르게 된다 — 다시 고르면 그냥 덮인다. */
$('#lcResults').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.lc-pick');
  if (!btn || !LC.p) return;
  const code = btn.dataset.code;
  const path = btn.dataset.path;
  btn.disabled = true;
  try {
    await api(`listing_projects?id=eq.${LC.p.id}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: {
        display_category_code: code,
        category_path: path,
        category_source: 'search',
        category_confirmed_at: new Date().toISOString()
      }
    });
    LC.p.display_category_code = code;
    LC.p.category_path = path;
    toast('카테고리를 정했습니다');
    await lcRenderCurrent();
    /* 필수속성이 아직 없으면 바로 받아온다 — 사람이 한 번 더 누르게 하면 잊는다 */
    try {
      const rows = await api('coupang_category_meta?select=display_category_code'
        + `&display_category_code=eq.${encodeURIComponent(code)}&limit=1`);
      if (!rows || !rows.length) await lcQueueMeta(code);
    } catch (e) { /* 029 미실행 — 넘어간다 */ }
    /* 단계 배지를 다시 그린다 */
    const { prog } = await lstFetchOne(LC.p.id);
    $('#lcSteps').innerHTML = lstStepBar(prog, 'category');
  } catch (e) {
    toast('저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
});

$('#lcPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await lcLoadCurrent();
});

$('#lcNoteSave').onclick = async () => {
  if (!LC.p) return;
  const note = ($('#lcNote').value || '').trim();
  if (!note) { toast('메모를 적으세요'); return; }
  const btn = $('#lcNoteSave');
  btn.disabled = true;
  try {
    await lstAddNote(LC.p.id, 'category', note);
    toast('메모를 남겼습니다');
    await lcLoadCurrent();
  } catch (e) {
    toast('저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
};

/* ============================================================
   91-listing-catalog.js — 카탈로그 매칭
   ------------------------------------------------------------
   WING 상품등록의 '카탈로그 매칭하기'와 같은 것을 여기서 한다.
   **정보만 가져온다** — 카탈로그에 결합해달라고 신청하는 게 아니다.
   (등록 몸통 23키에 카탈로그를 지정하는 필드가 아예 없다, 2026-08-21 확인)

   가져오는 것: 브랜드명 · 제조사 · 카테고리 · 조회수. [이 정보 쓰기]를 누르면
   준비 건의 카테고리·브랜드·제조사가 채워지고, 응답 원문이 통째로 박힌다(R-04).

   **웹은 WING 을 직접 못 부른다**(세션·CORS). 확장프로그램에 시켜서 받아온다 —
   판매현황·지표 동기화와 같은 구조다.

   **응답 구조를 아직 실물로 못 봤다.** 그래서 필드 이름을 단정하지 않고
   흔한 이름들을 훑는다(catExtract). 못 찾으면 원문을 그대로 보여준다 —
   그 원문을 보고 파서를 좁히는 게 다음 순서다(R-12·R-14).

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LCAT = { p: null, results: [], raw: null };

/* **카테고리 화면 안에서 산다**(사용자 결정 2026-08-21) — 카탈로그 매칭은
   "내가 등록할 카테고리를 찾는 수단"이지 그 자체가 목적이 아니다.
   그래서 준비 건 선택·단계 배지는 카테고리 화면 것을 쓰고 여기선 검색만 한다. */
function lkAttach(project) {
  LCAT.p = project;
  const box = $('#lkBox');
  if (box) box.classList.toggle('hidden', !project);
}

/* ---------- 검색 ---------- */
$('#lkSearchBtn').onclick = async () => {
  const kw = ($('#lkQuery').value || '').trim();
  const box = $('#lkResults');
  if (!kw) { box.innerHTML = '<p class="muted sm">상품명·상품번호·URL 중 하나를 넣으세요.</p>'; return; }

  box.innerHTML = '<div class="loader"><div class="spinner"></div>확장프로그램에 요청하는 중…</div>';
  const resp = await extensionSendMessage({ type: 'CATALOG_SEARCH', keyword: kw }, 40000);

  if (!resp.ok) {
    /* 실패 원인을 갈라서 말한다. "실패"만 띄우면 무엇을 해야 할지 모른다. */
    const e = String(resp.error || '');
    let hint;
    if (e === 'no-extension') {
      hint = '이 브라우저에 확장프로그램이 없습니다. 확장프로그램이 설치된 브라우저에서 여세요.'
        + '<br><span class="muted sm">로컬(localhost)에서는 확장프로그램이 응답하지 않습니다 — '
        + '배포된 주소에서만 됩니다.</span>';
    } else if (/캡처/.test(e)) {
      hint = '카탈로그 매칭 요청이 아직 캡처되지 않았습니다.<br>'
        + '① WING <b>상품등록 페이지를 새로 열고</b> ② [카탈로그 매칭하기]에서 아무거나 한 번 검색한 뒤 '
        + '③ 여기서 다시 시도하세요.<br>'
        + '<span class="muted sm">수집기는 페이지가 열릴 때 붙습니다 — 이미 열려 있던 탭은 새로고침해야 합니다.</span>';
    } else if (e === 'timeout') {
      hint = '응답이 없습니다. WING 탭이 로그인된 상태인지 확인하세요.';
    } else {
      hint = esc(e);
    }
    box.innerHTML = `<p class="msg err">${hint}</p>`;
    return;
  }

  const r = resp.result || {};
  LCAT.raw = r.json || r.raw || null;
  LCAT.results = catExtract(r.json);
  lkRenderResults(r);
};

$('#lkQuery').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#lkSearchBtn').click(); });

/* 응답 구조 — 2026-08-21 실물 확인. 추측이 아니라 캡처한 원문 그대로다.
   {
     nextSearchPage, hasNext,
     result: [{
       productId, productName, brandName(null 가능), itemId, itemName,
       displayCategoryInfo: [{ leafCategoryCode, rootCategoryCode, categoryHierarchy }],
       manufacture, categoryId, itemCountOfProduct, imagePath,
       salePrice, vendorItemId, rating, ratingCount,
       pvLast28Day,      // 최근 28일 조회수
       salesLast28d,     // 최근 28일 판매량  ← 소싱 판단에 가장 값어치 있는 값
       deliveryMethod, matchType, matchingResultId, sponsored, attributeTypes
     }]
   }

   **`categoryId`(7359)를 카테고리 코드로 쓰면 안 된다.** 등록에 쓰는 코드는
   `displayCategoryInfo[0].leafCategoryCode`(103112)다. 처음 쓴 느슨한 파서가
   categoryId 를 집었는데, 그대로 뒀으면 엉뚱한 카테고리로 등록될 뻔했다.
   (103112 는 우리 문서에 이미 있는 값이다 — 필수속성이 색상·개당중량·수량인 그 카테고리) */
function catExtract(json) {
  if (!json || typeof json !== 'object') return [];
  const rows = Array.isArray(json.result) ? json.result
    : (Array.isArray(json.results) ? json.results : null);
  if (!rows) return [];
  return rows.filter((o) => o && typeof o === 'object').map(catRow).slice(0, 20);
}

function catRow(o) {
  const info = (Array.isArray(o.displayCategoryInfo) && o.displayCategoryInfo[0]) || {};
  return {
    name: o.productName || null,
    productId: o.productId != null ? String(o.productId) : null,
    itemId: o.itemId != null ? String(o.itemId) : null,
    vendorItemId: o.vendorItemId != null ? String(o.vendorItemId) : null,
    itemName: o.itemName || null,
    brand: o.brandName || null,
    manufacture: o.manufacture || null,
    /* 등록에 쓰는 코드는 leafCategoryCode 다. categoryId 는 다른 체계다(쓰지 말 것). */
    categoryCode: info.leafCategoryCode != null ? String(info.leafCategoryCode) : null,
    rootCategoryCode: info.rootCategoryCode != null ? String(info.rootCategoryCode) : null,
    categoryPath: info.categoryHierarchy || null,
    image: o.imagePath || null,
    rating: o.rating != null ? o.rating : null,
    ratingCount: o.ratingCount != null ? o.ratingCount : null,
    pv: o.pvLast28Day != null ? o.pvLast28Day : null,
    sales: o.salesLast28d != null ? o.salesLast28d : null,
    salePrice: o.salePrice != null ? o.salePrice : null,
    itemCount: o.itemCountOfProduct != null ? o.itemCountOfProduct : null,
    raw: o
  };
}

function lkRenderResults(r) {
  const box = $('#lkResults');
  const rows = LCAT.results;
  const used = r.usedKeyword ? `<p class="muted sm">실제 검색어: <b>${esc(r.usedKeyword)}</b>${
    r.keywordNote ? ' — ' + esc(r.keywordNote) : ''}</p>` : '';

  if (!rows.length) {
    /* **"결과 0건"과 "못 읽음"은 다르다.** 둘을 같은 문구로 뭉개면 사람이 엉뚱한 데를 고친다.
       result 배열이 있는데 비었으면 쿠팡이 진짜로 못 찾은 것이다. */
    const json = LCAT.raw;
    const emptyResult = json && typeof json === 'object'
      && Array.isArray(json.result) && json.result.length === 0;

    if (emptyResult) {
      box.innerHTML = used
        + '<p class="msg">검색 결과가 없습니다.<br><span class="muted sm">'
        /* URL에서 번호를 이미 뽑았으면 그 안내는 빼야 한다 — 이미 한 일을 시키면 헷갈린다 */
        + (r.keywordNote ? '' : '· 상품 URL을 넣으셨다면 <b>상품번호만</b> 넣어보세요 (예: 9671949069)<br>')
        + '· 상품명으로 찾을 땐 짧게 — 긴 상품명은 그대로 일치해야 잡히는 편입니다<br>'
        + '· 카탈로그에 없는 신상품이면 결과가 원래 없습니다</span></p>';
      return;
    }

    /* 못 읽었으면 **숨기지 않고 원문을 보여준다**(R-15). 이 원문이 파서를 고치는 근거다. */
    box.innerHTML = used
      + '<p class="msg err">응답은 받았지만 상품 후보를 못 읽었습니다 — '
      + '필드 이름이 예상과 다릅니다. 아래 원문을 개발자에게 보여주세요.</p>'
      + `<p class="muted sm">바꾼 검색어 필드: ${esc((r.replacedFields || []).join(', ') || '없음')}</p>`
      + `<details open><summary>응답 원문</summary><textarea rows="14" readonly style="width:100%">${
          esc(typeof LCAT.raw === 'string' ? LCAT.raw : JSON.stringify(LCAT.raw, null, 1)).slice(0, 20000)
        }</textarea></details>`;
    return;
  }

  box.innerHTML = used + `<p class="muted sm">후보 ${rows.length}건 — 쓸 것을 고르세요</p>`
    + rows.map((c, i) => `<div class="lp-card">
        <div style="display:flex;gap:12px">
          ${c.image ? `<img class="thumb" style="width:64px;height:64px"
            src="${esc(imageUrl(c.image, 200))}" alt="" onerror="this.style.visibility='hidden'" />` : ''}
          <div style="flex:1;min-width:0">
            <div class="pname">${esc(c.name || '')}</div>
            <div class="kv-grid" style="margin-top:6px">
              ${c.productId ? `<span class="kv"><span class="kv-k">쿠팡상품ID</span><span class="kv-v">${esc(c.productId)}</span></span>` : ''}
              ${c.brand ? `<span class="kv"><span class="kv-k">브랜드</span><span class="kv-v">${esc(c.brand)}</span></span>` : ''}
              ${c.manufacture ? `<span class="kv"><span class="kv-k">제조사</span><span class="kv-v">${esc(c.manufacture)}</span></span>` : ''}
              ${c.salePrice != null ? `<span class="kv"><span class="kv-k">현재가</span><span class="kv-v">${won(c.salePrice)}</span></span>` : ''}
              ${c.itemCount != null ? `<span class="kv"><span class="kv-k">옵션</span><span class="kv-v">${esc(c.itemCount)}개</span></span>` : ''}
            </div>
            <!-- 조회수·판매량은 **그때만 볼 수 있는 값**이다. 이 줄이 소싱 판단의 근거가 된다. -->
            <div class="kv-grid" style="margin-top:4px">
              ${c.pv != null ? `<span class="kv"><span class="kv-k">28일 조회</span><span class="kv-v">${cnt(c.pv)}</span></span>` : ''}
              ${c.sales != null ? `<span class="kv"><span class="kv-k">28일 판매</span><span class="kv-v pos">${cnt(c.sales)}</span></span>` : ''}
              ${(c.pv && c.sales != null) ? `<span class="kv"><span class="kv-k">전환</span>
                <span class="kv-v">${Math.round(c.sales / c.pv * 1000) / 10}%</span></span>` : ''}
              ${c.rating ? `<span class="kv"><span class="kv-k">별점</span><span class="kv-v">${esc(c.rating)} (${esc(c.ratingCount || 0)})</span></span>` : ''}
            </div>
            <div class="psub">${esc(c.categoryPath || '카테고리 정보 없음')}${
              c.categoryCode ? ` <span class="muted">(${esc(c.categoryCode)})</span>` : ''}</div>
          </div>
          <button class="btn btn-sm btn-primary lk-use" data-i="${i}">이 정보 쓰기</button>
        </div>
      </div>`).join('')
    + `<details><summary class="muted sm">응답 원문 보기</summary><textarea rows="10" readonly style="width:100%">${
        esc(JSON.stringify(LCAT.raw, null, 1)).slice(0, 20000)}</textarea></details>`;
}

/* ---------- 준비 건에 반영 ---------- */
$('#lkResults').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.lk-use');
  if (!btn || !LCAT.p) return;
  const c = LCAT.results[Number(btn.dataset.i)];
  if (!c) return;
  btn.disabled = true;

  try {
    const body = {
      catalog_product_id: c.productId ? String(c.productId) : null,
      catalog_matched_at: new Date().toISOString(),
      catalog_snapshot: c.raw          // 원문 통째로 (R-04)
    };
    if (c.brand) body.brand = c.brand;
    if (c.manufacture) body.manufacture = c.manufacture;

    /* 카테고리 — 코드가 오면 그대로 쓰고, 경로만 오면 우리 표에서 찾아 코드를 얻는다.
       **못 찾으면 채우지 않는다.** 잘못된 코드로 등록하면 필수속성이 통째로 어긋난다. */
    let catMsg = '';
    let code = c.categoryCode;
    let path = c.categoryPath;
    if (!code && path) {
      const tail = String(path).split('>').pop().trim();
      const enc = encodeURIComponent(`*${tail.replace(/[(),*]/g, ' ').trim()}*`);
      const hits = await api('categories?select=category_code,full_path,name'
        + `&full_path.ilike.${enc}&limit=5`) || [];
      const exact = hits.find((h) => (h.full_path || '') === path)
        || hits.find((h) => (h.name || '') === tail);
      if (exact) { code = exact.category_code; path = exact.full_path; catMsg = ' · 카테고리는 경로로 찾아 맞췄습니다'; }
      else catMsg = ` · 카테고리 "${path}"를 우리 표에서 못 찾았습니다 — 카테고리 화면에서 직접 고르세요`;
    }
    if (code) {
      body.display_category_code = String(code);
      body.category_path = path || null;
      body.category_source = 'catalog';
      body.category_confirmed_at = new Date().toISOString();
    }

    await api(`listing_projects?id=eq.${LCAT.p.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body
    });

    /* 무엇을 근거로 무엇을 가져왔는지 남긴다. 조회수는 **그때만 볼 수 있는 값**이다. */
    await lstAddNote(LCAT.p.id, 'category',
      `카탈로그 매칭에서 가져옴: ${c.name || ''}`
      + (c.productId ? ` (상품ID ${c.productId})` : '')
      + (c.brand ? ` · 브랜드 ${c.brand}` : '')
      + (c.manufacture ? ` · 제조사 ${c.manufacture}` : '')
      + (c.pv != null ? ` · 그때 28일 조회 ${c.pv}` : '')
      + (c.sales != null ? ` · 28일 판매 ${c.sales}` : '')
      + (c.salePrice != null ? ` · 그때 가격 ${c.salePrice}원` : ''),
      { source: 'pre-matching', catalog: c.raw });

    toast('가져왔습니다' + (catMsg ? ' —' + catMsg : ''));
    if (catMsg) $('#lkMsg').textContent = catMsg.replace(/^ · /, '');
    $('#lkMsg').classList.toggle('hidden', !catMsg);

    /* 카테고리가 새로 정해졌으면 필수속성도 받아둔다 — 카테고리 화면과 같은 동작 */
    if (code) {
      try {
        const has = await api('coupang_category_meta?select=display_category_code'
          + `&display_category_code=eq.${encodeURIComponent(code)}&limit=1`);
        if (!has || !has.length) {
          await api('coupang_write_queue', {
            method: 'POST',
            body: { kind: 'category_meta', display_category_code: String(code), requested_by: AUTH.userId || null }
          });
        }
      } catch (e) { /* 029 미실행 — 넘어간다 */ }
    }
    /* 카테고리가 바뀌었으니 카테고리 화면을 다시 그린다 */
    if (typeof lcLoadCurrent === 'function') await lcLoadCurrent();
  } catch (e) {
    toast('저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
});

