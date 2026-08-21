-- ============================================================
-- 030. 상품 등록 초안 — 쿠팡에 보내기 전에 우리 쪽에 세워두는 자리
--
-- **등록은 되돌릴 수 없다.** 한 번 만들어지면 지우기가 까다롭고, 잘못 만든 상품이
-- WING 목록에 남는다. 그래서 보내기 전에 멈출 수 있는 자리가 필요하다.
--
-- 쿠팡의 '승인 요청 안 함'(requested=false)으로도 비슷한 효과를 기대할 수 있지만
-- **그게 WING에서 어떤 상태로 보이는지는 확인되지 않았다**(2026-08-20).
-- 근거: 정찰에서 본 기존 상품이 requested=false 인데 statusName="승인완료"였다 —
-- 즉 requested 는 "임시저장이냐"가 아니라 "지금 승인 요청 중이냐"에 가깝다.
-- 확인하려면 실제로 등록해봐야 하는데 그게 되돌릴 수 없는 일이라, 쿠팡 상태와
-- 무관하게 안전한 이쪽을 만든다.
--
-- 초안은 **등록에 쓸 payload 그대로** 담는다. 파싱해서 컬럼으로 쪼개지 않는 이유는
-- 큐의 payload 와 모양이 어긋나면 "초안에서는 되는데 등록하면 다르다"가 생기기
-- 때문이다 — 같은 것을 두 모양으로 저장하지 않는다.
-- ============================================================

create table if not exists product_drafts (
  id                       uuid primary key default gen_random_uuid(),

  -- 목록에서 알아볼 이름. payload 안에도 있지만 꺼내 두면 목록 조회가 단순해진다
  name                     text not null,
  source_seller_product_id text,          -- 복제 원본 (빈 양식이면 null)

  -- coupang_write_queue.payload 와 **같은 모양**이다. 등록할 때 그대로 실어 보낸다.
  payload                  jsonb not null,

  -- 소싱 판단 입력값. 아직 sourcing_decisions 에 넣지 않고 여기 들고 있다가
  -- 실제 등록할 때 넣는다 — 초안만 만들고 안 올린 건 '판단'이라 보기 어렵다.
  decision                 jsonb,

  -- draft: 아직 안 보냄 / submitted: 등록 요청까지 감 / discarded: 버림
  status                   text not null default 'draft'
                           check (status in ('draft', 'submitted', 'discarded')),
  -- 등록 요청을 넣었으면 그 큐 행. 결과(성공·실패·새 상품ID)는 그쪽에 있다.
  submitted_queue_id       uuid references coupang_write_queue(id),

  memo                     text,
  created_by               uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists product_drafts_status
  on product_drafts (status, updated_at desc);

do $$
begin
  execute 'alter table product_drafts enable row level security';
  execute 'drop policy if exists "read_for_authenticated" on product_drafts';
  execute 'create policy "read_for_authenticated" on product_drafts for select to authenticated using (true)';
  execute 'drop policy if exists "write_for_admin" on product_drafts';
  execute 'create policy "write_for_admin" on product_drafts for all to authenticated using (is_admin()) with check (is_admin())';
end $$;
