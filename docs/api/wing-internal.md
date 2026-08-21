# WING 내부 API (확장프로그램)

> **언제 읽나**: 정산·반품·재고현황 동기화가 안 될 때. 확장프로그램을 고칠 때.
> **최종 검증**: 2026-08-20 (비즈니스 인사이트 경로 확인)
> **관련 코드**: `extension/background.js`·`interceptor.js`·`popup.js`

## 왜 확장프로그램인가

이 API들은 **WING 로그인 세션 기반**이라 무인 서버가 못 부른다.
그래서 사용자 브라우저의 확장프로그램이 WING 탭에서 캡처해 Supabase에 올린다.

## 쓰는 엔드포인트

| 용도 | 경로 | 채우는 테이블 |
|---|---|---|
| 순매출(반품 반영) | `/tenants/rfm-inventory/sales/sold-vendor-item-list` | `rocket_growth_sales_wing_daily` |
| 확정 정산 | `/tenants/rfm/.../profit-status/search` | `rocket_growth_profit_daily` |
| 재고현황(개당 원가) | `/tenants/rfm-inventory/inventory-health-dashboard/search` | `rocket_growth_item_cost_snapshots` |

## 함정 1 — 세션 쿠키만으론 부족하다 (`x-xsrf-token`)

`profit-status/search`가 "Failed to fetch"만 뱉었다. 페이지 CSP 문제로 오인해서
**페이지 이동 우회**와 **백그라운드 직접 fetch** 둘 다 시도했지만 소용없었다.

**진짜 원인은 콘솔에 따로 뜨는 CORS 메시지에만 있었다** — 우리 `catch(e)`에는
"Failed to fetch"로만 보였다. **콘솔 원문을 반드시 같이 볼 것.**

해결: 쿠키 `XSRF-TOKEN`을 `document.cookie`로 읽어 `x-xsrf-token` 헤더로 실어 보낸다.
쿠키는 **페이지 컨텍스트에서만** 읽히므로 `chrome.scripting.executeScript`로 페이지 안에서
호출해야 한다(백그라운드 직접 fetch로는 못 닿는다).

**페이지 이동은 불필요했다** — 헤더만 맞으면 WING 탭이 어느 페이지에 있든 호출된다.
다른 WING API에서 "Failed to fetch"를 만나면 **페이지 이동부터 시도하지 말고 이 패턴부터 확인할 것.**

## 함정 2 — 순매출 0인 옵션은 목록에서 아예 빠진다

당일 매입+반품으로 순수량이 정확히 0이 되면 `sold-vendor-item-list`에 **0으로 찍히는 게 아니라 없다.**
이게 판매현황 병합을 날짜 단위로 하는 이유이고, 반품처리비 미귀속의 원인이기도 하다 → `domain/sales-profit.md`

## 함정 3 — 오늘 날짜 확정 정산은 믿으면 안 된다

`profit-status/search`가 아직 인식 안 한 날짜에도 **부분적으로 채워진 값**을 준다.
→ `domain/sales-profit.md`의 "오늘 날짜" 절

## 페이지네이션

재고현황은 **커서 기반(ES search_after)**. `paginationResponse.searchAfterSortValues`를
다음 요청에 그대로 싣는다. `pageSize`는 WING 프론트가 쓰는 **10 그대로** —
임의로 늘리지 말 것(미검증 변형은 만들지 않는다).

## 동기화 범위

**"오늘+어제" 이틀 고정.** 자정 근처 타임존 오차 대비이자, 탭 열 때마다 30일치를 훑으면
느리고 WING에 부담이라 일부러 좁혀둔 것. **이 기본값 자체는 바꾸지 말 것.**
과거 날짜는 "정산 백필" 버튼(수동)으로 채운다.

## 웹 ↔ 확장프로그램 통신

`externally_connectable`이 **웹 배포 도메인만** 허용한다(`https://sourcing-web2.vercel.app/*`).
도메인이 바뀌면 `manifest.json`도 같이 고쳐야 한다.
그 도메인의 웹페이지 JS만 부를 수 있고, 다른 사이트나 페이지 콘텐츠에서는 트리거되지 않는다 —
**신뢰 경계가 도메인 단위**다.

웹의 `SALES_EXT_ID`는 확장프로그램의 크롬 ID다. 폴더를 옮기거나 웹스토어에 배포하면 바뀐다.

## 반품 상품별 귀속은 불가능하다 → D-08

