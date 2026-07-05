// mediasoup SFU core.
//
// One Worker + one Router (a single "room"). The robot connects and *produces*
// media (video) and data (telemetry, and later pointcloud/events, each with its
// own reliability). Browsers connect and *consume* only the producers each
// screen needs — the server forwards exactly that, nothing more.
//
// Signaling is a small request/response + event protocol over the next-ws
// WebSocket (see api/sfu/route.ts). This module owns the mediasoup objects and
// the shared producer registry; the Peer class handles one connection.

import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";
import type { WebSocket } from "ws";

import { config } from "./config";

let worker: types.Worker | undefined;
let router: types.Router | undefined;
let initPromise: Promise<types.Router> | undefined;

// Shared registries so any peer can consume any producer (selective subscribe).
const producers = new Map<string, types.Producer>();
const dataProducers = new Map<string, types.DataProducer>();
const peers = new Set<Peer>();

export async function initSfu(): Promise<types.Router> {
  if (router) return router;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    worker = await mediasoup.createWorker(config.worker);
    worker.on("died", () => {
      console.error("[sfu] mediasoup worker died — exiting");
      process.exit(1);
    });
    router = await worker.createRouter({
      mediaCodecs: config.router.mediaCodecs,
    });
    console.log("[sfu] router ready");
    return router;
  })();

  return initPromise;
}

function getRouter(): types.Router {
  if (!router) throw new Error("[sfu] not initialized");
  return router;
}

// Health/status for /api/status.
export function getSfuStatus() {
  return {
    ready: !!router,
    peers: peers.size,
    producers: producers.size,
    dataProducers: dataProducers.size,
  };
}

// Describe a producer to clients so they can decide whether to consume it.
function describeProducer(p: types.Producer) {
  return { producerId: p.id, kind: p.kind, appData: p.appData };
}
function describeDataProducer(p: types.DataProducer) {
  return { dataProducerId: p.id, label: p.label, appData: p.appData };
}

interface Envelope {
  id?: number;
  action?: string;
  event?: string;
  [key: string]: unknown;
}

export class Peer {
  readonly ws: WebSocket;
  private transports = new Map<string, types.WebRtcTransport>();
  private producers = new Map<string, types.Producer>();
  private consumers = new Map<string, types.Consumer>();
  private dataProducers = new Map<string, types.DataProducer>();
  private dataConsumers = new Map<string, types.DataConsumer>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    peers.add(this);
  }

  private send(msg: Envelope) {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private reply(id: number | undefined, data: unknown) {
    if (id !== undefined) this.send({ id, ok: true, data });
  }
  private replyError(id: number | undefined, error: string) {
    if (id !== undefined) this.send({ id, ok: false, error });
  }

  async handle(raw: unknown) {
    let msg: Envelope;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    try {
      switch (msg.action) {
        case "getRtpCapabilities":
          return this.reply(msg.id, getRouter().rtpCapabilities);

        case "getProducers":
          // Late joiner: list what's already being produced.
          return this.reply(msg.id, {
            producers: [...producers.values()].map(describeProducer),
            dataProducers: [...dataProducers.values()].map(describeDataProducer),
          });

        case "createTransport":
          return this.reply(msg.id, await this.createTransport());

        case "connectTransport":
          await this.getTransport(msg.transportId as string).connect({
            dtlsParameters: msg.dtlsParameters as types.DtlsParameters,
          });
          return this.reply(msg.id, {});

        case "produce":
          return this.reply(msg.id, await this.produce(msg));

        case "produceData":
          return this.reply(msg.id, await this.produceData(msg));

        case "consume":
          return this.reply(msg.id, await this.consume(msg));

        case "consumeData":
          return this.reply(msg.id, await this.consumeData(msg));

        case "resumeConsumer":
          await this.consumers.get(msg.consumerId as string)?.resume();
          return this.reply(msg.id, {});

        default:
          return this.replyError(msg.id, `unknown action: ${msg.action}`);
      }
    } catch (err) {
      console.error("[sfu] handler error:", err);
      this.replyError(msg.id, err instanceof Error ? err.message : "error");
    }
  }

  private getTransport(id: string): types.WebRtcTransport {
    const t = this.transports.get(id);
    if (!t) throw new Error(`no transport ${id}`);
    return t;
  }

  private async createTransport() {
    const transport = await getRouter().createWebRtcTransport({
      ...config.webRtcTransport,
    });
    this.transports.set(transport.id, transport);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  private async produce(msg: Envelope) {
    const transport = this.getTransport(msg.transportId as string);
    const producer = await transport.produce({
      kind: msg.kind as types.MediaKind,
      rtpParameters: msg.rtpParameters as types.RtpParameters,
      appData: (msg.appData as types.AppData) ?? {},
    });
    this.producers.set(producer.id, producer);
    producers.set(producer.id, producer);
    producer.on("transportclose", () => this.producers.delete(producer.id));
    // Tell everyone else a new producer is available to consume.
    broadcastExcept(this, { event: "newProducer", ...describeProducer(producer) });
    return { id: producer.id };
  }

  private async produceData(msg: Envelope) {
    const transport = this.getTransport(msg.transportId as string);
    const dataProducer = await transport.produceData({
      sctpStreamParameters: msg.sctpStreamParameters as types.SctpStreamParameters,
      label: msg.label as string | undefined,
      protocol: msg.protocol as string | undefined,
      appData: (msg.appData as types.AppData) ?? {},
    });
    this.dataProducers.set(dataProducer.id, dataProducer);
    dataProducers.set(dataProducer.id, dataProducer);
    broadcastExcept(this, {
      event: "newDataProducer",
      ...describeDataProducer(dataProducer),
    });
    return { id: dataProducer.id };
  }

  private async consume(msg: Envelope) {
    const producerId = msg.producerId as string;
    const rtpCapabilities = msg.rtpCapabilities as types.RtpCapabilities;
    if (!getRouter().canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`cannot consume ${producerId}`);
    }
    const transport = this.getTransport(msg.transportId as string);
    // Start paused; client resumes after wiring up (avoids losing early frames).
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => this.consumers.delete(consumer.id));
    consumer.on("producerclose", () => {
      this.consumers.delete(consumer.id);
      this.send({ event: "consumerClosed", consumerId: consumer.id });
    });
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  private async consumeData(msg: Envelope) {
    const transport = this.getTransport(msg.transportId as string);
    const dataConsumer = await transport.consumeData({
      dataProducerId: msg.dataProducerId as string,
    });
    this.dataConsumers.set(dataConsumer.id, dataConsumer);
    dataConsumer.on("dataproducerclose", () =>
      this.dataConsumers.delete(dataConsumer.id),
    );
    return {
      id: dataConsumer.id,
      dataProducerId: dataConsumer.dataProducerId,
      sctpStreamParameters: dataConsumer.sctpStreamParameters,
      label: dataConsumer.label,
      protocol: dataConsumer.protocol,
    };
  }

  close() {
    for (const producer of this.producers.values()) {
      producers.delete(producer.id);
      broadcastExcept(this, { event: "producerClosed", producerId: producer.id });
    }
    for (const dataProducer of this.dataProducers.values()) {
      dataProducers.delete(dataProducer.id);
      broadcastExcept(this, {
        event: "dataProducerClosed",
        dataProducerId: dataProducer.id,
      });
    }
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    peers.delete(this);
  }
}

function broadcastExcept(origin: Peer, msg: Envelope) {
  for (const peer of peers) {
    if (peer !== origin) {
      try {
        peer.ws.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }
}
