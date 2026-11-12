import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { createHandler, callbackURL } from "../worker/index.js";
const origin = "https://private.example";
class D1 {
  constructor(sql) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(sql);
  }
  prepare(sql) {
    const db = this.db;
    return {
      bind(...args) {
        return {
          async all() {
            return { results: db.prepare(sql).all(...args) };
          },
          async first() {
            return db.prepare(sql).get(...args) || null;
          },
          async run() {
            const r = db.prepare(sql).run(...args);
            return { meta: { changes: r.changes } };
          },
        };
      },
    };
  }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const result = [];
      for (const s of stmts) result.push(await s.run());
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
async function setup({ fetcher } = {}) {
  const db = new D1(
      await readFile(
        new URL("../drizzle/0000_bridge.sql", import.meta.url),
        "utf8",
      ),
    ),
    pending = [];
  const calls = [];
  let failDelivery = false;
  const defaultFetch = async (url, options) => {
    calls.push({ url, options });
    const b = JSON.parse(options.body);
    return b.type === "verification"
      ? Response.json({ challenge: b.challenge })
      : new Response("", { status: failDelivery ? 503 : 202 });
  };
  const handler = createHandler(fetcher || defaultFetch),
    env = { DB: db },
    ctx = {
      waitUntil(p) {
        pending.push(p);
      },
    };
  async function req(path, method = "GET", body, owner = "owner", extra = {}) {
    const r = await handler(
      new Request(origin + path, {
        method,
        headers: {
          ...(owner ? { "oai-authenticated-user-id": owner } : {}),
          ...(method !== "GET"
            ? { "Content-Type": "application/json", Origin: origin }
            : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return { status: r.status, headers: r.headers, body: await r.json() };
  }
  const rpc = async (method, params = {}, owner = "owner") =>
    (
      await req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method, params },
        owner,
      )
    ).body;
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const subscription = {
    name: "message.created",
    arguments: { channel_id: "owner" },
    delivery: {
      mode: "webhook",
      url: "https://chatgpt.com/mcp-events/test-only",
      secret,
    },
  };
  const session = async () => (await req("/api/sessions", "POST", {})).body.id;
  const send = async (id, value = "hello") =>
    (await req("/api/sessions/" + id + "/messages", "POST", { text: value }))
      .body.id;
  return {
    db,
    req,
    rpc,
    secret,
    subscription,
    calls,
    session,
    send,
    setFailure(v) {
      failDelivery = v;
    },
  };
}
test("anonymous requests reject identity spoof-free access", async () => {
  const x = await setup();
  assert.equal(
    (await x.req("/api/status", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (
      await x.req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: 1, method: "server/discover" },
        null,
      )
    ).status,
    401,
  );
});
test("CSRF rejects cross-origin and missing-origin writes", async () => {
  const x = await setup();
  assert.equal(
    (
      await x.req("/api/sessions", "POST", {}, "owner", {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await x.req("/api/sessions", "POST", {}, "owner", { Origin: "" })).status,
    403,
  );
});
test("MCP 2 and initialize advertise events and tools", async () => {
  const x = await setup();
  for (const name of ["server/discover", "initialize"])
    assert.deepEqual((await x.rpc(name)).result.capabilities, {
      tools: {},
      events: {},
    });
  assert.equal(
    (await x.rpc("events/list")).result.events[0].name,
    "message.created",
  );
  assert.equal((await x.rpc("tools/list")).result.tools.length, 3);
});
test("arbitrary and misleading callback hosts reject before fetch", async () => {
  const x = await setup();
  for (const value of [
    "http://chatgpt.com/x",
    "https://127.0.0.1/x",
    "https://chatgpt.com.evil.example/x",
    "https://chatgpt.com:444/x",
    "https://u:p@chatgpt.com/x",
    "https://api.openai.com@evil.example/x",
    "https://example.org/x",
  ])
    assert.throws(() => callbackURL(value));
  assert.equal(x.calls.length, 0);
});
test("failed challenge stores no subscription", async () => {
  const x = await setup({
    fetcher: async () => Response.json({ challenge: "wrong" }),
  });
  assert.equal(
    (await x.rpc("events/subscribe", x.subscription)).error.code,
    -32015,
  );
  assert.equal(
    x.db.db
      .prepare("SELECT COUNT(*) n FROM bridge_subscriptions WHERE active=1")
      .get().n,
    0,
  );
});
test("subscription signatures use Standard Webhooks and refresh is idempotent", async () => {
  const x = await setup();
  const a = await x.rpc("events/subscribe", x.subscription),
    b = await x.rpc("events/subscribe", x.subscription);
  assert.equal(a.result.id, b.result.id);
  assert.equal(
    x.db.db
      .prepare("SELECT COUNT(*) n FROM bridge_subscriptions WHERE active=1")
      .get().n,
    1,
  );
  const { options } = x.calls[0],
    h = options.headers;
  const expected = createHmac(
    "sha256",
    Buffer.from(x.secret.slice(6), "base64"),
  )
    .update(h["webhook-id"] + "." + h["webhook-timestamp"] + "." + options.body)
    .digest("base64");
  assert.equal(h["webhook-signature"], "v1," + expected);
});
test("rotation signs new delivery with both keys", async () => {
  const x = await setup();
  await x.rpc("events/subscribe", x.subscription);
  await x.rpc("events/subscribe", {
    ...x.subscription,
    delivery: {
      ...x.subscription.delivery,
      secret: "whsec_" + randomBytes(32).toString("base64"),
    },
  });
  const updated = {
    ...x.subscription,
    delivery: {
      ...x.subscription.delivery,
      secret: x.db.db.prepare("SELECT secret FROM bridge_subscriptions").get()
        .secret,
    },
  };
  await x.rpc("events/subscribe", updated);
  await x.send(await x.session());
  const h = x.calls.at(-1).options.headers;
  assert.equal(h["webhook-signature"].split(" ").length, 2);
});
test("not subscribed is saved only and never replayed after subscription", async () => {
  const x = await setup(),
    s = await x.session();
  const r = await x.req("/api/sessions/" + s + "/messages", "POST", {
    text: "not yet",
  });
  assert.equal(r.body.delivery, "not_subscribed");
  await x.rpc("events/subscribe", x.subscription);
  assert.equal(
    x.db.db.prepare("SELECT COUNT(*) n FROM bridge_outbox").get().n,
    0,
  );
});
test("full simulated flow queues signed metadata, reads and replies idempotently", async () => {
  const x = await setup();
  await x.rpc("events/subscribe", x.subscription);
  const s = await x.session(),
    m = await x.send(s, "<script>test-code</script>");
  const evt = JSON.parse(x.calls.at(-1).options.body);
  assert.equal(evt.data.message_id, m);
  assert.equal(evt.data.session_id, s);
  assert.equal(evt.data.text, undefined);
  assert.equal(
    x.db.db.prepare("SELECT status FROM bridge_outbox").get().status,
    "accepted",
  );
  const read = await x.rpc("tools/call", {
    name: "bridge_read_message",
    arguments: { session_id: s, message_id: m },
  });
  assert.equal(
    read.result.structuredContent.content,
    "<script>test-code</script>",
  );
  const args = {
    session_id: s,
    message_id: m,
    text: "test-code",
    idempotency_key: "reply-once",
  };
  const first = await x.rpc("tools/call", {
      name: "bridge_reply",
      arguments: args,
    }),
    second = await x.rpc("tools/call", {
      name: "bridge_reply",
      arguments: args,
    });
  assert.equal(
    first.result.structuredContent.id,
    second.result.structuredContent.id,
  );
  assert.equal(second.result.structuredContent.duplicate, true);
  assert.equal((await x.req("/api/sessions/" + s)).body.messages.length, 2);
  assert.equal((await x.req("/api/status")).body.round_trip_verified, false);
});
test("owner isolation applies to sessions, read, reply, subscriptions", async () => {
  const x = await setup(),
    s = await x.session(),
    m = await x.send(s);
  assert.equal(
    (await x.req("/api/sessions/" + s, "GET", undefined, "other")).status,
    404,
  );
  assert.equal(
    (await x.req("/api/sessions", "GET", undefined, "other")).body.sessions
      .length,
    0,
  );
  assert.ok(
    (
      await x.rpc(
        "tools/call",
        {
          name: "bridge_read_message",
          arguments: { session_id: s, message_id: m },
        },
        "other",
      )
    ).result.isError,
  );
  assert.ok(
    (
      await x.rpc(
        "tools/call",
        {
          name: "bridge_reply",
          arguments: {
            session_id: s,
            message_id: m,
            text: "bad",
            idempotency_key: "bad",
          },
        },
        "other",
      )
    ).result.isError,
  );
  await x.rpc("events/subscribe", x.subscription);
  await x.rpc("events/unsubscribe", x.subscription, "other");
  assert.equal(
    x.db.db
      .prepare("SELECT COUNT(*) n FROM bridge_subscriptions WHERE active=1")
      .get().n,
    1,
  );
});
test("unsubscribe is idempotent and stops queued jobs", async () => {
  const x = await setup();
  await x.rpc("events/subscribe", x.subscription);
  x.setFailure(true);
  await x.send(await x.session());
  assert.equal(
    x.db.db.prepare("SELECT status FROM bridge_outbox").get().status,
    "pending",
  );
  const p = {
    ...x.subscription,
    delivery: { mode: "webhook", url: x.subscription.delivery.url },
  };
  assert.deepEqual((await x.rpc("events/unsubscribe", p)).result, {});
  assert.deepEqual((await x.rpc("events/unsubscribe", p)).result, {});
  assert.equal(
    x.db.db.prepare("SELECT status FROM bridge_outbox").get().status,
    "failed",
  );
});
test("idempotency key cannot target another message", async () => {
  const x = await setup(),
    s = await x.session(),
    m = await x.send(s),
    m2 = await x.send(s);
  await x.rpc("tools/call", {
    name: "bridge_reply",
    arguments: {
      session_id: s,
      message_id: m,
      text: "reply",
      idempotency_key: "same-key",
    },
  });
  assert.ok(
    (
      await x.rpc("tools/call", {
        name: "bridge_reply",
        arguments: {
          session_id: s,
          message_id: m2,
          text: "reply",
          idempotency_key: "same-key",
        },
      })
    ).result.isError,
  );
});
test("deletion requires explicit confirmation", async () => {
  const x = await setup(),
    s = await x.session();
  await x.send(s);
  assert.equal((await x.req("/api/sessions/" + s, "DELETE", {})).status, 400);
  assert.equal(
    (await x.req("/api/sessions/" + s, "DELETE", { confirm: true })).status,
    200,
  );
  assert.equal((await x.req("/api/sessions/" + s)).status, 404);
});
test("security headers and client rendering avoid user HTML injection", async () => {
  const x = await setup();
  const r = await x.req("/api/status");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  const src = await readFile(
    new URL("../worker/index.js", import.meta.url),
    "utf8",
  );
  assert.ok(!src.includes("innerHTML"));
  assert.ok(src.includes("body.textContent=m.content"));
});
test("unsubscribe prevents activation of an in-flight refresh", async () => {
  let release, entered;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let pause = false;
  const x = await setup({
    fetcher: async (url, options) => {
      const b = JSON.parse(options.body);
      if (pause) {
        entered();
        await gate;
      }
      return Response.json({ challenge: b.challenge });
    },
  });
  await x.rpc("events/subscribe", x.subscription);
  pause = true;
  const pending = x.rpc("events/subscribe", x.subscription);
  await started;
  await x.rpc("events/unsubscribe", {
    ...x.subscription,
    delivery: { mode: "webhook", url: x.subscription.delivery.url },
  });
  release();
  assert.equal((await pending).error.code, -32015);
  assert.equal(
    x.db.db.prepare("SELECT active FROM bridge_subscriptions").get().active,
    0,
  );
});
test("foreign keys reject late writes after session deletion and cascade replies", async () => {
  const x = await setup(),
    s = await x.session(),
    m = await x.send(s);
  await x.rpc("tools/call", {
    name: "bridge_reply",
    arguments: {
      session_id: s,
      message_id: m,
      text: "reply",
      idempotency_key: "delete-race",
    },
  });
  await x.req("/api/sessions/" + s, "DELETE", { confirm: true });
  assert.equal(
    x.db.db.prepare("SELECT COUNT(*) n FROM bridge_messages").get().n,
    0,
  );
  assert.throws(
    () =>
      x.db.db
        .prepare(
          "INSERT INTO bridge_messages (id,owner,session_id,role,content,created_at) VALUES (?,?,?,'user','late',1)",
        )
        .run(crypto.randomUUID(), "owner", s),
    /FOREIGN KEY/,
  );
});
test("event subscriptions accept standard MCP request metadata", async () => {
  const x = await setup();
  const result = await x.rpc("events/subscribe", {
    ...x.subscription,
    _meta: { progressToken: "metadata-is-not-a-filter" },
  });
  assert.ok(result.result?.id);
  assert.deepEqual(
    (await x.rpc("events/unsubscribe", { ...x.subscription, _meta: {} }))
      .result,
    {},
  );
});
