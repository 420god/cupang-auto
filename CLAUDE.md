# 쿠팡 소싱 시스템 — 프로젝트 컨텍스트

> 이 파일은 Claude Code가 이 폴더에서 세션을 시작할 때마다 자동으로 읽는다.
> **코드를 봐도 알 수 없는 것만** 적는다. "무엇을 하는 코드인가"는 파일을 직접 읽을 것.
> "왜 이렇게 짰는가"만 여기 있다.

## 구조

```
coupang-sourcing/
├── extension/    크롬 확장프로그램 (수집 → Supabase 업로드)
│   └── CLAUDE.md   확장프로그램 전용 컨텍스트
├── web/          웹사이트 (조회 · 마진계산 · 관리)
│   └── CLAUDE.md   웹사이트 전용 컨텍스트
├── db/
│   ├── migrations/  순서대로 실행하는 SQL. 지난 파일은 절대 수정 금지, 새 파일만 추가
│   └── CLAUDE.md     스키마 전용 컨텍스트
├── docs/
│   ├── api-notes.md      쿠팡 API 역공학 결과 (가장 중요)
│   ├── decisions.md      의사결정 이력 (A였는데 B라서 C로 변경)
│   └── troubleshooting.md 에러 → 원인 → 해결 (시간순)
└── scripts/       검증 스크립트 (node --check, HTML/JS 정합성 등)
```

## 세 컴포넌트를 묶는 계약(contract)

**extension이 쓰고 web이 읽는 테이블/컬럼이 바뀌면 양쪽 다 고쳐야 한다.**
이 셋은 독립적이지 않다. 스키마 하나가 세 곳의 API다.

```
extension/supabase.js  buildSupabasePayload()  → products/product_items 행 생성
db/migrations/*.sql                            → 그 행이 들어갈 테이블 정의
web/app.js              renderRows() 등        → 그 테이블을 읽어서 화면에 그림
```

**컬럼을 추가·이름변경·삭제할 때 체크리스트**
1. `db/migrations/`에 새 번호로 마이그레이션 추가 (기존 파일 수정 금지)
2. `extension/supabase.js`의 `buildSupabasePayload()` 반영
3. `web/app.js`의 관련 쿼리(`buildQuery`, `renderRows`, `renderOptions` 등) 반영
4. `scripts/check_all.sh` 실행해서 정합성 확인

## 절대 하지 말 것 (프로젝트 전역)

1. **`service_role`/`secret` 키를 어떤 파일에도 넣지 말 것.** extension은 publishable key + 관리자 계정 로그인만 쓴다. 과거 대화에서 secret 키가 노출되어 폐기한 이력이 있다.
2. **`user_items`/`item_calc`의 PK `(user_id, item_id)` 복합키를 단일키로 바꾸지 말 것.** 멀티유저 구조가 깨진다.
3. **`item_history`의 `unique index (item_id, recorded_date)`를 지우지 말 것.** 같은 날 중복 수집 방지의 유일한 장치.
4. **마이그레이션 파일을 수정하지 말 것.** 이미 실행된 것으로 간주하고 새 파일만 추가.

## 지금 상태 (최신 요약 — 사실만. "왜"는 docs/에 있으니 여기 다시 쓰지 말 것)

### 확장프로그램
DB 업로드·대기열 자동처리 구현됨. **`chrome://extensions`에서 새로고침해야 최신 코드 반영** — git push와 무관.
카테고리 수집은 `finishCategoryPipeline()`(popup.js) 하나로 통합돼 **카테고리 하나가 끝날 때마다 그 자리에서 상세보강→요금표확인→DB업로드까지 끝낸다** — 수동 실행과 대기열(`processJob`)이 공유. Supabase 로그인은 20분마다 자동 갱신(`startKeepAlive`). 자세한 흐름은 `extension/CLAUDE.md`.

