/* ============================================================
   92-listing-detail.js — 상세페이지
   ------------------------------------------------------------
   대표이미지와 흐름은 같다(후보를 남기고 하나를 고른다). 다른 점은 하나:
   **상세페이지는 여러 장이 한 덩어리**라서 낱장이 아니라 **세트**로 고른다.
   그래야 "A안에서 B안으로 바꿨더니 전환율이 어땠나"를 판정할 수 있다.

   한 장짜리 긴 이미지도 같은 구조다 — 장 수가 1인 세트일 뿐이다.
   따로 취급하지 않는다(코드가 두 갈래가 되면 이력도 두 모양이 된다).

   상세페이지를 바꾸면 **구매전환율·장바구니**를 본다. 조회는 안 변하는 게 정상이다
   (026 PRIMARY_METRICS: conversion_rate · cart_adds).

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞.
   ============================================================ */

const LD = { p: null, assets: [] };

async function loadListingDetail() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#ldBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#ldPicker'), rows);
  await ldLoadCurrent();
}

async function ldLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#ldBody').classList.add('hidden');
    $('#ldEmpty').classList.remove('hidden');
    $('#ldSteps').innerHTML = '';
    return;
  }
  $('#ldEmpty').classList.add('hidden');
  $('#ldBody').classList.remove('hidden');
  $('#ldSets').innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  let assets;
  try {
    assets = await api(`listing_assets?select=*&project_id=eq.${id}&kind=eq.detail`
      + '&order=set_no.asc,position.asc');
  } catch (e) {
    /* 033 미실행이면 set_no 정렬에서 400 이 난다. 무엇을 해야 하는지 말한다(R-15). */
    if (/set_no/.test(e.message)) {
      $('#ldSets').innerHTML = '<p class="muted">아직 <b>db/migrations/033_detail_sets.sql</b> 을 '
        + '실행하지 않았습니다 — Supabase에서 실행하면 이 화면이 동작합니다.</p>';
      return;
    }
    $('#ldSets').innerHTML = `<p class="muted">불러오지 못했습니다: ${esc(e.message)}</p>`;
    return;
  }

  const { p, prog } = await lstFetchOne(id);
  LD.p = p;
  LD.assets = assets || [];

  $('#ldSteps').innerHTML = lstStepBar(prog, 'detail');
  $('#ldUseClone').checked = (p.detail_source === 'clone');
  ldRender();

  const last = await lstLastNote(id, 'detail');
  $('#ldNote').value = '';
  $('#ldNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';
}

function ldSets() {
  const by = {};
  LD.assets.forEach((a) => { (by[a.set_no] = by[a.set_no] || []).push(a); });
  return Object.keys(by).map(Number).sort((x, y) => x - y).map((no) => ({
    no,
    label: (by[no].find((a) => a.set_label) || {}).set_label || null,
    items: by[no].sort((a, b) => a.position - b.position),
    selected: by[no].some((a) => a.is_selected)
  }));
}

