#!/usr/bin/env node
/*
 * 카테고리 정리본 CSV를 categories 테이블에 upsert.
 * 기존 행의 kan_category_id/unit1/unit2/commission_rate/product_count/
 * item_count/last_list_at/last_detail_at은 건드리지 않는다 — payload에
 * 그 컬럼들을 아예 넣지 않으므로 PostgREST가 merge-duplicates로 나머지
 * 컬럼만 갱신한다.
 *
 * service_role 키를 쓰지 않는다 (프로젝트 규칙). anon key + 관리자 로그인으로
 * write_for_admin RLS 정책을 통과한다.
 *
 * 사용법 (PowerShell):
 *   $env:SUPABASE_URL = "https://xxxx.supabase.co"
 *   $env:SUPABASE_ANON_KEY = "eyJ..."
 *   $env:SB_ADMIN_EMAIL = "admin@example.com"
 *   $env:SB_ADMIN_PASSWORD = "..."
 *   node scripts/import_categories.js "C:\Users\thezo\Downloads\카테고리 정리본.csv"
 *
 * Node 18+ 필요 (전역 fetch 사용).
 */

const fs = require('fs');

const CSV_PATH = process.argv[2];
if (!CSV_PATH) {
  console.error('사용법: node import_categories.js <csv경로>');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_EMAIL = process.env.SB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SB_ADMIN_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('환경변수 SUPABASE_URL / SUPABASE_ANON_KEY / SB_ADMIN_EMAIL / SB_ADMIN_PASSWORD를 먼저 설정하세요.');
  process.exit(1);
}

/* RFC4180 CSV 파서 (따옴표 안 쉼표/줄바꿈 처리) */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM 제거

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const table = parseCsv(raw).filter((r) => r.length > 1 && r[0] !== '');
  const header = table[0];
  const idx = (name) => header.indexOf(name);

  const iCode = idx('카테고리코드');
  const iName = idx('카테고리명');
  const iPath = idx('전체경로');
  const iDepth = idx('단계');
  const iLeaf = idx('말단여부');
  const iSelected = idx('현재선택');

  if (iCode < 0 || iName < 0 || iPath < 0) {
    console.error('CSV 헤더를 확인하세요:', header);
    process.exit(1);
  }

  const rows = table.slice(1)
    .filter((r) => r[iCode] && r[iCode].trim())
    .filter((r) => (iSelected < 0) || r[iSelected] === 'Y')
    .map((r) => {
      const fullPath = (r[iPath] || '').trim();
      const parts = fullPath.split('>');
      return {
        category_code: r[iCode].trim(),
        name: (r[iName] || '').trim(),
        full_path: fullPath,
        depth: r[iDepth] ? parseInt(r[iDepth], 10) : parts.length,
        is_leaf: (r[iLeaf] || 'Y').trim() === 'Y',
        root_name: parts[0] || '',
        parent_path: parts.length > 1 ? parts.slice(0, -1).join('>') : null
      };
    });

  console.log(`대상 ${rows.length}건. 로그인 중...`);

  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const login = await loginRes.json();
  if (!loginRes.ok) {
    console.error('로그인 실패:', login.error_description || login.msg || login);
    process.exit(1);
  }
  const accessToken = login.access_token;

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/categories?on_conflict=category_code`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`업로드 실패 (행 ${i}~${i + chunk.length}):`, res.status, errText);
      process.exit(1);
    }
    done += chunk.length;
    console.log(`업로드 ${done}/${rows.length}`);
  }

  console.log('완료.');
}

main().catch((e) => { console.error(e); process.exit(1); });
