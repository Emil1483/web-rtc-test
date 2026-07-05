// WebRTC hub — the server side of the SFU.
//
// The server (werift) is the OFFERER for every peer. werift interops with
// aiortc/browsers reliably as the offerer; as the answerer it fails DTLS/BUNDLE
// when a media m-line and a data channel are bundled together. So both the
// robot and each viewer connect, receive our offer, and answer.
//
// Data flow:
//   robot  --video track----> server --forward RTP--> each viewer
//   robot  --telemetry DC---> server --rebroadcast--> each viewer DC
// One received robot track is fanned out to every viewer's sender via
// replaceTrack (the werift SFU pattern) — no transcoding.

import { RTCPeerConnection } from "werift";
import type {
  MediaStreamTrack,
  RTCDataChannel,
  RTCRtpReceiver,
  RTCRtpSender,
} from "werift";
import type { WebSocket } from "ws";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const PLI_INTERVAL_MS = 2000;

// Behind Docker/NAT, werift only sees container-internal interfaces. Publish a
// fixed UDP port range (must be mapped in compose + opened in the firewall) and
// advertise the host's public IP so remote peers get a reachable candidate.
// PUBLIC_IP: the server's public address (e.g. the Linode IP).
// ICE_PORT_MIN/ICE_PORT_MAX: the published UDP range.
const PUBLIC_IP = process.env.PUBLIC_IP;
const ICE_PORT_MIN = Number(process.env.ICE_PORT_MIN ?? 50000);
const ICE_PORT_MAX = Number(process.env.ICE_PORT_MAX ?? 50019);

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceUseIpv4: true,
    icePortRange: [ICE_PORT_MIN, ICE_PORT_MAX],
    iceAdditionalHostAddresses: PUBLIC_IP ? [PUBLIC_IP] : undefined,
  });
}

type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string };

function parseSignal(raw: unknown): SignalMessage | null {
  try {
    return JSON.parse(String(raw));
  } catch {
    console.warn("[hub] ignoring non-JSON signaling message");
    return null;
  }
}

// werift embeds gathered ICE candidates in the SDP (non-trickle), so sending
// localDescription after setLocalDescription is a complete offer.
async function sendOffer(pc: RTCPeerConnection, socket: WebSocket) {
  await pc.setLocalDescription(await pc.createOffer());
  const local = pc.localDescription;
  if (!local) {
    console.error("[hub] no local description after createOffer");
    return;
  }
  socket.send(JSON.stringify({ type: "offer", sdp: local.sdp }));
}

interface ViewerSession {
  channel: RTCDataChannel | null;
  videoSender: RTCRtpSender;
}

// Realtime telemetry (100 Hz): drop old data rather than queue it. Unreliable +
// unordered so a slow/lossy viewer never builds a growing SCTP send buffer.
const TELEMETRY_DC_OPTS = { ordered: false, maxRetransmits: 0 };

class Hub {
  private robotVideoTrack: MediaStreamTrack | null = null;
  private robotReceiver: RTCRtpReceiver | null = null;
  private robotChannel: RTCDataChannel | null = null;
  private robotOnline = false;
  private pliTimer: ReturnType<typeof setInterval> | null = null;
  private viewers = new Set<ViewerSession>();

  // For the /api/status endpoint.
  get status() {
    return { robot: this.robotOnline, viewers: this.viewers.size };
  }

  private broadcastToViewers(text: string) {
    for (const viewer of this.viewers) {
      try {
        viewer.channel?.send(text);
      } catch (err) {
        console.warn("[hub] failed to send to viewer:", err);
      }
    }
  }

  private setRobotOnline(online: boolean) {
    if (this.robotOnline === online) return;
    this.robotOnline = online;
    this.broadcastToViewers(
      JSON.stringify({ status: online ? "online" : "offline" }),
    );
  }

  private requestKeyframe() {
    if (this.robotReceiver && this.robotVideoTrack?.ssrc) {
      this.robotReceiver.sendRtcpPLI(this.robotVideoTrack.ssrc);
    }
  }

