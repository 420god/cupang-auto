-- ============================================================
-- 007. 전역 기본 수수료율(가정치) 완전 제거
--
-- 006에서 categories.commission_rate로 카테고리별 실제 수수료율을 채운 뒤,
-- 더는 전역 가정치(10.8%)를 쓰지 않기로 함(사용자 결정, 2026-08-13).
-- 매칭 안 된 카테고리는 이제 "수수료 정보 없음"으로 표시되고 마진 계산에서
-- 제외된다 — web/app.js의 commissionFor()/calcMargin() 참조.
--
-- settings.fee_defaults에 남아있던 commission_rate 키만 제거한다.
-- 같은 값(vat_included)은 이 정리와 무관해서 그대로 둔다.
-- ============================================================

update settings
set value = value - 'commission_rate'
where key = 'fee_defaults';
