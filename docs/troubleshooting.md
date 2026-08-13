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

### 헷갈리기 쉬운 것
- ID 자릿수: productId **10자리**, itemId·vendorItemId **11자리**
- 카테고리 코드: `displayItemCategoryCode`(정답) vs `displayItemCategoryId`(1000 차이)
- `has_rocket`은 true/false 요약. 실제 유형은 `product_items.delivery_badge`
- `pvLast28dRank`, `lowerPvLast28d`는 **상품 단위**(같은 상품의 옵션끼리 동일)
- **background script가 없다.** 팝업이 닫히면 수집이 멈춘다 → "별도 창으로 열기" 안내
- 카테고리 상태 판정은 **KST 기준.** UTC면 오전 9시에 날짜가 바뀐다

---