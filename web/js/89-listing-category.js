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
