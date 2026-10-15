#!/usr/bin/env node
// Build a Figma design file from dom-extract.mjs output.
//
// Usage:
//   node scripts/figma-build.mjs --extract <dir> --screens screens.json --images <dir> \
//     --out manifest.json [--components BlogHeader,PostCard,...] [--only home-375,...] \
//     [--specs-only]
//
// screens.json entries: { "name": "home", "path": "/", "label": "記事一覧（トップ）" }
// The plugin's current file must be the target file: pass --expect-file <file name> and the
// build stops before writing anything when the plugin runs in another file (or more than one
// plugin answers on the channel, which the relay log shows as "Broadcast to 2 peer(s)").
// Layout on the canvas follows the skill's standard: Design page with all mobile frames,
// then all desktop frames, 100px apart; component masters on the Components page.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertScreen, TokenRegistry } from "./dom-to-figma.mjs";
import { connectFigma } from "./lib/figma-ws.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const extractDir = arg("extract");
const screens = JSON.parse(await readFile(arg("screens"), "utf8"));
const imageDir = arg("images");
const outPath = arg("out");
const componentNames = (arg("components", "") || "").split(",").filter(Boolean);
const only = (arg("only", "") || "").split(",").filter(Boolean);
const widths = (arg("widths", "375,1366") || "").split(",").map(Number);
const GAP = 100;
// Map component names to their source files (relative to the app root) for descriptions.
const sourceFiles = {};
const srcDir = arg("src");
if (srcDir) {
  const { readdir } = await import("node:fs/promises");
  const walkDir = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walkDir(full);
      else if (/\.tsx$/.test(e.name)) sourceFiles[e.name.replace(/\.tsx$/, "")] = path.relative(path.dirname(srcDir), full);
    }
  };
  await walkDir(srcDir);
}
const VIEWPORT = { 375: "SP", 1366: "PC" };
// --layout course: a course's existing Figma format: one page, a
// "コンポーネント" frame with labelled components, a "スタイルガイド" frame, blog_OGP, and
// screens named "<label>_SP" / "<label>_PC" in SP-PC pairs, every frame 100px apart.
const COURSE = arg("layout") === "course";
const componentLabels = Object.fromEntries((arg("component-labels", "") || "").split(",").filter(Boolean).map((x) => x.split("=")));
const styleGuidePath = arg("style-guide");
const ogpPath = arg("ogp");
const GRID_COLOR = { r: 1, g: 0, b: 0, a: 0.1 };
function gridsFor(sc, width) {
  const vp = VIEWPORT[width];
  if (vp === "PC" && sc.gridPC) return [{ pattern: "COLUMNS", alignment: "CENTER", count: 1, gutterSize: 0, sectionSize: sc.gridPC, color: GRID_COLOR, visible: true }];
  if (vp === "SP" && sc.gridSP) return [{ pattern: "COLUMNS", alignment: "STRETCH", count: 1, gutterSize: 0, offset: sc.gridSP, color: GRID_COLOR, visible: true }];
  return undefined;
}

// ---------- convert ----------
// color tokens from every extract (plain HTML pages define none; they match by value)
const allTokens = {};
for (const sc of screens) {
  const ex = JSON.parse(await readFile(path.join(extractDir, `${sc.name}-${widths[0]}.json`), "utf8"));
  Object.assign(allTokens, ex.tokens || {});
}
const tokens = new TokenRegistry(allTokens);
const styles = { text: new Map(), effects: new Map() };
const images = new Set();
const built = [];
for (const width of widths) {
  for (const sc of screens) {
    if (sc.widths && !sc.widths.includes(width)) continue;
    const ex = JSON.parse(await readFile(path.join(extractDir, `${sc.name}-${width}.json`), "utf8"));
    const { spec } = convertScreen(ex, { tokens, styles, images, layoutGrids: COURSE ? gridsFor(sc, width) : undefined });
    spec.name = COURSE ? `${sc.label || sc.name}_${VIEWPORT[width] || width}` : `${sc.label || sc.name} / ${VIEWPORT[width] || width}（${width}）`;
    built.push({ key: `${sc.name}-${width}`, screen: sc, width, spec, docHeight: ex.docHeight });
  }
}

