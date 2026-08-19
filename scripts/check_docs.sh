#!/usr/bin/env bash
# 문서 시스템 점검 — [세션 마무리!] 때 자동 실행, 평소엔 수동으로 돌려도 된다.
#
#   bash scripts/check_docs.sh
#
# 잡아내는 것
#   1. CLAUDE.md 크기 한도 초과 (R-17) — 자동 주입되는 비용이라 커지면 매 세션 손해
#   2. docs 문서의 머리글 3줄 누락 ("언제 읽나" 없으면 인덱스에서 판단이 안 된다)
#   3. docs/INDEX.md에 등록 안 된 문서 (있어도 못 찾으면 없는 것과 같다)
#   4. 깨진 ID 참조 (D-NN / R-NN 이 목록에 없음)
#   5. 오래 아무 일도 없던 규칙 (강등 후보)
#
# 실패해도 exit 1을 내지만, 대부분은 "고쳐야 할 것"이지 "망가진 것"은 아니다.

cd "$(dirname "$0")/.." || exit 1
fail=0
note() { printf '  %s\n' "$1"; }

echo "── 1. CLAUDE.md 크기 한도 (R-17)"
check_size() {
  local f="$1" limit="$2"
  [ -f "$f" ] || return 0
  local n; n=$(wc -m < "$f" | tr -d ' ')
  if [ "$n" -gt "$limit" ]; then
    note "초과  $f  ${n}자 / 한도 ${limit}자 → docs/로 내려보낼 것"
    fail=1
  else
    note "  ok  $f  ${n}자 / ${limit}자"
  fi
}
check_size CLAUDE.md 6000
check_size web/CLAUDE.md 3000
check_size db/CLAUDE.md 2000
check_size extension/CLAUDE.md 2000

echo
echo "── 2. 문서 머리글 (언제 읽나 / 최종 갱신·검증)"
while IFS= read -r f; do
  case "$f" in docs/archive/*) continue;; esac
  if ! head -5 "$f" | grep -q '언제 읽나'; then
    note "누락  $f  → '> **언제 읽나**: ...' 3줄 머리글을 넣을 것"
    fail=1
  fi
done < <(find docs -name '*.md' | sort)

echo
echo "── 3. docs/INDEX.md 등록 여부"
while IFS= read -r f; do
  case "$f" in docs/INDEX.md|docs/archive/*|docs/sessions/2*) continue;; esac
  name="${f#docs/}"
  if ! grep -q "$name" docs/INDEX.md; then
    note "미등록  $f  → docs/INDEX.md에 한 줄 추가할 것"
    fail=1
  fi
done < <(find docs -name '*.md' | sort)

echo
echo "── 4. ID 참조 (D-NN / R-NN)"
ids_d=$(grep -o '^### D-[0-9]\+' docs/decisions/INDEX.md 2>/dev/null | grep -o 'D-[0-9]\+' | sort -u)
ids_r=$(grep -o '^### R-[0-9]\+' docs/rules/INDEX.md 2>/dev/null | grep -o 'R-[0-9]\+' | sort -u)
used=$(grep -rho '\b[DR]-[0-9]\{2\}\b' --include='*.md' --include='*.js' --include='*.sql' \
        docs web db scripts CLAUDE.md STATUS.md 2>/dev/null \
        | grep -v archive | sort -u)
for id in $used; do
  case "$id" in
    D-*) echo "$ids_d" | grep -qx "$id" || { note "깨진 참조  $id  (decisions/INDEX.md에 없음)"; fail=1; };;
    R-*) echo "$ids_r" | grep -qx "$id" || { note "깨진 참조  $id  (rules/INDEX.md에 없음)"; fail=1; };;
  esac
done
[ -z "$used" ] && note "  참조 없음"

echo
echo "── 5. 강등 후보 규칙 (발동 0 · 위반 0)"
if [ -f docs/rules/INDEX.md ]; then
  awk '/^### [DR]-[0-9]+/ { id=$2 }
       /발동 0 · 위반 0/ { print "  후보  " id }' docs/rules/INDEX.md
  note "(신설 직후면 정상. 오래 이 상태면 정말 필요한 규칙인지 회고할 것)"
fi

echo
if [ "$fail" -eq 0 ]; then echo "통과 — 고칠 것 없음"; else echo "위에 표시된 항목을 고칠 것"; fi
exit "$fail"
