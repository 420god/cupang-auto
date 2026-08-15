-- ============================================================
-- 009. 로켓그로스 판매현황 — WING 내부 API 기반 순매출(반품 반영) 스냅샷
--
-- 005의 rocket_growth_sales_daily는 쿠팡 공식 Open API(rg/orders) 기반이라
-- 반품이 전혀 반영되지 않는다(결제된 주문만 나옴, docs/api-notes.md 4-4-1).
-- 이 테이블은 WING 내부 API(/tenants/rfm-inventory/sales/sold-vendor-item-list,
-- 로그인 세션 기반, 문서 4-4-2)로 하루 단위로 조회한 순매출(gmv/unitsSold)을
-- 담는다 — 반품이 음수로 이미 상쇄되어 있다.
--
-- 세션 기반이라 GCP VPS 무인 cron은 못 쓰고, 확장프로그램의 백그라운드
-- 스크립트(extension/background.js)가 WING 탭에서 캡처해 upsert한다.
-- 웹은 이 테이블 값이 있으면 우선 쓰고, 없으면 rocket_growth_sales_daily로
-- 폴백한다(web/app.js의 loadSales() 참조).
-- ============================================================

create table if not exists rocket_growth_sales_wing_daily (
  sale_date       date not null,
  vendor_item_id  text not null,
  product_id      text,
  product_name    text,
  quantity        int not null default 0,   -- 순수량(반품 시 음수 가능)
  revenue         bigint not null default 0, -- 순매출(반품 시 음수 가능)
  updated_at      timestamptz not null default now(),
  primary key (sale_date, vendor_item_id)
);

create index if not exists idx_rg_sales_wing_date on rocket_growth_sales_wing_daily (sale_date);

alter table rocket_growth_sales_wing_daily enable row level security;

drop policy if exists "read_for_authenticated" on rocket_growth_sales_wing_daily;
create policy "read_for_authenticated" on rocket_growth_sales_wing_daily
  for select to authenticated using (true);

-- 쓰기는 관리자 계정(확장프로그램이 로그인해서 씀, 005와 동일 패턴)만 가능
drop policy if exists "write_for_admin" on rocket_growth_sales_wing_daily;
create policy "write_for_admin" on rocket_growth_sales_wing_daily
  for all to authenticated
  using (is_admin()) with check (is_admin());
