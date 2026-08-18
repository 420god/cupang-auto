# 트러블슈팅 이력 + 미해결 이슈 + 주의사항

> 에러 원문 → 원인 → 해결. 시간순.

## 5. 트러블슈팅 이력 (시간순)

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | API 로그에 `mission-campaign`만 잡힘 | 로깅이 `fetch`만 후킹, XHR 누락 | XHR `open/setRequestHeader/send` 후킹 추가 |
| 2 | 인기상품검색 요청이 안 잡힘 (프레임 1개) | **해당 패널이 iframe** | manifest에 `all_frames:true`, `match_about_blank:true` → 프레임 604~640 잡힘 |
| 3 | `Cannot destructure property 'categoryCode' of 'result.result' as it is null` | 주입 함수에서 `throw`하면 크롬이 결과를 null로 만들어 에러가 사라짐 | 주입 함수는 절대 throw하지 않고 `{ok:false, error}` 반환 |
| 4 | `Unexpected end of JSON input` | 빈 응답에 `res.json()` 호출 | `res.text()`로 먼저 받고 빈값·파싱실패 구분 |
| 5 | 오류 없는데 0건 | `context`를 `searchCondition` 밖에 넣음 | 안쪽으로 이동 |
| 6 | `HTTP 400: Failed to read request` | 5의 연장. 바디를 계속 추측으로 구성 | **접근 전환** — interceptor 캡처 재사용 |
| 7 | 카테고리 `JSON 파싱 실패`, 크기 정확히 2000000 | `slice(0,2000000)`으로 잘려 JSON 깨짐 | 페이지 안에서 파싱 완료 후 결과만 반환 |
| 8 | 카테고리 113355 수집 0건 | **버그 아님.** 경로가 `ROOT>파페치>...` — 쿠팡이 인수한 명품 플랫폼이라 일반 통계 없음 | 부수 발견: 빈 검색어는 서버가 거부 → 요청 4회→1회 축소, "빠른 점검" 추가 |
| 9 | 상세 결과가 전부 "없는상품 Y" | **정상 페이지에도 "상품을 찾을 수 없습니다"가 숨겨진 템플릿으로 존재** | 판정 순서 역전 — 먼저 파싱, 데이터가 하나도 없을 때만 없는상품 |
| 10 | 판매량에 `</div` 조각이 섞임 | 태그 제거 후 `$`로 매칭하려다 실패 → 폴백으로 원문 60자 삽입 | HTML 원문에서 구간을 먼저 찾고 그다음 태그 제거 |
| 11 | `{v}` 템플릿이 잡힘 | i18n 템플릿 문자열 | `{v}` 포함 매치는 건너뛰고 다음 매치 탐색 |
| 12 | `ERROR: 42P17: generation expression is not immutable` | `recorded_date date generated always as (recorded_at::date)` — timestamptz→date는 타임존 의존 | 트리거 방식 + `default (now() at time zone 'Asia/Seoul')::date` |
| 13 | 엑셀 `#VALUE!` | IMAGE 함수 인자 순서 차이 | 프로그램 선택 드롭다운, 기본 양쪽호환 |
| 14 | 상위 N이 CSV에 미적용 | **버그 아님.** 원래 2단계 대상만 줄이는 옵션 | "CSV 출력에도 적용" 체크박스 추가 |
| 15 | 진행이 멈췄다 풀렸다 반복 | **정상.** 분당 상한(30/30)에 붙어 토큰 버킷이 60초 대기 | 상한을 올리도록 안내 |
| 16 | 웹 카테고리가 1개만 | 상품을 수집한 카테고리만 DB에 들어감 | "카테고리 전체 업로드" 버튼 추가 |
| 17 | 카테고리 삭제 실패 가능성 | `products.category_code` FK에 on delete 규칙 없음 | v3에서 `on delete cascade` 재생성 |
| 18 | 뷰가 없는 테이블 참조(자체 발견) | `v_category_status`가 `user_category_favorites`보다 먼저 정의됨 | 정의 순서 조정 |
| 19 | 카테고리별 수수료율 매핑했는데 "뷰티"도 수수료 정보 없음으로 뜸 | `categories.root_name`이 마이그레이션 002에서 **한 번만 백필**되고 자동 유지가 안 됨 — 그 이후 새로 수집된 카테고리는 `full_path`는 정상인데 `root_name`만 null로 남음(8,156개 중 2개, 하지만 이후 계속 늘어날 수 있는 구조적 문제) | `db/migrations/008`: `full_path` insert/update 시 `root_name`을 자동 재계산하는 트리거 추가(`delivery_badges`와 같은 패턴) + 기존 누락분 백필 |
| 20 | 소싱 목록을 페이지 열자마자 보면 마진이 "수수료 정보 없음"으로 뜨고 다시 안 고쳐짐 | `state.readyForMargins`가 `loadCategoryOptions()`를 안 기다림 — 카테고리별 수수료율이 `state.catUnits`에서 오게 되면서 이 경쟁 상태가 처음으로 드러남(예전엔 입출고비 조회만 이걸 썼고 실패해도 "요금표 없음"으로만 보였음) | `enterApp()`의 `state.readyForMargins = Promise.all([...])`에 `loadCategoryOptions()` 추가 |
| 21 | 옵션 펼치기도 20과 동일 증상 | `loadOptions()`도 `state.readyForMargins`를 안 기다림 | 네트워크 요청과 `state.readyForMargins`를 `Promise.all`로 같이 기다리도록 수정 |
| 22 | GitHub엔 푸시됐는데 Vercel 배포 목록에 그 커밋이 아예 안 뜸(빌드 실패도 아님) | GitHub→Vercel 웹훅 유실로 추정(재현 조건 불명) | `git commit --allow-empty` + push로 새 웹훅 발생시켜서 재배포 트리거 |
| 23 | WING 정산 위젯에서 8/14 하루만 봤을 때 값이 우리 사이트와 다름(8/14+8/15 합산된 것처럼 큼) | `pageFetchProfitStatus()`의 `recognitionDateTo`가 `dateStr T15:00Z`(=KST로 다음날 자정)라 다음날 데이터까지 같이 잡힘 — WING 서버가 두 타임스탬프를 KST 캘린더 날짜로 변환해 inclusive 범위로 처리하는 것으로 추정 | `recognitionDateTo`를 `recognitionDateFrom`과 동일값(`(dateStr-1)T15:00Z`)으로 통일 — WING 프론트가 하루 조회 시 실제로 이렇게 보내는 걸 캡처로 확인(`docs/api-notes.md` 4-4-5) |
| 24 | "정산 백필" 눌러도 특정 날짜가 계속 안 채워짐 | `syncProfitForDates()`가 하루 실패를 `console.warn`으로만 남기고 조용히 건너뜀 — 사용자가 개발자도구 없인 원인을 알 방법이 없었음 | 실패 목록(`{date,error}`)을 응답에 실어 백필 완료 메시지에 그대로 표시 |
| 25 | "상품 원가정보 갱신"을 눌러도 상품/옵션별 상세표가 계속 "수수료 정보 없음" | `loadItemCostSnapshots()`가 `captured_at <= 조회기간 끝날짜`로 필터링 — 스냅샷이 조회기간보다 나중에 찍혔으면(오늘 막 갱신했는데 어제만 조회) SQL 단계에서 스냅샷이 통째로 안 보여서 참고용 폴백(`snapshotAsOf()`)까지 같이 막힘 | 이 함수에서 날짜 필터 제거 — `snapshotAsOf()` 자체가 이미 "그 날짜 이전 우선, 없으면 가장 이른 것"을 알아서 고름 |
| 26 | 일별 상세표 08-15 매출(87,200)과 상품/옵션별 상세표 매출 합계가 안 맞음(12,900원 초과) | 당일 매입+반품으로 순매출이 정확히 0이 된 옵션은 WING `sold-vendor-item-list`에서 아예 빠지는데(0으로 안 찍히고 없음), 항목별 병합(`wing 있으면 wing, 없으면 gross`)이 그 옵션을 gross의 반품 미반영 옛날 값 그대로 남김 | `fetchSalesRange()`의 병합 단위를 항목별→날짜별로 변경 — 그 날짜에 wing 데이터가 하나라도 있으면 그 날짜는 wing만 쓰고 gross는 통째로 무시 |
| 27 | 오늘(08-16) 일별 상세표·상단 "오늘" 카드에서 판매수량은 맞는데(2개) 매출·수수료·입출고비·보관비·쿠폰비·광고비·밀크런·순이익이 전부 0/공백 — 상품/옵션별 상세표는 정상 | `syncProfitForDates()`가 WING `profit-status/search`의 "그 날짜 아직 미인식" 응답(HTTP 200, `profitAmount:0`이지만 필드는 다 있는 빈 응답 — 주로 당일 자정 직후 자동 동기화에서 발생)을 성공으로 오인해 `rocket_growth_profit_daily`에 전부 0인 행을 그대로 저장. `buildDailyRow()`가 이 행을 "확정"으로 믿어서 실제 판매(quantity)가 있는데도 매출 이하 전부 이 0값으로 덮어씀(라이브 DB 조회로 실제 0행 확인, 2026-08-16) | (1) `background.js`의 `syncProfitForDates()` — `totalSalesAmount`/`totalDeductionAmount`가 둘 다 0이면 저장 안 하고 실패(미인식)로 처리. (2) `web/app.js`의 `buildDailyRow()` — `confirmed` 행이 있어도 `total_sales_amount`/`total_deduction_amount`가 둘 다 0이면서 실제 판매수량(quantity)이 있으면 확정으로 안 믿고 옵션별 추정 폴백으로 전환(과거에 이미 저장된 빈 행에 대한 방어). 기존 0행 자체는 삭제하지 않았음(파괴적 DB 작업이라 미실행) — 웹 쪽 방어로 이미 정상 표시되고, 다음 실제 정산 인식 시 같은 `sale_date`로 upsert돼 자연히 덮어써짐 |
| 28 | VPS에서 `node rocket-growth-sync.js`(기존 30분 주문 동기화 포함 전체)가 `SyntaxError: Unexpected token '*'`로 실패 | 스크립트 맨 위 헤더 주석(`/* ... */`) 안에 cron 표기 예시를 리터럴로 `*/5 * * * *`라고 적어뒀는데, 이 안의 `*/`가 JS 블록 주석 종료 기호로 해석돼서 그 뒤(`5 * * * * node rocket-growth-sync.js...`)가 전부 실제 코드로 파싱됨 — 배포 직후 사용자가 VPS에서 실행하다가 바로 발견(2026-08-17) | 헤더 주석의 크론 예시를 리터럴 기호 대신 말로 풀어 씀. **앞으로 JS 파일 어디든 주석 안에 cron 표기(`*/N`)나 곱셈·정규식처럼 `*`와 `/`가 붙는 표현을 넣을 때는 항상 의심하고 `node --check`로 문법 검증할 것** — 이 프로젝트엔 로컬에 `node` 명령이 PATH에 없지만, `C:\Program Files\Adobe\Adobe Photoshop 2026\node.exe`가 실제 Node.js 바이너리라 `"그 경로\node.exe" --check 파일.js`로 문법만 검증 가능함(발견 2026-08-17) — 커밋 전에 이걸로 확인하는 습관을 들일 것 |
| 29 | 오늘(08-17) 실제 판매 0건인데 상단 "오늘"/"이번 주" 카드에 순수익 −6,470원이 "확정"으로 뜸. 사용자가 WING 정산현황 페이지를 보니 애초에 "오늘" 날짜 자체가 안 나온다(항상 D-1까지만) | #27에서 고친 "빈 응답(전부 0)만 걸러내기" 필터로는 부족했다 — WING `profit-status/search`가 오늘 날짜로 조회해도 **일부 필드는 0이 아닌 값을 줄 수 있다**(실측: `fulfillment_amount:6470`, `storage_amount:1282`, 매출 관련 필드는 0). 보관비 같은 항목은 판매 이벤트 없이도 창고 재고 기준으로 매일 누적되는 비용이라 이렇게 부분적으로 먼저 채워지는 것으로 추정 — 즉 "필드가 0이 아니다"가 "그날 정산이 최종 확정됐다"를 보장하지 않는다. WING 자신도 오늘 날짜는 화면에 아예 안 보여줌(D-1 경계) | `web/app.js`의 `buildDailyRow()` — 필드 내용과 무관하게 **`date`가 오늘(KST)이면 무조건 확정으로 안 믿는다**(`isToday = date === kstDateStr(new Date())`). WING 자신의 D-1 표시 경계와 원칙을 맞춘 것 — "전부 0인지" 같은 휴리스틱보다 훨씬 단순하고 확실함. 라이브 DB 조회로 실측 확인, 수정 후 "오늘"/"이번 주" 카드가 0원/0원으로 정상화됨 확인 |

