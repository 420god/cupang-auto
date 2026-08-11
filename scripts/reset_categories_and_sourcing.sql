-- 카테고리 + 소싱 데이터 전체 초기화 (테스트 재시작용)
-- Supabase SQL Editor에 붙여넣어 실행하세요.
--
-- categories를 지우면 FK cascade로 아래도 함께 지워집니다:
--   products -> product_items -> user_items / item_calc
--   user_category_favorites (categories 참조, cascade)
--   item_history는 FK가 없어서 trg_cleanup_history 트리거로 함께 정리됩니다.
--
-- collect_queue는 categories를 FK로 참조하지 않으므로 별도로 비웁니다.
-- settings / fulfillment_fees / profiles는 건드리지 않습니다.

delete from collect_queue;
delete from categories;   -- cascade로 products/product_items/user_items/item_calc/user_category_favorites까지 정리

-- 확인 (전부 0이어야 정상)
select
  (select count(*) from categories)               as categories,
  (select count(*) from products)                 as products,
  (select count(*) from product_items)             as product_items,
  (select count(*) from item_history)              as item_history,
  (select count(*) from user_items)                as user_items,
  (select count(*) from item_calc)                 as item_calc,
  (select count(*) from user_category_favorites)   as user_category_favorites,
  (select count(*) from collect_queue)             as collect_queue;
