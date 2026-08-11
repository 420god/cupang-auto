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