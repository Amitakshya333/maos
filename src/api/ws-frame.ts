/**
 * Zero-Dependency RFC 6455 WebSocket Framing
 *
 * Implements standard WebSocket handshake, frame serialization,
 * and frame deserialization using Node's standard `crypto` and `Buffer`.
 */

import * as crypto from 'crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/**
 * Generate the Sec-WebSocket-Accept header for the RFC 6455 handshake.
 */
export function createWebSocketAccept(secWebSocketKey: string): string {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey.trim() + WS_GUID)
    .digest('base64');
}

/**
 * Encode a message as an RFC 6455 frame.
 * Server-to-client frames are NOT masked.
 * Client-to-server frames MUST be masked.
 */
export function encodeWebSocketFrame(
  payload: string | Buffer,
  opcode: number = OPCODES.TEXT,
  masked = false,
  maskKey?: Buffer,
): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf-8');
  const length = data.length;

  let headerLength = 2;
  if (length >= 126 && length <= 65535) {
    headerLength += 2;
  } else if (length > 65535) {
    headerLength += 8;
  }

  if (masked) {
    headerLength += 4;
  }

  const frame = Buffer.alloc(headerLength + length);

  // Byte 0: FIN bit (0x80) | opcode
  frame[0] = 0x80 | (opcode & 0x0f);

  // Byte 1: Mask bit | payload length descriptor
  const maskBit = masked ? 0x80 : 0x00;
  let offset = 2;

  if (length < 126) {
    frame[1] = maskBit | length;
  } else if (length <= 65535) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }

  if (masked) {
    const mask = maskKey || crypto.randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;

    for (let i = 0; i < length; i++) {
      frame[offset + i] = data[i] ^ mask[i % 4];
    }
  } else {
    data.copy(frame, offset);
  }

  return frame;
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Parse one or more complete RFC 6455 frames from a buffer.
 * Returns decoded frames and any remaining partial buffer.
 */
export function decodeWebSocketFrames(buffer: Buffer): {
  frames: DecodedFrame[];
  remaining: Buffer;
} {
  const frames: DecodedFrame[] = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];

    const opcode = byte0 & 0x0f;
    const isMasked = (byte1 & 0x80) !== 0;
    let payloadLength = byte1 & 0x7f;

    let headerSize = 2;
    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerSize = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerSize = 10;
    }

    if (isMasked) {
      headerSize += 4;
    }

    const totalFrameSize = headerSize + payloadLength;
    if (buffer.length - offset < totalFrameSize) {
      // Incomplete frame, wait for more chunks
      break;
    }

    let payload: Buffer;
    if (isMasked) {
      const maskOffset = headerSize - 4;
      const maskKey = buffer.slice(offset + maskOffset, offset + headerSize);
      payload = Buffer.alloc(payloadLength);
      const dataOffset = offset + headerSize;

      for (let i = 0; i < payloadLength; i++) {
        payload[i] = buffer[dataOffset + i] ^ maskKey[i % 4];
      }
    } else {
      payload = buffer.slice(offset + headerSize, offset + totalFrameSize);
    }

    frames.push({ opcode, payload });
    offset += totalFrameSize;
  }

  return {
    frames,
    remaining: buffer.slice(offset),
  };
}
