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

---

## 8. 미해결 이슈

### 반드시 처리해야 할 것

**1. 판매수수료 데이터 없음**
- `categories.commission_rate`가 전부 null, 웹은 고정 **10.8%** 로 계산 중
- 사용자가 수수료 표 스크린샷 4장 제공했으나 **API가 없어 화면 파싱 필요**
- **카테고리 이름 체계가 다름**: 수집은 `가구/홈데코`, 수수료표는 `가구/홈인테리어` → 대분류 매핑표를 수동으로 만들어야 함(20개 남짓)
- 폴백 순서: 대+중+소 완전일치 → 대+중(소분류가 `-`) → 대분류 기본수수료 → 미매칭
- 사용자: "수수료는 일단 남겨두고 나중에 다시 말해줄게"

**2. `item_calc` 테이블이 비어 있음**
스키마만 있고 아무도 안 쓴다. 웹은 클라이언트에서 실시간 계산만 하고 `user_items`에만 저장.
→ **마진율 정렬·필터가 실제로 동작하지 않는다.** `v_product_list.best_margin_rate`도 항상 null.

**3. 웹 필터 일부 미동작**
- 배송유형: `products`에 해당 컬럼 없음(옵션 단위라서) → 쿼리에 미반영
- 마진율: 위 2번 때문

**4. 카테고리 통계 미갱신**
`product_count`, `item_count`가 0. `refresh_all_category_stats()`를 만들었으나 호출하는 곳이 없다.

**5. 이미지 CDN 주소 미검증**
`thumbnail6.coupangcdn.com/thumbnails/remote/{size}x{size}ex/image/{path}` 를 추정으로 넣었다. 확장프로그램에 검증 버튼이 있으나 결과 미확인. **틀리면 확장·웹 양쪽 다 이미지가 안 나온다.**

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