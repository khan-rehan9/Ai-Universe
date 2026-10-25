
import { onRequestPost } from "./functions/api/chat.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed." }),
          {
            status: 405,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "Allow": "POST"
            }
          }
        );
      }

      return onRequestPost({ request, env });
    }

    return env.ASSETS.fetch(request);
  }
};
