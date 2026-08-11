-- 테스트: 정리본 CSV 1행만 upsert
-- Supabase SQL Editor에 붙여넣어 실행하세요.
-- kan_category_id / unit1 / unit2 / commission_rate / product_count / item_count /
-- last_list_at / last_detail_at 은 건드리지 않습니다 (이미 있던 값 보존).

insert into categories (category_code, name, full_path, depth, is_leaf, root_name, parent_path)
values (
  '69244',
  '섹시 브래지어(19)',
  '패션의류잡화>여성패션>속옷/잠옷>섹시 언더웨어(19)>섹시 브래지어(19)',
  5,
  true,
  '패션의류잡화',
  '패션의류잡화>여성패션>속옷/잠옷>섹시 언더웨어(19)'
)
on conflict (category_code) do update set
  name        = excluded.name,
  full_path   = excluded.full_path,
  depth       = excluded.depth,
  is_leaf     = excluded.is_leaf,
  root_name   = excluded.root_name,
  parent_path = excluded.parent_path;

-- 확인
select category_code, name, full_path, root_name, parent_path,
       kan_category_id, unit1, unit2, commission_rate
from categories
where category_code = '69244';
