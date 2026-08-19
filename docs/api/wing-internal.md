# WING 내부 API (확장프로그램)

> **언제 읽나**: 정산·반품·재고현황 동기화가 안 될 때. 확장프로그램을 고칠 때.
> **최종 검증**: 2026-08-17
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
