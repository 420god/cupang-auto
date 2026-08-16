# 쿠팡 API 역공학 결과 + 마진 계산 공식

> extension/popup.js가 이 API들을 어떻게 다루는지의 '왜'.
> 코드는 extension/popup.js, extension/supabase.js를 직접 읽을 것.

## 2. 쿠팡 API 역공학 결과 — 가장 중요

코드에 결과는 반영돼 있지만 **왜 그렇게 짰는지는 코드에 없다.**

### 2-1. 카테고리 트리
```
GET /tenants/rfm-ss/api/cms/categories
```
재귀 구조 `{displayItemCategoryDto:{...}, child:[...]}`

- **응답이 2MB 초과.** 그래서 `pageFetchCategoryTree`가 페이지 안에서 파싱까지 끝내고 결과만 반환한다. 원문을 넘기면 잘려서 JSON이 깨진다.
- **`displayItemCategoryCode`가 정답 코드.** `displayItemCategoryId`와 **정확히 1000 차이**라 혼동하기 쉽다. (여성 골프 패딩 → Code 80987 / Id 79987)

### 2-2. 상품 검색 (1단계)
```
POST /tenants/rfm-ss/api/trends/search
```

**함정 3개 — 전부 실제로 겪었다.**

1. **`context`는 `searchCondition` 안에 있다.** 밖으로 빼면 `HTTP 400 Failed to read request`.
2. **`query`에 카테고리 이름이 들어간다.** 코드만 바꾸고 query를 그대로 두면 이전 카테고리 이름으로 필터링되어 엉뚱한 결과가 나온다.
3. **빈 query는 서버가 빈 응답으로 거부한다.**

그래서 최종적으로 **바디를 직접 만들지 않고 interceptor가 캡처한 실제 요청을 재사용**한다. 이 방식을 바꾸지 말 것.

**응답 필드는 정확히 20개.** 진단으로 확인했고 **판매량 절대수치도 배송유형도 없다.**
```
brandName, categoryId, displayCategoryInfos, imagePath, itemId, itemName,
listingEligibility, lowerPvLast28d, manufacture, mergeableStatus, productId,
productName, pvLast28dRank, pvLastDay, rating, ratingCount, salesPrice,
upperPvLast28d, vendorItemId
```

`lowerPvLast28d`가 `-9223372036854776000`(Long 최솟값)이면 **"하한 없음"** 의미. `cleanPv()`가 처리.

### 2-3. 요금 카테고리 매핑
```
POST /tenants/rfm/accounting-fee/category/search
Body: 8699        ← JSON이 아니라 숫자 문자열만
→ {unit1:"Apparel", unit2:"Women Clothes", kanCategoryId:8699, ...}
```

> **핵심 발견**: `kanCategoryId`가 상품 응답의 `categoryId`와 **같다.**
> 원래 `/tenants/rfm/api/product/meta/category/{code}`를 먼저 호출해야 하는 줄 알았으나,
> 이미 갖고 있는 값이라 한 단계 생략할 수 있다.

### 2-4. 입출고비 요금표
```
POST /tenants/rfm/accounting-fee/revamp/warehousing-and-fulfillment-fee
POST /tenants/rfm/accounting-fee/lowasp/...    (14,000원 미만 저가 전용)
Body: {agreementScope:"PRODUCTION", leafKanCategoryIds:[],
       unit1Unit2CategoryNames:[{unit1CategoryName, unit2CategoryName}]}
```
응답에서 **`finalAmount`가 화면의 "할인가"(실사용)**, `amount`가 정가.
`capacityType`: MINI / SMALL / MEDIUM / LARGE1 / LARGE2 / XLARGE

**카테고리 체계가 세 가지**라 헷갈린다.
```
쿠팡 진열   displayItemCategoryCode    77910
KAN         categoryId / kanCategoryId 6135, 8699
요금        unit1 / unit2              "Apparel" / "Women Clothes"
```

### 2-5. 소비자 상품 페이지 (2단계)
```
GET https://www.coupang.com/vp/products/{productId}?itemId={itemId}
```
- **API가 아니라 HTML.** 1건당 약 560KB (조기중단 시 평균 395KB)
- **ID 자릿수**: productId **10자리** / itemId·vendorItemId **11자리**. 잘못 넣으면 "상품을 찾을 수 없습니다"
- URL 시도 순서: `?itemId=` → `?itemId=&vendorItemId=` → `?vendorItemId=` → 기본
- **`www.coupang.com`은 CSP로 인터셉터 주입이 차단된다**(확인됨). 그래서 후킹이 아니라 `chrome.scripting.executeScript`로 직접 fetch한다.

**HTML 파싱의 함정**

| 항목 | 함정 |
|---|---|
| 없는상품 판정 | **정상 페이지에도 "상품을 찾을 수 없습니다"가 숨겨진 템플릿으로 들어 있다.** 이걸로 판단하면 안 됨 |
| 판매량 | `한 달간<s>{v}</s>구매했어요` i18n 템플릿이 실제 데이터보다 앞에 나올 수 있다 → `{v}` 포함 매치는 건너뜀 |
| 판매량 | **100명 미만이면 표기가 아예 없다** ("N명 이상 만족했어요"만 뜸) → `salesNumber=0`, `'100명 미만 추정'` |
| 가격 | JSON(`salePrice` 등) 우선, Tailwind 클래스(`twc-text-red-700`)는 폴백. 클래스는 디자인 변경에 취약 |
| 배송 | `deliveryBadgeLabel` → `logo_rocket_*` 이미지명 → `판매자:`+`배송사:` 순으로 판정 |

---

## 3. 마진 계산 — 확정 공식과 검증값

