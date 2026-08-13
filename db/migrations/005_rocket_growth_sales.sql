-- ============================================================
-- 005. 로켓그로스 판매현황 (쿠팡 공식 Open API 기반, 일별 스냅샷)
--
-- web/api/sales-today.js(+PROXY_URL) 대신 GCP VPS의 고정 IP에서
-- 직접 쿠팡 로켓그로스 주문 API를 호출해 이 테이블에 upsert한다.
-- 웹은 더는 쿠팡 API를 실시간 호출하지 않고 이 테이블만 읽는다.
-- ============================================================

create table if not exists rocket_growth_sales_daily (
  sale_date       date not null,
  vendor_item_id  text not null,
  product_name    text,
  quantity        int not null default 0,
  revenue         bigint not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (sale_date, vendor_item_id)
);

create index if not exists idx_rg_sales_date on rocket_growth_sales_daily (sale_date);

alter table rocket_growth_sales_daily enable row level security;

drop policy if exists "read_for_authenticated" on rocket_growth_sales_daily;
create policy "read_for_authenticated" on rocket_growth_sales_daily
  for select to authenticated using (true);

-- 쓰기는 관리자 계정(VPS 동기화 스크립트가 로그인해서 씀)만 가능 — is_admin()은 001_init.sql에서 정의됨
drop policy if exists "write_for_admin" on rocket_growth_sales_daily;
create policy "write_for_admin" on rocket_growth_sales_daily
  for all to authenticated
  using (is_admin()) with check (is_admin());
