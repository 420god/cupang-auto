# 소싱 탭

> **언제 읽나**: 소싱·카테고리 수집을 건드릴 때. 수수료 정보가 "없음"으로 뜰 때.
> **최종 검증**: 2026-08-17 (그 이후 이 영역은 안 건드림)
> **관련 코드**: `web/app.js` `commissionFor()`·`feeFor()`·`calcMargin()` · `extension/popup.js`

## 이 탭은 "남의 상품"을 조사하는 곳이다

`products` / `product_items`는 **카테고리 소싱으로 수집한 다른 판매자 상품 목록**이다.
**이 계정이 실제로 파는 상품과는 아무 관계가 없다** → D-09.
실제 판매 상품은 `my_skus` / `rocket_growth_product_registry` 쪽이다.

이 둘을 조인하려던 시도가 두 번 있었고 두 번 다 틀렸다(옵션ID 서브타이틀, 판매 원가).
**다시 시도하지 말 것.**

## 판매수수료

카테고리별 실제 요율만 쓴다. **전역 가정치(10.8%) 폴백은 의도적으로 없앴다.**
매칭 안 된 카테고리는 `commissionFor()`가 `null`을 반환하고, 화면은 "수수료 정보 없음"으로
표시하며 마진 계산을 아예 안 한다 — 의도된 동작이다.

**호출부 패턴**: `calcMargin()`을 부르기 전에 먼저 `null` 체크하고 "수수료 정보 없음"을 보여준다.
기존 4개 호출부가 이 패턴이니 새로 만들 때 그대로 따른다.

## 카테고리 매칭 작업 시 필수 습관

**외부 자료(WING 페이지 등)의 카테고리명을 절대 그대로 믿지 말 것.**
항상 실제 `categories.root_name`/`name`을 먼저 전수조회해서 대조한다 —
안 그러면 조용히 대부분 안 맞는다(실제로 63%가 안 맞을 뻔했다).

## 입출고비

`feeFor(catCode, size, price)`가 `state.feeCache`(메모리 캐시)에서 구간 조회한다.
요금표가 수천 행이라 **DB를 매번 조회하지 않는다** — 캐시가 필수다.

## `state.readyForMargins`에 새 로딩을 추가할 때

이 프로미스는 "마진 계산에 필요한 모든 상태가 준비됐다"는 신호다.
마진 계산이 참조하는 `state`의 어떤 부분이든 새로 채우는 로딩 함수를 추가하면 **여기에도 넣어야 한다.**

안 그러면 "로딩이 끝나기 전에 사용자가 너무 빨리 클릭"하는 경쟁 상태가 생기고,
소싱 목록과 옵션 펼치기 둘 다 **한 번 캐시하면 재계산을 안 하므로** 잘못된 "정보 없음"이
영구히 굳어버린다. 2026-08-13에 `loadCategoryOptions()`가 빠져서 이 버그가 두 군데서 났다.

## 알려진 미해결

- **마진율 필터·정렬이 안 먹는다** — `item_calc`가 비어 있어서다. `products.max_sales`처럼
  미리 계산해 저장해야 정렬이 가능한데, 지금은 옵션을 펼쳐야만 그때 계산된다
- `fulfillment_fees`에 전용할인가(`is_low_asp=true`) 행이 없는 카테고리는 "요금표 강제 재수집"이 필요

---

## 수집 파이프라인 (확장프로그램)

### ID/코드 헷갈리는 지점

```
productId       10자리   예: 9560229105
itemId          11자리   예: 22409716955
vendorItemId    11자리   예: 95555970302

displayItemCategoryCode  ← 검색 필터에 쓰는 정답 코드
displayItemCategoryId    ← 위와 정확히 1000 차이. 절대 이걸 쓰면 안 됨
categoryId (상품 응답)   = kanCategoryId (요금 API)   ← 같은 값, 다른 이름
```

### 데이터 흐름

```
collectedRows[]  1단계 결과 (runCategoryCollection)
detailsMap{}     2단계 결과 (runDetailCollection). key="{pid}_{iid}", 없으면 "{pid}" 폴백
  ↓ buildSupabasePayload(collectedRows, detailsMap, catUnitMap)   in extension/supabase.js
  ↓ 옵션을 상품 단위로 집계 (max_sales · sum_sales · rep_image_path 등)
{categories, products, items, history}  →  sbUpsert() 500행 청크
```

**새 필드를 수집에 추가하려면 `buildSupabasePayload`와 마이그레이션을 함께 고쳐야 한다.**
하나만 고치면 조용히 데이터가 빈다.

### `finishCategoryPipeline()` — 카테고리 하나를 끝까지

수동 실행과 대기열(`processJob`)이 **이 함수 하나를 공유한다.**
예전엔 전체 카테고리를 다 모았다가 마지막에 한 번에 업로드해서, 도중에 실패하면
그때까지 작업이 통째로 날아갔다.

```
1. 상세보강 (withDetail이면)
2. 입출고비 요금표 확인 (상세보강 성공 시)
3. buildSupabasePayload → sbUpsert
```

**카테고리 하나가 끝날 때마다 그 자리에서 끝까지 처리**하므로 중간에 중단돼도
이미 처리된 카테고리는 안전하다.

대기열은 30초 폴링이라 **팝업을 닫으면 안 된다** — "별도 창" 모드로만 쓴다.

### Supabase 접속 유지

`startKeepAlive`가 20분마다 리프레시 토큰을 미리 갱신한다.
3번 연속 실패하면 크롬 알림으로 재로그인을 요청한다(`manifest.json`의 `notifications` 권한이 이것 때문).
