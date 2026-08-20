#!/bin/bash
# 전체 정합성 검증. 프로젝트 루트에서 실행: bash scripts/check_all.sh
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== 1. JS 구문 검사 ==="
for f in extension/*.js web/api/*.js web/js/*.js; do
  node --check "$f" && echo "  OK  $f"
done

echo ""
echo "=== 2. HTML/JS id 정합성 ==="
python3 - <<'PY'
import re, glob

# web 로직은 web/js/*.js 여러 파일로 나뉘어 있지만 전역 스코프를 공유하므로
# 검사할 때는 전부 이어붙여 한 덩어리로 본다(분할 전 app.js 하나였을 때와 동일한 검사).
for pair in [("extension/popup.html", ["extension/popup.js"]),
             ("web/index.html", sorted(glob.glob("web/js/*.js")))]:
    html_path, js_paths = pair
    html = open(html_path, encoding="utf-8").read()
    js = "\n".join(open(p, encoding="utf-8").read() for p in js_paths)
    js_path = js_paths[0] if len(js_paths) == 1 else f"web/js/*.js ({len(js_paths)}개)"

    ids_html = set(re.findall(r'id="([^"]+)"', html))
    ids_js = set(re.findall(r"getElementById\('([^']+)'\)", js))
    ids_js |= set(re.findall(r"\$\('#([\w-]+)'\)", js))  # web 쪽은 $() 헬퍼 사용

    # q,tb는 동적 생성 HTML 내부용. metrics*는 지표 배너를 JS가 만들어 붙이는 것이라
    # index.html에 없다(web/js/90-boot.js autoSyncMetrics).
    missing = ids_js - ids_html - {"q", "tb", "metricsBanner", "metricsOpenWing", "metricsRetry"}
    status = "OK" if not missing else "FAIL"
    print(f"  {status}  {js_path} -> {html_path}"
          + (f"  누락: {sorted(missing)}" if missing else ""))
PY

echo ""
echo "=== 3. SQL 구문 검사 (sqlglot 필요: pip install sqlglot) ==="
python3 - <<'PY'
import re, glob
import warnings
warnings.filterwarnings("ignore")
try:
    import sqlglot
    import logging
    logging.getLogger("sqlglot").setLevel(logging.ERROR)
except ImportError:
    print("  SKIP  pip install sqlglot --break-system-packages 로 설치 후 재실행")
    raise SystemExit

for path in sorted(glob.glob("db/migrations/*.sql")):
    sql = open(path, encoding="utf-8").read()
    body = sql
    for blk in re.findall(r'do \$\$.*?\$\$;', body, re.S):
        body = body.replace(blk, '')
    for fn in re.findall(r'create or replace function.*?\$\$;', body, re.S):
        body = body.replace(fn, '')

    stmts = [s.strip() for s in body.split(';') if s.strip() and not s.strip().startswith('--')]
    ok = fail = 0
    for s in stmts:
        try:
            sqlglot.parse_one(s, dialect='postgres')
            ok += 1
        except Exception:
            fail += 1
    print(f"  {'OK' if fail == 0 else 'CHECK'}  {path}  ({ok}건 성공, {fail}건은 PL/pgSQL 전용 문법일 수 있음)")
PY

echo ""
echo "=== 4. manifest.json 유효성 ==="
python3 -c "import json; json.load(open('extension/manifest.json')); print('  OK  extension/manifest.json')"

echo ""
echo "=== 완료 ==="