---

## 8. 미해결 이슈

### 반드시 처리해야 할 것

**1. `item_calc` 테이블이 비어 있음**
스키마만 있고 아무도 안 쓴다. 웹은 클라이언트에서 실시간 계산만 하고 `user_items`에만 저장.
→ **마진율 정렬·필터가 실제로 동작하지 않는다.** `v_product_list.best_margin_rate`도 항상 null.

**2. 카테고리 통계 미갱신**
`product_count`, `item_count`가 0. `refresh_all_category_stats()`를 만들었으나 호출하는 곳이 없다.

**3. 이미지 CDN 주소 미검증**
`thumbnail6.coupangcdn.com/thumbnails/remote/{size}x{size}ex/image/{path}` 를 추정으로 넣었다. 확장프로그램에 검증 버튼이 있으나 결과 미확인. **틀리면 확장·웹 양쪽 다 이미지가 안 나온다.**

**4. 상품/옵션별 상세표 쿠폰비 필드 미검증(2026-08-16)**
개당 쿠폰비를 재고현황 응답의 `pricing.allMemberInstantDiscount + allMemberDownloadableDiscount`로 계산 중인데, 이게 WING 화면이 보여주는 "최종구매가" 기준과 정확히 일치하는지 실측 검증을 못 했다(같은 응답에 `creturnConfigViewDto.salePrice`라는 다른 후보 필드도 있음 — `docs/api-notes.md` 4-4-6). 사용자가 WING 화면과 대조해보고 다르면 알려주기로 함 — 다음 세션에서 피드백이 왔으면 필드를 바꿀 것.

