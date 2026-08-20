-- ============================================================
-- 025. 상품 정보 수정(상품명·검색어·대표이미지·상세페이지) + 이미지 저장소
--
-- 정찰로 확인된 것(2026-08-20, docs/api/coupang-open-api.md):
--   · 상품 수정은 **부분 수정이 안 된다.** 전체 몸통을 PUT해야 정상 검증에 들어간다
--   · rocketGrowthAdditionalInformation.legalAgreement = "AGREE" 가 반드시 있어야 한다
--     (조회 응답에는 안 나오는 쓰기 전용 필드다)
--   · 이미지 업로드 API는 없다. images[].vendorPath 에 http로 시작하는 공개 URL을 주면
--     쿠팡이 내려받는다(80·443 포트만)
--   · **이미지·상세페이지·검색어는 상품이 아니라 옵션(items[]) 단위다**
--
-- 그래서 웹은 "무엇을 바꿀지"만 담고, **워커가 쏘기 직전에 쿠팡에서 최신 상품을
-- 조회해 거기에 얹어 보낸다.** 우리 DB의 사본을 보내면 그 사이 WING에서 바뀐 게
-- 통째로 덮인다 — 전체 몸통 PUT이라 빠뜨린 필드는 지워지기 때문에 특히 위험하다.
-- ============================================================

-- ── 큐에 상품 수정 종류 추가 ─────────────────────────────────
alter table coupang_write_queue drop constraint if exists coupang_write_queue_kind_check;
alter table coupang_write_queue add constraint coupang_write_queue_kind_check
  check (kind in ('price', 'sale_stop', 'sale_resume', 'price_sync', 'product_update'));

-- 상품 수정은 **상품 단위**다(sellerProductId). 가격은 옵션 단위(vendorItemId)였다.
-- 둘을 한 컬럼에 섞지 않는다 — 나중에 "이 상품에 무슨 일이 있었나"를 볼 때
-- 어느 축으로 묶어야 할지 모르게 된다.
alter table coupang_write_queue
  add column if not exists seller_product_id text;

-- 무엇을 바꿀지. 전체 몸통이 아니라 **변경분만** 담는다(위 설명 참조).
--   { "requested": true,
--     "product": { "sellerProductName": "..." },
--     "items": { "<vendorItemId>": { "itemName", "searchTags", "images", "contents" } } }
alter table coupang_write_queue
  add column if not exists payload jsonb;

-- 쿠팡에 실제로 보낸 몸통을 통째로 남긴다(R-04). 전체 PUT이라 **무엇을 덮어썼는지가
-- 사고 조사의 전부**가 된다 — 나중에 "이 필드가 왜 비었지"를 추적할 유일한 단서다.
alter table coupang_write_queue
  add column if not exists sent_body jsonb;

-- 대상 컬럼 제약을 종류별로 다시 건다.
--   price/sale_*  → vendor_item_id 필수 (옵션 단위)
--   product_update → seller_product_id 필수 (상품 단위)
--   price_sync     → 둘 다 없으면 '전체'
alter table coupang_write_queue drop constraint if exists coupang_write_queue_target_required;
alter table coupang_write_queue add constraint coupang_write_queue_target_required
  check (
    (kind = 'price_sync')
    or (kind = 'product_update' and seller_product_id is not null)
    or (kind in ('price', 'sale_stop', 'sale_resume') and vendor_item_id is not null)
  );

create index if not exists coupang_write_queue_product
  on coupang_write_queue (seller_product_id, requested_at desc);

-- ── 이미지 저장소 ────────────────────────────────────────────
-- **공개 버킷이어야 한다.** 쿠팡이 로그인 없이 URL로 내려받아야 하기 때문이다.
-- 상품 이미지라 공개돼도 민감하지 않다 — 어차피 쿠팡 상세페이지에 공개된다.
--
-- 원본을 우리가 계속 갖게 되는 것도 의도다(R-04). 쿠팡 CDN에만 있으면
-- "이 상세페이지로 바꿨더니 판매가 어떻게 됐나"를 나중에 되짚을 수 없다.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

do $$
begin
  -- 읽기: 누구나. 쿠팡 서버가 익명으로 받아가야 하므로 authenticated로 막으면 안 된다.
  execute 'drop policy if exists "product_images_public_read" on storage.objects';
  execute 'create policy "product_images_public_read" on storage.objects '
       || 'for select using (bucket_id = ''product-images'')';

  -- 쓰기·삭제: 관리자만. 다른 테이블과 같은 기준(is_admin())을 쓴다.
  execute 'drop policy if exists "product_images_admin_write" on storage.objects';
  execute 'create policy "product_images_admin_write" on storage.objects '
       || 'for insert to authenticated with check (bucket_id = ''product-images'' and is_admin())';

  execute 'drop policy if exists "product_images_admin_delete" on storage.objects';
  execute 'create policy "product_images_admin_delete" on storage.objects '
       || 'for delete to authenticated using (bucket_id = ''product-images'' and is_admin())';
exception when insufficient_privilege then
  -- Supabase 프로젝트에 따라 storage.objects 정책을 SQL로 못 거는 경우가 있다.
  -- 그때는 대시보드 Storage > product-images > Policies 에서 같은 내용을 만들면 된다.
  raise notice 'storage.objects 정책을 SQL로 걸 수 없었다 — 대시보드에서 직접 만들 것';
end $$;

-- ── 상품 원문 보관: 화면이 '지금 값'을 보고 편집할 수 있게 ────
-- 웹은 쿠팡을 직접 못 부른다(D-16). 그런데 검색어·이미지·상세페이지의 현재 값을
-- 모르면 **깜깜이로 편집**하게 되고, 전체 몸통 PUT이라 그건 곧 사고다.
-- 그래서 워커가 상품 원문을 통째로 가져와 여기 넣어두고 화면이 그걸 읽는다.
--
-- 파싱해서 컬럼으로 쪼개지 않고 원문을 통으로 두는 이유: 쿠팡 상품 구조가 크고
-- (최상위 23키 x 옵션 23키) 아직 다 모른다. 쪼개면 모르는 필드가 버려지는데,
-- 전체 PUT 방식에서 **버려진 필드는 곧 지워지는 필드**다(R-04).
alter table rocket_growth_product_registry
  add column if not exists product_json      jsonb;
alter table rocket_growth_product_registry
  add column if not exists product_fetched_at timestamptz;

-- 읽기 전용 종류. 아무것도 바꾸지 않고 쿠팡에서 상품을 가져와 위 컬럼에 넣는다.
alter table coupang_write_queue drop constraint if exists coupang_write_queue_kind_check;
alter table coupang_write_queue add constraint coupang_write_queue_kind_check
  check (kind in ('price', 'sale_stop', 'sale_resume', 'price_sync',
                  'product_update', 'product_fetch'));

alter table coupang_write_queue drop constraint if exists coupang_write_queue_target_required;
alter table coupang_write_queue add constraint coupang_write_queue_target_required
  check (
    (kind = 'price_sync')
    or (kind in ('product_update', 'product_fetch') and seller_product_id is not null)
    or (kind in ('price', 'sale_stop', 'sale_resume') and vendor_item_id is not null)
  );
