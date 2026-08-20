-- ============================================================
-- 028. v_product_experiments — "이렇게 바꿨더니 어떻게 됐나"를 한 줄 SQL로
--
-- 변경 1건이 한 행이고, 그 앞뒤 지표가 이미 붙어 있다.
-- **AI 에이전트가 표 네 개를 조인하며 헤매지 않게 하는 것이 이 뷰의 목적이다.**
-- 계산식이 DB 안에 한 벌로 있으면 AI가 매번 새로 짜지 않는다 —
-- 마진 계산을 calcMargin() 하나로 묶어둔 것과 같은 이유다.
--
-- 판단이 필요했던 지점들:
--
-- ① **변경 당일은 전후 어느 쪽에도 안 넣는다.** 변경이 하루 중 몇 시에 일어났는지
--    모르므로 그날 지표는 전후가 섞여 있다. 어느 한쪽에 넣으면 그만큼 오염된다.
--
-- ② **전환율은 평균이 아니라 다시 계산한다.** 일별 전환율을 평균 내면 조회가 적은
--    날이 과대 대표된다(3회 중 1건=33%가 300회 중 5건=1.7%와 같은 무게가 된다).
--    합계끼리 나눠야 맞다.
--
-- ③ **교란 요인을 같이 낸다.** 이게 없으면 AI가 잘못된 결론을 확신한다:
--    · 같은 창 안에 다른 변경이 또 있었나 → 원인을 못 가린다
--    · 품절인 날이 있었나 → 지표가 떨어지는 게 당연하다
--    · 광고 상태가 바뀌었나 → 조회 증가가 광고 때문일 수 있다
--    · 아이템위너를 잃었나 → 노출 자체가 사라진다
--
-- ④ **표본이 부족하면 그렇다고 말한다.** 지금 하루 조회가 1,200 남짓이라 대부분의
--    변경은 통계적으로 판단 불가다. 숫자만 보여주면 사람도 AI도 과신한다.
-- ============================================================

drop view if exists v_product_experiments;