로켓그로스는 CS·반품을 쿠팡이 전담해서 **개별 반품 건을 보여주는 화면이 WING에 아예 없다.**
실제 API 캡처 90건에도 반품 관련 엔드포인트가 전무했다. **다시 조사하지 말 것.**

## 재고현황에 "반품-최상" 배지가 있다 (미연동)

반품 재판매 옵션은 별도 옵션ID를 받고 상품명은 원본과 같은데, WING 재고현황 화면에
`반품-최상` 배지가 붙는다. **현재 저장 중인 스냅샷에는 이 필드가 없다** —
반품 SKU 자동 판별을 하려면 API를 다시 캡처해서 필드를 추가해야 한다.

## 비즈니스 인사이트 (판매 분석) — 2026-08-20 경로 확인

**여기에 노출·클릭 지표가 있다.** 시스템에 없던 방문자·조회·장바구니와 유입경로가 전부 이 화면 것이다.

처음엔 화면 주소 `/tenants/business-insight/sales-analysis`를 API 주소로 착각해서 캡처가
0건이었다. 전체 요청 목록을 뽑고서야 알았다 — **실제 서비스는 `rfm-ss`이고, 이미 알고 있던
`trends/search`와 같은 곳이다.** 화면 주소와 데이터 주소가 다르다는 걸 놓쳤다.

| 용도 | 경로 (전부 POST, 일부 GET) |
|---|---|
| **옵션별 지표 목록** | `/tenants/rfm-ss/api/business-insight/vi-detail-search` |
| 전체 요약 | `/tenants/rfm-ss/api/business-insight/vendor-summary` |
| 시간대별 | `/tenants/rfm-ss/api/business-insight/hourly-vendor-sales-summary` |
| **유입경로** | `/tenants/rfm-ss/api/traffic-insight/distribution/summary/without-subscription` |
| 옵션별 광고 상태 | `/tenants/cmg-wing-card/wing/one-click-setup/condition` |
| 구독 자격 | `/tenants/rfm-ss/api/subscription/v1/is-eligible` |

**요청 형태 (실물)**
```json
// vi-detail-search — 하루치를 받으려면 startDate = endDate
{"startDate":"2026-08-14","endDate":"2026-08-20",
 "registrationTypes":["NORMAL","RFM"],
 "pageNumber":0,"pageSize":20,"sortBy":"GMV","sortOrder":"DESC","includeSoldVICount":true}

// traffic-insight — **without-subscription 이라 유료 구독 없이도 온다**
{"startDate":"...","endDate":"...","metrics":["unit_sold_contribution"],
 "trafficSources":["search","recommendation","promotion","product_list_pages",
                   "mycoupang","brandstore","live","other","ADS"],
 "registrationTypes":["NORMAL","RFM"],"isRecentlyListed":false}
```

`registrationTypes`: **RFM = 로켓그로스, NORMAL = 판매자배송.**

**`trafficSources`에 `ADS`가 있다** — 조회 증가가 광고 때문인지 자연 검색 때문인지 가를 수 있다.
실험 분석에서 이게 없으면 광고 효과를 썸네일 효과로 오독한다.

날짜를 바꾸면 화면 URL 자체가 바뀐다(페이지 재로드). 그래서 날짜별로 반복 호출하면
과거 백필이 가능하다. **당일 데이터는 다음날 밤에 채워지므로 어제치까지만 받는다.**


## 상품등록 화면이 부르는 내부 API (2026-08-21 캡처)

확장프로그램 인터셉터가 WING 요청을 전부 기록한다 → 팝업 [캡처된 API 호출 목록].
상품등록 페이지를 새로 열고 카탈로그 매칭을 한 번 검색해서 잡은 것들이다.

| 경로 | 무엇 |
|---|---|
| `POST /tenants/seller-web/pre-matching/search` | **카탈로그 상품매칭** — 상품명·URL·상품번호로 카탈로그 조회 |
| `GET /tenants/seller-web/vendor-inventory/product-category/getCategories?registrationType=NORMAL&term=` | 카테고리 검색(자동완성) |
| `GET /tenants/seller-web/category/display-category/getRootCategories` | 카테고리 최상위 트리 |
| `GET /tenants/seller-web/vendor/my/outbound-address` | **출고지 목록** — 뼈대에 필요 |
| `GET /tenants/seller-web/vendor/my/return-address` | **반품지 목록** — 뼈대에 필요 |
| `GET /vendor-inventory/constraint-by-info?internalCategoryId=…&dataType=SHIPPING_AND_RETURN_FEE` | 카테고리별 배송·반품비 제약 |
| `GET /vendor-inventory/delivery-charge-constraint?internalCategoryId=…` | 배송비 제약 |
| `GET /tenants/seller-web/vendor-inventory/rod/v2/prohibited-item-words` | **상품명 금지어** |
| `GET /tenants/seller-web/vendor-inventory/creation/is-mfn-allowed` | 판매자배송 가능 여부 |

