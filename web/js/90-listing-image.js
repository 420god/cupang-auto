/* ============================================================
   90-listing-image.js — 대표이미지
   ------------------------------------------------------------
   **고른 것만 남기지 않는다.** 올린 후보를 전부 남기고, 그중 하나에 표시만 한다.
   버린 후보가 있어야 나중에 "무엇 대신 무엇을 골랐나"를 볼 수 있고, 등록 후
   썸네일 교체 실험(product_change_history)과도 한 줄로 이어진다.

   교체 이력은 `is_selected` + `selected_at`/`unselected_at` 로 남는다.
   그래서 "이 옵션의 대표이미지 변천사"를 날짜순으로 뽑을 수 있다.

   대표이미지는 **옵션별**이다(사용자 확인 2026-08-21). 다만 실무에서는 같은 그림을
   여러 옵션에 쓰는 일이 잦아서 [모든 옵션에 적용]을 둔다.

   파일 순서 주의(D-17): 86 뒤, 95-boot 앞. 86의 공용 헬퍼를 쓴다.
   ============================================================ */

const LIMG = { p: null, items: [], assets: [] };

/* 쿠팡이 안내하는 대표이미지 기준. **우리가 실물로 검증한 값이 아니다**(R-14) —
   그래서 막지 않고 '안내 기준과 다름'이라고만 말한다. 실제 등록이 거부되면
   그때 이 값을 고치고 검증됨으로 표시한다. */
const LIMG_GUIDE = { min: 500, recommend: 1000, maxBytes: 10 * 1024 * 1024 };

async function loadListingImage() {
  let rows;
  try {
    rows = await lstFetchOpenProjects();
  } catch (e) {
    const miss = /PGRST205|does not exist|Not Found|404/i.test(e.message);
    $('#liBody').innerHTML = `<p class="muted">${miss
      ? '아직 <b>db/migrations/031_listing_pipeline.sql</b> 을 실행하지 않았습니다.'
      : '불러오지 못했습니다: ' + esc(e.message)}</p>`;
    return;
  }
  lstFillPicker($('#liPicker'), rows);
  await liLoadCurrent();
}

async function liLoadCurrent() {
  const id = LISTING.currentId;
  if (!id) {
    $('#liBody').classList.add('hidden');
    $('#liEmpty').classList.remove('hidden');
    $('#liSteps').innerHTML = '';
    return;
  }
  $('#liEmpty').classList.add('hidden');
  $('#liBody').classList.remove('hidden');
  $('#liItems').innerHTML = '<div class="loader"><div class="spinner"></div>불러오는 중…</div>';

  const [{ p, items, prog }, assets] = await Promise.all([
    lstFetchOne(id),
    api(`listing_assets?select=*&project_id=eq.${id}&kind=eq.rep&order=created_at.desc`)
  ]);
  LIMG.p = p;
  LIMG.items = items;
  LIMG.assets = assets || [];

  $('#liSteps').innerHTML = lstStepBar(prog, 'rep_image');
  lstGuardCategory(p, $('#liBody'), items);
  liRender();

  const last = await lstLastNote(id, 'rep_image');
  $('#liNote').value = '';
  $('#liNoteLast').textContent = last
    ? `지난번 메모(${String(last.created_at).slice(0, 10)}): ${last.note || ''}`
    : '';
}

