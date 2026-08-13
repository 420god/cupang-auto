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

```
개당 원가(원) = cost_cny × exchange_rate(기본 320)
정산예상액   = 판매가 - 수수료(판매가×10.8%) - 입출고비
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

**그래서 사용자와 합의한 방식(2026-08-13):** 판매현황 탭은 4-1의 실시간 주문 데이터에 **가정 수수료율 10.8%**(위 3번 마진계산 공식과 동일 기본값)를 적용한 **추정치**로 표시한다. 나중에 정산내역조회가 실제로 로켓그로스에서 동작하면 그 값으로 검증/보정하는 걸 별도 작업으로 남겨둔다.

### 4-5. 이익 계산에 필요한 나머지 조각
원가는 애초에 쿠팡 API 어디에도 없다 — 이미 있는 `user_items.cost_cny`를 써야 한다. 주문 API의 `vendorItemId`로 `product_items.vendor_item_id`를 조인하면 연결된다. 마진 계산은 3번의 `calcMargin()`을 그대로 재사용(별도 계산식 새로 만들지 말 것 — `web/CLAUDE.md` 규칙).

### 4-6. 아키텍처 — secretKey는 브라우저에 두면 안 됨
`web/`은 정적 사이트지만 배포처가 **Vercel**로 확인됨(`docs/decisions.md` 참조) → `web/api/sales-today.js` 하나 추가하면 번들러 없이 서버리스 함수로 동작. secretKey는 Vercel 환경변수에만 두고, 이 함수가 서명·호출까지 하고 집계 결과만 클라이언트에 반환한다. 클라이언트(app.js)는 그 결과 + Supabase 원가를 합쳐 화면에 그린다.

**막힌 것(2026-08-13 기준): 사용자가 아직 accessKey/secretKey/vendorId 미발급.** WING 로그인 후 Open API 신청은 사용자만 할 수 있어서 여기서 막힘. 발급받으면 `web/api/sales-today.js` 실제 구현·서명 검증 진행.

---