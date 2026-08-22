# 쿠팡 공식 Open API

> **언제 읽나**: 상품·주문 동기화(VPS 스크립트)를 고칠 때. 레지스트리가 0행일 때.
> **최종 검증**: 2026-08-20 (가격 변경 실물 성공 · 상품 수정 정찰)
> **관련 코드**: `scripts/rocket-growth-sync.js`

## 호출 구조

```
GCP VPS (고정 IP) → 쿠팡 Open API → Supabase → 웹
```

**쿠팡은 WING에 등록한 IP에서만 호출을 허용한다**(그 외 403). Vercel 서버리스는 고정 IP가
없어서 못 쓴다 — 그래서 VPS다. 유료 고정 IP 프록시로 우회하는 시도까지 해봤지만 쿠팡 WAF가
IP 대역째로 막았다(`../archive/2026-08-18-decisions.md`). **이 길은 닫혀 있다 — 다시 시도하지 말 것.**

인증: `CEA algorithm=HmacSHA256`. 서명 메시지 = `datetime + method + path + query`.

## 쓰는 엔드포인트

| 용도 | 경로 | 채우는 테이블 |
|---|---|---|
| 주문 조회 | `/v2/providers/rg_open_api/.../rg/orders` | `rocket_growth_sales_daily` |
| 상품 목록 페이징 | `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products` | `rocket_growth_product_registry` |
| 상품 단건 조회 | 위 + `/{sellerProductId}` | `my_skus` (바코드) |

## 필드명 함정 — 1년 가까이 조용히 0행을 넣고 있었다 → R-12

**목록 API의 실제 구조**
```
items: [{
  itemName,
  marketPlaceItemData:  { sellerProductItemId, vendorItemId },
  rocketGrowthItemData: { sellerProductItemId, vendorItemId }   ← 옵션ID는 이 안
}]
```

`docs/api-notes.md`에 2026-08-17에 **`rocketGrowthItem`(뒤에 `Data` 없이)으로 잘못 적었고**
코드가 그걸 그대로 따랐다. `sellerProductItemId`도 `items[]` 바로 아래가 아니라 **그 안쪽**이고,
**`vendorInventoryItemId`는 응답에 아예 없다**(있다고 적어뒀었다).

그래서 `--products` 크론이 매일 돌면서 **모든 옵션을 버리고 0행을 넣었다.**
`upsertProductRegistry()`가 `if (!rows.length) return;`이라 에러도 안 났다.

**재발 방지**: 첫 페이지 첫 상품을 `scripts/_sample_seller_product.json`에 항상 덤프하고,
버려진 개수를 경고로 출력한다. "조회 N건 → 저장 0행"을 조용히 넘기지 않는다.

## 엔드포인트 간 대소문자가 다르다

| 엔드포인트 | 마켓플레이스 필드명 |
|---|---|
| 목록 `seller-products` | `marketPlaceItemData` (대문자 P) |
| 단건 `query-product` | `marketplaceItemData` (소문자 p) |

같은 개념인데 철자가 다르다. `pickBarcode()`/`pickVendorItemId()`는 두 철자를 다 본다.

## 바코드 — 이 시스템의 조인키

**단건 조회에만 있다**(목록엔 없다). 위치:
```
items[].rocketGrowthItemData.barcode   "S0038265161756"   ← 진짜 값
items[].marketplaceItemData.barcode    ""                 ← 빈 문자열
```
**반드시 로켓그로스 쪽을 먼저 보고, 빈 문자열은 "없음"으로 취급한다.**

형태: `S00` + `rocketGrowthItemData.sellerProductItemId`
실측 10건이 전부 이 규칙을 따랐다. **다만 이 규칙으로 계산해서 쓰지는 말 것** — API가 준 값을 쓴다.

값이 WING 상품수정 화면 및 쿠플러스 구매요청 입력값과 **셋 다 일치**함을 사용자가 직접 대조 확인했다.

