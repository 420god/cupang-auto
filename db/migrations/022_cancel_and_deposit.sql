-- ============================================================
-- 022. 발주 취소 · 예치금 환불 기록
--
-- 사용자 확인(2026-08-18): 10개 SKU를 발주했는데 그중 2개를 **판매자가 못 팔겠다고**
-- 하는 일이 있다. 그러면 그 SKU만 취소되고 금액은 예치금으로 돌아온다.
--
-- 환불액이 상황마다 다르다는 게 핵심이다:
--   배송 전 취소   -> 배송비까지 돌아온다
--   배송 후 취소   -> 판매자에 따라 다르다(배송비를 내가 부담하는 경우도 있다)
--   불량           -> 역시 판매자마다 다르다
-- 그래서 **시스템은 추정만 하고 실제 금액은 사람이 고칠 수 있어야 한다.**
-- 그리고 예치금은 그때그때 들어오므로, 기록을 "예상"으로 남겼다가 실제 입금과
-- 맞춰본 뒤 "확정"으로 바꾸는 흐름이 필요하다.
-- ============================================================

-- ── 로트 취소 ────────────────────────────────────────────────
-- 발주 수량 자체는 줄이지 않는다. "20개 발주했는데 20개 취소됨"과 "애초에 0개 발주"는
-- 완전히 다른 사실이고, 나중에 "이 공급처는 취소가 잦다"를 보려면 원래 발주량이 남아야 한다.
--   미도착 = qty_ordered - qty_arrived - qty_cancelled
alter table inventory_lots
  add column if not exists qty_cancelled int not null default 0;
alter table inventory_lots
  add column if not exists cancel_reason text;   -- seller_unavailable | no_stock | quality | my_request | other
alter table inventory_lots
  add column if not exists cancel_memo text;

-- ── 예치금 기록 확장 ─────────────────────────────────────────
-- 016에서 만든 supplier_deposits는 "금액과 잔액"만 있었다. 취소·불량 환불을 자동으로
-- 남기려면 **무엇 때문에 생긴 환불인지**(어느 로트의 몇 개)와 **추정인지 확정인지**가 필요하다.
alter table supplier_deposits
  add column if not exists lot_id uuid references inventory_lots(id);
alter table supplier_deposits
  add column if not exists sku_id uuid references my_skus(id);
alter table supplier_deposits
  add column if not exists qty int;
alter table supplier_deposits
  add column if not exists reason text;          -- cancel | defect | ...

-- 시스템이 계산한 추정 환불액. amount_krw는 "실제로 인정할 금액"이고 사람이 고칠 수 있다.
-- 둘을 나란히 두면 나중에 "우리 추정이 실제와 얼마나 달랐나"를 볼 수 있다
-- (예측과 실측을 함께 남긴다는 이 프로젝트의 원칙).
alter table supplier_deposits
  add column if not exists estimated_amount_krw numeric;

-- expected: 돌려받을 예정(아직 입금 확인 안 됨) / confirmed: 실제 입금 확인됨 / void: 취소됨
alter table supplier_deposits
  add column if not exists status text not null default 'expected';
alter table supplier_deposits
  add column if not exists confirmed_at timestamptz;

create index if not exists supplier_deposits_status on supplier_deposits (status);
create index if not exists supplier_deposits_lot on supplier_deposits (lot_id);
