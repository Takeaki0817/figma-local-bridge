#!/usr/bin/env node
// Compliance check: the completion gate of the talk-to-figma-design skill.
//
// Reads the real layout properties of the current file through the plugin's dump_tree
// command (padding, sizing, effects, bindings, text styles and the source notes that
// figma-build.mjs records on each node) and runs these checks:
//
//   padding10      an auto-layout padding of 9.5-10.5px on any side (the old default value)
//   unsourcedFixed a FIXED width/height with no recorded source (CSS class, table, image...)
//   fillLeak       a child that spans its auto-layout parent's inner width but is not FILL
//   fillInHug      FILL on an axis the parent hugs, with no sibling that sets the size
//   shadowClip     a drop shadow cut off by a clipping ancestor
//   unboundColor   a solid fill or stroke not bound to a color variable
//   noTextStyle    a text layer without a text style (mixed text needs one on every part)
//   defaultName    a Figma default layer name (Frame 1, Rectangle 2, ...)
//   height         a screen frame whose height differs from the page it reproduces (beyond
//                  a recorded growth for taller Figma text)
//
// Usage:
//   node scripts/compliance-check.mjs [--roots id,id] [--manifest manifest.json] [--json]
// Without --roots it checks every top-level frame on the current page.
// With --manifest it also checks screen heights and the component masters.
// Instance internals are checked once, on their main component.
// Exit code 1 when any check fails.

import { readFile } from "node:fs/promises";
import { connectFigma } from "./lib/figma-ws.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes("--json");
const manifestPath = arg("manifest");
const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const DEFAULT_NAME = /^(Frame|Rectangle|Text|Ellipse|Line|Group|Vector|Component|Instance|Polygon|Star)\s*\d*$/;
const EPS = 0.75;

function walk(node, parent, fn, ancestors = []) {
  fn(node, parent, ancestors);
  if (node.type === "INSTANCE") return; // checked on the main component
  for (const c of node.children || []) walk(c, node, fn, [...ancestors, node]);
}

function checkRoot(root, expectHeight) {
  const hits = {
    padding10: [], unsourcedFixed: [], fillLeak: [], fillInHug: [], shadowClip: [],
    unboundColor: [], noTextStyle: [], defaultName: [], height: [],
  };
  const ref = (n) => ({ id: n.id, name: n.name });
  walk(root, null, (n, parent, ancestors) => {
    const auto = parent && parent.layoutMode && parent.layoutMode !== "NONE";
    if (n.padding && n.padding.some((p) => p >= 9.5 && p <= 10.5) && !n.sourcePad) hits.padding10.push({ ...ref(n), padding: n.padding });
    if (n.sizing && n !== root) {
      const [h, v] = n.sizing;
      const intrinsic = n.type === "RECTANGLE" || n.type === "VECTOR" || (n.name || "").startsWith("icon/");
      if (h === "FIXED" && !n.sourceW && !intrinsic && n.type !== "TEXT") hits.unsourcedFixed.push({ ...ref(n), axis: "width", w: n.w });
      if (v === "FIXED" && !n.sourceH && !intrinsic && n.type !== "TEXT") hits.unsourcedFixed.push({ ...ref(n), axis: "height", h: n.h });
      if (auto && n.positioning !== "ABSOLUTE") {
        const inner = parent.w - parent.padding[1] - parent.padding[3];
        const vertical = parent.layoutMode === "VERTICAL";
        // a hugging parent takes its width from a hugging child: that child is not a leak
        const sizesParent = (parent.sizing || [])[0] === "HUG" && h === "HUG";
        if (vertical && Math.abs(n.w - inner) <= EPS && h !== "FILL" && !n.sourceW && !intrinsic && !sizesParent) hits.fillLeak.push({ ...ref(n), w: n.w, inner });
        const parentSizing = parent.sizing || ["FIXED", "FIXED"];
        for (const [axis, i] of [["w", 0], ["h", 1]]) {
          if (n.sizing[i] !== "FILL" || parentSizing[i] !== "HUG") continue;
          const mainAxis = parent.layoutMode === "HORIZONTAL" ? 0 : 1;
          const siblings = (parent.children || []).filter((k) => k !== n && k.positioning !== "ABSOLUTE");
          const sizedSibling = siblings.some((k) => k.sizing && k.sizing[i] !== "FILL");
          if (i !== mainAxis && !sizedSibling) hits.fillInHug.push({ ...ref(n), axis });
        }
      }
    }
    if (n.effects && n.effects.some((e) => e.type === "DROP_SHADOW")) {
      // only drop shadows reach outside the box; inner shadows stay inside it
      const reach = Math.max(...n.effects.filter((e) => e.type === "DROP_SHADOW").map((e) => e.radius + Math.abs(e.spread || 0) + Math.max(Math.abs((e.offset || {}).x || 0), Math.abs((e.offset || {}).y || 0))));
      // absolute position of n inside each ancestor
      let x = n.x, y = n.y;
      for (let k = ancestors.length - 1; k >= 0; k--) {
        const a = ancestors[k];
        if (a !== root && a.clipsContent) {
          const left = x, top = y, right = a.w - (x + n.w), bottom = a.h - (y + n.h);
          if (Math.min(left, top, right, bottom) < reach - 0.5) hits.shadowClip.push({ ...ref(n), clippedBy: a.name, clippedById: a.id });
          break;
        }
        x += a.x;
        y += a.y;
      }
    }
    for (const [kind, paints] of [["fill", n.fills], ["stroke", n.strokes]]) {
      for (const p of paints || []) {
        if (p.type && p.type !== "SOLID") continue;
        if (p.color && p.color.length === 9 && p.color.endsWith("00")) continue; // fully transparent
        // a color equal to a variable's value but not bound to it (forgotten binding)
        if (!p.bound && variableHex.has(String(p.color).slice(0, 7).toLowerCase()) && !(n.name || "").startsWith("icon/")) hits.unboundColor.push({ ...ref(n), kind, color: p.color });
      }
    }
    if (n.type === "TEXT" && (!n.textStyleId || (n.textStyleId === "mixed" && !n.textStyleAllRanges))) hits.noTextStyle.push(ref(n));
    if (DEFAULT_NAME.test(n.name || "")) hits.defaultName.push({ ...ref(n), type: n.type });
  });
  // vector children inside icons carry their own paints; ignore them
  hits.unboundColor = hits.unboundColor.filter((h) => !/^(Vector|path|line|rect|circle|polyline)/i.test(h.name || ""));
  hits.defaultName = hits.defaultName.filter((h) => h.type !== "VECTOR");
  // a frame grown because Figma's text is taller (whole-pixel line heights or a later Japanese
  // line break; the reason is recorded on the frame) is allowed up to 3% of the page height
  const grown = /text is taller|rounds text heights/.test(root.sourceH || "") && root.h > expectHeight && root.h - expectHeight <= expectHeight * 0.03;
  if (expectHeight !== undefined && Math.abs(root.h - expectHeight) > 1 && !grown) hits.height.push({ ...ref(root), h: root.h, expected: expectHeight });
  return hits;
}