create view v_product_experiments as
with ch as (
  select
    h.id, h.vendor_item_id, h.seller_product_id, h.sku_id,
    h.field, h.before_value, h.after_value, h.source,
    h.primary_metrics, h.hypothesis, h.changed_by, h.queue_id, h.changed_at,
    -- 지표는 KST 하루 단위라 변경 시각도 KST 날짜로 맞춘다
    (h.changed_at at time zone 'Asia/Seoul')::date as changed_date
  from product_change_history h
),
win as (
  select ch.*,
    changed_date - 7 as before_from, changed_date - 1 as before_to,
    changed_date + 1 as after_from,  changed_date + 7 as after_to
  from ch
),
agg as (
  select
    w.id,
    -- 전
    count(mb.metric_date)                        as days_before,
    coalesce(sum(mb.views), 0)                   as views_before,
    coalesce(sum(mb.visitors), 0)                as visitors_before,
    coalesce(sum(mb.cart_adds), 0)               as cart_adds_before,
    coalesce(sum(mb.orders), 0)                  as orders_before,
    coalesce(sum(mb.sold_qty), 0)                as sold_qty_before,
    coalesce(sum(mb.revenue), 0)                 as revenue_before,
    -- 후
    count(ma.metric_date)                        as days_after,
    coalesce(sum(ma.views), 0)                   as views_after,
    coalesce(sum(ma.visitors), 0)                as visitors_after,
    coalesce(sum(ma.cart_adds), 0)               as cart_adds_after,
    coalesce(sum(ma.orders), 0)                  as orders_after,
    coalesce(sum(ma.sold_qty), 0)                as sold_qty_after,
    coalesce(sum(ma.revenue), 0)                 as revenue_after,
    -- 교란 요인
    count(*) filter (where ma.is_oos)            as oos_days_after,
    count(*) filter (where mb.is_oos)            as oos_days_before,
    count(*) filter (where ma.is_item_winner is false) as lost_winner_days_after,
    count(distinct ma.ad_campaign_status)        as ad_status_kinds_after,
    count(distinct mb.ad_campaign_status)        as ad_status_kinds_before
  from win w
  left join coupang_item_metrics_daily mb
         on mb.vendor_item_id = w.vendor_item_id
        and mb.metric_date between w.before_from and w.before_to
  left join coupang_item_metrics_daily ma
         on ma.vendor_item_id = w.vendor_item_id
        and ma.metric_date between w.after_from and w.after_to
  group by w.id
),
others as (
  -- 같은 옵션에 **같은 창 안에서** 일어난 다른 변경. 있으면 원인을 못 가린다.
  select w.id, count(o.id) as other_changes_in_window
  from win w
  left join ch o
         on o.vendor_item_id = w.vendor_item_id
        and o.id <> w.id
        and o.changed_date between w.before_from and w.after_to
  group by w.id
)
select
  w.id                                   as change_id,
  w.vendor_item_id,
  w.seller_product_id,
  w.sku_id,
  w.changed_at,
  w.changed_date,
  w.field,                               -- thumbnail | detail_page | search_tags | product_name | item_name | price | sale_status
  w.source,                              -- our_write = 우리가 바꿈 / sync = WING에서 누가 바꿈
  w.primary_metrics,                     -- 이 변경으로 움직여야 하는 지표
  w.hypothesis,                          -- 왜 바꿨나 (사람이 적은 가설)
  w.before_value,
  w.after_value,

  w.before_from, w.before_to, w.after_from, w.after_to,
  a.days_before, a.days_after,

  a.views_before, a.views_after,
  a.visitors_before, a.visitors_after,
  a.cart_adds_before, a.cart_adds_after,
  a.orders_before, a.orders_after,
  a.sold_qty_before, a.sold_qty_after,
  a.revenue_before, a.revenue_after,

  /* **일평균으로 비교한다.** 전후 날짜 수가 다를 수 있어서(경계·미수집) 합계를
     그대로 비교하면 날짜 수 차이가 변화로 보인다. */
  case when a.days_before > 0 then round(a.views_before::numeric / a.days_before, 2) end as views_per_day_before,
  case when a.days_after  > 0 then round(a.views_after::numeric  / a.days_after, 2)  end as views_per_day_after,
  case when a.days_before > 0 and a.views_before > 0 and a.days_after > 0
       then round(((a.views_after::numeric / a.days_after) / (a.views_before::numeric / a.days_before) - 1) * 100, 1)
  end as views_change_pct,

  case when a.days_before > 0 then round(a.orders_before::numeric / a.days_before, 2) end as orders_per_day_before,
  case when a.days_after  > 0 then round(a.orders_after::numeric  / a.days_after, 2)  end as orders_per_day_after,
  case when a.days_before > 0 and a.orders_before > 0 and a.days_after > 0
       then round(((a.orders_after::numeric / a.days_after) / (a.orders_before::numeric / a.days_before) - 1) * 100, 1)
  end as orders_change_pct,

  /* 전환율은 **합계끼리 나눈다**(위 ② 참조). 일별 평균을 내면 조회가 적은 날이 과대 대표된다. */
  case when a.views_before > 0 then round(a.orders_before::numeric / a.views_before * 100, 3) end as conv_pct_before,
  case when a.views_after  > 0 then round(a.orders_after::numeric  / a.views_after  * 100, 3) end as conv_pct_after,
  case when a.views_before > 0 and a.orders_before > 0 and a.views_after > 0
       then round((((a.orders_after::numeric / a.views_after) / (a.orders_before::numeric / a.views_before)) - 1) * 100, 1)
  end as conv_change_pct,

  -- ── 교란 요인 ──
  o.other_changes_in_window,
  a.oos_days_before, a.oos_days_after,
  a.lost_winner_days_after,
  (a.ad_status_kinds_before > 1 or a.ad_status_kinds_after > 1
   or a.ad_status_kinds_before <> a.ad_status_kinds_after) as ad_status_changed,

  /* **판단해도 되는가.** 숫자만 내놓으면 사람도 AI도 과신한다.
     기준을 여기 한 곳에 박아두면 화면과 AI가 같은 잣대를 쓴다. */
  case
    when a.days_after = 0                      then '아직 이릅니다 — 변경 후 지표가 없습니다'
    when a.days_before = 0                     then '비교 불가 — 변경 전 지표가 없습니다'
    when o.other_changes_in_window > 0         then '원인 불명 — 같은 기간에 다른 변경이 있었습니다'
    when a.oos_days_after > 0                  then '해석 주의 — 변경 후 품절인 날이 있었습니다'
    when a.lost_winner_days_after > 0          then '해석 주의 — 변경 후 아이템위너를 잃은 날이 있었습니다'
    when a.views_before < 100 or a.views_after < 100
                                               then '표본 부족 — 조회가 적어 판단하기 어렵습니다'
    else '비교 가능'
  end as verdict,

  a.days_after < 7 as window_incomplete
from win w
join agg a on a.id = w.id
join others o on o.id = w.id;

comment on view v_product_experiments is
  '상품 변경 1건 = 1행. 변경 전 7일 / 후 7일 지표와 교란 요인, 판단 가능 여부까지 붙어 있다. '
  '변경 당일은 전후 어느 쪽에도 넣지 않는다(시각을 모르므로 섞여 있다). '
  'AI 분석은 이 뷰를 읽는다 — 원본 표를 직접 조인하면 매번 다른 기준이 된다.';
