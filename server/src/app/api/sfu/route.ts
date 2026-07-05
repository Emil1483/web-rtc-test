// mediasoup signaling endpoint (next-ws). One WebSocket per peer (robot or
// browser). The Peer object handles the request/response protocol; the router
// is initialized lazily on the first connection.

import { initSfu, Peer } from "@/lib/mediasoup/sfu";

export async function UPGRADE(
  client: import("ws").WebSocket,
  server: import("ws").WebSocketServer,
  request: import("next/server").NextRequest,
) {
  await initSfu();

  const peer = new Peer(client);
  console.log("[sfu] peer connected");

  client.on("message", (raw) => {
    void peer.handle(raw);
  });

  client.on("close", () => {
    console.log("[sfu] peer disconnected");
    peer.close();
  });
}

export function GET() {
  return new Response("mediasoup signaling endpoint. Connect via WebSocket.", {
    status: 426,
    statusText: "Upgrade Required",
  });
}
