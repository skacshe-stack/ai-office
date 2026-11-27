/* ─────────────────────────────────────────────────────────
   도유니 AI 오피스 — 앱 로직
   · 설정 없이 localStorage로 즉시 동작
   · ⚙ 설정에서 Firebase(Firestore) 또는 AI API 키 / Cloudflare Worker 연결
   ───────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var DATA = window.AI_OFFICE_DATA || {};
  var LS_STATE = "doyuni.aiOffice.state.v1";
  var LS_SET = "doyuni.aiOffice.settings.v1";
  var LS_THEME = "doyuni.aiOffice.theme";
  var COLL_TOPICS = "aiOfficeTopics";
  var COLL_MESSAGES = "aiOfficeMessages";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ── 상태 ─────────────────────────────────────────── */
  var state = { rooms: [], members: [], topics: [], messages: [], activeRoomId: "great", activeTopicId: null };
  var settings = {
    firebase: null,          // { apiKey, projectId, ... }
    useLiveAI: false,
    keys: {},                // provider -> { key, model }
    bridge: { url: "", token: "" },
    pushed: { topics: [], messages: [] }
  };

  var ui = {
    senderId: "me",
    mentionIndex: 0,
    mentionMatches: [],
    pending: 0,
    editingTopicId: null,
    cloudStatus: "local",    // local | cloud | error
    cloudNote: "",
    pollTimer: null
  };

  /* ── 유틸 ─────────────────────────────────────────── */
  function uid(prefix) {
    return (prefix || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function toast(msg, kind) {
    var wrap = $("#toastWrap");
    if (!wrap) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind === "err" ? " err" : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === "err" ? 4200 : 2400);
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var ap = h < 12 ? "오전" : "오후";
    h = h % 12 || 12;
    return ap + " " + h + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function dayLabel(ms) {
    var d = new Date(ms);
    var now = new Date();
    var k = dayKey(ms), tk = dayKey(now.getTime());
    var y = new Date(now.getTime() - 86400000);
    if (k === tk) return "오늘";
    if (k === dayKey(y.getTime())) return "어제";
    return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일";
  }
  function statusLabel(s) { return s === "done" ? "완료" : s === "hold" ? "보류" : "진행 중"; }

  /* ── 저장 ─────────────────────────────────────────── */
  var saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(LS_STATE, JSON.stringify({
          rooms: state.rooms, members: state.members, topics: state.topics,
          messages: state.messages, activeRoomId: state.activeRoomId,
          activeTopicId: state.activeTopicId
        }));
      } catch (e) {
        console.warn("저장 실패", e);
      }
    }, 150);
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) { console.warn(e); }
  }

  function seedState() {
    var now = Date.now();
    state.rooms = (DATA.rooms || []).map(function (r) { return Object.assign({}, r); });
    state.members = (DATA.members || []).map(function (m) { return Object.assign({}, m); });
    state.topics = (DATA.topics || []).map(function (t) {
      var created = now - (t.createdAtOffsetMin || 0) * 60000;
      return {
        id: t.id, roomId: t.roomId, title: t.title, desc: t.desc || "",
        status: t.status || "open", createdAt: created, updatedAt: created
      };
    });
    state.messages = (DATA.messages || []).map(function (m) {
      var created = now - (m.minutesAgo || 0) * 60000;
      return {
        id: m.id || uid("m_"), topicId: m.topicId, senderId: m.senderId,
        text: m.text, createdAt: created, simulated: !!m.simulated
      };
    });
    state.activeRoomId = "great";
    var first = state.topics.filter(function (t) { return t.roomId === "great"; })[0];
    state.activeTopicId = first ? first.id : null;
  }

  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(LS_STATE); } catch (e) { raw = null; }
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && Array.isArray(s.topics) && Array.isArray(s.messages) && Array.isArray(s.members)) {
          state.rooms = s.rooms && s.rooms.length ? s.rooms : DATA.rooms;
          state.members = s.members.length ? s.members : DATA.members;
          state.topics = s.topics;
          state.messages = s.messages;
          state.activeRoomId = s.activeRoomId || "great";
          state.activeTopicId = s.activeTopicId || null;
          normalize();
          return;
        }
      } catch (e) { /* 깨진 저장값은 새로 시작 */ }
    }
    seedState();
    saveState();
  }

  function normalize() {
    // 방이 사라졌거나 안건이 없는 경우 보정
    if (!byId(state.rooms, state.activeRoomId)) state.activeRoomId = state.rooms[0] ? state.rooms[0].id : "great";
    var t = byId(state.topics, state.activeTopicId);
    if (!t || t.roomId !== state.activeRoomId) {
      var first = state.topics.filter(function (x) { return x.roomId === state.activeRoomId; })[0];
      state.activeTopicId = first ? first.id : null;
    }
  }

  function loadSettings() {
    var raw = null;
    try { raw = localStorage.getItem(LS_SET); } catch (e) { raw = null; }
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && typeof s === "object") {
          settings.firebase = s.firebase || null;
          settings.useLiveAI = !!s.useLiveAI;
          settings.keys = s.keys || {};
          settings.bridge = s.bridge || { url: "", token: "" };
          settings.pushed = s.pushed || { topics: [], messages: [] };
        }
      } catch (e) { /* 무시 */ }
    }
    if (!settings.bridge) settings.bridge = { url: "", token: "" };
    if (!settings.pushed) settings.pushed = { topics: [], messages: [] };
    if (window.AI_OFFICE_FIREBASE_CONFIG && !settings.firebase) {
      settings.firebase = window.AI_OFFICE_FIREBASE_CONFIG;
    }
  }

  /* ── 멤버/표시 ────────────────────────────────────── */
  function member(id) { return byId(state.members, id) || { id: id, name: id, short: "?", color: "default", kind: "ai", badge: "AI" }; }
  function aiMembers() { return state.members.filter(function (m) { return m.kind === "ai"; }); }
  function senderName(id) {
    var m = member(id);
    return m.name;
  }

  function memberAvatar(m, extra) {
    return '<span class="avatar ' + esc(m.color || "default") + (extra ? " " + extra : "") + '" aria-hidden="true">' + esc(m.short || m.name.slice(0, 1)) + "</span>";
  }

  /* ── 테마 ─────────────────────────────────────────── */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var lines = theme === "dark";
    var icon = $("#themeIcon");
    if (icon) {
      icon.innerHTML = lines
        ? '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>'
        : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>';
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", lines ? "#101614" : "#f5f7f6");
  }

  /* ── 렌더: 방 ─────────────────────────────────────── */
  function renderRooms() {
    var box = $("#rooms");
    box.innerHTML = state.rooms.map(function (r) {
      var active = r.id === state.activeRoomId ? " active" : "";
      return '<button class="room-btn' + active + '" type="button" data-room="' + esc(r.id) + '" title="' + esc(r.desc || "") + '">' +
        '<span class="emoji" aria-hidden="true">' + esc(r.icon || "💬") + "</span>" + esc(r.name) + "</button>";
    }).join("");
  }

  /* ── 렌더: 안건 목록 ──────────────────────────────── */
  function topicsOfRoom(roomId) {
    return state.topics
      .filter(function (t) { return t.roomId === roomId; })
      .sort(function (a, b) { return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt); });
  }
  function messagesOf(topicId) {
    return state.messages
      .filter(function (m) { return m.topicId === topicId; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  function renderTopics() {
    var list = topicsOfRoom(state.activeRoomId);
    var box = $("#topicList");
    $("#topicCount").textContent = String(list.length);

    if (!list.length) {
      box.innerHTML = '<div class="empty-topics">아직 안건이 없습니다.<br>‘새 안건’으로 첫 안건을 열어 보세요.</div>';
      return;
    }

    box.innerHTML = list.map(function (t) {
      var msgs = messagesOf(t.id);
      var last = msgs[msgs.length - 1];
      var peek = last ? senderName(last.senderId) + " · " + last.text.replace(/\s+/g, " ").slice(0, 34) : (t.desc || "대화를 시작해 보세요");
      var active = t.id === state.activeTopicId ? " active" : "";
      var done = t.status === "done" ? " done" : "";
      return '<div class="topic-item' + active + done + '" role="button" tabindex="0" data-topic="' + esc(t.id) + '">' +
        '<div class="topic-title"><span class="status-dot ' + esc(t.status) + '"></span><span>' + esc(t.title) + "</span></div>" +
        '<div class="topic-meta"><span class="peek">' + esc(peek) + '</span><span class="cnt">' + (msgs.length ? msgs.length : "") + "</span></div>" +
        '<button class="topic-more" type="button" data-edit="' + esc(t.id) + '" aria-label="안건 수정">' +
        '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' +
        "</div>";
    }).join("");
  }

  /* ── 렌더: 채팅 머리 ──────────────────────────────── */
  function renderHead() {
    var head = $("#chatHead");
    var topic = byId(state.topics, state.activeTopicId);
    if (!topic) {
      head.innerHTML = "";
      return;
    }
    var msgs = messagesOf(topic.id);
    var senders = [];
    msgs.forEach(function (m) { if (senders.indexOf(m.senderId) === -1) senders.push(m.senderId); });
    var stack = senders.slice(0, 5).map(function (id) {
      return memberAvatar(member(id));
    }).join("");
    var room = byId(state.rooms, topic.roomId) || { name: "" };

    head.innerHTML =
      '<div class="ch-main">' +
        '<div class="ch-title"><span>' + esc(topic.title) + "</span></div>" +
        '<div class="ch-sub">' +
          '<button class="chip-status ' + esc(topic.status) + '" id="statusChip" type="button" title="눌러서 상태 변경">' +
            '<span class="status-dot ' + esc(topic.status) + '"></span>' + statusLabel(topic.status) +
          "</button>" +
          "<span>" + esc(room.name || "") + " · 메시지 " + msgs.length + "개</span>" +
          (topic.desc ? '<span class="ch-desc" title="' + esc(topic.desc) + '">· ' + esc(topic.desc.slice(0, 40)) + (topic.desc.length > 40 ? "…" : "") + "</span>" : "") +
        "</div>" +
      "</div>" +
      (stack ? '<div class="members-stack" aria-hidden="true">' + stack + "</div>" : "") +
      '<button class="icon-btn" id="editTopicBtn" type="button" aria-label="안건 수정">' +
        '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>' +
      "</button>";
  }

  /* ── 렌더: 메시지 ─────────────────────────────────── */
  function mentionRegex() {
    var names = state.members.map(function (m) { return m.name; }).concat(["전체", "all"]);
    names.sort(function (a, b) { return b.length - a.length; });
    return new RegExp("@(" + names.map(escRe).join("|") + ")", "g");
  }

  function fmtBody(text) {
    var safe = esc(text);
    var re = mentionRegex();
    return safe.replace(re, function (m) { return "<mark>" + m + "</mark>"; });
  }

  function renderMessages() {
    var box = $("#messages");
    var topic = byId(state.topics, state.activeTopicId);

    if (!topic) {
      box.innerHTML =
        '<div class="chat-empty">' +
          '<div class="big" aria-hidden="true">🏛️</div>' +
          "<h3>아직 열린 안건이 없습니다</h3>" +
          "<p>안건을 하나 열면 AI 멤버들을 불러 대화를 시작할 수 있습니다.<br>설정 없이도 바로 쓸 수 있고, 내용은 이 기기에 저장됩니다.</p>" +
          '<button class="btn primary" type="button" data-act="new-topic">첫 안건 열기</button>' +
        "</div>";
      return;
    }

    var msgs = messagesOf(topic.id);
    if (!msgs.length) {
      box.innerHTML =
        '<div class="chat-empty">' +
          '<div class="big" aria-hidden="true">💬</div>' +
          "<h3>" + esc(topic.title) + "</h3>" +
          "<p>이 안건의 첫 이야기를 남겨 보세요.<br>@피클 처럼 부르면 해당 AI가 답합니다.</p>" +
          '<div class="row-actions" style="justify-content:center">' +
            '<button class="chip" type="button" data-quick="@피클 이 안건 어떻게 시작하면 좋을까?">@피클에게 묻기</button>' +
            '<button class="chip" type="button" data-quick="@전체 의견을 한 번씩 줘">@전체 소집</button>' +
          "</div>" +
        "</div>";
      return;
    }

    var html = "";
    var lastDay = null;
    msgs.forEach(function (m) {
      var dk = dayKey(m.createdAt);
      if (dk !== lastDay) {
        html += '<div class="day-sep">' + esc(dayLabel(m.createdAt)) + "</div>";
        lastDay = dk;
      }
      var mem = member(m.senderId);
      var mine = mem.kind === "human";
      html += '<div class="msg' + (mine ? " mine" : "") + '" data-id="' + esc(m.id) + '">' +
        memberAvatar(mem) +
        '<div class="msg-main">' +
          '<div class="msg-top">' +
            '<span class="msg-name">' + esc(mem.name) + "</span>" +
            '<span class="badge ' + (mem.kind === "human" ? "human" : "") + '">' + esc(mem.badge || (mem.kind === "human" ? "사람" : "AI")) + "</span>" +
            (m.simulated ? '<span class="badge sim" title="API 키를 연결하기 전까지 나오는 예시 답변입니다">예시</span>' : "") +
            '<span class="msg-time">' + fmtTime(m.createdAt) + "</span>" +
          "</div>" +
          '<div class="bubble">' + fmtBody(m.text) + "</div>" +
          '<div class="msg-actions">' +
            '<button class="mini-btn" type="button" data-act="copy" data-id="' + esc(m.id) + '">복사</button>' +
            '<button class="mini-btn" type="button" data-act="del-msg" data-id="' + esc(m.id) + '">삭제</button>' +
          "</div>" +
        "</div>" +
      "</div>";
    });

    box.innerHTML = html;
  }

  function scrollBottom(force) {
    var sc = $("#chatScroll");
    if (!sc) return;
    var near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 220;
    if (force || near) {
      requestAnimationFrame(function () { sc.scrollTop = sc.scrollHeight; });
    }
  }

  function renderChat() { renderHead(); renderMessages(); }

  /* ── 렌더: 입력 영역 ──────────────────────────────── */
  function renderChips() {
    var box = $("#chips");
    var list = aiMembers();
    box.innerHTML = list.map(function (m) {
      return '<button class="chip" type="button" data-quick="@' + esc(m.name) + ' ">' +
        '<span class="dotc" aria-hidden="true">@</span>' + esc(m.name) + "</button>";
    }).join("") + '<button class="chip" type="button" data-quick="@전체 "><span class="dotc" aria-hidden="true">@</span>전체</button>';
  }

  function renderSender() {
    var m = member(ui.senderId);
    $("#senderAvatar").textContent = m.short || m.name.slice(0, 1);
    $("#senderAvatar").className = "avatar tiny " + (m.color || "");
    $("#senderLabel").textContent = m.name;
    var note = $("#composerNote");
    if (m.kind === "ai") {
      note.textContent = "‘" + m.name + "’ 자격으로 입력 중 — 실제로는 내가 대신 말합니다.";
    } else if (ui.cloudStatus === "cloud") {
      note.textContent = "Firestore에 연결됨 · 다른 기기와 대화가 동기화됩니다.";
    } else if (settings.useLiveAI && hasAnyKey()) {
      note.textContent = "@멘션하면 연결된 AI가 실제로 답합니다.";
    } else {
      note.textContent = "@멘션하면 예시 답변이 달립니다 · 실제 AI는 ⚙ 설정에서 연결";
    }
  }

  function renderSenderMenu() {
    var menu = $("#senderMenu");
    menu.innerHTML = state.members.map(function (m) {
      return '<button class="sender-opt' + (m.id === ui.senderId ? " on" : "") + '" type="button" role="option" data-sender="' + esc(m.id) + '">' +
        memberAvatar(m, "tiny") + "<span>" + esc(m.name) + "</span><small>" + (m.kind === "human" ? "나" : "AI") + "</small></button>";
    }).join("");
  }

  function renderMode() {
    var badge = $("#modeBadge"), text = $("#modeText");
    badge.classList.remove("live", "error");
    if (ui.cloudStatus === "cloud") { badge.classList.add("live"); text.textContent = "Firestore 연결"; }
    else if (ui.cloudStatus === "error") { badge.classList.add("error"); text.textContent = "연결 확인 필요"; }
    else text.textContent = "로컬 모드";
    badge.title = ui.cloudNote || "연결 상태 · 눌러서 설정 열기";
    renderSender();
  }

  /* ── 안건 조작 ────────────────────────────────────── */
  function selectTopic(id) {
    var t = byId(state.topics, id);
    if (!t) return;
    state.activeRoomId = t.roomId;
    state.activeTopicId = t.id;
    renderRooms(); renderTopics(); renderChat(); closeDrawer(); scrollBottom(true); saveState();
  }

  function selectRoom(id) {
    state.activeRoomId = id;
    var list = topicsOfRoom(id);
    state.activeTopicId = list[0] ? list[0].id : null;
    renderRooms(); renderTopics(); renderChat(); closeDrawer(); saveState();
    scrollBottom(true);
  }

  function openTopicDialog(topicId) {
    ui.editingTopicId = topicId || null;
    var t = topicId ? byId(state.topics, topicId) : null;
    $("#topicDialogTitle").textContent = t ? "안건 수정" : "새 안건";
    $("#topicTitle").value = t ? t.title : "";
    $("#topicDesc").value = t ? (t.desc || "") : "";
    $("#topicRoom").value = t ? t.roomId : state.activeRoomId;
    $("#topicStatus").value = t ? t.status : "open";
    var del = $("#topicDeleteBtn");
    if (del) del.hidden = !t;
    $("#topicDialog").showModal();
    setTimeout(function () { $("#topicTitle").focus(); }, 60);
  }

  function saveTopic() {
    var title = $("#topicTitle").value.trim();
    if (!title) { toast("안건 제목을 적어 주세요", "err"); return false; }
    var desc = $("#topicDesc").value.trim();
    var roomId = $("#topicRoom").value;
    var status = $("#topicStatus").value;

    if (ui.editingTopicId) {
      var t = byId(state.topics, ui.editingTopicId);
      if (t) {
        t.title = title; t.desc = desc; t.roomId = roomId; t.status = status; t.updatedAt = Date.now();
        state.activeRoomId = roomId; state.activeTopicId = t.id;
        Cloud.pushTopic(t);
      }
      toast("안건을 수정했습니다");
    } else {
      var now = Date.now();
      var nt = { id: uid("t_"), roomId: roomId, title: title, desc: desc, status: status, createdAt: now, updatedAt: now };
      state.topics.push(nt);
      state.activeRoomId = roomId;
      state.activeTopicId = nt.id;
      Cloud.pushTopic(nt);
      toast("안건을 열었습니다");
    }
    saveState();
    renderRooms(); renderTopics(); renderChat(); scrollBottom(true);
    return true;
  }

  function deleteTopic(id) {
    var t = byId(state.topics, id);
    if (!t) return;
    if (!confirm("‘" + t.title + "’ 안건과 대화를 지웁니다.\n되돌릴 수 없습니다. 계속할까요?")) return;
    state.topics = state.topics.filter(function (x) { return x.id !== id; });
    state.messages = state.messages.filter(function (m) { return m.topicId !== id; });
    settings.pushed.topics = settings.pushed.topics.filter(function (x) { return x !== id; });
    saveSettings();
    if (state.activeTopicId === id) {
      var list = topicsOfRoom(state.activeRoomId);
      state.activeTopicId = list[0] ? list[0].id : null;
    }
    Cloud.remove(COLL_TOPICS, id);
    saveState();
    renderTopics(); renderChat();
    toast("안건을 지웠습니다");
    $("#topicDialog").close();
  }

  function cycleStatus() {
    var t = byId(state.topics, state.activeTopicId);
    if (!t) return;
    t.status = t.status === "open" ? "hold" : t.status === "hold" ? "done" : "open";
    t.updatedAt = Date.now();
    Cloud.pushTopic(t);
    saveState(); renderHead(); renderTopics();
    toast("상태: " + statusLabel(t.status));
  }

  /* ── 메시지 전송 ──────────────────────────────────── */
  function addMessage(partial) {
    var msg = {
      id: partial.id || uid("m_"),
      topicId: partial.topicId,
      senderId: partial.senderId,
      text: partial.text,
      createdAt: partial.createdAt || Date.now(),
      simulated: !!partial.simulated
    };
    state.messages.push(msg);
    var t = byId(state.topics, msg.topicId);
    if (t) t.updatedAt = msg.createdAt;
    saveState();
    return msg;
  }

  function parseMentioned(text) {
    var lower = text.toLowerCase();
    var out = [];
    if (text.indexOf("@전체") !== -1 || /@all(\b|$)/i.test(lower) || /@모두/.test(text)) {
      return aiMembers();
    }
    state.members.forEach(function (m) {
      if (m.kind !== "ai") return;
      if (lower.indexOf("@" + m.name.toLowerCase()) !== -1) out.push(m);
    });
    return out;
  }

  function sendMessage() {
    var input = $("#input");
    var text = input.value.replace(/\s+$/, "");
    if (!text.trim()) return;
    var topic = byId(state.topics, state.activeTopicId);
    if (!topic) { toast("먼저 안건을 열어 주세요", "err"); openTopicDialog(null); return; }

    var sender = member(ui.senderId);
    var msg = addMessage({ topicId: topic.id, senderId: sender.id, text: text });
    Cloud.pushMessage(msg);

    input.value = "";
    autoGrow();
    hideMention();
    renderTopics(); renderMessages(); scrollBottom(true);

    if (sender.kind === "human") {
      var targets = parseMentioned(text);
      targets = targets.slice(0, 3);
      if (targets.length) {
        targets.forEach(function (m, i) {
          setTimeout(function () { respondAs(m, topic, text); }, 420 + i * 260);
        });
      }
    }
  }

  /* ── AI 응답 ──────────────────────────────────────── */
  function hasAnyKey() {
    var k = settings.keys || {};
    return !!(settings.bridge.url || (k.openai && k.openai.key) || (k.anthropic && k.anthropic.key) ||
      (k.gemini && k.gemini.key) || (k.openrouter && k.openrouter.key));
  }

  function providerKey(provider) {
    var k = settings.keys[provider];
    return k && k.key ? k.key : "";
  }
  function providerModel(m) {
    var k = settings.keys[m.provider];
    return (k && k.model) || m.model || "";
  }

  function showTyping(name) {
    var el = $("#typing");
    $("#typingText").textContent = name + " 답변 작성 중…";
    el.hidden = false;
    ui.pending++;
    scrollBottom(true);
  }
  function hideTyping() {
    ui.pending = Math.max(0, ui.pending - 1);
    if (ui.pending === 0) $("#typing").hidden = true;
  }

  function conversationContext(topic, prompt) {
    var msgs = messagesOf(topic.id).slice(-12);
    return "회의실 주제: " + topic.title + (topic.desc ? "\n안건 설명: " + topic.desc : "") +
      "\n\n최근 대화:\n" + msgs.map(function (m) {
        return senderName(m.senderId) + ": " + m.text;
      }).join("\n");
  }

  function buildSystem(m) {
    return "당신은 '도유니 AI 오피스'의 AI 멤버 " + m.name + "입니다. 역할: " + (m.role || "") +
      ". 한국어로 짧고 실용적으로 답합니다. 과장하지 말고, 확인이 필요한 것은 확인이 필요하다고 말합니다. " +
      "인사말은 생략하고 바로 핵심부터 씁니다. 답변은 3~8줄 안으로 정리합니다.";
  }

  function respondAs(memberObj, topic, prompt) {
    if (ui.pending > 4) return;
    showTyping(memberObj.name);

    var live = settings.useLiveAI && hasAnyKey();
    if (!live) {
      var delay = 700 + Math.random() * 900;
      setTimeout(function () {
        var text = simulateReply(memberObj, topic, prompt);
        var msg = addMessage({ topicId: topic.id, senderId: memberObj.id, text: text, simulated: true });
        hideTyping(); renderTopics(); renderMessages(); scrollBottom(true);
        Cloud.pushMessage(msg);
      }, delay);
      return;
    }

    askAI(memberObj, prompt, conversationContext(topic, prompt))
      .then(function (text) {
        var clean = String(text || "").trim();
        if (!clean) throw new Error("빈 응답");
        var msg = addMessage({ topicId: topic.id, senderId: memberObj.id, text: clean });
        hideTyping(); renderTopics(); renderMessages(); scrollBottom(true);
        Cloud.pushMessage(msg);
      })
      .catch(function (err) {
        hideTyping();
        var msg = addMessage({
          topicId: topic.id, senderId: memberObj.id, simulated: true,
          text: simulateReply(memberObj, topic, prompt) + "\n\n(연결 오류로 예시 답변을 표시했습니다: " + friendlyError(err) + ")"
        });
        renderMessages(); scrollBottom(true);
        Cloud.pushMessage(msg);
        toast(memberObj.name + " 연결 실패 — 설정을 확인해 주세요", "err");
      });
  }

  function friendlyError(err) {
    var m = (err && err.message) || String(err || "");
    if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(m)) {
      return "브라우저에서 직접 호출이 막혔습니다(CORS·네트워크) — ⚙ 설정의 브릿지(Cloudflare Worker)를 권장합니다";
    }
    if (/401|403|invalid.*key|API key/i.test(m)) return "API 키가 거부되었습니다 — " + m;
    if (/429/.test(m)) return "사용 한도에 걸렸습니다 — 잠시 뒤 다시 시도해 주세요";
    return m || "알 수 없는 오류";
  }

  function withTimeout(promise, ms, label) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    return promise(ctrl.signal).then(function (v) { clearTimeout(t); return v; },
      function (e) { clearTimeout(t); throw e; });
  }

  function askAI(m, prompt, context) {
    if (settings.bridge && settings.bridge.url) {
      var payload = {
        provider: m.provider, model: providerModel(m),
        system: buildSystem(m), prompt: prompt, context: context,
        token: settings.bridge.token || ""
      };
      return withTimeout(function (signal) {
        return fetch(settings.bridge.url, {
          method: "POST", signal: signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(readJsonOrThrow).then(function (data) {
          return data.text || data.content || data.reply ||
            (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        });
      }, 40000, "bridge");
    }

    var key = providerKey(m.provider);
    if (!key) return Promise.reject(new Error("키 없음"));

    if (m.provider === "openai" || m.provider === "openrouter") {
      var url = m.provider === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
      return withTimeout(function (signal) {
        return fetch(url, {
          method: "POST", signal: signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({
            model: providerModel(m),
            messages: [
              { role: "system", content: buildSystem(m) },
              { role: "user", content: context + "\n\n요청: " + prompt }
            ],
            temperature: 0.6
          })
        }).then(readJsonOrThrow).then(function (data) {
          return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        });
      }, 40000, "openai");
    }

    if (m.provider === "anthropic") {
      return withTimeout(function (signal) {
        return fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
          },
          body: JSON.stringify({
            model: providerModel(m),
            max_tokens: 900,
            system: buildSystem(m),
            messages: [{ role: "user", content: context + "\n\n요청: " + prompt }]
          })
        }).then(readJsonOrThrow).then(function (data) {
          return (data.content || []).map(function (c) { return c.text || ""; }).join("\n");
        });
      }, 40000, "anthropic");
    }

    if (m.provider === "gemini") {
      var model = providerModel(m) || "gemini-2.0-flash";
      return withTimeout(function (signal) {
        return fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
          ":generateContent?key=" + encodeURIComponent(key), {
          method: "POST", signal: signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystem(m) }] },
            contents: [{ role: "user", parts: [{ text: context + "\n\n요청: " + prompt }] }]
          })
        }).then(readJsonOrThrow).then(function (data) {
          var c = data.candidates && data.candidates[0];
          return c && c.content && c.content.parts ? c.content.parts.map(function (p) { return p.text || ""; }).join("") : "";
        });
      }, 40000, "gemini");
    }

    return Promise.reject(new Error("지원하지 않는 제공자: " + m.provider));
  }

  function readJsonOrThrow(res) {
    return res.text().then(function (body) {
      var data = null;
      try { data = body ? JSON.parse(body) : null; } catch (e) { data = null; }
      if (!res.ok) {
        var detail = data && (data.error && (data.error.message || data.error)) || body.slice(0, 160);
        throw new Error("HTTP " + res.status + " · " + (typeof detail === "string" ? detail : JSON.stringify(detail)));
      }
      if (!data) throw new Error("응답을 읽지 못했습니다");
      return data;
    });
  }

  function simulateReply(m, topic, prompt) {
    var q = prompt.replace(/@(전체|모두|all)/gi, "").replace(/@\S+/g, "").replace(/\s+/g, " ").trim();
    var short = q.length > 48 ? q.slice(0, 48) + "…" : q;
    var title = topic.title;

    var sets = {
      pickle: [
        "네, " + "‘" + title + "’ 안건으로 확인했습니다.\n· 요청: " + (short || "말씀하신 내용") + "\n· 다음 단계: 제가 초안을 만들고, 확인이 필요한 부분만 표시해 두겠습니다.\n바로 시작할까요?",
        "정리해 두겠습니다.\n1) 지금 정할 것 — " + title + "에서 결론이 필요한 한 가지\n2) 제가 맡을 것 — 자료 찾기와 초안\n3) 도유니 님이 정할 것 — 최종 선택과 일정\n순서대로 진행하면 오래 걸리지 않습니다."
      ],
      chatgpt: [
        "실행안 세 가지로 나눠 봤습니다.\n· 최소안: 지금 있는 것 그대로 시작, 하루면 끝\n· 표준안: 백업과 동기화까지 포함, 이틀\n· 확장안: 자동화·알림 추가\n지금은 최소안으로 시작하고 필요할 때 올리는 쪽이 안전합니다.",
        "관점을 하나 더 보태면, " + (short || "이 안건") + "은 ‘결정’과 ‘실행’을 분리하면 빨라집니다.\n결정: 오늘 안에 한 번\n실행: 정해진 뒤 바로\n확인할 지표를 하나만 정해 두시죠."
      ],
      claude: [
        "논리 구조부터 정리했습니다.\n· 전제: " + (short || "이 안건") + "\n· 쟁점: 범위를 어디까지 볼지\n· 결론 후보: 지금 범위를 유지하되 기록을 남기는 방식\n빠진 조건이 있는지 한 번만 더 확인하면 충분해 보입니다.",
        "장문으로 늘이지 않아도 됩니다. 핵심은 세 줄입니다.\n1) 목적이 분명한가\n2) 되돌릴 수 있는가\n3) 다음 확인 시점이 정해졌는가\n세 가지가 채워지면 지금 안대로 진행해도 좋습니다."
      ],
      gemini: [
        "조사 관점에서 보면 확인할 것이 두 가지입니다.\n· 최신 정보인지 (오늘 기준)\n· 조건이 바뀌지 않았는지 (운영 시간·가격·일정)\n확인 필요한 항목을 정리해 두었으니, 원하시면 링크까지 모아 드리겠습니다.",
        "자료를 모아 요약하면 이렇습니다.\n· 공통으로 나오는 의견: 먼저 작게 시작\n· 주의할 점: 비용과 권한\n· 결론: " + title + "은 한 번에 다 하기보다 단계로 나누는 편이 좋습니다."
      ]
    };

    var pool = sets[m.id] || sets[m.provider] || [
      "확인했습니다. " + (short || "말씀하신 내용") + " 기준으로 정리해 두겠습니다.\n더 필요한 정보가 있으면 알려 주세요."
    ];
    var pick = pool[Math.floor(Math.random() * pool.length)];
    return pick;
  }

  /* ── Firebase (Firestore REST) ────────────────────── */
  var Cloud = {
    base: function () {
      if (!settings.firebase || !settings.firebase.projectId) return null;
      return "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(settings.firebase.projectId) +
        "/databases/(default)/documents";
    },
    key: function () { return settings.firebase && settings.firebase.apiKey ? settings.firebase.apiKey : ""; },
    url: function (path) {
      var b = this.base();
      if (!b) return null;
      return b + path + (path.indexOf("?") === -1 ? "?" : "&") + "key=" + encodeURIComponent(this.key());
    },

    toFs: function (obj) {
      var fields = {};
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        if (v === undefined || v === null) return;
        if (typeof v === "string") fields[k] = { stringValue: v };
        else if (typeof v === "number") fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        else if (typeof v === "boolean") fields[k] = { booleanValue: v };
        else fields[k] = { stringValue: String(v) };
      });
      return fields;
    },
    fromFsValue: function (v) {
      if (!v) return null;
      if ("stringValue" in v) return v.stringValue;
      if ("integerValue" in v) return Number(v.integerValue);
      if ("doubleValue" in v) return v.doubleValue;
      if ("booleanValue" in v) return v.booleanValue;
      if ("timestampValue" in v) return Date.parse(v.timestampValue);
      return null;
    },
    fromFs: function (doc) {
      var o = { id: String(doc.name).split("/").pop() };
      var f = doc.fields || {};
      Object.keys(f).forEach(function (k) { o[k] = Cloud.fromFsValue(f[k]); });
      return o;
    },

    test: function (cfg) {
      var b = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(cfg.projectId) +
        "/databases/(default)/documents";
      return fetch(b + "/" + COLL_TOPICS + "?pageSize=1&key=" + encodeURIComponent(cfg.apiKey))
        .then(readJsonOrThrow)
        .then(function (data) { return Array.isArray(data) ? data.length : 0; });
    },

    connect: function () {
      if (!settings.firebase || !settings.firebase.projectId || !settings.firebase.apiKey) {
        ui.cloudStatus = "local"; renderMode(); return;
      }
      ui.cloudNote = "연결 확인 중…";
      Cloud.test(settings.firebase).then(function () {
        ui.cloudStatus = "cloud";
        ui.cloudNote = "Firestore 연결됨 · 5초마다 동기화";
        renderMode();
        startPolling();
        Cloud.pull();
      }).catch(function (e) {
        ui.cloudStatus = "error";
        ui.cloudNote = "Firestore 연결 실패: " + (e.message || e);
        renderMode();
      });
    },

    disconnect: function () {
      stopPolling();
      ui.cloudStatus = "local";
      ui.cloudNote = "";
      renderMode();
    },

    write: function (coll, obj) {
      if (ui.cloudStatus !== "cloud") return Promise.resolve(false);
      var url = Cloud.url("/" + coll + "/" + encodeURIComponent(obj.id));
      return fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: Cloud.toFs(obj) })
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        var list = coll === COLL_TOPICS ? settings.pushed.topics : settings.pushed.messages;
        if (list.indexOf(obj.id) === -1) list.push(obj.id);
        saveSettings();
        return true;
      }).catch(function (e) {
        console.warn("Firestore 저장 실패", e);
        return false;
      });
    },

    remove: function (coll, id) {
      if (ui.cloudStatus !== "cloud") return Promise.resolve();
      var url = Cloud.url("/" + coll + "/" + encodeURIComponent(id));
      return fetch(url, { method: "DELETE" }).catch(function (e) { console.warn("Firestore 삭제 실패", e); });
    },

    pushTopic: function (t) {
      return Cloud.write(COLL_TOPICS, {
        id: t.id, roomId: t.roomId, title: t.title, desc: t.desc || "", status: t.status,
        createdAt: t.createdAt, updatedAt: t.updatedAt || t.createdAt
      });
    },
    pushMessage: function (m) {
      return Cloud.write(COLL_MESSAGES, {
        id: m.id, topicId: m.topicId, senderId: m.senderId, text: m.text,
        createdAt: m.createdAt, simulated: !!m.simulated
      });
    },

    pull: function () {
      if (ui.cloudStatus !== "cloud" || !Cloud.base()) return Promise.resolve();
      var topicsReq = fetch(Cloud.url("/" + COLL_TOPICS + "?pageSize=300"))
        .then(readJsonOrThrow)
        .then(function (data) { return Array.isArray(data) ? data.map(Cloud.fromFs) : []; })
        .catch(function (e) { console.warn("주제 동기화 실패", e); return null; });

      var msgBody = { structuredQuery: { from: [{ collectionId: COLL_MESSAGES }], limit: 800 } };
      var msgReq = fetch(Cloud.url(":runQuery"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msgBody)
      }).then(readJsonOrThrow).then(function (rows) {
        if (!Array.isArray(rows)) return [];
        return rows.filter(function (r) { return r && r.document; }).map(function (r) { return Cloud.fromFs(r.document); });
      }).catch(function (e) { console.warn("메시지 동기화 실패", e); return null; });

      return Promise.all([topicsReq, msgReq]).then(function (res) {
        var serverTopics = res[0], serverMsgs = res[1];
        if (serverTopics) mergeTopics(serverTopics);
        if (serverMsgs) mergeMessages(serverMsgs);
        renderTopics(); renderChat();
      });
    },

    pushAll: function () {
      if (ui.cloudStatus !== "cloud") { toast("먼저 Firebase를 연결해 주세요", "err"); return Promise.resolve(); }
      var jobs = state.topics.map(function (t) { return Cloud.pushTopic(t); })
        .concat(state.messages.map(function (m) { return Cloud.pushMessage(m); }));
      return Promise.all(jobs).then(function () {
        toast("이 기기의 안건 " + state.topics.length + "개, 메시지 " + state.messages.length + "개를 올렸습니다");
      });
    }
  };

  function mergeTopics(server) {
    var serverIds = {};
    server.forEach(function (s) { serverIds[s.id] = true; });

    // 다른 기기에서 지운 것 반영(내가 올렸던 항목만)
    var before = state.topics.length;
    state.topics = state.topics.filter(function (t) {
      if (serverIds[t.id]) return true;
      return settings.pushed.topics.indexOf(t.id) === -1;
    });
    if (state.topics.length !== before) {
      var alive = {};
      state.topics.forEach(function (t) { alive[t.id] = true; });
      state.messages = state.messages.filter(function (m) { return alive[m.topicId]; });
    }

    server.forEach(function (s) {
      if (!s.title) return;
      var cur = byId(state.topics, s.id);
      var obj = {
        id: s.id, roomId: s.roomId || "great", title: s.title, desc: s.desc || "",
        status: s.status || "open", createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || s.createdAt || Date.now()
      };
      if (cur) Object.assign(cur, obj); else state.topics.push(obj);
    });
    normalize();
    saveState();
  }

  function mergeMessages(server) {
    var serverIds = {};
    server.forEach(function (s) { serverIds[s.id] = true; });
    state.messages = state.messages.filter(function (m) {
      if (serverIds[m.id]) return true;
      return settings.pushed.messages.indexOf(m.id) === -1;
    });
    server.forEach(function (s) {
      if (!s.topicId || !s.text || !byId(state.topics, s.topicId)) return;
      var cur = byId(state.messages, s.id);
      var obj = {
        id: s.id, topicId: s.topicId, senderId: s.senderId || "pickle", text: s.text,
        createdAt: s.createdAt || Date.now(), simulated: !!s.simulated
      };
      if (cur) Object.assign(cur, obj); else state.messages.push(obj);
    });
    saveState();
  }

  function startPolling() {
    stopPolling();
    ui.pollTimer = setInterval(function () {
      if (document.hidden) return;
      Cloud.pull();
    }, 5000);
  }
  function stopPolling() {
    if (ui.pollTimer) { clearInterval(ui.pollTimer); ui.pollTimer = null; }
  }

  /* ── 멘션 자동완성 ────────────────────────────────── */
  function currentMentionQuery() {
    var el = $("#input");
    var pos = el.selectionStart;
    var before = el.value.slice(0, pos);
    var m = /@([^\s@]{0,20})$/.exec(before);
    return m ? { q: m[1], start: pos - m[0].length, end: pos } : null;
  }

  function showMention(q) {
    var pop = $("#mentionPop");
    var lower = q.toLowerCase();
    var cands = state.members.filter(function (m) {
      return m.kind === "ai" && (q === "" || m.name.toLowerCase().indexOf(lower) !== -1);
    }).map(function (m) { return { id: m.id, name: m.name, role: m.role || "AI", color: m.color }; });
    if (!cands.length) { hideMention(); return; }
    ui.mentionMatches = cands;
    ui.mentionIndex = clamp(ui.mentionIndex, 0, cands.length - 1);
    pop.innerHTML = cands.map(function (c, i) {
      return '<button class="mention-opt' + (i === ui.mentionIndex ? " sel" : "") + '" type="button" data-mention="' + esc(c.name) + '">' +
        '<span class="avatar tiny ' + esc(c.color) + '">' + esc(c.name.slice(0, 1)) + "</span>" +
        '<span class="who">@' + esc(c.name) + '</span><span class="role">' + esc(c.role) + "</span></button>";
    }).join("");
    pop.hidden = false;
  }

  function hideMention() {
    $("#mentionPop").hidden = true;
    ui.mentionMatches = [];
    ui.mentionIndex = 0;
  }

  function applyMention(name) {
    var el = $("#input");
    var q = currentMentionQuery();
    if (!q) return;
    var before = ElVal(el).slice(0, q.start);
    var after = el.value.slice(el.selectionStart);
    el.value = before + "@" + name + " " + after;
    var pos = q.start + name.length + 2;
    el.setSelectionRange(pos, pos);
    el.focus();
    hideMention();
    autoGrow();
  }
  function ElVal(el) { return el.value; }

  /* ── 입력 처리 ────────────────────────────────────── */
  function autoGrow() {
    var el = $("#input");
    el.style.height = "auto";
    el.style.height = Math.min(160, el.scrollHeight) + "px";
  }

  function insertAtCursor(text) {
    var el = $("#input");
    var start = el.selectionStart || el.value.length;
    var end = el.selectionEnd || el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    var pos = start + text.length;
    el.setSelectionRange(pos, pos);
    el.focus();
    autoGrow();
    var q = currentMentionQuery();
    if (q) showMention(q.q); else hideMention();
  }

  /* ── 설정 UI ──────────────────────────────────────── */
  var PROVIDERS = [
    { id: "openai", name: "ChatGPT", label: "OpenAI", model: "gpt-4o-mini" },
    { id: "anthropic", name: "Claude", label: "Anthropic", model: "claude-3-5-haiku-latest" },
    { id: "gemini", name: "Gemini", label: "Google", model: "gemini-2.0-flash" },
    { id: "openrouter", name: "기타", label: "OpenRouter", model: "openai/gpt-4o-mini" }
  ];

  function renderKeyList() {
    var box = $("#keyList");
    box.innerHTML = PROVIDERS.map(function (p) {
      var cur = settings.keys[p.id] || {};
      var has = cur.key ? " on" : "";
      return '<div class="key-row" data-provider="' + p.id + '">' +
        '<span class="kname">' + esc(p.name) + '<span class="tag">' + esc(p.label) + "</span></span>" +
        '<input type="password" data-key placeholder="API 키 (sk-…)" value="' + esc(cur.key || "") + '" autocomplete="off" spellcheck="false" />' +
        '<span class="key-state' + has + '">' + (cur.key ? "저장됨" : "없음") + "</span>" +
        '<div class="kmodel"><input type="text" data-model placeholder="모델" value="' + esc(cur.model || p.model) + '" spellcheck="false" /></div>' +
        "</div>";
    }).join("");
  }

  function renderSettingsStatus() {
    var modeName = ui.cloudStatus === "cloud" ? "Firestore 연결" : ui.cloudStatus === "error" ? "연결 오류" : "로컬 모드";
    $("#stMode").textContent = modeName;
    $("#stModeDesc").textContent = ui.cloudStatus === "cloud"
      ? "안건과 대화가 Firestore에 저장되고 5초마다 동기화됩니다."
      : "이 브라우저에만 저장됩니다. 설정 없이 바로 동작합니다.";

    var live = settings.useLiveAI && hasAnyKey();
    $("#stAI").textContent = live ? "실제 AI 답변" : "시뮬레이션";
    $("#stAIDesc").textContent = live
      ? (settings.bridge.url ? "Cloudflare Worker를 통해 답합니다." : "브라우저에서 직접 API를 호출합니다.")
      : "키를 넣으면 실제 AI가 답합니다. 지금은 예시 답변이 달립니다.";

    $("#stSync").textContent = ui.cloudStatus === "cloud" ? "Firestore" : "이 기기만";
    $("#stSyncDesc").textContent = ui.cloudStatus === "cloud"
      ? "다른 기기에서 같은 안건과 대화를 봅니다."
      : "Firebase를 연결하면 다른 기기와 같은 대화를 봅니다.";

    var items = [
      { ok: true, text: "기본 모드(로컬 저장) 동작 중" },
      { ok: !!(settings.firebase && settings.firebase.projectId), text: "Firebase Firestore " + (settings.firebase && settings.firebase.projectId ? "설정됨 · " + settings.firebase.projectId : "미설정") },
      { ok: !!(settings.bridge && settings.bridge.url), text: "Cloudflare Worker " + (settings.bridge && settings.bridge.url ? "연결됨" : "미설정") },
      { ok: Object.keys(settings.keys || {}).some(function (k) { return settings.keys[k] && settings.keys[k].key; }), text: "AI API 키 (BYOK)" }
    ];
    $("#checklist").innerHTML = items.map(function (it) {
      return '<li class="' + (it.ok ? "ok" : "") + '"><span class="mark">' + (it.ok ? "✓" : "–") + "</span>" + esc(it.text) + "</li>";
    }).join("");

  }

  function fillSettingsForms() {
    $("#fbConfig").value = settings.firebase ? JSON.stringify(settings.firebase, null, 2) : "";
    $("#bridgeUrl").value = settings.bridge.url || "";
    $("#bridgeToken").value = settings.bridge.token || "";
    $("#useLiveAI").checked = !!settings.useLiveAI;
    renderKeyList();
  }

  function openSettings(tab) {
    fillSettingsForms();
    renderSettingsStatus();
    if (!$("#settingsDialog").open) $("#settingsDialog").showModal();
    setTab(tab || "status");
  }
  function setTab(name) {
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    $$(".panel").forEach(function (p) { p.classList.toggle("active", p.dataset.panel === name); });
    if (name === "status") renderSettingsStatus();
  }

  function setResult(el, text, kind) {
    el.hidden = false;
    el.className = "result" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  /* ── 이벤트 연결 ──────────────────────────────────── */
  function bind() {
    // 방 · 안건
    $("#rooms").addEventListener("click", function (e) {
      var b = e.target.closest("[data-room]");
      if (b) selectRoom(b.dataset.room);
    });

    $("#topicList").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit]");
      if (edit) { e.stopPropagation(); openTopicDialog(edit.dataset.edit); return; }
      var item = e.target.closest("[data-topic]");
      if (item) selectTopic(item.dataset.topic);
    });
    $("#topicList").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var item = e.target.closest("[data-topic]");
      if (item) { e.preventDefault(); selectTopic(item.dataset.topic); }
    });

    $("#newTopicBtn").addEventListener("click", function () { openTopicDialog(null); });

    // 안건 모달
    $("#topicForm").addEventListener("submit", function (e) {
      e.preventDefault();
      if (e.submitter && e.submitter.value === "cancel") { $("#topicDialog").close(); return; }
      if (saveTopic()) $("#topicDialog").close();
    });
    var delBtn = $("#topicDeleteBtn");
    if (delBtn) delBtn.addEventListener("click", function () { deleteTopic(ui.editingTopicId); });

    // 채팅 헤더
    $("#chatHead").addEventListener("click", function (e) {
      if (e.target.closest("#statusChip")) cycleStatus();
      if (e.target.closest("#editTopicBtn")) openTopicDialog(state.activeTopicId);
    });

    // 메시지 액션 · 빠른 문구
    $("#messages").addEventListener("click", function (e) {
      var nt = e.target.closest('[data-act="new-topic"]');
      if (nt) { openTopicDialog(null); return; }
      var quick = e.target.closest("[data-quick]");
      if (quick) { insertAtCursor(quick.dataset.quick); return; }
      var copy = e.target.closest('[data-act="copy"]');
      if (copy) {
        var m = byId(state.messages, copy.dataset.id);
        if (m) {
          navigator.clipboard && navigator.clipboard.writeText(m.text).then(
            function () { toast("복사했습니다"); },
            function () { toast("복사할 수 없습니다", "err"); }
          );
        }
        return;
      }
      var del = e.target.closest('[data-act="del-msg"]');
      if (del) {
        var msg = byId(state.messages, del.dataset.id);
        if (!msg) return;
        if (!confirm("이 메시지를 지울까요?")) return;
        state.messages = state.messages.filter(function (x) { return x.id !== msg.id; });
        settings.pushed.messages = settings.pushed.messages.filter(function (x) { return x !== msg.id; });
        saveSettings(); saveState();
        Cloud.remove(COLL_MESSAGES, msg.id);
        renderMessages(); renderTopics();
      }
    });

    // 칩
    $("#chips").addEventListener("click", function (e) {
      var c = e.target.closest("[data-quick]");
      if (c) insertAtCursor(c.dataset.quick);
    });

    // 작성자 전환
    $("#senderBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = $("#senderMenu");
      var open = menu.hidden;
      renderSenderMenu();
      menu.hidden = !open;
      $("#senderBtn").setAttribute("aria-expanded", String(open));
    });
    $("#senderMenu").addEventListener("click", function (e) {
      var b = e.target.closest("[data-sender]");
      if (!b) return;
      ui.senderId = b.dataset.sender;
      $("#senderMenu").hidden = true;
      $("#senderBtn").setAttribute("aria-expanded", "false");
      renderSender();
      $("#input").focus();
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".sender-pick")) {
        $("#senderMenu").hidden = true;
        $("#senderBtn").setAttribute("aria-expanded", "false");
      }
    });

    // 입력
    var input = $("#input");
    input.addEventListener("keydown", function (e) {
      if (!document.getElementById("mentionPop").hidden) {
        if (e.key === "ArrowDown") { e.preventDefault(); ui.mentionIndex = (ui.mentionIndex + 1) % ui.mentionMatches.length; showMention(currentMentionQuery() ? currentMentionQuery().q : ""); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); ui.mentionIndex = (ui.mentionIndex - 1 + ui.mentionMatches.length) % ui.mentionMatches.length; showMention(currentMentionQuery() ? currentMentionQuery().q : ""); return; }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          var pick = ui.mentionMatches[ui.mentionIndex];
          if (pick) applyMention(pick.name);
          return;
        }
        if (e.key === "Escape") { hideMention(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener("input", function () {
      autoGrow();
      var q = currentMentionQuery();
      if (q) showMention(q.q); else hideMention();
    });
    input.addEventListener("blur", function () {
      setTimeout(hideMention, 120);
    });

    $("#mentionPop").addEventListener("mousedown", function (e) {
      e.preventDefault();
      var b = e.target.closest("[data-mention]");
      if (b) applyMention(b.dataset.mention);
    });

    $("#composer").addEventListener("submit", function (e) {
      e.preventDefault();
      sendMessage();
    });

    // 모바일 서랍
    $("#drawerBtn").addEventListener("click", toggleDrawer);
    $("#scrim").addEventListener("click", closeDrawer);

    // 상단 버튼
    $("#settingsBtn").addEventListener("click", function () { openSettings("status"); });
    $("#openSettingsLink").addEventListener("click", function () { openSettings("status"); });
    $("#modeBadge").addEventListener("click", function () { openSettings(ui.cloudStatus === "cloud" ? "status" : "firebase"); });
    $("#themeBtn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(LS_THEME, next); } catch (e) { /* ignore */ }
    });

    // 설정 탭
    $$(".tab").forEach(function (t) {
      t.addEventListener("click", function () { setTab(t.dataset.tab); });
    });
    $("#settingsClose").addEventListener("click", function () { $("#settingsDialog").close(); });

    // AI 키 저장
    $("#aiSaveBtn").addEventListener("click", function () {
      var keys = {};
      $$("#keyList .key-row").forEach(function (row) {
        var id = row.dataset.provider;
        var key = row.querySelector("[data-key]").value.trim();
        var model = row.querySelector("[data-model]").value.trim();
        if (key) keys[id] = { key: key, model: model };
      });
      settings.keys = keys;
      settings.useLiveAI = $("#useLiveAI").checked;
      saveSettings();
      fillSettingsForms();
      renderSender();
      renderSettingsStatus();
      toast(settings.useLiveAI && keys && Object.keys(keys).length ? "AI 키를 저장했습니다" : "저장했습니다");
    });
    $("#aiResetBtn").addEventListener("click", function () {
      if (!confirm("저장한 AI 키를 모두 지울까요?")) return;
      settings.keys = {};
      saveSettings();
      fillSettingsForms();
      renderSettingsStatus();
      toast("키를 지웠습니다");
    });
    $("#useLiveAI").addEventListener("change", function () {
      settings.useLiveAI = this.checked;
      saveSettings();
      renderSender();
      renderSettingsStatus();
    });

    // Firebase
    $("#fbSaveBtn").addEventListener("click", function () {
      var raw = $("#fbConfig").value.trim();
      var res = $("#fbResult");
      if (!raw) { setResult(res, "firebaseConfig를 붙여넣어 주세요.", "err"); return; }
      var cfg = null;
      try { cfg = JSON.parse(raw); } catch (e) {
        setResult(res, "JSON 형식이 아닙니다. Firebase 콘솔의 firebaseConfig를 그대로 붙여넣어 주세요.\n(" + e.message + ")", "err");
        return;
      }
      if (!cfg || !cfg.projectId || !cfg.apiKey) {
        setResult(res, "projectId와 apiKey가 필요합니다.", "err");
        return;
      }
      setResult(res, "연결 확인 중…");
      Cloud.test(cfg).then(function () {
        settings.firebase = cfg;
        saveSettings();
        ui.cloudStatus = "cloud";
        ui.cloudNote = "Firestore 연결됨 · 5초마다 동기화";
        renderMode();
        startPolling();
        Cloud.pull();
        setResult(res, "연결되었습니다 · 프로젝트 " + cfg.projectId + "\n다른 기기에서도 같은 설정을 넣으면 대화가 이어집니다.", "ok");
        renderSettingsStatus();
      }).catch(function (e) {
        settings.firebase = cfg;
        saveSettings();
        ui.cloudStatus = "error";
        ui.cloudNote = "연결 실패: " + (e.message || e);
        renderMode();
        setResult(res, "연결하지 못했습니다: " + (e.message || e) +
          "\n확인할 것: ① Firestore 데이터베이스가 만들어졌는지 ② 규칙이 읽기/쓰기를 허용하는지 ③ 웹 API 키 제한", "err");
      });
    });
    $("#fbTestBtn").addEventListener("click", function () {
      var res = $("#fbResult");
      var raw = $("#fbConfig").value.trim();
      var cfg = null;
      try { cfg = raw ? JSON.parse(raw) : settings.firebase; } catch (e) { cfg = null; }
      if (!cfg || !cfg.projectId) { setResult(res, "먼저 firebaseConfig를 넣어 주세요.", "err"); return; }
      setResult(res, "확인 중…");
      Cloud.test(cfg).then(function (n) {
        setResult(res, "연결됨 · 프로젝트 " + cfg.projectId + " (문서 " + n + "개 확인)", "ok");
      }).catch(function (e) {
        setResult(res, "실패: " + (e.message || e), "err");
      });
    });
    $("#fbDisconnectBtn").addEventListener("click", function () {
      settings.firebase = null;
      saveSettings();
      Cloud.disconnect();
      $("#fbConfig").value = "";
      setResult($("#fbResult"), "연결을 해제했습니다. 이후 내용은 이 기기에만 저장됩니다.", "ok");
      fillSettingsForms();
      renderSettingsStatus();
      toast("Firestore 연결을 해제했습니다");
    });
    var pushAllBtn = $("#fbPushAllBtn");
    if (pushAllBtn) pushAllBtn.addEventListener("click", function () { Cloud.pushAll(); });

    // 브릿지
    $("#bridgeSaveBtn").addEventListener("click", function () {
      var url = $("#bridgeUrl").value.trim();
      if (url && !/^https?:\/\//i.test(url)) { setResult($("#bridgeResult"), "https:// 로 시작하는 주소를 넣어 주세요.", "err"); return; }
      settings.bridge = { url: url, token: $("#bridgeToken").value.trim() };
      saveSettings();
      renderSettingsStatus();
      renderSender();
      setResult($("#bridgeResult"), url ? "저장했습니다. ‘AI 답변’ 탭에서 ‘실제 AI 답변 사용’을 켜면 Worker로 답합니다." : "브릿지 주소를 비웠습니다.", "ok");
    });
    $("#bridgeClearBtn").addEventListener("click", function () {
      settings.bridge = { url: "", token: "" };
      saveSettings();
      $("#bridgeUrl").value = "";
      $("#bridgeToken").value = "";
      renderSettingsStatus();
      $("#bridgeResult").hidden = true;
    });
    $("#bridgeTestBtn").addEventListener("click", function () {
      var url = $("#bridgeUrl").value.trim();
      var res = $("#bridgeResult");
      if (!url) { setResult(res, "Worker 주소를 먼저 넣어 주세요.", "err"); return; }
      setResult(res, "확인 중…");
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ping: true, token: $("#bridgeToken").value.trim() })
      }).then(readJsonOrThrow).then(function (data) {
        setResult(res, "연결됨 · " + JSON.stringify(data).slice(0, 160), "ok");
      }).catch(function (e) {
        setResult(res, "실패: " + (e.message || e) + "\nCORS 허용과 경로를 확인해 주세요.", "err");
      });
    });

    // 데이터
    $("#exportBtn").addEventListener("click", function () {
      var payload = {
        app: "doyuni-ai-office", version: 1, exportedAt: new Date().toISOString(),
        rooms: state.rooms, members: state.members, topics: state.topics, messages: state.messages
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "doyuni-ai-office-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast("백업 파일을 내려받았습니다");
    });
    $("#importBtn").addEventListener("click", function () { $("#importFile").click(); });
    $("#importFile").addEventListener("change", function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          if (!data || !Array.isArray(data.topics) || !Array.isArray(data.messages)) throw new Error("형식이 다릅니다");
          if (!confirm("지금 내용을 가져온 파일로 바꿉니다. 계속할까요?")) return;
          state.topics = data.topics;
          state.messages = data.messages;
          if (Array.isArray(data.rooms) && data.rooms.length) state.rooms = data.rooms;
          if (Array.isArray(data.members) && data.members.length) state.members = data.members;
          normalize();
          saveState();
          renderAll();
          $("#settingsDialog").close();
          toast("가져왔습니다 · 안건 " + state.topics.length + "개");
        } catch (e) {
          toast("가져오지 못했습니다: " + e.message, "err");
        }
      };
      reader.readAsText(file);
      this.value = "";
    });
    $("#resetDataBtn").addEventListener("click", function () {
      if (!confirm("이 브라우저의 안건과 대화를 모두 지웁니다. 계속할까요?")) return;
      state.topics = []; state.messages = []; state.activeTopicId = null;
      settings.pushed = { topics: [], messages: [] };
      saveState(); saveSettings();
      renderAll(); $("#settingsDialog").close();
      toast("안건과 대화를 지웠습니다");
    });
    $("#resetAllBtn").addEventListener("click", function () {
      if (!confirm("설정과 데이터를 모두 지우고 처음 상태로 돌립니다. 계속할까요?")) return;
      try {
        localStorage.removeItem(LS_STATE);
        localStorage.removeItem(LS_SET);
      } catch (e) { /* ignore */ }
      settings = { firebase: null, useLiveAI: false, keys: {}, bridge: { url: "", token: "" }, pushed: { topics: [], messages: [] } };
      Cloud.disconnect();
      seedState();
      saveState();
      renderAll(); renderSettingsStatus(); $("#settingsDialog").close();
      toast("처음 상태로 되돌렸습니다");
    });

    // ESC 로 서랍 닫기
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); $("#senderMenu").hidden = true; }
    });

    // 화면 크기 바뀌면 서랍 정리
    window.addEventListener("resize", function () {
      if (window.innerWidth > 820) closeDrawer();
      updatePlaceholder();
    });
  }

  function updatePlaceholder() {
    var el = $("#input");
    if (!el) return;
    el.placeholder = window.innerWidth > 560
      ? "안건에 대해 이야기하거나 @피클 처럼 불러 보세요"
      : "메시지 입력, @로 AI 부르기";
  }

  function toggleDrawer() {
    var sb = $("#sidebar");
    var open = !sb.classList.contains("open");
    sb.classList.toggle("open", open);
    $("#scrim").hidden = !open;
    $("#drawerBtn").setAttribute("aria-expanded", String(open));
  }
  function closeDrawer() {
    $("#sidebar").classList.remove("open");
    $("#scrim").hidden = true;
    var db = $("#drawerBtn");
    if (db) db.setAttribute("aria-expanded", "false");
  }

  /* ── 초기화 ───────────────────────────────────────── */
  function renderAll() {
    renderRooms();
    renderTopics();
    renderChat();
    renderChips();
    renderSender();
    renderMode();
    scrollBottom(true);
  }

  function init() {
    var savedTheme = null;
    try { savedTheme = localStorage.getItem(LS_THEME); } catch (e) { savedTheme = null; }
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(savedTheme || (prefersDark ? "dark" : "light"));

    loadSettings();
    loadState();

    var owner = DATA.owner || {};
    $("#myName").textContent = owner.name || "도유니";
    $("#myHandle").textContent = owner.handle || "";
    $("#myAvatar").textContent = owner.avatar || "도";

    // 안건 모달의 방 선택지
    $("#topicRoom").innerHTML = state.rooms.map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(r.icon + " " + r.name) + "</option>";
    }).join("");

    bind();
    updatePlaceholder();
    renderAll();
    renderSenderMenu();

    if (settings.firebase && settings.firebase.projectId) Cloud.connect();

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("./sw.js").catch(function () { /* 오프라인 캐시는 선택 사항 */ });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
