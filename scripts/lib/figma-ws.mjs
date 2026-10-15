// Minimal WebSocket client for the Figma Local Bridge relay (port 3055).
// Talks to the plugin directly, without the MCP server, so large payloads and
// results can be written to disk instead of flowing through a model context.

export async function connectFigma({ channel = process.env.FIGMA_CHANNEL || "figma-local-bridge", port = 3055 } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const pending = new Map();
  const gathering = new Map(); // id -> every answer, for callAll
  ws.onmessage = (e) => {
    const json = JSON.parse(e.data);
    const m = json.message;
    if (m && m.id && gathering.has(m.id) && json.type !== "progress_update" && (m.result !== undefined || m.error)) gathering.get(m.id).push(m);
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
  // FIGMA_TARGET_FILE=<file name>: only the plugin running in that file answers
  const target = process.env.FIGMA_TARGET_FILE;
  const send = (type, command, params, timeout) => {
    const id = crypto.randomUUID();
    if (target && type !== "join") params = { targetFile: target, ...params };
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
  // every plugin on the channel answers a command; collect all answers for a while (used to
  // make sure exactly one plugin, in the expected file, will receive the writes)
  const callAll = async (command, params = {}, waitMs = 2500) => {
    const id = crypto.randomUUID();
    gathering.set(id, []);
    // callAll asks every plugin, whatever FIGMA_TARGET_FILE says
    ws.send(JSON.stringify({ id, type: "message", channel, message: { id, command, params: { ...params, commandId: id } } }));
    await new Promise((r) => setTimeout(r, waitMs));
    const answers = gathering.get(id);
    gathering.delete(id);
    return answers.map((m) => (m.error ? { error: String(m.error) } : m.result));
  };
  return {
    call: (command, params = {}, timeout = 60000) => send("message", command, params, timeout),
    callAll,
    close: () => ws.close(),
  };
}
