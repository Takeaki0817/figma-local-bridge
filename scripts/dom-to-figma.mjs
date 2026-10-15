// Convert trees from dom-extract.mjs into build specs for the plugin's build_tree command.
//
// Principles (see .claude/skills/talk-to-figma-design/SKILL.md):
// - Values come from the rendered DOM, never from eyeballing.
// - Every auto-layout frame states all four paddings and itemSpacing.
// - FILL / HUG / FIXED is decided from geometry: FILL when the child spans the parent's
//   content box, HUG when the size equals what its content produces, FIXED otherwise
//   (with the CSS class that fixes it recorded as `source`).
// - Colors bind to variables named after the CSS token; text uses text styles named after
//   the Tailwind scale; shadows use effect styles named after the shadow class.

const EPS = 0.75;

// ---------- colors ----------
function srgbFromLinear(x) {
  x = Math.max(0, Math.min(1, x));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
function oklabToRgb(L, a, b, alpha) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: srgbFromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: srgbFromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: srgbFromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}
function alphaOf(part) {
  if (!part) return 1;
  part = part.trim();
  return part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part);
}
export function parseColor(str) {
  if (!str || str === "transparent" || str === "none") return null;
  let m;
  if ((m = str.match(/^rgba?\(([^)]+)\)$/))) {
    const [main, alpha] = m[1].includes("/") ? m[1].split("/") : [m[1], null];
    const parts = main.split(/[\s,]+/).filter(Boolean).map(Number);
    const a = alpha !== null ? alphaOf(alpha) : parts.length > 3 ? parts[3] : 1;
    return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a };
  }
  if ((m = str.match(/^oklch\(([^)]+)\)$/))) {
    const [main, alpha] = m[1].split("/");
    let [L, C, H] = main.trim().split(/\s+/);
    L = L.endsWith("%") ? parseFloat(L) / 100 : parseFloat(L);
    C = parseFloat(C);
    H = parseFloat(H) || 0;
    return oklabToRgb(L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180), alphaOf(alpha));
  }
  if ((m = str.match(/^oklab\(([^)]+)\)$/))) {
    const [main, alpha] = m[1].split("/");
    let [L, a, b] = main.trim().split(/\s+/);
    L = L.endsWith("%") ? parseFloat(L) / 100 : parseFloat(L);
    return oklabToRgb(L, parseFloat(a), parseFloat(b), alphaOf(alpha));
  }
  if ((m = str.match(/^color\(srgb ([^)]+)\)$/))) {
    const [main, alpha] = m[1].split("/");
    const [r, g, b] = main.trim().split(/\s+/).map(Number);
    return { r, g, b, a: alphaOf(alpha) };
  }
  return null;
}
const rgbKey = (c) => [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(",");

// ---------- tokens ----------
// Variable groups: daisyUI theme colors, Tailwind's default palette, and everything else
// (colors the app defines in its own @theme).
const DAISY_PREFIX = /^(base-|primary|secondary|accent|neutral|info|success|warning|error)/;
const TAILWIND_PALETTE = /^((slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)$/;
function tokenGroup(name) {
  if (DAISY_PREFIX.test(name) && !TAILWIND_PALETTE.test(name)) return "daisyui";
  if (TAILWIND_PALETTE.test(name)) return "tailwind";
  return "theme";
}

export class TokenRegistry {
  constructor(rawTokens) {
    this.byName = new Map();
    this.byRgb = new Map();
    const order = ["theme", "daisyui", "tailwind"];
    const entries = Object.entries(rawTokens || {})
      .filter(([k]) => !k.startsWith("shadow:"))
      .map(([k, v]) => [k, parseColor(v)])
      .filter(([, c]) => c && c.a === 1);
    entries.sort((a, b) => order.indexOf(tokenGroup(a[0])) - order.indexOf(tokenGroup(b[0])));
    for (const [name, c] of entries) {
      this.byName.set(name, c);
      const key = rgbKey(c);
      if (!this.byRgb.has(key)) this.byRgb.set(key, []);
      this.byRgb.get(key).push(name);
    }
    this.used = new Map(); // variable name -> color
  }
  // classChain: class strings from the element outward (for inherited text colors)
  resolve(color, classChain, prefixes) {
    if (!color || color.a === 0) return null;
    const key = rgbKey(color);
    const candidates = this.byRgb.get(key) || [];
    let token = null;
    if (candidates.length) {
      outer: for (const cls of classChain) {
        for (const raw of (cls || "").split(/\s+/)) {
          const c = raw.replace(/^([a-z0-9]+:)+/, "");
          if (/^hover:|^focus:/.test(raw)) continue;
          for (const p of prefixes) {
            const m = c.match(new RegExp(`^${p}-(.+?)(?:/\\d+)?$`));
            if (m && candidates.includes(m[1])) {
              token = m[1];
              break outer;
            }
          }
        }
      }
      if (!token) {
        const order = NAMING === "class" ? ["theme", "tailwind", "daisyui"] : ["theme", "daisyui", "tailwind"];
        token = candidates.slice().sort((a, b) => order.indexOf(tokenGroup(a)) - order.indexOf(tokenGroup(b)))[0];
      }
    }
    const paint = { color: { r: color.r, g: color.g, b: color.b }, opacity: round3(color.a) };
    if (token) {
      // A bound variable supplies the paint's alpha, so a token used at partial opacity
      // (Tailwind's `base-content/20`) gets its own variable carrying that alpha.
      const pct = Math.round(color.a * 100);
      const varName = pct >= 100 ? `${tokenGroup(token)}/${token}` : `${tokenGroup(token)}/${token} (${pct}%)`;
      paint.variable = varName;
      const base = this.byName.get(token);
      this.used.set(varName, { r: base.r, g: base.g, b: base.b, a: pct >= 100 ? 1 : round3(color.a) });
    }
    return paint;
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const round2 = (v) => Math.round(v * 100) / 100;

// ---------- text styles ----------
const TW_SIZE = { 12: "xs", 14: "sm", 16: "base", 18: "lg", 20: "xl", 24: "2xl", 30: "3xl", 36: "4xl", 48: "5xl" };
const TW_LEADING = { 12: 16, 14: 20, 16: 24, 18: 28, 20: 28, 24: 32, 30: 36, 36: 40, 48: 48 };
const TW_WEIGHT = { 100: "thin", 200: "extralight", 300: "light", 400: "normal", 500: "medium", 600: "semibold", 700: "bold", 800: "extrabold", 900: "black" };
const LEADING_NAMES = { 1: "none", 1.25: "tight", 1.375: "snug", 1.5: "normal", 1.625: "relaxed", 2: "loose" };

export function textStyleName(size, weight, lineHeight) {
  if (NAMING === "class") {
    // plain CSS: font-size / weight / line-height as written in the stylesheet
    const w = TW_WEIGHT[weight] || String(weight);
    const lh = lineHeight === null ? "normal" : String(round2(lineHeight / size));
    return `${round2(size)}px/${w}/${lh}`;
  }
  const sizeName = TW_SIZE[size] ? `text-${TW_SIZE[size]}` : `text-[${round2(size)}px]`;
  const w = TW_WEIGHT[weight] || String(weight);
  let lead = "";
  if (lineHeight === null) lead = "/leading-auto";
  else if (TW_LEADING[size] === undefined || Math.abs(TW_LEADING[size] - lineHeight) > 0.1) {
    const ratio = round3(lineHeight / size);
    lead = LEADING_NAMES[ratio] ? `/leading-${LEADING_NAMES[ratio]}` : `/leading-[${round2(lineHeight)}px]`;
  }
  return `${sizeName}/${w}${lead}`;
}

// ---------- box shadows ----------
function splitTop(str) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
export function parseShadows(str) {
  if (!str || str === "none") return [];
  const res = [];
  for (const part of splitTop(str)) {
    const colorMatch = part.match(/(rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\))/);
    const color = colorMatch ? parseColor(colorMatch[1]) : { r: 0, g: 0, b: 0, a: 1 };
    const rest = part.replace(colorMatch ? colorMatch[1] : "", "").trim();
    const inset = /\binset\b/.test(rest);
    const nums = rest.replace("inset", "").trim().split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    if (!color || color.a === 0) continue;
    if (x === 0 && y === 0 && blur === 0 && spread === 0) continue;
    res.push({ type: inset ? "INNER_SHADOW" : "DROP_SHADOW", color: { r: color.r, g: color.g, b: color.b, a: round3(color.a) }, offset: { x, y }, radius: blur, spread });
  }
  return res;
}

// ---------- tree helpers ----------
const SEMANTIC = new Set(["header", "nav", "main", "footer", "section", "article", "aside", "form", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "button", "a", "label", "h1", "h2", "h3", "h4", "h5", "h6", "p", "time", "small", "input", "select", "textarea"]);
const DAISY_NAMES = ["navbar-start", "navbar-end", "navbar", "card-body", "card", "drawer-content", "drawer-side", "drawer", "menu", "form-control", "label-text-alt", "label-text", "label", "badge", "btn", "input", "select", "textarea", "table", "alert", "divider", "join", "stat"];
const LIB_PLAIN = new Set(["div", "span"]);

function classList(n) {
  return (n.cls || "").split(/\s+/).filter(Boolean);
}
function hasClass(n, re) {
  return classList(n).some((c) => re.test(c.replace(/^([a-z0-9]+:)+/, "")));
}

function contentBox(n) {
  const s = n.style;
  const [pt, pr, pb, pl] = s.padding;
  const [bt, br, bb, bl] = s.borderWidth.map((w, i) => (s.borderStyle[i] === "none" ? 0 : w));
  return { x: n.box.x + pl + bl, y: n.box.y + pt + bt, w: n.box.w - pl - pr - bl - br, h: n.box.h - pt - pb - bt - bb };
}

function isVisual(n) {
  const s = n.style;
  const bg = parseColor(s.backgroundColor);
  if (bg && bg.a > 0) return true;
  if (s.borderWidth.some((w, i) => w > 0 && s.borderStyle[i] !== "none")) return true;
  if (s.boxShadow && s.boxShadow !== "none") return true;
  const clamped = s.lineClamp && s.lineClamp !== "none";
  if (!clamped && (s.overflowX !== "visible" || s.overflowY !== "visible")) return true;
  if (s.opacity !== 1) return true;
  return false;
}
const isPlain = (n) => LIB_PLAIN.has(n.tag) && !n.component;
const sameBox = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;

// "class": plain HTML/CSS pages are named after their first class (header-nav_link),
// the names students write themselves; otherwise React component / daisyUI / tag names.
let NAMING = null;

function nodeName(n) {
  if (n.component) return n.component;
  // the outermost element of a React component is named after it (TodoItem, AppLayout)
  // (icons keep icon/<name>, the same in every screen)
  if (NAMING !== "class" && n.tag !== "svg" && n.reactName && !/^(Anonymous|Fragment)$/.test(n.reactName)) return n.reactName;
  if (NAMING === "class" && n.tag !== "svg") {
    const first = classList(n)[0];
    if (first) return first;
  }
  const cls = classList(n).map((c) => c.replace(/^([a-z0-9]+:)+/, ""));
  for (const d of DAISY_NAMES) if (cls.includes(d)) return d;
  if (n.tag === "svg") return `icon/${n.iconName || "icon"}`;
  if (n.tag === "img") return (n.src || "").split("/").pop().replace(/\.[a-z]+(\?.*)?$/, "") || "image";
  if (SEMANTIC.has(n.tag)) return n.tag;
  if (n.tag === "span") return "span";
  return "div";
}

function textCharacters(runs) {
  return runs.map((r) => r.text).join("");
}

// A text-bearing element becomes a TEXT node itself when it has no box of its own.
function textIsSelf(n) {
  const s = n.style;
  if (isVisual(n)) return false;
  if (s.padding.some((p) => p > 0)) return false;
  if (/flex|grid/.test(s.display)) return false;
  return true;
}

// ---------- normalization: extract node -> working node ----------
function normalize(n, ancestors) {
  const chain = [n.cls, ...ancestors.map((a) => a.cls)];
  const w = { src: n, tag: n.tag, cls: n.cls, component: n.component, box: n.box, style: n.style, chain, children: [], lineCount: n.lineCount || 1 };
  w.absolute = n.style.position === "absolute" || n.style.position === "fixed";
  if (n.tag === "svg") {
    w.kind = "svg";
    return w;
  }
  if (n.tag === "img") {
    w.kind = "image";
    return w;
  }
  w.kind = "frame";
  w.content = contentBox(n);
  if (n.tag === "input" || n.tag === "textarea" || n.tag === "select") {
    const showsPlaceholder = !n.value && n.placeholder;
    // a checkbox or radio has a value ("on") that is never drawn
    const drawsValue = n.tag !== "input" || !/^(checkbox|radio|range|color|file|hidden)$/.test(n.inputType || "");
    const chars = drawsValue ? n.value || n.placeholder || "" : "";
    if (chars) {
      const lh = n.style.lineHeight;
      const lines = n.tag === "textarea" ? 1 : 1;
      const h = lh || n.style.fontSize * 1.45;
      const cb = w.content;
      const ty = n.tag === "textarea" ? cb.y : cb.y + cb.h / 2 - (h * lines) / 2;
      w.children.push({
        kind: "text",
        tag: "#value",
        chain,
        style: n.style,
        runs: [{ text: chars, color: showsPlaceholder ? n.placeholderColor : n.style.color, fontWeight: n.style.fontWeight, fontSize: n.style.fontSize }],
        box: { x: cb.x, y: ty, w: cb.w, h: h * lines },
        fillWidth: true,
        name: showsPlaceholder ? "placeholder" : "value",
      });
    }
    if (n.tag === "select") {
      // daisyUI draws the chevron with two 4x4 gradient squares; reproduce it as a small triangle.
      const color = (n.style.backgroundImage.match(/(oklch\([^)]*\)|rgba?\([^)]*\)|oklab\([^)]*\))\s*50%\)$/) || [])[1] || n.style.color;
      const c = parseColor(color) || { r: 0, g: 0, b: 0, a: 1 };
      const hex = "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
      w.children.push({
        kind: "svg",
        tag: "svg",
        chain,
        style: n.style,
        absolute: true,
        box: { x: n.box.x + n.box.w - 24, y: n.box.y + (n.box.h - 4) / 2 + 1, w: 8, h: 4 },
        svgOverride: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4" viewBox="0 0 8 4"><path d="M0 0H8L4 4Z" fill="${hex}"/></svg>`,
        name: "icon/chevron-down",
        constraints: { horizontal: "MAX", vertical: "CENTER" },
      });
    }
    const hexOf = (col) => {
      const c = parseColor(col) || { r: 0, g: 0, b: 0, a: 1 };
      return "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    };
    if (n.tag === "input" && n.inputType === "checkbox" && n.before && n.before.opacity !== "0") {
      // daisyUI draws the check with a clipped ::before shown only when checked; draw a check
      // of the same color in its place
      const size = round2(Math.min(n.box.w, n.box.h) * 0.7);
      w.children.push({
        kind: "svg",
        tag: "svg",
        chain,
        style: n.style,
        absolute: true,
        box: { x: n.box.x + (n.box.w - size) / 2, y: n.box.y + (n.box.h - size) / 2, w: size, h: size },
        svgOverride: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${hexOf(n.before.backgroundColor)}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
        name: "icon/check",
        constraints: { horizontal: "CENTER", vertical: "CENTER" },
      });
    }
    if (n.tag === "input" && n.inputType === "date") {
      // the calendar button the browser draws at the right end of a date field
      w.children.push({
        kind: "svg",
        tag: "svg",
        chain,
        style: n.style,
        absolute: true,
        box: { x: n.box.x + n.box.w - n.style.padding[1] - 14, y: n.box.y + (n.box.h - 14) / 2, w: 14, h: 14 },
        svgOverride: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${hexOf(n.style.color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
        name: "icon/calendar",
        constraints: { horizontal: "MAX", vertical: "CENTER" },
      });
    }
    return w;
  }
  if (n.tag === "progress" && n.progress && n.progress.position >= 0) {
    // the filled part (value / max) is drawn outside the DOM; draw it as a shape
    const pw = round2(n.box.w * n.progress.position), ph = round2(n.box.h);
    const r = Math.min((n.style.radius || [0])[0] || 0, ph / 2, pw / 2);
    const pc = parseColor(n.progress.color) || { r: 0, g: 0, b: 0, a: 1 };
    const hex = "#" + [pc.r, pc.g, pc.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const d = r > 0 ? `M${r} 0H${pw - r}A${r} ${r} 0 0 1 ${pw - r} ${ph}H${r}A${r} ${r} 0 0 1 ${r} 0Z` : `M0 0H${pw}V${ph}H0Z`;
    if (pw > 0) w.children.push({
      kind: "svg",
      tag: "svg",
      chain,
      style: n.style,
      absolute: true,
      box: { x: n.box.x, y: n.box.y, w: pw, h: ph },
      svgOverride: `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}"><path d="${d}" fill="${hex}"/></svg>`,
      name: "progress-value",
      constraints: { horizontal: "MIN", vertical: "CENTER" },
    });
    return w;
  }
  if (n.text) {
    const lh = n.style.lineHeight;
    const lines = Math.max(1, n.lineCount || 1);
    const tb = n.textBox || n.box;
    const h = lh ? lh * lines : tb.h;
    if (textIsSelf(n)) {
      w.kind = "text";
      w.runs = n.text;
      // The element's own box is the text box.
      const selfH = lh && Math.abs(n.box.h - h) > lh / 2 ? n.box.h : h;
      w.box = { x: n.box.x, y: n.box.y + (n.box.h - selfH) / 2, w: n.box.w, h: selfH };
      w.textBox = tb;
      return w;
    }
    const cbx = w.content;
    const blockLine = !/flex|grid/.test(n.style.display) && lines === 1 && lh && Math.abs(cbx.h - h) <= 1;
    // text cut off with "…" (Tailwind truncate) is as wide as its box, not as its words
    const cut = n.style.textOverflow === "ellipsis" && /nowrap/.test(n.style.whiteSpace || "");
    w.children.push({
      kind: "text",
      tag: "#text",
      chain,
      style: { ...n.style, margin: [0, 0, 0, 0], lineClamp: "none" },
      runs: n.text,
      box: { x: cut ? cbx.x : tb.x, y: blockLine ? cbx.y : tb.y + tb.h / 2 - h / 2, w: cut ? cbx.w : tb.w, h },
      textBox: cut ? { ...tb, x: cbx.x, w: cbx.w } : tb,
      lineCount: lines,
      fillWidth: cut || undefined,
    });
    return w;
  }
  for (const which of ["before", "after"]) {
    const ps = n[which];
    const svg = ps && pseudoBorderSvg(n, ps);
    if (svg) w.children.push(svg);
  }
  for (const c of n.children || []) {
    if (c.tag === "#text") {
      const lh = c.style.lineHeight;
      const lines = Math.max(1, c.lineCount || 1);
      const h = lh ? lh * lines : c.box.h;
      w.children.push({ kind: "text", tag: "#text", chain, style: { ...c.style, margin: [0, 0, 0, 0] }, runs: c.text, box: { x: c.box.x, y: c.box.y + c.box.h / 2 - h / 2, w: c.box.w, h }, textBox: c.box, lineCount: lines });
      continue;
    }
    w.children.push(normalize(c, [n, ...ancestors]));
  }
  return w;
}

// A CSS-drawn arrow: an empty pseudo-element with borders on some sides, often rotated
// (e.g. `border-top/right: 1px; transform: rotate(45deg)`). Reproduced as line vectors.
function pseudoBorderSvg(n, ps) {
  if (!/^["']{2}$/.test(ps.content || "")) return null;
  if (ps.position !== "absolute") return null;
  const w = parseFloat(ps.width), h = parseFloat(ps.height);
  const bw = String(ps.borderWidth || "").split(/\s+/).map(parseFloat);
  const [t, r, b, l] = bw.length === 1 ? [bw[0], bw[0], bw[0], bw[0]] : bw.length === 2 ? [bw[0], bw[1], bw[0], bw[1]] : bw.length === 3 ? [bw[0], bw[1], bw[2], bw[1]] : bw;
  if (!(w > 0 && h > 0) || ![t, r, b, l].some((x) => x > 0)) return null;
  const color = parseColor((String(ps.borderColor || "").match(/(rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\))/) || [])[1]) || { r: 0, g: 0, b: 0, a: 1 };
  // positioned against the element's padding box
  const st = n.style;
  const bl = st.borderStyle[3] === "none" ? 0 : st.borderWidth[3];
  const btop = st.borderStyle[0] === "none" ? 0 : st.borderWidth[0];
  const left = parseFloat(ps.left), top = parseFloat(ps.top);
  if (Number.isNaN(left) || Number.isNaN(top)) return null;
  const m = (String(ps.transform || "").match(/matrix\(([^)]+)\)/) || [])[1];
  const [a, bb, c, d, e, f] = m ? m.split(",").map(parseFloat) : [1, 0, 0, 1, 0, 0];
  const ox = w / 2, oy = h / 2;
  const tf = ([x, y]) => [ox + a * (x - ox) + c * (y - oy) + e, oy + bb * (x - ox) + d * (y - oy) + f];
  const segs = [];
  if (t > 0) segs.push([[0, 0], [w, 0]]);
  if (r > 0) segs.push([[w, 0], [w, h]]);
  if (b > 0) segs.push([[w, h], [0, h]]);
  if (l > 0) segs.push([[0, h], [0, 0]]);
  const pts = segs.flat().map(tf);
  const sw = Math.max(t, r, b, l);
  const minX = Math.min(...pts.map((p) => p[0])) - sw / 2, maxX = Math.max(...pts.map((p) => p[0])) + sw / 2;
  const minY = Math.min(...pts.map((p) => p[1])) - sw / 2, maxY = Math.max(...pts.map((p) => p[1])) + sw / 2;
  const hex = "#" + [color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  const lines = segs.map(([p, q]) => {
    const [x1, y1] = tf(p), [x2, y2] = tf(q);
    return `<line x1="${round2(x1 - minX)}" y1="${round2(y1 - minY)}" x2="${round2(x2 - minX)}" y2="${round2(y2 - minY)}" stroke="${hex}" stroke-width="${sw}" stroke-linecap="square"/>`;
  }).join("");
  const W = round2(maxX - minX), H = round2(maxY - minY);
  return {
    kind: "svg",
    tag: "svg",
    chain: [n.cls],
    style: n.style,
    absolute: true,
    box: { x: n.box.x + bl + left + minX, y: n.box.y + btop + top + minY, w: W, h: H },
    svgOverride: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${lines}</svg>`,
    name: "icon/arrow (::" + "before)",
  };
}

// ---------- simplification ----------
function simplify(w) {
  if (w.kind !== "frame") return w;
  w.children = w.children.map(simplify).filter(Boolean);
  // Drop empty, invisible wrappers; an empty box with a set width (w-24) is a spacer that
  // keeps a flex row balanced, so it stays
  if (w.children.length === 0 && !isVisual(w)) return w.box.w >= 1 && fixedClass(w, "w") ? w : null;
  if (w.children.length !== 1) return w;
  const c = w.children[0];
  if (w.absolute && c.kind !== "frame") {
    // keep the positioned wrapper's placement on the child
  }
  // R2: invisible parent, same box -> the child takes its place.
  if (!isVisual(w) && sameBox(w.box, c.box) && !(w.component && c.component)) {
    if (w.component && !c.component) c.component = w.component;
    if (!c.component && !SEMANTIC.has(c.tag) && SEMANTIC.has(w.tag)) {
      c.semanticName = w.tag;
    }
    if (w.absolute) c.absolute = true;
    c.extraCls = [c.extraCls, w.cls, w.extraCls].filter(Boolean).join(" ");
    if (/^inline/.test(w.style.display || "")) c.wrapperInline = true;
    if (w.src && w.src.declared) c.wrapperDeclared = Object.assign({}, w.src.declared, c.wrapperDeclared || {});
    c.margin = w.style.margin;
    c.flexGrowFrom = w.style.flexGrow;
    if (w.style.alignSelf) c.alignSelfFrom = w.style.alignSelf;
    return c;
  }
  // R3: invisible child frame with the same box -> parent absorbs its layout and children.
  if (c.kind === "frame" && !isVisual(c) && sameBox(w.box, c.box) && !(w.component && c.component)) {
    w.component = w.component || c.component;
    w.layoutFrom = c.layoutFrom || c;
    w.children = c.children;
    w.content = c.content;
    return w;
  }
  // R4: a clipping wrapper whose only child is an image of the same size -> one image.
  if (c.kind === "image" && sameBox(w.box, c.box)) {
    c.radius = w.style.radius;
    c.wrapperName = nodeName(w) === "div" ? null : nodeName(w);
    return c;
  }
  // R5: an invisible plain child that spans the parent's content width hands its children up.
  const padded = (k) => (k.style.padding || []).some((p) => p > 0);
  const keepsBoundary = c.component && (isVisual(w) || padded(w));
  // a flex or grid parent keeps its own alignment (centering) instead of taking the child's
  const parentLaysOut = /flex|grid/.test(w.style.display) && !sameBox(c.box, w.content || c.box);
  if (c.kind === "frame" && !isVisual(c) && (isPlain(c) || isPlain(w)) && !(c.component && w.component) && !c.absolute && !keepsBoundary && !parentLaysOut) {
    const pc = w.content;
    if (Math.abs(c.box.x - pc.x) < EPS && Math.abs(c.box.w - pc.w) < EPS) {
      if (isPlain(w) && !w.component) {
        w.component = c.component;
        if (!c.component && !isPlain(c)) w.semanticName = c.tag;
      } else if (c.component && !w.component) {
        w.component = c.component;
      }
      w.layoutFrom = c.layoutFrom || c;
      w.children = c.children;
      w.content = { x: c.content.x, y: Math.min(c.content.y, w.content.y), w: c.content.w, h: c.content.h };
      w.content = c.content;
      return w;
    }
  }
  return w;
}

// ---------- layout ----------
function layoutStyle(w) {
  return (w.layoutFrom || w).style;
}
function axisInfo(mode) {
  return mode === "HORIZONTAL" ? { s: "x", z: "w", cs: "y", cz: "h" } : { s: "y", z: "h", cs: "x", cz: "w" };
}

function fixedClass(w, axis) {
  const re = axis === "w" ? /^(w-(?!full|auto|fit|screen)|max-w-|size-)/ : /^(h-(?!full|auto|fit)|min-h-|max-h-|size-)/;
  const node = w.src || w;
  const all = [w.cls, w.extraCls, w.layoutFrom && w.layoutFrom.cls].filter(Boolean).join(" ");
  const hit = all.split(/\s+/).map((c) => c.replace(/^([a-z0-9]+:)+/, "")).find((c) => re.test(c));
  if (hit) return hit;
  const cls = classList(node);
  // plain CSS: a width/height rule that applies to the element
  // the element's own rule first; a relative one (100%) defers to the removed wrapper's
  const own = (w.src && w.src.declared) || w.declared || {};
  const keys = axis === "w" ? ["width", "max-width", "flex-basis"] : ["height", "min-height", "max-height"];
  const absolute = (v) => v && !/(100%|auto|fit-content)/.test(v.split(":").pop());
  for (const k of keys) {
    if (absolute(own[k])) return `css ${own[k]}`;
    if (w.wrapperDeclared && absolute(w.wrapperDeclared[k])) return `css ${w.wrapperDeclared[k]}`;
  }
  if (axis === "h" && (w.style || {}).display === "table-row") return "table row height";
  for (const d of ["btn-square", "btn-circle"]) if (cls.includes(d)) return `${d} (daisyUI)`;
  if (axis === "h") for (const d of ["btn", "input", "select", "badge", "navbar", "drawer-side"]) if (cls.includes(d)) return `${d} (daisyUI)`;
  return null;
}

function decideLayout(w) {
  const s = layoutStyle(w);
  const flow = w.children.filter((c) => !c.absolute);
  const display = s.display;
  let mode;
  const isFlex = /flex/.test(display);
  if (w.forcedMode) {
    mode = w.forcedMode;
  } else if (isFlex) {
    mode = s.flexDirection.startsWith("column") ? "VERTICAL" : "HORIZONTAL";
  } else if (flow.length <= 1) {
    mode = "VERTICAL";
  } else {
    // Grid and table placement can differ from source order: use the visual order.
    const byY = flow.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const byX = flow.slice().sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
    if (byY.every((c, i) => i === 0 || c.box.y >= byY[i - 1].box.y + byY[i - 1].box.h - 1)) {
      mode = "VERTICAL";
      w.children = [...byY, ...w.children.filter((c) => c.absolute)];
    } else if (byX.every((c, i) => i === 0 || c.box.x >= byX[i - 1].box.x + byX[i - 1].box.w - 1)) {
      mode = "HORIZONTAL";
      w.children = [...byX, ...w.children.filter((c) => c.absolute)];
    } else {
      mode = "NONE";
    }
  }
  w.mode = mode;
  w.isFlex = isFlex;
  if (mode !== "NONE") flow.splice(0, flow.length, ...w.children.filter((c) => !c.absolute));
  w.isGrid = display.includes("grid");
  if (mode === "NONE") return;
  const ax = axisInfo(mode);
  const box = w.box;
  const cb = w.content;
  // cross-axis padding from the content box
  const padCrossStart = cb[ax.cs] - box[ax.cs];
  const padCrossEnd = box[ax.cs] + box[ax.cz] - (cb[ax.cs] + cb[ax.cz]);
  let primary = "MIN";
  if (isFlex) {
    const jc = s.justifyContent;
    if (/center/.test(jc)) primary = "CENTER";
    else if (/space-between/.test(jc)) primary = "SPACE_BETWEEN";
    else if (/flex-end|^end/.test(jc)) primary = "MAX";
    else if (/space-(around|evenly)/.test(jc)) primary = "SPACE_BETWEEN";
  }
  if (flow.length === 1 && primary === "SPACE_BETWEEN") primary = "MIN";
  if (!isFlex && display === "table-cell" && mode === "VERTICAL" && s.verticalAlign === "middle") primary = "CENTER";
  let counter = "MIN";
  if (isFlex) {
    const ai = s.alignItems;
    if (/center/.test(ai)) counter = "CENTER";
    else if (/flex-end|^end/.test(ai)) counter = "MAX";
    else if (/baseline/.test(ai) && mode === "HORIZONTAL") counter = "BASELINE";
  }
  if (!isFlex || counter === "MIN") {
    // infer from geometry for children that do not span the cross axis
    const narrow = flow.filter((c) => Math.abs(c.box[ax.cz] - cb[ax.cz]) > EPS);
    if (narrow.length) {
      const pos = narrow.map((c) => {
        const before = c.box[ax.cs] - cb[ax.cs];
        const after = cb[ax.cs] + cb[ax.cz] - (c.box[ax.cs] + c.box[ax.cz]);
        if (Math.abs(before - after) <= 1) return "CENTER";
        if (Math.abs(before) <= 1) return "MIN";
        if (Math.abs(after) <= 1) return "MAX";
        return "OTHER";
      });
      if (pos.every((p) => p === "CENTER")) counter = "CENTER";
      else if (pos.every((p) => p === "MAX")) counter = "MAX";
      else if (!isFlex && pos.every((p) => p === "MIN")) counter = "MIN";
      else if (!isFlex) {
        // mixed alignment: wrap each odd child in a full-width wrapper aligned on its own
        w.children = w.children.map((c, i) => {
          if (c.absolute) return c;
          const k = flow.indexOf(c);
          if (k < 0 || pos[narrow.indexOf(c)] === undefined) return c;
          const p = pos[narrow.indexOf(c)];
          if (p === "MIN") return c;
          const wb = { ...c.box };
          wb[ax.cs] = cb[ax.cs];
          wb[ax.cz] = cb[ax.cz];
          return { kind: "frame", synthetic: true, name: "align-wrapper", box: wb, content: { ...wb }, style: { ...c.style, display: "block", padding: [0, 0, 0, 0], borderWidth: [0, 0, 0, 0], borderStyle: ["none", "none", "none", "none"], backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none", overflowX: "visible", overflowY: "visible", opacity: 1, flexGrow: 0 }, children: [c], forcedCounter: p === "OTHER" ? "MIN" : p, chain: c.chain || [] };
        });
        return decideLayout(w);
      }
    }
  }
  if (w.forcedCounter) counter = w.forcedCounter;
  // main-axis geometry
  const starts = flow.map((c) => c.box[ax.s]);
  const ends = flow.map((c) => c.box[ax.s] + c.box[ax.z]);
  const gaps = flow.slice(1).map((c, i) => round2(starts[i + 1] - ends[i]));
  const lead = flow.length ? round2(starts[0] - box[ax.s]) : round2(cb[ax.s] - box[ax.s]);
  const trail = flow.length ? round2(box[ax.s] + box[ax.z] - ends[ends.length - 1]) : round2(box[ax.s] + box[ax.z] - (cb[ax.s] + cb[ax.z]));
  const cssStart = round2(cb[ax.s] - box[ax.s]);
  const cssEnd = round2(box[ax.s] + box[ax.z] - (cb[ax.s] + cb[ax.z]));
  const snap = (v) => {
    const r = Math.round(v * 2) / 2;
    return Math.abs(r) < 0.75 ? 0 : r;
  };
  const marginOf = (c) => (c.margin || (c.style && c.style.margin) || [0, 0, 0, 0]);
  const lastMargin = flow.length ? Math.max(0, marginOf(flow[flow.length - 1])[mode === "HORIZONTAL" ? 1 : 2]) : 0;
  const collapses = mode === "VERTICAL" && !isFlex && cssEnd < 0.5;
  const naturalTrail = cssEnd + (collapses ? 0 : lastMargin);
  // More space after the last child than padding + margin: the size comes from outside
  // (stretched by a row, a fixed height, a table column), so keep the CSS padding.
  const sizedFromOutside = primary === "MIN" && trail - naturalTrail > 1;
  const widthFromOutside = mode === "HORIZONTAL" && sizedFromOutside;
  w.layout = {
    mode, primary, counter,
    padCrossStart: snap(padCrossStart), padCrossEnd: snap(padCrossEnd),
    gaps: gaps.map(snap), lead: snap(lead), trail: sizedFromOutside ? snap(naturalTrail) : snap(trail),
    cssStart: snap(cssStart), cssEnd: snap(cssEnd), naturalTrail: snap(naturalTrail), wrap: s.flexWrap === "wrap", widthFromOutside, sizedFromOutside,
  };
}

// Group consecutive children so that every frame has one uniform gap.
function regroup(w) {
  const L = w.layout;
  if (!L || L.primary !== "MIN" || L.gaps.length < 2) return;
  const uniform = (g) => g.every((x) => Math.abs(x - g[0]) <= 0.5);
  if (uniform(L.gaps)) return;
  const ax = axisInfo(L.mode);
  let items = w.children.filter((c) => !c.absolute);
  const abs = w.children.filter((c) => c.absolute);
  let gaps = L.gaps.slice();
  let guard = 0;
  while (!uniform(gaps) && guard++ < 20) {
    const m = Math.min(...gaps);
    const nextItems = [];
    const nextGaps = [];
    let i = 0;
    while (i < items.length) {
      let j = i;
      while (j < gaps.length && Math.abs(gaps[j] - m) <= 0.5) j++;
      if (j > i) {
        const members = items.slice(i, j + 1);
        const x0 = Math.min(...members.map((c) => c.box.x));
        const y0 = Math.min(...members.map((c) => c.box.y));
        const x1 = Math.max(...members.map((c) => c.box.x + c.box.w));
        const y1 = Math.max(...members.map((c) => c.box.y + c.box.h));
        const gb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const memberName = (k) => k.name || k.component || k.semanticName || (k.kind === "text" ? (k.src && k.src.tag && k.src.tag !== "#text" ? k.src.tag : "text") : nodeName(k.src || k));
        const names = members.map(memberName);
        const label = names.length > 3 ? `${names.slice(0, 3).join(" + ")} …` : names.join(" + ");
        // a group cut out of a flex row is still a flex row: its items shrink to fit, and it
        // stretches when one of its items does (flex-grow)
        const fromStyle = (w.layoutFrom || w).style || {};
        const groupDisplay = /flex/.test(fromStyle.display || "") ? "flex" : "block";
        const groupGrow = members.some((k) => ((k.style || {}).flexGrow || 0) > 0 || (k.flexGrowFrom || 0) > 0) ? 1 : 0;
        nextItems.push({ kind: "frame", synthetic: true, name: label, box: gb, content: { ...gb }, style: { ...fromStyle, display: groupDisplay, padding: [0, 0, 0, 0], borderWidth: [0, 0, 0, 0], borderStyle: ["none", "none", "none", "none"], backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none", overflowX: "visible", overflowY: "visible", opacity: 1, justifyContent: "normal", alignItems: "normal", flexGrow: groupGrow }, children: members, chain: w.chain || [], forcedMode: L.mode, forcedCounter: L.counter === "BASELINE" ? "MIN" : L.counter });
        if (j < gaps.length) nextGaps.push(gaps[j]);
        i = j + 1;
      } else {
        nextItems.push(items[i]);
        if (i < gaps.length) nextGaps.push(gaps[i]);
        i++;
      }
    }
    items = nextItems;
    gaps = nextGaps;
  }
  w.children = [...items, ...abs];
  L.gaps = gaps;
}

// ---------- sizing ----------
function hugExtent(c, axis) {
  if (c.kind === "text") return axis === "w" ? (c.textBox ? c.textBox.w : c.box.w) : c.box.h;
  if (c.kind !== "frame" || !c.layout) return null;
  const L = c.layout;
  const ax = axisInfo(L.mode);
  const flow = c.children.filter((k) => !k.absolute);
  if (axis === ax.z) {
    const sum = flow.reduce((a, k) => a + k.box[ax.z], 0);
    const gapSum = L.gaps.length ? L.gaps.reduce((a, g) => a + g, 0) : 0;
    // centered or end-aligned content: Figma hugs with the CSS padding only
    if (L.primary !== "MIN") return withMinWidth(c, axis, L.cssStart + sum + (L.primary === "SPACE_BETWEEN" ? 0 : gapSum) + L.cssEnd);
    return withMinWidth(c, axis, L.lead + sum + gapSum + L.trail);
  }
  const max = flow.length ? Math.max(...flow.map((k) => k.box[ax.cz])) : 0;
  return withMinWidth(c, axis, L.padCrossStart + max + L.padCrossEnd);
}

function withMinWidth(c, axis, v) {
  const minW = c.style && c.style.minWidth;
  return axis === "w" && minW > 0 ? Math.max(v, minW) : v;
}

// Equal columns (grid-cols-N) all fill; otherwise content-sized columns hug and the
// widest remaining column takes the rest (auto + 1fr).
function gridColumnFills(c, parent) {
  const cols = parent.children.filter((k) => !k.absolute);
  const equal = cols.every((k) => Math.abs(k.box.w - cols[0].box.w) <= 1);
  if (equal) return true;
  if (fixedClass(c, "w")) return false;
  const hugs = (k) => k.kind === "frame" && k.layout && Math.abs(hugExtent(k, "w") - k.box.w) <= 1 && !k.layout.widthFromOutside && (k.children || []).every((g) => Math.abs(g.box.w - k.content.w) > 1 || g.kind !== "frame" || !/flex-1|w-full/.test(g.cls || ""));
  const rest = cols.filter((k) => !(hugs(k) && k.box.w < Math.max(...cols.map((q) => q.box.w))));
  return rest.includes(c) && c.box.w === Math.max(...rest.map((q) => q.box.w));
}

const clampOf = (k) => {
  const v = parseInt((k.style || {}).lineClamp, 10);
  return v > 0 ? v : 0;
};

// Width of a box in CSS comes from its container unless it shrinks to fit its content.
function shrinksToFit(c, parent) {
  const st = c.style || {};
  if (/^inline/.test(st.display || "") || c.wrapperInline) return true;
  if (c.absolute) return true;
  if (parent.isFlex && parent.layout.mode === "HORIZONTAL") return true;
  if (parent.isFlex && parent.layout.mode === "VERTICAL") {
    const ai = layoutStyle(parent).alignItems || "";
    const as = st.alignSelf || "auto";
    if (/center|start|end/.test(as)) return true;
    if (/center|start|end|baseline/.test(ai) && !/stretch/.test(as)) return true;
  }
  return false;
}

// Children of a flex row that share the width equally (daisyUI navbar-start/end: 50%).
function equalSplit(parent) {
  const cols = parent.children.filter((k) => !k.absolute);
  if (cols.length < 2) return false;
  const gaps = parent.layout.gaps.reduce((a, g) => a + g, 0);
  const sum = cols.reduce((a, k) => a + k.box.w, 0);
  return cols.every((k) => Math.abs(k.box.w - cols[0].box.w) <= 1) && Math.abs(sum + gaps - parent.content.w) <= 1;
}

// The width a box would take if nothing limited it (CSS max-content): wrapped text counts
// as unbounded.
function intrinsicWidth(k) {
  if (k.kind === "text") return k.lineCount > 1 ? Infinity : k.textBox ? k.textBox.w : k.box.w;
  if (k.kind !== "frame") return k.box.w;
  if (fixedClass(k, "w")) return k.box.w;
  const flow = (k.children || []).filter((x) => !x.absolute);
  if (!k.layout || !flow.length) return k.box.w;
  const L = k.layout;
  if (L.mode === "HORIZONTAL") {
    const gaps = L.gaps.reduce((a, g) => a + g, 0);
    return L.lead + flow.reduce((a, x) => a + intrinsicWidth(x), 0) + gaps + L.trail;
  }
  return L.padCrossStart + Math.max(...flow.map(intrinsicWidth)) + L.padCrossEnd;
}

function decideSizing(c, parent) {
  const pm = parent && parent.layout ? parent.layout.mode : "NONE";
  const sz = { h: "FIXED", v: "FIXED" };
  if (!parent || pm === "NONE" || c.absolute) {
    // positioned layers keep their measured box; say why
    if (parent) {
      const pos = (c.style || {}).position;
      const why = c.absolute ? `position: ${pos} (placed over the layout)` : "overlapping layers (free placement in the parent)";
      sz.sourceW = fixedSource(c, parent, "w") || why;
      sz.sourceH = fixedSource(c, parent, "h") || why;
    }
    return sz;
  }
  const ax = axisInfo(pm);
  const key = (axis) => (axis === "w" ? "h" : "v");
  const pcb = parent.content;
  const parentSz = parent.sizingDecided || { h: "FIXED", v: "FIXED" };
  const cs = c.style || {};
  const grow = (cs.flexGrow || 0) > 0 || (c.flexGrowFrom || 0) > 0;
  const hugMatches = (k, axis) => {
    if (k.kind === "image" || k.kind === "svg") return false;
    if (k.kind === "text" && axis === "w" && (k.lineCount > 1 || clampOf(k))) return false;
    if (k.layout && k.layout.sizedFromOutside && axis === (k.layout.mode === "HORIZONTAL" ? "w" : "h")) return false;
    const hug = hugExtent(k, axis);
    return hug !== null && Math.abs(hug - k.box[axis]) <= 1;
  };
  const sizesItself = (k, axis) => k.kind === "image" || k.kind === "svg" || !!fixedClass(k, axis) || hugMatches(k, axis);

  for (const axis of ["w", "h"]) {
    const isMain = axis === ax.z;
    const parentHugs = parentSz[key(axis)] === "HUG";
    const spans = Math.abs(c.box[axis] - pcb[axis]) <= EPS;
    let v;
    if (c.kind === "svg") v = "FIXED";
    else if (isMain && grow && parent.isFlex && !parentHugs) v = "FILL";
    else if (isMain && axis === "w" && parent.isGrid && pm === "HORIZONTAL" && !parentHugs && gridColumnFills(c, parent)) v = "FILL";
    else if (isMain && axis === "w" && parent.isFlex && pm === "HORIZONTAL" && !parentHugs && equalSplit(parent)) v = "FILL";
    else if (axis === "w") {
      // single-line, unclamped text shrinks to its words; wrapped or clamped text needs a width
      const fullWidth = hasClass(c, /^w-full$/) || /:\s*100%/.test((((c.src || c).declared || {}).width) || "");
      const shrink = c.kind === "text" ? !!(c.textBox && Math.abs(c.textBox.w - c.box.w) <= 1) && c.lineCount <= 1 && !clampOf(c) : shrinksToFit(c, parent) && !fullWidth;
      const rowMain = isMain && pm === "HORIZONTAL" && !grow;
      const soleTextInFixed = c.kind === "text" && isMain && pm === "HORIZONTAL" && parent.children.filter((k) => !k.absolute).length === 1 && fixedClass(parent, "w") && parent.layout.primary === "CENTER";
      if (soleTextInFixed) {
        v = "FILL";
        c.alignCenter = true;
      } else if (c.kind === "text" && c.fillWidth && !parentHugs) v = "FILL";
      else if (spans && !parentHugs && !rowMain && (!shrink || c.kind === "text")) v = "FILL";
      // a flex item that would be wider than its share (its text wraps) is squeezed by the
      // row: it takes the space the other items leave
      else if (!parentHugs && rowMain && parent.isFlex && c.kind === "frame" && !fixedClass(c, "w") && intrinsicWidth(c) > c.box.w + 1) v = "FILL";
      // a group made only to even out gaps is as wide as its widest member
      else if (c.synthetic && hugMatches(c, "w")) v = "HUG";
      else if (spans && parentHugs && !rowMain) {
        // the parent takes the width of its widest child: that child hugs, the others fill
        const others = parent.children.filter((k) => !k.absolute && k !== c && Math.abs(k.box.w - pcb.w) <= EPS && sizesItself(k, "w"));
        if (sizesItself(c, "w")) v = c.kind === "text" || (c.kind === "frame" && !fixedClass(c, "w")) ? "HUG" : "FIXED";
        else v = others.length ? "FILL" : "FIXED";
      } else if (c.kind === "text") v = shrink ? "HUG" : "FIXED";
      else if (c.kind === "frame" && shrink && hugMatches(c, "w") && !fixedClass(c, "w")) v = "HUG";
      else v = "FIXED";
    } else {
      // height: content decides unless something fixes or stretches it
      if (c.kind === "text") v = "HUG";
      else if (!isMain && spans && c.kind !== "image") {
        if (!parentHugs) v = sizesItself(c, "h") && !fixedClass(c, "h") && hugMatches(c, "h") && parent.layout.counter !== "MIN" ? "HUG" : "FILL";
        else {
          const others = parent.children.filter((k) => !k.absolute && k !== c && Math.abs(k.box.h - pcb.h) <= EPS && sizesItself(k, "h"));
          v = sizesItself(c, "h") ? (fixedClass(c, "h") || !hugMatches(c, "h") ? "FIXED" : "HUG") : others.length ? "FILL" : "FIXED";
        }
      } else if (c.kind === "frame" && hugMatches(c, "h") && !fixedClass(c, "h")) v = "HUG";
      else v = "FIXED";
    }
    if (parent.layout.counter === "BASELINE" && !isMain && v === "FILL") v = "FIXED";
    sz[key(axis)] = v;
    // a single line that is the only child of a centering row is centered; this also holds
    // when Figma stretches it (a min-width parent makes its text child FILL)
    if (axis === "w" && c.kind === "text" && c.lineCount <= 1 && pm === "HORIZONTAL" && parent.layout.primary === "CENTER" && parent.children.filter((k) => !k.absolute).length === 1) c.alignCenter = true;
    if (v === "FIXED") sz[axis === "w" ? "sourceW" : "sourceH"] = fixedSource(c, parent, axis);
    // why a box that could fill its parent hugs instead (checked by compliance-check)
    if (v === "HUG" && axis === "w" && c.kind === "frame" && spans && shrinksToFit(c, parent)) {
      const st = c.style || {};
      sz.sourceW = /^inline/.test(st.display || "") ? `fits its content (display: ${st.display})` : parent.isFlex && pm === "VERTICAL" ? `fits its content (align-items: ${layoutStyle(parent).alignItems})` : "fits its content (flex item)";
    }
  }
  return sz;
}

// Where a FIXED size comes from, recorded on the node for the compliance check.
function fixedSource(c, parent, axis) {
  if (c.kind === "image") return "image (rendered size of the img element)";
  const pos = (c.style || {}).position;
  if (pos === "fixed") return "position: fixed (an overlay over the screen)";
  if (pos === "sticky" && parent.style && parent.style.position === "fixed") return "position: sticky inside a fixed overlay";
  if (c.kind === "svg") return c.name === "icon/chevron-down" ? "select arrow (daisyUI)" : c.name === "progress-value" ? "progress value (value / max of the progress bar)" : "icon size attribute";
  const cls = fixedClass(c, axis);
  if (cls) return `class ${cls}`;
  const d = (c.style || {}).display;
  if (d === "table-cell" || (parent.style || {}).display === "table-row") return "table column (table layout)";
  if (d === "table" || c.tag === "table") return "table width (table layout; scrolls inside overflow-x-auto when wider)";
  if (parent.isGrid) return "grid track";
  if (c.layout && c.layout.sizedFromOutside) return "stretched by its container";
  return null;
}

// ---------- emit ----------
function fontWeight(v) {
  return Math.round((v || 400) / 100) * 100;
}

function emitText(c, parent, tokens, styles) {
  const s = c.style;
  const runs = c.runs || [];
  const characters = textCharacters(runs);
  const baseColor = parseColor(runs[0] && runs[0].color ? runs[0].color : s.color);
  const fill = tokens.resolve(baseColor, c.chain || [], ["text"]);
  const weight = fontWeight(runs[0] ? runs[0].fontWeight : s.fontWeight);
  const size = runs[0] ? runs[0].fontSize : s.fontSize;
  const lineHeight = s.lineHeight;
  const styleName = textStyleName(size, weight, lineHeight);
  styles.text.set(styleName, { family: "Noto Sans JP", weight, size, lineHeight, letterSpacing: s.letterSpacing || 0 });
  const outRuns = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    const rc = parseColor(r.color);
    const run = { start: pos, end };
    let differs = false;
    if (fontWeight(r.fontWeight) !== weight) {
      run.weight = fontWeight(r.fontWeight);
      differs = true;
    }
    if (r.fontSize !== size) {
      run.size = r.fontSize;
      differs = true;
    }
    if (rc && baseColor && rgbKey(rc) !== rgbKey(baseColor)) {
      run.fill = tokens.resolve(rc, c.chain || [], ["text"]);
      differs = true;
    }
    // a bold or larger part gets a text style of its own, so the whole text stays styled
    if (run.weight || run.size) {
      const rs = run.size || size, rw = run.weight || weight;
      run.textStyle = textStyleName(rs, rw, lineHeight);
      styles.text.set(run.textStyle, { family: "Noto Sans JP", weight: rw, size: rs, lineHeight, letterSpacing: s.letterSpacing || 0 });
    }
    if (differs && end > pos) outRuns.push(run);
    pos = end;
  }
  const align = c.alignCenter ? "CENTER" : { center: "CENTER", right: "RIGHT", end: "RIGHT", justify: "JUSTIFIED" }[s.textAlign] || "LEFT";
  const clamp = parseInt(s.lineClamp, 10);
  const deco = s.textDecoration || (runs[0] && runs[0].textDecoration) || "";
  // text-overflow: ellipsis on one line (Tailwind truncate) ends with "…" in Figma too
  const ellipsis = s.textOverflow === "ellipsis" && /nowrap/.test(s.whiteSpace || "");
  const spec = {
    type: "TEXT",
    name: c.name || characters.replace(/\n/g, " ").slice(0, 40),
    w: round2(c.box.w),
    h: round2(c.box.h),
    text: {
      characters,
      family: "Noto Sans JP",
      weight,
      size,
      lineHeight,
      letterSpacing: s.letterSpacing || 0,
      align,
      decoration: /underline/.test(deco) ? "UNDERLINE" : /line-through/.test(deco) ? "STRIKETHROUGH" : "NONE",
      fill: fill || { color: { r: 0, g: 0, b: 0 }, opacity: 1 },
      runs: outRuns,
      maxLines: clamp > 0 ? clamp : ellipsis ? 1 : undefined,
    },
    textStyle: styleName,
  };
  return spec;
}

function emitBoxStyle(w, spec, tokens, styles) {
  const s = w.style;
  const chain = w.chain || [];
  const bg = parseColor(s.backgroundColor);
  spec.fills = bg && bg.a > 0 ? [tokens.resolve(bg, chain, ["bg"])] : [];
  const weights = s.borderWidth.map((x, i) => (s.borderStyle[i] === "none" ? 0 : x));
  if (weights.some((x) => x > 0)) {
    const idx = weights.findIndex((x) => x > 0);
    const bc = parseColor(s.borderColor[idx]);
    // border-transparent keeps its width (it reserves space and lets instances switch it on)
    if (bc && bc.a > 0) spec.strokes = { paints: [tokens.resolve(bc, chain, ["border"])], weights, align: "INSIDE" };
    else if (bc) spec.strokes = { paints: [{ color: { r: bc.r, g: bc.g, b: bc.b }, opacity: 0 }], weights, align: "INSIDE" };
  }
  if (s.radius.some((r) => r > 0)) spec.radius = s.radius.map((r) => Math.min(r, Math.min(w.box.w, w.box.h) / 2)).map(round2);
  const effects = parseShadows(s.boxShadow);
  if (effects.length) {
    const shadowClass = classList(w).map((c) => c.replace(/^([a-z0-9]+:)+/, "")).find((c) => /^shadow(-[a-z0-9]+)?$/.test(c));
    if (shadowClass) {
      spec.effectStyle = shadowClass;
      styles.effects.set(shadowClass, effects);
    } else spec.effects = effects;
  }
  if (s.overflowX !== "visible" || s.overflowY !== "visible") spec.clips = true;
  if (s.opacity !== 1) spec.opacity = s.opacity;
}

function emit(w, parent, tokens, styles, ctx) {
  const rel = (b) => (parent ? { x: round2(b.x - parent.box.x), y: round2(b.y - parent.box.y) } : { x: 0, y: 0 });
  const sizing = decideSizing(w, parent);
  // an empty spacer (w-24 with no content) has no height of its own
  if (w.kind === "frame" && !w.children.length && sizing.v === "FIXED" && !sizing.sourceH) sizing.sourceH = "empty spacer (no content)";
  const base = { w: round2(w.box.w), h: round2(w.box.h), ...rel(w.box), sizing };
  const src = w.src || w;
  if (src.tag && src.tag !== "#text" && src.tag !== "#value") base.dom = [src.tag, (src.cls || "").trim()].filter(Boolean).join(" .").slice(0, 200);
  if (w.absolute) {
    base.absolute = true;
    if (w.constraints) base.constraints = w.constraints;
    else if (parent) {
      const left = w.box.x - parent.box.x, right = parent.box.x + parent.box.w - (w.box.x + w.box.w);
      const top = w.box.y - parent.box.y, bottom = parent.box.y + parent.box.h - (w.box.y + w.box.h);
      base.constraints = {
        horizontal: Math.abs(left - right) <= 1 ? "CENTER" : right < left ? "MAX" : "MIN",
        vertical: Math.abs(top - bottom) <= 1 ? "CENTER" : bottom < top ? "MAX" : "MIN",
      };
    }
  }
  if (w.kind === "text") {
    const spec = emitText(w, parent, tokens, styles);
    return { ...spec, ...base, name: spec.name };
  }
  if (w.kind === "svg") {
    const svgOpacity = w.src && w.src.style && w.src.style.opacity !== 1 ? { opacity: w.src.style.opacity } : {};
    return { type: "SVG", name: w.name || nodeName(w.src || w), svg: w.svgOverride || w.src.svg, ...svgOpacity, ...base };
  }
  if (w.kind === "image") {
    const spec = { type: "IMAGE", name: NAMING !== "class" && w.wrapperName && w.wrapperName !== "div" ? w.wrapperName : nodeName(w.src), image: (w.src.src || "").split("/").pop().split("?")[0], scaleMode: w.src.style.objectFit === "contain" ? "FIT" : "FILL", ...base };
    if (w.radius && w.radius.some((r) => r > 0)) spec.radius = w.radius;
    if (w.src.style.radius.some((r) => r > 0)) spec.radius = w.src.style.radius;
    ctx.images.add(spec.image);
    return spec;
  }
  // frame
  w.sizingDecided = sizing;
  let name = w.name || (w.component ? w.component : w.semanticName || nodeName(w.src || w));
  const notes = [];
  const st = w.style || {};
  if (st.position === "sticky") {
    // a static comp cannot show sticking: say where it sticks and how tall it is
    const top = parseFloat(st.top) || 0;
    const vh = ctx.viewportHeight || 0;
    let note = top > 0 ? `sticky・上から${round2(top)}px` : "sticky";
    if (Math.abs(w.box.h - (vh - top)) <= 1 && top > 0) note += `・高さは画面の高さ−${round2(top)}px`;
    else if (Math.abs(w.box.h - vh) <= 1) note += "・高さは画面いっぱい";
    notes.push(note);
  }
  // content past the right edge, not counting what an inner clipping box already hides
  const clips = (x) => x.style && (x.style.overflowX !== "visible" || x.style.overflowY !== "visible");
  const overflowsX = (k) => (k.children || []).some((x) => x.box.x + x.box.w > w.box.x + w.box.w + 1 || (!clips(x) && overflowsX(x)));
  if ((st.overflowX === "auto" || st.overflowX === "scroll") && overflowsX(w)) notes.push("横スクロール");
  if (notes.length) name = `${name}（${notes.join("・")}）`;
  const spec = { type: "FRAME", name, ...base, children: [] };
  if (w.component) spec.component = w.component;
  if (notes.length) spec.notes = notes;
  if (notes.includes("横スクロール")) {
    spec.overflow = "HORIZONTAL";
    // Figma scrolls to the bounds of the children; when the browser scrolls further
    // (something overflows a cell), an invisible marker sets the same end
    const sw = w.src && w.src.scrollWidth;
    const reach = Math.max(0, ...w.children.map((k) => k.box.x + k.box.w - w.box.x));
    if (sw && sw > reach + 1) {
      w.scrollMarker = { type: "FRAME", name: `scroll-end（ブラウザの横スクロール幅 ${sw}px）`, w: 1, h: 1, x: sw - 1, y: 0, absolute: true, layout: { mode: "NONE" }, fills: [], sizing: { h: "FIXED", v: "FIXED", sourceW: `browser scrollWidth ${sw}px`, sourceH: "marker" }, children: [] };
    }
  }
  if (w.src) emitBoxStyle(w, spec, tokens, styles);
  // CSS draws box-shadow around the box even when it has no background; Figma casts it from
  // the layer's filled area, so a shadowed box gets the background that shows behind it
  ctx.bgStack = ctx.bgStack || [];
  const dropShadow = spec.effectStyle || (spec.effects || []).some((e) => e.type === "DROP_SHADOW");
  if (dropShadow && (!spec.fills || !spec.fills.length)) {
    spec.fills = [ctx.bgStack[ctx.bgStack.length - 1] || tokens.resolve({ r: 1, g: 1, b: 1, a: 1 }, [], ["bg"])];
    spec.fillSource = "the background behind it (CSS box-shadow on a transparent box)";
  }
  if (st.minWidth > 0 && sizing.h === "HUG") spec.minWidth = st.minWidth;
  const L = w.layout;
  if (L) {
    const isH = L.mode === "HORIZONTAL";
    let padStart, padEnd;
    if (L.primary === "MIN") {
      padStart = Math.max(0, L.lead);
      padEnd = sizing[isH ? "h" : "v"] === "HUG" || !parent ? Math.max(0, L.trail) : Math.max(0, L.naturalTrail);
      // a frame with no evidence of a fixed main size hugs its content
    } else {
      padStart = Math.max(0, L.cssStart);
      padEnd = Math.max(0, L.cssEnd);
    }
    const gap = L.primary === "SPACE_BETWEEN" ? 0 : L.gaps.length ? Math.max(0, L.gaps[0]) : 0;
    let padding = isH ? [L.padCrossStart, padEnd, L.padCrossEnd, padStart] : [padStart, L.padCrossEnd, padEnd, L.padCrossStart];
    if (spec.strokes) {
      // strokesIncludedInLayout makes the border take space as in CSS (border-box), so the
      // padding is the CSS value (pl-10 = 40, not 41)
      const bw = spec.strokes.weights;
      padding = padding.map((p, i) => Math.max(0, p - bw[i]));
      spec.strokesIncluded = true;
    }
    spec.layout = { mode: L.mode, gap: round2(gap), padding: padding.map(round2), primary: L.primary, counter: L.counter, wrap: !!L.wrap };
    if (padding.some((p) => p > 0)) spec.sourcePad = w.synthetic ? "child margins (measured)" : "CSS padding + border, child margins (measured)";
  } else {
    spec.layout = { mode: "NONE" };
  }
  const opaque = spec.fills && spec.fills.length && spec.fills[0].opacity !== 0 && !spec.fillSource;
  if (opaque) ctx.bgStack.push(spec.fills[0]);
  for (const c of w.children) {
    if (c.kind === "frame" && !c.src && !c.synthetic) continue;
    spec.children.push(emit(c, w, tokens, styles, ctx));
  }
  if (opaque) ctx.bgStack.pop();
  if (w.scrollMarker) spec.children.push(w.scrollMarker);
  return spec;
}

function prepare(w) {
  if (w.kind !== "frame") return;
  decideLayout(w);
  regroup(w);
  for (const c of w.children) prepare(c);
}

// When a frame's main-axis padding end was computed from trailing space but the frame
// ends up FIXED/FILL, keep the CSS padding instead (done in emit via sizing).

export function convertScreen(extract, opts = {}) {
  NAMING = extract.naming || null;
  const tokens = opts.tokens || new TokenRegistry(extract.tokens);
  const styles = opts.styles || { text: new Map(), effects: new Map() };
  const ctx = { images: opts.images || new Set(), viewportHeight: extract.viewportHeight || extract.viewport.h };
  let w = normalize(extract.root, []);
  w = simplify(w) || w;
  // The screen root fills the viewport width and the full document height.
  w.box = { x: 0, y: 0, w: extract.viewport.w, h: extract.docHeight };
  if (w.kind === "frame") {
    const s = w.style;
    w.content = contentBox({ box: w.box, style: s });
  }
  prepare(w);
  const spec = emit(w, null, tokens, styles, ctx);
  spec.sizing = { h: "FIXED", v: "FIXED", sourceW: `viewport ${extract.viewport.w}px`, sourceH: `document height ${extract.docHeight}px` };
  if (opts.layoutGrids) spec.layoutGrids = opts.layoutGrids;
  spec.clips = true;
  if (!spec.fills || !spec.fills.length) spec.fills = [tokens.resolve({ r: 1, g: 1, b: 1, a: 1 }, [], ["bg"])];
  return { spec, tokens, styles, images: ctx.images };
}
