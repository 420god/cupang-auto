-- ============================================================
-- 027. 지표 표를 '엑셀 기준'에서 '실제 API 기준'으로 맞춘다 + 유입경로
--
-- 026은 사용자가 준 엑셀을 보고 짰다. 그런데 실제 API 응답을 캡처해보니
-- **같은 개념인데 단위가 다르다**(2026-08-20, docs/api/wing-internal.md):
--     구매전환율   엑셀 "1.71%"        vs  API pvToOrder 0.0171   (퍼센트 아니고 비율)
--     아이템위너   엑셀 "88.9" (%)     vs  API isItemWinner false (비율 아니고 불리언)
-- 엑셀 기준으로 두면 나중에 API로 채울 때 조용히 100배 틀리거나 타입이 안 맞는다.
-- **API가 원본이므로 API에 맞춘다.**
--
-- 그리고 엑셀에 없던 것들이 응답에 있었다 — searchVolume·srpClick·srpClickShare는
-- 지금 전부 0이지만 유료 구독 시 채워질 자리로 보인다. 미리 받아두면 구독하는 날부터
-- 바로 쌓인다(안 만들어두면 그날부터 다시 마이그레이션해야 한다).
-- ============================================================

-- ── 단위가 어긋난 컬럼 정리 ──────────────────────────────────
-- conversion_rate는 이제 **비율**을 담는다(0.0171 = 1.71%). 화면에서 곱해 보여준다.
-- 이미 들어간 값이 없으므로(아직 한 번도 안 채웠다) 그냥 의미만 바꾼다.
comment on column coupang_item_metrics_daily.conversion_rate is
  '주문/조회 비율. API pvToOrder 원값 그대로 (0.0171 = 1.71%). 퍼센트가 아니다';

-- 아이템위너는 옵션마다 참/거짓이다. 엑셀의 "%"는 기간 평균이었던 것으로 보인다.
alter table coupang_item_metrics_daily
  add column if not exists is_item_winner boolean;
comment on column coupang_item_metrics_daily.item_winner_rate is
  '엑셀에서 오는 기간 평균(%). API 경로로 받을 땐 비어 있고 is_item_winner를 쓴다';

-- ── 응답에 있는데 026에 없던 것들 ────────────────────────────
-- 지금은 0으로 오지만 구독하면 채워질 자리(searchVolume/srpClick/srpClickShare).
alter table coupang_item_metrics_daily add column if not exists search_volume     numeric;
alter table coupang_item_metrics_daily add column if not exists srp_click         numeric;
alter table coupang_item_metrics_daily add column if not exists srp_click_share   numeric;

-- 실험 해석에 직접 쓰이는 상태값들.
-- is_oos: 품절이면 지표가 떨어지는 게 당연하다 — 변경 효과와 헷갈리면 안 된다
-- has_badge / rating_*: 배지·리뷰도 전환율을 흔든다
alter table coupang_item_metrics_daily add column if not exists is_oos            boolean;
alter table coupang_item_metrics_daily add column if not exists has_badge         boolean;
alter table coupang_item_metrics_daily add column if not exists rating_count      int;
alter table coupang_item_metrics_daily add column if not exists rating_review     numeric;
alter table coupang_item_metrics_daily add column if not exists registration_type text;   -- RFM=로켓그로스 / NORMAL=판매자배송
alter table coupang_item_metrics_daily add column if not exists category_path     text;
-- 그날 그 옵션의 대표이미지 경로. **썸네일 실험의 증거다** — 이력과 대조하면
-- "이 지표가 찍힌 날 화면에 걸려 있던 그림"이 무엇이었는지 확정할 수 있다.
alter table coupang_item_metrics_daily add column if not exists image_path        text;

-- 광고 캠페인 상태(one-click-setup/condition). ABORTED_INACTIVE 등.
-- **광고를 켠 날의 조회 증가를 썸네일 효과로 오독하지 않으려면 이게 필요하다.**
alter table coupang_item_metrics_daily add column if not exists ad_campaign_status text;
alter table coupang_item_metrics_daily add column if not exists ad_campaign_count  int;

-- 응답 원문을 통째로 남긴다(R-04). 쿠팡이 *Variance 를 이미 계산해서 주는데,
-- 비교 기준 기간이 불명확해서 우리 분석엔 안 쓴다 — 대신 버리지도 않는다.
-- 나중에 기준을 알아내면 되살릴 수 있고, 응답에 새 필드가 생겨도 여기 남는다.
alter table coupang_item_metrics_daily add column if not exists raw jsonb;

-- ── 유입경로 (하루 × 경로) ───────────────────────────────────
-- traffic-insight 는 **판매자 전체 단위다** — 요청에 vendorItemIds가 없다.
-- 그래서 옵션별 인과까지는 못 가르지만, "그날 광고 유입이 있었나"는 확실히 알 수 있다.
-- 실험 분석에서 이게 없으면 광고 효과를 썸네일 효과로 오독한다.
--
-- **without-subscription 엔드포인트라 유료 구독 없이도 온다**(2026-08-20 확인).
-- 구독하면 옵션별·검색어별이 열릴 것으로 보이는데, 그때는 이 표에 컬럼을 더하면 된다.
create table if not exists coupang_traffic_daily (
  metric_date        date not null,
  traffic_source     text not null,   -- search | recommendation | promotion | ADS | ...
  traffic_group      text,            -- internal_organic 등
  registration_types text,            -- 요청에 쓴 값 그대로. 나중에 범위를 바꾸면 구분해야 한다

  impression         bigint,
  glance_views       bigint,          -- 이 경로로 들어온 조회수
  add_to_cart        bigint,
  orders             bigint,
  units_sold         bigint,
  gmv                bigint,
  conversion_rate    numeric,         -- 여기선 퍼센트로 온다(1.72). 위 pvToOrder와 단위가 다르다
  glance_views_mix   numeric,         -- 전체 조회 중 이 경로 비중(%)
  unit_sold_contrib  numeric,

  raw                jsonb,
  uploaded_at        timestamptz not null default now(),
  primary key (metric_date, traffic_source)
);

create index if not exists coupang_traffic_date on coupang_traffic_daily (metric_date desc);

-- ── 어디까지 받았나 ──────────────────────────────────────────
-- 확장프로그램은 브라우저가 켜져 있을 때만 돈다. 며칠 WING을 안 열면 구멍이 생기는데,
-- **어디가 구멍인지 알아야 다음에 열었을 때 메울 수 있다.**
-- 성공한 날만 기록하면 "안 받은 날"과 "받았는데 데이터가 0인 날"을 구분 못 한다(R-15).
create table if not exists coupang_metrics_sync_log (
  metric_date   date primary key,
  synced_at     timestamptz not null default now(),
  item_rows     int,      -- 옵션 지표 몇 행
  traffic_rows  int,      -- 유입경로 몇 행
  pages         int,      -- 몇 페이지를 돌았나
  note          text
);

do $$
declare t text;
begin
  foreach t in array array['coupang_traffic_daily', 'coupang_metrics_sync_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "read_for_authenticated" on %I', t);
    execute format('create policy "read_for_authenticated" on %I for select to authenticated using (true)', t);
    execute format('drop policy if exists "write_for_admin" on %I', t);
    execute format('create policy "write_for_admin" on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;
