import { Socket } from 'node:net';
import type { MinecraftStatus } from '@glacier/shared';

/**
 * Minecraft "Server List Ping" (the protocol the multiplayer screen uses). Works for any Java
 * edition server without enabling query or RCON.
 */

function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i]!;
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, size: i + 1 };
  }
  throw new Error('VarInt too long');
}

function packet(id: number, ...fields: Buffer[]) {
  const body = Buffer.concat([varInt(id), ...fields]);
  return Buffer.concat([varInt(body.length), body]);
}

function mcString(s: string) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
}

/** Flatten a chat component (or plain string) to text, dropping § colour codes. */
export function chatToText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/§./g, '');
  if (!value || typeof value !== 'object') return '';
  const v = value as { text?: string; extra?: unknown[] };
  return `${chatToText(v.text ?? '')}${(v.extra ?? []).map(chatToText).join('')}`;
}

export function pingMinecraft(host: string, port: number, timeoutMs = 3_000): Promise<MinecraftStatus> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const started = Date.now();
    let buf = Buffer.alloc(0);
    const done = (status: MinecraftStatus) => {
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(timeoutMs, () => done({ online: false }));
    socket.on('error', () => done({ online: false }));
    socket.connect(port, host, () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // Handshake (protocol -1 = "just asking"), next state 1 = status; then a status request.
      socket.write(packet(0x00, varInt(-1), mcString(host), portBuf, varInt(1)));
      socket.write(packet(0x00));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const id = readVarInt(buf, len.size)!;
        const strLen = readVarInt(buf, len.size + id.size)!;
        const start = len.size + id.size + strLen.size;
        const json = JSON.parse(buf.subarray(start, start + strLen.value).toString('utf8'));
        done({
          online: true,
          version: json.version?.name,
          motd: chatToText(json.description),
          players: {
            online: json.players?.online ?? 0,
            max: json.players?.max ?? 0,
            sample: (json.players?.sample ?? []).map((p: { name: string; id: string }) => ({ name: p.name, id: p.id })),
          },
          latencyMs: Date.now() - started,
        });
      } catch {
        done({ online: false });
      }
    });
  });
}

export const __test = { varInt, readVarInt, packet, mcString };
