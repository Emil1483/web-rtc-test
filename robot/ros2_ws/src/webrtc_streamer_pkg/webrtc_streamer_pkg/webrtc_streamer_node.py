"""WebRTC streamer node (mediasoup producer).

The robot side of the SFU. Connects to the mediasoup signaling endpoint and
*produces*:

  * /camera/image_raw  (sensor_msgs/Image, rgb8)     -> a VP8 video track
  * /thrusters         (my_interfaces/Thrusters)     -> data producer "telemetry" (unreliable)
  * /pointcloud/points (sensor_msgs/PointCloud2)     -> data producer "pointcloud" (reliable)

Point clouds go as binary: 8-byte little-endian float64 timestamp, then the
PointCloud2 payload verbatim (packed float32 x,y,z per point — the layout
pointcloud_node publishes). The channel is reliable+ordered because a cloud
fragments into many SCTP chunks and unreliable delivery loses most of them;
newest-wins is enforced sender-side by dropping clouds while the channel
still buffers earlier ones.

Browsers consume these selectively via the server. rclpy runs in a background
thread; pymediasoup/aiortc run on an asyncio loop in the main thread. ROS
callbacks hand data to the loop via loop.call_soon_threadsafe.
"""

import asyncio
import fractions
import json
import os
import struct
import threading
import time

import numpy as np

import rclpy
from rclpy.node import Node

from aiortc import MediaStreamTrack
from av import VideoFrame
import websockets

from pymediasoup import AiortcHandler, Device
from pymediasoup.rtp_parameters import RtpCapabilities
from pymediasoup.models.transport import (
    DtlsParameters,
    IceCandidate,
    IceParameters,
)
from pymediasoup.sctp_parameters import SctpParameters

from sensor_msgs.msg import Image, PointCloud2
from my_interfaces.msg import Thrusters

DEFAULT_SIGNALING_URL = "ws://localhost:3000/api/sfu"
RECONNECT_DELAY_S = 3.0
VIDEO_CLOCK_RATE = 90000


def _dump(model):
    """Serialize a pymediasoup pydantic model to a JSON-ready dict (camelCase)."""
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json", by_alias=True, exclude_none=True)
    if hasattr(model, "json"):
        return json.loads(model.json(by_alias=True, exclude_none=True))
    return model


