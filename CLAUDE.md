# 쿠팡 소싱 시스템

중국 1688 사입 → 쿠플러스 구매대행 → 로켓그로스 판매. **다품종 소량**, 6개월 내 SKU 수천 개 목표.
소싱·발주·재고·판매·이익을 한 시스템으로 묶고, 쌓인 데이터를 나중에 **AI 에이전트가 분석**하게 한다.

## 먼저 이것부터

**애매하면 묻는다 (R-10)** — 아래 상황에서는 판단하지 말고 그냥 물어본다.
새 테이블·컬럼 / 계산식·회계 규칙 / 실무 순서를 코드로 옮길 때 / 이미 쓰는 화면의 동작 변경 /
외부 파일·API 구조 가정 / 기본값 결정.
**질문에는 항상 `> 제안:`을 붙인다** — 그래야 질문이 진행을 막지 않는다.
묻지 않아도 되는 것: 변수명 · CSS 세부 · 커밋 메시지 · 확정된 규칙의 재확인.

**작업·결정 턴 끝에 `확인 필요` 또는 `가정 없음`을 적는다 (R-11).**

**사용자가 `규칙!` 이라고 하면** — 어긴 규칙을 짚고, `docs/rules/INDEX.md`에 위반을 기록하고,
왜 안 지켜졌는지 한 줄 남긴다. 어긴 게 없다고 판단되면 그렇게 말한다.

**사용자가 `[세션 마무리!]` 라고 하면** — `docs/HOW-TO-DOCUMENT.md`의 7단계 절차를 따른다.

## 세션 시작 시

1. `STATUS.md` — 미실행 마이그레이션·배포 상태·미해결
2. `docs/INDEX.md` — 필요한 문서를 여기서 고른다
3. 처음이면 `docs/GLOSSARY.md` 한 번

## 규칙 (상세·이력 → `docs/rules/INDEX.md`)

**전역**
- **R-01** `service_role`/`secret` 키를 어떤 파일에도 넣지 않는다
- **R-02** 실행된 마이그레이션은 수정하지 않는다 — 새 번호만, 항상 멱등하게
- **R-03** 데이터 무결성 키를 건드리지 않는다 — `user_items` 복합키·`item_history` 유니크·`on_conflict`
- **R-04** 원본을 버리지 않는다 — 집계만 저장하지 말고 raw 값을 남긴다
- **R-05** 추정과 확정을 구분해서 저장한다

**작업 방식**
- **R-10** 애매하면 묻는다 (위 참조)
- **R-11** 작업·결정 턴 끝에 `확인 필요` / `가정 없음`
- **R-12** 외부 파일·API 구조는 **실물을 확인한 뒤** 코드를 쓴다 (청구서 3회 오판)
- **R-13** 내놓기 전에 **실제로 돌려본다** — 화면은 브라우저, 서버 코드는 `scripts/jscheck.py`
- **R-14** 구조를 가정하지 말고 **검산에 기댄다**
- **R-15** 파생 화면은 원본이 없을 때 **그 사실을 말한다**
- **R-16** 알게 된 즉시 기록한다 — 몰아서 하지 않는다
- **R-17** `CLAUDE.md`엔 "모르고 건드리면 사고 나는 것"만 — 한도 넘으면 `docs/`로 내린다

## 구조

```
extension/  크롬 확장프로그램 (수집·WING 동기화)   → 폴더 CLAUDE.md
web/        웹사이트 (12개 화면)                   → 폴더 CLAUDE.md
db/         Supabase 스키마                        → 폴더 CLAUDE.md
scripts/    VPS 동기화 · 점검 스크립트
docs/       모든 상세 문서                         → docs/INDEX.md
```

**셋을 묶는 계약**: 스키마 하나가 세 곳의 API다.
```
extension/supabase.js buildSupabasePayload()  →  db/migrations/*.sql  →  web/js/*.js
```
컬럼을 바꾸면 ①마이그레이션 새 번호 ②extension ③web ④`bash scripts/check_all.sh` 순으로 챙긴다.

## 문서 지도

| 찾는 것 | 어디 |
|---|---|
| 지금 사실 (마이그레이션·배포·미해결) | `STATUS.md` |
| 무엇이 어디 있는지 · 키워드 색인 | `docs/INDEX.md` |
| 원가·이익 계산 | `docs/domain/cost-model.md` |
| 발주·입고·출고 수량 흐름 | `docs/domain/inventory-flow.md` |
| 쿠팡 상품 등록·수정·실험 기록 | `docs/domain/product-listing.md` |
| 청구서 인식 | `docs/domain/invoice-parsing.md` |
| 판매현황 계산 | `docs/domain/sales-profit.md` |
| API 스펙·함정 | `docs/api/` |
| 뒤집으면 비싼 결정 (`D-NN`) | `docs/decisions/INDEX.md` |
| 최근 세션에 무슨 일이 | `docs/sessions/INDEX.md` |
| 2026-08-19 재구성 이전 원본 | `docs/archive/` |
