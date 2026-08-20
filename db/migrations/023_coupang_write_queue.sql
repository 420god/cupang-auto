-- ============================================================
-- 023. 쿠팡 쓰기 큐 — 웹에서 누르면 VPS가 대신 쏜다
--
-- 왜 큐인가: 쿠팡 Open API는 WING에 등록한 IP에서만 받는데 Vercel은 고정 IP가 없다.
-- 유료 고정 IP 프록시까지 사서 시도했다가 WAF에 IP 대역째 막힌 전례가 있다(D-16).
-- 그래서 웹은 이 테이블에 "무엇을 어떻게 바꿔달라"만 넣고, 고정 IP를 가진 VPS가
-- 그걸 집어서 실제로 호출한다. 웹은 포트를 열 필요도, 비밀키를 만질 필요도 없다.
--
-- 그리고 이 테이블은 **큐이자 곧 변경 이력이다**(2026-08-20 사용자 요청).
-- 별도 이력 테이블을 만들지 않는 이유: 요청·실행·결과가 한 행에 다 있어야
-- "이때 왜 이 가격으로 바꿨고 쿠팡이 뭐라 답했나"가 한눈에 보인다.
--
-- 검증된 사실(2026-08-20 실물 호출):
--   PUT /v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/{id}/prices/{price}
--   → {"code":"SUCCESS","message":"가격 변경을 완료했습니다."}
--   로켓그로스 옵션ID인데 **마켓플레이스 계열** 경로가 받는다. rg_open_api 쪽은 404다.
-- ============================================================

create table if not exists coupang_write_queue (
  id              uuid primary key default gen_random_uuid(),

  -- price: 판매가 변경 / sale_stop·sale_resume: 판매중지·재개
  -- 판매상태 두 개는 아직 실물로 확인 안 됐다(실패하면 상품이 실제로 내려가서 시험을 미뤘다).
  -- 값은 미리 정의해두되, 워커가 '미검증' 종류는 거부하도록 해서 사고를 막는다.
  kind            text not null check (kind in ('price', 'sale_stop', 'sale_resume')),

  -- 쿠팡 로켓그로스 옵션ID. rocket_growth_product_registry.vendor_item_id 와 같은 값이다
  -- (동기화의 pickVendorItemId()가 rocketGrowthItemData를 먼저 보므로 이미 로켓그로스 쪽이 들어 있다).
  -- **마켓플레이스 옵션ID가 아니다** — 같은 상품에 옵션ID가 두 개고 가격도 두 벌이다
  -- (실측: 로켓그로스 7,500 / 마켓플레이스 13,000). 여기 잘못 넣으면 엉뚱한 가격이 바뀐다.
  vendor_item_id  text not null,
  sku_id          uuid references my_skus(id),   -- 연결돼 있으면 채운다. 없어도 실행은 된다

  -- ── 무엇을 바꾸나 ───────────────────────────────────────────
  -- price_after 는 우리가 만들려는 값. kind='price' 일 때만 쓴다.
  price_after     bigint,
  -- price_before 는 **쏘기 직전에 쿠팡에 물어본 실제 값**이다. 웹이 채우지 않는다.
  -- 웹 화면이 아는 값은 마지막 동기화 시점의 값이라, 그 사이 WING에서 사람이 바꿨으면 다르다.
  -- 실제 이전 값을 남겨야 나중에 "얼마에서 얼마로"가 진실이 된다(R-04).
  price_before    bigint,

  -- ── 왜 바꾸나: 판단 근거를 그 시점 그대로 박제한다 ──────────
  -- 원가는 계속 바뀌므로 나중에 다시 계산하면 그때의 판단을 복원할 수 없다.
  -- 이걸 남겨야 나중에 AI가 "마진 12%에서 가격을 내렸더니 판매량이 어땠나"를 볼 수 있다.
  margin_rate_at_request   numeric,   -- 요청 시점 마진율(%)
  unit_cost_krw_at_request numeric,   -- 요청 시점 개당 매입원가(원)
  reason          text,               -- 사람이 적는 한 줄. 선택

  -- ── 실행 상태 ───────────────────────────────────────────────
  -- queued: 웹이 넣음 / running: 워커가 집음 / done: 성공 / failed: 실패 / cancelled: 실행 전 취소
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts        int  not null default 0,   -- 재시도 횟수. 무한루프 방지용으로 워커가 상한을 건다
  http_status     int,
  -- 쿠팡 응답 원문을 그대로 남긴다(R-04). 실패 사유가 여기에만 있고, 성공해도
  -- code/message 형태라 나중에 응답 형식이 바뀌면 이 원문이 유일한 단서가 된다.
  response_body   text,

  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- 워커가 "아직 안 한 것"만 빠르게 집기 위한 인덱스. 대부분의 행은 done이라 부분 인덱스로 둔다.
create index if not exists coupang_write_queue_pending
  on coupang_write_queue (requested_at)
  where status in ('queued', 'running');

-- 화면에서 "이 옵션의 가격 변경 이력"을 시간순으로 본다
create index if not exists coupang_write_queue_item
  on coupang_write_queue (vendor_item_id, requested_at desc);

create index if not exists coupang_write_queue_sku
  on coupang_write_queue (sku_id, requested_at desc);

do $$
begin
  execute 'alter table coupang_write_queue enable row level security';
  execute 'drop policy if exists "read_for_authenticated" on coupang_write_queue';
  execute 'create policy "read_for_authenticated" on coupang_write_queue for select to authenticated using (true)';
  execute 'drop policy if exists "write_for_admin" on coupang_write_queue';
  execute 'create policy "write_for_admin" on coupang_write_queue for all to authenticated using (is_admin()) with check (is_admin())';
end $$;