class RosVideoTrack(MediaStreamTrack):
    """aiortc video track fed by the latest ROS camera frame (drop-old)."""

    kind = "video"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self._start = None

    def push(self, frame: VideoFrame):
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

        self.video_track: RosVideoTrack | None = None
        self.data_producer = None
        self.pointcloud_producer = None

        # Signaling RPC state (per connection).
        self._ws = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 1

        self.create_subscription(Image, "camera/image_raw", self.on_image, 10)
        self.create_subscription(Thrusters, "thrusters", self.on_thrusters, 10)
        # depth 1: clouds are big and only the newest matters
        self.create_subscription(
            PointCloud2, "pointcloud/points", self.on_pointcloud, 1
        )
        self._warned_pointcloud_layout = False
        self.get_logger().info(
            f"WebRtcStreamerNode started, signaling: {self.signaling_url}"
        )

    # --- ROS callbacks (rclpy spin thread) --------------------------------

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
        dp = self.data_producer
        if dp is not None and dp.readyState == "open":
            dp.send(payload)

    def on_pointcloud(self, msg: PointCloud2):
        # The streamer forwards msg.data verbatim, so it requires the packed
        # float32 x,y,z layout pointcloud_node publishes.
        if msg.point_step != 12 or msg.is_bigendian:
            if not self._warned_pointcloud_layout:
                self._warned_pointcloud_layout = True
                self.get_logger().warn(
                    "pointcloud dropped: expected packed little-endian float32 "
                    f"x,y,z (point_step 12), got point_step {msg.point_step}"
                )
            return
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        payload = struct.pack("<d", stamp) + bytes(msg.data)
        self.loop.call_soon_threadsafe(self._send_pointcloud, payload)

    def _send_pointcloud(self, payload: bytes):
        dp = self.pointcloud_producer
        if dp is None or dp.readyState != "open":
            return
        # Newest wins: if the channel still buffers earlier clouds, drop this
        # one instead of queueing lag.
        if dp.bufferedAmount > 2 * len(payload):
            return
        dp.send(payload)

    # --- signaling RPC ----------------------------------------------------

    async def rpc(self, action: str, params: dict | None = None):
        assert self._ws is not None
        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future = self.loop.create_future()
        self._pending[request_id] = future
        await self._ws.send(json.dumps({"id": request_id, "action": action, **(params or {})}))
        return await future

    async def _reader(self, ws):
        async for raw in ws:
            msg = json.loads(raw)
            mid = msg.get("id")
            if mid is not None and mid in self._pending:
                fut = self._pending.pop(mid)
                if msg.get("ok"):
                    fut.set_result(msg.get("data"))
                else:
                    fut.set_exception(RuntimeError(msg.get("error", "rpc error")))
            # server events (newProducer, etc.) are irrelevant to a producer

    # --- asyncio / mediasoup (main loop) ----------------------------------

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
        self.video_track = RosVideoTrack()
        self._pending = {}
        transport = None

        async with websockets.connect(self.signaling_url) as ws:
            self._ws = ws
            reader_task = asyncio.ensure_future(self._reader(ws))
            try:
                # Load device with the router's capabilities.
                router_caps = await self.rpc("getRtpCapabilities")
                device = Device(
                    handlerFactory=AiortcHandler.createFactory(
                        tracks=[self.video_track], loop=self.loop
                    )
                )
                await device.load(RtpCapabilities(**router_caps))

                # Create the send transport (server dicts -> pydantic models).
                params = await self.rpc("createTransport", {"direction": "send"})
                transport = device.createSendTransport(
                    id=params["id"],
                    iceParameters=IceParameters(**params["iceParameters"]),
                    iceCandidates=[IceCandidate(**c) for c in params["iceCandidates"]],
                    dtlsParameters=DtlsParameters(**params["dtlsParameters"]),
                    sctpParameters=(
                        SctpParameters(**params["sctpParameters"])
                        if params.get("sctpParameters")
                        else None
                    ),
                )

                @transport.on("connectionstatechange")
                async def on_conn_state(state):
                    self.get_logger().info(f"send transport state: {state}")

                @transport.on("connect")
                async def on_connect(dtlsParameters):
                    await self.rpc(
                        "connectTransport",
                        {"transportId": transport.id, "dtlsParameters": _dump(dtlsParameters)},
                    )

                @transport.on("produce")
                async def on_produce(kind, rtpParameters, appData):
                    res = await self.rpc(
                        "produce",
                        {
                            "transportId": transport.id,
                            "kind": kind,
                            "rtpParameters": _dump(rtpParameters),
                            "appData": appData or {},
                        },
                    )
                    return res["id"]

                @transport.on("producedata")
                async def on_producedata(sctpStreamParameters, label, protocol, appData):
                    res = await self.rpc(
                        "produceData",
                        {
                            "transportId": transport.id,
                            "sctpStreamParameters": _dump(sctpStreamParameters),
                            "label": label,
                            "protocol": protocol,
                            "appData": appData or {},
                        },
                    )
                    return res["id"]

                await transport.produce(track=self.video_track, stopTracks=False)
                self.data_producer = await transport.produceData(
                    ordered=False, maxRetransmits=0, label="telemetry"
                )
                # Ordered + reliable, unlike telemetry: a cloud fragments into
                # ~30 SCTP chunks, and unreliable (or even unordered) delivery
                # of fragmented messages loses ~90% of them end-to-end.
                # Newest-wins is enforced in _send_pointcloud instead.
                self.pointcloud_producer = await transport.produceData(
                    label="pointcloud"
                )
                self.get_logger().info("producing video + telemetry + pointcloud")

                await reader_task  # returns when the socket closes
            finally:
                reader_task.cancel()
                self.data_producer = None
                self.pointcloud_producer = None
                self.video_track = None
                self._ws = None
                if transport is not None:
                    await transport.close()


def main(args=None):
    rclpy.init(args=args)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    node = WebRtcStreamerNode(loop)

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