## SKU ID(WING 8자리)는 어디에도 없다

조사한 세 API 어디에도 자릿수가 맞는 필드가 없다(`itemId` 10자리, `sellerProductItemId` 11자리).
재고 페이지에서 정말 필요해지면 WING 내부 API를 다시 캡처해야 한다.

## 광고 리포트 (별도 경로)

`advertising.coupang.com` 대시보드에서 어제 기준 엑셀 다운로드. **아직 미연동.**

컬럼에 **광고집행 옵션ID**와 **광고전환매출발생 옵션ID**가 **둘 다** 있어서 SKU 단위 ROAS가 가능하다.

**함정**: 두 옵션ID가 다른 행이 실제로 있다(핑크에 광고비를 썼는데 퍼플이 팔림).
광고비를 어느 SKU에 붙일지 **귀속 규칙을 명시적으로 정해야 한다**(집행 기준 vs 전환 기준).
1일/14일 어트리뷰션, 직접/간접도 따로 나오므로 어느 값을 순이익에 쓸지도 결정 대상.

## 실행

```bash
cd /home/thezone1633/cupang-auto
node scripts/rocket-growth-sync.js                     # 주문(오늘+어제)
node scripts/rocket-growth-sync.js --products          # 상품 레지스트리
node scripts/rocket-growth-sync.js --skus --skip-orders --limit=5 --dry-run   # SKU 적재 시험
```

`.env`는 `scripts/.env`에 있고 `__dirname` 기준으로 읽으므로 **어느 디렉터리에서 실행해도 된다**.
환경변수가 **7개 한꺼번에** 누락되면 키가 틀린 게 아니라 `.env` 자체를 못 읽은 것이다.

## 쓰기 API (2026-08-20 정찰로 확인)

### 가격 변경 — 실물로 성공 확인

```
PUT /v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{vendorItemId}/prices/{가격}
→ {"code":"SUCCESS","message":"가격 변경을 완료했습니다."}
```

**로켓그로스 옵션ID인데 마켓플레이스 계열 경로가 받는다.** `rg_open_api` 쪽은 404다.
후보를 나란히 던져서 알아냈다 — 한쪽만 짚었으면 못 찾았다.

현재가·판매여부·재고는 같은 계열의 하위 경로에서 읽는다. **옵션 단건 조회(`vendor-items/{id}`)
자체는 404이고 이것만 산다:**
```
GET .../vendor-items/{vendorItemId}/inventories
→ { amountInStock, salePrice, onSale, sellerItemId }
```

### 가격이 두 벌이다 — 옵션ID도 두 개다

같은 상품에 로켓그로스와 마켓플레이스 가격이 따로 붙는다(실측: 7,500 / 13,000).
```
items[].rocketGrowthItemData.priceData.salePrice   vendorItemId 95827571043
items[].marketplaceItemData.priceData.salePrice    vendorItemId 95827571044
```
**우리가 다루는 건 로켓그로스 쪽이다.** `rocket_growth_product_registry.vendor_item_id`에
이미 그쪽이 들어 있다(`pickVendorItemId()`가 rocketGrowthItemData를 먼저 보므로).
여기를 헷갈리면 엉뚱한 가격이 바뀐다.

### 상품 수정은 부분 수정이 안 된다

몸통을 키워가며 던져본 결과(대상은 존재하지 않는 상품이라 안전했다):
```
업체코드만        → "업체상품아이디를 입력해주세요"
+ 상품ID          → "시스템이 불안정합니다"    ← 검증 메시지가 아니다. 서버가 터진 것
+ 상품명·카테고리  → "시스템이 불안정합니다"
전체 23개 키      → "로켓그로스 입고 불가 조건을 확인하시고 동의해주세요"
```
**전체 몸통을 보내야 비로소 정상 검증 단계로 들어간다.** 상품명 하나 바꾸려 해도
상품 전체를 다시 보내야 하고, 빠뜨린 필드는 지워진다.

