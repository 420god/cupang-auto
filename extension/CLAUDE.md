# extension/ — 크롬 확장프로그램

## 구조
```
manifest.json    MV3. content_scripts에 interceptor.js를 MAIN world, all_frames:true로 주입
interceptor.js   fetch/XHR 후킹, 쿠팡 API 요청·응답을 sessionStorage에 캡처
background.js    서비스워커(2026-08-15 추가). externally_connectable로 웹의 요청을 받아
                 WING 세션으로 반품 포함 판매현황을 동기화. 아래 섹션 참조
popup.html       UI. <details>로 접어서 핵심만 노출 (사용자 선호)
popup.js         전체 로직 (4200여 줄)
supabase.js       Supabase 인증·REST·데이터 변환. popup.html에서 popup.js보다 먼저 로드됨.
                 background.js도 importScripts()로 이 파일을 그대로 재사용함(인증 로직 중복 금지)
```

**팝업 쪽(popup.js)엔 여전히 background script가 없다.** 팝업이 닫히면 popup.js 쪽 작업(수집·대기열 폴링 등)은 모두 멈춘다 — "별도 창으로 열기"(`chrome.windows.create`)가 이걸 우회하는 유일한 방법이니 건드릴 때 주의. **다만 `background.js`(서비스워커)는 별개로 상시 존재**하며, 웹이 메시지를 보낼 때만 깨어나 동작한다(팝업 상태와 무관) — 아래 "판매현황/반품 동기화" 섹션 참조.

## 절대 바꾸지 말 것

1. **`trends/search` 요청 바디를 직접 만들지 말 것.** `interceptor.js`가 캡처한 실제 요청을 `popup.js`의 `pageCollectCategory`/`pageFetchProductDetail`이 재사용한다. 바디를 직접 구성하면 반드시 실패한다 — `context`가 `searchCondition` 안에 있어야 하고, `query`에 카테고리 이름이 들어가야 한다. 이유는 `docs/api-notes.md` 참조.

2. **조기 중단(early stop) 조건을 완화하지 말 것.** `pageFetchProductDetail`의 스트리밍 로직에서 `판매자:`만 있고 `배송사:`가 없으면 중단하지 않는다 — 로켓 배지가 뒤에 나올 수 있어서다. 조건을 느슨하게 하면 배송유형이 오분류된다.

3. **주입 함수(`page*`로 시작하는 함수)에서 `throw`하지 말 것.** `chrome.scripting.executeScript`로 실행되는 함수가 throw하면 크롬이 결과를 `null`로 만들어 에러 메시지가 통째로 사라진다. 반드시 `{ok:false, error:'...'}` 객체를 반환할 것.

4. **`RateGovernor` 클래스의 4단계 임계값을 감으로 조정하지 말 것.** `docs/decisions.md`에 왜 그 숫자인지(분당 1000이 왜 위험한지 포함) 적혀 있다.

## ID/코드 헷갈리는 지점

```
productId       10자리   예: 9560229105
itemId          11자리   예: 22409716955
vendorItemId    11자리   예: 95555970302

displayItemCategoryCode  ← 검색 필터에 쓰는 정답 코드
displayItemCategoryId    ← 위와 정확히 1000 차이. 절대 이걸 쓰면 안 됨
categoryId (상품 응답의)  = kanCategoryId (요금 API의)  ← 같은 값, 다른 이름
```

## 판매현황/반품 동기화 (`background.js`, 2026-08-15)

**진단용 캡처(`interceptor.js`의 `SALES_PATHS`/`saveSalesCapture`, 팝업 "판매현황 API 캡처 보기")는 그대로 남아있다** — WING 내부 판매현황/정산 API의 정확한 요청/응답 구조(요청 **헤더**까지, 2026-08-15에 추가함 — 아래 XSRF 함정을 이걸로 찾았다)를 처음 알아낼 때 썼고, 앞으로 이 API들이 바뀌었는지 다시 확인할 때도 쓸 수 있어서 지우지 않았다. 새 WING 내부 API를 조사할 땐 **먼저 이 캡처로 요청 헤더까지 확인할 것** — 응답/바디만 보고 재구현하면 인증 헤더를 놓친다(바로 아래 함정 참조). 하지만 **실제 자동 동기화는 이걸 안 쓰고 `background.js`가 직접 담당**한다(수동 캡처 → 확인 → 나중에 붙이는 방식이 아니라, 능동적으로 API를 호출하는 방식).

