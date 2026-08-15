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

**진단용 캡처(`interceptor.js`의 `SALES_PATHS`/`saveSalesCapture`, 팝업 "판매현황 API 캡처 보기")는 그대로 남아있다** — WING 내부 판매현황 API의 정확한 요청/응답 구조를 처음 알아낼 때 썼고, 앞으로 이 API가 바뀌었는지 다시 확인할 때도 쓸 수 있어서 지우지 않았다. 하지만 **실제 자동 동기화는 이걸 안 쓰고 `background.js`가 직접 담당**한다(수동 캡처 → 확인 → 나중에 붙이는 방식이 아니라, 능동적으로 API를 호출하는 방식).

```
웹의 판매현황 탭 (loadSales())
  → chrome.runtime.sendMessage(SALES_EXT_ID, {type:'SYNC_SALES', dateFrom, dateTo})
  → background.js의 onMessageExternal 리스너가 깨어남
     1. WING 탭 찾기, 없으면 새로 열기(getOrOpenWingTab)
     2. 날짜별로(범위를 통째로 넣으면 합산되어버리므로 하루씩, docs/api-notes.md 4-4-2 실측 확인)
        chrome.scripting.executeScript로 그 탭 안에서 sold-vendor-item-list 호출
        (같은 origin이라 쿠키가 자동으로 붙음, 별도 인증 코드 불필요)
     3. 로그인 안 돼 있으면(JSON 아닌 응답) notLoggedIn 에러로 즉시 실패 반환
     4. sbUpsert()로 rocket_growth_sales_wing_daily에 upsert (Supabase 인증은 supabase.js 재사용)
  → 웹에 {ok, days, rowCount} 응답
```

**`syncSales()`가 판매(반품 포함)와 확정 정산 둘 다 같은 WING 탭으로 처리한다(2026-08-15 확장)** — `syncSalesForDates()`(→ `rocket_growth_sales_wing_daily`)와 `syncProfitForDates()`(→ `rocket_growth_profit_daily`, `profit-status/search` 기반, `docs/api-notes.md` 4-4-4)를 순서대로 호출한다. WING 탭을 두 번 찾거나 열지 않기 위해 `getOrOpenWingTab()` 결과를 두 함수에 공유한다. **하루 단위 조회가 실패해도(정산 미확정 등) 그 날짜만 건너뛰고 전체 동기화는 안 막는다** — `notLoggedIn`만 즉시 전체 실패로 처리(로그인부터 해야 어차피 다 실패하므로).

**기본 동기화 범위는 "오늘+어제" 이틀 고정이다** — `rocket-growth-sync.js`와 같은 이유(자정 근처 타임존 오차, `docs/api-notes.md` 4-1)이자, 판매현황 탭을 열 때마다 매번 30일치를 다 훑으면 느리고 WING에 부담이라 일부러 좁혀둔 것. 더 넓은 범위를 과거로 백필하고 싶으면(예: 지난달 반품까지 채우고 싶을 때) 이 기본값을 바꾸지 말고 **별도의 수동 백필 기능을 새로 만들 것**.

**`externally_connectable`이 웹 도메인(`https://sourcing-web2.vercel.app/*`)만 허용한다** — 웹 배포 도메인이 바뀌면 `manifest.json`도 같이 고쳐야 한다. 이 메시지 채널은 그 도메인의 웹페이지 JS만 부를 수 있고, 다른 사이트나 페이지 콘텐츠(관찰된 데이터)에서는 절대 트리거되지 않는다 — 신뢰 경계가 도메인 단위인 것.

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
