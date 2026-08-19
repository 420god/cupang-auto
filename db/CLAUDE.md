# db/

Supabase 스키마. `migrations/`를 번호순으로 실행한다.

## 절대 바꾸지 말 것

1. **이미 실행된 마이그레이션 파일을 수정하지 않는다** — 새 번호로만 추가한다
2. **모든 마이그레이션은 멱등하게** — `if not exists` / `drop ... if exists`.
   여러 번 실행해도 안전해야 한다
3. **RLS를 빠뜨리지 않는다** — 새 테이블은 `read_for_authenticated` + `write_for_admin`(`is_admin()`)

## 어디를 볼 것

| 찾는 것 | 어디 |
|---|---|
| **실행 여부** (미실행 마이그레이션) | `../STATUS.md` |
| 마이그레이션 이력·설계 이유 | `../docs/ops/migrations.md` |
| 상품원장·공급 스키마가 왜 그런지 | `../docs/domain/cost-model.md`, `inventory-flow.md` |

**실행 상태를 이 파일에 적지 말 것** — 자주 바뀌어서 바로 낡는다. `STATUS.md`가 유일한 출처다.