### 해결됨 (여기 있던 이유만 남김)

- ~~판매수수료 데이터 없음~~ — 이 표에서 예전에 예측했던 그대로 **카테고리 이름 체계가 정말 달랐다**(수집은 `가구/홈데코`, 수수료표는 `가구/홈인테리어` 등 6개 대분류). 2026-08-13 `db/migrations/006~008`로 해결. 자세한 매칭 과정·함정은 `docs/decisions.md` 2026-08-13 항목.
- ~~웹 배송유형 필터 미동작~~ — `004`로 해결(`products.delivery_badges`).

### 보류
- 완전 자동 수집(서버가 쿠팡 로그인) — 보안·차단·2FA
- IP 로테이션 / Node.js 이전 — 10만 건 넘으면 검토
- 90일 이후 이력 주 단위 압축 — 구조만 잡음
- 정밀 VAT 계산 — "다른 페이지"로
- Next.js 전환, 커스텀 도메인
- 옵션별 판매량 교차검증(사용자는 다르다고 했으나 데이터로 확인 안 함)

---

## 9. 주의사항 — 절대 하지 말 것

1. **`service_role`/`secret` 키를 코드에 넣지 말 것.** 대화 중 사용자가 실수로 노출해 폐기 권고했다. 확장프로그램 UI에 secret 키 거부 검사가 있으니 제거하지 말 것.
2. **요청 템플릿 구조를 추측으로 만들지 말 것.** interceptor 캡처 재사용 방식을 유지.
3. **`context`를 `searchCondition` 밖으로 빼지 말 것.**
4. **`query`를 빈 문자열로 보내지 말 것.**
5. **조기 중단 조건을 완화하지 말 것.** 특히 `판매자:`만 보고 중단하면 오분류된다.
6. **`unique index (item_id, recorded_date)`를 지우지 말 것.** 같은 날 중복 방지의 유일한 장치.
7. **`recorded_date`를 generated 컬럼으로 되돌리지 말 것.** `42P17` 재발.
8. **`user_items`/`item_calc`의 복합키를 단일키로 바꾸지 말 것.** 멀티유저가 깨진다.
9. **`rocket_growth_sales_daily`(Open API)와 `rocket_growth_sales_wing_daily`(WING)를 항목별로 병합하지 말 것.** 날짜별로 "그 날짜에 wing이 있으면 wing만" 써야 한다(트러블슈팅 26번). 항목별 병합으로 되돌리면 당일 매입+반품 net-zero 항목이 이중 계상된다.
10. **`rocket_growth_item_cost_snapshots`를 덮어쓰지(upsert) 말 것 — 항상 insert로 쌓을 것.** 가격 변경 전/후 요율을 구분해야 하는 게 이 테이블의 존재 이유다(`web/CLAUDE.md`). `loadItemCostSnapshots()`에 날짜 필터를 다시 추가하지도 말 것(트러블슈팅 25번).

