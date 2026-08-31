import { Duplex } from "node:stream";

/**
 * Hard upper bound on a single length-prefixed tunnel protocol frame. Checked BEFORE
 * `readExactly(stream, bodyLen)` runs, because `bodyLen` is a big-endian u32 read straight off
 * the wire from a peer that has not authenticated yet — without a cap, a malicious/garbled length
 * makes `readExactly` buffer an unbounded number of chunks trying to reach it. This is exactly how
 * dev crashed on 2026-08-14: a stray HTTP request landed on the tunnel port, and its first four
 * bytes (`b"GET "`), interpreted as a length prefix, decoded to 1_195_725_856.
 *
 * Real payloads are a few hundred bytes of JSON (a UUID, a short secret, a couple of prefixed ids
 * and a hostname) — 64 KiB leaves well over 100x headroom. Mirrors the Rust side's
 * `MAX_TUNNEL_FRAME` (`src/protocol/tunnel.rs`); the two must stay in sync.
 */
export const MAX_TUNNEL_FRAME = 64 * 1024;

/**
 * How long a peer gets to finish sending one length-prefixed frame, counted from when we start
 * waiting for its length prefix. Bounds a "length prefix is valid and small, but the body trickles
 * in one byte every 30 seconds" (slowloris-style) connection from pinning a read forever. Mirrors
 * the Rust side's `FRAME_READ_TIMEOUT`.
 */
export const FRAME_READ_TIMEOUT_MS = 10_000;

export enum ControlClientMsgType {
    Auth = "Auth",
    Heartbeat = "Heartbeat"
}
export interface ControlClientMsgAuth {
    type: ControlClientMsgType.Auth;
    payload: {
        secret: string;
    };
}
export interface ControlClientMsgHeartbeat {
    type: ControlClientMsgType.Heartbeat
}

export type ControlClientMsg = ControlClientMsgAuth;
export enum ControlServerMsgType {
    Ack = "Ack",
    CloseTunnel = "CloseTunnel",
    RequestTunnel = "RequestTunnel",
}

export interface ControlServerMessageAck {
    type: ControlServerMsgType.Ack;
}
export interface ControlServerMessageCloseTunnel {
    type: ControlServerMsgType.CloseTunnel;
    payload: {
        reason?: string;
    };
}
export interface ControlServerMessageRequestTunnel {
    type: ControlServerMsgType.RequestTunnel;
    payload: {
        tunnel_connection_id: string;
    };
}

export type ControlServerMsg =
    | ControlServerMessageAck
    | ControlServerMessageRequestTunnel
    | ControlServerMessageCloseTunnel;

export function encodeFrame(obj: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

export async function readFrame(stream: Duplex): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(
            new Error(`timed out after ${FRAME_READ_TIMEOUT_MS}ms reading tunnel frame`),
        );
    }, FRAME_READ_TIMEOUT_MS);

    try {
        const lenBuf = await readExactly(stream, 4, controller.signal);
        const bodyLen = lenBuf.readUInt32BE(0);
        // Checked BEFORE the body read, which is what would otherwise buffer an unbounded number
        // of chunks trying to reach `bodyLen` — see `MAX_TUNNEL_FRAME`'s doc comment.
        if (bodyLen > MAX_TUNNEL_FRAME) {
            throw new Error(
                `tunnel frame length ${bodyLen} exceeds the ${MAX_TUNNEL_FRAME}-byte limit`,
            );
        }
        const body = await readExactly(stream, bodyLen, controller.signal);
        const jsonText = body.toString("utf8");
        return JSON.parse(jsonText);
    } finally {
        clearTimeout(timer);
    }
}

export async function readTypedFrame<T>(
    stream: Duplex,
    validator: (value: unknown) => value is T,
): Promise<T> {
    const value = await readFrame(stream);
    if (!validator(value)) {
        throw new Error("Invalid frame payload");
    }
    return value;
}

// Exported so a test can call it directly: with `bytes === 0`, `onReadable`'s
// `while (total < bytes)` loop body never runs (`0 < 0` is false), so without this
// special case the promise below would never settle on its own -- unlike Rust's
// `read_exact`, which returns `Ok(())` immediately for a zero-length read. In production this
// surfaces as a 0-length frame (an in-range but never-realistic length prefix) hanging for the
// full `FRAME_READ_TIMEOUT` instead of resolving at once.
export function readExactly(stream: Duplex, bytes: number, signal?: AbortSignal): Promise<Buffer> {
    if (bytes <= 0) {
        return Promise.resolve(Buffer.alloc(0));
    }

    return new Promise((resolve, reject) => {
        let chunks: Buffer[] = [];
        let total = 0;

        const cleanup = () => {
            stream.off("readable", onReadable);
            stream.off("error", onError);
            stream.off("end", onEnd);
            stream.off("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        };

        const finish = () => {
            const merged = Buffer.concat(chunks, total);
            const wanted = merged.subarray(0, bytes);
            const remaining = merged.subarray(bytes);
            if (remaining.length > 0) {
                stream.unshift(remaining);
            }
            cleanup();
            resolve(wanted);
        };

        const onReadable = () => {
            while (total < bytes) {
                const chunk = stream.read(bytes - total) as Buffer | null;
                if (!chunk) {
                    return;
                }

                chunks.push(chunk);
                total += chunk.length;

                if (total >= bytes) {
                    finish();
                    return;
                }
            }
        };

        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        const onEnd = () => {
            cleanup();
            reject(new Error("Stream ended before enough bytes were read"));
        };

        const onClose = () => {
            cleanup();
            reject(new Error("Stream closed before enough bytes were read"));
        };

        // Lets `readFrame`'s timeout actually stop this read (removing all listeners) instead of
        // just racing it: without this, a slowloris peer that never sends enough bytes leaves
        // this promise — and its listeners on `stream` — alive forever after the caller times out.
        const onAbort = () => {
            cleanup();
            reject(signal?.reason ?? new Error("aborted"));
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort);
        }

        stream.on("readable", onReadable);
        stream.on("error", onError);
        stream.on("end", onEnd);
        stream.on("close", onClose);

        onReadable();
    });
}
