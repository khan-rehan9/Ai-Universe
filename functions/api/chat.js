
export async function onRequestPost({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });

  if (!env.GEMINI_API_KEY) {
    return json({ error: "Server API secret is not configured." }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: "Please send a message." }, 400);
  }

  const messages = body.messages.slice(-12);
  const contents = [];

  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant", "model"].includes(message.role) ||
      typeof message.text !== "string" ||
      !message.text.trim()
    ) {
      continue;
    }

    const role = message.role === "user" ? "user" : "model";
    const text = message.text.trim().slice(0, 4000);
    const previous = contents[contents.length - 1];

    if (previous && previous.role === role) {
      previous.parts[0].text += "\n\n" + text;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  if (!contents.length || contents[0].role !== "user") {
    return json({ error: "A user message is required first." }, 400);
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are the AI Universe assistant. Answer clearly and accurately."
            }]
          },
          contents,
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.7
          }
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 429) {
        return json({
          error: "API quota or rate limit reached. No paid fallback was attempted."
        }, 429);
      }

      return json({
        error: "AI provider request failed. Check API configuration and quota."
      }, 502);
    }

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return json({ error: "The AI returned an empty response. Try again." }, 502);
    }

    return json({ reply });
  } catch {
    return json({ error: "Could not connect to the AI provider." }, 502);
  }
        }
        