### 헷갈리기 쉬운 것
- ID 자릿수(내부 역공학 API, 소싱 탭 기준): productId **10자리**, itemId·vendorItemId **11자리**. **주의: 이건 소비자 상품페이지 스크래핑(`docs/api-notes.md` 2-5) 문맥의 값이고, 로켓그로스 공식 Open API(4-7)의 sellerProductId·productId·vendorItemId·itemId와 자릿수가 다시 검증된 적은 없다** — 4-7에서 실측한 값은 sellerProductId/sellerProductItemId/vendorItemId=11자리, itemId=10자리. 두 체계를 섞어서 "productId는 항상 10자리"처럼 단정하지 말 것, 필요하면 그때그때 실측할 것.
- 카테고리 코드: `displayItemCategoryCode`(정답) vs `displayItemCategoryId`(1000 차이)
- `has_rocket`은 true/false 요약. 실제 유형은 `product_items.delivery_badge`
- `pvLast28dRank`, `lowerPvLast28d`는 **상품 단위**(같은 상품의 옵션끼리 동일)
- **background script가 없다.** 팝업이 닫히면 수집이 멈춘다 → "별도 창으로 열기" 안내
- 카테고리 상태 판정은 **KST 기준.** UTC면 오전 9시에 날짜가 바뀐다
- **WING의 "정산 인식"은 D-1 지연 이후로도 계속 갱신된다.** 확정 정산이 있는 날짜라도 값이 시간이 지나며 계속 바뀔 수 있다(실측: 2026-08-15 하루치가 몇 시간 사이 47,719원→58,293원으로 변함). 스크린샷과 실시간 화면을 비교할 땐 같은 시점에 캡처했는지 확인할 것.

