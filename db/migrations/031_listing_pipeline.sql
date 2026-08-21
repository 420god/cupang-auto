-- ============================================================
-- 031. 상품 등록 파이프라인 — 소싱한 상품에 데이터를 단계별로 쌓아 등록까지
--
-- 무엇이 바뀌는가 (2026-08-21 사용자 결정):
--   전(前): 등록 모달 하나에서 "복제할 기존 상품"을 고르고 그 자리에서 이름·이미지·
--           가격·규격을 다 채운다. 즉 **정보의 출처가 복제 원본**이고, 판단 기록은
--           등록 직전에 한 덩어리로 받는다.
--   후(後): 소싱에서 "이건 등록한다"고 찍은 상품이 준비 건(listing_projects)이 되고,
--           대표이미지 · 상세페이지 · 상품명/검색어 · 카테고리 · 물류/바코드를
--           **각각의 화면에서 채워 여기에 쌓는다.** 등록 화면은 다 찼는지 보고
--           쏘기만 한다.
--   복제는 없어지지 않는다 — **뼈대**(배송·반품지·과세유형·필수속성·고시정보)로만 쓴다.
--   채우는 값은 전부 이 표에서 온다. 그래서 상품명을 고치려면 등록 화면이 아니라
--   상품명 화면에서 고친다.
--
-- 왜 payload 한 덩어리(jsonb)로 안 두는가:
--   030 product_drafts 는 "쿠팡에 보낼 몸통 그대로"를 담는다. 그건 **보내기 직전의
--   스냅샷**으로는 맞지만, 준비 과정에는 안 맞는다 — "③만 끝난 상품 목록"이나
--   "대표이미지가 아직 없는 것"을 물어볼 수가 없기 때문이다. 단계별 진행을 보여주는
--   화면이 이 표의 존재 이유다.
--   → 준비는 여기(컬럼), 보내기 직전 몸통은 product_drafts/큐 payload(jsonb).
--
-- AI 에이전트를 위해 의도적으로 한 것:
--   · 단계마다 "왜 이렇게 정했나"를 listing_step_notes 에 **행으로** 남긴다.
--     product_change_history(026)와 모양이 같아서, 등록 전 판단과 등록 후 수정이
--     한 줄로 이어진다. "이 기준으로 소싱 → 이렇게 만들어 등록 → 이렇게 고침 → 결과"
--   · 이미지는 고른 것만 남기지 않고 **후보를 전부** 남긴다(R-04). 버린 후보가
--     있어야 "무엇 대신 무엇을 골랐나"를 나중에 볼 수 있다.
--   · 진행 상태를 화면 코드가 아니라 뷰(v_listing_progress)가 판정한다. 사람과
--     에이전트가 같은 기준을 본다.
-- ============================================================

