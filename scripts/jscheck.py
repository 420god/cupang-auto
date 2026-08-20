# node 없는 환경에서 'JS가 완전히 깨졌는지'만 보는 단순 검사기.
#
# 왜 있나: 2026-08-20에 같은 사고를 네 번 겪었다. 편집 스크립트를 거치면서
# 문자열 안의 개행 이스케이프가 진짜 줄바꿈으로 바뀌어 따옴표가 안 닫혔다.
# 그러면 파일 전체가 파싱 단계에서 죽는데, 확장프로그램에서는
# "팝업 버튼이 하나도 반응 없음"이라는 엉뚱한 증상으로 나타났다.
# 괄호 균형만 보는 검사로는 못 잡는다 — 괄호는 멀쩡하기 때문이다.
#
# 쓰는 법: python scripts/jscheck.py web/js/*.js extension/*.js
# node가 있으면 `node --check`가 더 정확하다. 이건 node가 없을 때의 대용이다.
#
# 잡는 것 두 가지:
#   1) 괄호 균형
#   2) **따옴표 문자열 안의 진짜 줄바꿈** — ' 와 " 는 줄을 넘을 수 없다.
#      편집 중 \n 이 실제 개행으로 바뀌면 여기서 걸린다(2026-08-20에 세 번 겪음).
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def check(path):
    src = open(path, encoding='utf-8').read()
    i, n, line = 0, len(src), 1
    stack = []
    close = {'}': '{', ')': '(', ']': '['}
    prev_sig = ''
    errors = []

    while i < n:
        c = src[i]
        if c == '\n':
            line += 1; i += 1; continue
        if c == '/' and i + 1 < n and src[i+1] == '/':
            while i < n and src[i] != '\n': i += 1
            continue
        if c == '/' and i + 1 < n and src[i+1] == '*':
            i += 2
            while i + 1 < n and not (src[i] == '*' and src[i+1] == '/'):
                if src[i] == '\n': line += 1
                i += 1
            i += 2; continue
        if c == '`':                       # 템플릿 문자열은 줄을 넘어도 된다
            i += 1
            while i < n:
                if src[i] == '\\': i += 2; continue
                if src[i] == '\n': line += 1
                if src[i] == '`': break
                i += 1
            i += 1; prev_sig = 'x'; continue
        if c in ('"', "'"):                # 일반 문자열은 줄을 넘으면 문법 오류
            q, start = c, line
            i += 1
            closed = False
            while i < n:
                if src[i] == '\\': i += 2; continue
                if src[i] == '\n':
                    errors.append(f'{start}행: {q} 문자열이 닫히기 전에 줄이 바뀜 (문법 오류)')
                    line += 1; break
                if src[i] == q: closed = True; break
                i += 1
            i += 1; prev_sig = 'x'; continue
        # return/typeof 등 키워드 뒤에도 정규식이 올 수 있다.
        # 이걸 빼면 "return 정규식.test(s)" 같은 정상 코드를 나눗셈으로 오해해 오탐이 난다.
        kw = ''
        k = i - 1
        while k >= 0 and src[k] in ' \t':      # 먼저 공백을 건너뛴다 ("return /..." 의 빈칸)
            k -= 1
        while k >= 0 and (src[k].isalpha() or src[k] == '_'):
            kw = src[k] + kw; k -= 1
        if c == '/' and (prev_sig in '(,=:[!&|?{};' or kw in
                         ('return','typeof','case','in','of','do','else','yield','await','delete','void','new')):
            i += 1; in_class = False
            while i < n:
                if src[i] == '\\': i += 2; continue
                if src[i] == '[': in_class = True
                elif src[i] == ']': in_class = False
                elif src[i] == '/' and not in_class: break
                elif src[i] == '\n': break
                i += 1
            i += 1
            while i < n and src[i].isalpha(): i += 1
            prev_sig = 'x'; continue
        if c in '{([':
            stack.append((c, line))
        elif c in close:
            if not stack or stack[-1][0] != close[c]:
                errors.append(f'{line}행: {c} 짝이 안 맞음')
            else:
                stack.pop()
        if not c.isspace(): prev_sig = c
        i += 1

    if stack:
        errors.append('닫히지 않은 괄호: ' + str([(c, l) for c, l in stack[:5]]))
    name = path.split('/')[-1]
    if errors:
        print(f'  ✗ {name}')
        for e in errors[:8]: print(f'      {e}')
        return False
    print(f'  OK {name}')
    return True

ok = all([check(p) for p in sys.argv[1:]])
sys.exit(0 if ok else 1)