const figma = await connectFigma();
const reports = [];
const variableHex = new Set();
try {
  const vars = await figma.call("get_variables", {}, 60000).catch(() => null);
  for (const v of (vars && vars.variables) || []) {
    for (const val of Object.values(v.valuesByMode || {})) {
      if (val && typeof val === "object" && "r" in val && (val.a === undefined || val.a === 1)) {
        variableHex.add("#" + [val.r, val.g, val.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join(""));
      }
    }
  }
  const page = await figma.call("dump_tree", { maxDepth: 1 }, 120000);
  let roots = (arg("roots", "") || "").split(",").filter(Boolean);
  const expected = {};
  if (!roots.length && manifest) {
    for (const s of Object.values(manifest.screens)) {
      roots.push(s.id);
      expected[s.id] = s.docHeight;
    }
    for (const set of Object.values(manifest.components || {})) roots.push(set.id);
  }
  if (!roots.length) roots = (page.children || []).map((c) => c.id);
  for (const id of roots) {
    const tree = await figma.call("dump_tree", { nodeId: id, maxDepth: 60 }, 180000);
    reports.push({ id, name: tree.name, hits: checkRoot(tree, expected[id]) });
  }
} finally {
  figma.close();
}

const totals = {};
for (const r of reports) for (const [k, v] of Object.entries(r.hits)) totals[k] = (totals[k] || 0) + v.length;
const failed = Object.values(totals).some((n) => n > 0);
if (asJson) {
  console.log(JSON.stringify({ ok: !failed, totals, reports }, null, 1));
} else {
  const label = {
    padding10: "余白10px帯", unsourcedFixed: "出典のない固定サイズ", fillLeak: "FILLの付け忘れ", fillInHug: "縮む親の中のFILL",
    shadowClip: "切れる影", unboundColor: "変数に結ばれていない色", noTextStyle: "テキストスタイルなし", defaultName: "既定のレイヤー名", height: "画面の高さの不一致",
  };
  for (const [k, n] of Object.entries(totals)) console.log(`${n === 0 ? "○" : "×"} ${label[k]}: ${n}件`);
  for (const r of reports) {
    const bad = Object.entries(r.hits).filter(([, v]) => v.length);
    if (bad.length) console.log(`- ${r.name}: ` + bad.map(([k, v]) => `${label[k]} ${v.length}（例: ${v.slice(0, 3).map((h) => h.name).join(", ")}）`).join(" / "));
  }
}
process.exit(failed ? 1 : 0);
