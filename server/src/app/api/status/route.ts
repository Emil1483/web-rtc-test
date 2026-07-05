// Health/status of the WebRTC hub: is a robot connected, how many viewers.

import { hub } from "@/lib/webrtc/hub";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(hub.status);
}
