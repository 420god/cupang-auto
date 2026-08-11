-- ============================================================
-- 스키마 보완 (v3)
--   - 카테고리 삭제 시 연쇄 삭제
--   - 관리자만 카테고리 삭제 가능
--
-- schema.sql, schema_v2_web.sql 실행 후 이어서 실행하세요.
-- ============================================================

-- ------------------------------------------------------------
-- 1. 카테고리 삭제 시 상품도 함께 삭제되도록 변경
--    (기존 제약을 지우고 cascade로 다시 겁니다)
-- ------------------------------------------------------------
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'products'::regclass
    and contype = 'f'
    and confrelid = 'categories'::regclass
  limit 1;

  if cname is not null then
    execute format('alter table products drop constraint %I', cname);
  end if;
end $$;

alter table products
  add constraint products_category_code_fkey
  foreign key (category_code)
  references categories(category_code)
  on delete cascade;

-- product_items -> products 는 이미 cascade이므로
-- 카테고리 삭제 시 상품 -> 옵션까지 연쇄 삭제됩니다.
-- user_items, item_calc 도 product_items 참조이므로 함께 정리됩니다.


-- ------------------------------------------------------------
-- 2. 이력은 외래키가 없으므로 별도로 정리합니다
--    (카테고리 삭제 시 고아 이력이 남지 않도록)
-- ------------------------------------------------------------
create or replace function cleanup_orphan_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from item_history h
  where not exists (
    select 1 from product_items i where i.item_id = h.item_id
  );
  return null;
end $$;

drop trigger if exists trg_cleanup_history on products;
create trigger trg_cleanup_history
  after delete on products
  for each statement execute function cleanup_orphan_history();


-- ------------------------------------------------------------
-- 3. 카테고리 통계 갱신 함수 (수집 후 호출용)
-- ------------------------------------------------------------
create or replace function refresh_all_category_stats()
returns void language plpgsql security definer set search_path = public as $$
begin
  update categories c
  set product_count = coalesce(s.pc, 0),
      item_count    = coalesce(s.ic, 0)
  from (
    select
      p.category_code,
      count(distinct p.product_id) as pc,
      count(i.item_id)             as ic
    from products p
    left join product_items i on i.product_id = p.product_id
    group by p.category_code
  ) s
  where c.category_code = s.category_code;

  -- 상품이 하나도 없는 카테고리는 0으로
  update categories c
  set product_count = 0, item_count = 0
  where not exists (
    select 1 from products p where p.category_code = c.category_code
  );
end $$;


-- ------------------------------------------------------------
-- 4. 삭제 권한: 관리자만 카테고리를 지울 수 있습니다
--    (이미 write_for_admin 정책에 포함되어 있으나 명시적으로 확인)
-- ------------------------------------------------------------
-- 확인용 쿼리:
--   select tablename, policyname, cmd
--   from pg_policies
--   where tablename = 'categories';
