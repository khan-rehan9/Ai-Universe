const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

const MAX_BODY_BYTES = 60000;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 4000;
const GEMINI_MODEL = "gemini-3.8-flash";

let cachedFirebaseKeys = null;
let firebaseKeysExpiry = 0;

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

function decodeBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  const binary = atob(base64);
  const bytes = Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );

  return new TextDecoder().decode(bytes);
}

async function getFirebaseKeys() {
  if (cachedFirebaseKeys && Date.now() < firebaseKeysExpiry) {
    return cachedFirebaseKeys;
  }

  const response = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );

  if (!response.ok) {
    throw new Error("Firebase signing keys unavailable.");
  }

  const data = await response.json();

  if (!Array.isArray(data.keys) || !data.keys.length) {
    throw new Error("Firebase signing keys are invalid.");
  }

  cachedFirebaseKeys = data.keys;

  const cacheControl = response.headers.get("Cache-Control") || "";
  const match = cacheControl.match(/max-age=(\d+)/i);
  const maxAge = match ? Number(match[1]) : 300;

  firebaseKeysExpiry =
    Date.now() + Math.max(60, Math.min(maxAge, 21600)) * 1000;

  return cachedFirebaseKeys;
}

async function verifyFirebaseToken(token, projectId) {
  if (!token || !projectId) return false;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = JSON.parse(decodeBase64Url(parts[0]));
    const claims = JSON.parse(decodeBase64Url(parts[1]));

    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.aud !== projectId ||
      claims.iss !==
        `https://securetoken.google.com/${projectId}` ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      claims.sub.length > 128
    ) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(claims.exp) ||
      !Number.isFinite(claims.iat) ||
      claims.exp <= now ||
      claims.iat > now + 60
    ) {
      return false;
    }

    const keys = await getFirebaseKeys();
    const signingKey = keys.find(key => key.kid === header.kid);

    if (
      !signingKey ||
      signingKey.kty !== "RSA" ||
      (signingKey.alg && signingKey.alg !== "RS256")
    ) {
      return false;
    }

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      signingKey,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["verify"]
    );

    const signature = Uint8Array.from(
      atob(
        parts[2]
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(parts[2].length / 4) * 4, "=")
      ),
      character => character.charCodeAt(0)
    );

    const signedData = new TextEncoder().encode(
      `${parts[0]}.${parts[1]}`
    );

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedData
    );
  } catch {
    return false;
  }
}

function normalizeMessages(messages) {
  const result = [];

  for (const message of messages.slice(-MAX_MESSAGES)) {
    if (
      !message ||
      !["user", "assistant", "model"].includes(message.role) ||
      typeof message.text !== "string"
    ) {
      continue;
    }

    const text = message.text.trim().slice(0, MAX_MESSAGE_LENGTH);
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

  const apiKey = (env.GEMINI_API_KEY || "").trim();
  const projectId = (env.FIREBASE_PROJECT_ID || "").trim();

  if (!apiKey) {
    return json({
      error: "Gemini API secret is not configured."
    }, 503);
  }

  if (!projectId) {
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

  const authenticated = await verifyFirebaseToken(token, projectId);

  if (!authenticated) {
    return json({
      error: "Your sign-in session is invalid or expired. Please sign in again."
    }, 401);
  }

  let body;

  try {
    const declaredLength = request.headers.get("Content-Length");

    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_BODY_BYTES)
    ) {
      return json({ error: "Request is too large." }, 413);
    }

    const buffer = await request.arrayBuffer();

    if (buffer.byteLength > MAX_BODY_BYTES) {
      return json({ error: "Request is too large." }, 413);
    }

    body = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return json({ error: "Please send a valid message." }, 400);
  }

  const contents = normalizeMessages(body.messages);

  if (!contents.length || contents[0].role !== "user") {
    return json({
      error: "A valid user message is required first."
    }, 400);
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = JSON.stringify({
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
  });

  // Automatic retry mechanism for transient 503 / network glitches
  let lastResponse = null;
  let lastData = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      lastResponse = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      });

      lastData = await lastResponse.json().catch(() => ({}));

      if (lastResponse.ok) {
        const candidate = lastData.candidates?.[0];
        const reply = (candidate?.content?.parts || [])
          .map(part => typeof part.text === "string" ? part.text : "")
          .join("")
          .trim();

        if (reply) {
          return json({ reply });
        }
      }

      // If server error 503 or 429, wait briefly and retry
      if ([503, 500, 429].includes(lastResponse.status) && attempt < 3) {
        await new Promise(r => setTimeout(r, 1200 * attempt));
        continue;
      }

      break;
    } catch (err) {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }
  }

  if (!lastResponse || !lastResponse.ok) {
    const status = lastResponse?.status || 502;
    const backendMessage = lastData?.error?.message;

    if (status === 429) {
      return json({
        error: "Gemini quota or rate limit reached. Please try again in a moment."
      }, 429);
    }

    if (backendMessage) {
      return json({
        error: `Gemini Error (${status}): ${backendMessage}`
      }, 502);
    }

    return json({
      error: "Gemini is temporarily busy. Please send your message again."
    }, 502);
  }

  return json({
    error: "Gemini returned no text. Please try asking again."
  }, 502);
      }
          
