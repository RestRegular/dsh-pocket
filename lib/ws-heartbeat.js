/**
 * dsh-pocket — WebSocket 心跳中继。
 *
 * 宿主的 Remote 多路复用服务器（`/api/remote.mux`）每 2 秒发一次 Ping，
 * 连续 2 个间隔没等到 Pong 就直接 `socket.terminate()`；浏览器只能看到
 * 一个没有任何关闭原因的 1006，随后整条连接被重建、页面数据重新拉取。
 *
 * 桌面直通模式下手机连的是 Pocket 的反代，这条 Ping 会一路穿过隧道打到
 * 手机上。手机息屏、浏览器冻结标签页、移动网络休眠时，Pong 往往来不及在
 * 4 秒内回来，于是空闲会话被反复踢下线——这正是「没在干活的会话老是重新
 * 连接」的根因；有任务在跑的会话因为持续收到下行帧，掩盖了这个问题。
 *
 * 这里在代理边界替手机立刻回一个 Pong：宿主看到的永远是及时应答，链路不
 * 再因为手机睡着而被判死。Ping 本身照旧转发给手机，保持原有的保活节奏和
 * NAT 映射，行为差异只有「谁来回这个 Pong」。
 *
 * @module dsh-pocket/ws-heartbeat
 */

import { randomBytes } from 'node:crypto';

/** 控制帧 opcode：Ping（RFC 6455 §5.2）。 */
const OPCODE_PING = 0x9;

/** Pong 帧 opcode。 */
const OPCODE_PONG = 0xa;

/** 控制帧载荷上限（RFC 6455 §5.5）。 */
const MAX_CONTROL_PAYLOAD = 125;

/** 单帧长度上限；超过基本可以判定这条链路已经错乱。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** 帧头最长 2 + 8 + 4 字节。 */
const MAX_HEAD_BYTES = 14;

/**
 * 按掩码键还原载荷。
 * @param {Buffer} payload
 * @param {Buffer} key
 * @returns {Buffer}
 */
function unmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    out[index] = payload[index] ^ key[index & 3];
  }
  return out;
}

/**
 * 编码一个客户端→服务端的 Pong（必须带掩码）。
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodePong(payload) {
  const body = payload.length > MAX_CONTROL_PAYLOAD
    ? payload.subarray(0, MAX_CONTROL_PAYLOAD)
    : payload;
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ key[index & 3];
  }
  return Buffer.concat([Buffer.from([0x80 | OPCODE_PONG, 0x80 | masked.length]), key, masked]);
}

/**
 * 判断这次升级是不是真正的 WebSocket（否则不能按帧解析字节流）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').IncomingMessage} upstreamRes
 * @returns {boolean}
 */
export function isWebSocketUpgrade(req, upstreamRes) {
  const upgrade = req.headers.upgrade;
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return false;
  return upstreamRes.headers['sec-websocket-accept'] !== undefined;
}

/**
 * 上游→下游方向的帧旁路：每读到一个 Ping，就地补一个 Pong，同时把原始帧
 * 继续转发下去。
 *
 * 只解析帧头，不关心载荷语义，因此压缩（RSV1）、分片、扩展握手都能照常
 * 透传；控制帧本身永远不压缩、也不会被分片。
 *
 * 载荷边到边转发、不落缓冲，所以再大的快照批次也不会在这里堆积。
 */
export class HeartbeatRelay {
  /**
   * @param {{
   *   onPong: (payload: Buffer) => void,
   *   forward: (chunk: Buffer) => void,
   *   onError?: (error: Error) => void,
   * }} handlers
   */
  constructor({ onPong, forward, onError }) {
    this.onPong = onPong;
    this.forward = forward;
    this.onError = onError ?? (() => {});
    /** 当前帧的帧头字节（含扩展长度与掩码键）。 */
    this.head = Buffer.allocUnsafe(MAX_HEAD_BYTES);
    this.headLength = 0;
    /** 帧头还需要几个字节才算完整。 */
    this.need = 2;
    /** 当前帧剩余待消费的载荷字节数。 */
    this.remaining = 0;
    /** 正在收集的 Ping 载荷；非 Ping 帧为 undefined。 */
    this.ping = undefined;
    /** Ping 帧的掩码键（服务端下发时没有）。 */
    this.mask = undefined;
    this.opcode = 0;
  }

  /**
   * 喂一段上游字节。
   * @param {Buffer} chunk
   * @returns {void}
   */
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - offset);
        const slice = chunk.subarray(offset, offset + take);
        offset += take;
        this.remaining -= take;
        this.forward(slice);
        if (this.ping !== undefined) this.ping.push(slice);
        if (this.remaining === 0) this.#frameEnd();
        continue;
      }
      this.head[this.headLength] = chunk[offset];
      this.headLength += 1;
      offset += 1;
      if (this.headLength < this.need) continue;
      if (this.#headReady()) continue;
      return;
    }
  }

  /**
   * 帧头凑齐后推进状态：先算出完整帧头长度，再解析长度/掩码。
   * @returns {boolean} 解析是否仍然健康（false 表示已报错，调用方应停止）。
   */
  #headReady() {
    if (this.need === 2) {
      const second = this.head[1];
      const short = second & 0x7f;
      const ext = short === 126 ? 2 : short === 127 ? 8 : 0;
      this.need = 2 + ext + ((second & 0x80) !== 0 ? 4 : 0);
      if (this.headLength < this.need) return true;
    }
    const second = this.head[1];
    const short = second & 0x7f;
    const ext = short === 126 ? 2 : short === 127 ? 8 : 0;
    const masked = (second & 0x80) !== 0;
    let length = short;
    if (ext === 2) {
      length = this.head.readUInt16BE(2);
    } else if (ext === 8) {
      const wide = this.head.readBigUInt64BE(2);
      if (wide > BigInt(MAX_FRAME_BYTES)) {
        this.#fail(new Error('websocket frame too large'));
        return false;
      }
      length = Number(wide);
    }
    if (length > MAX_FRAME_BYTES) {
      this.#fail(new Error('websocket frame too large'));
      return false;
    }
    this.opcode = this.head[0] & 0x0f;
    this.mask = masked ? Buffer.from(this.head.subarray(2 + ext, 2 + ext + 4)) : undefined;
    this.forward(Buffer.from(this.head.subarray(0, this.headLength)));
    if (this.opcode === OPCODE_PING) this.ping = [];
    this.remaining = length;
    this.headLength = 0;
    this.need = 2;
    if (this.remaining === 0) this.#frameEnd();
    return true;
  }

  /** 一帧结束：Ping 就补 Pong，然后复位。 */
  #frameEnd() {
    if (this.ping !== undefined) {
      let payload = this.ping.length === 1 ? this.ping[0] : Buffer.concat(this.ping);
      if (this.mask !== undefined) payload = unmask(payload, this.mask);
      this.ping = undefined;
      this.onPong(payload);
    }
    this.remaining = 0;
    this.headLength = 0;
    this.need = 2;
    this.mask = undefined;
  }

  /**
   * @param {Error} error
   */
  #fail(error) {
    this.remaining = 0;
    this.headLength = 0;
    this.need = 2;
    this.ping = undefined;
    this.mask = undefined;
    this.onError(error);
  }
}
