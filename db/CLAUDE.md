# db/ — Supabase 스키마

## 마이그레이션 규칙

```
migrations/001_init.sql              기본 테이블 10개 + RLS + 뷰 2개
migrations/002_web_features.sql      카테고리 상태 컬럼, 대기열, 초대 테이블, 뷰 1개 추가
migrations/003_cascade_fix.sql       products→categories FK를 cascade로 재생성
migrations/004_delivery_badges.sql   products.delivery_badges(배열) + 자동갱신 트리거 + 조회 인덱스
migrations/005_rocket_growth_sales.sql  로켓그로스 판매현황 일별 스냅샷 테이블(GCP VPS가 upsert)
migrations/006_commission_rates.sql  categories.commission_rate를 WING 수수료안내 페이지 기준으로 채움
migrations/007_drop_global_commission_default.sql  settings.fee_defaults에서 commission_rate 키 제거(전역 가정치 폐기)
migrations/008_root_name_trigger.sql  categories.root_name 자동유지 트리거 + 백필 + commission_rate 재적용
migrations/009_rocket_growth_sales_wing.sql  WING 내부 API 기반 순매출(반품 반영) 스냅샷 — 확장프로그램이 upsert
migrations/010_rocket_growth_profit_daily.sql  WING 정산현황 API 기반 확정 손익 스냅샷(계정 전체 합계) — 확장프로그램이 upsert
migrations/011_rocket_growth_profit_storage.sql  rocket_growth_profit_daily에 storage_amount(보관비) 컬럼 추가 — 새 API 호출 없이 이미 받던 profit-status 응답 필드를 분리 저장
migrations/012_rocket_growth_item_cost_snapshots.sql  상품별 실제 개당 수수료·입출고비·보관비 이력 테이블(덮어쓰지 않고 스냅샷으로 쌓음) — 확장프로그램의 "상품 원가정보 갱신"이 insert
```

**이미 실행된 파일은 절대 수정하지 않는다.** 스키마를 바꿔야 하면 `004_설명.sql`처럼 새 번호로 추가한다. 모든 마이그레이션은 `if not exists`/`drop ... if exists`를 써서 **여러 번 실행해도 안전**하게 만든다 — 이 관례를 유지할 것.

새 세션에서 가장 먼저 확인할 것: **001~011은 실행 확인됨(2026-08-16). 012 실행 여부만 미확인** — 안 됐으면 먼저 실행(`create table if not exists`라 여러 번 실행해도 안전).

## 핵심 설계 (코드로는 안 보이는 이유)

**두 테이블 분리 이유** — `products`(상품, 정적에 가까움) + `product_items`(옵션, 가격·판매량 등 변동값). 옵션마다 이미지·판매량이 다르다는 걸 사용자가 확인해서 이렇게 나눴다. `products.max_sales`/`sum_sales`는 옵션들 중 집계값이고, `rep_image_path`는 **판매량 최대 옵션의 이미지**다.

**`item_history` 하루 1행 제한** — `unique index (item_id, recorded_date)`. `recorded_date`는 `recorded_at`을 KST로 변환한 값이며, **generated column이 아니라 트리거**로 채운다 (timestamptz→date 변환은 타임존 의존이라 PostgreSQL이 생성 컬럼으로 거부함, 에러 `42P17`).

**멀티유저 격리** — `user_items`, `item_calc`, `user_category_favorites`는 PK가 `(user_id, item_id)` 또는 `(user_id, category_code)` 복합키. 공통 데이터(`products` 등)는 회원 전체 읽기 + 관리자만 쓰기(`is_admin()` 함수로 판정).

**관리자 자가승격 방지** — `profiles` update 정책이 `is_admin` 값을 기존 값과 같아야만 통과시킨다. 이걸 없애면 일반 회원이 자기 계정을 관리자로 바꿀 수 있다.

**배송유형은 옵션 것이 원본, 상품 것은 파생값** — 배송유형 컬럼은 `product_items.delivery_badge` 하나뿐이고, `products.delivery_badges`(text[])는 그 상품의 활성 옵션들에 실제로 존재하는 유형을 정규화·중복제거해 접어둔 **캐시**다. `product_items`에 statement 트리거(`trg_delivery_badges_*`)가 걸려 있어 수집할 때마다 자동 갱신된다. **확장프로그램은 이 컬럼을 쓰지 않는다** — 양쪽에서 쓰면 1단계(목록만) 수집이 배송유형을 지워버린다. 정규화 규칙은 `norm_delivery_badge()`에 있고, 못 알아본 라벨은 임의 분류하지 않고 원문 그대로 남긴다.

**카테고리 삭제 연쇄** — `categories` 삭제 시 `products`(cascade, 003에서 추가) → `product_items`(cascade) → `user_items`/`item_calc`(cascade)까지 자동 삭제된다. `item_history`는 FK가 없어서(고의) 별도 트리거(`cleanup_orphan_history`)로 정리한다.

**`root_name`도 파생 캐시 — 반드시 트리거로 유지할 것** — `delivery_badges`와 같은 패턴. `root_name`은 `full_path`의 첫 세그먼트일 뿐인데, 002에서는 한 번 백필만 하고 트리거를 안 달아서 그 이후 새로 수집된 카테고리는 계속 null로 남는 버그가 있었다(008에서 트리거 추가로 해결, `set_category_root_name()`/`trg_category_root_name`). **앞으로 `full_path`에서 파생되는 컬럼을 또 만들면 처음부터 트리거를 같이 만들 것** — "한 번 백필하고 끝"은 반드시 나중에 또 썩는다.

## 미해결 (스키마 관점)

- `item_calc`가 비어 있다. 웹에서 저장하는 코드 자체가 없어서 — 스키마 문제가 아니라 애플리케이션 로직 미구현.
- `product_count`/`item_count`는 `refresh_all_category_stats()` 함수는 있지만 아무도 호출 안 함. 트리거로 자동화하거나 수집 후 명시적으로 호출해야 함.

## 운영 SQL

```sql
-- 관리자 부여
update profiles set is_admin = true where email = '이메일';

-- 전체 요약
select (select count(*) from products) as 상품,
       (select count(*) from product_items) as 옵션,
       (select count(*) from item_history) as 이력;

-- RLS 정책 확인
select tablename, policyname, cmd from pg_policies where tablename = '테이블명';
```

## 자세한 내용

전체 컬럼 정의는 `migrations/*.sql`을 직접 읽을 것 (주석 포함되어 있음).
설계 논의 배경: `../docs/decisions.md`
