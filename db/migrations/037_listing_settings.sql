-- ============================================================
-- 037. 등록 설정 — 늘 같은 값은 한 곳에서 정한다
--
-- 사용자 결정(2026-08-21): 브랜드·제조사·소비자상담 전화번호·고시정보 기본값처럼
-- **상품이 달라도 늘 같은 값**을 매번 입력하지 않는다. 한 곳에 정해두고 자동으로 들어간다.
--
-- 왜 표를 하나 더 만드나: settings(002)는 환율·기본원가 같은 **계산용 설정**이다.
-- 등록용 값을 거기 섞으면 "이 값이 계산에 쓰이나 등록에 쓰이나"를 매번 따져야 한다.
--
-- 한 행만 쓴다(single row). 여러 벌이 필요해지면 그건 '양식'(listing_templates)이지
-- 설정이 아니다 — 둘의 경계를 흐리면 어느 값이 이겼는지 못 따진다.
-- ============================================================

create table if not exists listing_settings (
  id                    int primary key default 1 check (id = 1),

  -- 상품 주요 정보에 늘 들어가는 값
  default_brand         text,
  default_manufacture   text,

  -- 고시정보 기본값. 양식(listing_templates)의 값이 비었을 때 이걸로 채운다.
  -- 모양: { "noticeCategoryName": "기타 재화",
  --         "items": { "제조국(원산지)": "중국", "소비자상담 관련 전화번호": "…" } }
  -- **품명 및 모델명은 여기 안 넣는다** — 항상 상품명이 들어간다(사용자 결정).
  notice_defaults       jsonb not null default '{}'::jsonb,

  -- 옵션·물류 기본값. 상품마다 바꿀 수 있고, 여기 값은 '처음에 채워지는 값'이다.
  default_size_type     text,
  default_outbound_day  int,

  -- 검색필터 기본값을 카테고리별로. 모양: { "103112": { "수제 여부": "예" } }
  -- 카테고리마다 항목이 달라서 카테고리 코드로 나눠 담는다.
  filter_defaults       jsonb not null default '{}'::jsonb,

  updated_by            uuid,
  updated_at            timestamptz not null default now()
);

insert into listing_settings (id) values (1) on conflict (id) do nothing;

-- ── 검색필터 값은 준비 건에 ─────────────────────────────────
-- 쿠팡 API 는 필수속성과 검색필터를 **한 배열(items[].attributes)** 로 받는다.
-- 화면만 나뉘어 있을 뿐이다. 그래서 값도 한 군데 모아두고 등록할 때 합친다.
--
-- 필수속성 중 색상·무게는 **옵션마다 다르므로** 옵션에서 만들고(등록 시 자동),
-- 검색필터는 대부분 상품 단위라 여기 둔다.
-- 모양: { "수제 여부": "예", "슬라임 재료": "클리어" }
alter table listing_projects
  add column if not exists search_filters jsonb not null default '{}'::jsonb;

do $$
begin
  execute 'alter table listing_settings enable row level security';
  execute 'drop policy if exists "read_for_authenticated" on listing_settings';
  execute 'create policy "read_for_authenticated" on listing_settings for select to authenticated using (true)';
  execute 'drop policy if exists "write_for_admin" on listing_settings';
  execute 'create policy "write_for_admin" on listing_settings for all to authenticated using (is_admin()) with check (is_admin())';
end $$;

drop trigger if exists listing_settings_touch on listing_settings;
create trigger listing_settings_touch before update on listing_settings
  for each row execute function touch_updated_at();