**아래 공식의 "수수료 10.8%"는 이 공식이 처음 검증되던 시점의 예시값일 뿐이다.** 지금 코드(`calcMargin()`)는 수수료율을 인자로 받고, 실제 호출부는 전부 `commissionFor(catCode)`(카테고리별 실제 요율)로 구해서 넘긴다 — 전역 10.8% 가정치는 없다(`docs/api-notes.md` 4-4-3, 2026-08-13에 제거됨). 공식 구조 자체(판매가에서 수수료·입출고비를 빼는 계산 순서)만 여기서 확인할 것.

```
개당 원가(원) = cost_cny × exchange_rate(기본 320)
정산예상액   = 판매가 - 수수료(판매가×수수료율) - 입출고비
실마진       = 정산예상액 - 원가 - 출고비(300) - 작업비(300)
실마진율     = 실마진 ÷ 판매가 × 100
```
**현재가 기준 / 희망가 기준 두 벌로 계산한다.**

**VAT는 따지지 않는다.** 사용자 명시: "소싱페이지에서의 부가세 처리는 원가 하나로, 위안화로". 정밀한 공급가액 기준 손익은 "다른 페이지"로 보류.

**실제 청구서로 검증한 값 — 회귀 테스트 기준으로 쓸 것**
```
1688 결제 166.5 CNY / 21개 → 개당 7.93 CNY
7.93 × 320 = 2,538원        (청구서 53,280÷21 = 2,537원과 일치)

판매가 15,000 · 수수료 10.8% · 입출고 3,000 · 원가 7.93CNY
  → 수수료 1,620 / 정산 10,380 / 원가 2,538 / 실마진 7,242원 (48.3%)
희망가 12,000 → 4,566원 (38.1%)
판매가  5,000 → -1,178원 (-23.6%)   적자도 정상 표시
```

---

## 4. 로켓그로스 Open API (판매현황 탭용, 2026-08-13 조사)

> 위 1~3번은 로그인 쿠키 기반 **내부 역공학 API**. 이 섹션은 완전히 별개인 **쿠팡 공식 Open API**(`developers.coupang.com`, WING에서 발급받는 accessKey/secretKey로 HMAC 서명).
> Base URL 공통: `https://api-gateway.coupang.com`. 인증은 HMAC-SHA256, `Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...` 형태(정확한 서명 생성 규칙은 코드 작성 시 `developers.coupangcorp.com`의 "Creating HMAC Signature" 문서로 재검증할 것 — 아직 실제 키로 테스트 못 해봄).

### 4-1. 로켓그로스 주문 조회 (판매량·매출용 — 이게 핵심)
```
GET /v2/providers/rg_open_api/apis/api/v1/vendors/{vendorId}/rg/orders
쿼리: paidDateFrom, paidDateTo (yyyymmdd, 필수, 최대 30일 범위), nextToken (페이징)
```
응답 `data[]` → `orderId`, `paidAt`, `orderItems[]`(`vendorItemId`, `productName`, `salesQuantity`, `unitSalesPrice`, `currency`).
**수수료·정산액 필드 없음.** 매출(수량×단가)까지만 나온다. 분당 50회 제한, 한국 구매자만.

**`paidDateFrom=paidDateTo=오늘` 단일일자 조회는 오늘 새벽 주문을 빠뜨릴 수 있음(실측 확인, 2026-08-15).** `paidDateFrom=paidDateTo=20260815`로만 조회하면 0건이 나왔는데, 범위를 `어제~오늘`로 넓히니 오늘 오전 5:29 KST에 결제된 주문이 나왔다 — **날짜 필터가 KST가 아니라 UTC 자정 기준으로 도는 것으로 추정**(KST 00:00~09:00 사이 주문은 UTC로는 아직 "어제"라 단일일자 조회에서 빠짐). `scripts/rocket-growth-sync.js`가 기본으로 "오늘+어제"(`--days=2`) 이틀치를 항상 같이 조회하는 이유가 정확히 이거였음 — 예전엔 "자정 근처 오차" 정도로만 적혀 있었는데 이제 메커니즘까지 확인됨. **절대 단일일자 조회로 바꾸지 말 것.**

### 4-2. 로켓창고 재고 조회
```
GET /v2/providers/rg_open_api/apis/api/v1/vendors/{vendorId}/rg/inventory/summaries
쿼리: vendorItemId(선택), nextToken
```
`totalOrderableQuantity`(주문가능수량), `salesCountMap.SALES_COUNT_LAST_THIRTY_DAYS`(최근 30일 판매량). 판매현황 탭엔 필수 아님, 재고 표시용.

### 4-3. 상품 등록/수정/조회/카테고리 API들
`seller_api` 계열(`/v2/providers/seller_api/apis/api/v1/marketplace/seller-products` 등). 상품 등록·관리용이고 **판매현황·정산과 무관** — 조사만 하고 이번 작업엔 안 씀.

### 4-4. 수수료·정산 — 직접 주는 API가 로켓그로스엔 없음 (중요)
검색으로 찾은 것은 `marketplace_openapi` 계열 두 개뿐:
```
GET /v2/providers/openapi/apis/api/v1/revenue-history                 (매출내역조회, recognitionDateFrom/To)
GET /v2/providers/marketplace_openapi/apis/api/v1/settlement-histories (정산내역조회, revenueRecognitionYearMonth=YYYY-MM, 월 단위)
```
- 이게 **일반 마켓플레이스용인지 로켓그로스 계정에도 데이터가 나오는지 미확인**. 실제 키 받으면 먼저 테스트해볼 것.
- 정산내역조회는 **월 단위**라 애초에 "오늘 확정 수수료"라는 개념이 존재하지 않을 가능성이 높음(정산은 며칠~한 달 지연).