### legalAgreement = "AGREE" (2026-08-20 실물 확인)

**값은 불리언이 아니라 문자열 `"AGREE"`다.** 문서엔 이름만 있고 타입이 없어서
후보를 나란히 던져 가렸다:
```
true    → "로켓그로스 입고 불가 조건을 확인하시고 동의해주세요"
"AGREE" → "[중복된 바코드가 존재합니다., 업체코드가 잘못 되었습니다.]"   ← 통과
"Y"     → (동의 메시지 그대로)
"true"  → (동의 메시지 그대로)
```
"AGREE"일 때 나온 두 에러가 **필드 검증을 다 통과했다는 증거다** — 바코드 중복은
실제 상품의 옵션을 그대로 보냈으니 당연하고, "업체코드가 잘못 되었습니다"는
존재하지 않는 상품(sellerProductId=1)의 **소유권 검증**에서 막힌 것이다.

계정 단위 동의(WING)는 이미 되어 있었다. 막던 건 몸통에 빠진 이 필드 하나였다.

### legalAgreement — 조회에 안 나오는 쓰기 전용 필드

필수 최상위 필드에 `rocketGrowthAdditionalInformation`이 있고 그 안에
`rfmInboundName`과 **`legalAgreement`**가 들어간다. 그런데 **조회 응답에는
`rfmInboundName`만 있다.** 즉 "조회한 걸 그대로 되보내면 된다"가 성립하지 않는다.

그리고 계정 단위 동의가 따로 필요하다:
**WING > 판매자정보 > 추가정보 > "OPEN API key 발급" 영역 >
"로켓그로스 상품 생성 API 이용 및 심사 기준 동의"**

### 이미지 CDN 주소 (2026-08-20 실물 확인)

```
https://image1.coupangcdn.com/image/{cdnPath}   → 200 image/png
```
**`/image/` 접두사가 필요하다.** 없으면 403이다. 호스트는 `image1`·`thumbnail1`·`static`·
`image6`·`image10` 어느 것이든 같은 파일을 준다. 오래 "미검증"으로 남아 있던 항목인데,
후보 호스트에 실제로 요청을 던져 확인했다.

이걸로 **바꾸기 전 이미지를 우리 쪽에 보관할 수 있게 됐다** — 워커가 PUT 직전에
내려받아 Supabase Storage(`product-images/archive/...`)에 넣는다. 경로 문자열만
남기면 그림은 쿠팡에만 있어서, 쿠팡이 지우면 "이전 썸네일이 뭐였나"를 영영 못 본다.

### 이미지 — 업로드 API가 없다. URL을 주면 쿠팡이 가져간다

전용 업로드 엔드포인트를 찾다가 `/seller-products/images`가 400이라 있는 줄 알았는데,
아무 문자열이나 넣어도 같은 400이었다(`업체상품아이디[...]는 숫자형으로 입력해주세요`).
**경로 파라미터로 먹힌 것이지 엔드포인트가 아니다.**

실제 방식: `images[].vendorPath`에 **`http://`로 시작하는 공개 URL**을 넣으면 쿠팡이
자동으로 내려받아 자기 CDN에 넣는다. **80·443 포트만 된다.**
조회 응답에 파일명만 보이는 건 쿠팡이 저장한 뒤의 결과값이라 입력값과 형태가 다르다.
→ Supabase Storage 공개 URL을 그대로 쓸 수 있다.

상세설명도 같은 그릇이다:
```
contents[] = { contentsType: HTML|IMAGE|TEXT,
               contentDetails[] = { content, detailType: TEXT|IMAGE } }
```
실제 상품은 `contentsType: IMAGE_NO_SPACE` + `detailType: IMAGE`로, 상세페이지가
HTML이 아니라 **이미지 나열**이었다.

### 카테고리 메타 (등록에 필요)