---
### rocket-growth-sync.js 실행 시 "환경변수 누락: COUPANG_ACCESS_KEY, ..." 7개 전부 (2026-08-18)

**증상**: VPS에서 저장소 루트로 이동한 뒤 `node scripts/rocket-growth-sync.js ...`로 실행했더니
환경변수 7개가 **전부** 누락됐다고 나오며 즉시 종료.

**원인**: `dotenv`는 기본적으로 **실행한 위치(cwd)**의 `.env`를 읽는데, 이 프로젝트의 `.env`는
`scripts/.env`에 있다. 저장소 루트에서 실행하면 루트의 `.env`(없음)를 찾다가 아무것도 못 읽는다.
기존 크론은 `scripts`로 `cd`한 뒤 실행하고 있어서 지금까지 드러나지 않았다.
"일부만 누락"이 아니라 **7개가 한꺼번에 누락**되면 키를 잘못 적은 게 아니라 `.env` 자체를 못 읽은 것이다.

**해결**: `require('dotenv').config({ path: path.join(__dirname, '.env') })`로 바꿔서 실행 위치와
무관하게 항상 `scripts/.env`를 읽게 했다. 같은 이유로 `--skus`가 남기는 응답 샘플 파일도
`__dirname` 기준으로 쓴다(루트에서 실행했다면 `scripts/scripts/...`에 쓰려다 실패했을 것).

### --products가 "상품 32건 조회됨 / upsert 대상 0행" — 레지스트리가 계속 비어 있었다 (2026-08-18)

**증상**: `rocket_growth_product_registry`가 비어 있어서 `--skus`가 "레지스트리 0행"으로 아무것도 안 했다.
`--products`를 직접 돌려보니 상품 조회는 32건 되는데 upsert 대상이 0행. 크론은 정상이었다
(두 줄 다 `cd .../scripts` 후 실행이라 `.env`도 잘 읽힘). 즉 **매일 새벽 3시에 돌면서 매번 0행을 넣고
조용히 성공한 척** 하고 있었다 — `upsertProductRegistry()`가 `if (!rows.length) return;`이라 에러도 안 난다.

