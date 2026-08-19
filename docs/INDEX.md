# 문서 지도

> **언제 읽나**: 무언가를 찾을 때 **가장 먼저**. 어느 문서를 열지 여기서 정한다.
> **최종 갱신**: 2026-08-19

## 먼저 읽을 것

| 파일 | 무엇 |
|---|---|
| `../CLAUDE.md` | 프로젝트 정체성 · 규칙 요약 · 지도 (자동 주입) |
| `../STATUS.md` | **지금 사실** — 마이그레이션·배포·미해결 |
| `GLOSSARY.md` | 용어. 바코드/옵션ID/묶음/로트가 헷갈릴 때 |
| `rules/INDEX.md` | 규칙 상세 + 발동·위반 이력 |
| `HOW-TO-DOCUMENT.md` | 문서 작성 규칙 + `[세션 마무리!]` 절차 |

## 도메인 — 이 시스템이 어떻게 동작하는가

| 파일 | 언제 읽나 |
|---|---|
| `domain/cost-model.md` | 원가가 이상할 때. 원가 계산을 고칠 때 |
| `domain/inventory-flow.md` | 발주→입고→출고 수량·상태가 안 맞을 때 |
| `domain/invoice-parsing.md` | 청구서 인식이 깨졌을 때 |
| `domain/sales-profit.md` | 판매현황 숫자가 WING과 다를 때 |
| `domain/reorder.md` | 재발주 제안 수량이 감과 다를 때 |
| `domain/sourcing.md` | 소싱 탭·카테고리 수집을 건드릴 때 |

## API

| 파일 | 언제 읽나 |
|---|---|
| `api/coupang-open-api.md` | 상품·주문 동기화를 고칠 때 (VPS 스크립트) |
| `api/wing-internal.md` | 정산·재고현황 동기화를 고칠 때 (확장프로그램) |
| `api/couplus.md` | 구매대행 서류·환율·발주 프로세스 |

## 운영

| 파일 | 언제 읽나 |
|---|---|
| `ops/deployment.md` | 배포가 반영 안 될 때 |
| `ops/migrations.md` | 마이그레이션 이력·설계 이유 |

## 기록

| 파일 | 무엇 |
|---|---|
| `decisions/INDEX.md` | 뒤집으면 비싼 결정들 (`D-NN`) |
| `sessions/INDEX.md` | 세션별 한 일·틀린 것 (`S-YYYY-MM-DD`) |
| `archive/` | 2026-08-19 재구성 이전 원본. **옮기다 놓친 게 있으면 여기 있다** |

---

## 키워드 색인

| 찾는 것 | 어디 |
|---|---|
| 환율 320/310/219.72, 두 환율 | `api/couplus.md` · `GLOSSARY.md` |
| 선입선출, 로트 분할, 개당 원가 | `domain/cost-model.md` |
| 청구서가 이상하게 인식됨 | `domain/invoice-parsing.md` |
| 배송비 배분·재배분 | `domain/cost-model.md` · D-11 |
| 불량, 취소, 예치금 환불 | `domain/inventory-flow.md` |
| 도착 대기에 아무것도 안 나옴 | `domain/inventory-flow.md` (SKU 미연결) |
| 부가세 공식 | `domain/sales-profit.md` |
| 보관비를 왜 옵션에 안 붙이나 | `domain/sales-profit.md` · D-07 |
| 반품 상품별 귀속 (막다른 길) | D-08 — **다시 시도하지 말 것** |
| `product_items` 조인 (하지 말 것) | D-09 |
| 바코드가 왜 조인키인가 | D-02 |
| 재발주 수량 공식 | `domain/reorder.md` |
| 수수료 카테고리 매칭 | `domain/sourcing.md` |
| 확장프로그램이 안 먹을 때 | `api/wing-internal.md` · `ops/deployment.md` |
| VPS 스크립트가 0행을 넣을 때 | `api/coupang-open-api.md` |
| 마이그레이션 실행 확인법 | `../STATUS.md` |
