-- ============================================================
-- 019. 배대지 작업비 · 불량 수량 · 로트 분할
--
-- 배경(docs/decisions.md 2026-08-18): 원가는 두 번에 나눠 확정된다.
--   ① 발주 시   구매대행분(상품+중국내배송+국제운임+통관, 환율에 다 포함)
--   ② 출고 시   배대지 작업비(검수·포장·바코드, 개당 300원 수준)
-- 그리고 **작업비 청구서가 쿠팡센터 도착 전에 온다**(사용자 확인)는 게 중요하다 —
-- 물건이 팔리기 시작할 땐 이미 원가가 확정돼 있어서, 팔린 뒤에 원가가 바뀌는
-- 문제 자체가 없다. 소급 재계산 로직을 만들지 말 것.
-- ============================================================

-- ── SKU별 작업비 기본값 ──────────────────────────────────────
-- 왜 항목별로 쪼개나: 사용자 확인(2026-08-18) "바코드 100원 없이 갈 때도 있다".
-- 총액 하나만 저장하면 왜 그 금액인지 나중에 알 수 없다 — 항목을 남겨야
-- "이 상품은 왜 500원인가"에 답할 수 있다(집계보다 원자값을 남기는 프로젝트 원칙).
-- 실제 청구액은 출고 시점에 줄별로 다시 정해지고, 여기 값은 그때의 기본값일 뿐이다.
alter table my_skus
  add column if not exists work_fee_items jsonb
    default '{"inspect": 200, "barcode": 100, "extra": 0}'::jsonb;
alter table my_skus
  add column if not exists work_fee_note text;   -- 에어캡·봉제 등 기타 작업 설명

-- ── 불량 수량 ────────────────────────────────────────────────
-- 중국 배대지 검수에서 발견된다(한국 도착 후 발견은 드묾 — 그건 나중에 재고 조정으로).
-- 불량분은 대행사가 예치금으로 환불해주므로 **개당 원가는 그대로**이고 수량만 준다.
alter table purchase_order_lines
  add column if not exists defect_qty int not null default 0;
alter table purchase_order_lines
  add column if not exists defect_memo text;

-- ── 로트 분할 ────────────────────────────────────────────────
-- 부분 출고가 실제로 일어난다(사용자 확인). 100개 중 60개만 보내면 그 60개엔
-- 작업비가 붙고 남은 40개는 안 붙어서, 한 로트가 두 개의 개당 원가를 갖게 된다.
-- 그래서 출고분을 새 로트로 떼어낸다. split_from_lot_id로 어디서 갈라졌는지 남긴다.
alter table inventory_lots
  add column if not exists split_from_lot_id uuid references inventory_lots(id);

-- ── 원가 구성을 컬럼으로도 남긴다 ────────────────────────────
-- cost_breakdown(jsonb)에 이미 내역이 들어가지만, 사용자가 "총합으로 더하되 따로도
-- 저장해두면 나중에 볼 때 좋겠다"고 해서(2026-08-18) 두 축을 컬럼으로 뺀다.
-- 컬럼이면 "작업비가 원가의 몇 %인가" 같은 질문을 SQL로 바로 물어볼 수 있다
-- (AI가 스키마만 보고 분석 쿼리를 짤 수 있어야 한다는 프로젝트 원칙).
-- unit_cost_krw = unit_purchase_cost_krw + unit_work_fee_krw 가 항상 성립해야 한다.
alter table inventory_lots
  add column if not exists unit_purchase_cost_krw numeric;   -- 구매대행분(발주 시 확정)
alter table inventory_lots
  add column if not exists unit_work_fee_krw numeric not null default 0;  -- 배대지 작업비(출고 시 확정)

-- 019 이전에 만들어진 로트는 작업비가 아직 0이므로 구매대행분 = 총원가다
update inventory_lots
   set unit_purchase_cost_krw = unit_cost_krw
 where unit_purchase_cost_krw is null;

-- ── 출고 묶음에 검산용 필드 ──────────────────────────────────
-- 청구서 총액(사람이 넣거나 파일에서 읽은 값)과 우리가 줄별로 계산한 합계를
-- 나란히 두고 다르면 화면에서 경고한다. 어느 쪽이 맞는지는 사람이 판단한다.
alter table inbound_shipments
  add column if not exists computed_work_fee_krw numeric;
alter table inbound_shipments
  add column if not exists invoice_source text;   -- manual | xlsx | pdf | none
