"""WebRTC streamer node.

Phase 3: the robot side of the SFU. Acts as the WebRTC offerer and bridges ROS
topics to the server:

  * /camera/image_raw (sensor_msgs/Image, rgb8) -> a VP8 video track
  * /thrusters        (my_interfaces/Thrusters)  -> JSON on the data channel

rclpy runs in a background thread; aiortc runs on an asyncio loop in the main
thread. ROS callbacks hand data to the loop via loop.call_soon_threadsafe.
"""

import asyncio
import fractions
import json
import threading
import time

import numpy as np

import rclpy
from rclpy.node import Node

from aiortc import (
    MediaStreamTrack,
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from av import VideoFrame
import websockets

from sensor_msgs.msg import Image
from my_interfaces.msg import Thrusters

DEFAULT_SIGNALING_URL = "ws://localhost:3000/api/signaling?role=robot"
STUN_URL = "stun:stun.l.google.com:19302"
RECONNECT_DELAY_S = 3.0
VIDEO_CLOCK_RATE = 90000


class RosVideoTrack(MediaStreamTrack):
    """aiortc video track fed by the latest ROS camera frame (drop-old)."""

    kind = "video"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self._start = None

    def push(self, frame: VideoFrame):
        # Runs on the asyncio loop (via call_soon_threadsafe). Keep only the
        # newest frame so a slow encoder never builds latency.
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._queue.put_nowait(frame)

    async def recv(self) -> VideoFrame:
        frame = await self._queue.get()
        if self._start is None:
            self._start = time.monotonic()
        frame.pts = int((time.monotonic() - self._start) * VIDEO_CLOCK_RATE)
        frame.time_base = fractions.Fraction(1, VIDEO_CLOCK_RATE)
        return frame


class WebRtcStreamerNode(Node):
    def __init__(self, loop: asyncio.AbstractEventLoop):
        super().__init__("webrtc_streamer_node")
        self.loop = loop
        self.declare_parameter("signaling_url", DEFAULT_SIGNALING_URL)
        self.signaling_url = (
            self.get_parameter("signaling_url").get_parameter_value().string_value
        )

        # Set per-connection in _connect_once; ROS callbacks guard against None.
        self.video_track: RosVideoTrack | None = None
        self.channel = None

        self.create_subscription(Image, "camera/image_raw", self.on_image, 10)
        self.create_subscription(Thrusters, "thrusters", self.on_thrusters, 10)
        self.get_logger().info(
            f"WebRtcStreamerNode started, signaling: {self.signaling_url}"
        )

    # --- ROS callbacks (run on the rclpy spin thread) ---------------------

    def on_image(self, msg: Image):
        track = self.video_track
        if track is None:
            return
        arr = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(
            msg.height, msg.width, 3
        )
        frame = VideoFrame.from_ndarray(arr, format="rgb24")
        self.loop.call_soon_threadsafe(track.push, frame)

    def on_thrusters(self, msg: Thrusters):
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        payload = json.dumps({"t": stamp, "v": [float(v) for v in msg.values]})
        self.loop.call_soon_threadsafe(self._send_telemetry, payload)

    def _send_telemetry(self, payload: str):
        channel = self.channel
        if channel is not None and channel.readyState == "open":
            channel.send(payload)

    # --- asyncio / WebRTC (run on the main loop) --------------------------

    async def run(self):
        while rclpy.ok():
            try:
                await self._connect_once()
            except (OSError, websockets.WebSocketException) as exc:
                self.get_logger().warn(f"signaling connection failed: {exc}")
            if rclpy.ok():
                self.get_logger().info(f"reconnecting in {RECONNECT_DELAY_S}s")
                await asyncio.sleep(RECONNECT_DELAY_S)

    async def _connect_once(self):
        # The server is the offerer (werift interops reliably as offerer). We
        # answer: attach our video track to its recvonly video m-line and send
        # telemetry on the data channel it creates.
        config = RTCConfiguration(iceServers=[RTCIceServer(urls=STUN_URL)])
        pc = RTCPeerConnection(configuration=config)
        self.video_track = RosVideoTrack()

        @pc.on("datachannel")
        def on_datachannel(channel):
            self.channel = channel
            self.get_logger().info(f"data channel: {channel.label}")

        @pc.on("connectionstatechange")
        async def on_state_change():
            self.get_logger().info(f"connection state: {pc.connectionState}")

        try:
            async with websockets.connect(self.signaling_url) as ws:
                self.get_logger().info("connected to signaling, awaiting offer")
                async for raw in ws:
                    message = json.loads(raw)
                    if message.get("type") != "offer":
                        continue
                    await pc.setRemoteDescription(
                        RTCSessionDescription(sdp=message["sdp"], type=message["type"])
                    )
                    pc.addTrack(self.video_track)
                    # aiortc gathers ICE during setLocalDescription (non-trickle).
                    await pc.setLocalDescription(await pc.createAnswer())
                    await ws.send(
                        json.dumps(
                            {
                                "type": pc.localDescription.type,
                                "sdp": pc.localDescription.sdp,
                            }
                        )
                    )
                    self.get_logger().info("answer sent")
        finally:
            self.channel = None
            self.video_track = None
            await pc.close()


def main(args=None):
    rclpy.init(args=args)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    node = WebRtcStreamerNode(loop)

    # rclpy spins in a background thread; the main thread runs the asyncio loop.
    ros_thread = threading.Thread(target=rclpy.spin, args=(node,), daemon=True)
    ros_thread.start()

    try:
        loop.run_until_complete(node.run())
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
