/* ============================================================
   86-listing.js — 상품등록 (등록 준비 건 목록)
   ------------------------------------------------------------
   이 화면은 **쿠팡에 쏘기만 하는 자리**다. 값을 채우는 곳이 아니다.
   상품명·카테고리·대표이미지·상세페이지·물류/바코드는 각각의 화면에서 채우고,
   여기서는 "다 찼는가"만 보고 등록을 진행한다(사용자 결정 2026-08-21).

   진행 판정은 **화면이 하지 않는다.** db/migrations/031 의 v_listing_ready 가 한다.
   여기서 다시 판정하면 나중에 에이전트가 보는 기준과 화면이 보는 기준이 갈린다.

   **파일 순서 주의**(D-17): 이 파일은 85 뒤, 90 앞이다. 최상위 실행문은 앞 파일에
   있는 것만 참조한다($, api, esc, toast, AUTH …는 00-core.js).
   ============================================================ */

const LISTING = { rows: [], filter: '', loaded: false };

/* 단계 정의를 한 곳에 둔다 — 목록의 배지, 나중에 만들 작업 화면들, 그리고
   "무엇이 빠졌나" 문구가 전부 이 배열을 읽는다. */
const LISTING_STEPS = [
  { key: 'skeleton',  label: '뼈대',       col: 'step_skeleton'  },
  { key: 'category',  label: '카테고리',   col: 'step_category'  },
  { key: 'name',      label: '상품명',     col: 'step_name'      },
  { key: 'rep_image', label: '대표이미지', col: 'step_rep_image' },
  { key: 'detail',    label: '상세페이지', col: 'step_detail'    },
  { key: 'logistics', label: '물류·바코드', col: 'step_logistics' },
  { key: 'price',     label: '가격',       col: 'step_price'     }
];

const LISTING_STATUS_LABEL = {
  preparing: '준비중', ready: '등록 가능', submitted: '등록 요청함',
  registered: '등록됨', discarded: '버림'
};

/* ---------- 목록 ---------- */

async function loadListing() {
  const body = $('#lstRows');
  body.innerHTML = '<tr><td colspan="6"><div class="loader"><div class="spinner"></div>불러오는 중…</div></td></tr>';

  let projects, progress, reps;
  try {
    /* 세 번을 나눠 부르는 이유: 진행 판정은 뷰에만 있고, 대표이미지 썸네일은
       별도 표에 있다. 조인해서 한 번에 받으려면 뷰를 또 만들어야 하는데
       화면 하나 때문에 뷰를 늘리지 않는다. */
    [projects, progress, reps] = await Promise.all([
      api('listing_projects?select=*&order=updated_at.desc&limit=200'),
      api('v_listing_ready?select=*'),
      api('listing_assets?select=project_id,url&kind=eq.rep&is_selected=is.true')
    ]);
  } catch (e) {
    /* 031 미실행이면 404다. 화면을 깨뜨리지 말고 무엇을 해야 하는지 말한다(R-15). */
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    body.innerHTML = `<tr><td colspan="6" class="muted">${miss
      ? '아직 <b>db/migrations/031_listing_pipeline.sql</b> 을 실행하지 않았습니다 — '
        + 'Supabase SQL 편집기에서 실행하면 이 화면이 동작합니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</td></tr>`;
    $('#lstSummary').textContent = '—';
    return;
  }

  const progById = {};
  (progress || []).forEach((p) => { progById[p.id] = p; });
  const repById = {};
  (reps || []).forEach((a) => { if (!repById[a.project_id]) repById[a.project_id] = a.url; });

  LISTING.rows = (projects || []).map((p) => ({
    p, prog: progById[p.id] || {}, rep: repById[p.id] || null
  }));
  LISTING.loaded = true;

  renderListing();
}