**(2026-08-13 당시 방식, 이후 개선됨 — 아래 4-4-3 참조)** 판매현황 탭은 4-1의 실시간 주문 데이터에 ~~가정 수수료율 10.8%~~를 적용한 추정치로 표시했었다. **지금은 아니다** — 카테고리별 실제 수수료율을 DB에 채워넣은 뒤로 판매현황도 소싱 탭과 똑같이 `commissionFor(catCode)`(실제 요율)를 쓴다. 자세한 건 바로 아래 4-4-3.

**입출고비를 직접 주는 API는 없다는 것 확정(2026-08-13, 문서로 직접 확인함).** 매출내역조회(`revenue-history`)·정산내역조회(`settlement-histories`) 둘 다 문서에 **"일반 마켓플레이스 판매자 전용"**이라고 명시돼 있어 로켓그로스 대상이 아니고, 응답 필드에도 `serviceFee`(수수료)·쿠폰·배송비 관련 항목만 있을 뿐 입출고비 항목 자체가 없다 —애초에 입출고비는 로켓그로스(쿠팡 풀필먼트)에만 발생하는 비용이라 마켓플레이스 정산 구조에 그 개념이 없는 것. 즉 로켓그로스 셀러가 입출고비 실제값을 API로 받을 방법은 현재 **없음**. 요금표 기반 추정(`feeFor()`)이 유일한 방법이고, 이 이상 정확도를 올릴 API 경로는 막다른 길이니 나중에 또 찾아보지 말 것.

**카테고리별 판매수수료율이 어떤 API에도 없다는 것 확정(2026-08-13 당일 조사).** `developers.coupang.com/ko/api` 전체 카탈로그(100개 API)를 다 뒤져봤지만 수수료 필드가 있는 API는 없었다 — **API로는** 여전히 못 받는다는 뜻.

### 4-4-3. 카테고리별 실제 수수료율 — API 대신 WING 수수료안내 페이지로 해결됨(2026-08-13, 같은 날 바로 이어서)

API로 안 된다고 포기하지 않고, **사용자가 WING의 "수수료 안내" 페이지(HTML, `2019-11-25 기준` 명시된 자료)를 직접 가져다줘서** 이걸 파싱해 `categories.commission_rate`를 채웠다(`db/migrations/006_commission_rates.sql`). 그리고 전역 10.8% 가정치는 **완전히 제거**했다(`007_drop_global_commission_default.sql`) — 매칭 안 된 카테고리는 이제 "수수료 정보 없음"으로 표시되고 마진 계산에서 제외된다(가정치로 대충 채우지 않음, 의도된 동작).

**소싱 탭·판매현황 탭 둘 다 이 실제 요율을 쓴다**(`web/app.js`의 `commissionFor(catCode)`) — **더 이상 어디에도 10.8% 가정치가 안 남아있다.** 이 문서 위쪽(4-4 도입부, 4-4-1)과 3번 섹션의 "가정 수수료율 10.8%" 언급은 전부 **이 개선 이전의 기록**이니, 지금 코드 동작과 헷갈리지 말 것. 카테고리 매칭 작업 시 함정은 `db/CLAUDE.md`와 `docs/decisions.md` 2026-08-13 항목 참조.

**남아있는 진짜 추정치는 입출고비뿐이다** — 이건 4-4 위쪽 설명대로 API 자체가 없어서(로켓그로스 전용 비용이라 마켓플레이스 정산 구조에 개념이 없음) 요금표 기반 추정(`feeFor()`)이 유일한 방법이다.

### 4-4-1. 반품/취소 — 공식 Open API로는 안 되지만, WING 내부 API로는 됨 (2026-08-15, 최종 결론 뒤집힘 — 아래 4-4-2 참조)

판매현황 탭에 반품 집계가 없다는 사용자 지적으로 재조사. **로켓그로스 전용 반품 API는 없다**(로켓그로스 섹션엔 상품관리 6개 + RG Order + RG Inventory, 총 8개뿐). 대신 일반 반품/취소 API가 있다:

```
GET /v2/providers/openapi/apis/api/v6/vendors/{vendorId}/returnRequests
쿼리: searchType=timeFrame(필수), createdAtFrom/createdAtTo(필수, "yyyy-MM-ddTHH:mm" 형식 — 날짜만 넣으면 400),
      status(RU/UC/CC/PR, 선택), cancelType(RETURN 기본값/CANCEL, 선택 — CANCEL이면 status 미지원),
      nextToken, maxPerPage(기본 50), orderId(선택)
```

**1차 테스트(2026-08-15, GCP VPS에서 실제 키로 호출)**: `cancelType=RETURN`, 최근 30일 → `HTTP 200, {"data":[]}`. 403/"마켓플레이스 전용" 에러 없이 정상 200이라 "된다"고 1차 판단했었음.

**2차 테스트(같은 날, 사용자가 WING 화면에서 당일 실제 반품 1건을 스크린샷으로 제시함 — 상품 "덴넬 박사퍼티 슬라임", vendorItemId `95826801582`, -9,000원 -1개)**: 이 실제 케이스를 잡아내는지 재검증 → `cancelType=RETURN`/`CANCEL` 둘 다, 3일 범위·30일 범위 전부 **여전히 `{"data":[]}`**. 즉 **알고 있는 실제 반품 건이 하나도 안 잡힌다.**

**결론(잠정)**: 이 API는 인증·호출은 되지만(403 같은 명시적 거부가 없음) **로켓그로스 반품은 이 API가 읽는 데이터에 아예 없는 것으로 보인다** — 4-4의 정산/매출 API처럼 문서에 명시적으로 "마켓플레이스 전용"이라 안 써있을 뿐, 실질적으로는 같은 카테고리(로켓그로스는 쿠팡이 직접 풀필먼트·반품을 처리하므로 셀러용 "반품 신청" 레코드 자체가 안 쌓이는 구조로 추정). 로켓그로스 섹션에 반품 API가 처음부터 없는 것과도 일치.

