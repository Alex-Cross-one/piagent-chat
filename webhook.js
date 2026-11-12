import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";
export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
// Resolve on every connection and pin the validated address; never follow redirects.
export async function safePost(url, body, headers) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw Error("Invalid callback URL");
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Error("Non-public callback address");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        servername: u.hostname,
        lookup: (_host, opts, cb) =>
          opts.all
            ? cb(null, [address])
            : cb(null, address.address, address.family),
        timeout: 10000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
          if (Buffer.byteLength(raw) > 65536)
            req.destroy(Error("Response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    req.on("timeout", () => req.destroy(Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
export async function signedPost(sub, payload, id, post = safePost) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 262144) throw Error("Payload too large");
  const now = new Date();
  const signatures = [
    sub.secret,
    ...(sub.oldSecret && sub.rotationUntil > Date.now() ? [sub.oldSecret] : []),
  ]
    .map((secret) => new Webhook(secret).sign(id, now, body))
    .join(" ");
  return post(sub.url, body, {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
    "webhook-signature": signatures,
    "X-MCP-Subscription-Id": sub.id,
  });
}