**원인**: `flattenProductRegistry()`가 `it.rocketGrowthItem` / `it.marketPlaceItem`을 찾는데,
실제 응답 필드명은 **`rocketGrowthItemData` / `marketPlaceItemData`**였다. `docs/api-notes.md` 4-7 ①에
2026-08-17에 이름을 틀리게 적어뒀고 코드가 그걸 그대로 따랐다. 실제 응답을 저장해본 적이 없어서
1년 가까이(만든 뒤 계속) 아무도 몰랐다.

**해결**: 필드명 수정(옛 이름도 폴백으로 남김) + `sellerProductItemId`를 `rg` 안쪽에서 읽도록 수정.

**재발 방지 — 여기서 배운 것**:
1. `--products` 실행 시 **첫 페이지 첫 상품을 `scripts/_sample_seller_product.json`에 항상 덤프**한다.
   응답 구조를 눈으로 볼 수 있으면 이 종류의 버그는 1분이면 잡힌다.
2. **"조회 N건 → 저장 0행"을 조용히 넘기지 말 것.** 버려진 개수를 경고로 출력하게 했다
   ("API가 안 준 것"인지 "우리가 못 읽은 것"인지 구분이 안 되는 게 이 버그의 본질이었다).
3. **문서에 적힌 API 필드명을 믿고 코드를 짜지 말 것** — 실제 응답을 한 번은 저장해서 대조할 것.
   이 프로젝트의 카테고리 매칭에서 배운 "외부 자료를 그대로 믿지 말 것"과 같은 교훈이다.

### 청구서 PDF 인식이 엉망 — pdf-parse 기본 추출기가 칸 사이 공백을 버린다 (2026-08-18)

**증상**: 발주 탭에서 청구서 PDF를 넣었더니 상품명이 `비슷 왁뿌 세알2069.8129.868128`,
수량이 `14,196.4` 같은 값으로 나왔다. 환율 역산도 실패.

**원인**: `pdf-parse`의 **기본 텍스트 추출기가 칸 사이 공백을 버린다.**
`계란 비슷 왁뿌 세알 20 6 9.8 129.8 6 8 128`이 `세알2069.8129.868128`로 붙어서 나왔다.
파서 문제가 아니라 추출 문제였다 — 같은 PDF를 pypdf로 뽑으면 공백이 멀쩡하다.
즉 **PDF 안에는 정보가 다 있다.**

**해결**: `pdf-parse`의 `pagerender` 훅으로 **좌표 기반 추출**을 직접 구현했다
(`web/api/parse-invoice.js`의 `renderPageByPosition()`). pdfjs가 주는 조각별 x/y/폭을 써서
y가 비슷하면 같은 줄로 묶고, x 순으로 정렬한 뒤, 앞 조각이 끝난 x와 다음 조각의 x가
벌어져 있으면 공백을 넣는다. **무조건 공백으로 잇지 않는 이유**: 한글은 한 단어가 여러
조각으로 쪼개져 와서 그러면 "계 란 비 슷"이 된다. 새 의존성은 안 늘렸다 —
pdf-parse가 내부적으로 쓰는 pdfjs를 그대로 쓴다. 실패하면 기본 추출로 폴백한다.

**재발 방지 — 진짜 문제는 "조용히 틀린 것"이었다**:
1. 확인 화면에 **"인식된 원문 보기"**를 넣었다. 인식이 이상할 때 원인을 눈으로 볼 수 있는
   유일한 창구다. 어떤 추출기가 쓰였는지도 같이 표시한다.
2. **숫자 구조 검사**를 경고로 띄운다. 한 줄의 숫자는 7개(그룹 머리)·3개(구성원)·1개 중
   하나여야 하고, **수량은 반드시 양의 정수**여야 한다. 위 사고에서 수량이 `14196.4`로
   나왔는데도 화면엔 아무 경고가 없었고 사용자가 눈으로 보고서야 알았다.

**교훈**: PDF 텍스트 추출기는 라이브러리마다 결과가 다르다. 한 라이브러리에서 되는 걸 보고
다른 데서도 되리라 가정하지 말 것 — 이 프로젝트는 pypdf로 확인하고 pdf-parse로 배포했다가 당했다.
