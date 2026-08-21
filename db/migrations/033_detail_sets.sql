-- ============================================================
-- 033. 상세페이지를 '세트' 단위로 관리한다
--
-- 상세페이지는 대표이미지와 다르다: **여러 장이 한 덩어리로 하나의 상세페이지**다.
-- 그래서 후보를 낱장으로 관리하면 "A안에서 B안으로 바꿨더니 전환율이 어땠나"를
-- 판정할 수 없다 — 무엇에서 무엇으로 바꿨는지가 장 단위로 흩어지기 때문이다.
-- (사용자 결정 2026-08-21: 세트 단위 + 한 장짜리 긴 이미지 둘 다 되게)
--
-- 한 장짜리 긴 이미지는 **장 수가 1인 세트**다. 따로 취급하지 않는다 —
-- 특별 취급하면 코드가 두 갈래가 되고 이력도 두 모양이 된다.
--
-- 대표이미지(kind='rep')는 세트 개념이 없다. set_no 는 기본값 1 로 두고 안 쓴다.
-- ============================================================

alter table listing_assets add column if not exists set_no int not null default 1;
alter table listing_assets add column if not exists set_label text;

-- 세트 안의 순서가 곧 노출 순서다. 세트별로 position 을 따로 센다.
create index if not exists listing_assets_set
  on listing_assets (project_id, kind, set_no, position);
