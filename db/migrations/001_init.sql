-- ============================================================
-- 쿠팡 소싱 데이터베이스 스키마 (멀티유저 + RLS)
--
--   공통 데이터 : 로그인한 회원이면 누구나 읽기 가능
--   개인 데이터 : 본인 것만 읽기/쓰기 가능
--   수집(쓰기)  : service_role 키를 쓰는 확장프로그램만 가능
--
-- Supabase SQL Editor에 그대로 붙여넣어 실행하세요.
-- ============================================================


-- ============================================================
-- PART 1. 공통 데이터 (수집으로 채워지는 영역)
-- ============================================================

-- 1-1. 전역 설정
create table if not exists settings (
  key           text primary key,
  value         jsonb not null,
  updated_at    timestamptz not null default now()
);

insert into settings (key, value) values
  ('exchange_rate', '{"cny_krw": 320}'),
  ('default_costs', '{"outbound_fee": 300, "work_fee": 300}'),
  ('fee_defaults',  '{"commission_rate": 10.8, "vat_included": true}')
on conflict (key) do nothing;


-- 1-2. 카테고리
create table if not exists categories (
  category_code   text primary key,
  name            text not null,
  full_path       text,
  depth           int,
  is_leaf         boolean default true,
  kan_category_id text,
  unit1           text,
  unit2           text,
  commission_rate numeric(5,2),
  fee_matched     boolean default false,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_categories_kan  on categories (kan_category_id);
create index if not exists idx_categories_unit on categories (unit1, unit2);


-- 1-3. 입출고비 요금표
create table if not exists fulfillment_fees (
  id            bigserial primary key,
  unit1         text not null,
  unit2         text not null,
  capacity_type text not null,
  min_price     int  not null,
  base_amount   int,
  final_amount  int,
  is_low_asp    boolean default false,
  updated_at    timestamptz not null default now(),
  unique (unit1, unit2, capacity_type, min_price, is_low_asp)
);

create index if not exists idx_fees_lookup
  on fulfillment_fees (unit1, unit2, capacity_type, min_price);


-- 1-4. 상품
create table if not exists products (
  product_id        text primary key,
  product_name      text,
  brand_name        text,
  manufacture       text,

  category_code     text references categories(category_code),
  category_id       text,
  category_path     text,

  pv_rank           int,
  pv_lower          bigint,
  pv_upper          bigint,
  rating            numeric(3,1),
  rating_count      int,

  max_sales         int,
  sum_sales         int,
  min_price         int,
  max_price         int,
  option_count      int default 0,
  has_rocket        boolean default false,
  all_soldout       boolean default false,
  rep_image_path    text,

  is_active         boolean default true,
  first_seen_at     timestamptz default now(),
  last_seen_at      timestamptz default now(),
  raw               jsonb,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_products_maxsales on products (max_sales desc nulls last);
create index if not exists idx_products_sumsales on products (sum_sales desc nulls last);
create index if not exists idx_products_category on products (category_code);
create index if not exists idx_products_rank     on products (pv_rank);
create index if not exists idx_products_price    on products (min_price);
create index if not exists idx_products_active   on products (is_active) where is_active = true;


-- 1-5. 옵션
create table if not exists product_items (
  item_id             text primary key,
  product_id          text not null references products(product_id) on delete cascade,
  vendor_item_id      text,

  item_name           text,
  image_path          text,
  current_price       int,
  origin_price        int,
  price_basis         text,

  sales_text          text,
  sales_number        int,
  delivery_badge      text,
  delivery_basis      text,
  shipping_fee        text,
  courier             text,
  seller_name         text,
  is_soldout          boolean default false,
  listing_eligibility text,

  is_active           boolean default true,
  first_seen_at       timestamptz default now(),
  last_seen_at        timestamptz default now(),
  detail_updated_at   timestamptz,
  raw                 jsonb,
  updated_at          timestamptz not null default now()
);

create index if not exists idx_items_product  on product_items (product_id);
create index if not exists idx_items_sales    on product_items (sales_number desc nulls last);
create index if not exists idx_items_price    on product_items (current_price);
create index if not exists idx_items_delivery on product_items (delivery_badge);
create index if not exists idx_items_active   on product_items (is_active) where is_active = true;


-- 1-6. 변경 이력 (같은 날 중복 방지)
-- recorded_date는 생성 컬럼 대신 트리거로 채웁니다.
-- (timestamptz -> date 변환은 타임존 의존이라 generated 컬럼에 못 씁니다)
create table if not exists item_history (
  id              bigserial primary key,
  item_id         text not null,
  product_id      text not null,

  price           int,
  sales_number    int,
  pv_rank         int,
  rating_count    int,
  delivery_badge  text,
  is_soldout      boolean,

  change_reason   text,
  recorded_at     timestamptz not null default now(),
  recorded_date   date not null default (now() at time zone 'Asia/Seoul')::date
);

-- recorded_at을 직접 지정한 경우에도 날짜가 맞도록 보정
create or replace function set_recorded_date()
returns trigger language plpgsql as $$
begin
  new.recorded_date := (new.recorded_at at time zone 'Asia/Seoul')::date;
  return new;
end $$;

drop trigger if exists trg_recorded_date on item_history;
create trigger trg_recorded_date
  before insert or update on item_history
  for each row execute function set_recorded_date();

create index if not exists idx_history_item on item_history (item_id, recorded_at desc);
create index if not exists idx_history_date on item_history (recorded_date);
create unique index if not exists idx_history_item_date
  on item_history (item_id, recorded_date);


-- 1-7. 수집 로그
create table if not exists collect_runs (
  id            bigserial primary key,
  run_type      text,
  category_code text,
  total_count   int,
  new_count     int,
  updated_count int,
  started_at    timestamptz default now(),
  finished_at   timestamptz,
  status        text default 'running',
  note          text
);


-- ============================================================
-- PART 2. 개인 데이터 (사용자별로 분리)
-- ============================================================

-- 2-1. 회원 프로필
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  is_admin      boolean default false,   -- 수집 데이터 쓰기 권한
  prefs         jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- 2-2. 개인 소싱 데이터
create table if not exists user_items (
  user_id           uuid not null references auth.users(id) on delete cascade,
  item_id           text not null references product_items(item_id) on delete cascade,
  product_id        text,

  want_price        int,
  cost_cny          numeric(10,2),
  exchange_rate     numeric(10,2),
  outbound_fee      int,
  work_fee          int,

  is_favorite       boolean default false,
  memo              text,
  status            text default '검토중',

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists idx_user_items_user    on user_items (user_id);
create index if not exists idx_user_items_fav     on user_items (user_id, is_favorite) where is_favorite;
create index if not exists idx_user_items_status  on user_items (user_id, status);
create index if not exists idx_user_items_product on user_items (user_id, product_id);


-- 2-3. 개인 계산 결과
create table if not exists item_calc (
  user_id             uuid not null references auth.users(id) on delete cascade,
  item_id             text not null references product_items(item_id) on delete cascade,
  product_id          text,

  commission_rate     numeric(5,2),
  capacity_type       text default 'MINI',
  cost_krw            int,
  outbound_fee        int,
  work_fee            int,

  cur_price           int,
  cur_commission      int,
  cur_fulfillment     int,
  cur_settlement      int,
  cur_margin          int,
  cur_margin_rate     numeric(6,2),

  want_price          int,
  want_commission     int,
  want_fulfillment    int,
  want_settlement     int,
  want_margin         int,
  want_margin_rate    numeric(6,2),

  fee_estimated       boolean default false,
  calculated_at       timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists idx_calc_user_margin on item_calc (user_id, cur_margin_rate desc nulls last);
create index if not exists idx_calc_user_want   on item_calc (user_id, want_margin_rate desc nulls last);
create index if not exists idx_calc_user_prod   on item_calc (user_id, product_id);


-- ============================================================
-- PART 3. RLS (행 수준 보안)
-- ============================================================

-- 3-1. 공통 데이터: 로그인 회원 읽기 전용
alter table settings         enable row level security;
alter table categories       enable row level security;
alter table fulfillment_fees enable row level security;
alter table products         enable row level security;
alter table product_items    enable row level security;
alter table item_history     enable row level security;
alter table collect_runs     enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','categories','fulfillment_fees',
    'products','product_items','item_history','collect_runs'
  ]
  loop
    execute format('drop policy if exists "read_for_authenticated" on %I;', t);
    execute format(
      'create policy "read_for_authenticated" on %I
         for select to authenticated using (true);', t);
  end loop;
end $$;


-- 3-1-b. 공통 데이터 쓰기: 관리자만 가능
--        (확장프로그램은 관리자 계정으로 로그인해 수집합니다)
create or replace function is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','categories','fulfillment_fees',
    'products','product_items','item_history','collect_runs'
  ]
  loop
    execute format('drop policy if exists "write_for_admin" on %I;', t);
    execute format(
      'create policy "write_for_admin" on %I
         for all to authenticated
         using (is_admin()) with check (is_admin());', t);
  end loop;
end $$;


-- 3-2. 개인 데이터: 본인 것만 전체 권한
alter table profiles   enable row level security;
alter table user_items enable row level security;
alter table item_calc  enable row level security;

drop policy if exists "own_profile_read" on profiles;
create policy "own_profile_read" on profiles
  for select to authenticated using (id = auth.uid());

-- is_admin은 스스로 바꿀 수 없도록 update 시 기존 값 유지를 강제합니다
drop policy if exists "own_profile_update" on profiles;
create policy "own_profile_update" on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and is_admin = coalesce(
      (select p.is_admin from profiles p where p.id = auth.uid()), false)
  );

drop policy if exists "own_user_items" on user_items;
create policy "own_user_items" on user_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own_item_calc" on item_calc;
create policy "own_item_calc" on item_calc
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ============================================================
-- PART 4. 편의 뷰 (security_invoker = 호출자 권한으로 RLS 적용)
-- ============================================================

create or replace view v_product_list
with (security_invoker = true) as
select
  p.product_id,
  p.product_name,
  p.brand_name,
  p.category_path,
  p.rep_image_path,
  p.max_sales,
  p.sum_sales,
  p.min_price,
  p.max_price,
  p.option_count,
  p.has_rocket,
  p.pv_rank,
  p.rating,
  p.rating_count,
  p.last_seen_at,
  exists (
    select 1 from user_items u
    where u.product_id = p.product_id
      and u.user_id = auth.uid()
      and u.is_favorite
  ) as has_favorite,
  (
    select max(c.cur_margin_rate) from item_calc c
    where c.product_id = p.product_id
      and c.user_id = auth.uid()
  ) as best_margin_rate
from products p
where p.is_active;


create or replace view v_favorites
with (security_invoker = true) as
select
  u.user_id,
  u.item_id,
  u.product_id,
  u.memo,
  u.status,
  u.want_price,
  u.cost_cny,
  u.exchange_rate,
  i.item_name,
  i.image_path,
  i.current_price,
  i.sales_number,
  i.delivery_badge,
  p.product_name,
  p.brand_name,
  p.category_path,
  c.cur_margin,
  c.cur_margin_rate,
  c.want_margin,
  c.want_margin_rate,
  u.updated_at
from user_items u
join product_items i on i.item_id = u.item_id
join products      p on p.product_id = i.product_id
left join item_calc c on c.item_id = u.item_id and c.user_id = u.user_id
where u.is_favorite;


-- ============================================================
-- PART 5. updated_at 자동 갱신
-- ============================================================
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'settings','categories','products','product_items',
    'profiles','user_items'
  ]
  loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on %1$s;
       create trigger trg_touch_%1$s before update on %1$s
       for each row execute function touch_updated_at();', t);
  end loop;
end $$;


-- ============================================================
-- PART 6. 최초 설정 안내
-- ============================================================
-- 1) Supabase Authentication에서 본인 계정을 먼저 가입시킵니다.
-- 2) 아래 SQL로 그 계정에 관리자 권한을 부여하세요.
--    (이 계정으로 확장프로그램이 로그인해 수집합니다)
--
--    update profiles set is_admin = true
--    where email = '본인이메일@example.com';
--
-- 3) 권한 확인:
--    select id, email, is_admin from profiles;
--
-- ※ service_role 키는 확장프로그램에 절대 넣지 마세요.
--   RLS를 통째로 우회하는 마스터 키라 유출 시 전체 데이터가 노출됩니다.
--   확장프로그램에는 anon key만 넣고, 관리자 계정으로 로그인해 사용합니다.
