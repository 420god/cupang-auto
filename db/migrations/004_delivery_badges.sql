-- ============================================================
-- 배송유형 대표값 + 조회 성능 (v4)
--   - products.delivery_badges : 그 상품의 옵션들에 실제로 존재하는 배송유형 목록
--   - product_items 변경 시 자동 갱신 (statement 트리거)
--   - 소싱 목록 기본 정렬/필터용 인덱스
--
-- 001~003 실행 후 이어서 실행하세요. 여러 번 실행해도 안전합니다.
--
-- 왜 컬럼으로 미리 저장하나:
--   소싱 목록은 products만 읽어서 한 번에 그린다. 배송유형을 보여주려고
--   product_items를 매번 조인/추가조회하면 페이지마다 왕복이 하나 더 생기고
--   옵션 수만큼 행이 딸려온다. 배송유형은 수집할 때만 바뀌므로 미리 접어둔다.
-- ============================================================


-- ------------------------------------------------------------
-- 1. 배지 정규화
--    수집 원본(delivery_badge)은 표기가 제각각이라 그대로 쓰면 필터가 안 맞는다.
--    쿠팡이 실제로 쓰는 5종으로 접고, 못 알아본 라벨은 원문 그대로 둔다
--    (화면에는 "실제 옵션에 있는 값"이 보여야 하므로 임의로 판매자배송에
--     몰아넣지 않는다). '판정불가'는 정보가 없는 것이므로 제외한다.
-- ------------------------------------------------------------
create or replace function norm_delivery_badge(b text)
returns text language sql immutable as $$
  select case
    when b is null or btrim(b) = '' or btrim(b) = '판정불가' then null
    when b like '%프레시%'                        then '로켓프레시'
    when b like '%직구%' or b like '%글로벌%'      then '로켓직구'
    when b like '%판매자로켓%' or b like '%그로스%' then '판매자로켓'
    when b like '%로켓%'                          then '로켓배송'
    when b like '%판매자배송%'                     then '판매자배송'
    else btrim(b)
  end
$$;

-- 표시 순서 고정용 (로켓 → 판매자 순)
create or replace function delivery_badge_rank(b text)
returns int language sql immutable as $$
  select case b
    when '로켓배송'   then 1
    when '로켓프레시' then 2
    when '로켓직구'   then 3
    when '판매자로켓' then 4
    when '판매자배송' then 5
    else 6
  end
$$;


-- ------------------------------------------------------------
-- 2. 컬럼
-- ------------------------------------------------------------
alter table products
  add column if not exists delivery_badges text[] not null default '{}';

comment on column products.delivery_badges is
  '활성 옵션들에 존재하는 배송유형 목록(정규화·중복제거). product_items 트리거가 채운다.';


-- ------------------------------------------------------------
-- 3. 재계산 함수
--    security definer: extension이 product_items를 upsert할 때 트리거가
--    products를 갱신해야 하는데, RLS 쓰기 정책이 관리자 전용이라
--    호출자 권한으로는 막힐 수 있다.
-- ------------------------------------------------------------
create or replace function recompute_product_delivery(pids text[])
returns void language sql security definer set search_path = public as $$
  update products p
  set delivery_badges = coalesce(s.badges, '{}')
  from (
    select
      d.product_id,
      array_agg(d.b order by delivery_badge_rank(d.b), d.b) as badges
    from (
      select distinct i.product_id, norm_delivery_badge(i.delivery_badge) as b
      from product_items i
      where i.product_id = any(pids)
        and i.is_active
    ) d
    where d.b is not null
    group by d.product_id
  ) s
  where p.product_id = s.product_id
    and p.delivery_badges is distinct from coalesce(s.badges, '{}');

  -- 배지가 하나도 없게 된 상품은 빈 배열로 되돌린다
  update products p
  set delivery_badges = '{}'
  where p.product_id = any(pids)
    and coalesce(array_length(p.delivery_badges, 1), 0) > 0
    and not exists (
      select 1 from product_items i
      where i.product_id = p.product_id
        and i.is_active
        and norm_delivery_badge(i.delivery_badge) is not null
    );
$$;


-- ------------------------------------------------------------
-- 4. 트리거 (행 단위가 아니라 statement 단위 — 수집이 수천 행을 한꺼번에
--    upsert하므로 행마다 돌면 업로드가 느려진다)
-- ------------------------------------------------------------
create or replace function refresh_delivery_badges_ins()
returns trigger language plpgsql security definer set search_path = public as $$
declare pids text[];
begin
  select array_agg(distinct product_id) into pids from new_rows;
  if pids is not null then perform recompute_product_delivery(pids); end if;
  return null;
end $$;

