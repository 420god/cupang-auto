-- ============================================================
-- 035. 뼈대를 두 종류로 나눈다 (사용자 결정 2026-08-21)
--
--   shipping  배송 · 반품/교환          → **계정 공통에 가깝다.** 거의 안 바뀐다
--   notice    상품정보제공고시 · 상품주요정보 → **상품군마다 다르다.** 여러 벌이 생긴다
--
-- 왜 나누나: 하나로 묶어두면 고시정보만 다른 상품을 만들 때 배송·반품지까지
-- 통째로 복사해야 한다. 그러면 반품지를 바꿀 일이 생겼을 때 **여러 벌을 다 고쳐야 한다.**
-- 나눠두면 배송은 한 벌만 두고 고시정보만 여러 벌 만들어 조합한다.
--
-- 031 의 template_id 는 그대로 두되 **더 쓰지 않는다**(값이 든 행이 없다).
-- 컬럼을 지우면 되돌리기가 어렵고, 남겨두는 비용은 없다.
-- ============================================================

alter table listing_templates
  add column if not exists kind text not null default 'shipping';
do $$
begin
  alter table listing_templates drop constraint if exists listing_templates_kind_check;
  alter table listing_templates add constraint listing_templates_kind_check
    check (kind in ('shipping', 'notice'));
end $$;
create index if not exists listing_templates_kind on listing_templates (kind, is_default);

alter table listing_projects
  add column if not exists shipping_template_id uuid references listing_templates(id);
alter table listing_projects
  add column if not exists notice_template_id uuid references listing_templates(id);

-- ── 진행 판정을 다시 쓴다 ────────────────────────────────────
-- 뼈대 단계는 **두 그룹이 다 붙었을 때** 끝난 것이다. 하나만 붙어도 등록 몸통에
-- 빈 자리가 생긴다. 복제 원본을 통째로 쓰는 경우는 예외로 둔다(그때는 원본에 다 있다).
create or replace view v_listing_progress with (security_invoker = true) as
select
  p.id,
  p.status,
  p.product_name,
  p.updated_at,
  i.item_count,

  ((p.shipping_template_id is not null and p.notice_template_id is not null)
     or p.clone_seller_product_id is not null)                        as step_skeleton,
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