function liRender() {
  if (!LIMG.items.length) {
    $('#liItems').innerHTML = '<p class="muted">옵션이 없습니다 — 옵션·가격 화면에서 먼저 만드세요.</p>';
    return;
  }
  $('#liItems').innerHTML = LIMG.items.map((it) => {
    const mine = LIMG.assets.filter((a) => a.item_id === it.id);
    const sel = mine.find((a) => a.is_selected);
    const name = (it.item_name || '').trim() || `옵션 ${it.position + 1}`;

    return `<div class="lp-card" data-li-item="${esc(it.id)}">
      <div class="lp-card-head">
        <b style="flex:1">${esc(name)}</b>
        <label class="btn btn-sm">올리기
          <input type="file" class="li-file" accept="image/*" multiple hidden /></label>
      </div>

      <div class="li-row">
        <div class="li-current">
          ${sel ? `<img src="${esc(sel.url)}" alt="" class="li-big" />
                   <div class="muted sm">${esc(liMeta(sel))}</div>
                   ${liWarn(sel)}`
                : '<div class="li-big li-empty">아직 고른 이미지가 없습니다</div>'}
        </div>
        <div class="li-cands">
          ${mine.length
            ? mine.map((a) => `<div class="li-cand ${a.is_selected ? 'on' : ''}" data-li-asset="${esc(a.id)}">
                <img src="${esc(a.url)}" alt="" />
                <div class="xs muted">${esc(String(a.created_at).slice(5, 10))}
                  ${a.width_px ? `· ${a.width_px}×${a.height_px}` : ''}</div>
                <div class="li-cand-btns">
                  ${a.is_selected ? '<span class="prog prog-ok">사용중</span>'
                    : '<button class="btn btn-sm li-pick">이걸로</button>'}
                  ${(a.is_selected || a.selected_at)
                    ? '' : '<button class="btn btn-sm btn-ghost li-del">삭제</button>'}
                </div>
              </div>`).join('')
            : '<span class="muted sm">후보가 없습니다. [올리기]로 여러 장을 올려두고 고르세요.</span>'}
        </div>
      </div>
      ${sel ? '<button class="btn btn-sm li-all" style="margin-top:8px">이 이미지를 모든 옵션에 적용</button>' : ''}
    </div>`;
  }).join('');
}

function liMeta(a) {
  const parts = [];
  if (a.width_px) parts.push(`${a.width_px}×${a.height_px}`);
  if (a.bytes) parts.push(`${Math.round(a.bytes / 1024).toLocaleString()}KB`);
  if (a.created_at) parts.push(String(a.created_at).slice(0, 10));
  return parts.join(' · ');
}

/* 안내 기준과 다르면 말해주되 **막지 않는다**. 우리가 검증한 값이 아니라서다. */
function liWarn(a) {
  const w = a.width_px, h = a.height_px;
  const msgs = [];
  if (w && h) {
    if (Math.min(w, h) < LIMG_GUIDE.min) msgs.push(`짧은 변이 ${Math.min(w, h)}px`);
    else if (Math.min(w, h) < LIMG_GUIDE.recommend) msgs.push(`권장 ${LIMG_GUIDE.recommend}px보다 작음`);
    if (w !== h) msgs.push('정사각형이 아님');
  }
  if (a.bytes && a.bytes > LIMG_GUIDE.maxBytes) msgs.push('10MB 초과');
  return msgs.length
    ? `<p class="sm neg">${esc(msgs.join(' · '))} <span class="muted">— 쿠팡 안내 기준이며 우리가 검증한 값은 아닙니다</span></p>`
    : '';
}

/* ---------- 올리기 ---------- */
/* 파일을 Storage 에 올리고 후보 행을 만든다. **가로·세로를 여기서 재둔다** —
   나중에 다시 재려면 이미지를 전부 내려받아야 한다. */
$('#liItems').addEventListener('change', async (ev) => {
  if (!ev.target.matches('.li-file')) return;
  const card = ev.target.closest('[data-li-item]');
  const itemId = card.dataset.liItem;
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;

  const msg = $('#liMsg');
  msg.classList.remove('hidden');
  msg.textContent = `${files.length}장 올리는 중…`;
  try {
    for (const f of files) {
      const dim = await liReadSize(f);
      const url = await uploadProductImage(f, 'listing/' + LIMG.p.id);
      await api('listing_assets', {
        method: 'POST',
        body: {
          project_id: LIMG.p.id, item_id: itemId, kind: 'rep',
          url, storage_path: url.split('/product-images/')[1] || null,
          mime: f.type || null, bytes: f.size || null,
          width_px: dim.w || null, height_px: dim.h || null,
          origin: 'upload', label: f.name.slice(0, 60),
          created_by: AUTH.userId || null
        }
      });
    }
    msg.textContent = `${files.length}장 올렸습니다 — 쓸 것을 고르세요.`;
    await liLoadCurrent();
  } catch (e) {
    msg.textContent = '올리지 못했습니다: ' + e.message;
  }
});