  // Point a viewer's sender at the robot track. One track, many senders.
  private attachVideo(viewer: ViewerSession) {
    if (this.robotVideoTrack) {
      void viewer.videoSender.replaceTrack(this.robotVideoTrack);
      this.requestKeyframe(); // new consumer needs a fresh keyframe
    }
  }

  // Robot: server offers recvonly video + a data channel; robot answers,
  // sending its video and its telemetry.
  handleRobot(socket: WebSocket) {
    console.log("[hub] robot connected");
    const pc = createPeerConnection();
    pc.iceConnectionStateChange.subscribe((state) =>
      console.log("[hub] robot ICE state:", state),
    );

    const videoTransceiver = pc.addTransceiver("video", {
      direction: "recvonly",
    });
    this.robotReceiver = videoTransceiver.receiver;
    videoTransceiver.onTrack.subscribe((track) => {
      console.log("[hub] robot video track received");
      this.robotVideoTrack = track;
      for (const viewer of this.viewers) this.attachVideo(viewer);
      if (!this.pliTimer) {
        this.pliTimer = setInterval(() => this.requestKeyframe(), PLI_INTERVAL_MS);
      }
    });

    const channel = pc.createDataChannel("telemetry", TELEMETRY_DC_OPTS);
    this.robotChannel = channel;
    channel.stateChanged.subscribe((state) => {
      if (state === "open") this.setRobotOnline(true);
    });
    channel.onMessage.subscribe((data) =>
      this.broadcastToViewers(data.toString()),
    );

    void sendOffer(pc, socket);

    socket.on("message", (raw) => {
      const message = parseSignal(raw);
      if (message?.type === "answer") {
        void pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      }
    });

    socket.on("close", () => {
      console.log("[hub] robot disconnected");
      this.robotChannel = null;
      this.robotVideoTrack = null;
      this.robotReceiver = null;
      if (this.pliTimer) {
        clearInterval(this.pliTimer);
        this.pliTimer = null;
      }
      // Stop feeding viewers a frozen last frame and mark the robot offline.
      for (const viewer of this.viewers) {
        void viewer.videoSender.replaceTrack(null).catch(() => {});
      }
      this.setRobotOnline(false);
      pc.close();
    });
  }

  // Viewer: server offers sendonly video + a data channel; browser answers.
  handleViewer(socket: WebSocket) {
    console.log(`[hub] viewer connected (total: ${this.viewers.size + 1})`);
    const pc = createPeerConnection();
    pc.iceConnectionStateChange.subscribe((state) =>
      console.log("[hub] viewer ICE state:", state),
    );

    const videoTransceiver = pc.addTransceiver("video", {
      direction: "sendonly",
    });
    const session: ViewerSession = {
      channel: null,
      videoSender: videoTransceiver.sender,
    };
    this.viewers.add(session);

    const channel = pc.createDataChannel("telemetry", TELEMETRY_DC_OPTS);
    session.channel = channel;
    channel.stateChanged.subscribe((state) => {
      // Tell a freshly-connected viewer the current robot status.
      if (state === "open") {
        channel.send(
          JSON.stringify({ status: this.robotOnline ? "online" : "offline" }),
        );
      }
    });
    channel.onMessage.subscribe((data) => {
      // Viewer -> robot (command path). Robot may be absent; ignore then.
      this.robotChannel?.send(data.toString());
    });

    this.attachVideo(session); // no-op until the robot track exists

    void sendOffer(pc, socket);

    socket.on("message", (raw) => {
      const message = parseSignal(raw);
      if (message?.type === "answer") {
        void pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      }
    });

    socket.on("close", () => {
      this.viewers.delete(session);
      console.log(`[hub] viewer disconnected (remaining: ${this.viewers.size})`);
      pc.close();
    });
  }
}

// Single shared hub across the process (module singleton).
export const hub = new Hub();
