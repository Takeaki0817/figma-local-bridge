#!/usr/bin/env bun
// Compliance checker for the skill's always-on design norms.
//
// Connects to the Figma plugin over the WebSocket relay (ws://localhost:3055),
// dumps each requested root node via get_node_info, then runs six checks over
// the flattened tree and prints a human-readable report (or --json).
//
// Usage:
//   bun scripts/compliance-check.mjs --nodes <id,id,...> [--channel <ch>]
//        [--ledger <path>] [--shadows <path>] [--fixed-exceptions <path>] [--json]
//
// Env: FIGMA_CHANNEL is used when --channel is omitted.
//
// Graceful degradation: when a field a check depends on is absent from the
// dump (e.g. an old plugin build that does not pass it through), that check
// reports "⚠ データ欠落（プラグイン開き直しで有効化）" and the others continue.

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    nodes: [],
    channel: process.env.FIGMA_CHANNEL || "figma-local-bridge",
    ledger: null,
    shadows: null,
    fixedExceptions: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--nodes":
        args.nodes = (argv[++i] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--channel":
        args.channel = argv[++i];
        break;
      case "--ledger":
        args.ledger = argv[++i];
        break;
      case "--shadows":
        args.shadows = argv[++i];
        break;
      case "--fixed-exceptions":
        args.fixedExceptions = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      default:
        console.error(`unknown arg: ${a}`);
        process.exit(1);
    }
  }
  return args;
}

function readJsonOrNull(path, label) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`WARN: failed to read ${label} (${path}): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket layer (mirrors e2e-effect.mjs: pending Map, one send() per command)
// ---------------------------------------------------------------------------

function connect(channel) {
  const ws = new WebSocket("ws://localhost:3055");
  const pending = new Map();
  let joined = false;
  let onReady = null;

  function send(command, params) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${command}`));
      }, 20000);
      pending.set(id, { resolve, reject, t });
      ws.send(
        JSON.stringify({
          id,
          type: "message",
          channel,
          message: { id, command, params: { ...params, commandId: id } },
        })
      );
    });
  }

  ws.onopen = () =>
    ws.send(JSON.stringify({ id: crypto.randomUUID(), type: "join", channel }));

  ws.onerror = () => {
    if (onReady) onReady.reject(new Error("ws connection error (relay down?)"));
  };

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (
      !joined &&
      data.type === "system" &&
      typeof data.message === "string" &&
      data.message.startsWith("Joined channel")
    ) {
      joined = true;
      if (onReady) onReady.resolve();
      return;
    }
    if (data.type === "broadcast" && data.message && pending.has(data.message.id)) {
      const m = data.message;
      const p = pending.get(m.id);
      if (m.error) {
        pending.delete(m.id);
        clearTimeout(p.t);
        p.reject(
          new Error(typeof m.error === "string" ? m.error : JSON.stringify(m.error))
        );
      } else if (m.result !== undefined) {
        pending.delete(m.id);
        clearTimeout(p.t);
        p.resolve(m.result);
      }
    }
  };

  const ready = new Promise((resolve, reject) => {
    onReady = { resolve, reject };
    setTimeout(() => reject(new Error("join timeout (15s)")), 15000);
  });

  return { ws, send, ready };
}

// ---------------------------------------------------------------------------
// Tree flattening
// ---------------------------------------------------------------------------

// get_node_info returns filterFigmaNode output (possibly wrapped in {document}).
function unwrap(result) {
  if (result && result.document) return result.document;
  return result;
}

// Flatten to a list carrying parent pointer and absolute bbox for geometry.
function flatten(root) {
  const list = [];
  function walk(node, parent, depth) {
    const entry = { node, parent, depth };
    list.push(entry);
    for (const child of node.children || []) {
      walk(child, entry, depth + 1);
    }
  }
  walk(root, null, 0);
  return list;
}

