// mediasoup configuration, env-driven so ports/addresses aren't hardcoded.
//
// Env:
//   MEDIASOUP_LISTEN_IP      bind address inside the container/host (default 0.0.0.0)
//   MEDIASOUP_ANNOUNCED_IP   public address peers connect to (falls back to PUBLIC_IP)
//   MEDIASOUP_RTC_MIN_PORT   RTC UDP/TCP port range start (default 40000)
//   MEDIASOUP_RTC_MAX_PORT   RTC UDP/TCP port range end   (default 40049)
//
// The RTC port range must be published in compose and opened in the firewall.

import type { types } from "mediasoup";

const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP ?? "0.0.0.0";
const ANNOUNCED_IP =
  process.env.MEDIASOUP_ANNOUNCED_IP ?? process.env.PUBLIC_IP ?? undefined;
const RTC_MIN_PORT = Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000);
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40049);

export const config = {
  worker: {
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
    logLevel: "warn" as types.WorkerLogLevel,
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as types.WorkerLogTag[],
  },

  router: {
    // Keep VP8 to match the robot (aiortc) and browsers. Add audio/H264 later.
    mediaCodecs: [
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {},
      },
    ] as types.RtpCodecCapability[],
  },

  // WebRTC transport: server is the public ICE endpoint. Both UDP and TCP are
  // enabled — the TCP fallback lets clients on UDP-hostile networks connect
  // without a TURN relay (mediasoup ICE-TCP on the announced port).
  webRtcTransport: {
    listenInfos: [
      {
        protocol: "udp",
        ip: LISTEN_IP,
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
      {
        protocol: "tcp",
        ip: LISTEN_IP,
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
    ] as types.TransportListenInfo[],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
    numSctpStreams: { OS: 1024, MIS: 1024 },
    initialAvailableOutgoingBitrate: 1_000_000,
  },
};
