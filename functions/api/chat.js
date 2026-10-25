const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function verifyFirebaseToken(token, projectId) {
  if (!token || !projectId) return false;

  try {
    const response = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ idToken: token })
      }
    );

    if (!response.ok) return false;

    const data = await response.json();
    const user = data.users?.[0];

    return Boolean(
      user &&
      user.localId &&
      user.emailVerified !== undefined
    );
  } catch {
    return false;
  }
}

function normalizeMessages(messages) {
  const result = [];

  for (const message of messages.slice(-12)) {
    if (
      !message ||
      !["user", "assistant", "model"].includes(message.role) ||
      typeof message.text !== "string"
    ) {
      continue;
    }

    const text = message.text.trim().slice(0, 4000);
    if (!text) continue;

    const role = message.role === "user" ? "user" : "model";
    const previous = result[result.length - 1];

    if (previous && previous.role === role) {
      previous.parts[0].text += "\n\n" + text;
    } else {
      result.push({
        role,
        parts: [{ text }]
      });
    }
  }

  return result;
}

export async function onRequestPost({ request, env }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (!env.GEMINI_API_KEY) {
    return json({
      error: "Gemini API secret is not configured."
    }, 503);
  }

  if (!env.FIREBASE_PROJECT_ID) {
    return json({
      error: "Firebase project ID is not configured."
    }, 503);
  }

  const token = getBearerToken(request);

  if (!token) {
    return json({
      error: "Please sign in to AI Universe first."
    }, 401);
  }

  const authenticated = await verifyFirebaseToken(
    token,
    env.FIREBASE_PROJECT_ID
  );

  if (!authenticated) {
    return json({
      error: "Your sign-in session is invalid or expired. Please sign in again."
    }, 401);
  }

  let body;

  try {
    const contentLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (contentLength > 60000) {
      return json({ error: "Request is too large." }, 413);
    }

    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: "Please send a message." }, 400);
  }

  const contents = normalizeMessages(body.messages);

  if (!contents.length || contents[0].role !== "user") {
    return json({
      error: "A valid user message is required first."
    }, 400);
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
              text:
                "You are AI Universe, a helpful and accurate AI assistant. " +
                "Respond clearly in the user's preferred language. " +
                "Never claim to have performed an action you did not perform."
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
          error:
            "Gemini free quota or rate limit reached. " +
            "No paid fallback was attempted. Please try again later."
        }, 429);
      }

      if (response.status === 401 || response.status === 403) {
        return json({
          error:
            "Gemini API access was rejected. Check the API key, " +
            "project settings and model access."
        }, 502);
      }

      return json({
        error:
          "Gemini is temporarily unavailable. " +
          "No paid fallback was attempted."
      }, 502);
    }

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map(part => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();

    if (!reply) {
      return json({
        error: "Gemini returned no text. Please try again."
      }, 502);
    }

    return json({ reply });
  } catch {
    return json({
      error:
        "Could not connect to Gemini. " +
        "No paid fallback was attempted."
    }, 502);
  }
}
