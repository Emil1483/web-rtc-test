"use client";

import { useEffect, useRef, useState } from "react";
import { Device } from "mediasoup-client";
import type { types } from "mediasoup-client";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

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

// Minimal request/response over the signaling WebSocket, correlated by id.
class Signaling {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  onEvent: (msg: Record<string, unknown>) => void = () => {};

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? "rpc error"));
      } else if (msg.event) {
        this.onEvent(msg);
      }
    };
  }

  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
  }

  request<T = unknown>(action: string, params: object = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, action, ...params }));
    });
  }

  close() {
    this.ws.close();
  }
}

export default function Home() {
  const [state, setState] = useState<string>("new");
  const [values, setValues] = useState<number[]>([0, 0, 0, 0]);
  const [hz, setHz] = useState(0);
  const [robotOnline, setRobotOnline] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const latestValues = useRef<number[]>([0, 0, 0, 0]);
  const lastT = useRef<number>(-Infinity);
  const msgTimes = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let signaling: Signaling | null = null;
    let recvTransport: types.Transport | null = null;

    const handleTelemetry = (raw: string) => {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.v)) {
          msgTimes.current.push(performance.now());
          if (typeof data.t === "number" && data.t > lastT.current) {
            lastT.current = data.t;
            latestValues.current = data.v;
          }
        }
      } catch {
        /* ignore malformed */
      }
    };

    const consumeVideo = async (producerId: string, device: Device) => {
      if (!recvTransport) return;
      const p = await signaling!.request<{
        id: string;
        producerId: string;
        kind: types.MediaKind;
        rtpParameters: types.RtpParameters;
      }>("consume", {
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      const consumer = await recvTransport.consume(p);
      if (videoRef.current) {
        videoRef.current.srcObject = new MediaStream([consumer.track]);
      }
      await signaling!.request("resumeConsumer", { consumerId: consumer.id });
      setRobotOnline(true);
    };

    const consumeData = async (dataProducerId: string) => {
      if (!recvTransport) return;
      const p = await signaling!.request<{
        id: string;
        dataProducerId: string;
        sctpStreamParameters: types.SctpStreamParameters;
        label: string;
        protocol: string;
      }>("consumeData", { transportId: recvTransport.id, dataProducerId });
      const dc = await recvTransport.consumeData(p);
      dc.on("message", (data: string) => handleTelemetry(data));
    };

    (async () => {
      // ICE servers (STUN + optional TURN) for the transport.
      let iceServers: RTCIceServer[] = [];
      try {
        const res = await fetch("/api/ice-config");
        const cfg = await res.json();
        if (Array.isArray(cfg.iceServers)) iceServers = cfg.iceServers;
      } catch {
        /* direct only */
      }

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      signaling = new Signaling(`${proto}://${window.location.host}/api/sfu`);
      await signaling.ready();
      if (cancelled) return;

      const device = new Device();
      const routerRtpCapabilities = await signaling.request<types.RtpCapabilities>(
        "getRtpCapabilities",
      );
      await device.load({ routerRtpCapabilities });

      // Create the receive transport.
      const params = await signaling.request<types.TransportOptions>(
        "createTransport",
        { direction: "recv" },
      );
      recvTransport = device.createRecvTransport({ ...params, iceServers });

      recvTransport.on("connect", ({ dtlsParameters }, cb, errback) => {
        signaling!
          .request("connectTransport", {
            transportId: recvTransport!.id,
            dtlsParameters,
          })
          .then(() => cb())
          .catch(errback);
      });
      recvTransport.on("connectionstatechange", (s) => setState(s));

      // Server pushes availability events; consume what each screen needs.
      signaling.onEvent = (msg) => {
        if (msg.event === "newProducer" && msg.kind === "video") {
          void consumeVideo(msg.producerId as string, device);
        } else if (msg.event === "newDataProducer") {
          // This screen wants telemetry; other screens would filter on label.
          if (msg.label === "telemetry") void consumeData(msg.dataProducerId as string);
        } else if (msg.event === "producerClosed") {
          setRobotOnline(false);
          lastT.current = -Infinity;
          if (videoRef.current) videoRef.current.srcObject = null;
        }
      };

      // Consume anything already being produced (robot connected first).
      const existing = await signaling.request<{
        producers: { producerId: string; kind: string }[];
        dataProducers: { dataProducerId: string; label: string }[];
      }>("getProducers");
      for (const pr of existing.producers) {
        if (pr.kind === "video") await consumeVideo(pr.producerId, device);
      }
      for (const dp of existing.dataProducers) {
        if (dp.label === "telemetry") await consumeData(dp.dataProducerId);
      }
    })().catch((err) => console.error("[sfu] setup failed:", err));

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
      recvTransport?.close();
      signaling?.close();
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
          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 2 }}>
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