function liReadSize(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({}); URL.revokeObjectURL(url); };
      img.src = url;
    } catch (e) { resolve({}); }
  });
}

/* ---------- 고르기 · 삭제 ---------- */
$('#liItems').addEventListener('click', async (ev) => {
  const card = ev.target.closest('[data-li-item]');
  if (!card) return;
  const itemId = card.dataset.liItem;

  if (ev.target.closest('.li-pick')) {
    const assetId = ev.target.closest('[data-li-asset]').dataset.liAsset;
    await liSelect(itemId, assetId);
    return;
  }

  if (ev.target.closest('.li-del')) {
    const assetId = ev.target.closest('[data-li-asset]').dataset.liAsset;
    if (!confirm('이 후보를 지울까요? 한 번도 쓴 적 없는 후보만 지울 수 있습니다.')) return;
    await api(`listing_assets?id=eq.${assetId}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await liLoadCurrent();
    return;
  }

  if (ev.target.closest('.li-all')) {
    const sel = LIMG.assets.find((a) => a.item_id === itemId && a.is_selected);
    if (!sel) return;
    ev.target.disabled = true;
    try {
      /* 다른 옵션에는 **같은 URL로 후보를 새로 만들어** 붙인다. 한 행을 여러 옵션이
         가리키게 하면 한쪽에서 바꿀 때 다른 쪽 이력까지 흔들린다. */
      for (const it of LIMG.items) {
        if (it.id === itemId) continue;
        const [made] = await api('listing_assets', {
          method: 'POST', headers: { prefer: 'return=representation' },
          body: {
            project_id: LIMG.p.id, item_id: it.id, kind: 'rep',
            url: sel.url, storage_path: sel.storage_path, mime: sel.mime, bytes: sel.bytes,
            width_px: sel.width_px, height_px: sel.height_px,
            origin: sel.origin, label: sel.label,
            memo: '다른 옵션에서 복사', created_by: AUTH.userId || null
          }
        });
        await liSelect(it.id, made.id, true);
      }
      toast('모든 옵션에 적용했습니다');
      await liLoadCurrent();
    } catch (e) {
      toast('적용 실패: ' + e.message);
    } finally { ev.target.disabled = false; }
  }
});

/* 고르기 = 쓰던 것을 내리고 새것을 올린다. **내린 시각을 남긴다** — 그게 교체 이력이다. */
async function liSelect(itemId, assetId, quiet) {
  const prev = LIMG.assets.find((a) => a.item_id === itemId && a.is_selected);
  try {
    if (prev && prev.id !== assetId) {
      await api(`listing_assets?id=eq.${prev.id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { is_selected: false, unselected_at: new Date().toISOString() }
      });
    }
    await api(`listing_assets?id=eq.${assetId}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: { is_selected: true, selected_at: new Date().toISOString(), unselected_at: null }
    });
    if (!quiet) {
      toast('대표이미지를 정했습니다');
      await liLoadCurrent();
    }
  } catch (e) {
    if (!quiet) toast('저장 실패: ' + e.message);
    else throw e;
  }
}

$('#liPicker').addEventListener('change', async (ev) => {
  lstSetCurrent(ev.target.value);
  await liLoadCurrent();
});

$('#liNoteSave').onclick = async () => {
  if (!LIMG.p) return;
  const note = ($('#liNote').value || '').trim();
  if (!note) { toast('메모를 적으세요'); return; }
  const btn = $('#liNoteSave');
  btn.disabled = true;
  try {
    await lstAddNote(LIMG.p.id, 'rep_image', note);
    toast('메모를 남겼습니다');
    await liLoadCurrent();
  } catch (e) {
    toast('저장 실패: ' + e.message);
  } finally { btn.disabled = false; }
};