### 웹사이트
Vercel 배포(`420god/cupang-auto` → `sourcing-web2.vercel.app`), `main` push 시 자동배포 확인됨.
**주의: GitHub→Vercel 웹훅이 가끔 유실된다(2026-08-13 실제로 겪음)** — 푸시했는데 사이트에 반영이 안 되면, 배포 목록에 그 커밋이 아예 없는지부터 확인. 없으면 `git commit --allow-empty` + push로 재트리거하면 됨(빌드 실패가 아니라 웹훅이 안 온 것이라 로그 볼 필요 없음).

### DB 마이그레이션
001~007 실행 완료 확인됨. **008(`root_name` 자동유지 트리거)은 실행 여부 미확인 — 세션 시작하면 제일 먼저 확인할 것.**

### 판매수수료 (내부 역공학 API 계산용)
카테고리별 실제 요율 사용 중, 전역 가정치(10.8%) 폴백 없음(`web/app.js`의 `commissionFor()`). 매칭 안 된 카테고리는 "수수료 정보 없음"으로 표시하고 마진 계산을 안 한다 — 의도된 동작.
**카테고리 매칭 작업할 때 필수 습관**: 외부 자료(WING 페이지 등)의 카테고리명을 절대 그대로 믿지 말고, 항상 실제 `categories.root_name`/`name`을 먼저 전수조회해서 대조할 것 — 안 그러면 조용히 대부분 안 맞는다(실제로 63% 안 맞을 뻔했음). 왜/어떻게는 `docs/decisions.md` 2026-08-13 항목과 `db/CLAUDE.md` 참조.

### 판매현황 탭 (쿠팡 공식 Open API, 로켓그로스)
내부 역공학 API와 완전히 별개 시스템. **GCP VPS(고정 IP) → Supabase → 웹** 구조로 실사용 검증 완료. 왜 이 구조인지(Vercel+프록시를 먼저 시도했다가 버린 이유 포함)는 `docs/decisions.md` 2026-08-13 항목, API 스펙은 `docs/api-notes.md` 4번 섹션. 수수료·입출고비는 API에 없어서 추정치(`feeFor()`+`calcMargin()` 재사용)만 가능 — 더 나은 API 없는지 다시 찾아볼 필요 없음, 이미 다 찾아봤음.

### 알려진 미해결
- `item_calc` 테이블 비어있음 → 마진율 정렬·필터 안 먹음(웹은 클라이언트 실시간 계산만 하고 `user_items`에만 저장).
- 이미지 CDN 주소(`thumbnail6.coupangcdn.com/...`) 미검증.
- `fulfillment_fees`에 전용할인가(`is_low_asp=true`) 행이 없는 카테고리는 "요금표 강제 재수집" 해야 채워짐(새로 수집하는 카테고리는 자동으로 둘 다 받음).

## 세션 운영 방식

**세션 시작 시**: 위 "지금 상태"에서 확인 안 된 항목(현재는 마이그레이션 008)부터 사용자에게 물을 것.

**작업하면서**: 코드만 봐서는 알 수 없는 이유·함정·거절한 대안이 생기면, **그때그때 맞는 파일에 바로 기록할 것** — 다 끝나고 몰아서 하지 말 것.
```
왜 이렇게 만들었는지 / 검토했다 버린 대안        → docs/decisions.md
에러·버그와 그 원인·해결 (재발 방지용)           → docs/troubleshooting.md
쿠팡 API 역공학·스펙 결과                        → docs/api-notes.md
스키마 설계 이유, 마이그레이션 관련               → db/CLAUDE.md
확장프로그램 전용 함정·데이터 흐름                → extension/CLAUDE.md
웹 계산 로직·알려진 미동작                        → web/CLAUDE.md
지금 이 파일의 "지금 상태"                        → 배포·마이그레이션 등 현재 사실 요약만, 서사는 위 파일들로
```
**세션 끝날 때(또는 배포했을 때)**: 위 표에 맞는 파일들을 실제로 갱신했는지 확인. 다음 대화가 완전히 새 세션이어도 코드 + 이 파일들만으로 지금까지의 맥락을 이해할 수 있어야 한다. 이미 해결됐거나 더는 의미 없는 내용은 남겨두지 말고 정리/삭제할 것 — 오래된 서사를 계속 누적하면 오히려 다음 세션이 읽기 힘들어진다.
