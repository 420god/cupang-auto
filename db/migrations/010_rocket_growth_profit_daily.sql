-- ============================================================
-- 010. 로켓그로스 판매현황 — 확정 정산(손익) 일별 스냅샷
--
-- WING 내부 API(/tenants/rfm/v2/settlements/profit-status/search, 로그인 세션 기반,
-- docs/api-notes.md 4-4-4)로 하루 단위 조회한 "확정" 수수료·입출고비·쿠폰·광고비·
-- 밀크런·순이익을 담는다. 009와 달리 이건 옵션(vendorItemId)별이 아니라
-- 계정 전체 합계만 나온다 — 그래서 판매현황의 옵션별 표에는 못 합치고,
-- 별도의 "확정 정산 요약" 카드로만 쓴다(web/app.js 참조).
--
-- "D-1부터 조회 가능"(정산 인식 지연 추정, 미확정) — 오늘 날짜는 0이거나
-- 데이터가 없을 수 있다. 세션 기반이라 확장프로그램(extension/background.js)만
-- 채울 수 있고, VPS 무인 cron은 못 쓴다(009와 같은 이유).
-- ============================================================

create table if not exists rocket_growth_profit_daily (
  sale_date                    date not null primary key,
  total_sales_amount           bigint not null default 0,  -- 총매출(환불 전)
  total_refunded_sales_amount  bigint not null default 0,  -- 환불액
  net_sales_amount             bigint not null default 0,  -- 순매출(환불 반영)
  total_deduction_amount       bigint not null default 0,  -- 총 차감액
  commission_amount            bigint not null default 0,  -- 확정 판매수수료(VAT포함)
  fulfillment_amount           bigint not null default 0,  -- 확정 입출고비(창고+풀필먼트+보관 등, VAT포함)
  coupon_amount                bigint not null default 0,  -- 판매자 쿠폰 비용
  ad_amount                    bigint not null default 0,  -- 광고비 차감
  milkrun_amount                bigint not null default 0,  -- 밀크런 이용액
  profit_amount                bigint not null default 0,  -- 확정 순이익
  profit_to_sales_ratio        numeric(6,2),                -- 확정 이익률(%)
  updated_at                   timestamptz not null default now()
);

alter table rocket_growth_profit_daily enable row level security;

drop policy if exists "read_for_authenticated" on rocket_growth_profit_daily;
create policy "read_for_authenticated" on rocket_growth_profit_daily
  for select to authenticated using (true);

drop policy if exists "write_for_admin" on rocket_growth_profit_daily;
create policy "write_for_admin" on rocket_growth_profit_daily
  for all to authenticated
  using (is_admin()) with check (is_admin());