// ---------- components ----------
function signature(s) {
  const own = s.type === "FRAME" ? `F:${(s.layout || {}).mode}` : s.type;
  return `${own}(${(s.children || []).map(signature).join(",")})`;
}
function paintsEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}
function diff(master, occ, pathArr, out) {
  if (master.type === "TEXT") {
    if (master.text.characters !== occ.text.characters) out.push({ path: pathArr, characters: occ.text.characters });
    if (!paintsEqual([master.text.fill], [occ.text.fill])) out.push({ path: pathArr, textFill: occ.text.fill });
    return;
  }
  if (master.type === "IMAGE" && master.image !== occ.image) out.push({ path: pathArr, image: occ.image, scaleMode: occ.scaleMode });
  if (master.type === "FRAME" || master.type === "IMAGE") {
    if (master.type === "FRAME" && !paintsEqual(master.fills, occ.fills)) out.push({ path: pathArr, fills: occ.fills || [] });
    const ms = master.strokes || null, os = occ.strokes || null;
    if (JSON.stringify(ms) !== JSON.stringify(os)) out.push({ path: pathArr, strokes: os ? os.paints : [], strokeWeights: os ? os.weights : null });
  }
  (master.children || []).forEach((c, i) => diff(c, occ.children[i], [...pathArr, i], out));
}
function collect(spec, fn, parent = null, index = -1) {
  fn(spec, parent, index);
  (spec.children || []).forEach((c, i) => collect(c, fn, spec, i));
}

const masters = new Map(); // "PostCard/SP" -> master spec
// Components whose look does not change with the viewport but with their text become
// one set with a state property instead (e.g. StatusBadge: Status=公開 / Status=下書き).
const stateProps = Object.fromEntries((arg("state-components", "") || "").split(",").filter(Boolean).map((x) => x.split(":")));
// --variant-labels "TodoItem=未完了|完了": uses of a component that differ in structure become
// variants of a 状態 property (most common first), instead of loose frames
const variantLabels = Object.fromEntries((arg("variant-labels", "") || "").split(",").filter(Boolean).map((x) => { const [n, v] = x.split("="); return [n, v.split("|")]; }));
const variantKey = (name, variantName) => {
  const props = Object.fromEntries(variantName.split(",").map((p) => p.trim().split("=")));
  const labels = variantLabels[name];
  const vp = props.Viewport || Object.values(props)[0];
  return labels && props["状態"] && props["状態"] !== labels[0] ? `${name}/${vp}/${props["状態"]}` : `${name}/${vp}`;
};
const firstText = (s) => (s.type === "TEXT" ? s.text.characters : (s.children || []).map(firstText).find(Boolean));
for (const [name, prop] of Object.entries(stateProps)) {
  const occs = [];
  for (const b of built) collect(b.spec, (s, parent, index) => { if (s.component === name && parent) occs.push({ s, parent, index }); });
  const byState = new Map();
  for (const o of occs) {
    const state = firstText(o.s) || "default";
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state).push(o);
  }
  for (const [state, group] of byState) {
    const master = JSON.parse(JSON.stringify(group[0].s));
    const auto = master.layout && master.layout.mode !== "NONE";
    Object.assign(master, { type: "COMPONENT", name: `${prop}=${state}`, absolute: false, x: 0, y: 0 });
    master.sizing = { h: auto ? "HUG" : "FIXED", v: auto ? "HUG" : "FIXED" };
    masters.set(`${name}/${state}`, { master, name, vp: state });
    for (const o of group) {
      o.parent.children[o.index] = { type: "INSTANCE", component: `${name}/${state}`, name, w: o.s.w, h: o.s.h, x: o.s.x, y: o.s.y, sizing: o.s.sizing, absolute: o.s.absolute, overrides: [] };
    }
  }
}
for (const name of componentNames.filter((n) => !stateProps[n])) {
  for (const width of widths) {
    const vp = VIEWPORT[width] || String(width);
    const occs = [];
    for (const b of built.filter((x) => x.width === width)) {
      collect(b.spec, (s, parent, index) => {
        if (s.component === name && parent) occs.push({ s, parent, index });
      });
    }
    if (occs.length === 0) continue;
    const bySig = new Map();
    for (const o of occs) {
      const sig = signature(o.s);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(o);
    }
    const ranked = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
    const totalUses = occs.length;
    if (totalUses < 2 && !flag("all-components")) continue;
    const labels = variantLabels[name];
    const groups = labels ? ranked.slice(0, labels.length) : ranked.slice(0, 1);
    groups.forEach(([sig, group], gi) => {
    const master = JSON.parse(JSON.stringify(group[0].s));
    master.type = "COMPONENT";
    master.name = labels ? `Viewport=${vp}, 状態=${labels[gi]}` : `Viewport=${vp}`;
    const mkey = gi === 0 ? `${name}/${vp}` : `${name}/${vp}/${labels[gi]}`;
    master.absolute = false;
    master.x = 0;
    master.y = 0;
    // A master hugs where its uses hug; elsewhere it keeps the width it is used at.
    const occ = group[0].s.sizing || {};
    const auto = master.layout && master.layout.mode !== "NONE";
    master.sizing = {
      h: occ.h === "HUG" && auto ? "HUG" : "FIXED",
      v: occ.v === "HUG" && auto ? "HUG" : "FIXED",
      sourceW: occ.h === "HUG" && auto ? undefined : occ.sourceW || `width where it is used (${master.w}px); instances ${occ.h === "FILL" ? "fill their container" : "keep it"}`,
      sourceH: occ.v === "HUG" && auto ? undefined : occ.sourceH || `height where it is used (${master.h}px); instances ${occ.v === "FILL" ? "fill their container" : "keep it"}`,
    };
    masters.set(mkey, { master, name, vp });
    for (const o of group) {
      const overrides = [];
      diff(group[0].s, o.s, [], overrides);
      const inst = {
        type: "INSTANCE",
        component: mkey,
        name,
        w: o.s.w,
        h: o.s.h,
        x: o.s.x,
        y: o.s.y,
        sizing: o.s.sizing,
        absolute: o.s.absolute,
        overrides,
      };
      o.parent.children[o.index] = inst;
    }
    });
  }
}