-- ── 뼈대 템플릿 ──────────────────────────────────────────────
-- 배송·반품/교환·과세유형·고시정보처럼 상품이 달라도 거의 같은 것들.
-- 사용자 결정: "설정해둔 데이터를 쓰고, 필요하면 내가 템플릿을 추가해서 고른다."
--
-- payload 를 통으로 두는 이유는 029 의 coupang_category_meta 와 같다 — 카테고리마다
-- 필수 항목이 다르고 아직 전부 모른다. 쪼개면 모르는 필드가 조용히 버려지는데,
-- 등록은 그 필드가 빠지면 실패한다.
create table if not exists listing_templates (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  is_default               boolean not null default false,

  -- 어디서 떠온 뼈대인가. 기존 상품 하나를 조회해서 만든 것이면 그 상품ID.
  source_seller_product_id text,

  -- 배송·반품지·과세유형·필수속성·고시정보 등. 쿠팡 몸통의 부분집합 그대로.
  payload                  jsonb not null default '{}'::jsonb,

  memo                     text,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists listing_templates_default on listing_templates (is_default);

-- ── 준비 건 (쿠팡 등록상품 1건) ★ ────────────────────────────
create table if not exists listing_projects (
  id                    uuid primary key default gen_random_uuid(),

  -- preparing 준비중 / ready 다 참(등록 가능) / submitted 등록 요청함
  -- / registered 쿠팡에 만들어짐 / discarded 버림
  -- ready 는 뷰가 판정하는 것과 별개로 **사람이 확정(잠금)** 했을 때의 상태다.
  status                text not null default 'preparing'
                        check (status in ('preparing', 'ready', 'submitted', 'registered', 'discarded')),

  -- ── 출처 (소싱) ──
  -- **강한 FK를 안 건다**: products/product_items 는 수집 주기마다 갈아엎히는 성격이라
  -- 참조 무결성을 걸면 재수집이 막힌다(017 sourcing_candidates 와 같은 이유).
  source_kind           text not null default 'favorite'
                        check (source_kind in ('favorite', 'manual', 'candidate')),
  sourcing_candidate_id uuid references sourcing_candidates(id),
  ref_product_id        bigint,
  ref_item_id           bigint,
  source_url            text,        -- 1688 오퍼 또는 참고 링크
  -- 소싱 시점의 시장 모습. **나중에 절대 복원 못 한다** — 만드는 순간 찍어둔다.
  source_snapshot       jsonb,

  -- ── ① 뼈대 ──
  template_id           uuid references listing_templates(id),
  clone_seller_product_id text,      -- 복제 원본(뼈대로만 쓴다)

  -- ── ② 카테고리 ──
  display_category_code text,
  category_path         text,
  category_source       text,        -- recommend(쿠팡 추천) | search | manual | clone
  category_confirmed_at timestamptz,

  -- ── ③ 상품명 · 검색어 ──
  product_name          text,        -- sellerProductName
  display_product_name  text,        -- 비우면 product_name 을 쓴다
  brand                 text,
  search_tags           text[],

  -- ── ⑤ 상세페이지 ──
  -- assets: listing_assets 의 detail 을 쓴다 / clone: 복제 원본 상세를 그대로 쓴다
  detail_source         text not null default 'assets'
                        check (detail_source in ('assets', 'clone')),

  -- ── 한글표시사항(= 고시정보와 상당 부분 겹친다) ──
  -- my_skus.label_* 와 같은 이름을 쓴다. 등록 후 SKU 로 그대로 복사하기 위해서다.
  -- 옵션별로 다른 경우는 아직 없어서 상품 단위로 둔다(사용자 확인: "대부분 공통").
  label_importer        text,
  label_manufacturer    text,
  label_origin_country  text,
  label_volume          text,
  label_material        text,
  label_product_type    text,
  label_caution         text,
  label_usage_standard  text,

  -- ── 판단 (등록 성공 시 sourcing_decisions 로 박제) ──
  expected_monthly_qty   numeric,
  expected_unit_cost_krw numeric,
  expected_sell_price    bigint,
  expected_margin_rate   numeric,
  reason_memo            text,

  -- ── 등록 ──
  requested             boolean not null default false,  -- 등록과 동시에 승인요청까지
  sourcing_decision_id  uuid references sourcing_decisions(id),
  submitted_queue_id    uuid references coupang_write_queue(id),
  submitted_at          timestamptz,
  created_seller_product_id text,     -- 쿠팡이 준 새 상품ID = 등록의 결과물
  registered_at         timestamptz,
  my_product_id         uuid references my_products(id),

  memo                  text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists listing_projects_status on listing_projects (status, updated_at desc);
create index if not exists listing_projects_ref on listing_projects (ref_item_id);
create index if not exists listing_projects_created_spid on listing_projects (created_seller_product_id);

-- ── 옵션 ─────────────────────────────────────────────────────
-- 사용자 확인(2026-08-21): 옵션이 4개여도 대부분 공통이고, **옵션별로 다른 건
-- 대표이미지와 입고(물류) 정보 정도**다. 그래서 상품 단위 값은 위에 두고
-- 여기엔 옵션마다 실제로 갈리는 것만 둔다.
create table if not exists listing_project_items (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references listing_projects(id) on delete cascade,
  position              int  not null default 0,
  item_name             text,

  -- ── ⑦ 가격 ──
  -- 채널이 상품마다 다르다(로켓그로스 전용이면 marketplace 는 null 로 둔다).
  sale_price            bigint,
  marketplace_sale_price bigint,

  -- ── ⑥ 바코드 ──
  -- coupang: WING 의 "상품 바코드가 없어요" = 쿠팡이 발급한다 (기본값)
  -- own:     우리가 가진 바코드를 그대로 쓴다
  -- 기본이 coupang 인 이유: 이 시스템의 조인키가 **쿠팡 발급 바코드**다(D-02).
  -- 자체 바코드를 넣으면 번호가 두 벌이 되어 청구서·입고 매칭이 갈라진다.
  barcode_mode          text not null default 'coupang'
                        check (barcode_mode in ('coupang', 'own')),
  own_barcode           text,

  -- ── ⑥ 물류 입고 정보 (rocketGrowthItemData.skuInfo) ──
  -- **skuInfo 는 주려면 전 항목이 필수다**(부분만 보내면 오류). 그래서 기본값을
  -- 전부 채워둔다 — 빈칸으로 두면 등록이 깨지는 자리다.
  -- 단위: width/length/height = mm, weight/net_weight = g, distribution_period = 일
  inbound_name          text,        -- 옵션 단위 입고 표기명. 상품 단위(rfmInboundName)와 별개다
  sku_width             int,
  sku_length            int,
  sku_height            int,
  sku_weight            int,
  sku_net_weight        int,
  distribution_period   int  not null default 0,
  expired_at_managed    boolean not null default false,   -- 제조일/소비기한 관리 상품인가
  fragile               boolean not null default false,   -- 깨지거나 샐 수 있는가
  hazardous             boolean,
  heat_sensitive        boolean,
  heavy_bulky           boolean,
  season                text not null default 'YEAR_ROUND',
  stand_alone           boolean not null default false,
  -- 우리가 아직 모르는 skuInfo 항목이 있으면 여기 담는다(R-04). 복제 원본에서
  -- 읽은 값을 통째로 넣어두면 등록 시 빠뜨리지 않는다.
  sku_info_extra        jsonb,

  -- ── 공급처 (1688) ──
  -- **sku_suppliers(015)와 같은 이름**을 쓴다. 등록 후 SKU 가 생기면 1:1로 복사한다.
  -- 사용자 결정: 소싱 단계의 데이터가 여기로 계속 흘러 들어와 쌓인다.
  supplier_seller_id    text,
  supplier_offer_url    text,
  supplier_option1_cn   text,
  supplier_option2_cn   text,
  supplier_moq          int,
  -- **추정치다.** 소싱 시점에 본 1688 호가일 뿐, 실제 단가는 발주 후 구매대행
  -- 청구서로 확정된다(사용자 확인 2026-08-21). 확정 원가는 inventory_lots 쪽에 있고
  -- **이 값을 덮어쓰지 않는다** — 덮으면 "내 추정이 얼마나 틀렸나"를 영영 못 본다(R-05).
  supplier_price_cny    numeric,
  est_unit_cost_krw     numeric,    -- 추정 개당 원가(원). 관세·배송·작업비까지 얹은 감

  -- 소싱에서 넘어온 값인가, 여기서 사람이 고친 값인가.
  -- 소싱 화면이 완성되면 대부분 sourcing 이 되고, 그때 "소싱 판단이 등록까지
  -- 얼마나 살아남았나"를 볼 수 있다.
  price_source          text not null default 'manual'
                        check (price_source in ('sourcing', 'manual')),

  -- ── 등록 결과 ──
  created_vendor_item_id text,
  barcode                text,       -- 등록 후 동기화가 채운다(쿠팡 발급)
  sku_id                 uuid references my_skus(id),

  memo                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists listing_project_items_pos
  on listing_project_items (project_id, position);
create index if not exists listing_project_items_project
  on listing_project_items (project_id);

-- ── 이미지 후보 (대표 · 상세 · 경쟁사) ────────────────────────
-- **고른 것만 남기지 않는다.** 버린 후보가 있어야 "무엇 대신 무엇을 골랐나"를
-- 나중에 볼 수 있고, 등록 후 썸네일 교체 실험과도 이어진다.
-- 파일 자체는 Storage(product-images/listing/{project_id}/...)에 있고 여기엔 URL 만 둔다.
create table if not exists listing_assets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references listing_projects(id) on delete cascade,
  -- 대표이미지는 옵션별이라 item_id 가 있고, 상세페이지는 상품 단위라 null 이다.
  item_id       uuid references listing_project_items(id) on delete cascade,

  kind          text not null
                check (kind in ('rep', 'detail', 'competitor', 'reference')),
  url           text not null,
  storage_path  text,
  position      int  not null default 0,     -- 상세페이지 순서

  is_selected   boolean not null default false,
  selected_at   timestamptz,
  unselected_at timestamptz,                 -- 내려온 시각 = 교체 이력

  origin        text not null default 'upload'
                check (origin in ('upload', 'ai', 'competitor', 'clone')),
  mime          text,
  bytes         int,
  width_px      int,
  height_px     int,
  label         text,        -- "A안", "누끼 버전" 등 사람이 붙이는 이름
  memo          text,

  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists listing_assets_project on listing_assets (project_id, kind, position);
create index if not exists listing_assets_item on listing_assets (item_id) where item_id is not null;

-- ── 단계별 "왜" ★ ────────────────────────────────────────────
-- 등록 직전에 한 번 몰아서 받으면 "썸네일을 왜 그렇게 했나"와 "가격을 왜 그렇게
-- 정했나"가 한 칸에 섞인다. 섞인 근거는 나중에 어느 쪽도 판정할 수 없다
-- (product_change_history 에서 이미 겪은 문제 — 가설은 항목별로 따로 받는다).
--
-- append-only 로 쓴다. 고칠 때마다 행이 하나 더 쌓이고, 최신 행이 지금 생각이다.
create table if not exists listing_step_notes (
  id              bigint generated by default as identity primary key,
  project_id      uuid not null references listing_projects(id) on delete cascade,
  item_id         uuid references listing_project_items(id) on delete cascade,

  step            text not null
                  check (step in ('source', 'skeleton', 'category', 'name',
                                  'rep_image', 'detail', 'logistics', 'price', 'submit')),
  note            text,          -- 왜 이렇게 정했나 (AI 가 읽을 원문)
  hypothesis      text,          -- 무엇을 기대하나 (등록 후 검증 대상)
  -- 무엇을 봐야 판정되는가. 026 product_change_history.primary_metrics 와 같은 개념 —
  -- 매번 AI 가 추측하지 않도록 행마다 박아둔다.
  primary_metrics text[],
  extra           jsonb,

  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index if not exists listing_step_notes_project
  on listing_step_notes (project_id, step, created_at desc);

-- ── 진행 상태를 뷰가 판정한다 ────────────────────────────────
-- 화면 코드에 판정을 두면 에이전트가 같은 판정을 다시 구현해야 하고, 둘이 어긋난다.
-- 여기 한 곳에만 둔다.
-- security_invoker: 001 이후의 관례. 뷰가 정의자 권한으로 돌면 RLS를 우회한다.
create or replace view v_listing_progress with (security_invoker = true) as
select
  p.id,
  p.status,
  p.product_name,
  p.updated_at,
  i.item_count,

  -- ① 뼈대
  (p.template_id is not null or p.clone_seller_product_id is not null) as step_skeleton,
  -- ② 카테고리
  (p.display_category_code is not null)                                as step_category,
  -- ③ 상품명·검색어
  (coalesce(nullif(trim(p.product_name), ''), null) is not null
     and coalesce(array_length(p.search_tags, 1), 0) > 0)              as step_name,
  -- ④ 대표이미지 — 옵션이 하나라도 있고, 모든 옵션이 고른 대표이미지를 가졌을 때
  (i.item_count > 0 and i.item_count = i.items_with_rep)               as step_rep_image,
  -- ⑤ 상세페이지 — 복제 원본을 쓰기로 했으면 그것으로 충족
  (p.detail_source = 'clone' or i.detail_selected > 0)                 as step_detail,
  -- ⑥ 물류·바코드
  (i.item_count > 0 and i.item_count = i.items_logistics_ok)           as step_logistics,
  -- ⑦ 가격
  (i.item_count > 0 and i.item_count = i.items_priced)                 as step_price,

  i.items_with_rep,
  i.items_logistics_ok,
  i.items_priced,
  i.detail_selected
from listing_projects p
left join lateral (
  select
    count(*)                                                   as item_count,
    count(*) filter (where exists (
      select 1 from listing_assets a
      where a.item_id = it.id and a.kind = 'rep' and a.is_selected))   as items_with_rep,
    count(*) filter (where
      coalesce(it.sku_width, 0)  > 0 and coalesce(it.sku_length, 0) > 0 and
      coalesce(it.sku_height, 0) > 0 and coalesce(it.sku_weight, 0) > 0 and
      coalesce(nullif(trim(it.inbound_name), ''), null) is not null and
      (it.barcode_mode = 'coupang'
        or coalesce(nullif(trim(it.own_barcode), ''), null) is not null))  as items_logistics_ok,
    count(*) filter (where coalesce(it.sale_price, 0) > 0)              as items_priced,
    (select count(*) from listing_assets a2
      where a2.project_id = p.id and a2.kind = 'detail' and a2.is_selected) as detail_selected
  from listing_project_items it
  where it.project_id = p.id
) i on true;

-- 다 찼는지 한 번에 묻기 위한 얇은 뷰. 화면과 에이전트가 같은 문장을 쓴다.
create or replace view v_listing_ready with (security_invoker = true) as
select *,
  (step_skeleton and step_category and step_name and step_rep_image
     and step_detail and step_logistics and step_price) as all_done
from v_listing_progress;

-- ── RLS (기존 표들과 같은 형태) ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['listing_templates', 'listing_projects', 'listing_project_items',
                           'listing_assets', 'listing_step_notes']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "read_for_authenticated" on %I', t);
    execute format('create policy "read_for_authenticated" on %I for select to authenticated using (true)', t);
    execute format('drop policy if exists "write_for_admin" on %I', t);
    execute format('create policy "write_for_admin" on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- updated_at 자동 갱신 — 목록이 "최근 손댄 순"으로 정렬되려면 필요하다.
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['listing_templates', 'listing_projects', 'listing_project_items']
  loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()',
                   t || '_touch', t);
  end loop;
end $$;

-- ── 뒤늦게 추가한 컬럼 ───────────────────────────────────────
-- create table if not exists 는 **이미 있는 표에 컬럼을 더해주지 않는다.**
-- 이 파일의 이전 판을 먼저 돌린 경우를 위해 따로 얹는다(R-02 — 항상 멱등하게).
alter table listing_project_items
  add column if not exists est_unit_cost_krw numeric;
alter table listing_project_items
  add column if not exists price_source text not null default 'manual';
do $$
begin
  alter table listing_project_items drop constraint if exists listing_project_items_price_source_check;
  alter table listing_project_items add constraint listing_project_items_price_source_check
    check (price_source in ('sourcing', 'manual'));
end $$;
