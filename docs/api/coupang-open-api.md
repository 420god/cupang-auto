# 쿠팡 공식 Open API

> **언제 읽나**: 상품·주문 동기화(VPS 스크립트)를 고칠 때. 레지스트리가 0행일 때.
> **최종 검증**: 2026-08-19 (필드명 수정 후 57행 적재 확인)
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