```
GET .../meta/category-related-metas/display-category-codes/{displayCategoryCode}
```
`attributes`(필수/선택), `noticeCategories`(고시정보 4종 택1), `certifications`,
`requiredDocumentNames`를 준다. 실측 카테고리 103112의 필수 속성은 색상·개당 중량·수량.

### 실제로 받아본 응답 (2026-08-21, 카테고리 103353 · 액체괴물/슬라임)

`category_meta` 큐가 **처음으로 실제 동작했다**(그전까진 표와 큐 종류만 있었다).
웹에서 요청 → 워커가 4초 만에 처리 → `coupang_category_meta`에 저장까지 확인.

최상위 키 7개:
```
attributes  certifications  noticeCategories  isAllowSingleItem
requiredDocumentNames  allowedOfferConditions  isExpirationDateRequiredForRocketGrowth
```

| 무엇 | 실측값 |
|---|---|
| `attributes` | 19개. 필수는 `수량`(NUMBER·개), `색상`(STRING). 나머지는 OPTIONAL |
| `noticeCategories` | 5종 중 택1 — 화장품 · 가공식품 · 어린이제품 · 기타 재화 · 생활화학제품 |
| 고시정보 항목 | 종류마다 다르다. '화장품'은 11항목(용량·사용기한·전성분·소비자상담 전화번호 …) |
| `certifications` | 27종 목록. `NOT_REQUIRED`부터 `KC_KID_*`까지 **고르는 값**이다 |
| `requiredDocumentNames` | 조건부 필수(`MANDATORY_PARALLEL_IMPORTED`, `MANDATORY_BATTERY_UN_TEST` …) |
| `isExpirationDateRequiredForRocketGrowth` | **물류 단계와 직결** — 이 값이 true면 유통기한 입력이 필수다 |

`required` 값이 `MANDATORY`/`OPTIONAL` 문자열이다(불리언이 아니다).
카테고리를 바꾸면 필수 속성이 통째로 달라지므로 **카테고리 확정 뒤에 속성 칸을 그린다.**

고시정보 `기타 재화` 5개 항목은 `my_skus`의 `label_*` 컬럼과 거의 그대로 맞물린다
(품명·제조국·제조자). **소비자상담 전화번호만 우리 쪽에 없다.**

## 로켓그로스 물류·바코드는 상품 등록에 안 들어간다 (2026-08-20)

**바코드는 쿠팡이 발급한다.** 우리가 넣는 값이 아니다 —
`S00` + `rocketGrowthItemData.sellerProductItemId` 규칙이고, 등록 후 동기화가 가져온다
(`db/migrations/015` my_skus.barcode 주석: "쿠팡 발급. 실무 조인키").

**박스 규격·무게 같은 물류 값은 상품 응답 어디에도 없다.** 최상위 23키와 옵션 23키를
전부 확인했다. 로켓그로스 전용은 `rocketGrowthAdditionalInformation` 하나뿐이고
그 안에 `rfmInboundName`(입고 시 표기명)과 쓰기 전용 `legalAgreement`가 있다.

### 정정(2026-08-21): 물류 정보는 `rocketGrowthItemData.skuInfo` 안에 있다

위에서 "상품 응답 어디에도 없다"고 적었는데 **틀렸다.** 옵션 최상위 키만 훑고
`rocketGrowthItemData` 안쪽을 안 봐서 놓쳤다. 실물에 이렇게 들어 있다:

```json
"skuInfo": {
  "inboundName": "노트북 파우치 13인치",       // 옵션 단위 입고 표기명
  "width": 424, "length": 280, "height": 60,   // mm
  "weight": 201, "netWeight": null,            // g
  "quantityPerBox": 1,                         // 로켓그로스는 항상 1 (문서 명시)
  "distributionPeriod": 0, "expiredAtManaged": false,   // 유통기한(일) / 관리여부
  "fragile": false, "hazardous": null, "heatSensitive": null, "heavyBulky": null,
  "season": "YEAR_ROUND", "standAlone": false,
  "originalBarcode": null, "originalDimensionInputType": "USER_INPUT"
}
```

