/* ─────────────────────────────────────────────────────────
   도유니 AI 오피스 — Cloudflare Worker 브릿지
   ---------------------------------------------------------
   앱에서 보낸 요청을 각 AI 제공자에게 대신 보내고 답변만 돌려줍니다.
   API 키는 Worker 환경변수에만 있고, 브라우저에는 노출되지 않습니다.

   배포·설정 방법: CLOUDFLARE_SETUP.md
   ───────────────────────────────────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET") {
      return json({ ok: true, service: "doyuni-ai-office-bridge", providers: Object.keys(PROVIDERS) });
    }
    if (request.method !== "POST") return json({ error: "POST만 지원합니다" }, 405);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "JSON 본문이 필요합니다" }, 400);
    }

    // 토큰 확인 (Worker에 OFFICE_TOKEN을 넣었다면 반드시 일치해야 함)
    if (env.OFFICE_TOKEN && body.token !== env.OFFICE_TOKEN) {
      return json({ error: "토큰이 맞지 않습니다" }, 401);
    }

    if (body.ping) {
      return json({
        ok: true,
        providers: Object.keys(PROVIDERS).filter((p) => keyFor(p, env)),
        tokenRequired: !!env.OFFICE_TOKEN
      });
    }

    const provider = String(body.provider || "openai").toLowerCase();
    const apiKey = keyFor(provider, env);
    if (!apiKey) return json({ error: provider + " 키가 Worker에 설정되지 않았습니다" }, 400);

    const prompt = String(body.prompt || "");
    const context = String(body.context || "");
    const system = String(body.system || "한국어로 짧고 실용적으로 답합니다.");
    const userText = context ? context + "\n\n요청: " + prompt : prompt;
    const model = body.model || PROVIDERS[provider].defaultModel;

    try {
      const text = await callProvider(provider, apiKey, model, system, userText, body);
      return json({ text: text, provider: provider, model: model });
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 502);
    }
  }
};

const PROVIDERS = {
  openai: { defaultModel: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  anthropic: { defaultModel: "claude-3-5-haiku-latest", envKey: "ANTHROPIC_API_KEY" },
  gemini: { defaultModel: "gemini-2.0-flash", envKey: "GEMINI_API_KEY" },
  openrouter: { defaultModel: "openai/gpt-4o-mini", envKey: "OPENROUTER_API_KEY" },
  pickle: { defaultModel: "gpt-4o-mini", envKey: "OPENAI_API_KEY" }
};

function keyFor(provider, env) {
  const meta = PROVIDERS[provider];
  if (!meta) return null;
  return env[meta.envKey] || null;
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && data.error && (data.error.message || data.error)) || text.slice(0, 200);
    throw new Error("HTTP " + res.status + " · " + (typeof detail === "string" ? detail : JSON.stringify(detail)));
  }
  if (!data) throw new Error("응답을 읽지 못했습니다");
  return data;
}

async function callProvider(provider, apiKey, model, system, userText, body) {
  if (provider === "openai" || provider === "pickle" || provider === "openrouter") {
    const url =
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
    const headers = { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = body.referer || "https://github.com/skacshe-stack/ai-office";
      headers["X-Title"] = "Doyuni AI Office";
    }
    const res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: model,
        temperature: 0.6,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userText }
        ]
      })
    });
    const data = await readJson(res);
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 900,
        system: system,
        messages: [{ role: "user", content: userText }]
      })
    });
    const data = await readJson(res);
    return (data.content || []).map((c) => c.text || "").join("\n");
  }

  if (provider === "gemini") {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
        ":generateContent?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userText }] }]
        })
      }
    );
    const data = await readJson(res);
    const c = data.candidates && data.candidates[0];
    return c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("") : "";
  }

  throw new Error("지원하지 않는 제공자: " + provider);
}
