import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { createApp } from "../server.js";
import { publicAddress, safePost } from "../webhook.js";
test("callback network protections reject private, special, credentialed and non-HTTPS URLs", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
    "224.0.0.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  await assert.rejects(safePost("http://example.com", "{}", {}));
  await assert.rejects(safePost("https://u:p@example.com", "{}", {}));
  await assert.rejects(safePost("https://127.0.0.1", "{}", {}));
});
test("MCP subscription lifecycle and authenticated external-message/read/reply loop", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bridge-"));
  const secret = "whsec_" + randomBytes(32).toString("base64"),
    deliveries = [];
  let fakeNow = Date.now(),
    callbackStatus = 503,
    verificationBad = false;
  const options = {
    dataDir,
    token: "owner-test-password-1234567890",
    mode: "bridge",
    agentFactory: () => {
      throw Error("Must never substitute another model");
    },
    bridgeOptions: {
      now: () => fakeNow,
      verifyToken: async (token) => {
        if (token !== "mcp-owner-token") throw Error("unauthorized");
        return "owner-subject";
      },
      post: async (url, body, headers) => {
        assert.equal(url, "https://callback.example/events");
        new Webhook(secret).verify(body, headers);
        const b = JSON.parse(body);
        if (b.type === "verification")
          return {
            status: 200,
            body: JSON.stringify({
              challenge: verificationBad ? "wrong" : b.challenge,
            }),
          };
        deliveries.push(b);
        return { status: callbackStatus, body: "{}" };
      },
    },
  };
  let app = createApp(options),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  let base = `http://127.0.0.1:${server.address().port}`,
    cookie = "";
  const request = (path, body, headers = {}) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  let sequence = 0;
  const rpc = async (method, params = {}) =>
    await (
      await request(
        "/mcp",
        { jsonrpc: "2.0", id: ++sequence, method, params },
        { authorization: "Bearer mcp-owner-token" },
      )
    ).json();
  const subscription = {
    name: "message.created",
    arguments: { channel_id: "owner" },
    delivery: {
      mode: "webhook",
      url: "https://callback.example/events",
      secret,
    },
  };
  try {
    assert.equal(
      (await request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }))
        .status,
      401,
    );
    assert.equal(
      (await rpc("initialize")).result.capabilities.events.constructor,
      Object,
    );
    assert.equal(
      (await rpc("events/list")).result.events[0].name,
      "message.created",
    );
    assert.equal((await rpc("tools/list")).result.tools.length, 2);
    assert.equal(
      (
        await rpc("events/subscribe", {
          ...subscription,
          arguments: { channel_id: "other" },
        })
      ).error.code,
      -32602,
    );
    verificationBad = true;
    assert.equal(
      (await rpc("events/subscribe", subscription)).error.code,
      -32015,
    );
    verificationBad = false;
    const sub = await rpc("events/subscribe", subscription);
    assert.ok(sub.result.id);
    assert.equal(
      (await rpc("events/subscribe", subscription)).result.id,
      sub.result.id,
    );
    const login = await request("/api/login", { token: options.token });
    cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await (await request("/api/sessions", {})).json();
    const result = await (
      await request("/api/sessions/" + session.id + "/messages", {
        message: "只回复测试码 123",
      })
    ).text();
    assert.match(result, /bridge_status/);
    await app.locals.bridge.drain();
    assert.equal(deliveries.length, 1);
    const evt = deliveries[0];
    assert.deepEqual(Object.keys(evt.data).sort(), [
      "channel_id",
      "message_id",
      "session_id",
    ]);
    assert.ok(!JSON.stringify(evt).includes("只回复"));
    callbackStatus = 200;
    fakeNow += 20000;
    await app.locals.bridge.drain();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].eventId, evt.eventId);
    const read = await rpc("tools/call", {
      name: "bridge_read_message",
      arguments: { session_id: session.id, message_id: evt.data.message_id },
    });
    assert.equal(
      read.result.structuredContent.message.content,
      "只回复测试码 123",
    );
    const reply = {
      name: "bridge_reply",
      arguments: {
        session_id: session.id,
        message_id: evt.data.message_id,
        text: "测试码 123",
        idempotency_key: "reply-key-123",
      },
    };
    assert.equal(
      (await rpc("tools/call", reply)).result.structuredContent.duplicate,
      false,
    );
    assert.equal(
      (await rpc("tools/call", reply)).result.structuredContent.duplicate,
      true,
    );
    const saved = await (await request("/api/sessions/" + session.id)).json();
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].source, "dot-bridge");
    assert.equal((await app.locals.bridge.status()).status, "reply_received");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app = createApp(options);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await app.locals.bridge.status()).subscriptionCount, 1);
    assert.ok((await app.locals.bridge.status()).lastReplyAt);
    assert.deepEqual(
      (await rpc("events/unsubscribe", subscription)).result,
      {},
    );
    assert.deepEqual(
      (await rpc("events/unsubscribe", subscription)).result,
      {},
    );
    assert.equal((await app.locals.bridge.status()).subscriptionCount, 0);
    const queued = await app.locals.bridge.queue(session.id, "unsubscribed");
    assert.equal(queued.status, "unsubscribed");
    await app.locals.bridge.drain();
    assert.equal(deliveries.length, 2);
    assert.ok(
      (await readFile(join(dataDir, "bridge-state.dat"), "utf8")).includes(
        "unsubscribed",
      ) === false,
    );
    await rpc("events/subscribe", { ...subscription, ttlMs: 100 });
    fakeNow += 200;
    assert.equal((await app.locals.bridge.status()).subscriptionCount, 0);
    await app.locals.bridge.queue(session.id, "expired");
    await app.locals.bridge.drain();
    assert.equal(deliveries.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  }
});