```
웹의 판매현황 탭 (loadSales())
  → chrome.runtime.sendMessage(SALES_EXT_ID, {type:'SYNC_SALES', dateFrom, dateTo})
  → background.js의 onMessageExternal 리스너가 깨어남
     1. WING 탭 찾기, 없으면 새로 열기(getOrOpenWingTab)
     2. syncSalesForDates: 날짜별로(범위를 통째로 넣으면 합산되어버리므로 하루씩,
        docs/api-notes.md 4-4-2 실측 확인) executeScript로 그 탭 안에서
        sold-vendor-item-list 호출 → rocket_growth_sales_wing_daily에 upsert
     3. syncProfitForDates: 같은 방식으로 하루씩 profit-status/search 호출
        (x-xsrf-token 헤더 필수, 아래 함정 참조) → rocket_growth_profit_daily에 upsert
        — 정산이 실패해도(정산 미확정 등) 판매 결과는 그대로 반환(전체를 막지 않음)
     4. 로그인 안 돼 있으면(JSON 아닌 응답) notLoggedIn 에러로 즉시 전체 실패 반환
  → 웹에 {ok, days, rowCount, profitRowCount} 응답
```

**함정 — 세션 쿠키만으론 부족하고 `x-xsrf-token` 헤더가 따로 필요한 API가 있다(`profit-status/search`, 2026-08-15에 겪고 해결).** 처음엔 그냥 "Failed to fetch"만 보여서 페이지별 CSP 문제로 오인했다 — `https://wing.coupang.com/tenants/rfm/settlements/home` 페이지로 먼저 이동시키는 우회, 백그라운드에서 `credentials:'include'`로 직접 fetch하는 우회 둘 다 시도했지만 소용없었다(그 둘의 흔적이 커밋 히스토리에 남아있을 수 있는데, 최종적으로는 둘 다 필요 없었다). **진짜 원인은 콘솔에 별도로 뜨는 CORS 에러 메시지**(`Access to fetch at 'https://helpseller.coupang.com/access/logout' (redirected from ...) ... blocked by CORS policy`)에만 있었고, 우리 코드가 잡는 `catch(e)`에는 그냥 "Failed to fetch"로만 보였다 — **콘솔 원문을 반드시 같이 볼 것, 우리 쪽 에러 메시지만 보고 판단하지 말 것.** 해결은 `pageFetchProfitStatus()`처럼 쿠키 `XSRF-TOKEN` 값을 `document.cookie`로 읽어서 `x-xsrf-token` 헤더로 그대로 실어 보내는 것 — 쿠키는 페이지 컨텍스트에서만 읽히므로 `chrome.scripting.executeScript`로 페이지 안에서 호출해야 한다(백그라운드 직접 fetch로는 이 쿠키에 못 닿는다). **페이지 이동은 불필요했다** — 인증 헤더만 맞으면 WING 탭이 어느 페이지에 있든 호출된다. **다른 WING 내부 API에서 "Failed to fetch"를 만나면 페이지 이동부터 시도하지 말고, 이 패턴(헤더 캡처 → XSRF 토큰 확인)부터 확인할 것.**

**기본 동기화 범위는 "오늘+어제" 이틀 고정이다** — `rocket-growth-sync.js`와 같은 이유(자정 근처 타임존 오차, `docs/api-notes.md` 4-1)이자, 판매현황 탭을 열 때마다 매번 30일치를 다 훑으면 느리고 WING에 부담이라 일부러 좁혀둔 것. **이 기본값 자체는 바꾸지 말 것.**

**수동 백필(2026-08-15 구현 완료)** — 이 자동 범위보다 과거 날짜(예: 이번 달 1일부터)까지 확정 정산·반품을 채우고 싶을 때 쓴다. `background.js`를 따로 건드릴 필요 없이(`onMessageExternal`의 `SYNC_SALES`가 원래부터 `dateFrom`/`dateTo`를 임의로 받아 최대 `MAX_DAYS`(31일)까지 처리한다 — 자동 동기화 쪽(`web/app.js`의 `syncSalesViaExtension()`)만 "오늘+어제"로 일부러 좁혀 보내고 있었을 뿐), 웹의 판매현황 탭 하단 "정산 백필" 버튼(`web/app.js`의 `backfillSales()`)이 그 자리에서 사용자가 고른 조회 기간(`salesFrom`~`salesTo`)을 그대로 같은 메시지로 보낸다. **왜 필요했는지**: 상단 고정기간 카드(이번 달 등)가 확정 정산 없는 과거 날짜를 카테고리 요율 추정으로 메꾸는데, 상품 카테고리 매칭이 안 된 계정은 그 추정이 사실상 0으로 깔려서 WING 실제 위젯과 크게 어긋나는 게 실사용 중 발견됨(`web/CLAUDE.md` 참조) — 과거 날짜까지 확정값을 실제로 채워 넣는 게 근본적인 해결책이라 이 기능을 만들었다.

