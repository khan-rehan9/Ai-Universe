
export async function onRequest() {
  return new Response(
    JSON.stringify({
      message: "AI Universe API is working!"
    }),
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
