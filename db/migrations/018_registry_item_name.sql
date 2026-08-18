-- ============================================================
-- 018. rocket_growth_product_registry에 item_name(옵션명) 추가
--
-- 새 API 호출이 늘어나는 게 아니라, 이미 받고 있던 상품목록 응답의
-- items[].itemName을 그냥 버리고 있던 걸 저장하는 것뿐이다(011/013과 같은 패턴).
--
-- 왜 지금 필요한가: 상품원장(my_skus.sku_name)을 만들 때 "상품명 + 옵션명"이
-- 필요한데, 지금까지 레지스트리엔 상품명(seller_product_name)만 있고 옵션명이
-- 없어서 옵션을 구분할 수 없었다. 옵션명은 단건조회(query-product)에도 있지만
-- 그건 상품 수만큼 호출해야 하는 무거운 API라, 목록 API에서 이미 오는 값을
-- 버리지 않는 게 맞다.
-- ============================================================

alter table rocket_growth_product_registry
  add column if not exists item_name text;