create or replace function refresh_delivery_badges_upd()
returns trigger language plpgsql security definer set search_path = public as $$
declare pids text[];
begin
  select array_agg(distinct product_id) into pids from (
    select product_id from new_rows
    union
    select product_id from old_rows
  ) t;
  if pids is not null then perform recompute_product_delivery(pids); end if;
  return null;
end $$;

create or replace function refresh_delivery_badges_del()
returns trigger language plpgsql security definer set search_path = public as $$
declare pids text[];
begin
  select array_agg(distinct product_id) into pids from old_rows;
  if pids is not null then perform recompute_product_delivery(pids); end if;
  return null;
end $$;

drop trigger if exists trg_delivery_badges_ins on product_items;
create trigger trg_delivery_badges_ins
  after insert on product_items
  referencing new table as new_rows
  for each statement execute function refresh_delivery_badges_ins();

drop trigger if exists trg_delivery_badges_upd on product_items;
create trigger trg_delivery_badges_upd
  after update on product_items
  referencing new table as new_rows old table as old_rows
  for each statement execute function refresh_delivery_badges_upd();

drop trigger if exists trg_delivery_badges_del on product_items;
create trigger trg_delivery_badges_del
  after delete on product_items
  referencing old table as old_rows
  for each statement execute function refresh_delivery_badges_del();


-- ------------------------------------------------------------
-- 5. 기존 데이터 백필
-- ------------------------------------------------------------
update products p
set delivery_badges = coalesce(s.badges, '{}')
from (
  select
    d.product_id,
    array_agg(d.b order by delivery_badge_rank(d.b), d.b) as badges
  from (
    select distinct i.product_id, norm_delivery_badge(i.delivery_badge) as b
    from product_items i
    where i.is_active
  ) d
  where d.b is not null
  group by d.product_id
) s
where p.product_id = s.product_id
  and p.delivery_badges is distinct from coalesce(s.badges, '{}');


-- ------------------------------------------------------------
-- 6. 인덱스
--    (a) 배송유형 필터: 배열 포함(cs) 검색용 GIN
--    (b) 소싱 목록 기본 정렬(is_active + max_sales desc)과
--        카테고리 필터 조합 — 기존 idx_products_maxsales는 is_active 조건을
--        못 써서 필터 후 정렬에 추가 비용이 든다
--    (c) 상품명 검색(ilike *keyword*)은 인덱스가 전혀 없어 전체 스캔이었다
-- ------------------------------------------------------------
create index if not exists idx_products_delivery_badges
  on products using gin (delivery_badges);

create index if not exists idx_products_active_maxsales
  on products (max_sales desc nulls last) where is_active;

create index if not exists idx_products_cat_maxsales
  on products (category_code, max_sales desc nulls last) where is_active;

-- pg_trgm은 설치 스키마가 환경마다 달라서(public / extensions) 둘 다 시도한다.
-- 실패해도 검색이 느려질 뿐이라 마이그레이션 전체를 중단시키지 않는다.
do $$
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then null;
  end;

  begin
    execute 'create index if not exists idx_products_name_trgm
               on products using gin (product_name gin_trgm_ops)';
  exception when others then
    begin
      execute 'create index if not exists idx_products_name_trgm
                 on products using gin (product_name extensions.gin_trgm_ops)';
    exception when others then
      raise notice 'pg_trgm 인덱스를 만들지 못했습니다 — 상품명 검색은 기존대로 동작합니다';
    end;
  end;
end $$;


-- ------------------------------------------------------------
-- 7. 뷰에도 노출
-- ------------------------------------------------------------
create or replace view v_product_list
with (security_invoker = true) as
select
  p.product_id,
  p.product_name,
  p.brand_name,
  p.category_path,
  p.rep_image_path,
  p.max_sales,
  p.sum_sales,
  p.min_price,
  p.max_price,
  p.option_count,
  p.has_rocket,
  p.pv_rank,
  p.rating,
  p.rating_count,
  p.last_seen_at,
  exists (
    select 1 from user_items u
    where u.product_id = p.product_id
      and u.user_id = auth.uid()
      and u.is_favorite
  ) as has_favorite,
  (
    select max(c.cur_margin_rate) from item_calc c
    where c.product_id = p.product_id
      and c.user_id = auth.uid()
  ) as best_margin_rate,
  -- create or replace view는 기존 컬럼 순서를 바꿀 수 없다. 새 컬럼은 항상 맨 뒤에.
  p.delivery_badges
from products p
where p.is_active;


-- ------------------------------------------------------------
-- 확인용
--   select delivery_badges, count(*) from products
--   where is_active group by 1 order by 2 desc limit 20;
-- ------------------------------------------------------------
