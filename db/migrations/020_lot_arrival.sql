-- ============================================================
-- 020. 로트 도착 수량 · 불량 처리 (입고 페이지)
--
-- 왜 필요한가: 지금까지는 로트를 만들 때 `qty_china = 발주수량`을 그대로 넣었다.
-- 아직 중국 창고에 도착하지도 않았는데 창고에 있는 것처럼 기록된 셈이라,
-- 출고 화면은 "그 발주가 도착 단계인가"(purchase_orders.status)로 우회해서 걸러야 했다.
--
-- 그런데 사용자 확인(2026-08-18): **1688에서 일부만 먼저 도착하는 일이 실제로 있다.**
-- 그러면 발주 단위 상태로는 표현이 안 된다 — 같은 발주 안에서도 SKU마다 도착 시점이 다르다.
-- 그래서 **로트마다 실제 도착 수량을 기록**하고, 창고 수량은 거기서 나오게 바꾼다.
--
--   qty_ordered            발주 수량 (불변)
--   qty_arrived            실제로 중국 창고에 도착한 누계
--   qty_defect             불량 누계 (도착 검수 + 나중에 발견한 것)
--   qty_ordered - qty_arrived = 아직 안 온 수량
--   qty_china              창고에 실제로 있는 수량 (도착 - 불량 - 출고분)
-- ============================================================

alter table inventory_lots
  add column if not exists qty_arrived int not null default 0;
alter table inventory_lots
  add column if not exists qty_defect int not null default 0;

-- 불량을 어떻게 처리했는지 — 대행사에서 예치금으로 환불받거나, 그냥 손실로 털거나.
-- 사용자가 "둘 다 가능하니 열어두라"고 확인(2026-08-18). 실제 예치금 반영은
-- 나중에 자금 화면에서 하고, 여기서는 어느 쪽으로 처리하기로 했는지만 남긴다.
alter table inventory_lots
  add column if not exists defect_disposition text;   -- refund | loss | null(미정)
alter table inventory_lots
  add column if not exists defect_memo text;

-- ── 기존 데이터 정리 ──────────────────────────────────────────
-- 이미 "중국배대지 도착"으로 넘긴 로트는 발주 수량만큼 도착한 것으로 본다.
update inventory_lots
   set qty_arrived = qty_ordered
 where arrived_china_at is not null and qty_arrived = 0;

-- 아직 도착 안 한 로트는 창고 수량을 0으로 되돌린다 —
-- 예전 코드가 생성 시점에 발주수량을 그대로 넣어둔 것이라 실제와 다르다.
-- 이 로트들은 입고 페이지에서 도착 처리를 해야 창고 수량이 생긴다.
update inventory_lots
   set qty_china = 0
 where arrived_china_at is null and qty_china > 0;