function bboxOf(node) {
  const b = node.absoluteBoundingBox;
  if (!b || typeof b.x !== "number") return null;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const IN_BAND = (v) => typeof v === "number" && v >= 9.5 && v <= 10.5;

// Check 1: padding band (any side within 9.5–10.5). Prefer real padding fields,
// fall back to geometry derived from children when padding fields are absent.
function checkPaddingBand(list, ledger) {
  const ledgerIds = ledger ? new Set(collectLedgerIds(ledger)) : null;
  const active = []; // layoutMode≠NONE (padding actually renders) or geometry-derived
  const latent = []; // layoutMode===NONE: padding field lingers but has no visual effect
  let usedGeometryFallback = false;
  let anyPaddingField = false;

  for (const { node } of list) {
    const hasPaddingFields =
      node.paddingTop !== undefined ||
      node.paddingRight !== undefined ||
      node.paddingBottom !== undefined ||
      node.paddingLeft !== undefined;

    let sides = null;
    let source = null;

    if (hasPaddingFields) {
      anyPaddingField = true;
      sides = {
        L: node.paddingLeft,
        T: node.paddingTop,
        R: node.paddingRight,
        B: node.paddingBottom,
      };
      source = "field";
    } else if (node.children && node.children.length > 0) {
      const geom = derivePaddingFromChildren(node);
      if (geom) {
        sides = geom;
        source = "geometry";
        usedGeometryFallback = true;
      }
    }

    if (!sides) continue;
    const banded = ["L", "T", "R", "B"].filter((k) => IN_BAND(sides[k]));
    if (banded.length === 0) continue;
    if (ledgerIds && ledgerIds.has(node.id)) continue; // sourced padding, excused

    const hit = {
      id: node.id,
      name: node.name,
      source,
      layoutMode: node.layoutMode !== undefined ? node.layoutMode : null,
      sides: {
        L: round1(sides.L),
        T: round1(sides.T),
        R: round1(sides.R),
        B: round1(sides.B),
      },
      bandedSides: banded,
    };

    // A padding field only affects layout when layoutMode is HORIZONTAL/VERTICAL.
    // With layoutMode===NONE the value lingers but is visually inert -> latent.
    // Geometry-derived hits have no layoutMode signal but reflect real gaps ->
    // treat as active.
    if (source === "field" && hit.layoutMode === "NONE") {
      latent.push(hit);
    } else {
      active.push(hit);
    }
  }

  return {
    ok: active.length === 0,
    hits: active,
    latent,
    note: !anyPaddingField && usedGeometryFallback
      ? "padding フィールドがダンプに無く、幾何導出でフォールバック判定"
      : null,
    degraded: false,
  };
}

function derivePaddingFromChildren(node) {
  const pb = bboxOf(node);
  if (!pb) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let count = 0;
  for (const child of node.children) {
    const cb = bboxOf(child);
    if (!cb) continue;
    count++;
    minX = Math.min(minX, cb.x);
    minY = Math.min(minY, cb.y);
    maxX = Math.max(maxX, cb.x + cb.w);
    maxY = Math.max(maxY, cb.y + cb.h);
  }
  if (count === 0) return null;
  return {
    L: minX - pb.x,
    T: minY - pb.y,
    R: pb.x + pb.w - maxX,
    B: pb.y + pb.h - maxY,
  };
}

function collectLedgerIds(ledger) {
  // Accept a few shapes: array of ids, array of {nodeId}, or {ids:[...]}.
  if (Array.isArray(ledger)) {
    return ledger
      .map((e) => (typeof e === "string" ? e : e && (e.nodeId || e.id)))
      .filter(Boolean);
  }
  if (ledger && Array.isArray(ledger.ids)) return ledger.ids;
  if (ledger && Array.isArray(ledger.entries)) {
    return ledger.entries.map((e) => e.nodeId || e.id).filter(Boolean);
  }
  return [];
}

// Check 2: unsupported FIXED sizing. Frames whose layoutSizing is FIXED, minus
// the root node and any ids in --fixed-exceptions.
function checkUnjustifiedFixed(list, rootId, fixedExceptions) {
  const anySizingField = list.some(
    ({ node }) =>
      node.layoutSizingHorizontal !== undefined ||
      node.layoutSizingVertical !== undefined
  );
  if (!anySizingField) {
    return { degraded: true, hits: [], ok: null };
  }
  const excepted = new Set([rootId, ...(fixedExceptions || [])]);
  const hits = [];
  for (const { node } of list) {
    const isFrameLike =
      node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "INSTANCE";
    if (!isFrameLike) continue;
    if (excepted.has(node.id)) continue;
    const h = node.layoutSizingHorizontal;
    const v = node.layoutSizingVertical;
    if (h === "FIXED" || v === "FIXED") {
      hits.push({
        id: node.id,
        name: node.name,
        horizontal: h,
        vertical: v,
        layoutMode: node.layoutMode !== undefined ? node.layoutMode : null,
      });
    }
  }
  return { degraded: false, hits, ok: hits.length === 0 };
}

// Check 3: effects. With --shadows, diff against the reference list to find
// missing shadows. Without it, just list nodes that carry effects.
function checkEffects(list, shadows) {
  const withEffects = list
    .filter(({ node }) => Array.isArray(node.effects) && node.effects.length > 0)
    .map(({ node }) => ({
      id: node.id,
      name: node.name,
      effects: node.effects.map((e) => e.type),
    }));

  if (!shadows) {
    return {
      mode: "inventory",
      ok: null,
      withEffects,
      missing: [],
    };
  }

  const refs = Array.isArray(shadows) ? shadows : shadows.entries || [];
  const missing = [];
  for (const ref of refs) {
    const matched = list.some(({ node }) => {
      if (ref.nodeId && node.id !== ref.nodeId) return false;
      if (ref.namePattern) {
        let re;
        try {
          re = new RegExp(ref.namePattern);
        } catch {
          re = null;
        }
        if (re && !re.test(node.name || "")) return false;
        if (!re && node.name !== ref.namePattern) return false;
      }
      return Array.isArray(node.effects) && node.effects.length > 0;
    });
    if (!matched) {
      missing.push(ref);
    }
  }
  return {
    mode: "diff",
    ok: missing.length === 0,
    withEffects,
    missing,
  };
}

// Check 4: shadow clipping. An effect-bearing node whose ancestor chain has a
// clipsContent=true frame will have its shadow clipped.
function checkShadowClipping(list) {
  const anyClipField = list.some(({ node }) => node.clipsContent !== undefined);
  if (!anyClipField) {
    // Can still evaluate effects, but clipping status is unknown.
    const hasEffectNodes = list.some(
      ({ node }) => Array.isArray(node.effects) && node.effects.length > 0
    );
    if (hasEffectNodes) {
      return { degraded: true, hits: [], ok: null };
    }
  }
  const hits = [];
  for (const entry of list) {
    const node = entry.node;
    if (!(Array.isArray(node.effects) && node.effects.length > 0)) continue;
    const hasShadow = node.effects.some(
      (e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"
    );
    if (!hasShadow) continue;
    // Walk ancestors.
    let p = entry.parent;
    const clippers = [];
    while (p) {
      if (p.node.clipsContent === true) {
        clippers.push({ id: p.node.id, name: p.node.name });
      }
      p = p.parent;
    }
    if (clippers.length > 0) {
      hits.push({ id: node.id, name: node.name, clippedBy: clippers });
    }
  }
  return { degraded: false, hits, ok: hits.length === 0 };
}

// Check 5: Variables. Count nodes with boundVariables, and count nodes whose
// fills are hardcoded (SOLID with no variable binding).
function checkVariables(list) {
  const anyBoundField = list.some(({ node }) => node.boundVariables !== undefined);
  let boundCount = 0;
  const boundNodes = [];
  let hardcodedFillCount = 0;
  const hardcodedFillNodes = [];

  for (const { node } of list) {
    const bv = node.boundVariables;
    if (bv && typeof bv === "object" && Object.keys(bv).length > 0) {
      boundCount++;
      boundNodes.push({ id: node.id, name: node.name, keys: Object.keys(bv) });
    }
    // Hardcoded fill: a SOLID fill present, and no node-level fill binding.
    if (Array.isArray(node.fills) && node.fills.length > 0) {
      const hasSolid = node.fills.some((f) => f && f.type === "SOLID");
      const fillBound = bv && (bv.fills || bv.fill);
      if (hasSolid && !fillBound) {
        hardcodedFillCount++;
        hardcodedFillNodes.push({ id: node.id, name: node.name });
      }
    }
  }
  return {
    degraded: !anyBoundField,
    boundCount,
    boundNodes,
    hardcodedFillCount,
    hardcodedFillNodes,
  };
}

// Check 6: default names matching /^(Frame|Rectangle|Text|Ellipse|Line)\s*\d*$/.
function checkDefaultNames(list) {
  const re = /^(Frame|Rectangle|Text|Ellipse|Line)\s*\d*$/;
  const hits = [];
  for (const { node } of list) {
    if (re.test(node.name || "")) {
      hits.push({ id: node.id, name: node.name, type: node.type });
    }
  }
  return { ok: hits.length === 0, hits };
}

function round1(v) {
  return typeof v === "number" ? Math.round(v * 10) / 10 : v;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function mark(ok) {
  if (ok === null) return "⚠";
  return ok ? "○" : "×";
}

function renderHuman(perNode) {
  const lines = [];
  for (const nodeReport of perNode) {
    const { rootId, rootName, error, checks } = nodeReport;
    lines.push("=".repeat(70));
    lines.push(`ROOT ${rootId}  ${rootName || ""}`);
    lines.push("=".repeat(70));
    if (error) {
      lines.push(`  ダンプ取得失敗: ${error}`);
      lines.push("");
      continue;
    }

    // 1. padding — 有効(layoutMode≠NONE)で○×判定、潜在(layoutMode=NONE)は参考件数
    const p = checks.padding;
    const latentCount = (p.latent || []).length;
    lines.push(
      `[1] padding帯(9.5-10.5px)  ${mark(p.ok)}  有効 ${p.hits.length} 件 / 潜在(layoutMode=NONE) ${latentCount} 件${
        p.note ? "  (" + p.note + ")" : ""
      }`
    );
    for (const h of p.hits) {
      lines.push(
        `      - ${h.id}  ${h.name}  L${h.sides.L}/T${h.sides.T}/R${h.sides.R}/B${h.sides.B}  [${h.bandedSides.join(",")}] (${h.source}, layout:${h.layoutMode ?? "?"})`
      );
    }
    if (latentCount > 0) {
      lines.push(`      -- 潜在(視覚無影響・参考): ${latentCount} 件（--json に一覧）`);
    }

    // 2. FIXED — layoutMode を併記して妥当性レビューを容易に
    const f = checks.fixed;
    if (f.degraded) {
      lines.push(
        `[2] 根拠なきFIXED          ⚠  データ欠落（プラグイン開き直しで有効化）`
      );
    } else {
      lines.push(`[2] 根拠なきFIXED          ${mark(f.ok)}  該当 ${f.hits.length} 件`);
      for (const h of f.hits) {
        lines.push(
          `      - ${h.id}  ${h.name}  H:${h.horizontal} V:${h.vertical}  (layout:${h.layoutMode ?? "?"})`
        );
      }
    }

    // 3. effects
    const e = checks.effects;
    if (e.mode === "inventory") {
      lines.push(
        `[3] effects(在庫)          -  effects保有 ${e.withEffects.length} 件（参照リスト未指定）`
      );
      for (const w of e.withEffects) {
        lines.push(`      - ${w.id}  ${w.name}  [${w.effects.join(",")}]`);
      }
    } else {
      lines.push(
        `[3] effects(突合)          ${mark(e.ok)}  欠落 ${e.missing.length} 件 / 保有 ${e.withEffects.length} 件`
      );
      for (const m of e.missing) {
        lines.push(
          `      - MISSING ${m.nodeId || m.namePattern || JSON.stringify(m)}`
        );
      }
    }

    // 4. shadow clipping
    const c = checks.clipping;
    if (c.degraded) {
      lines.push(
        `[4] 影のクリップ           ⚠  データ欠落（プラグイン開き直しで有効化）`
      );
    } else {
      lines.push(`[4] 影のクリップ           ${mark(c.ok)}  警告 ${c.hits.length} 件`);
      for (const h of c.hits) {
        lines.push(
          `      - ${h.id}  ${h.name}  ← clip親: ${h.clippedBy.map((x) => x.name).join(", ")}`
        );
      }
    }

    // 5. Variables
    const v = checks.variables;
    if (v.degraded) {
      lines.push(
        `[5] Variables              ⚠  boundVariables 欠落（プラグイン開き直しで有効化）  ハードコードfill ${v.hardcodedFillCount} 件`
      );
    } else {
      lines.push(
        `[5] Variables              -  バインド ${v.boundCount} 件 / ハードコードfill ${v.hardcodedFillCount} 件`
      );
    }

    // 6. default names
    const n = checks.defaultNames;
    lines.push(`[6] 既定名                 ${mark(n.ok)}  該当 ${n.hits.length} 件`);
    for (const h of n.hits.slice(0, 50)) {
      lines.push(`      - ${h.id}  "${h.name}"  (${h.type})`);
    }
    if (n.hits.length > 50) lines.push(`      ... 他 ${n.hits.length - 50} 件`);

    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.nodes.length === 0) {
    console.error(
      "usage: bun scripts/compliance-check.mjs --nodes <id,id,...> [--channel <ch>] [--ledger <path>] [--shadows <path>] [--fixed-exceptions <path>] [--json]"
    );
    process.exit(1);
  }

  const ledger = readJsonOrNull(args.ledger, "ledger");
  const shadows = readJsonOrNull(args.shadows, "shadows");
  const fixedExceptionsRaw = readJsonOrNull(args.fixedExceptions, "fixed-exceptions");
  const fixedExceptions = Array.isArray(fixedExceptionsRaw)
    ? fixedExceptionsRaw.map((e) => (typeof e === "string" ? e : e.nodeId || e.id))
    : fixedExceptionsRaw && Array.isArray(fixedExceptionsRaw.ids)
      ? fixedExceptionsRaw.ids
      : [];

  const conn = connect(args.channel);
  try {
    await conn.ready;
  } catch (e) {
    console.error(`接続失敗: ${e.message}`);
    console.error("WebSocket relay (bun socket) とプラグインの起動・チャンネル参加を確認してください。");
    process.exit(2);
  }

  const perNode = [];
  for (const nodeId of args.nodes) {
    try {
      const raw = await conn.send("get_node_info", { nodeId });
      const root = unwrap(raw);
      if (!root || !root.id) {
        perNode.push({ rootId: nodeId, error: "empty/invalid dump" });
        continue;
      }
      const list = flatten(root);
      perNode.push({
        rootId: root.id,
        rootName: root.name,
        nodeCount: list.length,
        checks: {
          padding: checkPaddingBand(list, ledger),
          fixed: checkUnjustifiedFixed(list, root.id, fixedExceptions),
          effects: checkEffects(list, shadows),
          clipping: checkShadowClipping(list),
          variables: checkVariables(list),
          defaultNames: checkDefaultNames(list),
        },
      });
    } catch (e) {
      perNode.push({ rootId: nodeId, error: e.message });
    }
  }

  conn.ws.close();

  if (args.json) {
    console.log(JSON.stringify({ channel: args.channel, perNode }, null, 2));
  } else {
    console.log(renderHuman(perNode));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
