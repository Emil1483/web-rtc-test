"""WebRTC streamer node.

Phase 1: the robot side of the SFU. Acts as the WebRTC offerer, connects to the
server's signaling WebSocket, opens a data channel, and exchanges ping/echo
messages to prove the peer connection works end to end. ROS topic and camera
bridging land in later phases.
"""

import asyncio
import json

import rclpy
from rclpy.node import Node

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
import websockets

DEFAULT_SIGNALING_URL = "ws://localhost:3000/api/signaling?role=robot"
STUN_URL = "stun:stun.l.google.com:19302"
RECONNECT_DELAY_S = 3.0


class WebRtcStreamerNode(Node):
    def __init__(self):
        super().__init__("webrtc_streamer_node")
        self.declare_parameter("signaling_url", DEFAULT_SIGNALING_URL)
        self.signaling_url = (
            self.get_parameter("signaling_url").get_parameter_value().string_value
        )
        self.get_logger().info(
            f"WebRtcStreamerNode started, signaling: {self.signaling_url}"
        )

    async def run(self):
        """Reconnect loop — survives server restarts during development."""
        while rclpy.ok():
            try:
                await self._connect_once()
            except (OSError, websockets.WebSocketException) as exc:
                self.get_logger().warn(f"signaling connection failed: {exc}")
            if rclpy.ok():
                self.get_logger().info(f"reconnecting in {RECONNECT_DELAY_S}s")
                await asyncio.sleep(RECONNECT_DELAY_S)

    async def _connect_once(self):
        config = RTCConfiguration(iceServers=[RTCIceServer(urls=STUN_URL)])
        pc = RTCPeerConnection(configuration=config)
        ping_task: asyncio.Task | None = None

        channel = pc.createDataChannel("telemetry")

        @channel.on("open")
        def on_open():
            nonlocal ping_task
            self.get_logger().info("data channel open")
            ping_task = asyncio.ensure_future(self._ping(channel))

        @channel.on("message")
        def on_message(message):
            self.get_logger().info(f"from server: {message}")

        @pc.on("connectionstatechange")
        async def on_state_change():
            self.get_logger().info(f"connection state: {pc.connectionState}")

        try:
            # aiortc gathers ICE during setLocalDescription (non-trickle), so the
            # resulting SDP already carries our candidates.
            await pc.setLocalDescription(await pc.createOffer())

            async with websockets.connect(self.signaling_url) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": pc.localDescription.type,
                            "sdp": pc.localDescription.sdp,
                        }
                    )
                )
                self.get_logger().info("offer sent, awaiting answer")

                async for raw in ws:
                    message = json.loads(raw)
                    if message.get("type") == "answer":
                        await pc.setRemoteDescription(
                            RTCSessionDescription(
                                sdp=message["sdp"], type=message["type"]
                            )
                        )
                        self.get_logger().info("answer applied")
        finally:
            if ping_task is not None:
                ping_task.cancel()
            await pc.close()

    async def _ping(self, channel):
        index = 0
        try:
            while True:
                channel.send(f"ping {index}")
                index += 1
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass


def main(args=None):
    rclpy.init(args=args)
    node = WebRtcStreamerNode()
    try:
        asyncio.run(node.run())
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
