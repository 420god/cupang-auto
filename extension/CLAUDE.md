# extension/

크롬 확장프로그램. 카테고리 소싱 수집 + WING 내부 API 동기화.
**`chrome://extensions`에서 새로고침해야 반영된다** — git push와 무관.

## 절대 바꾸지 말 것

1. **`trends/search` 요청 바디를 직접 만들지 않는다** — `interceptor.js`가 캡처한 실제 요청을
   재사용한다. 직접 구성하면 반드시 실패한다(`context`가 `searchCondition` 안에 있어야 한다)
2. **조기 중단 조건을 완화하지 않는다** — `판매자:`만 있고 `배송사:`가 없어도 중단하지 않는다.
   로켓 배지가 뒤에 나올 수 있어서, 느슨하게 하면 배송유형이 오분류된다
3. **주입 함수(`page*`)에서 `throw`하지 않는다** — 크롬이 결과를 `null`로 만들어 에러가
   통째로 사라진다. 반드시 `{ok:false, error:'...'}`를 반환한다
4. **감으로 조정하지 않는다** — `RateGovernor` 4단계 임계값 · WING 동기화 "오늘+어제" 범위 ·
   재고현황 `pageSize`(10). 전부 이유가 있는 값이다

## 알아둘 것

- **`displayItemCategoryId`를 쓰면 안 된다** — 정답은 `displayItemCategoryCode`(정확히 1000 차이)
- 새 수집 필드를 추가하면 `supabase.js`의 `buildSupabasePayload()`와 마이그레이션을 **함께** 고친다
- WING API가 "Failed to fetch"를 뱉으면 **페이지 이동부터 시도하지 말고** `x-xsrf-token`부터 확인한다

## 상세

| 주제 | 문서 |
|---|---|
| WING API 스펙·함정 | `../docs/api/wing-internal.md` |
| 수집 파이프라인·ID 체계 | `../docs/domain/sourcing.md` |
| 판매현황 계산 | `../docs/domain/sales-profit.md` |
