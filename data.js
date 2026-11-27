/* 도유니 AI 오피스 — 기본 데이터
   처음 방문했을 때 화면을 채우는 값입니다. 이후 내용은 브라우저(localStorage)에 저장됩니다. */

window.AI_OFFICE_DATA = {
  version: 1,
  owner: { name: "도유니", handle: "@bangdoyuni1", avatar: "도" },

  rooms: [
    { id: "great",   name: "대회의실", icon: "🏛️", desc: "안건을 열고 결론까지 모으는 방" },
    { id: "command", name: "지휘실",   icon: "🎯", desc: "바로 실행할 일을 정리하는 방" },
    { id: "lounge",  name: "라운지",   icon: "☕", desc: "가볍게 아이디어를 던지는 방" }
  ],

  /* kind: human | ai
     provider: openai | anthropic | gemini | openrouter | pickle (브릿지 전용) */
  members: [
    {
      id: "me", name: "도유니", short: "도", avatarKind: "text", color: "me",
      kind: "human", badge: "사람 · 의장", role: "안건을 열고 최종 결정을 내립니다."
    },
    {
      id: "pickle", name: "피클", short: "ㅍ", avatarKind: "text", color: "pickle",
      kind: "ai", badge: "AI · 메인 비서", role: "일정·자료·정리를 맡는 메인 비서",
      provider: "pickle", model: "pickle"
    },
    {
      id: "chatgpt", name: "ChatGPT", short: "G", avatarKind: "text", color: "gpt",
      kind: "ai", badge: "AI · 실행", role: "대안 발굴과 실행안 작성",
      provider: "openai", model: "gpt-4o-mini"
    },
    {
      id: "claude", name: "Claude", short: "C", avatarKind: "text", color: "claude",
      kind: "ai", badge: "AI · 검증", role: "논리 점검과 장문 정리",
      provider: "anthropic", model: "claude-3-5-haiku-latest"
    },
    {
      id: "gemini", name: "Gemini", short: "✦", avatarKind: "text", color: "gemini",
      kind: "ai", badge: "AI · 조사", role: "자료 조사와 요약",
      provider: "gemini", model: "gemini-2.0-flash"
    }
  ],

  topics: [
    {
      id: "t-open", roomId: "great", title: "AI 오피스 오픈 준비", status: "open",
      desc: "이 저장소를 켜 두고, 매일 아침 무엇을 받아 볼지 정합니다.",
      createdAtOffsetMin: 600
    },
    {
      id: "t-week", roomId: "great", title: "이번 주 할 일 정리", status: "open",
      desc: "AI에게 맡길 일과 내가 직접 할 일을 나눠 봅니다.",
      createdAtOffsetMin: 300
    },
    {
      id: "t-idea", roomId: "lounge", title: "주말에 해볼 만한 것", status: "hold",
      desc: "가볍게 아이디어만 모아 두는 안건.",
      createdAtOffsetMin: 120
    }
  ],

  messages: [
    { topicId: "t-open", senderId: "me", minutesAgo: 42,
      text: "오피스 문 열었어. @피클 오늘 확인해야 할 것부터 정리해 줘." },
    { topicId: "t-open", senderId: "pickle", minutesAgo: 40, simulated: true,
      text: "네, 도유니 님. 오늘 확인할 것 세 가지로 정리했습니다.\n1) 오피스 주소와 접속 상태 — 배포 후 바로 확인\n2) 아침 브리핑에 넣을 항목 — 울산·부산 소식, 할 일, 날씨\n3) 알림 받을 시간 — 원하시는 시각 하나만 정해 주세요\n정해 주시면 그대로 맞춰 두겠습니다." },
    { topicId: "t-open", senderId: "me", minutesAgo: 32,
      text: "@ChatGPT @Claude 이 구조에서 빠뜨린 게 있을까? 서로 다른 관점으로 봐 줘." },
    { topicId: "t-open", senderId: "chatgpt", minutesAgo: 30, simulated: true,
      text: "실행 관점에서 두 가지가 빠졌습니다.\n· 백업: 지금은 이 브라우저에만 저장되니 JSON 내보내기를 주 1회\n· 권한: 여러 기기에서 쓰려면 Firebase를 연결하고 규칙을 읽기/쓰기로 잠그기\n우선순위는 백업 → 동기화 순서를 권합니다." },
    { topicId: "t-open", senderId: "claude", minutesAgo: 28, simulated: true,
      text: "구조 관점에서는 '안건'과 '방'의 관계만 분명히 하면 충분해 보입니다.\n· 방 = 맥락(대회의실·지휘실·라운지)\n· 안건 = 결정할 단위, 대화는 안건에 붙습니다\n결론: 지금 구조를 유지하고, 안건마다 '결론 한 줄'을 남기는 칸만 추가하면 기록이 남습니다." },
    { topicId: "t-week", senderId: "me", minutesAgo: 90,
      text: "@피클 이번 주는 AI한테 뭘 맡기고 내가 뭘 할지 나눠 줘." },
    { topicId: "t-week", senderId: "pickle", minutesAgo: 88, simulated: true,
      text: "맡길 일: 자료 조사·요약, 초안 작성, 일정 정리.\n직접 하실 일: 최종 확인과 승인, 결제·예약처럼 되돌리기 어려운 결정.\n이 기준으로 나누면 확인하실 일이 절반으로 줄어듭니다." },
    { topicId: "t-idea", senderId: "me", minutesAgo: 20,
      text: "주말에 울산·부산 쪽으로 반나절 나들이 생각 중. @Gemini 후보 몇 개만." },
    { topicId: "t-idea", senderId: "gemini", minutesAgo: 18, simulated: true,
      text: "이동 시간과 실내·실외를 섞어 세 개만 추렸습니다.\n· 울산: 태화강 국가정원 산책 → 근처 카페\n· 부산: 해운대 대신 광안리 산책 → 민락동 저녁\n· 비 오면: 부산 영화의전당·시립미술관\n실제 운영 시간과 휴무는 당일 확인이 필요합니다." }
  ]
};