**하루 단위 실패는 조용히 건너뛰므로, 실패 목록을 응답에 실어서 화면에 보여준다(2026-08-15 추가)** — `syncSalesForDates()`/`syncProfitForDates()`가 각각 `{rowCount, failed:[{date,error}]}`를 반환하고, `syncSales()`가 이걸 `salesFailed`/`profitFailed`로 묶어 `onMessageExternal` 응답에 그대로 실어 보낸다. 웹의 `backfillSales()`가 `profitFailed`가 있으면 상태 메시지에 실패 날짜·이유를 바로 보여준다(자동 상태 숨김도 생략해서 사용자가 읽을 시간을 준다). **처음엔 `console.warn`으로만 남겨서, 백필해도 특정 날짜가 왜 안 채워지는지 사용자가 개발자도구 없인 알 방법이 없었다** — 실사용 중 "백필해도 계속 카드가 안 맞는다"는 혼란으로 이어져서 고침. 앞으로 이 함수들을 고칠 때 `failed` 배열을 계속 채워서 반환하는 관례를 유지할 것.

**`externally_connectable`이 웹 도메인(`https://sourcing-web2.vercel.app/*`)만 허용한다** — 웹 배포 도메인이 바뀌면 `manifest.json`도 같이 고쳐야 한다. 이 메시지 채널은 그 도메인의 웹페이지 JS만 부를 수 있고, 다른 사이트나 페이지 콘텐츠(관찰된 데이터)에서는 절대 트리거되지 않는다 — 신뢰 경계가 도메인 단위인 것.

## 상품별 실제 원가정보(개당 수수료·입출고비·보관비) 동기화 (`syncItemCosts`, 2026-08-16 구현 완료)

판매현황의 상품/옵션별 상세표가 카테고리 요율표 추정만 쓰던 걸, WING 재고현황이 상품별로 직접 매긴 **실제** 개당 수수료/입출고비와 이번달 누적보관비로 대체했다. API 스펙·캡처 경위는 `docs/api-notes.md` 4-4-6.

```
웹의 "상품 원가정보 갱신" 버튼
  → chrome.runtime.sendMessage(SALES_EXT_ID, {type:'SYNC_ITEM_COSTS'})
  → getOrOpenWingTab() → syncItemCosts(tab):
     inventory-health-dashboard/search를 pageSize=10 커서 기반으로 끝까지 페이지네이션
     (MAX_ITEM_COST_PAGES=60 안전장치, pageSize 10 기준 최대 600개 상품)
     → 상품마다 {commission_amount(=takeRateAmount), fulfillment_amount(=fulfillmentFee+warehousingFee),
        coupon_amount(=allMemberInstantDiscount+allMemberDownloadableDiscount, db/migrations/013),
        monthly_storage_fee_amount} 추출 → rocket_growth_item_cost_snapshots(db/migrations/012)에 insert
  → 웹에 {ok, rowCount} 응답 → fetchAndRenderSales() 재호출로 화면 갱신
```

**`SYNC_SALES`와 별개의 새 메시지 타입(`SYNC_ITEM_COSTS`)** — `onMessageExternal` 리스너 안에서 `message.type`으로 분기한다. 정산 백필과 마찬가지로 **자동으로는 안 돈다**(수백 개 상품까지 갈 수 있는 페이지네이션을 매번 자동으로 돌리면 느리고 WING에 부담 — `RateGovernor`가 있는 이유와 같은 우려, 사용자가 직접 지적함). 웹의 "상품 원가정보 갱신" 버튼(수동)으로만 트리거된다.

**덮어쓰지 않고 스냅샷으로 계속 쌓는다(`sbInsertIgnore`, upsert 아님)** — 상품 가격이 바뀌면 개당 수수료·입출고비도 같이 바뀌는데, **가격이 바뀌기 전에 팔린 것은 바뀌기 전 요율로 계산해야 한다는 게 사용자의 명확한 요구사항**이었다. 그래서 `vendor_item_id` 하나에 최신값만 남기는 대신 `(vendor_item_id, captured_at)`로 이력을 쌓고, 웹 쪽에서 판매 날짜 이전 중 가장 최근 스냅샷을 골라 쓴다(`web/app.js`의 `snapshotAsOf()`, `web/CLAUDE.md` 참조).

