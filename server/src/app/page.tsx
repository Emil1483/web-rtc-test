"use client";

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// Non-trickle: resolve once ICE gathering finished so the offer carries all
// candidates (matches the robot and server behaviour).
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

const THRUSTER_COLORS = ["#42a5f5", "#66bb6a", "#ffa726", "#ef5350"];

function ThrusterBar({ index, value }: { index: number; value: number }) {
  const clamped = Math.max(-1, Math.min(1, value));
  const pct = ((clamped + 1) / 2) * 100; // 0..100, 50 = zero
  const color = THRUSTER_COLORS[index];
  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
        <Typography variant="caption">T{index}</Typography>
        <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
          {value.toFixed(3)}
        </Typography>
      </Box>
      <Box
        sx={{
          position: "relative",
          height: 14,
          borderRadius: 1,
          bgcolor: "action.hover",
          overflow: "hidden",
        }}
      >
        {/* center (zero) reference */}
        <Box
          sx={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: "1px",
            bgcolor: "divider",
          }}
        />
        {/* fill from center to value */}
        <Box
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            bgcolor: color,
            left: `${Math.min(50, pct)}%`,
            width: `${Math.abs(pct - 50)}%`,
          }}
        />
      </Box>
    </Box>
  );
}

export default function Home() {
  const [state, setState] = useState<RTCPeerConnectionState>("new");
  const [values, setValues] = useState<number[]>([0, 0, 0, 0]);
  const [hz, setHz] = useState(0);
  const [robotOnline, setRobotOnline] = useState(false);
  const [transport, setTransport] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const latestValues = useRef<number[]>([0, 0, 0, 0]);
  const lastT = useRef<number>(-Infinity);
  const msgTimes = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;

    // After connecting, find the selected ICE candidate pair and report the
    // path type: host / srflx (direct) or relay (going through TURN).
    const logTransport = async (peer: RTCPeerConnection) => {
      const stats = await peer.getStats();
      let type = "unknown";
      stats.forEach((r) => {
        const rp = r as { type: string; state?: string; nominated?: boolean; localCandidateId?: string };
        if (rp.type === "candidate-pair" && rp.state === "succeeded" && rp.nominated) {
          const local = rp.localCandidateId ? stats.get(rp.localCandidateId) : undefined;
          if (local) type = (local as { candidateType: string }).candidateType;
        }
      });
      setTransport(type);
      console.log(`[webrtc] connected via ${type}${type === "relay" ? " (TURN)" : ""}`);
    };

    (async () => {
      // Fetch ICE config (STUN + optional TURN) from the server so credentials
      // aren't in the bundle. Fall back to STUN if it fails.
      let iceServers: RTCIceServer[] = [...ICE_SERVERS];
      try {
        const res = await fetch("/api/ice-config");
        const cfg = await res.json();
        if (Array.isArray(cfg.iceServers)) iceServers = cfg.iceServers;
      } catch {
        /* fall back to STUN */
      }
      if (cancelled) return;

      pc = new RTCPeerConnection({ iceServers });

      // The server is the offerer. It sends us the forwarded robot video track
      // and a data channel carrying fanned-out thruster telemetry; we answer.
      pc.ontrack = (e) => {
        if (videoRef.current) videoRef.current.srcObject = e.streams[0];
      };

      pc.ondatachannel = (e) => {
        e.channel.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.status) {
              setRobotOnline(data.status === "online");
              // Robot gone: reset the ordering guard so a reconnecting robot
              // (whose timestamps may start lower) isn't blocked.
              if (data.status === "offline") lastT.current = -Infinity;
            } else if (Array.isArray(data.v)) {
              msgTimes.current.push(performance.now());
              // Unordered channel: drop values that arrive out of order (a
              // packet older than one we've already shown). `t` is robot time.
              if (typeof data.t === "number" && data.t > lastT.current) {
                lastT.current = data.t;
                latestValues.current = data.v;
              }
            }
          } catch {
            /* ignore malformed */
          }
        };
      };

      pc.onconnectionstatechange = () => {
        if (!pc) return;
        setState(pc.connectionState);
        if (pc.connectionState === "connected") void logTransport(pc);
      };

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${window.location.host}/api/signaling?role=viewer`,
      );

      ws.onmessage = async (e) => {
        const message = JSON.parse(e.data);
        if (message.type !== "offer" || !pc) return;
        await pc.setRemoteDescription(message);
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForIceGathering(pc);
        const answer = pc.localDescription;
        if (answer) ws?.send(JSON.stringify({ type: answer.type, sdp: answer.sdp }));
      };
    })();

    // Render telemetry at animation rate, decoupled from the 100 Hz stream.
    let raf = 0;
    const tick = () => {
      setValues([...latestValues.current]);
      const now = performance.now();
      msgTimes.current = msgTimes.current.filter((t) => now - t < 1000);
      setHz(msgTimes.current.length);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ws?.close();
      pc?.close();
    };
  }, []);

  const color =
    state === "connected"
      ? "success"
      : state === "failed" || state === "disconnected"
        ? "error"
        : "warning";

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Box
          sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="h4">Robot Telemetry</Typography>
          <Stack direction="row" spacing={1}>
            {transport && (
              <Chip
                label={transport === "relay" ? "via TURN" : "direct"}
                color={transport === "relay" ? "info" : "default"}
                size="small"
                variant="outlined"
              />
            )}
            <Chip label={`WebRTC: ${state}`} color={color} size="small" />
          </Stack>
        </Box>

        <Paper
          variant="outlined"
          sx={{ p: 1, bgcolor: "black", position: "relative" }}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{
              width: "100%",
              borderRadius: 4,
              display: "block",
              opacity: robotOnline ? 1 : 0.3,
            }}
          />
          {!robotOnline && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Chip label="Robot offline" color="error" />
            </Box>
          )}
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Box
            sx={{ display: "flex", justifyContent: "space-between", mb: 2 }}
          >
            <Typography variant="h6">Thrusters</Typography>
            <Chip
              label={`${hz} Hz`}
              size="small"
              color={hz > 50 ? "success" : "default"}
            />
          </Box>
          <Stack spacing={1.5}>
            {values.slice(0, 4).map((v, i) => (
              <ThrusterBar key={i} index={i} value={v} />
            ))}
          </Stack>
        </Paper>
      </Stack>
    </Container>
  );
}
