-- ============================================================
-- 웹사이트용 스키마 확장 (v2)
--   - 카테고리 수집 상태 추적
--   - 사용자별 카테고리 즐겨찾기
--   - 수집 대기열
--   - 초대 기반 가입 제한
--
-- 기존 schema.sql을 이미 실행한 상태에서 이어서 실행하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- 1. 카테고리에 수집 상태 컬럼 추가
-- ------------------------------------------------------------
alter table categories
  add column if not exists last_list_at    timestamptz,   -- 1단계(상품목록) 완료 시각
  add column if not exists last_detail_at  timestamptz,   -- 2단계(판매량/배송) 완료 시각
  add column if not exists product_count   int default 0,
  add column if not exists item_count      int default 0,
  add column if not exists parent_path     text,          -- 대분류 (그룹핑용)
  add column if not exists root_name       text;          -- 최상위 카테고리명

create index if not exists idx_cat_root      on categories (root_name);
create index if not exists idx_cat_detail_at on categories (last_detail_at desc nulls last);


-- ------------------------------------------------------------
-- 2. 사용자별 카테고리 즐겨찾기
-- ------------------------------------------------------------
create table if not exists user_category_favorites (
  user_id       uuid not null references auth.users(id) on delete cascade,
  category_code text not null references categories(category_code) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, category_code)
);

create index if not exists idx_ucf_user on user_category_favorites (user_id);

alter table user_category_favorites enable row level security;

drop policy if exists "own_cat_favorites" on user_category_favorites;
create policy "own_cat_favorites" on user_category_favorites
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- 수집 상태를 한국시간 기준으로 판정하는 뷰
--   collected : 2단계까지 오늘 완료
--   partial   : 1단계만 오늘 완료 (2단계 미완)
--   stale     : 과거에 수집했으나 오늘은 안 함
--   never     : 한 번도 수집 안 함
create or replace view v_category_status
with (security_invoker = true) as
select
  c.category_code,
  c.name,
  c.full_path,
  c.root_name,
  c.parent_path,
  c.product_count,
  c.item_count,
  c.last_list_at,
  c.last_detail_at,
  case
    when c.last_detail_at is not null
     and (c.last_detail_at at time zone 'Asia/Seoul')::date
         = (now() at time zone 'Asia/Seoul')::date          then 'collected'
    when c.last_list_at is not null
     and (c.last_list_at   at time zone 'Asia/Seoul')::date
         = (now() at time zone 'Asia/Seoul')::date          then 'partial'
    when c.last_list_at is not null or c.last_detail_at is not null
                                                            then 'stale'
    else 'never'
  end as status,
  greatest(
    coalesce(c.last_detail_at, 'epoch'::timestamptz),
    coalesce(c.last_list_at,   'epoch'::timestamptz)
  ) as last_any_at,
  exists (
    select 1 from user_category_favorites f
    where f.category_code = c.category_code
      and f.user_id = auth.uid()
  ) as is_favorite
from categories c;


-- ------------------------------------------------------------
-- 3. 수집 대기열
--    웹에서 등록하면 확장프로그램이 읽어서 처리합니다
-- ------------------------------------------------------------
create table if not exists collect_queue (
  id            bigserial primary key,
  requested_by  uuid references auth.users(id) on delete set null,
  category_code text not null,
  category_name text,

  job_type      text not null default 'full',
    -- full: 1+2단계 / list: 목록만 / detail: 상세만
  priority      int  not null default 0,       -- 높을수록 먼저
  status        text not null default 'pending',
    -- pending / running / done / failed / cancelled

  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  result_count  int,
  error_message text,
  worker_note   text
);

create index if not exists idx_queue_pending
  on collect_queue (status, priority desc, requested_at)
  where status = 'pending';
create index if not exists idx_queue_user on collect_queue (requested_by);

-- 같은 카테고리가 대기중에 중복 등록되지 않도록
create unique index if not exists idx_queue_unique_pending
  on collect_queue (category_code)
  where status in ('pending', 'running');

alter table collect_queue enable row level security;

-- 모든 회원이 대기열을 보고 등록할 수 있습니다
drop policy if exists "queue_read" on collect_queue;
create policy "queue_read" on collect_queue
  for select to authenticated using (true);

drop policy if exists "queue_insert" on collect_queue;
create policy "queue_insert" on collect_queue
  for insert to authenticated
  with check (requested_by = auth.uid());

-- 본인이 등록한 건 취소 가능, 관리자는 전체 관리 가능
drop policy if exists "queue_update" on collect_queue;
create policy "queue_update" on collect_queue
  for update to authenticated
  using (requested_by = auth.uid() or is_admin())
  with check (requested_by = auth.uid() or is_admin());

drop policy if exists "queue_delete" on collect_queue;
create policy "queue_delete" on collect_queue
  for delete to authenticated
  using (requested_by = auth.uid() or is_admin());


-- ------------------------------------------------------------
-- 4. 초대 기반 가입 제한
--    관리자가 이메일을 등록해두면 그 이메일만 가입됩니다
-- ------------------------------------------------------------
create table if not exists invited_emails (
  email       text primary key,
  invited_by  uuid references auth.users(id) on delete set null,
  note        text,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table invited_emails enable row level security;

-- 관리자만 초대 목록을 관리합니다
drop policy if exists "invites_admin" on invited_emails;
create policy "invites_admin" on invited_emails
  for all to authenticated
  using (is_admin()) with check (is_admin());


-- 가입 시 초대 목록에 있는지 검사합니다
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  allowed boolean;
  first_user boolean;
begin
  -- 첫 사용자는 무조건 허용 (관리자 계정 생성용)
  select count(*) = 0 into first_user from profiles;

  if not first_user then
    select exists (
      select 1 from invited_emails
      where lower(email) = lower(new.email)
    ) into allowed;

    if not allowed then
      raise exception '초대되지 않은 이메일입니다. 관리자에게 문의하세요.';
    end if;

    update invited_emails
      set used_at = now()
      where lower(email) = lower(new.email);
  end if;

  insert into profiles (id, email, is_admin)
  values (new.id, new.email, first_user)
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ------------------------------------------------------------
-- 5. 카테고리 수집 상태 자동 갱신
--    상품/옵션이 업로드되면 카테고리 통계를 다시 계산합니다
-- ------------------------------------------------------------
create or replace function refresh_category_stats(p_category_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update categories c
  set product_count = coalesce(s.pc, 0),
      item_count    = coalesce(s.ic, 0)
  from (
    select
      p.category_code,
      count(distinct p.product_id) as pc,
      count(i.item_id)             as ic
    from products p
    left join product_items i on i.product_id = p.product_id
    where p.category_code = p_category_code
    group by p.category_code
  ) s
  where c.category_code = p_category_code
    and s.category_code = c.category_code;
end $$;


-- ------------------------------------------------------------
-- 6. 대분류 이름 채우기 (full_path에서 추출)
-- ------------------------------------------------------------
update categories
set root_name = split_part(full_path, '>', 1)
where full_path is not null
  and (root_name is null or root_name = '');