// Viewport variants that differ only in their sizes collapse into one component.
const stripSizes = (spec) => JSON.stringify(spec, (k, v) => (["w", "h", "x", "y", "sizing", "name"].includes(k) ? undefined : v));
for (const name of componentNames) {
  if (variantLabels[name]) continue;
  const sp = masters.get(`${name}/SP`), pc = masters.get(`${name}/PC`);
  if (!sp || !pc || stripSizes(sp.master) !== stripSizes(pc.master)) continue;
  masters.delete(`${name}/PC`);
  sp.single = true;
  for (const b of built) collect(b.spec, (s) => { if (s.type === "INSTANCE" && s.component === `${name}/PC`) s.component = `${name}/SP`; });
}

const tokenPayload = {
  collection: "Colors",
  mode: "Light",
  colors: Object.fromEntries([...tokens.used.entries()].sort().map(([k, c]) => [k, { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a }])),
  textStyles: Object.fromEntries([...styles.text.entries()].sort().map(([k, t]) => [k, t])),
  effectStyles: Object.fromEntries(styles.effects.entries()),
};

if (flag("specs-only")) {
  await writeFile(outPath, JSON.stringify({ tokens: tokenPayload, masters: Object.fromEntries(masters), screens: built.map((b) => ({ key: b.key, spec: b.spec })) }, null, 1));
  console.log(JSON.stringify({ specs: built.length, masters: [...masters.keys()], colors: Object.keys(tokenPayload.colors).length, textStyles: Object.keys(tokenPayload.textStyles).length, effectStyles: Object.keys(tokenPayload.effectStyles) }));
  process.exit(0);
}

// ---------- build ----------
const imagePayload = {};
for (const name of images) {
  if (!name) continue;
  const buf = await readFile(path.join(imageDir, name));
  imagePayload[name] = buf.toString("base64");
}

