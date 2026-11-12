const $ = (id) => document.getElementById(id);
let current = null,
  history = [],
  busy = false,
  mode = "bridge",
  refreshing = false;
async function api(url, method = "GET", body) {
  const r = await fetch("/api" + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    $("login").hidden = false;
    $("workspace").hidden = true;
  }
  if (!r.ok) {
    const j = await r.json();
    throw Error(j.error || "请求失败");
  }
  return r;
}
const text = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content || [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("");
function message(role, content, source) {
  const el = document.createElement("article");
  el.className = "message " + role;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent =
    role === "user"
      ? "你"
      : source === "dot-bridge"
        ? "● dot · 桥接回信"
        : "pi 模型 · 独立对话";
  const p = document.createElement("div");
  p.className = "content";
  p.textContent = content;
  el.append(label, p);
  $("messages").append(el);
  return p;
}
function bottom() {
  $("messages").scrollTop = $("messages").scrollHeight;
}
function status(s) {
  $("notice").textContent = s;
}
async function refresh() {
  const list = await (await api("/sessions")).json();
  $("sessions").replaceChildren();
  for (const s of list) {
    const b = document.createElement("button");
    b.textContent = s.title;
    b.classList.toggle("selected", s.id === current);
    b.onclick = () => open(s.id);
    $("sessions").append(b);
  }
}
async function open(id) {
  if (busy) return;
  try {
    const s = await (await api("/sessions/" + id)).json();
    current = id;
    history = s.messages;
    $("title").textContent = s.title;
    $("messages").replaceChildren();
    for (const m of history)
      if (["user", "assistant"].includes(m.role))
        message(m.role, text(m), m.source);
    $("sidebar").classList.remove("open");
    await refresh();
    bottom();
  } catch (e) {
    status(e.message);
  }
}
async function start() {
  const c = await (await api("/config")).json();
  mode = c.mode;
  $("model").textContent =
    mode === "bridge" ? "dot · MCP bridge" : c.provider + " / " + c.model;
  $("login").hidden = true;
  $("workspace").hidden = false;
  if (mode === "standalone")
    $("bridge-state").textContent =
      "独立 pi 模型模式，不是 ChatGPT 中的 dot，不同步记忆或会话。";
  if (!c.configured)
    status("服务端尚未配置模型 API key。界面已就绪，配置后即可开始对话。");
  await refresh();
}
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/login", "POST", { token: $("token").value });
    $("token").value = "";
    await start();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
};
$("new-chat").onclick = async () => {
  if (busy) return;
  try {
    const s = await (await api("/sessions", "POST")).json();
    await open(s.id);
    $("prompt").focus();
  } catch (e) {
    status(e.message);
  }
};
$("menu").onclick = () => $("sidebar").classList.toggle("open");
$("logout").onclick = async () => {
  if (busy) return;
  await api("/logout", "POST");
  location.reload();
};
$("delete").onclick = async () => {
  if (!current || busy || !confirm("删除此对话？删除后无法从此应用恢复。"))
    return;
  try {
    await api("/sessions/" + current, "DELETE");
    location.reload();
  } catch (e) {
    status(e.message);
  }
};
$("export").onclick = () => {
  if (!current) return;
  const blob = new Blob([JSON.stringify({ messages: history }, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "dot-conversation.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("stop").onclick = () =>
  api("/sessions/" + current + "/stop", "POST").catch((e) => status(e.message));
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
};
document.querySelectorAll(".suggestions button").forEach(
  (b) =>
    (b.onclick = () => {
      $("prompt").value = b.textContent;
      $("prompt").focus();
    }),
);
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("prompt").value.trim();
  if (!input || busy) return;
  busy = true;
  $("send").hidden = true;
  $("stop").hidden = false;
  $("prompt").disabled = true;
  status("");
  let p;
  try {
    if (!current) {
      const s = await (await api("/sessions", "POST")).json();
      current = s.id;
    }
    $("welcome")?.remove();
    message("user", input);
    p = mode === "bridge" ? null : message("assistant", "");
    $("prompt").value = "";
    bottom();
    const r = await api("/sessions/" + current + "/messages", "POST", {
        message: input,
      }),
      reader = r.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const kind = event.match(/^event: (.+)$/m)?.[1],
          data = event.match(/^data: (.+)$/m)?.[1];
        if (!data) continue;
        const d = JSON.parse(data);
        if (kind === "bridge_status")
          status(
            d.status === "unsubscribed"
              ? "消息已保存在此服务器，但尚无 dot 订阅，未发送给 dot。连接后请重新发送。"
              : "消息已排队发送给 dot，正在等待异步回复。",
          );
        if (kind === "delta" && p) {
          p.textContent += d.text;
          bottom();
        }
        if (kind === "error") status(d.message);
      }
    }
    const s = await (await api("/sessions/" + current)).json();
    history = s.messages;
    $("title").textContent = s.title;
    await refresh();
  } catch (err) {
    status(err.message);
    if (p && !p.textContent) p.textContent = "未能完成回答。请检查提示后重试。";
    $("prompt").value = input;
  } finally {
    busy = false;
    $("send").hidden = false;
    $("stop").hidden = true;
    $("prompt").disabled = false;
    $("prompt").focus();
  }
};
start().catch(() => {});

setInterval(async () => {
  if (
    mode !== "bridge" ||
    busy ||
    refreshing ||
    $("workspace").hidden ||
    document.hidden
  )
    return;
  refreshing = true;
  try {
    const b = await (await api("/bridge/status")).json();
    $("bridge-state").textContent =
      b.status === "reply_received"
        ? "桥接已收到回信。请核对回复来自你绑定的同一个 dot。"
        : b.status === "subscribed_unverified"
          ? "已订阅，尚未收到验证回信；暂不能确认已接通当前 dot。"
          : "桥接尚未连接：需配置 OAuth、安装插件并在当前 dot 订阅。";
    if (b.failed)
      status("有消息未送达，可能订阅过期或回调失败。检查连接后请重新发送。");
    if (current) {
      const requested = current;
      const s = await (await api("/sessions/" + requested)).json();
      if (requested !== current) return;
      if (JSON.stringify(s.messages) !== JSON.stringify(history)) {
        history = s.messages;
        $("messages").replaceChildren();
        for (const m of history)
          if (["user", "assistant"].includes(m.role))
            message(m.role, text(m), m.source);
        bottom();
      }
    }
  } catch (e) {
    status(e.message);
  } finally {
    refreshing = false;
  }
}, 2500);
