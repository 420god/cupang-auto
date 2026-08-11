# web/ — 웹사이트

## 구조
```
index.html   로그인 + 4개 페이지(소싱/즐겨찾기/카테고리/대기열) + 설정 모달
style.css    CSS 변수 기반 라이트/다크 테마. --bg, --surface 등
app.js       전체 로직. 빌드 도구 없음, 그대로 배포
```

Vercel/Netlify에 **정적 파일 그대로** 올린다. 프레임워크·번들러 도입하지 말 것 — 사용자가 "복잡한 과정 없이"를 명시적으로 요구했다.

## 절대 바꾸지 말 것

1. **`user_items`/`item_calc`에 쓸 때 `on_conflict=user_id,item_id`를 빼지 말 것.** 빼면 사용자 간 데이터가 서로 덮어써진다 (RLS는 읽기만 막지, upsert 충돌 키는 별개).

2. **마진 계산은 `calcMargin()` 하나로 통일할 것.** 다른 곳에서 직접 계산식을 새로 쓰지 말고 이 함수를 재사용. 실제 청구서로 검증된 값(2,538원)과 어긋나면 잘못된 것.

3. **`recalcRow()`의 자동저장에 디바운스(`debounce`, 600ms)가 걸려 있다.** 제거하면 타이핑마다 API 호출이 나가 느려진다.

## 알아야 계산 가능한 것

```javascript
calcMargin({price, commission, fulfillment, costCny, rate, outbound, work})
// costCny가 null이면 margin/rate는 null, settlement만 반환됨
// = "원가 미입력" 상태를 화면에서 구분하는 근거
```

입출고비는 `feeFor(catCode, size, price)`가 `state.feeCache`(메모리 캐시, `loadFeeTables()`가 앱 시작 시 전체 로드)에서 구간 조회한다. **DB를 매번 조회하지 않는다** — 요금표가 수천 행이라 캐시가 필수.

## 알려진 미해결 (건드릴 때 참고)

- **배송유형 필터가 실제로는 안 먹는다.** `products` 테이블에 배송유형 컬럼이 없다(옵션 단위라서). `buildQuery()`에 `f.delivery` 처리가 빠져 있는 게 아니라 애초에 반영할 컬럼이 없다. 고치려면: (a) products에 대표 배송유형 컬럼 추가 + extension에서 채우기, 또는 (b) product_items를 조인하는 쿼리로 변경.
- **마진율 필터·정렬도 안 먹는다.** `item_calc` 테이블이 비어 있어서다. `products.max_sales`처럼 미리 계산해 저장해야 정렬이 가능한데, 지금은 옵션을 펼쳐야만(`loadOptions`) 그때 계산된다.
- 자세한 배경은 `../CLAUDE.md`의 "지금 상태" 및 `../docs/decisions.md` 참조.

## RLS 관련 주의

웹은 `sb.js`가 아니라 `app.js`의 `api()` 함수 하나로 모든 REST 호출을 감싼다. **관리자 전용 동작**(카테고리 삭제, 상품 강제 삭제 등)은 `AUTH.isAdmin` 체크를 UI에서 먼저 하더라도, **최종 방어는 DB의 RLS 정책**이라는 걸 잊지 말 것. UI에서 버튼만 숨기고 RLS 정책을 안 걸면 관리자가 아닌 사람도 API를 직접 호출해 삭제할 수 있다.

## 자세한 내용

- 표시 항목 우선순위, UI 선호: `../docs/decisions.md` 하단 "사용자 요구사항"
- 겪은 에러(#VALUE! 등): `../docs/troubleshooting.md`