### 정정(2026-08-21): skuInfo 는 15개가 아니라 **22개**다

위 예시는 실물의 일부만 옮긴 것이었다. 상품 13건(옵션 13개)의 원문을 받아 전수 확인했다.
**`skuInfo`를 주면 그 객체의 모든 항목이 필수**이므로, 빠진 7개를 모르고 보내면 등록이 깨진다.

| 필드 | 실측 13/13 | 비고 |
|---|---|---|
| `width` `length` `height` `weight` `netWeight` | 상품마다 다름 | mm · g |
| `inboundName` | 상품마다 다름 | **옵션 단위** 입고 표기명 |
| `season` | `"YEAR_ROUND"` | |
| `quantityPerBox` | `1` | 로켓그로스는 항상 1(문서 명시) |
| `fragile` `standAlone` | `false` | 깨짐 / 단독 포장 |
| `expiredAtManaged` | `false` | 소비기한 관리 |
| `producedAtManaged` `manufacturedAtManaged` | `false` | **둘 다 있다.** WING 화면의 "제조일이 적혀 있나요?"가 어느 쪽인지는 **미확인** |
| `distributionPeriod` | `0` | 유통기한(일) |
| `hazardous` `heatSensitive` `heavyBulky` | `null` | |
| `year` `vendorFlexCode` `rocketInstallation` | `null` | 처음 보는 필드. 용도 미확인 |
| `originalBarcode` | **`null` 13/13** | ↓ |
| `originalDimensionInputType` | `"USER_INPUT"` | 규격을 사람이 넣었다는 뜻 |

### 바코드 — "상품 바코드가 없어요"는 `originalBarcode: null` 이다

이 계정 상품 13건이 **전부 `originalBarcode: null`** 이고, 전부 쿠팡 발급 바코드
(`rocketGrowthItemData.barcode` = `S00…`)를 쓰고 있다. WING에서 "상품 바코드가 없어요"를
체크한 상태와 일치한다.

**다만 역방향은 확인 못 했다** — 자체 바코드를 넣으면 이 필드에 들어가는지는
그렇게 등록해본 적이 없어서 모른다. 우리 기본값이 쿠팡 발급(D-02)이라 당장은 상관없지만,
**자체 바코드 경로는 미검증**이라는 걸 화면이 말해야 한다.

**단위**(문서 확인): `width`·`length`·`height` = mm, `weight`·`netWeight` = g.

**중요한 제약**: skuInfo 는 선택적 객체지만 **주기로 하면 그 객체의 모든 항목이 필수**다.
일부만 넣으면 오류가 난다 → 복제 원본의 skuInfo 에 **덮어쓰는** 방식이어야 한다.

**복제에서 놓치기 쉬운 자리 둘**:
· `skuInfo.inboundName` 은 **옵션 단위** 입고명이다(상품 단위 `rfmInboundName` 과 별개).
  둘 다 안 바꾸면 창고에 원본 상품·옵션의 이름표가 붙는다.
· 규격·무게가 그대로 따라온다. 새 상품 크기가 다르면 틀린 값으로 등록된다.

WING 화면의 "지금 입력 / 나중에 입력"은 이 skuInfo 를 등록 때 채울지 나중에 채울지의
선택이다. 기본값이 "나중에 입력"이라 **필수는 아니다.**

→ **확인됨(2026-08-20, WING 화면).** 상품 등록 화면의 "로켓그로스 물류 입고 정보"는
   `지금 입력 / 나중에 입력` 선택이고 **기본값이 "나중에 입력"**이다.
   안내 문구: "로켓그로스 입고 생성 페이지에서 다시 입력할 수 있습니다."
   즉 **입고 규격은 등록의 필수 조건이 아니고 별도 입고 신청 단계의 일이다.**
   상품 등록 = 카탈로그에 올리는 것, 입고 신청 = 물건을 물류센터로 보내는 것으로 갈린다.
   우리 복제 등록은 이 필드를 건드리지 않으므로 기본값("나중에 입력")과 같은 상태가 된다.

