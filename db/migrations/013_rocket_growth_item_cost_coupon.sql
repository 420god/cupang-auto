-- ============================================================
-- 013. 상품별 원가 스냅샷에 개당 쿠폰비 컬럼 추가
--
-- inventory-health-dashboard/search 응답의 pricing.allMemberInstantDiscount +
-- allMemberDownloadableDiscount(둘 다 판매자 부담 쿠폰) — 확정 정산(profit-status)의
-- totalSellerInstantDiscountAmount + totalSellerDownloadDiscountAmount와 같은
-- 개념·같은 명명 규칙이라 이 둘의 합을 개당 쿠폰비로 쓴다. docs/api-notes.md 4-4-6 참조.
-- 새 API 호출 없이 syncItemCosts()가 이미 받는 응답에서 필드만 하나 더 뽑는 것.
-- ============================================================

alter table rocket_growth_item_cost_snapshots
  add column if not exists coupon_amount bigint not null default 0;
