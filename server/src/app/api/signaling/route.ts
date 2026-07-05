// WebRTC signaling endpoint (next-ws). Robot and browser viewers connect here
// to exchange SDP. Role is selected via ?role=robot|viewer.

import { hub } from "@/lib/webrtc/hub";

export function UPGRADE(
  client: import("ws").WebSocket,
  server: import("ws").WebSocketServer,
  request: import("next/server").NextRequest,
) {
  const role = request.nextUrl.searchParams.get("role");

  switch (role) {
    case "robot":
      hub.handleRobot(client);
      return;
    case "viewer":
      hub.handleViewer(client);
      return;
    default:
      console.warn(`[signaling] rejecting unknown role: ${role}`);
      client.close(1008, "unknown role");
  }
}

export function GET() {
  return new Response("WebRTC signaling endpoint. Connect via WebSocket.", {
    status: 426,
    statusText: "Upgrade Required",
  });
}
