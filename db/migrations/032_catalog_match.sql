-- ============================================================
-- 032. 카탈로그 상품매칭 결과를 준비 건에 담는다
--
-- WING 상품등록 화면의 '카탈로그 매칭하기'가 주는 것:
--   상품명 · 쿠팡상품ID · **브랜드명 · 제조사 · 카테고리** · 별점 · 조회수(최근 28일)
--
-- 왜 Open API 가 아닌가 (2026-08-21 실물 확인):
--   등록 몸통 23키에 카탈로그를 지정하는 필드가 **없다**(brand · brandId · manufacture ·
--   sellerProductId 뿐). 조회 응답에도 없다. 즉 공식 API 로는 이 정보를 얻을 수도,
--   특정 카탈로그에 붙여달라고 요청할 수도 없다.
--   → WING 내부 API(`POST /tenants/seller-web/pre-matching/search`) + 확장프로그램이
--     유일하게 확인된 길이다. **정보만 가져온다.**
--
-- 원문을 통째로 남기는 이유(R-04): 지금 쓰는 건 브랜드·제조사·카테고리·조회수뿐이지만,
-- 그 응답에 무엇이 더 들어 있는지 아직 다 모른다. 쪼개서 저장하면 모르는 필드가
-- 조용히 버려지고, 그때 판단에 쓴 근거를 나중에 복원할 수 없다.
-- ============================================================

-- 브랜드는 이미 031 에 있다. 제조사는 없어서 추가한다 —
-- 쿠팡 등록 몸통의 최상위 `manufacture` 로 그대로 나간다.
alter table listing_projects add column if not exists manufacture text;

-- 어느 카탈로그에서 가져왔나. **매칭을 신청한 게 아니라 참고한 것**이다.
alter table listing_projects add column if not exists catalog_product_id text;
alter table listing_projects add column if not exists catalog_matched_at timestamptz;

-- 응답 원문 한 건 통째로. 조회수·별점 같은 **그때의 시장 스냅샷**이 여기 남는다.
-- 나중에 "조회수 172짜리를 골랐는데 결과가 어땠나"를 볼 수 있는 유일한 근거다.
alter table listing_projects add column if not exists catalog_snapshot jsonb;

create index if not exists listing_projects_catalog
  on listing_projects (catalog_product_id) where catalog_product_id is not null;

-- 카테고리를 무엇으로 정했는지 구분하려고 category_source 에 값이 하나 더 생긴다.
-- (컬럼은 031 에 이미 있고 자유 텍스트라 제약 변경은 필요 없다:
--  recommend | search | manual | clone | catalog)
