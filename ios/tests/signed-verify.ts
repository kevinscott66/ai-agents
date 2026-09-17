// Run by run.py: the server-side canonical form and ECDSA check accept what the iPhone code produces.
import { canonicalJson } from "SIGNED_ACTIONS";
const { spki, payload, signature } = JSON.parse(await Bun.stdin.text());
if (canonicalJson(JSON.parse(payload)) !== payload) throw new Error("server canonical form differs from iOS");
const key = await crypto.subtle.importKey("spki", Buffer.from(spki, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64"), new TextEncoder().encode(payload))) throw new Error("server rejected iOS signature");
console.log("PASS: server verifies iPhone SPKI key and raw P-256 signature");
