"use server";

// ICE server list (STUN + optional TURN), built from environment so credentials
// and URLs are never hardcoded. Served to browser peers via the getIceServers
// server action (mediasoup transports take iceServers for the optional TURN
// fallback).
//
// Env:
//   TURN_URLS        comma-separated TURN urls, e.g.
//                    "turn:1.2.3.4:3478?transport=udp,turn:1.2.3.4:3478?transport=tcp"
//   TURN_USERNAME    TURN username
//   TURN_CREDENTIAL  TURN password
// If TURN_URLS is unset, only STUN is used (direct connectivity only).

export interface IceServer {
  urls: string; // werift requires a string (not string[])
  username?: string;
  credential?: string;
}

let loggedConfig = false;

export async function getIceServers(): Promise<IceServer[]> {
  const servers: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

  const turnUrls = (process.env.TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;

  for (const urls of turnUrls) {
    servers.push({ urls, username, credential });
  }

  if (!loggedConfig) {
    loggedConfig = true;
    console.log(
      turnUrls.length > 0
        ? `[ice] TURN enabled (${turnUrls.length} url(s)): ${turnUrls.join(", ")}`
        : "[ice] TURN disabled — STUN only (direct connectivity)",
    );
  }

  return servers;
}
