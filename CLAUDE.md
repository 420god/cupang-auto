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

## 지금 상태 (최신 요약, 자세한 건 docs/ 참조)

- 확장프로그램. DB 업로드·대기열 자동처리까지 구현됨. **`chrome://extensions`에서 새로고침해야 최신 코드가 반영됨** — git push와 무관.
- 웹사이트 **배포·실사용 확인됨** (2026-08-12). GitHub `420god/cupang-auto` 저장소가 Vercel/Netlify와 연동돼 `main` push 시 자동배포.
  - 작업중(미커밋): 소싱 목록 배송 칸을 옵션 실제 배송유형 전부 표시로 변경 + 배송유형 필터 활성화(`db/migrations/004_delivery_badges.sql` 필요) + 조회 최적화 몇 가지. 배경은 `docs/decisions.md` 2026-08-12 항목.
  - 그 전 배포 `0c37d9d` — 희망가/원가 자동저장 버그 2건 수정(DB 컬럼 한도 초과 시 400 반복 실패 → 클라이언트에서 차단, 여러 옵션 연달아 편집 시 앞 항목 저장이 조용히 취소되던 공유 디바운스 버그 → `debounceKeyed()`로 item_id별 분리).
  - 그 전 배포 `f383e53`: 입출고비 요금표 자동 수집(상세수집 직후, DB에 없는 카테고리만) + 저가 상품 전용 할인가(전용할인가) 반영. 이전엔 `loadFeeTables()`가 `is_low_asp=eq.false`로 하드코딩돼 전용할인가를 아예 안 읽었음 — 이제 14,000원 미만이면 전용할인가 우선, 없으면 일반 할인가로 폴백.
  - **`fulfillment_fees`에 전용할인가(`is_low_asp=true`) 행이 아직 하나도 없음(2026-08-12 확인).** 기존에 수집된 카테고리는 확장프로그램에서 "요금표 강제 재수집" 체크 후 다시 수집해야 전용할인가가 채워짐. 새로 수집하는 카테고리는 자동으로 둘 다 받음.
- `db/migrations/001~004` **모두 실행 완료**(2026-08-12 확인). 004 백필 후 상품 314개 중 54개가 `delivery_badges = {}`인데, 이건 그 옵션들이 **2단계(상세) 수집 전이라 `delivery_badge`가 NULL**이기 때문 — 정상이며 해당 카테고리를 상세수집하면 채워진다.
- **판매수수료 데이터 없음.** 전부 고정 10.8%로 계산 중. `docs/decisions.md` 참조.
- **`item_calc` 테이블 비어있음.** 웹은 마진을 클라이언트에서 실시간 계산만 하고 `user_items`에만 저장. 마진율 정렬/필터가 실제로는 안 먹는다.
- 이미지 CDN 주소(`thumbnail6.coupangcdn.com/...`) 미검증.

세션 시작 시 남은 미확인 항목(마이그레이션 실행 여부 등)부터 사용자에게 확인할 것.
변경사항을 배포까지 했다면 이 섹션(및 필요시 최근 커밋 요약)을 갱신해서 다음 대화가 이어받을 수 있게 할 것.
