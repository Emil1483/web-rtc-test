"use client";

import { useEffect, useMemo, useState } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

export default function Home() {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Build the ws:// URL on the client only (window is unavailable during SSR).
  const [socketUrl, setSocketUrl] = useState<string | null>(null);
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    setSocketUrl(`${proto}://${window.location.host}/api/ws`);
  }, []);

  const { sendMessage, lastMessage, readyState } = useWebSocket(socketUrl, {
    shouldReconnect: () => true,
  });

  useEffect(() => {
    if (lastMessage !== null) {
      setLog((prev) => [...prev, `⇠ ${lastMessage.data}`]);
    }
  }, [lastMessage]);

  const connected = readyState === ReadyState.OPEN;

  const status = useMemo(
    () =>
      ({
        [ReadyState.CONNECTING]: "connecting",
        [ReadyState.OPEN]: "connected",
        [ReadyState.CLOSING]: "closing",
        [ReadyState.CLOSED]: "disconnected",
        [ReadyState.UNINSTANTIATED]: "uninstantiated",
      })[readyState],
    [readyState],
  );

  const send = () => {
    if (!input || !connected) return;
    sendMessage(input);
    setLog((prev) => [...prev, `⇢ ${input}`]);
    setInput("");
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h4" gutterBottom>
            WebRTC Test Server
          </Typography>
          <Typography variant="body2" color="text.secondary">
            WebSocket: {status}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1}>
          <TextField
            fullWidth
            size="small"
            label="Message"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <Button variant="contained" onClick={send} disabled={!connected}>
            Send
          </Button>
        </Stack>

        <Paper variant="outlined" sx={{ p: 2, minHeight: 200, fontFamily: "monospace" }}>
          {log.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No messages yet.
            </Typography>
          ) : (
            log.map((line, i) => (
              <Typography key={i} variant="body2" component="div">
                {line}
              </Typography>
            ))
          )}
        </Paper>
      </Stack>
    </Container>
  );
}