function ldRender() {
  const clone = $('#ldUseClone').checked;
  $('#ldSets').classList.toggle('dim-block', clone);

  const sets = ldSets();
  if (!sets.length) {
    $('#ldSets').innerHTML = '<p class="muted">아직 올린 상세페이지가 없습니다. '
      + '[+ 새 세트 올리기]로 여러 장을 한 번에 올리세요 — 고른 순서가 곧 노출 순서입니다.</p>';
    return;
  }

  $('#ldSets').innerHTML = sets.map((s) => {
    const one = s.items.length === 1;
    const total = s.items.reduce((sum, a) => sum + (a.bytes || 0), 0);
    return `<div class="lp-card ${s.selected ? 'ld-on' : ''}" data-ld-set="${s.no}">
      <div class="lp-card-head">
        <b style="flex:1">세트 ${s.no}
          <span class="muted sm">${s.items.length}장${one ? ' · 한 장짜리 긴 이미지' : ''}
            · ${Math.round(total / 1024).toLocaleString()}KB
            · ${esc(String(s.items[0].created_at).slice(0, 10))}</span></b>
        ${s.selected
          ? '<span class="prog prog-ok">이걸로 등록됩니다</span>'
          : '<button class="btn btn-sm btn-primary ld-pick">이 세트 쓰기</button>'}
        <label class="btn btn-sm">+ 추가
          <input type="file" class="ld-add" accept="image/*" multiple hidden /></label>
        ${s.selected ? '' : '<button class="btn btn-sm btn-ghost ld-drop">세트 삭제</button>'}
      </div>
      <div class="ld-strip">
        ${s.items.map((a, i) => `<div class="ld-img" data-ld-asset="${esc(a.id)}">
            <img src="${esc(a.url)}" alt="" />
            <div class="xs muted">${i + 1}${a.width_px ? ` · ${a.width_px}×${a.height_px}` : ''}</div>
            <div class="li-cand-btns">
              <button class="btn btn-sm ld-up" ${i === 0 ? 'disabled' : ''} title="앞으로">▲</button>
              <button class="btn btn-sm ld-down" ${i === s.items.length - 1 ? 'disabled' : ''} title="뒤로">▼</button>
              <button class="btn btn-sm btn-ghost ld-del" title="이 장만 삭제">✕</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

/* ---------- 복제 원본 그대로 쓰기 ---------- */
/* 상세페이지를 새로 안 만들고 뼈대 상품 것을 그대로 쓰는 경우. 이것도 **선택**이라
   기록으로 남는다 — 나중에 "상세를 안 만든 상품들"을 따로 볼 수 있다. */
$('#ldUseClone').addEventListener('change', async () => {
  if (!LD.p) return;
  const clone = $('#ldUseClone').checked;
  try {
    await api(`listing_projects?id=eq.${LD.p.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { detail_source: clone ? 'clone' : 'assets' }
    });
    LD.p.detail_source = clone ? 'clone' : 'assets';
    ldRender();
    const { prog } = await lstFetchOne(LD.p.id);
    $('#ldSteps').innerHTML = lstStepBar(prog, 'detail');
    toast(clone ? '복제 원본의 상세페이지를 씁니다' : '올린 세트를 씁니다');
  } catch (e) {
    toast('저장 실패: ' + e.message);
  }
});

/* ---------- 새 세트 올리기 ---------- */
$('#ldNewSet').addEventListener('change', async (ev) => {
  const files = Array.from(ev.target.files || []);
  if (!files.length || !LD.p) return;
  const nextNo = Math.max(0, ...LD.assets.map((a) => a.set_no || 1)) + 1;
  await ldUpload(files, nextNo, 0);
  ev.target.value = '';
});

/* 기존 세트에 추가 */
$('#ldSets').addEventListener('change', async (ev) => {
  if (!ev.target.matches('.ld-add')) return;
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  const setNo = Number(ev.target.closest('[data-ld-set]').dataset.ldSet);
  const cur = LD.assets.filter((a) => a.set_no === setNo);
  await ldUpload(files, setNo, cur.length);
  ev.target.value = '';
});

/* **고른 순서가 곧 노출 순서다.** 파일 탐색기 순서와 다를 수 있으므로 올린 뒤 눈으로
   확인하게 번호를 붙여 보여준다. 가로·세로는 올릴 때 재둔다(나중엔 못 잰다). */
async function ldUpload(files, setNo, startPos) {
  const msg = $('#ldMsg');
  msg.classList.remove('hidden');
  msg.textContent = `${files.length}장 올리는 중…`;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const dim = await liReadSize(f);          // 90-listing-image.js 의 것을 재사용
      const url = await uploadProductImage(f, 'listing/' + LD.p.id);
      await api('listing_assets', {
        method: 'POST',
        body: {
          project_id: LD.p.id, kind: 'detail', set_no: setNo, position: startPos + i,
          url, storage_path: url.split('/product-images/')[1] || null,
          mime: f.type || null, bytes: f.size || null,
          width_px: dim.w || null, height_px: dim.h || null,
          origin: 'upload', label: f.name.slice(0, 60), created_by: AUTH.userId || null
        }
      });
    }
    msg.textContent = `세트 ${setNo}에 ${files.length}장 올렸습니다 — 순서를 확인하세요.`;
    await ldLoadCurrent();
  } catch (e) {
    msg.textContent = '올리지 못했습니다: ' + e.message;
  }
}

/* ---------- 세트 고르기 · 순서 · 삭제 ---------- */
$('#ldSets').addEventListener('click', async (ev) => {
  const setEl = ev.target.closest('[data-ld-set]');
  if (!setEl || !LD.p) return;
  const setNo = Number(setEl.dataset.ldSet);

  if (ev.target.closest('.ld-pick')) {
    ev.target.disabled = true;
    try {
      /* 쓰던 세트를 내리고 새 세트를 올린다. **내린 시각을 남긴다** — 그게 교체 이력이다.
         낱장이 아니라 세트 통째로 바뀌므로 그 세트의 모든 장에 같은 시각이 찍힌다. */
      const now = new Date().toISOString();
      const prev = LD.assets.filter((a) => a.is_selected && a.set_no !== setNo);
      for (const a of prev) {
        await api(`listing_assets?id=eq.${a.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: { is_selected: false, unselected_at: now }
        });
      }
      for (const a of LD.assets.filter((x) => x.set_no === setNo)) {
        await api(`listing_assets?id=eq.${a.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: { is_selected: true, selected_at: now, unselected_at: null }
        });
      }
      /* 세트를 골랐다는 건 복제 원본을 안 쓴다는 뜻이다 — 두 곳이 어긋나지 않게 같이 맞춘다 */
      if (LD.p.detail_source !== 'assets') {
        await api(`listing_projects?id=eq.${LD.p.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { detail_source: 'assets' }
        });
      }
      toast(`세트 ${setNo}로 정했습니다`);
      await ldLoadCurrent();
    } catch (e) {
      toast('저장 실패: ' + e.message);
    }
    return;
  }

  if (ev.target.closest('.ld-drop')) {
    const items = LD.assets.filter((a) => a.set_no === setNo);
    const used = items.some((a) => a.selected_at);
    if (used) { toast('한 번이라도 쓴 세트는 지울 수 없습니다 — 이력이 끊깁니다'); return; }
    if (!confirm(`세트 ${setNo}(${items.length}장)를 지울까요?`)) return;
    for (const a of items) {
      await api(`listing_assets?id=eq.${a.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    }
    await ldLoadCurrent();
    return;
  }

  const imgEl = ev.target.closest('[data-ld-asset]');
  if (!imgEl) return;
  const assetId = imgEl.dataset.ldAsset;

  if (ev.target.closest('.ld-del')) {
    const a = LD.assets.find((x) => x.id === assetId);
    if (a && a.selected_at) { toast('한 번이라도 쓴 장은 지울 수 없습니다'); return; }
    await api(`listing_assets?id=eq.${assetId}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await ldRenumber(setNo, assetId);
    await ldLoadCurrent();
    return;
  }

  if (ev.target.closest('.ld-up') || ev.target.closest('.ld-down')) {
    const dir = ev.target.closest('.ld-up') ? -1 : 1;
    const items = LD.assets.filter((a) => a.set_no === setNo).sort((a, b) => a.position - b.position);
    const idx = items.findIndex((a) => a.id === assetId);
    const other = items[idx + dir];
    if (!other) return;
    await api(`listing_assets?id=eq.${assetId}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { position: other.position }
    });
    await api(`listing_assets?id=eq.${other.id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { position: items[idx].position }
    });
    await ldLoadCurrent();
  }
});

/* 장을 지우면 번호에 구멍이 난다. 구멍 자체는 순서에 영향이 없지만(정렬만 하므로),
   나중에 추가할 때 position 이 겹치지 않도록 촘촘하게 다시 매긴다. */
async function ldRenumber(setNo, removedId) {
  const items = LD.assets.filter((a) => a.set_no === setNo && a.id !== removedId)
    .sort((a, b) => a.position - b.position);
  for (let i = 0; i < items.length; i++) {
    if (items[i].position === i) continue;
    await api(`listing_assets?id=eq.${items[i].id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { position: i }
    });
  }
}

$('#ldPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await ldLoadCurrent();
});

$('#ldNoteSave').onclick = async () => {
  if (!LD.p) return;
  const note = ($('#ldNote').value || '').trim();
  if (!note) { toast('메모를 적으세요'); return; }
  const btn = $('#ldNoteSave');
  btn.disabled = true;
  try {
    await lstAddNote(LD.p.id, 'detail', note);
    toast('메모를 남겼습니다');
    await ldLoadCurrent();
  } catch (e) {
    toast('저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
};
