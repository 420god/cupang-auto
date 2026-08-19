# web/

정적 파일 그대로 Vercel에 올린다. **프레임워크·번들러 도입 금지** — 사용자가 "복잡한 과정 없이"를
명시했다. `api/*.js`는 예외(Vercel이 번들러 없이 함수로 인식).

```
index.html  로그인 + 11개 화면 + 모달
style.css   CSS 변수 기반 라이트/다크
app.js      전체 로직. 빌드 없음
api/        서버리스 함수 (sales-today.js=안 씀, parse-invoice.js=청구서 읽기)
```

## 절대 바꾸지 말 것

1. **마진 계산은 `calcMargin()` 하나로 통일한다** — 다른 곳에서 계산식을 새로 쓰지 않는다.
   고칠 땐 `docs/domain/cost-model.md`의 검산 예시와 대조할 것
2. **`recalcRow()`의 디바운스(600ms)를 제거하지 않는다** — 타이핑마다 API가 나간다
3. **`user_items`/`item_calc` 쓰기에서 `on_conflict=user_id,item_id`를 빼지 않는다** —
   빼면 사용자 간 데이터가 덮어써진다(RLS는 읽기만 막는다)
4. **확장프로그램 호출(`syncSalesViaExtension`)이 실패해도 판매현황은 항상 동작해야 한다**

## 알아둘 것

- `calcMargin()`은 `commission`이 null이면 통째로 null을 반환한다 → 호출 전에 null 체크하고
  "수수료 정보 없음"을 보여준다. `costKrw`가 있으면 실제 매입원가를 쓰고, 없을 때만 `costCny`로 떨어진다
- `state.readyForMargins`에 **새 비동기 로딩을 추가하면 반드시 여기에도 넣는다** —
  안 넣으면 잘못된 "정보 없음"이 캐시에 영구히 굳는다
- 표에 컬럼을 추가·삭제하면 `index.html`의 `<th>` 수와 `app.js`의 `colspan`을 **둘 다** 고친다

## 상세

| 주제 | 문서 |
|---|---|
| 판매현황 계산 전체 | `../docs/domain/sales-profit.md` |
| 원가·선입선출 | `../docs/domain/cost-model.md` |
| 발주·입고·출고 화면 | `../docs/domain/inventory-flow.md` |
| 청구서 인식 | `../docs/domain/invoice-parsing.md` |
| 재발주 제안 공식 | `../docs/domain/reorder.md` |
| 소싱·수수료 매칭 | `../docs/domain/sourcing.md` |
