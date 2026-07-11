// mediasoup SFU singleton. Signaling, the Worker/Router/transport lifecycle,
// and reconnect-tolerant producer/dataProducer registries are all handled by
// Proto4WebrtcSfu (npm package "proto4webrtc"). This module only supplies
// the env-driven parts of the config that differ per deployment.
//
// Env:
//   MEDIASOUP_LISTEN_IP      bind address inside the container/host (default 0.0.0.0)
//   MEDIASOUP_ANNOUNCED_IP   public address peers connect to (falls back to PUBLIC_IP)
//   MEDIASOUP_RTC_MIN_PORT   RTC UDP/TCP port range start (default 40000)
//   MEDIASOUP_RTC_MAX_PORT   RTC UDP/TCP port range end   (default 40049)
//
// The RTC port range must be published in compose and opened in the firewall.
// Router media codecs (VP8) are left at Proto4WebrtcSfu's default.

import { Proto4WebrtcSfu } from "proto4webrtc";

const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP ?? "0.0.0.0";
const ANNOUNCED_ADDRESS =
  process.env.MEDIASOUP_ANNOUNCED_IP ?? process.env.PUBLIC_IP ?? undefined;
const RTC_MIN_PORT = Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000);
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40049);

export const sfu = new Proto4WebrtcSfu({
  // Both UDP and TCP: TCP is the fallback for clients on UDP-hostile
  // networks, avoiding a TURN relay requirement.
  webRtcTransport: {
    listenInfos: [
      {
        protocol: "udp",
        ip: LISTEN_IP,
        announcedAddress: ANNOUNCED_ADDRESS,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
      {
        protocol: "tcp",
        ip: LISTEN_IP,
        announcedAddress: ANNOUNCED_ADDRESS,
        portRange: { min: RTC_MIN_PORT, max: RTC_MAX_PORT },
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  },
});
