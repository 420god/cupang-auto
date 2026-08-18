/* Vercel 서버리스 함수 — PDF 바이트를 받아 텍스트만 뽑아서 돌려준다.
   **하는 일이 이것뿐인 게 의도다.** 텍스트를 청구서 줄 구조로 되돌리는 로직은
   브라우저(web/app.js의 parseCouplusInvoice)에 있다:
   - 파싱 규칙은 자주 손보게 되는데, 브라우저 쪽이면 배포 없이 바로 확인된다
   - 사용자가 텍스트를 직접 붙여넣는 경로와 로직이 한 벌로 공유된다
   - 서버는 라이브러리 의존이 필요한 부분(PDF 해석)만 담당해 책임이 명확해진다

   프론트엔드는 번들러도 의존성도 없이 유지한다는 원칙(web/CLAUDE.md) 때문에
   브라우저에 PDF 라이브러리를 넣지 않고 이 함수를 쓴다. api/*.js는 Vercel이
   번들러 없이 그대로 함수로 인식하므로 그 원칙과 부딪히지 않는다.

   쿠팡 API를 부르는 sales-today.js와 달리 **외부 네트워크 호출이 전혀 없다** —
   순수 계산이라 고정 IP 문제(docs/decisions.md 2026-08-13)와 무관하다. */

const pdf = require('pdf-parse');

const MAX_BYTES = 8 * 1024 * 1024; // 청구서 PDF는 보통 100KB 남짓. 사고 방지용 상한.

/* pdf-parse의 **기본 텍스트 추출기는 칸 사이 공백을 버린다.**
   2026-08-18 실제로 겪음: "계란 비슷 왁뿌 세알 20 6 9.8 129.8 6 8 128"이
   "비슷 왁뿌 세알2069.8129.868128"로 붙어서 나와 파서가 통째로 오작동했다
   (수량 14196.4 같은 값이 만들어짐). PDF 자체엔 정보가 멀쩡히 들어 있고
   (pypdf로 뽑으면 공백이 정상) 추출기만의 문제였다.

   그래서 pdf-parse가 제공하는 pagerender 훅으로 **좌표 기반 추출**을 직접 한다.
   pdfjs가 주는 각 텍스트 조각의 x/y와 폭을 써서
     - y가 비슷하면 같은 줄로 묶고
     - x 순으로 정렬한 뒤
     - 앞 조각이 끝난 x와 다음 조각의 x 사이가 벌어져 있으면 공백을 넣는다
   무조건 공백으로 잇지 않는 이유: 한글은 한 단어가 여러 조각으로 쪼개져 오는 일이
   흔해서, 그러면 "계 란 비 슷"처럼 글자마다 띄어써진다.

   새 의존성을 추가하지 않는다 — pdf-parse가 내부적으로 쓰는 pdfjs를 그대로 쓴다. */
const LINE_TOL = 3;   // 같은 줄로 볼 y 오차(pt)
const GAP_MIN = 1;    // 이만큼 벌어지면 칸이 다른 것으로 보고 공백을 넣는다

function renderPageByPosition(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
    .then((tc) => {
      const items = (tc.items || [])
        .filter((it) => it.str != null && it.str !== '')
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width || 0
        }));
      if (!items.length) return '';

      items.sort((a, b) => (Math.abs(a.y - b.y) > LINE_TOL ? b.y - a.y : a.x - b.x));

      const lines = [];
      let cur = null;
      items.forEach((it) => {
        if (!cur || Math.abs(it.y - cur.y) > LINE_TOL) {
          cur = { y: it.y, parts: [] };
          lines.push(cur);
        }
        cur.parts.push(it);
      });

      return lines.map((ln) => {
        ln.parts.sort((a, b) => a.x - b.x);
        let out = '';
        let prevEnd = null;
        ln.parts.forEach((p) => {
          if (prevEnd !== null && p.x - prevEnd > GAP_MIN) out += ' ';
          out += p.str;
          prevEnd = p.x + p.w;
        });
        return out.replace(/\s+/g, ' ').trim();
      }).join('\n');
    });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error('파일이 너무 큽니다(8MB 초과).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' });
    return;
  }
  try {
    const buf = await readBody(req);
    if (!buf.length) {
      res.status(400).json({ error: '빈 요청입니다.' });
      return;
    }
    /* %PDF 시그니처 확인 — 다른 파일을 끌어다 놨을 때 라이브러리 내부 에러 대신
       사람이 읽을 수 있는 메시지를 주기 위함 */
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') {
      res.status(400).json({ error: 'PDF 파일이 아닙니다.' });
      return;
    }
    /* 좌표 기반 추출을 먼저 시도하고, 그게 실패하면 pdf-parse 기본 추출로 물러선다.
       기본 추출은 공백이 뭉개지지만 아무것도 못 주는 것보단 낫고, 화면에서
       "인식된 원문"을 눈으로 확인할 수 있으니 사람이 판단할 수 있다. */
    let text = '';
    let method = 'position';
    try {
      const d = await pdf(buf, { pagerender: renderPageByPosition });
      text = d.text || '';
      if (!text.trim()) throw new Error('빈 텍스트');
      res.status(200).json({ text, pages: d.numpages || null, method });
      return;
    } catch (inner) {
      method = 'pdf-parse-default';
    }
    const data = await pdf(buf);
    res.status(200).json({
      text: data.text || '',
      pages: data.numpages || null,
      method
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'PDF 해석에 실패했습니다.' });
  }
};