const figma = await connectFigma();
// Figma sometimes answers "Unable to establish connection to Figma" for a moment; the plugin
// removes a half-built tree, so one more try is safe
async function buildTree(params, timeout) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await figma.call("build_tree", params, timeout);
    } catch (e) {
      if (attempt >= 3 || !/Unable to establish connection/i.test(String(e.message || e))) throw e;
      console.error(`build_tree failed (${String(e.message || e).slice(0, 80)}), retrying`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}
const expectFile = arg("expect-file");
if (!expectFile && !flag("specs-only")) {
  console.error("--expect-file <file name> is required: it keeps a build from writing into another open file");
  figma.close();
  process.exit(2);
}
if (expectFile) {
  // every plugin on the channel would receive the writes: exactly one, in the expected file
  const answers = await figma.callAll("get_file_info", {}, 3000);
  const names = answers.map((a) => (a && a.name) || (a && a.error) || "?");
  if (answers.length !== 1 || names[0] !== expectFile) {
    console.error(`plugins answering: ${answers.length} (${names.join(", ") || "none"}); expected one in "${expectFile}"; nothing was written`);
    figma.close();
    process.exit(2);
  }
  // and every command carries the file name, so a plugin in another file ignores it
  const rawCall = figma.call;
  figma.call = (command, params = {}, timeout) => rawCall(command, { ...params, targetFile: expectFile }, timeout);
}
const manifest = { builtAt: new Date().toISOString(), pages: {}, tokens: {}, components: {}, screens: {} };
if (COURSE) {
  try {
    await buildCourse();
  } finally {
    await writeFile(outPath, JSON.stringify(manifest, null, 1));
    figma.close();
  }
  process.exit(0);
}
try {
  manifest.pages = await figma.call("ensure_pages", { pages: ["Design", "Components"] });
  if (flag("clean")) {
    // only for a file this script owns: rebuild from scratch
    for (const name of ["Design", "Components"]) {
      const r = await figma.call("clear_page", { pageId: manifest.pages[name], expectName: name });
      console.log(JSON.stringify({ cleared: name, removed: r.removed }));
    }
  }
  manifest.tokens = await figma.call("ensure_tokens", tokenPayload, 120000);

  // masters on the Components page
  await figma.call("set_current_page", { pageId: manifest.pages.Components });
  const componentIds = {};
  let cy = 0;
  const byName = new Map();
  for (const [key, m] of masters) {
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push([key, m]);
  }
  for (const [name, list] of byName) {
    const ids = [];
    let cx = 0;
    for (const [key, m] of list) {
      const r = await buildTree({ tree: m.master, images: imagePayload, tokens: manifest.tokens, x: cx, y: cy }, 180000);
      ids.push(r.rootId);
      componentIds[key] = r.rootId;
      cx += r.width + GAP;
    }
    const notes = [...new Set(list.flatMap(([, m]) => m.master.notes || []))];
    const description = [sourceFiles[name] ? `React: ${sourceFiles[name]}` : null, ...notes.map((n) => `${n}（スクロールしても画面に固定）`.replace("横スクロール（スクロールしても画面に固定）", "横スクロール"))].filter(Boolean).join("\n") || undefined;
    if (list.length === 1 && list[0][1].single) {
      // a single component, no variant set
      await figma.call("rename_node", { nodeId: ids[0], name });
      if (description) await figma.call("set_component_description", { nodeId: ids[0], description });
      const only = { id: ids[0], name, width: 0, height: 0, variants: [{ id: ids[0], name: "Viewport=SP" }] };
      const dump = await figma.call("dump_tree", { nodeId: ids[0], maxDepth: 0 });
      only.width = dump.w;
      only.height = dump.h;
      manifest.components[name] = only;
      componentIds[`${name}/SP`] = ids[0];
      cy += only.height + GAP;
      console.log(JSON.stringify({ component: name, variants: 1 }));
      continue;
    }
    const set = await figma.call("combine_variants", { componentIds: ids, name, x: 0, y: cy, description });
    for (const v of set.variants) componentIds[variantKey(name, v.name)] = v.id;
    manifest.components[name] = set;
    cy += set.height + GAP;
    console.log(JSON.stringify({ component: name, variants: set.variants.length }));
  }

  // screens on the Design page
  await figma.call("set_current_page", { pageId: manifest.pages.Design });
  let x = 0;
  for (const b of built) {
    if (only.length && !only.includes(b.key)) {
      x += b.spec.w + GAP;
      continue;
    }
    const r = await buildTree({ tree: b.spec, images: imagePayload, tokens: manifest.tokens, components: componentIds, x, y: 0 }, 300000);
    manifest.screens[b.key] = { id: r.rootId, name: r.name, x, width: r.width, height: r.height, docHeight: b.docHeight, created: r.createdCount };
    console.log(JSON.stringify({ screen: b.key, id: r.rootId, w: r.width, h: r.height, docHeight: b.docHeight, nodes: r.createdCount }));
    x += b.spec.w + GAP;
  }
} finally {
  await writeFile(outPath, JSON.stringify(manifest, null, 1));
  figma.close();
}


// ---------- course layout ----------
function textSpec(characters, size, weight, opts = {}) {
  return {
    type: "TEXT", name: opts.name || characters.replace(/\n/g, " ").slice(0, 40), w: opts.w || 10, h: Math.round(size * 1.6),
    sizing: { h: opts.w ? "FILL" : "HUG", v: "HUG" },
    text: { characters, family: "Noto Sans JP", weight, size, lineHeight: opts.lineHeight || null, letterSpacing: 0, align: "LEFT", fill: { color: opts.color || { r: 0.2, g: 0.2, b: 0.2 }, opacity: 1, variable: opts.variable }, runs: [] },
  };
}
function headingSpec(title, width) {
  // a section title with a rule under it, as in the course's frames
  return {
    type: "FRAME", name: title, w: width, h: 80, sizing: { h: "FIXED", v: "HUG", sourceW: "course format: heading rule width" },
    layout: { mode: "VERTICAL", gap: 16, padding: [0, 0, 16, 0], primary: "MIN", counter: "MIN" },
    strokes: { paints: [{ color: { r: 0.2, g: 0.2, b: 0.2 }, opacity: 1 }], weights: [0, 0, 1, 0], align: "INSIDE" }, strokesIncluded: true,
    children: [textSpec(title, 40, 700, { lineHeight: 56 })], sourcePad: "course format",
  };
}
function sectionFrame(name, w, h, children, opts = {}) {
  return {
    type: "FRAME", name, w, h, x: opts.x || 0, y: opts.y || 0,
    sizing: { h: opts.fixedW ? "FIXED" : "HUG", v: "HUG", sourceW: opts.fixedW ? `course format: ${w}px` : undefined },
    layout: { mode: "VERTICAL", gap: opts.gap || 24, padding: opts.padding || [96, 120, 96, 120], primary: "MIN", counter: "MIN" },
    fills: [{ color: { r: 1, g: 1, b: 1 }, opacity: 1, variable: "tailwind/white" }],
    sourcePad: "course format", children,
  };
}

async function buildCourse() {
  // one page named like the course file; an earlier "Design" page becomes "Page 1" and the
  // separate "Components" page goes away (its masters are rebuilt inside the frame)
  let pages = await figma.call("list_pages", {});
  if (!pages.find((p) => p.name === "Page 1")) {
    const design = pages.find((p) => p.name === "Design");
    if (design) await figma.call("rename_node", { nodeId: design.id, name: "Page 1" });
    else await figma.call("ensure_pages", { pages: ["Page 1"] });
    pages = await figma.call("list_pages", {});
  }
  const pageId = pages.find((p) => p.name === "Page 1").id;
  await figma.call("set_current_page", { pageId });
  for (const p of pages) if (p.name === "Components" && flag("clean")) await figma.call("delete_node", { nodeId: p.id });
  manifest.pages = { "Page 1": pageId };
  if (flag("clean")) {
    const r = await figma.call("clear_page", { pageId, expectName: "Page 1" });
    console.log(JSON.stringify({ cleared: "Page 1", removed: r.removed }));
  }
  const imagePayload = {};
  for (const name of images) {
    if (!name) continue;
    imagePayload[name] = (await readFile(path.join(imageDir, name))).toString("base64");
  }
  if (ogpPath) imagePayload["blog_ogp"] = (await readFile(ogpPath)).toString("base64");
  manifest.tokens = await figma.call("ensure_tokens", tokenPayload, 120000);

  // masters, first built off to the side, then combined and moved into the frame
  const componentIds = {};
  const byName = new Map();
  for (const [key, m] of masters) {
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push([key, m]);
  }
  const sets = [];
  let tmpY = 0;
  const order = [...componentNames, ...Object.keys(stateProps)];
  const ordered = [...byName.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  for (const [name, list] of ordered) {
    // the course file shows PC before SP
    list.sort((a, b) => (b[1].vp === "PC") - (a[1].vp === "PC"));
    const ids = [];
    let cx = -20000;
    for (const [key, m] of list) {
      const r = await buildTree({ tree: m.master, images: imagePayload, tokens: manifest.tokens, x: cx, y: tmpY }, 180000);
      ids.push(r.rootId);
      componentIds[key] = r.rootId;
      cx += r.width + GAP;
    }
    const notes = [...new Set(list.flatMap(([, m]) => m.master.notes || []))];
    const src = sourceFiles[name] ? `React: ${sourceFiles[name]}` : null;
    const description = [src, ...notes.map((n) => (n === "横スクロール" ? n : `${n}（スクロールしても画面に固定）`))].filter(Boolean).join("\n") || undefined;
    if (list.length === 1 && list[0][1].single) {
      await figma.call("rename_node", { nodeId: ids[0], name });
      if (description) await figma.call("set_component_description", { nodeId: ids[0], description });
      const dump = await figma.call("dump_tree", { nodeId: ids[0], maxDepth: 0 });
      manifest.components[name] = { id: ids[0], name, width: dump.w, height: dump.h, variants: [{ id: ids[0], name: "Viewport=SP" }] };
      componentIds[`${name}/SP`] = ids[0];
      sets.push({ name, id: ids[0] });
    } else {
      const set = await figma.call("combine_variants", { componentIds: ids, name, x: -20000, y: tmpY, description });
      for (const v of set.variants) componentIds[variantKey(name, v.name)] = v.id;
      manifest.components[name] = set;
      sets.push({ name, id: set.id });
    }
    tmpY += 2000;
    console.log(JSON.stringify({ component: name }));
  }

  // コンポーネント frame: title, then "・label" and the component, top to bottom
  const compChildren = [headingSpec("コンポーネント", 760)];
  // --components-note "...": one line under the heading (which screens the parts come from)
  if (arg("components-note")) compChildren.push(textSpec(arg("components-note"), 14, 400, { color: { r: 0.33, g: 0.33, b: 0.33 } }));
  for (const st of sets) compChildren.push(textSpec(`・${componentLabels[st.name] || st.name}`, 18, 700, { name: componentLabels[st.name] || st.name }));
  const comp = await buildTree({ tree: sectionFrame("コンポーネント", 1566, 1200, compChildren), tokens: manifest.tokens, x: 0, y: 0 }, 120000);
  const lead = arg("components-note") ? 2 : 1; // heading (and note) before the first label
  for (let i = 0; i < sets.length; i++) {
    await figma.call("set_parent", { nodeId: sets[i].id, parentId: comp.rootId, index: lead + 1 + i * 2 });
  }
  let compDump = await figma.call("dump_tree", { nodeId: comp.rootId, maxDepth: 0 });
  // text heights leave a fraction; pad the bottom so the frame's H reads as a whole number
  const frac = Math.ceil(compDump.h - 0.01) - compDump.h;
  if (frac > 0.001) {
    await figma.call("set_padding", { nodeId: comp.rootId, paddingBottom: compDump.padding[2] + frac });
    compDump = await figma.call("dump_tree", { nodeId: comp.rootId, maxDepth: 0 });
  }
  manifest.frames = { components: { id: comp.rootId, w: compDump.w, h: compDump.h } };
  let x = compDump.w + GAP;

  // スタイルガイド frame from a data file
  if (styleGuidePath) {
    const sg = JSON.parse(await readFile(styleGuidePath, "utf8"));
    const children = [];
    for (const sec of sg.sections) {
      const block = { type: "FRAME", name: sec.title, w: 760, h: 100, sizing: { h: "FIXED", v: "HUG", sourceW: "course format" }, layout: { mode: "VERTICAL", gap: 24, padding: [0, 0, 0, 0], primary: "MIN", counter: "MIN" }, children: [headingSpec(sec.title, 760)] };
      if (sec.colors) {
        for (const row of sec.colors) {
          const sw = { type: "FRAME", name: row.label || "colors", w: 760, h: 120, sizing: { h: "FIXED", v: "HUG", sourceW: "course format" }, layout: { mode: "VERTICAL", gap: 8, padding: [0, 0, 0, 0], primary: "MIN", counter: "MIN" }, children: [] };
          if (row.label) sw.children.push(textSpec(row.label, 14, 400, { color: { r: 0.33, g: 0.33, b: 0.33 } }));
          const line = { type: "FRAME", name: "swatches", w: 760, h: 110, sizing: { h: "FIXED", v: "HUG", sourceW: "course format" }, layout: { mode: "HORIZONTAL", gap: 6, padding: [0, 0, 0, 0], primary: "MIN", counter: "MIN", wrap: true, counterGap: 16 }, children: [] };
          for (const c of row.items) {
            const col = { r: parseInt(c.hex.slice(1, 3), 16) / 255, g: parseInt(c.hex.slice(3, 5), 16) / 255, b: parseInt(c.hex.slice(5, 7), 16) / 255 };
            line.children.push({
              type: "FRAME", name: c.name || c.hex, w: 78, h: 110, sizing: { h: "HUG", v: "HUG" }, layout: { mode: "VERTICAL", gap: 12, padding: [0, 0, 0, 0], primary: "MIN", counter: "CENTER" },
              children: [
                { type: "FRAME", name: "swatch", w: 78, h: 78, sizing: { h: "FIXED", v: "FIXED", sourceW: "course format", sourceH: "course format" }, layout: { mode: "NONE" }, fills: [{ color: col, opacity: c.alpha === undefined ? 1 : c.alpha, variable: c.variable }], strokes: { paints: [{ color: { r: 0.67, g: 0.67, b: 0.67 }, opacity: 1 }], weights: [1, 1, 1, 1], align: "INSIDE" } },
                textSpec(c.caption || c.hex, 14, 400, { color: { r: 0.33, g: 0.33, b: 0.33 } }),
              ],
            });
          }
          sw.children.push(line);
          block.children.push(sw);
        }
      }
      if (sec.lines && sec.lines.length) block.children.push(textSpec(sec.lines.join("\n"), 16, 400, { w: 760, lineHeight: 31, name: sec.title + "の説明" }));
      children.push(block);
    }
    const sgSpec = sectionFrame("スタイルガイド", 1366, 2000, children, { padding: [120, 303, 120, 303], gap: 120 });
    const sgr = await buildTree({ tree: sgSpec, tokens: manifest.tokens, x, y: 0 }, 120000);
    manifest.frames.styleGuide = { id: sgr.rootId, w: sgr.width, h: sgr.height };
    x += sgr.width + GAP;
  }

  // blog_OGP under the components, right-aligned
  if (ogpPath) {
    const ogp = { type: "FRAME", name: "blog_OGP", w: 1200, h: 630, sizing: { h: "FIXED", v: "FIXED", sourceW: "OGP 1200x630", sourceH: "OGP 1200x630" }, layout: { mode: "NONE" }, fills: [], clips: true,
      children: [{ type: "IMAGE", name: "blog_ogp", image: "blog_ogp", w: 1200, h: 630, x: 0, y: 0, sizing: { h: "FIXED", v: "FIXED" } }] };
    const r = await buildTree({ tree: ogp, images: imagePayload, tokens: manifest.tokens, x: compDump.w - 1200, y: compDump.h + GAP }, 120000);
    manifest.frames.ogp = { id: r.rootId };
  }

  // screens: per page an SP-PC pair; every frame 100px apart (the skill's standard)
  for (const sc of screens) {
    for (const width of widths) {
      const b = built.find((q) => q.screen.name === sc.name && q.width === width);
      if (!b) continue;
      if (only.length && !only.includes(b.key)) { x += b.spec.w + GAP; continue; }
      const r = await buildTree({ tree: b.spec, images: imagePayload, tokens: manifest.tokens, components: componentIds, x, y: 0 }, 300000);
      manifest.screens[b.key] = { id: r.rootId, name: r.name, x, width: r.width, height: r.height, docHeight: b.docHeight, created: r.createdCount };
      console.log(JSON.stringify({ screen: b.key, id: r.rootId, w: r.width, h: r.height, docHeight: b.docHeight, nodes: r.createdCount }));
      x += b.spec.w + GAP;
    }
  }
  await orderLayers(pageId);
}

// Layers panel top to bottom as in the course file: コンポーネント, スタイルガイド, the
// screens in page order (SP then PC), blog_OGP. The panel shows the last child on top.
async function orderLayers(pageId) {
  const topToBottom = [manifest.frames.components && manifest.frames.components.id, manifest.frames.styleGuide && manifest.frames.styleGuide.id];
  for (const sc of screens) for (const width of widths) {
    const s = manifest.screens[`${sc.name}-${width}`];
    if (s) topToBottom.push(s.id);
  }
  if (manifest.frames.ogp) topToBottom.push(manifest.frames.ogp.id);
  for (const id of topToBottom.filter(Boolean)) await figma.call("set_parent", { nodeId: id, parentId: pageId, index: 0, keepPosition: true });
}
