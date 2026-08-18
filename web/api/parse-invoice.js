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
    const data = await pdf(buf);
    res.status(200).json({
      text: data.text || '',
      pages: data.numpages || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'PDF 해석에 실패했습니다.' });
  }
};
