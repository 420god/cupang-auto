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
  - **2026-08-13 커밋: 카테고리 수집 파이프라인을 즉시완결형으로 리팩터링.** 예전엔 전체 카테고리 목록(1단계) 다 모았다가 상세보강(2단계)·업로드를 마지막에 한 번에 처리 → 도중에 실패하면 그때까지 작업이 통째로 안 올라갈 위험이 있었음. 지금은 `finishCategoryPipeline()`(popup.js)로 통합해서 **카테고리 하나가 끝날 때마다 그 자리에서 상세보강→요금표확인→DB업로드까지 끝냄** — 수동 실행과 대기열(`processJob`)이 이 함수를 공유. 도중에 중단돼도 이미 끝난 카테고리는 안전.
  - 같은 커밋에 **Supabase 로그인 접속 유지** 추가: 20분마다 리프레시 토큰 자동 갱신(`startKeepAlive`), 갱신이 3번 연속 실패(리프레시 토큰 자체 만료)하면 크롬 알림으로 재로그인 요청(`notifyLoginExpired`) — `manifest.json`에 `notifications` 권한 추가됨.
- 웹사이트 **배포·실사용 확인됨** (2026-08-12). GitHub `420god/cupang-auto` 저장소가 **Vercel**과 연동돼(2026-08-13 확인, 플랫폼 재확인 불필요) `main` push 시 자동배포. Vercel이므로 `web/api/*.js`에 파일만 두면 별도 설정 없이 서버리스 함수로 동작한다 — secretKey처럼 브라우저에 노출하면 안 되는 값을 다룰 때 이 경로를 쓴다.
  최근 배포: `fcdef99` — 소싱 목록 배송 칸을 옵션 실제 배송유형(섞이면 전부) 표시로 변경 + 배송유형 필터 활성화(`004` 실행 완료) + 조회 최적화(정렬·검색 인덱스, 옵션 펼치기 병렬화, 카테고리 option 일괄 삽입, 스크롤 핸들러). 배경은 `docs/decisions.md` 2026-08-12 항목.
  - 그 전 배포 `0c37d9d` — 희망가/원가 자동저장 버그 2건 수정(DB 컬럼 한도 초과 시 400 반복 실패 → 클라이언트에서 차단, 여러 옵션 연달아 편집 시 앞 항목 저장이 조용히 취소되던 공유 디바운스 버그 → `debounceKeyed()`로 item_id별 분리).
  - 그 전 배포 `f383e53`: 입출고비 요금표 자동 수집(상세수집 직후, DB에 없는 카테고리만) + 저가 상품 전용 할인가(전용할인가) 반영. 이전엔 `loadFeeTables()`가 `is_low_asp=eq.false`로 하드코딩돼 전용할인가를 아예 안 읽었음 — 이제 14,000원 미만이면 전용할인가 우선, 없으면 일반 할인가로 폴백.
  - **`fulfillment_fees`에 전용할인가(`is_low_asp=true`) 행이 아직 하나도 없음(2026-08-12 확인).** 기존에 수집된 카테고리는 확장프로그램에서 "요금표 강제 재수집" 체크 후 다시 수집해야 전용할인가가 채워짐. 새로 수집하는 카테고리는 자동으로 둘 다 받음.
- `db/migrations/001~004` **모두 실행 완료**(2026-08-12 확인). 004 백필 후 상품 314개 중 54개가 `delivery_badges = {}`인데, 이건 그 옵션들이 **2단계(상세) 수집 전이라 `delivery_badge`가 NULL**이기 때문 — 정상이며 해당 카테고리를 상세수집하면 채워진다.
- **판매수수료 데이터 없음.** 전부 고정 10.8%로 계산 중. `docs/decisions.md` 참조.
- **`item_calc` 테이블 비어있음.** 웹은 마진을 클라이언트에서 실시간 계산만 하고 `user_items`에만 저장. 마진율 정렬/필터가 실제로는 안 먹는다.
- 이미지 CDN 주소(`thumbnail6.coupangcdn.com/...`) 미검증.
- **로켓그로스 Open API 연동 "판매현황" 탭 — 아키텍처 전환 후 재구현, 실사용 아직 미검증 (2026-08-13).** 내부 역공학 API(위 항목들)와는 별개로 쿠팡 공식 Open API(HMAC 인증)를 붙여 `web/`에 "판매량/매출/추정 수수료/추정 이익" 탭을 추가했다. 설계·조사 배경은 `docs/api-notes.md` "4. 로켓그로스 Open API" 섹션 참조. 자세한 삽질 이력은 [[project-coupang-rocket-growth-openapi]] 메모리에 더 자세히 있음.
  - **1차 시도(Vercel 서버리스 + 유료 고정IP 프록시)는 실패로 판명**: Vercel 함수(`web/api/sales-today.js`)는 고정 IP가 없어 쿠팡이 403으로 막음 → Webshare 프록시로 우회 시도했으나, 프록시 IP를 2개나 바꿔봐도 전부 쿠팡 WAF가 "Access denied" HTML로 차단(데이터센터 프록시 IP 자체가 대역 단위로 블랙리스트된 것으로 추정). 이 코드는 폴백용으로 지우지 않고 남겨둠(`PROXY_URL` 포함).
  - **2차 시도(현재, 커밋 `aa7e988`)로 전환**: 애초에 서버리스+프록시 구매가 아니라 "고정 IP 있는 서버 하나에서 직접 호출"이 정상적인 방식임을 확인 → **GCP `e2-micro` 무료 티어 VPS**(리전 `us-west1`, 외부IP `35.233.169.220`, 고정 IP로 예약 완료)를 만들어 거기서 직접 쿠팡을 호출하는 방식으로 변경. `scripts/rocket-growth-sync.js`가 그 서버에서 cron으로 돌면서 쿠팡 주문을 `rocket_growth_sales_daily`(`db/migrations/005`) 테이블에 upsert하고, `web/app.js`의 `loadSales()`는 이제 그 테이블만 읽는다(더는 브라우저/Vercel에서 쿠팡 API를 실시간 호출하지 않음).
  - 수수료·정산액은 API에 없어서 여전히 기존 10.8% 가정 수수료율 기반 추정치(`feeFor()`+`calcMargin()` 재사용).
  - **로컬 정적 서버로 새 코드 경로만 검증함(2026-08-13)**: `loadSales()`가 Supabase 테이블을 조회하도록 바뀐 게 정상 동작 확인 — 실제 계정으로는 `rocket_growth_sales_daily?...` 쿼리가 "테이블을 찾을 수 없음"으로 정상적으로(예상대로) 실패함, UI 크래시 없음.
  - **남은 것(전부 미완료)**: ① Supabase에 마이그레이션 005 아직 미실행 — SQL Editor에서 실행 필요. ② VPS에 Node 설치 + `scripts/` 배포(`npm install`) + `scripts/.env.example`을 `.env`로 복사해서 실제 값 채우기(`COUPANG_*`, `SB_ADMIN_EMAIL/PASSWORD`) + cron 등록 아직 안 함. ③ WING에 등록한 `35.233.169.220`의 반영(최대 24시간) 확인 안 됨. ④ 이 전체 파이프라인이 실제 데이터로 한 번도 안 돌아봄.

세션 시작 시 남은 미확인 항목(마이그레이션 실행 여부 등)부터 사용자에게 확인할 것.
변경사항을 배포까지 했다면 이 섹션(및 필요시 최근 커밋 요약)을 갱신해서 다음 대화가 이어받을 수 있게 할 것.
