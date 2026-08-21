-- ============================================================
-- 029. 신규 상품 등록 (복제 기반) + 소싱 판단 박제 + 카테고리 메타 캐시
--
-- 정찰로 확인된 것(2026-08-20):
--   · 등록/수정은 같은 엔드포인트를 POST/PUT 으로 쓴다. **전체 몸통이 필요하다**
--   · rocketGrowthAdditionalInformation.legalAgreement = "AGREE" 필수
--   · 전체 몸통을 그대로 보냈더니 "중복된 바코드가 존재합니다" 가 나왔다 —
--     **복제할 때 무엇을 지워야 하는지를 이 에러가 알려준 것이다**(식별자 계열)
--   · 이미지는 images[].vendorPath 에 http 공개 URL을 주면 쿠팡이 내려받는다
--
-- 왜 복제가 기본인가: 최상위 23키 + 옵션 23키에 고시정보·필수속성까지 사람이 채우면
-- WING에서 하는 것과 다를 게 없다. 비슷한 기존 상품을 복제하면 배송·반품지·과세유형·
-- 고시정보·필수속성이 그대로 따라오고, 사람은 이름·가격·이미지·검색어만 바꾸면 된다.
-- **다품종 소량이라 비슷한 상품이 계속 나오는 구조**에 이게 맞다.
-- ============================================================

-- ── 큐에 등록 종류 추가 ──────────────────────────────────────
alter table coupang_write_queue drop constraint if exists coupang_write_queue_kind_check;
alter table coupang_write_queue add constraint coupang_write_queue_kind_check
  check (kind in ('price', 'sale_stop', 'sale_resume', 'price_sync',
                  'product_update', 'product_fetch',
                  'product_create',      -- 신규 등록
                  'category_meta'));     -- 카테고리 메타 가져오기(빈 양식 등록용)

-- 등록은 **대상 상품이 없다**(만드는 중이니까). 대신 복제 원본을 seller_product_id 에 담는다.
-- category_meta 는 카테고리 코드를 담는다.
alter table coupang_write_queue
  add column if not exists display_category_code text;

-- 등록에 성공하면 쿠팡이 새 sellerProductId 를 준다. **이게 등록의 결과물이다** —
-- 이걸 남겨야 나중에 "이 판단으로 만든 상품이 저것"이라고 이을 수 있다.
alter table coupang_write_queue
  add column if not exists created_seller_product_id text;

alter table coupang_write_queue drop constraint if exists coupang_write_queue_target_required;
alter table coupang_write_queue add constraint coupang_write_queue_target_required
  check (
    (kind = 'price_sync')
    or (kind = 'category_meta' and display_category_code is not null)
    or (kind = 'product_create')      -- 복제 원본은 payload 안에 담는다(없을 수도 있다: 빈 양식)
    or (kind in ('product_update', 'product_fetch') and seller_product_id is not null)
    or (kind in ('price', 'sale_stop', 'sale_resume') and vendor_item_id is not null)
  );

-- ── 소싱 판단을 등록과 잇는다 ────────────────────────────────
-- sourcing_decisions(017)는 만들어만 두고 채우는 화면이 없어 비어 있었다.
-- 등록 화면이 그 자리다 — **판단 시점의 예상치는 나중에 절대 복원 못 한다.**
--
-- 등록 시점엔 아직 SKU가 없다(등록 후 동기화가 만든다). 그래서 판단 → 상품 →
-- (나중에) SKU 순으로 이어지도록 seller_product_id 를 여기 둔다.
-- my_skus.sourcing_decision_id 는 그대로 두고, SKU가 생기면 이 값으로 맞춰 이으면 된다.
alter table sourcing_decisions
  add column if not exists seller_product_id text;

-- 등록 시점에 사람이 적는 것들. 017의 expected_* 를 그대로 쓰되,
-- "무엇을 근거로 그렇게 봤나"를 자유롭게 남길 자리를 하나 더 둔다.
-- reason_memo 는 이미 있으므로 추가하지 않는다 — 같은 뜻의 컬럼을 두 개 만들면
-- 나중에 AI가 어느 쪽을 읽어야 할지 모른다.

create index if not exists sourcing_decisions_product
  on sourcing_decisions (seller_product_id);

-- ── 카테고리 메타 캐시 (빈 양식 등록용) ──────────────────────
-- 웹은 쿠팡을 직접 못 부른다(D-16). 빈 양식으로 등록하려면 그 카테고리의
-- 필수 속성·고시정보를 알아야 하는데, 그건 쿠팡만 안다.
-- 그래서 워커가 가져와 여기 넣고 화면이 읽는다.
--
-- 원문을 통으로 둔다(R-04). 필수 속성 구조가 카테고리마다 다르고 아직 다 모른다 —
-- 쪼개면 모르는 필드가 버려지는데, 등록은 그 필드가 빠지면 실패한다.
create table if not exists coupang_category_meta (
  display_category_code text primary key,
  category_path         text,
  raw                   jsonb not null,
  fetched_at            timestamptz not null default now()
);

do $$
begin
  execute 'alter table coupang_category_meta enable row level security';
  execute 'drop policy if exists "read_for_authenticated" on coupang_category_meta';
  execute 'create policy "read_for_authenticated" on coupang_category_meta for select to authenticated using (true)';
  execute 'drop policy if exists "write_for_admin" on coupang_category_meta';
  execute 'create policy "write_for_admin" on coupang_category_meta for all to authenticated using (is_admin()) with check (is_admin())';
end $$;