**추가로 RG Order API·RG Inventory API 원본 응답도 직접 까봤음(같은 날)** — 혹시 문서에 안 적힌 숨은 필드가 있을까 해서. 둘 다 없음. RG Order API는 정말 `vendorId`/`orderId`/`paidAt`/`orderItems[].{vendorItemId,productName,salesQuantity,unitSalesPrice,currency}` 5종류뿐이고, 오늘 반품된 그 주문 4건도 `salesQuantity: 1`로 아무 이상 없이 찍혀 있었음(취소/반품 표시 필드 자체가 없다는 뜻). RG Inventory API도 `salesCountMap.SALES_COUNT_LAST_THIRTY_DAYS`, `inventoryDetails.totalOrderableQuantity`뿐, 반품/재입고 구분 필드 없음.

**웹 검색으로 찾은 정황 증거(주의: 어느 것도 "불가능"을 직접 못박은 1차 기술문서는 아님)**:
- 쿠팡 공식 로켓그로스 소개 페이지(marketplace.coupang.com, `rocketarticle07`, **마케팅 카피**): "물류, 포장, 배송, 재고관리와 CS는 로켓그로스에게 맡기고" — CS(반품 포함)를 쿠팡이 대행한다는 취지.
- 플레이오토(쿠팡과 무관한 국내 3자 쇼핑몰 통합관리 솔루션) 로켓그로스 도움말(`plto.com`): "**상품관련 기능만 제공**(상품등록/수정/SKU매칭/입고정보)" — 반품·취소·주문조회·정산은 언급 자체가 없음. 단, 이건 "플레이오토가 그 기능을 안 만들었다"는 것이지 "쿠팡 API가 원천적으로 안 된다"를 직접 증명하진 않음.

**증거 신뢰도 정리**: 가장 강한 근거는 검색이 아니라 **직접 실측**(1차 API 호출 결과 + RG Order/Inventory 원본 필드 확인)이고, 위 검색 결과들은 그 방향과 일치하는 **정황 증거**일 뿐이다 — "인터넷에 확인된 자료가 있다"고 단정하면 과장이다.

**이 시점(4-4-1)의 잠정 결론이었던 "공식 Open API 경로로는 막혀 있다"는 것 자체는 여전히 맞다.** 다만 아래 4-4-2에서 완전히 다른 경로(WING 내부 API)로 실제 반품 순액 데이터를 찾았다 — 그러니 "로켓그로스 반품은 셀러에게 아예 안 보인다"는 결론은 틀렸다. 쿠팡이 안 주는 게 아니라 **공식 Open API에만 없는 것.**

`returnItems[]`(일반 반품 API, `4-4-1`) 응답 필드는 여전히 실제 데이터로 검증 못 함 — 이제 안 써도 되므로 더 검증할 필요도 없음.

### 4-4-2. WING 내부 판매현황 API — 반품이 순액으로 정확히 반영됨 (2026-08-15, 확장프로그램으로 캡처 성공)

사용자가 WING의 "재고현황" 위젯에 오늘 반품(퍼플 47g, vendorItemId `95826801582`)이 이미 순매출에 반영된 걸 스크린샷으로 제시 → `extension/interceptor.js`에 `SALES_PATHS` 캡처를 추가해서(기존 `FEE_PATHS` 패턴 그대로) 실제 호출되는 내부 API를 확보함.

```
POST https://wing.coupang.com/tenants/rfm-inventory/sales/sold-vendor-item-list
바디: {"startDate":{"date":"yyyy-MM-dd","timeZone":"Asia/Seoul"},"endDate":{...},
      "pageNumber":0,"pageSize":10,"sortBy":"GMV","sortOrder":"DESC"}
응답: {"pagination":{...}, "soldVendorItems":[
  {"vendorId","vendorItemId","productId","vendorInventoryName","vendorInventoryItemName",
   "imagePath","gmv":{"amount","currency"},"unitsSold"}, ...
]}

GET https://wing.coupang.com/tenants/rfm-inventory/sales/today
응답: {"vendorId","todayGmvWithTrend":{gmv,previousPeriodGmv,percentIncreaseFromPreviousPeriod},
      "todayUnitsSoldWithTrend":{...},"todayHourlySales":[{hour,gmv,unitsSold}×24],
      "yesterdayHourlySales":[...],"yesterdayTotalGmv","yesterdayTotalUnitsSold","lastRefreshTimestamp"}
```

**반품이 이미 순액(음수)으로 반영된 것 실측 확인됨** — 2026-08-15 실제 캡처 결과:
```
퍼플 47g(vendorItemId 95826801582): gmv -9000, unitsSold -1   ← 반품 그 자체
그린 47g(vendorItemId 95826801580): gmv 800,  unitsSold 0    ← 오늘 판매분(9,800원)이 오늘 반품으로 상쇄, 800원만 잔존(반품배송비 차감분으로 추정, 미확정)
todayHourlySales의 12시 구간: gmv -18000, unitsSold -2       ← 반품 시점이 시간대별로도 그대로 찍힘
```
`todayGmvWithTrend.gmv`(12,300원)·`todayUnitsSoldWithTrend.unitsSold`(1개)는 `soldVendorItems[]`를 다 더한 값과 정확히 일치 — 내부적으로 일관된 순액 계산.

**결정적 제약**: 이 API는 HMAC 서명이 아니라 **WING 로그인 세션 쿠키 기반**이다. 즉 지금처럼 GCP VPS가 무인 cron으로 호출하는 방식(`rocket-growth-sync.js`)이 그대로 안 통한다 — 사용자가 로그인한 WING 브라우저 탭 안에서만(확장프로그램의 `chrome.scripting.executeScript` 방식으로) 호출 가능. `product_id`/`vendorItemId`가 있어 기존 `product_items` 조인 키와 바로 연결되는 건 장점.

