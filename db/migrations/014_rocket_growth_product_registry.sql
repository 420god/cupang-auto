-- ============================================================
-- 014. 로켓그로스 상품 등록정보 레지스트리 — 등록상품ID·상품ID·옵션ID 매핑
--
-- 판매현황(rocket_growth_sales_*)이 주는 vendor_item_id만으로는 "등록상품ID"
-- (WING 화면 표기, sellerProductId)와 "상품ID"(쿠팡 소비자 페이지 URL에 쓰는
-- productId)를 알 수 없다. 이 값들은 소싱 탭의 product_items와는 무관하다 —
-- product_items는 "이 계정이 실제로 등록해서 파는 상품"이 아니라 카테고리
-- 소싱(마진 조사용으로 다른 판매자 상품을 수집)의 결과물이라 서로 다른
-- vendor_item_id 공간이다(2026-08-16 사용자 지적으로 발견 — web/CLAUDE.md 참조).
--
-- 공식 Open API "상품 목록 페이징 조회"(GET .../marketplace/seller-products,
-- businessTypes=rocketGrowth)로 채운다 — docs/api-notes.md 4-7 참조.
-- SKU ID(WING 화면의 8자리 값)는 이 API에 없어서 이번엔 제외했다(2026-08-16
-- 사용자 결정 — 나중에 재고 페이지 만들 때 다시 조사하기로 함).
--
-- 스냅샷(012)과 달리 이력을 안 쌓고 최신값으로 덮어쓴다 — 등록상품ID/상품ID는
-- 한 번 발급되면 안 바뀌는 값이라(가격과 달리) "그 시점 값"을 구분할 필요가 없다.
-- ============================================================

create table if not exists rocket_growth_product_registry (
  vendor_item_id          text primary key,  -- 옵션ID (rocketGrowthItem.vendorItemId)
  seller_product_id       text,              -- 등록상품ID (WING 화면 표기와 동일)
  seller_product_item_id  text,              -- 벤더아이템 옵션 ID
  product_id              text,              -- 상품ID — 쿠팡 소비자 페이지(/vp/products/{productId}) URL에 씀
  vendor_inventory_item_id text,             -- 재고 아이템ID (재고 페이지용으로 미리 확보)
  seller_product_name     text,
  updated_at              timestamptz not null default now()
);

alter table rocket_growth_product_registry enable row level security;

drop policy if exists "read_for_authenticated" on rocket_growth_product_registry;
create policy "read_for_authenticated" on rocket_growth_product_registry
  for select to authenticated using (true);

drop policy if exists "write_for_admin" on rocket_growth_product_registry;
create policy "write_for_admin" on rocket_growth_product_registry
  for all to authenticated
  using (is_admin()) with check (is_admin());
