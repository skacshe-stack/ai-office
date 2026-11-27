/* Firebase 설정 파일 (선택)
   ─────────────────────────────────────────────────────────
   아래 값이 null이면 앱은 '로컬 모드'로 동작합니다. (설정 없이 바로 사용 가능)

   채우는 두 가지 방법:
   1) 이 파일에 직접 넣기 — 공개 저장소에 올릴 때는 키 노출을 감안하세요.
      window.AI_OFFICE_FIREBASE_CONFIG = {
        apiKey: "...", authDomain: "...", projectId: "...",
        storageBucket: "...", messagingSenderId: "...", appId: "..."
      };
   2) 앱 화면에서: 오른쪽 위 ⚙ → Firebase 탭 → firebaseConfig 붙여넣기 → 저장 · 연결
      (이때 값은 그 사람의 브라우저 localStorage에만 저장됩니다.)

   ※ apiKey는 웹 클라이언트 공개 키입니다. 실제 보안은 Firestore 규칙으로 잠급니다.
   ※ 이 저장소에는 어떤 키도 들어 있지 않습니다.
   ───────────────────────────────────────────────────────── */
window.AI_OFFICE_FIREBASE_CONFIG = null;
