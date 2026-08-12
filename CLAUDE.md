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

- 확장프로그램 v12.0.0. DB 업로드·대기열 자동처리까지 구현됨.
- 웹사이트 **배포·실사용 확인됨** (2026-08-12). GitHub `420god/cupang-auto` 저장소가 Vercel/Netlify와 연동돼 `main` push 시 자동배포. 최근 배포: `1289d56` — 소싱 페이지 초기 로딩 속도 개선(초기화 병렬화, `apiAll` 병렬 페이지네이션, 카테고리 캐싱).
- `db/migrations/001~003` 모두 실행됐는지 **미확인** — 먼저 물어볼 것.
- **판매수수료 데이터 없음.** 전부 고정 10.8%로 계산 중. `docs/decisions.md` 참조.
- **`item_calc` 테이블 비어있음.** 웹은 마진을 클라이언트에서 실시간 계산만 하고 `user_items`에만 저장. 마진율 정렬/필터가 실제로는 안 먹는다.
- 이미지 CDN 주소(`thumbnail6.coupangcdn.com/...`) 미검증.

세션 시작 시 남은 미확인 항목(마이그레이션 실행 여부 등)부터 사용자에게 확인할 것.
변경사항을 배포까지 했다면 이 섹션(및 필요시 최근 커밋 요약)을 갱신해서 다음 대화가 이어받을 수 있게 할 것.
