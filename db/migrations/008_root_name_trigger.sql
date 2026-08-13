-- ============================================================
-- 008. categories.root_name 자동 유지 트리거
--
-- root_name(= full_path 첫 세그먼트)은 002에서 딱 한 번 백필만 됐고 그 뒤로는
-- 자동으로 안 채워진다. 그래서 002 실행 이후 확장프로그램이 새로 수집해 넣은
-- 카테고리는 root_name이 계속 null로 남는다 — 2026-08-13 기준 2건 확인됨
-- (category_code 56512 "뷰티소품", 69411 "비치웨어" — 둘 다 full_path는
-- 정상인데 root_name만 null이라 006의 카테고리별 수수료율 매칭에서 빠짐).
--
-- delivery_badges와 같은 패턴(db/CLAUDE.md "배송유형은 옵션 것이 원본, 상품
-- 것은 파생값" 참조)으로, root_name도 full_path에서 파생되는 캐시이니
-- 트리거로 항상 동기화한다.
-- ============================================================

create or replace function set_category_root_name()
returns trigger language plpgsql as $$
begin
  new.root_name := split_part(new.full_path, '>', 1);
  return new;
end $$;

drop trigger if exists trg_category_root_name on categories;
create trigger trg_category_root_name
  before insert or update of full_path on categories
  for each row execute function set_category_root_name();

-- 지금까지 놓친 것들 백필
update categories
set root_name = split_part(full_path, '>', 1)
where root_name is null or root_name = '';

-- 방금 root_name이 채워진 행들은 006이 이미 지나가서 commission_rate가 여전히
-- null이다. 006의 "대분류 기본 수수료" 단계만 다시 돌려서 채운다(소분류 예외는
-- 이 2건 다 해당 안 되는 걸 확인했음 — 06 참조).
update categories set commission_rate = v.rate
from (values
  ('가전/디지털', 7.8), ('가구/홈데코', 10.8), ('도서', 10.8), ('음반', 10.8),
  ('문구/오피스', 10.8), ('출산/유아동', 10.0), ('스포츠/레져', 10.8), ('뷰티', 9.6),
  ('생활용품', 7.8), ('식품', 10.6), ('완구/취미', 10.8), ('자동차용품', 10.0),
  ('주방용품', 10.8), ('패션의류잡화', 10.5), ('반려/애완용품', 10.8)
) as v(root_name, rate)
where categories.root_name = v.root_name and categories.commission_rate is null;
