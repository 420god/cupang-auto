# web/ — 웹사이트

## 구조
```
index.html   로그인 + 5개 페이지(소싱/판매현황/즐겨찾기/카테고리/대기열) + 설정 모달
style.css    CSS 변수 기반 라이트/다크 테마. --bg, --surface 등
app.js       전체 로직. 빌드 도구 없음, 그대로 배포
api/         Vercel 서버리스 함수 자리(현재 sales-today.js 하나, 안 씀 — 아래 참조)
package.json api/용 npm 의존성(undici) — 프론트엔드는 여전히 완전 무의존
```

Vercel에 **정적 파일 그대로** 올린다(플랫폼 확정, `../CLAUDE.md` 참조). 프레임워크·번들러 도입하지 말 것 — 사용자가 "복잡한 과정 없이"를 명시적으로 요구했다. `api/*.js`는 예외 — Vercel이 번들러 없이 그대로 서버리스 함수로 인식하는 기능이라 이 원칙과 안 부딪힌다.

**판매현황 탭은 다른 탭들과 데이터 소스·계산 시점이 완전히 다르다** — 소싱/즐겨찾기/카테고리는 웹이 실시간으로 계산하지만, 판매현황(`loadSales()`/`fetchAndRenderSales()`)은 두 테이블을 읽기만 한다. `web/api/sales-today.js`는 그 이전 시도의 잔재로 지금은 아무것도 안 부른다 — 왜 이렇게 됐는지는 `../docs/decisions.md` 2026-08-13 항목.

**판매현황은 테이블이 두 개다(2026-08-15 추가) — 왜 안 합쳤는지 알아둘 것**:
- `rocket_growth_sales_daily`: 공식 Open API 기반, GCP VPS가 무인 cron으로 채움. 항상 최신이지만 **반품이 반영 안 됨**(`docs/api-notes.md` 4-4-1).
- `rocket_growth_sales_wing_daily`: WING 내부 API 기반(로그인 세션 필요), **반품이 순액으로 반영됨**(4-4-2). 세션이 필요해서 무인 cron이 못 채우고, `extension/background.js`가 웹의 메시지 요청을 받아서 채운다.

두 테이블에 같은 `(sale_date, vendor_item_id)` 행이 있으면 `fetchAndRenderSales()`가 **wing 값을 우선**하고, wing 쪽에 없으면 daily(gross) 값으로 폴백한다 — 한 테이블로 합치지 않은 이유는 서로 다른 스크립트(무인 VPS cron vs. 사용자 브라우저의 확장프로그램)가 같은 컬럼에 동시에 쓰다가 경쟁하는 걸 피하기 위함(`db/CLAUDE.md`가 이미 이 원칙을 씀).

**`loadSales()`가 `syncSalesViaExtension()`을 매번 호출한다** — `chrome.runtime.sendMessage(SALES_EXT_ID, ...)`로 브라우저 확장프로그램(설치돼 있고 WING에 로그인돼 있다면)에게 "오늘+어제" 반품 데이터를 다시 동기화해달라고 요청한다. 확장프로그램이 없거나 응답이 없어도(일반 방문자, 다른 브라우저 등) 타임아웃 후 조용히 기존 방식으로 넘어간다 — **이 호출이 실패해도 판매현황 자체는 항상 정상 동작해야 한다**, 이 전제를 깨는 수정을 하지 말 것. `SALES_EXT_ID`는 확장프로그램의 크롬 ID(`chrome://extensions`에서 확인)라서 확장프로그램을 다른 폴더로 옮기거나 웹스토어에 정식 배포하면 바뀔 수 있음 — 그러면 이 상수도 같이 갱신해야 함.

## 절대 바꾸지 말 것

1. **`user_items`/`item_calc`에 쓸 때 `on_conflict=user_id,item_id`를 빼지 말 것.** 빼면 사용자 간 데이터가 서로 덮어써진다 (RLS는 읽기만 막지, upsert 충돌 키는 별개).

2. **마진 계산은 `calcMargin()` 하나로 통일할 것.** 다른 곳에서 직접 계산식을 새로 쓰지 말고 이 함수를 재사용. 실제 청구서로 검증된 값(2,538원)과 어긋나면 잘못된 것.

3. **`recalcRow()`의 자동저장에 디바운스(`debounce`, 600ms)가 걸려 있다.** 제거하면 타이핑마다 API 호출이 나가 느려진다.

## 알아야 계산 가능한 것

