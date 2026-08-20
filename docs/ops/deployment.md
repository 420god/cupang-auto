# 배포

> **언제 읽나**: 고쳤는데 반영이 안 될 때.
> **최종 검증**: 2026-08-19
> **관련 코드**: `web/` (Vercel) · `scripts/` (VPS) · `extension/` (Chrome)

## 셋이 각각 다른 방식으로 반영된다

| 대상 | 방법 | 주의 |
|---|---|---|
| **웹** | `main` push → Vercel 자동배포 | 웹훅이 가끔 유실됨 |
| **VPS 스크립트** | VPS에서 `git pull` | **push만으론 반영 안 됨** |
| **확장프로그램** | `chrome://extensions`에서 새로고침 | **git과 무관** |

`extension/background.js`·`interceptor.js`를 고친 세션 다음엔 항상 새로고침을 확인할 것.

## Vercel 웹훅 유실

푸시했는데 사이트에 반영이 안 되면 **배포 목록에 그 커밋이 아예 없는지부터** 확인한다.
없으면 빌드 실패가 아니라 웹훅이 안 온 것이므로 로그를 볼 필요가 없다.

```bash
git commit --allow-empty -m "redeploy" && git push
```

저장소: `420god/cupang-auto` → `sourcing-web2.vercel.app`

## VPS

```
경로: /home/thezone1633/cupang-auto
크론:
  */30 * * * *  cd .../scripts && /usr/bin/node rocket-growth-sync.js
  0 3 * * *     cd .../scripts && /usr/bin/node rocket-growth-sync.js --products
```

`.env`는 `scripts/.env`. 지금은 `__dirname` 기준으로 읽으므로 어느 디렉터리에서 실행해도 된다.

## 웹의 서버리스 함수

`web/api/*.js`는 Vercel이 번들러 없이 그대로 함수로 인식한다 — **프론트엔드 무의존 원칙과
안 부딪히는 유일한 예외**다. `web/package.json`의 의존성은 전부 `api/` 전용이다.

| 함수 | 의존성 | 상태 |
|---|---|---|
| `parse-invoice.js` | pdf-parse, xlsx | 청구서 PDF/엑셀 읽기 |

**함수는 이것 하나뿐이다.** 쿠팡을 부르는 서버 일은 전부 VPS에 있다 — Vercel은 고정 IP가
없어서 쿠팡 WAF에 막힌다(유료 프록시까지 사서 실패했다 → `../archive/2026-08-18-decisions.md`).

새 npm 의존성을 추가하면 Vercel 첫 배포가 조금 더 걸린다.

## 마이그레이션

Supabase SQL 편집기에서 직접 실행한다. 실행 상태는 `../STATUS.md`.
"destructive operations"와 "RLS 미설정" 경고가 뜨는데 **둘 다 오탐**이다 —
`drop policy if exists`(바로 다시 만듦)와 `do $$` 블록 안의 RLS 설정을 정적 분석기가 못 읽는다.
`Run and enable RLS`를 눌러도 이미 켜진 걸 또 켜는 것뿐이라 안전하다.
