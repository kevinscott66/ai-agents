import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function authNonce(): string { return randomBytes(32).toString("hex"); }
export function validAuthNonce(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function authProof(secret: string, role: "server" | "client" | "accepted", clientNonce: string, serverNonce: string): string {
  return createHmac("sha256", secret).update(`mac-bridge-v2:${role}:${clientNonce}:${serverNonce}`).digest("hex");
}
export function verifyAuthProof(secret: string, role: "server" | "client" | "accepted", clientNonce: string, serverNonce: string, proof: unknown): boolean {
  if (!validAuthNonce(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(authProof(secret, role, clientNonce, serverNonce), "hex"));
}


/** Authenticate every server command, including its connection and order, against active relays. */
export function signedFrame(secret: string, direction: "server" | "client", clientNonce: string, serverNonce: string, sequence: number, body: string) {
  const mac = createHmac("sha256", secret).update(`mac-bridge-v2:frame:${direction}:${clientNonce}:${serverNonce}:${sequence}:${body}`).digest("hex");
  return {type: "signed", sequence, body, mac};
}

export function signedServerFrame(secret: string, clientNonce: string, serverNonce: string, sequence: number, body: string) {
  return signedFrame(secret, "server", clientNonce, serverNonce, sequence, body);
}
export function verifySignedFrame(secret: string, direction: "server" | "client", clientNonce: string, serverNonce: string, sequence: number, frame: any): string | null {
  if (!frame || frame.type !== "signed" || !Number.isSafeInteger(frame.sequence) || frame.sequence !== sequence || typeof frame.body !== "string" || !validAuthNonce(frame.mac)) return null;
  const expected = signedFrame(secret, direction, clientNonce, serverNonce, sequence, frame.body).mac;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(frame.mac, "hex")) ? frame.body : null;
}

/** One per connection. Never disclose the shared secret or fall back to legacy auth. */
export function createDaemonHandshake(secret: string) {
  const clientNonce = authNonce();
  let serverNonce: string | undefined;
  let complete = false;
  let receivedSequence = 0;
  let sentSequence = 0;
  return {
    hello: { type: "auth_hello", clientNonce },
    challenge(msg: { serverNonce: string; proof: string }) {
      if (serverNonce || complete || !validAuthNonce(msg.serverNonce) || !verifyAuthProof(secret, "server", clientNonce, msg.serverNonce, msg.proof)) return null;
      serverNonce = msg.serverNonce;
      return { type: "auth_proof", proof: authProof(secret, "client", clientNonce, serverNonce) };
    },
    unwrap(raw: unknown): string | null {
      if (!complete || !serverNonce) return null;
      let frame: any;
      try { frame = JSON.parse(String(raw)); } catch { return null; }
      const body = verifySignedFrame(secret, "server", clientNonce, serverNonce, receivedSequence + 1, frame);
      if (body === null) return null;
      receivedSequence++;
      return body;
    },
    wrap(body: string) {
      if (!complete || !serverNonce) return null;
      return signedFrame(secret, "client", clientNonce, serverNonce, ++sentSequence, body);
    },
    accept(proof: unknown): boolean {
      if (complete || !serverNonce || !verifyAuthProof(secret, "accepted", clientNonce, serverNonce, proof)) return false;
      complete = true;
      return true;
    },
  };
}