```javascript
calcMargin({price, commission, fulfillment, costCny, rate, outbound, work})
// commission이 null이면 통째로 null 반환(계산 자체를 안 함) — "수수료 정보 없음"
// costCny가 null이면 margin/rate는 null, settlement까지는 반환됨 — "원가 입력 필요"
// 이 둘은 화면에서 서로 다른 문구로 구분해서 보여준다. 섞어서 하나로 뭉치지 말 것.
```

**전역 기본 수수료율은 없다(2026-08-13 이후).** `commission`은 항상 `commissionFor(catCode)`(카테고리별 실제 요율, `state.catUnits[catCode].commission`)로 구해서 넘긴다 — `settings.commission` 같은 전역 폴백은 의도적으로 없앴다. 매칭 안 된 카테고리는 `commissionFor()`가 null을 반환하니, 호출부에서 `calcMargin()`을 부르기 전에 먼저 null 체크하고 "수수료 정보 없음"을 보여줄 것(소싱 옵션표/판매현황 표의 기존 4개 호출부가 이 패턴이다 — 새로 만들 때 그대로 따라할 것).

입출고비는 `feeFor(catCode, size, price)`가 `state.feeCache`(메모리 캐시, `loadFeeTables()`가 앱 시작 시 전체 로드)에서 구간 조회한다. **DB를 매번 조회하지 않는다** — 요금표가 수천 행이라 캐시가 필수.

**`state.readyForMargins`에 새 비동기 로딩을 추가할 때 반드시 챙길 것** — 이 프로미스는 "마진 계산에 필요한 모든 상태가 준비됐다"는 신호다(`enterApp()`에서 `Promise.all([loadSettings(), loadFeeTables(), loadCategoryOptions()])`). 마진 계산이 참조하는 `state`의 어떤 부분이든(예: `state.catUnits`) 새로 채우는 로딩 함수를 추가하면 **여기에도 같이 넣어야 한다** — 안 그러면 "카테고리 로딩이 끝나기 전에 사용자가 너무 빨리 클릭"하는 경쟁 상태가 생기고, 소싱 목록(`loadRowMargins`)과 옵션 펼치기(`loadOptions`) 둘 다 이 프로미스만 기다리고 결과를 **한 번 캐시하면 다시 재계산 안 하므로** 잘못된 "정보 없음" 상태가 영구히 굳어버린다. 실제로 2026-08-13에 `loadCategoryOptions()`가 빠져서 이 버그가 두 군데서 났었다.

## 알려진 미해결 (건드릴 때 참고)

- ~~배송유형 필터가 안 먹는다~~ → **해결(004).** `products.delivery_badges` 배열을 DB 트리거가 채우고, `buildQuery()`가 `delivery_badges=cs.{"유형"}`으로 거른다. 목록의 배송 칸도 `deliveryCell()`이 그 배열을 전부 보여준다(옵션에 판매자배송·판매자로켓이 섞여 있으면 둘 다 표시). **`state.hasDeliveryCol`은 004 미실행 DB에서 400을 한 번 받고 예전 `has_rocket` 표시로 되돌리기 위한 것** — 004가 확실히 실행됐다면 지워도 되지만, 남겨두면 배포 순서가 어긋나도 목록이 안 깨진다.
- **마진율 필터·정렬도 안 먹는다.** `item_calc` 테이블이 비어 있어서다. `products.max_sales`처럼 미리 계산해 저장해야 정렬이 가능한데, 지금은 옵션을 펼쳐야만(`loadOptions`) 그때 계산된다.
- 자세한 배경은 `../CLAUDE.md`의 "지금 상태" 및 `../docs/decisions.md` 참조.

## RLS 관련 주의

웹은 `sb.js`가 아니라 `app.js`의 `api()` 함수 하나로 모든 REST 호출을 감싼다. **관리자 전용 동작**(카테고리 삭제, 상품 강제 삭제 등)은 `AUTH.isAdmin` 체크를 UI에서 먼저 하더라도, **최종 방어는 DB의 RLS 정책**이라는 걸 잊지 말 것. UI에서 버튼만 숨기고 RLS 정책을 안 걸면 관리자가 아닌 사람도 API를 직접 호출해 삭제할 수 있다.

## 자세한 내용

- 표시 항목 우선순위, UI 선호: `../docs/decisions.md` 하단 "사용자 요구사항"
- 겪은 에러(#VALUE! 등): `../docs/troubleshooting.md`