**날짜 범위를 통째로 넣으면 그 범위 전체가 하나로 합산된다(일별 breakdown 아님, 2026-08-15 실측 확인).** WING 위젯에서 "지난 7일"/"지난 30일"을 눌러서 재캡처해보니, `startDate`~`endDate`를 넓게 잡을수록 `soldVendorItems[]`의 각 항목 `gmv`/`unitsSold`가 그 기간 전체의 합계로 나온다(예: 그린 47g이 7일 범위에선 46,600원/5개, 30일 범위에선 64,600원/7개 — 날짜별로 안 쪼개짐). **그래서 날짜별(`sale_date`) 데이터가 필요하면 하루씩(`startDate=endDate=그날`) 따로 호출해야 한다** — `rocket-growth-sync.js`가 날짜별로 도는 것과 같은 이유.

**캡처 인프라(진단용, 지금도 남아있음)**: `extension/interceptor.js`의 `SALES_PATHS`/`saveSalesCapture()`가 이 두 API의 요청·응답을 `sessionStorage.__cwc_sales_captures`에 저장하고, 팝업의 "판매현황 API 캡처 보기" 버튼으로 확인 가능 — 이 API가 나중에 또 바뀌었는지 확인할 때 씀.

**구현 완료(2026-08-15)**: 실제 자동 동기화는 `extension/background.js`(신설 서비스워커)가 담당한다. 웹의 판매현황 탭이 열릴 때마다 `chrome.runtime.sendMessage`로 "오늘+어제" 동기화를 요청하고, 백그라운드가 WING 탭에서 하루씩 호출해 `rocket_growth_sales_wing_daily`(`db/migrations/009`)에 upsert한다. 자세한 흐름은 `extension/CLAUDE.md` "판매현황/반품 동기화" 섹션, 웹 쪽 병합 로직(같은 날짜·옵션이면 이 테이블 값이 기존 `rocket_growth_sales_daily`보다 우선)은 `web/CLAUDE.md` 참조.

**그린 47g의 800원 잔존액(2026-08-15, 정정)**: "반품배송비 차감분"이라는 앞선 추정은 근거 없는 추측이었다. 더 설득력 있는 설명(사용자 제보, 미확정이지만 유력): 그린은 오늘 새벽에 팔리고 오늘 낮에 반품된 "당일 판매+당일 반품" 케이스인데(퍼플은 반품만 있고 판매가 없어서 깨끗하게 나옴, 위 참조), **"판매" 쪽 금액과 "반품(환불)" 쪽 금액이 서로 다른 가격 기준으로 잡혔을 가능성**이 있다 — 예: 판매 시점 가격과 환불 처리 시점 가격이 다르거나(사용자가 그 사이 가격을 800원 올렸다고 함), 판매 쪽은 쿠폰 할인 전 정가로 잡히고 환불 쪽은 쿠폰 할인 후 실제 결제액 기준으로 처리됐거나. 어느 쪽이 맞는지는 아직 실측 검증 안 됨 — 급한 문제는 아니라서 보류. **중요한 건 net 값(`gmv`/`unitsSold`) 자체는 쿠팡이 실제 거래를 합산한 결과라 신뢰할 수 있다는 것** — 판매가를 우리가 따로 추적/캐싱하는 게 아니므로 가격을 자주 바꿔도 이 net 값엔 왜곡이 없다.

### 4-4-4. 정산 확정값 API — 수수료·입출고비·쿠폰·광고비·밀크런 전부 실제값으로 나옴 (2026-08-15, 초대형 발견)

판매수수료율은 4-4-3에서 이미 실제값(카테고리별)으로 해결했지만, **입출고비·쿠폰·광고비 등은 여전히 추정치였다.** WING의 "정산현황" 페이지를 캡처해서 이것도 해결했다.

```
POST https://wing.coupang.com/tenants/rfm/v2/settlements/profit-status/search
바디: {"recognitionDateFrom":"yyyy-MM-ddT15:00:00.000Z","recognitionDateTo":"yyyy-MM-ddT15:00:00.000Z"}
      (UTC ISO 시각. T15:00:00Z = KST 자정이므로, "from=D일 15:00Z, to=(D+n)일 15:00Z"가
       KST 기준 D~D+n-1일 구간을 뜻하는 것으로 보임 — 정확한 경계는 실측으로 재확인할 것)
응답: {
  profitAmount, profitToSalesRatio,
  totalSalesAmount, totalRefundedSalesAmount, totalSalesAmountWithRefund,
  totalDeductionAmount, totalInventoryCompensationAmount,
  profitStatusDeductionDetail: {
    totalWarehousingFeeAmount, totalFulfillmentFeeAmount, totalStorageFeeAmount,
    totalBarcodeLabelingFeeAmount, totalContainerUnloadingFeeAmount,
    totalCreturnGradingFeeAmount, totalCreturnReverseShippingFeeAmount,
    totalVreturnHandlingFeeAmount, totalVreturnShippingFeeAmount,
    totalCfsVatAmount, totalCfsAmountWithVat,        ← 위 입출고비 항목들의 합계(VAT포함)
    totalTakeRateAmountWithVat,                       ← 확정 판매수수료(VAT포함)
    totalSellerInstantDiscountAmount, totalSellerCreditDiscountAmount,
    totalSellerDownloadDiscountAmount, totalSellerDiscountAmount,  ← 판매자 쿠폰 비용 합계
    totalAdDeduction, totalCoupangLiveDeduction, totalMilkrunDeduction,
    totalRocketGrowthSaverDeduction, totalRocketGrowthBusinessInsightsDeduction,
    totalRecurringServicesAmount, totalPostPurchaseServiceFeeAmount, totalPostPurchaseIncentiveAmount
  },
  profitStatusBenefitDetail
}
```