**복제할 때 rfmInboundName 을 반드시 새 상품명으로 바꾼다** — 안 바꾸면 창고에
원본 상품의 이름표가 붙는다. 조회 응답에 들어 있어서 그대로 복제되기 쉬운 함정이다.

## 상품 상태와 임시저장 (2026-08-21 공식 문서 확인)

```
검토 중 · 임시저장 · 승인 대기중 · 승인됨 · 부분 승인 · 승인 거부 · 상품 삭제
```
흐름: **상품 생성 → 임시저장 → (승인요청) → 승인대기중 → 승인됨**
문서에 "승인 요청은 임시저장 상태에서만 가능"하다고 되어 있다.

→ **등록 시 `requested: false` 면 임시저장으로 들어간다.** 별도의 임시저장 API가
   따로 있는 게 아니다. `requested: true` 면 생성과 동시에 승인요청까지 간다.

한동안 헷갈렸던 지점: 정찰에서 본 **기존 상품이 `requested: false` 인데
`statusName: "승인완료"`** 였다. 이걸 보고 "requested 는 임시저장 여부가 아니다"라고
읽었는데, **승인이 끝난 뒤 requested 가 다시 false 로 돌아간 것**으로 보는 게 맞다.
즉 requested 는 "지금 승인 요청 중인가"이고, 신규 생성 시에는 "임시저장에 머물 것인가"를
가른다. 하나의 응답 스냅샷만 보고 필드 의미를 단정하면 이렇게 어긋난다.



## 카테고리 속성 = 필수속성 + 검색필터 (2026-08-21 캡처 대조로 확정)

`category-related-metas` 의 `attributes` 하나가 WING 화면 **두 곳**으로 갈린다.

| `required` | WING 화면 | 우리 화면 |
|---|---|---|
| `MANDATORY` | **옵션** 영역 (수량·색상·개당 중량) | 옵션·가격 + 등록 시 자동 채움 |
| 그 외(`OPTIONAL`) | **검색필터** 영역 | 검색필터 화면 |

103112 실측: 전체 28 = 필수 3 + 선택 25. WING 검색필터 캡처의 항목이 그 25개와 일치했다.

### 입력 방식도 메타가 알려준다 — 지어내지 말 것

```json
{ "attributeTypeName": "선물포장 타입", "required": "OPTIONAL",
  "dataType": "STRING", "inputType": "SELECT",
  "inputValues": ["바구니","보자기","부직포가방","선물박스","선물박스 + 쇼핑백","쇼핑백"],
  "usableUnits": [], "basicUnit": "없음", "exposed": "NONE", "groupNumber": "NONE" }
```

| 조합 | 화면 | 103112 개수 |
|---|---|---|
| `SELECT` + `inputValues` | 드롭다운 | 28 |
| `INPUT` + `usableUnits` | 숫자 + 단위 선택(예: 아이템 높이 = cm·mm) | 11 |
| `INPUT` + 단위 없음 | 자유 입력 | 8 |

**값은 단위를 붙여 저장한다** — 실측 상품의 값이 `"70g"` · `"1개"` 형태였다.

### 옵션명은 필수속성의 조합으로 보인다

실측: `itemName "감자색 70g 1개"` ↔ `attributes 색상=감자색 · 개당 중량=70g · 수량=1개`.
WING 옵션 화면도 `수량 [숫자] [개/박스/세트] [추가]` 로 옵션을 만들고,
검색필터를 열면 **"옵션을 먼저 설정해주세요"** 라고 막는다.
→ 순서가 **카테고리 → 옵션(필수속성) → 검색필터** 라는 뜻이다.
