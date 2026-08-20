# 마이그레이션

> **언제 읽나**: 스키마를 바꿀 때. 특정 마이그레이션이 왜 그렇게 생겼는지 알고 싶을 때.
> **최종 검증**: 2026-08-19
> **실행 상태**: `../STATUS.md` (여기 적으면 바로 낡는다)

## 규칙

**이미 실행된 파일은 절대 수정하지 않는다**(R-02). 새 번호로만 추가한다.
모든 마이그레이션은 `if not exists` / `drop ... if exists`를 써서 **여러 번 실행해도 안전**하게 만든다.

RLS 패턴은 전부 같다 — `read_for_authenticated`(select, 전체) + `write_for_admin`(all, `is_admin()`).

## 이력

| # | 내용 |
|---|---|
| 001~004 | 기본 테이블 10개 · 웹 기능 · cascade · 배송 배지 |
| 005~013 | 로켓그로스 판매현황 5겹 (주문·WING순매출·확정정산·보관비·원가스냅샷·쿠폰비) |
| 014 | 상품 레지스트리 (등록상품ID·상품ID·옵션ID 매핑) |
| 015 | **상품원장** — `my_products`·`my_skus`·`sku_channel_listings`·`sku_suppliers`·`sku_bom` |
| 016 | **공급** — 환율이력·구매요청·청구서줄·입고·로트·재고이동·매출원가·예치금 |
| 017 | **소싱·예측** — 소싱 후보/판단·예측 원장·월 고정비·알림 |
| 018 | 레지스트리에 `item_name` (이미 받던 값을 버리지 않게) |
| 019 | 작업비 항목·불량 수량·로트 분할·원가 2축 |
| 020 | 로트 실제 도착 수량 (`qty_arrived`) |
| 021 | `inventory_lots.sku_id` nullable |
| 022 | 로트 취소 + 예치금 기록 확장 |
| 023 | 쿠팡 쓰기 큐 — 웹이 넣고 VPS가 쏜다(D-16) |
| 024 | 쿠팡 판매가·판매여부·재고 + 가격 변동 이력 |
| 025 | 상품 정보 수정(상품명·검색어·이미지) 큐 + Storage 버킷 |

## 설계에서 꼭 알아야 할 것

**두 테이블 분리(`products` / `product_items`)** — 상품은 정적에 가깝고 옵션은 가격·판매량이
변한다. 옵션마다 이미지·판매량이 다른 걸 확인해서 나눴다.
`products.max_sales`/`sum_sales`는 옵션 집계값이고 `rep_image_path`는 **판매량 최대 옵션의 이미지**다.

**`item_history` 하루 1행 제한** — `unique index (item_id, recorded_date)`.
`recorded_date`는 `recorded_at`을 KST로 변환한 값인데 **generated column이 아니라 트리거**로 채운다
(timestamptz→date 변환은 타임존 의존이라 PostgreSQL이 생성 컬럼으로 거부한다, 에러 `42P17`).

**이력 저장을 "현재상태 + 변경분"으로 나눈 이유** — 목록은 `products`만 읽어 빠르고, 추이는
`item_history`로 본다. 변경분만 저장하면 연 1,640만 행(2~3GB)이지만 전량 저장하면
연 1억 950만 행(15~20GB, 월 4~6만 원)이 된다.

**015~022의 설계 이유**는 도메인 문서에 있다 → `../domain/cost-model.md`, `../domain/inventory-flow.md`

## 실행 여부 확인법

Supabase REST에 물어보면 된다. RLS 때문에 내용은 안 보이지만 **존재 여부는 응답 코드로 갈린다** —
없으면 `PGRST205` 404, 있으면 200 + 빈 배열. 자세한 명령은 `../STATUS.md`.
