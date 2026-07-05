// WebRTC hub — the server side of the SFU.
//
// Phase 1: accept a single robot peer over the signaling WebSocket, complete
// the offer/answer handshake with werift, and echo whatever arrives on the
// robot's data channel. Viewer fan-out (multiple browsers) lands in Phase 2.

import { RTCPeerConnection } from "werift";
import type { WebSocket } from "ws";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// Signaling messages exchanged over the WebSocket. werift/aiortc both embed
// their gathered ICE candidates directly in the SDP (non-trickle), so a single
// offer/answer round-trip is all we need — no separate candidate messages yet.
type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string };

function send(socket: WebSocket, message: SignalMessage) {
  socket.send(JSON.stringify(message));
}

// Handle one robot connection. The robot is the offerer (it owns the media),
// so we wait for its offer, answer it, and wire up the data channel.
export function handleRobot(socket: WebSocket) {
  console.log("[hub] robot connected");
  let pc: RTCPeerConnection | null = null;

  socket.on("message", async (raw) => {
    let message: SignalMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.warn("[hub] ignoring non-JSON signaling message");
      return;
    }

    if (message.type !== "offer") return;

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.iceConnectionStateChange.subscribe((state) =>
      console.log("[hub] robot ICE state:", state),
    );

    pc.onDataChannel.subscribe((channel) => {
      console.log(`[hub] robot data channel open: ${channel.label}`);
      channel.onMessage.subscribe((data) => {
        const text = data.toString();
        console.log("[hub] from robot:", text);
        channel.send(`echo:${text}`); // Phase 1: prove the round-trip works.
      });
    });

    await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
    await pc.setLocalDescription(await pc.createAnswer());

    const local = pc.localDescription;
    if (!local) {
      console.error("[hub] no local description after createAnswer");
      return;
    }
    send(socket, { type: "answer", sdp: local.sdp });
  });

  socket.on("close", () => {
    console.log("[hub] robot disconnected");
    pc?.close();
    pc = null;
  });
}
