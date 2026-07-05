// Health/status of the mediasoup SFU: router ready, peer/producer counts.

import { getSfuStatus } from "@/lib/mediasoup/sfu";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getSfuStatus());
}