**아직 바디는 못 봤다** — 목록에는 경로만 나온다. `pre-matching/search`를 쓰려면
`trends/search`와 같은 방식(인터셉터가 요청 몸통을 템플릿으로 저장 → 검색어만 바꿔 재요청)이
필요하다.

### 왜 Open API 가 아니라 여기인가

등록 몸통 23키를 실제로 확인했다(2026-08-21): `brand` · `brandId` · `manufacture` ·
`sellerProductId` 뿐이고 **카탈로그를 지정하는 필드가 없다.** 조회 응답에도 없다.
즉 Open API 로는 카탈로그 정보를 가져올 수도, 특정 카탈로그에 붙여달라고 지정할 수도 없다.
→ 카탈로그 매칭은 **WING 내부 API + 확장프로그램**이 유일하게 확인된 길이다.

**호출은 사람이 누를 때 1회씩만.** 배치·반복 호출을 하지 않는 게 차단을 피하는 유일한 방법이다
(소싱 수집이 이미 훨씬 무거운 호출을 하고 있어서, 준비 건당 1~2회는 증가분이 사실상 없다).

### 카탈로그 매칭 실측 (2026-08-21)

```
POST /tenants/seller-web/pre-matching/search
요청  {"keyword":"9671949069","excludedProductIds":[],"searchPage":0,
       "searchOrder":"DEFAULT","sortType":"DEFAULT"}
```
`keyword` 하나만 바꾸면 된다. 상품명·상품번호·URL 다 받는다.

```json
{"nextSearchPage":1,"hasNext":false,"result":[{
  "productId":9671949069, "productName":"루모아 무중력 박사 퍼티 슬라임 말랑이",
  "brandName":null, "itemId":28918717061, "itemName":"1개 42g 오로라펄",
  "displayCategoryInfo":[{"leafCategoryCode":103112,"rootCategoryCode":102984,
                          "categoryHierarchy":"완구/취미>…>액체괴물/슬라임(완제품)"}],
  "manufacture":"루모아", "categoryId":7359, "itemCountOfProduct":12,
  "imagePath":"vendor_inventory/…png", "salePrice":5800, "vendorItemId":95850422728,
  "rating":4.0, "ratingCount":14,
  "pvLast28Day":5877,     // 최근 28일 조회수
  "salesLast28d":353,     // 최근 28일 판매량  ★ 소싱 판단에 가장 값어치 있다
  "deliveryMethod":"DOMESTIC", "matchType":null, "matchingResultId":null,
  "sponsored":null, "attributeTypes":null }]}
```

**`categoryId`(7359)를 등록 카테고리로 쓰면 안 된다.** 등록에 쓰는 코드는
`displayCategoryInfo[0].leafCategoryCode`(103112)다. 처음 만든 느슨한 파서가
`categoryId` 를 집었는데, 그대로 뒀으면 **엉뚱한 카테고리로 등록될 뻔했다.**
필드 이름이 비슷하다고 같은 뜻이 아니다 — displayItemCategoryId 함정과 같은 종류다.

**조회수·판매량이 같이 온다.** 이건 소싱 판단 시점에만 볼 수 있는 값이라
`listing_projects.catalog_snapshot` 에 응답 원문을 통째로 박아둔다(R-04).
나중에 "28일 조회 5,877 · 판매 353짜리를 보고 골랐는데 결과가 어땠나"를 계산할 수 있다.

**URL 을 그대로 보내면 0건이다**(2026-08-21 실측). `keyword` 에는 **상품번호만** 넣어야 한다.
WING 화면도 같은 일을 한다 — 바깥 칸에 URL 을 붙여넣으면 다이얼로그 검색칸엔 숫자만 들어간다.
그래서 확장프로그램이 `coupang.com/vp/products/(\d+)` 를 먼저 뽑아낸 뒤 보낸다.

`{"hasNext":false,"nextSearchPage":0,"result":[]}` 는 **정상 응답에 결과가 없는 것**이다.
파싱 실패와 구분해서 말해야 한다 — 같은 문구로 뭉개면 엉뚱한 데를 고치게 된다.