function renderListing() {
  const rows = LISTING.rows.filter((r) => {
    if (!LISTING.filter) return r.p.status !== 'discarded';
    return r.p.status === LISTING.filter;
  });

  const ready = LISTING.rows.filter((r) => r.prog.all_done && r.p.status === 'preparing').length;
  $('#lstSummary').textContent =
    `${LISTING.rows.filter((r) => r.p.status !== 'discarded').length}건`
    + (ready ? ` · 등록 가능 ${ready}건` : '');

  const body = $('#lstRows');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">'
      + '준비 중인 상품이 없습니다. 소싱 → 즐겨찾기에서 [등록 준비]를 누르면 여기로 들어옵니다.'
      + '</td></tr>';
    return;
  }

  body.innerHTML = rows.map((r) => {
    const p = r.p;
    const g = r.prog;
    const name = (p.product_name || '').trim();
    const ref = (p.source_snapshot && p.source_snapshot.product_name) || '';

    const chips = LISTING_STEPS.map((s) => {
      const done = g[s.col] === true;
      return `<span class="prog ${done ? 'prog-ok' : 'prog-dim'}">${done ? '✓ ' : ''}${s.label}</span>`;
    }).join('');

    const missing = LISTING_STEPS.filter((s) => g[s.col] !== true).map((s) => s.label);
    const done = g.all_done === true;

    return `<tr data-lst="${esc(p.id)}">
      <td class="col-img">${r.rep
        ? `<img class="thumb" src="${esc(r.rep)}" alt="" onerror="this.style.visibility='hidden'" />`
        : '<div class="thumb"></div>'}</td>
      <td>
        <div class="pname">${name ? esc(name) : '<span class="muted">(상품명 미정)</span>'}</div>
        <div class="psub">${ref ? '참고: ' + esc(ref) : ''}${p.source_url
          ? ` · <a href="${esc(p.source_url)}" target="_blank" rel="noopener">원본</a>` : ''}</div>
      </td>
      <td class="col-num">${g.item_count || 0}</td>
      <td><div class="lst-chips">${chips}</div></td>
      <td class="col-mid">
        <span class="prog ${p.status === 'registered' ? 'prog-ok' : 'prog-dim'}">${
          esc(LISTING_STATUS_LABEL[p.status] || p.status)}</span>
        <div class="psub">${esc(String(p.updated_at || '').slice(0, 10))}</div>
      </td>
      <td class="col-mid">
        ${p.status === 'registered'
          ? `<span class="muted sm">상품ID ${esc(p.created_seller_product_id || '—')}</span>`
          : `<button class="btn btn-sm btn-primary lst-submit" ${done ? '' : 'disabled'}
               title="${done ? '쿠팡에 등록 요청' : '남은 단계: ' + esc(missing.join(' · '))}">등록</button>`}
        <button class="btn btn-sm btn-ghost lst-drop" title="이 준비 건을 버립니다">버림</button>
      </td>
    </tr>`;
  }).join('');
}

/* 상태 탭 */
$('#lstTabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  $$('#lstTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  LISTING.filter = t.dataset.status || '';
  renderListing();
});

$('#lstRefresh').onclick = () => loadListing();

/* ---------- 새 준비 건 ---------- */
/* 소싱에서 넘어오는 게 기본 경로다(사용자 확인). 여기 있는 건 소싱 목록에 없는
   상품을 직접 올릴 때를 위한 보조 입구다. */
$('#lstNewBtn').onclick = () => {
  $('#lstNewBox').classList.toggle('hidden');
  if (!$('#lstNewBox').classList.contains('hidden')) $('#lstNewName').focus();
};

$('#lstNewCreate').onclick = async () => {
  const name = ($('#lstNewName').value || '').trim();
  const url = ($('#lstNewUrl').value || '').trim();
  const btn = $('#lstNewCreate');
  btn.disabled = true;
  try {
    await createListingProject({
      source_kind: 'manual',
      product_name: name || null,
      source_url: url || null
    }, name ? `직접 만든 준비 건: ${name}` : '직접 만든 준비 건');
    $('#lstNewName').value = '';
    $('#lstNewUrl').value = '';
    $('#lstNewBox').classList.add('hidden');
    toast('준비 건을 만들었습니다');
    await loadListing();
  } catch (e) {
    toast('만들지 못했습니다: ' + e.message);
  } finally { btn.disabled = false; }
};

/* 준비 건 하나를 만든다. **옵션 1개를 같이 만든다** — 쿠팡 상품은 옵션이 최소
   하나 필요하고, 옵션이 0개면 대표이미지·물류·가격 단계가 판정 자체를 못 한다.
   출처 기록(step='source')도 이때 남긴다. 나중에 "이걸 왜 골랐더라"의 출발점이다. */
async function createListingProject(fields, sourceNote) {
  /* 늘 같은 값과 기본 양식을 여기서 붙인다(사용자 결정 2026-08-21).
     **부르는 쪽이 준 값이 이긴다** — 즐겨찾기에서 온 값을 설정이 덮으면 안 된다.
     설정/양식이 없거나 037·035 미실행이면 그냥 넘어간다(준비 건 생성은 막지 않는다). */
  const auto = {};
  try {
    const st = (await api('listing_settings?select=*&id=eq.1&limit=1'))[0];
    if (st) {
      if (st.default_brand) auto.brand = st.default_brand;
      if (st.default_manufacture) auto.manufacture = st.default_manufacture;
    }
  } catch (e) { /* 037 미실행 */ }
  try {
    const tpls = await api('listing_templates?select=id,kind&is_default=is.true') || [];
    tpls.forEach((t) => {
      if (t.kind === 'shipping') auto.shipping_template_id = t.id;
      if (t.kind === 'notice') auto.notice_template_id = t.id;
    });
  } catch (e) { /* 031·035 미실행 */ }

  const [p] = await api('listing_projects', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: Object.assign({ created_by: AUTH.userId || null }, auto, fields)
  });
  await api('listing_project_items', {
    method: 'POST',
    body: { project_id: p.id, position: 0 }
  });
  if (sourceNote) {
    await api('listing_step_notes', {
      method: 'POST',
      body: { project_id: p.id, step: 'source', note: sourceNote, created_by: AUTH.userId || null }
    });
  }
  return p;
}

/* ---------- 버림 ---------- */
/* 지우지 않고 status 만 바꾼다 — 거른 것도 남아야 "내가 뭘 접었나"를 나중에 본다
   (017 sourcing_candidates 가 버린 후보를 남기는 것과 같은 이유). */
