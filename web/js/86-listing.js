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
  const [p] = await api('listing_projects', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: Object.assign({ created_by: AUTH.userId || null }, fields)
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
    /* 등록 실행은 ④단계에서 붙인다. 지금 누를 수 있는 건 모든 단계가 끝난
       건뿐인데, 작업 화면들이 아직 없어서 여기까지 오는 경우가 없다.
       **버튼이 조용히 아무것도 안 하는 것**이 제일 나쁘므로 말은 해준다. */
    toast('등록 실행은 다음 단계에서 연결됩니다 — 아직 쿠팡에 아무것도 보내지 않았습니다');
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