**계산 공식을 실제 캡처값으로 검산해서 100% 확인함(2026-08-15)**:
```
totalCfsAmountWithVat = 창고비+풀필먼트비+보관비+(그 외 반품처리비 등, 이번 캡처는 대부분 0)+VAT
totalDeductionAmount  = totalCfsAmountWithVat + totalTakeRateAmountWithVat + totalSellerDiscountAmount
                        + totalAdDeduction + totalCoupangLiveDeduction + totalMilkrunDeduction
                        + totalRocketGrowthSaverDeduction + totalRocketGrowthBusinessInsightsDeduction
                        + totalRecurringServicesAmount + totalPostPurchaseServiceFeeAmount
profitAmount          = totalSalesAmountWithRefund - totalDeductionAmount + totalInventoryCompensationAmount

실제 캡처값(2026-08-04~07 구간): 15,374 + 8,364 + 4,600 + 0 + 0 + 14,300 = 42,638 = totalDeductionAmount ✓
                                 75,000 - 42,638 = 32,362 = profitAmount ✓
```

**결정적 한계 — 옵션(vendorItemId)별로 안 쪼개진다.** `sold-vendor-item-list`와 달리 이건 **계정 전체 합계**만 준다. 그래서 "이 옵션의 정확한 마진"은 여전히 못 만들고, "이 기간 전체의 확정 매출·비용·순이익"만 만들 수 있다 — 판매현황의 옵션별 표에 합치지 말고 **별도의 "확정 정산 요약" 구역**으로 보여주는 게 맞다.

**세션 기반이라 4-4-2와 같은 제약**(VPS 무인 cron 불가, 확장프로그램 경로 필요)이 그대로 적용된다. **"D-1부터 조회 가능"**(사용자 제보) — 다만 이건 아직 실측으로 검증 못 함(테스트 중엔 항상 아래 인증 함정에 걸려서 진짜 데이터 부족 때문인지 구분이 안 됐음). 실제로 최신 1~2일 범위가 계속 비면 이게 원인일 수 있음 — 확인되면 여기 업데이트할 것.

**결정적 함정(2026-08-15, 실제로 겪고 최종 해결함) — `x-xsrf-token` 헤더 없이는 로그인 세션이 있어도 거부된다.** 처음엔 "Failed to fetch"만 보여서 페이지별 CSP 문제로 오인하고, `https://wing.coupang.com/tenants/rfm/settlements/home` 페이지로 먼저 이동시키는 우회를 시도했지만(및 백그라운드에서 직접 fetch하는 시도도) 둘 다 실패했다. **`interceptor.js`에 요청 헤더까지 저장하도록 캡처를 확장(`saveSalesCapture`에 `headers` 인자 추가)해서 실제 정산현황 페이지가 보내는 요청을 헤더까지 캡처하고 나서야 원인이 드러났다**: 이 API는 세션 쿠키와는 별개로 **`x-xsrf-token` 헤더**를 요구하는 CSRF 이중제출 패턴을 쓴다 — 이 헤더가 없으면 서버가 `https://helpseller.coupang.com/access/logout`으로 리다이렉트시키고, 그 리다이렉트 응답에 CORS 헤더가 없어서 브라우저가 그냥 `"Failed to fetch"`로만 보여준 것(진짜 원인은 콘솔에 별도로 뜨는 CORS 에러 메시지에 있었다 — 요약 로그만 보고는 못 찾았음).

**최종 해결책**: 쿠키 `XSRF-TOKEN` 값을 `document.cookie`로 읽어서 그대로 `x-xsrf-token` 헤더에 실어 보내면 된다(`extension/background.js`의 `pageFetchProfitStatus()`). 쿠키는 페이지 컨텍스트에서만 읽히므로(백그라운드 서비스워커에선 `document`가 없음) 반드시 `chrome.scripting.executeScript`로 페이지 안에서 호출해야 한다 — **페이지 이동(정산현황 페이지로 갈 필요)은 불필요했다**, 인증 헤더만 맞으면 WING 탭이 어느 페이지에 있든 호출된다(`sold-vendor-item-list`와 동일). **다른 WING 내부 API를 새로 추가할 때 "Failed to fetch"를 만나면, 페이지 이동보다 먼저 이 패턴(요청 헤더 캡처 → `x-xsrf-token` 같은 CSRF 헤더 누락 의심)부터 확인할 것.**

덤으로 `POST /tenants/rfm/v2/settlements/upcoming-settlement/search`(바디: `{"currentDate":"...Z"}`)도 같이 발견함 — 앞으로 들어올 정산 스케줄(주 단위, `settlementPeriodStartDate/EndDate`, `paymentRatio`, `paymentAmount`, `finalSettlementAmount` 등)을 준다. 판매현황과는 성격이 달라서(현금흐름 예정표) 이번 작업엔 안 쓰지만, 나중에 "정산 예정" 같은 별도 페이지를 만들 때 쓸 수 있음. 캡처된 요청 헤더를 보면 이것도 같은 `x-xsrf-token`을 쓰므로, 나중에 붙일 때 `pageFetchProfitStatus()`와 똑같은 패턴(쿠키에서 토큰 읽어 헤더에 싣기)을 그대로 쓰면 됨.

**구현 완료·실사용 검증됨(2026-08-15).** 판매현황 탭에서 실제로 "정산 M건"이 0이 아닌 값으로 뜨는 것까지 사용자가 최종 확인함. `rocket_growth_profit_daily`(`db/migrations/010`)에 저장되고, `web/app.js`의 판매현황 일별표(`renderDailyTable()`)/상단 요약표(`renderPeriodCards()`)가 이 값을 읽어 보여준다(2026-08-15 UI 개편으로 `renderProfitSummary()` 카드는 없어졌음 — `web/CLAUDE.md` 참조).

