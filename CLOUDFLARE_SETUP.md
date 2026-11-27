# ☁️ Cloudflare Worker 브릿지 — 5분 설정

브라우저에 API 키를 두지 않고, Worker가 대신 AI를 호출하게 하는 방법입니다.
무료 플랜으로 하루 수백 번의 호출이면 충분합니다.

---

## 1. Worker 만들기

1. https://dash.cloudflare.com → 로그인 → 왼쪽 **Workers & Pages**
2. **Create application → Create Worker** → 이름 예: `doyuni-ai-office` → **Deploy**
3. **Edit code** 를 눌러 편집기를 열고, 기본 코드를 모두 지운 뒤
   이 저장소의 [`cloudflare-worker.js`](./cloudflare-worker.js) 내용을 그대로 붙여넣습니다
4. **Deploy**

배포되면 주소가 생깁니다:
```
https://doyuni-ai-office.<내-서브도메인>.workers.dev
```

---

## 2. API 키 넣기

Worker 화면 → **Settings → Variables and Secrets → Add**

| 이름 | 값 | 종류 |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` | Secret |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Secret |
| `GEMINI_API_KEY` | `AIza...` | Secret |
| `OPENROUTER_API_KEY` | `sk-or-...` | Secret |
| `OFFICE_TOKEN` | 아무 긴 문자열 | Secret (권장) |

- 쓰고 싶은 AI의 키만 넣으면 됩니다
- `OFFICE_TOKEN`을 넣으면 앱 설정의 **공유 토큰**과 같아야만 답합니다 (주소를 아는 사람이 마음대로 쓰는 것을 막음)
- 키를 바꾼 뒤에는 **Deploy**를 다시 눌러야 반영됩니다

---

## 3. 앱에 연결

1. 오피스 앱 → 오른쪽 위 **⚙ → 브릿지**
2. **Worker 주소**에 위 주소 입력 (`https://...workers.dev`)
3. **공유 토큰**에 `OFFICE_TOKEN` 값 입력 (안 넣었으면 비워 둠)
4. **연결 확인** → `연결됨` 이 나오면 성공
5. **저장** → **AI 답변** 탭에서 **실제 AI 답변 사용** 켜기

이제 `@Claude` 처럼 부르면 Worker를 거쳐 실제 답변이 달립니다.

---

## 4. 확인 방법

터미널에서 바로 테스트:

```bash
curl -X POST "https://doyuni-ai-office.<내-서브도메인>.workers.dev" \
  -H "Content-Type: application/json" \
  -d '{"ping": true, "token": "OFFICE_TOKEN에_넣은_값"}'
```

응답 예:
```json
{"ok":true,"providers":["openai","anthropic"],"tokenRequired":true}
```

실제 호출 테스트:
```bash
curl -X POST "https://doyuni-ai-office.<내-서브도메인>.workers.dev" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "system": "한국어로 짧게 답하세요.",
    "prompt": "한 줄로 인사해 줘",
    "token": "OFFICE_TOKEN에_넣은_값"
  }'
```
```json
{"text":"안녕하세요! ...","provider":"openai","model":"gpt-4o-mini"}
```

---

## 5. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `토큰이 맞지 않습니다` (401) | 앱의 공유 토큰과 Worker의 `OFFICE_TOKEN`이 다름 |
| `... 키가 Worker에 설정되지 않았습니다` | 해당 제공자의 환경변수가 없음 → Variables에 추가 후 Deploy |
| `HTTP 429` | 제공자 쪽 사용 한도. 잠시 뒤 다시 시도 |
| 연결 확인이 실패 | 주소 끝의 `/` 제거, `https://` 포함 여부 확인 |
| 답변이 느림 | Worker가 제공자 응답을 기다리는 중. 30초까지 걸릴 수 있음 |

---

## 요청 형식 (직접 쓸 때)

```json
POST /
{
  "provider": "openai | anthropic | gemini | openrouter",
  "model": "gpt-4o-mini",
  "system": "AI의 역할 지시문",
  "context": "최근 대화 요약 (선택)",
  "prompt": "사용자의 요청",
  "token": "OFFICE_TOKEN (없으면 생략)"
}
```

응답: `{"text": "...", "provider": "...", "model": "..."}` 또는 오류 시 `{"error": "..."}`