$('#lstRows').addEventListener('click', async (ev) => {
  const tr = ev.target.closest('tr[data-lst]');
  if (!tr) return;
  const id = tr.dataset.lst;

  if (ev.target.closest('.lst-drop')) {
    if (!confirm('이 준비 건을 버릴까요? 기록은 남고 목록에서만 빠집니다.')) return;
    await api(`listing_projects?id=eq.${id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'discarded' }
    });
    toast('버렸습니다');
    await loadListing();
    return;
  }

  if (ev.target.closest('.lst-submit')) {
    await lstOpenSubmit(id);
  }
});

/* ---------- 즐겨찾기 → 등록 준비 ---------- */
/* 버튼 markup 은 10-sourcing.js 의 카드 렌더에 있고, 동작은 여기 있다.
   10 은 86보다 먼저 로드되므로 거기서 이 함수를 직접 부르면 안 된다 — 위임으로 받는다.
   (실제로는 클릭 시점이라 늦게 정의돼도 되지만, D-17 규칙을 눈으로 지키는 편이 낫다) */
$('#favList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.fav-listing');
  if (!btn) return;
  const card = btn.closest('.fav-card');
  const iid = card.dataset.iid;
  btn.disabled = true;
  try {
    /* 이미 만든 게 있으면 또 만들지 않는다 — 같은 상품으로 준비 건이 두 벌 생기면
       어느 쪽에 값을 채웠는지 알 수 없게 된다. */
    const dup = await api(`listing_projects?select=id,product_name,status`
      + `&ref_item_id=eq.${encodeURIComponent(iid)}&status=neq.discarded&limit=1`) || [];
    if (dup.length) {
      toast('이미 등록 준비 중인 상품입니다 — 상품등록 화면에서 이어서 하세요');
      return;
    }

    /* **판단 시점의 시장 모습은 나중에 절대 복원 못 한다**(017). 그래서 즐겨찾기 행을
       통째로 스냅샷으로 박아둔다. 지금 쓰지 않는 필드도 버리지 않는다(R-04). */
    const rows = await api(`v_favorites?select=*&item_id=eq.${encodeURIComponent(iid)}&limit=1`) || [];
    const f = rows[0] || {};

    const p = await createListingProject({
      source_kind: 'favorite',
      ref_product_id: f.product_id || null,
      ref_item_id: f.item_id || null,
      source_snapshot: f,
      /* 상품명은 **채우지 않는다.** 경쟁사 상품명을 그대로 옮기면 그게 초안이 되어
         버린다. 참고용으로 스냅샷에만 남기고, 이름은 상품명 화면에서 짓는다. */
      expected_sell_price: null
    }, `소싱 즐겨찾기에서 승격: ${f.product_name || ''} (현재가 ${f.current_price || '—'})`);

    toast('등록 준비를 만들었습니다 — 상품등록 화면에서 이어서 하세요');
    if (LISTING.loaded) loadListing();
    return p;
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    toast(miss
      ? 'db/migrations/031 을 아직 실행하지 않았습니다'
      : '만들지 못했습니다: ' + e.message);
  } finally { btn.disabled = false; }
});

/* ============================================================
   작업 화면들이 공유하는 것 — "지금 작업 중인 준비 건"
   ------------------------------------------------------------
   대표이미지·상세페이지·상품명·카테고리·물류 화면이 전부 같은 준비 건을 놓고
   일한다. 화면마다 따로 고르게 하면 "어느 상품을 편집 중인지"를 사람이 계속
   확인해야 한다. 그래서 고른 것을 여기 한 곳에 두고 localStorage 에 남긴다.
   ============================================================ */

LISTING.currentId = localStorage.getItem('listing_current') || '';

function lstSetCurrent(id) {
  LISTING.currentId = id || '';
  localStorage.setItem('listing_current', LISTING.currentId);
}

/* 아직 등록 전인 것만 고를 수 있게 한다 — 이미 등록된 상품을 여기서 고치면
   쿠팡에 반영되지 않아서 "바꿨는데 왜 그대로냐"가 된다(수정은 상품수정 화면). */
async function lstFetchOpenProjects() {
  return await api('listing_projects?select=id,product_name,status,source_snapshot'
    + '&status=in.(preparing,ready)&order=updated_at.desc&limit=200') || [];
}

/* 준비 건 하나를 통째로 읽는다. 작업 화면들이 공통으로 쓴다. */
async function lstFetchOne(id) {
  const [ps, items, prog] = await Promise.all([
    api(`listing_projects?select=*&id=eq.${id}&limit=1`),
    api(`listing_project_items?select=*&project_id=eq.${id}&order=position.asc`),
    api(`v_listing_ready?select=*&id=eq.${id}&limit=1`)
  ]);
  return { p: (ps || [])[0] || null, items: items || [], prog: (prog || [])[0] || {} };
}

/* 준비 건 고르는 select 를 채운다. 이름이 아직 없으면 참고 상품명을 보여준다 —
   "(상품명 미정)"만 여러 줄이면 무엇이 무엇인지 못 고른다. */
function lstFillPicker(sel, rows) {
  const label = (r) => (r.product_name || '').trim()
    || ('(이름 미정) ' + (((r.source_snapshot || {}).product_name) || '').slice(0, 28));
  sel.innerHTML = rows.length
    ? rows.map((r) => `<option value="${esc(r.id)}">${esc(label(r))}</option>`).join('')
    : '<option value="">준비 중인 상품이 없습니다</option>';
  if (rows.length) {
    if (!rows.some((r) => r.id === LISTING.currentId)) lstSetCurrent(rows[0].id);
    sel.value = LISTING.currentId;
  }
}

/* 단계 배지. 작업 화면 위쪽에 띄워 "지금 어디까지 됐는지"를 늘 보이게 한다.
   목록 화면과 같은 판정(v_listing_ready)을 쓴다 — 두 화면이 다른 말을 하면 안 된다. */
function lstStepBar(prog, activeKey) {
  return LISTING_STEPS.map((s) => {
    const done = prog[s.col] === true;
    const cls = s.key === activeKey ? 'prog prog-mid' : (done ? 'prog prog-ok' : 'prog prog-dim');
    return `<span class="${cls}">${done ? '✓ ' : ''}${s.label}</span>`;
  }).join('');
}

/* 단계마다 **봐야 할 지표가 다르다.** 등록 후 이 상품을 판정할 때 무엇을 볼지
   지금 박아둬야 AI가 매번 추측하지 않는다(026·D-18과 같은 생각).
   **키 이름을 워커의 PRIMARY_METRICS와 똑같이 쓴다** — 다른 낱말을 쓰면
   등록 전 근거와 등록 후 변경 이력이 서로 다른 어휘가 되어 한 줄로 못 잇는다. */
const LISTING_STEP_METRICS = {
  name:      ['views', 'visitors'],
  category:  ['views', 'visitors'],
  rep_image: ['views', 'visitors'],
  detail:    ['conversion_rate', 'cart_adds'],
  price:     ['conversion_rate', 'item_winner_rate']
};

/* 단계별 근거를 남긴다. append-only 라 고칠 때마다 행이 쌓이고 최신이 지금 생각이다. */
async function lstAddNote(projectId, step, note, extra) {
  const body = { project_id: projectId, step, note, created_by: AUTH.userId || null };
  const pm = LISTING_STEP_METRICS[step];
  if (pm) body.primary_metrics = pm;
  if (extra) body.extra = extra;
  await api('listing_step_notes', { method: 'POST', body });
}

/* 그 단계에 마지막으로 적은 근거. 화면을 다시 열었을 때 지난번 생각을 보여준다. */
async function lstLastNote(projectId, step) {
  const rows = await api(`listing_step_notes?select=note,created_at`
    + `&project_id=eq.${projectId}&step=eq.${step}&order=created_at.desc&limit=1`) || [];
  return rows[0] || null;
}

/* ============================================================
   등록 실행 — 준비 건 + 뼈대 두 벌 → 쿠팡 몸통 → 큐
   ------------------------------------------------------------
   **등록은 되돌릴 수 없다.** 그래서 만든 몸통을 먼저 보여주고 한 번 더 누르게 한다.

   워커(scripts/coupang-write-worker.js)와의 계약:
     payload = { source_seller_product_id, product{}, itemCommon{}, items[], requested }
   워커가 복제 원본을 조회해 식별자를 지우고, 여기서 준 값을 얹어 POST 한다.
   **워커를 고치면 여기도 같이 고쳐야 한다** — 두 곳이 어긋나면 조용히 원본 값이 등록된다.
   ============================================================ */

async function lstBuildPayload(projectId) {
  const { p, items } = await lstFetchOne(projectId);
  const warn = [];
  const auto = [];

  const [assets, tpls, metaRows, settingsRows] = await Promise.all([
    api(`listing_assets?select=*&project_id=eq.${projectId}&is_selected=is.true&order=set_no.asc,position.asc`),
    api('listing_templates?select=*'),
    p.display_category_code
      ? api('coupang_category_meta?select=raw&display_category_code=eq.'
          + encodeURIComponent(p.display_category_code) + '&limit=1')
      : Promise.resolve([]),
    api('listing_settings?select=*&id=eq.1&limit=1').catch(() => [])
  ]);
  const settingsRow = (settingsRows || [])[0] || null;
  const shipT = (tpls || []).find((t) => t.id === p.shipping_template_id);
  const noticeT = (tpls || []).find((t) => t.id === p.notice_template_id);
  const meta = (metaRows || [])[0] || null;

  if (!shipT) warn.push('배송·반품 뼈대가 없습니다');
  if (!noticeT) warn.push('고시정보·상품주요정보 뼈대가 없습니다');

  /* 복제 원본이 있어야 워커가 몸통을 만든다(빈 양식 등록은 아직 워커가 거부한다) */
  const src = p.clone_seller_product_id
    || (shipT && shipT.source_seller_product_id) || (noticeT && noticeT.source_seller_product_id);
  if (!src) warn.push('복제 원본이 없습니다 — 뼈대를 기존 상품에서 떠야 합니다');

  /* ── 상품 단위 ── */
  const product = Object.assign({},
    (shipT && shipT.payload.product) || {},
    (noticeT && noticeT.payload.product) || {},
    {
      sellerProductName: p.product_name || '',
      displayProductName: (p.display_product_name || p.product_name || ''),
      generalProductName: p.product_name || '',
      brand: p.brand || '',
      manufacture: p.manufacture || (settingsRow && settingsRow.default_manufacture) || p.brand || ''
    });
  if (p.display_category_code) product.displayCategoryCode = Number(p.display_category_code);
  /* 무엇으로 채웠는지 **정확히** 말한다. "브랜드명을 넣었다"고만 하면 설정값이 들어간
     경우에도 그렇게 보여서, 확인 화면이 사실과 다른 말을 하게 된다. */
  if (!p.manufacture) {
    const from = (settingsRow && settingsRow.default_manufacture) ? '등록 설정의 제조사'
      : (p.brand ? '브랜드명(쿠팡 안내와 같은 방식)' : null);
    if (from) auto.push(`제조사가 비어 ${from}을(를) 넣었습니다`);
    else warn.push('제조사가 비어 있습니다 — 등록 설정이나 카탈로그 매칭으로 채우세요');
  }

  /* ── 옵션 공통(뼈대) ── */
  const itemCommon = Object.assign({},
    (shipT && shipT.payload.item) || {},
    (noticeT && noticeT.payload.item) || {});

  /* 고시정보: 양식 값이 비었으면 **등록 설정의 기본값**으로 메운다(사용자 결정 2026-08-21).
     양식이 더 구체적이므로 양식이 우선이고, 설정은 빈 자리만 채운다. */
  const noticeDef = ((settingsRow || {}).notice_defaults || {}).items || {};
  if (Array.isArray(itemCommon.notices)) {
    itemCommon.notices = itemCommon.notices.map((n) => {
      const nm = n.noticeCategoryDetailName || '';
      if (String(n.content || '').trim() || !noticeDef[nm]) return n;
      auto.push(`고시정보 '${nm}' ← 등록 설정 기본값`);
      return Object.assign({}, n, { content: noticeDef[nm] });
    });
  }

  /* 고시정보의 '품명 및 모델명'은 상품명으로 채운다(사용자 결정 2026-08-21) */
  if (Array.isArray(itemCommon.notices)) {
    itemCommon.notices = itemCommon.notices.map((n) => {
      if (/품명/.test(n.noticeCategoryDetailName || '')) {
        auto.push(`고시정보 '${n.noticeCategoryDetailName}' ← 상품명`);
        return Object.assign({}, n, { content: p.product_name || '' });
      }
      return n;
    });
    const empty = itemCommon.notices.filter((n) => !String(n.content || '').trim());
    if (empty.length) warn.push(`고시정보 ${empty.length}개 항목이 비어 있습니다 `
      + `(${empty.map((n) => n.noticeCategoryDetailName).join(', ')})`);
  }
  /* 필수속성은 옵션별이라 공통에서 뺀다 */
  const attrTemplate = itemCommon.attributes || [];
  delete itemCommon.attributes;

  /* ── 옵션 ── */
  const repByItem = {};
  const detail = [];
  (assets || []).forEach((a) => {
    if (a.kind === 'rep' && a.item_id) repByItem[a.item_id] = a.url;
    if (a.kind === 'detail') detail.push(a.url);
  });

  const outItems = items.map((it) => {
    const name = (it.item_name || '').trim();
    const one = {
      itemName: name,
      salePrice: it.sale_price,
      marketplaceSalePrice: it.marketplace_sale_price,
      searchTags: p.search_tags || [],
      skuInfo: {
        inboundName: (it.inbound_name || '').trim()
          || [p.product_name, name].filter(Boolean).join(' '),
        width: it.sku_width, length: it.sku_length, height: it.sku_height,
        weight: it.sku_weight, netWeight: it.sku_net_weight,
        distributionPeriod: it.distribution_period || 0,
        expiredAtManaged: it.expired_at_managed === true,
        producedAtManaged: it.produced_at_managed === true,
        manufacturedAtManaged: it.manufactured_at_managed === true,
        fragile: it.fragile === true,
        originalBarcode: it.barcode_mode === 'own' ? (it.own_barcode || null) : null
      },
      attributes: lstBuildAttributes(meta, attrTemplate, it.attributes, p.search_filters,
                                     name, auto, warn)
    };
    if (repByItem[it.id]) {
      one.images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: repByItem[it.id] }];
    } else {
      warn.push(`옵션 "${name || '(이름없음)'}"에 대표이미지가 없습니다`);
    }
    /* 상세페이지: 세트를 골랐으면 그것으로, '복제 원본 그대로'면 아예 안 준다
       (워커가 원본 이미지를 우리 Storage로 옮겨 넣는다) */
    if (p.detail_source !== 'clone') {
      if (detail.length) {
        one.contents = detail.map((u) => ({
          contentsType: 'IMAGE_NO_SPACE',
          contentDetails: [{ content: u, detailType: 'IMAGE' }]
        }));
      } else {
        warn.push('상세페이지 세트를 고르지 않았습니다');
      }
    }
    if (it.barcode_mode === 'own') {
      warn.push(`옵션 "${name}"이 자체 바코드를 씁니다 — **이 경로는 미검증**입니다`);
    }
    return one;
  });

  return {
    payload: { source_seller_product_id: src ? String(src) : null,
               product, itemCommon, items: outItems, requested: p.requested === true },
    warn, auto, project: p
  };
}

/* 속성 만들기 — **추측하지 않는다**(2026-08-21 개편).
   ------------------------------------------------------------
   쿠팡은 필수속성과 검색필터를 한 배열(items[].attributes)로 받는다. 값의 출처는 셋:
     필수속성  옵션·가격 화면에서 옵션마다 입력  → listing_project_items.attributes
     검색필터  검색필터 화면에서 상품 단위 입력   → listing_projects.search_filters
     그 외     뼈대(복제 원본)에 있던 값
   앞의 둘이 우리 값이므로 **뼈대 값보다 우선**한다.

   예전에는 값을 담을 자리가 없어서 색상←옵션명, 무게←잰 값으로 **추측해서** 채웠다.
   그때 실측으로 드러난 사고가 `색상=감자색 · 개당 중량=70g`(복제 원본 값)이 그대로
   나갈 뻔한 것이다. 이제 자리가 생겨서 추측이 사라졌다.

   순서는 카테고리 메타를 따른다 — 쿠팡이 정한 순서가 곧 옵션명 순서다. */
function lstBuildAttributes(meta, template, itemAttrs, filters, itemName, auto, warn) {
  const metaAttrs = ((meta && meta.raw && meta.raw.attributes) || []);
  const byName = {};
  (template || []).forEach((a) => { byName[a.attributeTypeName] = a; });

  const label = itemName || '(이름없음)';
  const out = [];
  const used = {};

  metaAttrs.forEach((m) => {
    const nm = m.attributeTypeName;
    used[nm] = 1;
    const base = byName[nm] || {};
    let value = null;
    let from = null;

    if (itemAttrs && itemAttrs[nm] != null && String(itemAttrs[nm]).trim()) {
      value = String(itemAttrs[nm]).trim(); from = '옵션';
    } else if (filters && filters[nm] != null && String(filters[nm]).trim()) {
      value = String(filters[nm]).trim(); from = '검색필터';
    } else if (base.attributeValueName && String(base.attributeValueName).trim()) {
      value = String(base.attributeValueName).trim(); from = '뼈대';
    }

    if (m.required === 'MANDATORY') {
      if (!value) { warn.push(`[${label}] 필수속성 '${nm}'이 비어 있습니다 — 옵션·가격 화면에서 채우세요`); }
      else if (from === '뼈대') {
        /* 복제 원본 값이 그대로 나가는 자리다. **조용히 넘기지 않는다.** */
        auto.push(`[${label}] '${nm}' = "${value}" — 복제 원본 값입니다. 맞는지 확인하세요`);
      }
    }
    if (!value) return;   // 빈 값은 안 보낸다
    out.push({
      attributeTypeName: nm,
      attributeValueName: value,
      exposed: base.exposed || m.exposed || 'NONE',
      editable: base.editable === undefined ? true : base.editable
    });
  });

  /* 메타에 없는데 뼈대에 있던 속성 — 카테고리가 달라졌을 때 생긴다.
     **버린다.** 다른 카테고리의 속성을 보내면 등록이 거부된다. */
  (template || []).forEach((a) => {
    if (used[a.attributeTypeName]) return;
    if (!String(a.attributeValueName || '').trim()) return;
    warn.push(`뼈대의 '${a.attributeTypeName}'은 이 카테고리에 없는 속성이라 뺐습니다`);
  });

  return out;
}

/* ---------- 등록 확인 모달 ---------- */
/* **등록은 되돌릴 수 없다.** 그래서 무엇을 보낼지 먼저 보여주고, 경고가 있으면
   그것부터 읽게 한다. 자동으로 채운 값도 반드시 보여준다 — 조용히 채우면
   틀린 값이 그대로 등록된다. */
async function lstOpenSubmit(projectId) {
  const modal = $('#lstSubmitModal');
  modal.classList.remove('hidden');
  $('#lstSubBody').innerHTML = '<div class="loader"><div class="spinner"></div>몸통을 만드는 중…</div>';
  $('#lstSubGo').disabled = true;
  $('#lstSubMsg').classList.add('hidden');

  let built;
  try {
    built = await lstBuildPayload(projectId);
  } catch (e) {
    $('#lstSubBody').innerHTML = '<p class="msg err">몸통을 못 만들었습니다: ' + esc(e.message) + '</p>';
    return;
  }
  LISTING.building = built;

  const p = built.project;
  const pay = built.payload;
  const blocking = !pay.source_seller_product_id;

  const rows = pay.items.map((it) => '<tr>'
    + '<td>' + esc(it.itemName || '(이름없음)') + '</td>'
    + '<td class="col-num">' + (it.salePrice ? won(it.salePrice) : '—') + '</td>'
    + '<td class="col-num">' + (it.marketplaceSalePrice ? won(it.marketplaceSalePrice) : '—') + '</td>'
    + '<td class="sm">' + esc(it.skuInfo.inboundName) + '</td>'
    + '<td class="sm">' + it.skuInfo.width + '×' + it.skuInfo.length + '×' + it.skuInfo.height
      + 'mm · ' + it.skuInfo.weight + 'g</td>'
    + '<td class="sm">' + (it.skuInfo.originalBarcode ? esc(it.skuInfo.originalBarcode) : '쿠팡 발급') + '</td>'
    + '</tr>').join('');

  $('#lstSubBody').innerHTML =
    '<div class="kv-grid">'
    + '<span class="kv"><span class="kv-k">상품명</span><span class="kv-v">' + esc(pay.product.sellerProductName) + '</span></span>'
    + '<span class="kv"><span class="kv-k">카테고리</span><span class="kv-v">' + esc(p.category_path || pay.product.displayCategoryCode || '—') + '</span></span>'
    + '<span class="kv"><span class="kv-k">옵션</span><span class="kv-v">' + pay.items.length + '개</span></span>'
    + '<span class="kv"><span class="kv-k">복제 원본</span><span class="kv-v">' + esc(pay.source_seller_product_id || '없음') + '</span></span>'
    + '</div>'
    + '<h4 class="sku-sec">옵션</h4>'
    + '<div class="table-wrap"><table class="grid"><thead><tr>'
    + '<th>옵션명</th><th class="col-num">로켓그로스</th><th class="col-num">판매자배송</th>'
    + '<th>입고 표기명</th><th>규격</th><th>바코드</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + (built.auto.length
        ? '<h4 class="sku-sec">자동으로 채운 값 <span class="muted sm">— 틀렸으면 지금 고치세요</span></h4><ul class="sm">'
          + built.auto.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
        : '')
    + (built.warn.length
        ? '<div class="msg err"><b>확인이 필요합니다</b><ul class="sm">'
          + built.warn.map((w) => '<li>' + w + '</li>').join('') + '</ul></div>'
        : '')
    + (blocking ? '<p class="msg err">복제 원본이 없어 등록할 수 없습니다 — 뼈대를 기존 상품에서 뜨세요.</p>' : '')
    + '<details style="margin-top:10px"><summary class="muted sm">쿠팡에 보낼 몸통 전체 보기</summary>'
    + '<textarea rows="16" readonly style="width:100%;font-family:monospace;font-size:12px">'
    + esc(JSON.stringify(pay, null, 1)) + '</textarea></details>'
    + '<label class="chk" style="margin-top:10px"><input type="checkbox" id="lstSubRequested"'
    + (pay.requested ? ' checked' : '') + ' />'
    + '<span>등록과 동시에 <b>승인 요청</b>까지 보냅니다 (체크를 빼면 임시저장 상태로 들어갑니다)</span></label>';

  $('#lstSubGo').disabled = blocking;
  $('#lstSubGo').dataset.pid = projectId;
}

$('#lstSubmitModal').addEventListener('click', (ev) => {
  if (ev.target.matches('[data-close], .modal-backdrop')) $('#lstSubmitModal').classList.add('hidden');
});

/* 진짜 등록 — 여기서부터는 되돌릴 수 없다 */
$('#lstSubGo').onclick = async () => {
  const built = LISTING.building;
  if (!built) return;
  const btn = $('#lstSubGo');
  const pid = btn.dataset.pid;
  btn.disabled = true;
  $('#lstSubMsg').classList.remove('hidden');
  $('#lstSubMsg').textContent = '등록 요청을 넣는 중…';

  try {
    const payload = built.payload;
    payload.requested = $('#lstSubRequested').checked === true;

    /* 판단을 먼저 박제한다. **등록이 실패해도 판단은 남아야 한다** —
       "이렇게 보고 골랐는데 등록이 안 됐다"도 기록이다(017). */
    let decisionId = built.project.sourcing_decision_id || null;
    if (!decisionId) {
      const p = built.project;
      const snap = p.source_snapshot || {};
      const cat = p.catalog_snapshot || {};
      const [made] = await api('sourcing_decisions', {
        method: 'POST', headers: { prefer: 'return=representation' },
        body: {
          method: p.source_kind,
          snapshot_min_price: snap.current_price || cat.salePrice || null,
          snapshot_review_count: cat.ratingCount || null,
          snapshot_raw: { favorite: snap, catalog: cat },
          expected_monthly_qty: p.expected_monthly_qty,
          expected_unit_cost_krw: p.expected_unit_cost_krw,
          expected_sell_price: p.expected_sell_price || (payload.items[0] || {}).salePrice || null,
          expected_margin_rate: p.expected_margin_rate,
          reason_memo: p.reason_memo
        }
      });
      decisionId = made.id;
      await api('listing_projects?id=eq.' + pid, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { sourcing_decision_id: decisionId }
      });
    }
    payload.sourcing_decision_id = decisionId;

    const [q] = await api('coupang_write_queue', {
      method: 'POST', headers: { prefer: 'return=representation' },
      body: { kind: 'product_create', payload, requested_by: AUTH.userId || null }
    });

    await api('listing_projects?id=eq.' + pid, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { status: 'submitted', submitted_queue_id: q.id,
              submitted_at: new Date().toISOString(), requested: payload.requested }
    });
    await lstAddNote(pid, 'submit',
      '쿠팡 등록 요청 (옵션 ' + payload.items.length + '개, '
      + (payload.requested ? '승인요청까지' : '임시저장') + ')', { queue_id: q.id });

    $('#lstSubMsg').textContent = '등록을 요청했습니다 — VPS 워커가 처리합니다. 결과를 지켜봅니다.';
    lstWatchQueue(q.id, pid);
    await loadListing();
  } catch (e) {
    $('#lstSubMsg').textContent = '요청 실패: ' + e.message;
    btn.disabled = false;
  }
};

/* 큐가 처리되는지 지켜본다. **워커가 꺼져 있으면 영원히 기다리게 되므로**
   2분이 지나면 그 사실을 말한다(가격 변경 화면과 같은 규칙). */
function lstWatchQueue(queueId, projectId) {
  const started = Date.now();
  const tick = async () => {
    let row;
    try {
      row = (await api('coupang_write_queue?select=*&id=eq.' + queueId + '&limit=1'))[0];
    } catch (e) { return; }
    if (!row) return;

    if (row.status === 'done' || row.status === 'failed') {
      const ok = row.status === 'done';
      $('#lstSubMsg').innerHTML = ok
        ? '<b>등록되었습니다.</b> 새 상품ID ' + esc(row.created_seller_product_id || '—')
        : '<b class="neg">등록 실패</b> — ' + esc(String(row.response_body || '').slice(0, 400));
      if (ok) {
        await api('listing_projects?id=eq.' + projectId, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: { status: 'registered', created_seller_product_id: row.created_seller_product_id,
                  registered_at: new Date().toISOString() }
        });
      } else {
        /* 실패하면 다시 준비중으로 돌린다 — 고쳐서 다시 시도할 수 있어야 한다 */
        await api('listing_projects?id=eq.' + projectId, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { status: 'preparing' }
        });
        $('#lstSubGo').disabled = false;
      }
      await loadListing();
      return;
    }

    if (Date.now() - started > 120000) {
      $('#lstSubMsg').innerHTML = '2분이 지나도 처리되지 않았습니다 — '
        + '<b>VPS 워커가 꺼져 있을 수 있습니다.</b> 요청은 큐에 남아 있어서 워커가 켜지면 처리됩니다.';
      return;
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

/* ============================================================
   순서 강제 — 카테고리가 먼저다 (사용자 결정 2026-08-21)
   ------------------------------------------------------------
   **카테고리에 따라 채워야 할 게 달라진다** — 필수속성·검색필터·고시정보 종류·
   수수료·입출고비가 전부 카테고리에서 나온다. 카테고리를 안 정한 채로 다른 걸
   먼저 채우면 나중에 안 맞아서 다시 해야 한다.

   막는 방식은 **열리되 입력만 잠그는 것**이다(사용자 선택). 아예 못 열게 하면
   그 화면에 뭐가 있는지도 볼 수 없다.
   ============================================================ */
function lstGuardCategory(p, bodyEl, items) {
  if (!bodyEl) return true;
  const host = bodyEl.parentNode;
  let g = host.querySelector('.lst-guard');

  /* 무엇이 먼저 필요한지 순서대로 본다. **카테고리 → 옵션** 순이다.
     items 를 넘기지 않은 화면은 카테고리만 본다. */
  let need = null;
  if (!(p && p.display_category_code)) {
    need = {
      page: 'listing-category', label: '카테고리 정하러 가기',
      msg: '<b>카테고리를 먼저 정해야 합니다.</b> '
        + '카테고리에 따라 필수속성·검색필터·고시정보·수수료가 전부 달라집니다 — '
        + '먼저 정하지 않으면 여기서 채운 값이 나중에 안 맞습니다.'
    };
  } else if (items && !(items || []).some((it) => String(it.item_name || '').trim())) {
    /* WING 도 검색필터를 열면 "옵션을 먼저 설정해주세요"로 막는다(2026-08-21 캡처).
       옵션명이 필수속성의 조합이라, 옵션이 없으면 채울 대상 자체가 없다. */
    need = {
      page: 'listing-price', label: '옵션 만들러 가기',
      msg: '<b>옵션을 먼저 만들어야 합니다.</b> '
        + '옵션명은 필수속성(색상·수량 등)의 조합이라, 옵션이 없으면 여기서 채울 대상이 없습니다. '
        + 'WING 도 같은 이유로 막습니다.'
    };
  }

  if (!need) {
    if (g) g.remove();
    bodyEl.classList.remove('dim-block');
    return true;
  }
  if (!g) {
    g = document.createElement('div');
    g.className = 'msg err lst-guard';
    host.insertBefore(g, bodyEl);
  }
  g.innerHTML = need.msg
    + ` <button class="btn btn-sm lst-go-cat" data-page="${need.page}" style="margin-left:6px">`
    + `${need.label}</button>`;
  bodyEl.classList.add('dim-block');
  return false;
}

/* 배너의 버튼. 화면마다 따로 걸지 않고 한 번만 건다(위임). */
document.addEventListener('click', (ev) => {
  const go = ev.target.closest('.lst-go-cat');
  if (!go) return;
  const page = go.dataset.page || 'listing-category';
  const btn = Array.from(document.querySelectorAll('.nav-item'))
    .find((b) => b.dataset.page === page);
  if (btn) btn.click();
});
