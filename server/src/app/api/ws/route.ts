// Sample next-ws WebSocket route. Define an `UPGRADE` export and next-ws
// (patched into Next.js via the `prepare` script) routes upgrade requests here.

export function UPGRADE(
  client: import("ws").WebSocket,
  server: import("ws").WebSocketServer,
  request: import("next/server").NextRequest,
) {
  console.log("[WS] Client connected");

  client.on("message", (message) => {
    // Echo back for now — real signalling logic goes here later.
    client.send(message.toString());
  });

  client.once("close", () => {
    console.log("[WS] Client disconnected");
  });
}

export function GET() {
  return new Response("WebSocket endpoint. Connect via WebSocket upgrade.", {
    status: 426,
    statusText: "Upgrade Required",
  });
}
