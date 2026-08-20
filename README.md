# 쿠팡 소싱 시스템

쿠팡 셀러가 소싱할 상품을 판단하기 위한 데이터 수집·분석 도구.
크롬 확장프로그램으로 수집 → Supabase에 저장 → 웹사이트에서 조회·마진계산.

## Claude Code로 작업할 때

이 폴더에서 Claude Code를 실행하면 `CLAUDE.md`를 자동으로 읽는다.
하위 폴더(`extension/`, `web/`, `db/`)에도 각각 `CLAUDE.md`가 있어서,
그 폴더 안에서 작업할 때 관련 맥락을 추가로 읽는다.

**작업 시작 전에 항상 다음을 확인할 것** (`CLAUDE.md`의 "지금 상태"가 최신 기준):
1. `db/migrations/`가 전부 실제로 Supabase에 실행됐는지 (현재 001~008 — 몇 번까지 확인됐는지는 `CLAUDE.md` 참조)
2. `extension/`이 최신 버전으로 배포됐는지 (chrome://extensions에서 확인)
3. `web/`이 실제로 배포·접속 가능한지 (Vercel, `sourcing-web2.vercel.app`)
4. 판매현황 탭을 쓴다면 `scripts/rocket-growth-sync.js`가 GCP VPS에서 cron으로 정상 도는지

## 폴더 구조

```
extension/   크롬 확장프로그램 (Manifest V3, 빌드 없음)
web/         웹사이트 (정적 HTML/CSS/JS, 빌드 없음) + api/(Vercel 서버리스, 현재 미사용)
db/          Supabase 스키마 (PostgreSQL)
  migrations/  순서대로 실행. 지난 파일 수정 금지
docs/        코드에 없는 맥락 (API 함정, 의사결정, 트러블슈팅)
scripts/     검증 스크립트 + rocket-growth-sync.js(GCP VPS에서 cron으로 도는 판매현황 동기화)
```

## 처음 설정하는 경우

```bash
# 1. DB
#    Supabase 프로젝트 생성 → SQL Editor에서 db/migrations/*.sql을 번호 순서대로 실행

# 2. 확장프로그램
#    chrome://extensions → 개발자 모드 → "압축 해제된 확장 프로그램 로드" → extension/ 폴더 선택

# 3. 웹사이트
#    web/ 폴더를 Vercel에 배포 (빌드 명령 없음, 정적 파일 그대로)

# 4. (판매현황 탭을 쓰려면) GCP VPS 등 고정 IP 서버 하나에
#    scripts/rocket-growth-sync.js를 npm install 후 cron 등록 — 이유: docs/decisions.md 2026-08-13 항목

# 5. 검증
bash scripts/check_all.sh
```

## 기술 스택

프론트엔드(`web/`, `extension/`)는 Vanilla JavaScript만 사용, 프레임워크·번들러·npm 패키지 없음 — 의도적 선택.
`web/api/`(서버리스 — 청구서 읽기 함수 하나)와 `scripts/`(GCP VPS에서 도는 독립 스크립트)는 이 원칙과 무관한 서버사이드 코드라 npm 의존성(`pdf-parse`, `xlsx`, `dotenv`)을 쓴다.
DB는 Supabase(PostgreSQL) + RLS. 자세한 이유는 `docs/decisions.md`.

## 문서 지도

| 파일 | 내용 |
|---|---|
| `CLAUDE.md` | 세 컴포넌트를 묶는 계약, 전역 금지사항, 현재 상태 요약 |
| `extension/CLAUDE.md` | 확장프로그램 데이터 흐름, 절대 바꾸면 안 되는 것 |
| `web/CLAUDE.md` | 웹사이트 계산 로직, 알려진 미동작 기능 |
| `db/CLAUDE.md` | 스키마 설계 이유, 마이그레이션 규칙 |
| `docs/api-notes.md` | 쿠팡 API 역공학 결과 (요청 구조, 응답 필드, 함정) |
| `docs/decisions.md` | 왜 이렇게 만들었는지, 검토했다 버린 대안 |
| `docs/troubleshooting.md` | 겪은 에러와 해결책, 미해결 이슈, 주의사항 |
