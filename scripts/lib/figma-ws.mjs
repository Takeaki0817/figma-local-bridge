// Minimal WebSocket client for the Figma Local Bridge relay (port 3055).
// Talks to the plugin directly, without the MCP server, so large payloads and
// results can be written to disk instead of flowing through a model context.

export async function connectFigma({ channel = process.env.FIGMA_CHANNEL || "figma-local-bridge", port = 3055 } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const pending = new Map();
  ws.onmessage = (e) => {
    const json = JSON.parse(e.data);
    const m = json.message;
    if (!m || !m.id || !pending.has(m.id)) return;
    if (json.type === "progress_update") return;
    if (m.result === undefined && !m.error) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(String(m.error))) : p.resolve(m.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Cannot reach the relay on port " + port));
  });
  const send = (type, command, params, timeout) => {
    const id = crypto.randomUUID();
    const req =
      type === "join"
        ? { id, type: "join", channel: params.channel, message: { id, command: "join", params: { ...params, commandId: id } } }
        : { id, type: "message", channel, message: { id, command, params: { ...params, commandId: id } } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${command} (the plugin window may be closed or another tab is active)`));
        }
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(req));
      if (type === "join") setTimeout(() => { if (pending.has(id)) { clearTimeout(timer); pending.delete(id); resolve("joined"); } }, 800);
    });
  };
  await send("join", "join", { channel }, 5000);
  return {
    call: (command, params = {}, timeout = 60000) => send("message", command, params, timeout),
    close: () => ws.close(),
  };
}