### 4-4-5. recognitionDateTo 경계 버그 — 하루치 조회가 다음날 데이터까지 합산하고 있었음 (2026-08-15, 발견·원인규명·수정 완료)

사용자가 WING "수익 현황" 위젯에서 **2026-08-14 하루만** 선택해 실제 값(매출 60,000 / 비용 68,313 / 이익 −8,313)을 스크린샷으로 제시 → `rocket_growth_profit_daily`에 저장된 8/14 행과 대조해보니 **7개 필드 전부**에서 "저장된 8/14 값 − 저장된 8/15 값 = 위젯의 진짜 8/14 값"이 정확히 일치했다(순매출 91,800−31,800=60,000, 총공제 85,577−17,264=68,313, 광고비 37,508−0=37,508, 입출고비 36,810−15,160=21,650, 수수료 10,859−4,004=6,855, 쿠폰 400−(−1,900)=2,300, 이익 6,223−14,536=−8,313 — 전부 위젯값과 일치). 즉 **"8/14"로 조회한 결과가 사실 8/14+8/15 두 날짜 합산이었다.**

**원인 확정(실측 캡처, 2026-08-15)** — 사용자가 WING 정산현황 페이지에서 하루(8/14)만 선택했을 때 WING 프론트 자신이 실제로 보낸 요청을 팝업 "판매현황 API 캡처 보기"로 캡처:
```
{"recognitionDateFrom":"2026-08-13T15:00:00.000Z","recognitionDateTo":"2026-08-13T15:00:00.000Z"}
→ 응답: profitAmount:-8313, totalSalesAmountWithRefund:60000, totalDeductionAmount:68313,
   totalAdDeduction:37508, totalCfsAmountWithVat:21650, totalTakeRateAmountWithVat:6855,
   totalSellerDiscountAmount:2300  ← 위젯 스크린샷과 전부 정확히 일치
```
**WING 자신은 `recognitionDateFrom`과 `recognitionDateTo`에 완전히 같은 값을 넣는다** — 둘 다 "(대상일−1)일 T15:00:00.000Z"(=KST로 대상일 00:00:00 정각). 우리 `pageFetchProfitStatus()`는 `recognitionDateTo`에 `dateStr T15:00:00.000Z`(=KST로 **다음날** 00:00:00 정각)를 넣고 있었던 게 버그 — 서버가 두 타임스탬프를 KST 캘린더 날짜로 변환해서 그 날짜 범위를 inclusive하게 처리하는 것으로 보이는데, `recognitionDateTo`가 다음날 자정 정각이면 그 날짜(다음날)까지 포함돼버린 것. `recognitionDateFrom`은 애초에 대상일 자신의 00:00:00 정각이라 반대 방향(전날)으로는 새지 않았다.

**"100% 검산"했다고 예전에 적었던 것(4-4-4 상단)은 항목 간 산술적 정합성만 확인한 것이지, 캘린더 경계가 실제로 정확한지는 검증한 적이 없었다** — 이번이 그 첫 검증이었고 어긋난다는 게 여기서 처음 드러났다.

**수정 완료(2026-08-15)** — `extension/background.js`의 `pageFetchProfitStatus()`에서 `recognitionDateTo`를 `recognitionDateFrom`과 동일한 값(`${fromDateStr}T15:00:00.000Z`)으로 맞췄다. **과거 데이터 수동 백필 불필요** — 판매현황 탭을 다시 열면 "오늘+어제" 자동 재동기화로 최근 날짜는 저절로 덮어써진다. 이 버그가 있던 기간에 동기화된 더 과거 날짜(있다면)는 여전히 이틀치 합산값으로 남아있을 수 있음 — 발견 당시 DB엔 8/14·8/15 두 행만 있었으니 실질적으로 8/14 하나만 영향받았고 다음 재동기화로 자동 정정된다.

### 4-4-6. WING 재고현황 API — 상품별 실제 개당 수수료·입출고비·보관비 (2026-08-16, 캡처 성공)

지금까지 상품/옵션별 상세표는 카테고리 요율표 기반 추정(`commissionFor()`/`feeFor()`)만 썼는데, 사용자가 WING 재고현황 페이지의 "예상(개당)" 툴팁(판매수수료+입출고·배송비용 분해)과 "이번달 누적보관비"를 스크린샷으로 제시 → 이게 카테고리 추정보다 정확한 **쿠팡이 그 상품에 직접 매긴 실제값**이라는 걸 확인하고 조사 시작. 일반 API 로그(`__cwc_api_log`, 팝업 "캡처된 API 호출 목록")로 후보를 추리고 `SALES_PATHS`에 등록한 뒤 재캡처.

```
POST https://wing.coupang.com/tenants/rfm-inventory/inventory-health-dashboard/search
바디: {"paginationRequest":{"pageSize":10,"pageNumber":N,"searchAfterSortValues":cursor|null},
      "hiddenStatus":"VISIBLE","sort":[{"sortParameter":"ORDERABLE_QUANTITY","sortDirection":"DESCENDING"}],
      "rrqContext":{"source":"IHD","eventType":"RRQ_SEEN","metadata":"{}"}}
응답: {"viProperties":[{
  "vendorItemId", ...,
  "settlementStatistics": {
    "takeRateAmount":{"amount"},        ← 개당 판매수수료 (WING "예상(개당)" 툴팁의 "판매수수료"와 일치)
    "fulfillmentFee":{"amount"},
    "warehousingFee":{"amount"}         ← 이 둘의 합이 툴팁의 "입출고·배송비용"과 정확히 일치(실측 검산: 1925+1000=2925)
  },
  "inventoryDetails": {
    "storageFee": {"monthlyStorageFeeAmount":{"amount"}}  ← "이번달 누적보관비"와 일치(실측 14,670원 일치)
  }
}], "paginationResponse": {"pageNumber","pageSize","totalNumberOfElements","searchAfterSortValues"}}
```