**`trigger_source` 컬럼(항상 `'manual_refresh'`, 2026-08-16 결정)** — 지금은 이 수동 버튼만 스냅샷을 만들지만, **나중에 웹에 가격 수정 기능이 생기면 가격을 바꾼 바로 그 순간이 사람이 버튼 누르는 것보다 훨씬 정확한 스냅샷 시점**이라, 그때는 가격 변경 성공 직후 그 상품 하나만(`pricing-info/{vendorItemId}`, 아직 응답 미확인 — 4-4-6 참조) 같은 스냅샷 로직으로 찍도록 확장할 계획이다. `syncItemCosts()`의 핵심 로직을 "이 vendorItemId들의 현재 원가정보를 스냅샷으로 추가"하는 재사용 가능한 단위로 설계해둔 게 이 확장을 염두에 둔 것 — 나중에 가격 수정 기능을 만들 때 이 함수(또는 그 안의 upsert 부분)를 그대로 재사용하고, `trigger_source`만 `'price_change'`로 넘기면 된다. **가격 수정 기능 자체는 아직 없음.**

**페이지네이션은 커서 기반(ES 스타일 search_after)** — `paginationResponse.searchAfterSortValues`를 다음 요청 그대로 전달. `pageSize`는 WING이 실제 쓰는 10 그대로 — 임의로 늘리지 말 것(절대 바꾸지 말 것 규칙 1과 같은 이유, 미검증 변형은 만들지 않는다).

## 데이터 흐름 (기능 추가 시 참고)

```
collectedRows[]  1단계 결과. runCategoryCollection()이 채움
detailsMap{}     2단계 결과. key="{pid}_{iid}" 우선, 없으면 "{pid}"로 폴백
                 runDetailCollection()이 채움
  ↓
buildSupabasePayload(collectedRows, detailsMap, catUnitMap)  in supabase.js
  ↓  옵션들을 상품 단위로 집계 (max_sales, sum_sales, rep_image_path 등)
{categories, products, items, history}
  ↓
sbUpsert() 500행 청크로 업로드
```

새 필드를 수집에 추가하려면 **`buildSupabasePayload`와 DB 마이그레이션을 함께** 고쳐야 한다. 하나만 고치면 조용히 데이터가 빈다.

## 카테고리 하나 끝까지 처리 (`finishCategoryPipeline`)

2026-08-13부터 **수동 "카테고리 수집"과 대기열(`processJob`)이 이 함수 하나를 공유한다.** 예전엔 전체 카테고리(1단계)를 다 모았다가 마지막에 한 번에 상세보강·업로드했는데, 도중에 실패하면 그때까지 작업이 통째로 안 올라갈 위험이 있었다.

```
finishCategoryPipeline(catCode, rows, opts)
  1. (withDetail이면) 상세보강 — runDetailCollection
  2. (상세보강 성공했으면) 입출고비 요금표 확인 — collectFeeDataForCategories
  3. buildSupabasePayload → sbUpsert
  → { detailDone, uploaded, productCount, itemCount }
```
**카테고리 하나가 끝날 때마다 그 자리에서 끝까지 처리**하므로, 중간에 중단돼도 이미 처리된 카테고리는 안전하게 저장돼 있다.

- **수동 실행**(`runCategoryCollection`): 카테고리 목록을 순회하면서 하나씩 1단계 수집 직후 바로 `finishCategoryPipeline()` 호출.
- **대기열**(`processJob`): `status='running'` → 1단계 수집 → `sbMarkCategoryCollected('list')` → `finishCategoryPipeline(catCode, collectedRows, {withDetail: job.job_type !== 'list'})` → `status='done'|'failed'`. 30초마다 폴링(`setInterval`). 감시 중엔 팝업을 닫으면 안 되므로 "별도 창" 모드로만 쓴다.

## Supabase 접속 유지 (`startKeepAlive`)

팝업/별도 창을 오래 열어둬도 로그인이 끊기지 않도록 20분마다 리프레시 토큰을 미리 갱신한다(`sbKeepAliveTick`). 갱신이 3번 연속 실패하면(리프레시 토큰 자체 만료 등, 드묾) 크롬 알림으로 재로그인을 요청한다(`notifyLoginExpired`) — `manifest.json`의 `notifications` 권한이 이걸 위한 것.

## 자세한 내용

- 쿠팡 API 전체 명세, 함정 3가지: `../docs/api-notes.md`
- 왜 이렇게 설계했는지: `../docs/decisions.md`
- 겪은 에러와 해결: `../docs/troubleshooting.md`
