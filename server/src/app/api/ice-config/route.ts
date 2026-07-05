// ICE configuration for browser viewers (STUN + optional TURN). Served from the
// server so TURN credentials aren't baked into the client bundle. The browser
// fetches this before creating its RTCPeerConnection.

import { getIceServers } from "@/lib/webrtc/iceServers";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ iceServers: getIceServers() });
}
