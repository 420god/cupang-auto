-- ============================================================
-- 034. skuInfo 의 날짜 관리 플래그 두 개
--
-- 상품 13건의 원문을 전수 확인한 결과(2026-08-21), skuInfo 에는 **날짜 관련 플래그가
-- 셋**이다. 031 에는 하나(expired_at_managed)밖에 없었다.
--
--   expiredAtManaged        소비기한 관리
--   producedAtManaged       (WING 화면의 "제조일이 적혀 있나요?" 로 추정)
--   manufacturedAtManaged   (위와 둘 중 하나 — **어느 쪽인지 미확인**)
--
-- **둘의 차이를 아직 모른다.** 실측은 13/13 전부 false 라서 구분할 근거가 없었다.
-- 그래서 둘 다 칸을 만들어두고 기본값 false 로 둔다. 모르는 채로 하나만 만들면
-- 나중에 "왜 이 값은 못 넣지"가 된다.
--
-- **skuInfo 는 주면 전 항목이 필수**라, 빠진 필드를 모르고 보내면 등록이 깨진다.
-- 그래서 실측으로 확인한 22개를 전부 채울 수 있어야 한다.
-- ============================================================

alter table listing_project_items
  add column if not exists produced_at_managed boolean not null default false;
alter table listing_project_items
  add column if not exists manufactured_at_managed boolean not null default false;
