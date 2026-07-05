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
  const videoRef = useRef<HTMLVideoElement>(null);

  const latestValues = useRef<number[]>([0, 0, 0, 0]);
  const msgTimes = useRef<number[]>([]);

  useEffect(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
          } else if (Array.isArray(data.v)) {
            latestValues.current = data.v;
            msgTimes.current.push(performance.now());
          }
        } catch {
          /* ignore malformed */
        }
      };
    };

    pc.onconnectionstatechange = () => setState(pc.connectionState);

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${window.location.host}/api/signaling?role=viewer`,
    );

    ws.onmessage = async (e) => {
      const message = JSON.parse(e.data);
      if (message.type !== "offer") return;
      await pc.setRemoteDescription(message);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc);
      const answer = pc.localDescription;
      if (answer) ws.send(JSON.stringify({ type: answer.type, sdp: answer.sdp }));
    };

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
      cancelAnimationFrame(raf);
      ws.close();
      pc.close();
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
          <Chip label={`WebRTC: ${state}`} color={color} size="small" />
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
