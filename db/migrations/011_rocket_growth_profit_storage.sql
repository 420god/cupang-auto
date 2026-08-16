-- ============================================================
-- 011. 로켓그로스 확정 정산 — 보관비 컬럼 분리
--
-- profit-status/search 응답의 profitStatusDeductionDetail.totalStorageFeeAmount는
-- 010에서부터 이미 매번 받아오고 있었지만, totalCfsAmountWithVat(=fulfillment_amount,
-- 창고비+풀필먼트비+보관비+VAT 합계)에 묶여서 따로 안 보였다(docs/api-notes.md 4-4-4
-- 계산식 참조). 판매현황 일별 상세표에 보관비를 별도 컬럼으로 보여달라는 요청으로
-- 분리한다 — 새 API 호출 없이 이미 받던 응답 필드를 하나 더 저장하는 것뿐.
-- ============================================================

alter table rocket_growth_profit_daily
  add column if not exists storage_amount bigint not null default 0;