**페이지네이션은 커서 기반(ES 스타일 search_after)** — 첫 요청은 `searchAfterSortValues:null`, 다음 요청부터는 직전 응답의 `paginationResponse.searchAfterSortValues`를 그대로 실어 보낸다. `pageSize`는 WING 프론트가 실제 보내는 값(10) 그대로 씀 — 더 크게 요청해도 되는지 확인 안 해봤고, 임의로 늘리면 거부당할 수 있어 시도 안 함(절대 바꾸지 말 것 규칙 1과 같은 이유).

**인증은 기존 정산현황 API와 동일한 `x-xsrf-token` 쿠키 패턴** — 새로 풀 함정 없었음.

**`storage-fee-modal/{vendorItemId}`(GET, 재고 상세 모달)도 같이 캡처했지만 원화 요율은 안 줌** — `skuAgeBuckets`(보관기간 구간별 `stowedQuantity`, 수량만)만 응답에 있고, 스크린샷에 보이던 "제품 1개당 1일 보관비"(원 단위, 기본/프로모션/최종 분해) 값은 이 API 응답 어디에도 없다. 지금 목표(상품별 순이익 추정)엔 `inventory-health-dashboard/search`의 `monthlyStorageFeeAmount`만으로 충분해서 더 조사 안 함 — 나중에 일별 보관비 원화 요율이 꼭 필요해지면 이 API 응답에 안 나온 다른 소스를 다시 찾아야 함.

**`pricing-info/{vendorItemId}`(GET)는 아직 응답을 못 봤다** — `SALES_PATHS`에 후보로만 등록해뒀음. 나중에 웹에 가격 수정 기능을 만들 때, 가격 바꾼 상품 하나만 전체 페이지네이션 없이 빠르게 재조회하는 용도로 쓸 수 있을지 그때 확인할 것(아래 "상품별 원가정보 스냅샷" 참고).

**구현 완료(2026-08-16)** — `extension/background.js`의 `syncItemCosts()`/`pageFetchInventoryHealth()`가 전체 상품을 끝까지 페이지네이션해서 `rocket_growth_item_cost_snapshots`(`db/migrations/012`)에 저장한다. 자세한 설계(왜 덮어쓰지 않고 이력으로 쌓는지, 가격 변경 시점과의 연동 계획)는 `extension/CLAUDE.md`, 웹에서 이 값을 쓰는 방식은 `web/CLAUDE.md` 참조.

### 4-5. 이익 계산에 필요한 나머지 조각
원가는 애초에 쿠팡 API 어디에도 없다 — 이미 있는 `user_items.cost_cny`를 써야 한다. 주문 API의 `vendorItemId`로 `product_items.vendor_item_id`를 조인하면 연결된다. 마진 계산은 3번의 `calcMargin()`을 그대로 재사용(별도 계산식 새로 만들지 말 것 — `web/CLAUDE.md` 규칙).

### 4-6. 아키텍처 — secretKey는 브라우저에 두면 안 됨, 그리고 IP 화이트리스트도 있음

**secretKey**: `web/`은 정적 사이트지만 배포처가 **Vercel**로 확인됨(`docs/decisions.md` 참조) → 브라우저에 두면 안 되는 값은 서버리스 함수에서만 다뤄야 함.

**IP 화이트리스트(중요, 처음엔 몰랐던 함정)**: 쿠팡 Open API는 accessKey 발급/수정 시 WING에 등록한 IP(최대 10개)에서만 호출을 허용한다. 등록 안 된 IP는 명확한 JSON 403(`"Your ip address ... is not allowed"`)으로 막힌다. **문제는 등록해도 끝이 아니라는 것** — 쿠팡 API 앞단에 별도 WAF/CDN이 있어서, 화이트리스트를 통과해도 **데이터센터/프록시 성격의 IP는 또 다른 종류의 차단(JSON이 아니라 쿠팡 로고 박힌 HTML "Access denied" 페이지)을 당할 수 있다.** 유료 프록시(Webshare) IP를 두 개나 바꿔봐도 똑같이 막혔음 — 프록시 업체의 IP 대역 자체가 이미 블랙리스트에 걸려있는 것으로 추정.

**결론: 진짜 해결책은 프록시 구매가 아니라 "고정 IP 있는 평범한 서버에서 직접 호출"이다.** 최종 아키텍처(커밋 `aa7e988`):
```
GCP e2-micro 무료 VPS(고정 IP) → scripts/rocket-growth-sync.js가 cron으로 쿠팡 직접 호출
  → Supabase rocket_growth_sales_daily 테이블에 upsert (db/migrations/005)
  → web/app.js의 loadSales()는 이 테이블만 읽음 (브라우저/Vercel에서 쿠팡 API 실시간 호출 안 함)
```
`web/api/sales-today.js`(Vercel 서버리스 함수) + `PROXY_URL`은 1차 시도의 잔재로 코드에 남아있지만 더는 안 씀(폴백용으로 삭제 안 함).

VPS 스크립트가 Supabase에 쓸 때 `service_role` 키를 쓰지 않는다 — "secret 키를 어떤 파일에도 넣지 말 것" 규칙을 VPS의 로컬(비 git) `.env`까지 지켰다. 대신 관리자 계정(`SB_ADMIN_EMAIL`/`SB_ADMIN_PASSWORD`)으로 로그인해 `is_admin()` RLS로 쓰기 권한을 얻는다(확장프로그램과 같은 방식).

---