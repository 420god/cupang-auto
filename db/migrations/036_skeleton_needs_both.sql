-- ============================================================
-- 036. 뼈대 단계는 두 그룹이 **다** 붙어야 완료다
--
-- 035 에서 규칙을 이렇게 썼다:
--   (배송 뼈대 있음 and 고시 뼈대 있음) or 복제 원본 있음
--
-- 그런데 화면에서 뼈대를 붙일 때 **복제 원본 ID도 같이 채운다**(출처가 그 상품이므로).
-- 그래서 한쪽만 붙여도 뒤의 조건이 참이 되어 **완료로 떠버렸다**(2026-08-21 실측).
-- 예외를 남겨둔 게 규칙을 통째로 무력화한 경우다.
--
-- 이제 복제 원본은 '출처 기록'과 '상세페이지를 원본 것으로 쓸 때'만 쓰고,
-- 뼈대 완료 판정에서는 빼다.
-- ============================================================

create or replace view v_listing_progress with (security_invoker = true) as
select
  p.id,
  p.status,
  p.product_name,
  p.updated_at,
  i.item_count,

  -- 둘 다 있어야 한다. 하나만 있으면 등록 몸통에 빈 자리가 생긴다.
  (p.shipping_template_id is not null and p.notice_template_id is not null) as step_skeleton,
  (p.display_category_code is not null)                                as step_category,
  (coalesce(nullif(trim(p.product_name), ''), null) is not null
     and coalesce(array_length(p.search_tags, 1), 0) > 0)              as step_name,
  (i.item_count > 0 and i.item_count = i.items_with_rep)               as step_rep_image,
  (p.detail_source = 'clone' or i.detail_selected > 0)                 as step_detail,
  (i.item_count > 0 and i.item_count = i.items_logistics_ok)           as step_logistics,
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

create or replace view v_listing_ready with (security_invoker = true) as
select *,
  (step_skeleton and step_category and step_name and step_rep_image
     and step_detail and step_logistics and step_price) as all_done
from v_listing_progress;
