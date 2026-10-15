#!/usr/bin/env node
// Extract the rendered DOM of a running web app into a JSON tree that
// dom-to-figma.mjs turns into a Figma build spec.
//
// Usage:
//   node scripts/dom-extract.mjs --base http://localhost:5173 --out <dir> \
//     --screens screens.json [--widths 375,1366] [--heights 667,768] \
//     [--components PostCard,BlogHeader,...] [--chrome <path to Chrome>]
//
// screens.json: [{ "name": "home", "path": "/" }, ...]
// For each screen and width it writes <name>-<width>.json (tree) and
// <name>-<width>.png (full-page screenshot at device scale 1).

import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const base = arg("base", "http://localhost:5173");
const out = arg("out");
const screensFile = arg("screens");
const widths = arg("widths", "375,1366").split(",").map(Number);
const heights = arg("heights", "667,768").split(",").map(Number);
const components = (arg("components", "") || "").split(",").filter(Boolean);
// Plain HTML has no React components: --class-components "header,post,single_meta-cat=category"
// treats elements with these classes as component roots (name after "=" or the class).
const classComponents = Object.fromEntries(
  (arg("class-components", "") || "").split(",").filter(Boolean).map((x) => {
    const [cls, name] = x.split("=");
    return [cls, name || cls];
  })
);
// --full-height: measure long pages with the browser window as tall as the page, so
// elements sized to the screen (100dvh sidebars, sticky columns) span the whole design.
const fullHeight = process.argv.includes("--full-height");
const defaultChrome = path.join(
  process.env.HOME,
  "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
);
const chromePath = arg("chrome", existsSync(defaultChrome) ? defaultChrome : undefined);

if (!out || !screensFile) {
  console.error("--out and --screens are required");
  process.exit(2);
}

// Runs inside the page. Returns { root, docHeight, tokens }.
function extractInPage({ componentNames, classComponents }) {
  const wanted = new Set(componentNames);
  const vw = window.innerWidth;

  const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  function componentOf(el) {
    for (const c of el.classList || []) if (classComponents[c]) return classComponents[c];
    const key = fiberKey(el);
    if (!key) return null;
    let f = el[key] && el[key].return;
    let found = null;
    while (f && typeof f.type !== "string") {
      const nameOf = (t) =>
        t && (t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && t.render.name));
      // React.memo components keep their display name on elementType, not on type
      const name = nameOf(f.elementType) || nameOf(f.type);
      // the innermost app component owns this element
      if (name && wanted.has(name) && !found) found = name;
      f = f.return;
    }
    return found;
  }

  const px = (v) => (v === "normal" || v === "auto" || v === "" ? null : parseFloat(v));
  const box = (r) => ({
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    w: r.width,
    h: r.height,
  });

  function styleOf(cs) {
    return {
      display: cs.display,
      position: cs.position,
      top: cs.top,
      visibility: cs.visibility,
      opacity: parseFloat(cs.opacity),
      flexDirection: cs.flexDirection,
      flexWrap: cs.flexWrap,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      alignSelf: cs.alignSelf,
      flexGrow: parseFloat(cs.flexGrow),
      flexShrink: parseFloat(cs.flexShrink),
      rowGap: px(cs.rowGap),
      columnGap: px(cs.columnGap),
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
      margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(parseFloat),
      borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat),
      borderStyle: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
      borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat),
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      backgroundPosition: cs.backgroundPosition,
      backgroundSize: cs.backgroundSize,
      boxShadow: cs.boxShadow,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      color: cs.color,
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10),
      lineHeight: px(cs.lineHeight),
      letterSpacing: px(cs.letterSpacing),
      textAlign: cs.textAlign,
      textDecoration: cs.textDecorationLine,
      whiteSpace: cs.whiteSpace,
      lineClamp: cs.webkitLineClamp,
      transform: cs.transform,
      objectFit: cs.objectFit,
      zIndex: cs.zIndex,
      verticalAlign: cs.verticalAlign,
      minWidth: px(cs.minWidth),
      maxWidth: cs.maxWidth === "none" ? null : px(cs.maxWidth),
    };
  }

  function pseudo(el, which) {
    const cs = getComputedStyle(el, which);
    if (!cs || cs.content === "none" || cs.content === "normal" || cs.display === "none") return null;
    return {
      content: cs.content,
      display: cs.display,
      position: cs.position,
      width: cs.width,
      height: cs.height,
      top: cs.top,
      left: cs.left,
      right: cs.right,
      bottom: cs.bottom,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderWidth: cs.borderWidth,
      borderColor: cs.borderColor,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      maskImage: cs.maskImage || cs.webkitMaskImage,
      transform: cs.transform,
      opacity: cs.opacity,
    };
  }

  function textRuns(el) {
    // Collect visible text of an element whose content is inline-only, with a style per run.
    const runs = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const cs = getComputedStyle(node.parentElement);
        // white-space: pre-line / pre-wrap keep line breaks; normal collapses them
        const keepBreaks = /^pre|break-spaces/.test(cs.whiteSpace);
        const t = keepBreaks
          ? node.textContent.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n")
          : node.textContent.replace(/\s+/g, " ");
        if (!t) return;
        runs.push({
          text: t,
          color: cs.color,
          fontWeight: parseInt(cs.fontWeight, 10),
          fontSize: parseFloat(cs.fontSize),
          textDecoration: cs.textDecorationLine,
        });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const cs = getComputedStyle(node);
      if (cs.display === "none") return;
      if (node.tagName === "BR") {
        runs.push({ text: "\n", br: true });
        return;
      }
      node.childNodes.forEach(walk);
    };
    el.childNodes.forEach(walk);
    // Trim leading/trailing spaces and spaces around line breaks, as the browser does.
    let s = runs;
    for (let i = 0; i < s.length; i++) {
      if (s[i].br) {
        if (i > 0 && !s[i - 1].br) s[i - 1].text = s[i - 1].text.replace(/ $/, "");
        if (i + 1 < s.length && !s[i + 1].br) s[i + 1].text = s[i + 1].text.replace(/^ /, "");
      }
    }
    if (s.length && !s[0].br) s[0].text = s[0].text.replace(/^ /, "");
    if (s.length && !s[s.length - 1].br) s[s.length - 1].text = s[s.length - 1].text.replace(/ $/, "");
    return s.filter((r) => r.text.length > 0);
  }

  const INLINE = new Set(["inline", "contents"]);
  function isInlineOnly(el) {
    // True when every child is a text node, <br>, or an inline element containing only inline content.
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) continue;
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const cs = getComputedStyle(c);
      if (cs.display === "none") continue;
      if (c.tagName === "BR") continue;
      if (!INLINE.has(cs.display)) return false;
      if (["IMG", "SVG", "svg", "INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(c.tagName)) return false;
      if (!isInlineOnly(c)) return false;
    }
    return true;
  }

  function hasText(el) {
    return Array.from(el.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && c.textContent.trim());
  }

  // Content scrolled out of view inside an overflow-x container still belongs to the design.
  function insideScroller(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  }
  function visibleOnPage(r, cs, el) {
    if (r.width <= 0 || r.height <= 0) return false;
    if ((r.right <= 0 || r.left >= vw) && !insideScroller(el)) return false;
    if (cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  // Size declarations that apply to an element, from same-origin stylesheets (last wins).
  const sizeRules = [];
  const collectRules = (list) => {
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        if (window.matchMedia(rule.conditionText || rule.media.mediaText).matches) collectRules(rule.cssRules);
        continue;
      }
      if (!rule.style || !rule.selectorText) continue;
      const decl = {};
      for (const prop of ["width", "height", "min-width", "max-width", "min-height", "max-height", "flex-basis"]) {
        const v = rule.style.getPropertyValue(prop);
        if (v && v !== "auto" && v !== "none") decl[prop] = v;
      }
      if (Object.keys(decl).length) sizeRules.push({ selector: rule.selectorText, decl });
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectRules(sheet.cssRules);
    } catch (e) {}
  }
  function declaredSizes(el) {
    const out = {};
    for (const r of sizeRules) {
      let hit = false;
      try {
        hit = el.matches(r.selector);
      } catch (e) {}
      if (!hit) continue;
      for (const [k, v] of Object.entries(r.decl)) out[k] = `${r.selector} { ${k}: ${v} }`;
    }
    return Object.keys(out).length ? out : null;
  }

  function walk(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") return null;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const node = {
      tag,
      cls: typeof el.className === "string" ? el.className : el.getAttribute("class") || "",
      component: componentOf(el),
      box: box(r),
      style: styleOf(cs),
    };
    const declared = declaredSizes(el);
    if (declared) node.declared = declared;
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") node.scrollWidth = el.scrollWidth;
    if (!visibleOnPage(r, cs, el) && tag !== "html" && tag !== "body") {
      // Keep fixed-size invisible elements out entirely; their children are not rendered either.
      return null;
    }
    const before = pseudo(el, "::before");
    const after = pseudo(el, "::after");
    if (before) node.before = before;
    if (after) node.after = after;

    if (tag === "svg") {
      const clone = el.cloneNode(true);
      clone.setAttribute("width", String(r.width));
      clone.setAttribute("height", String(r.height));
      node.svg = clone.outerHTML.replace(/currentColor/g, cs.color);
      node.iconName = (node.cls.match(/lucide-([a-z0-9-]+)/g) || []).map((c) => c.replace("lucide-", "")).filter((n) => n !== "icon")[0] || null;
      return node;
    }
    if (tag === "img") {
      node.src = el.currentSrc || el.src;
      node.alt = el.alt;
      return node;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      node.inputType = el.type;
      if (tag === "select") {
        const opt = el.options[el.selectedIndex];
        node.value = opt ? opt.text : "";
      } else {
        node.value = el.value;
        node.placeholder = el.placeholder || "";
        node.placeholderColor = getComputedStyle(el, "::placeholder").color;
      }
      // Text box inside the control, measured from padding.
      return node;
    }

    if (hasText(el) || (el.childElementCount > 0 && isInlineOnly(el) && el.innerText.trim())) {
      if (isInlineOnly(el)) {
        node.text = textRuns(el);
        // Measure the laid-out text: union of client rects of its text.
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((q) => q.width > 0 && q.height > 0);
        if (rects.length) {
          const left = Math.min(...rects.map((q) => q.left));
          const right = Math.max(...rects.map((q) => q.right));
          const top = Math.min(...rects.map((q) => q.top));
          const bottom = Math.max(...rects.map((q) => q.bottom));
          node.textBox = box({ left, right, top, bottom, width: right - left, height: bottom - top });
          const tops = new Set(rects.map((q) => Math.round(q.top)));
          node.lineCount = tops.size;
        }
        return node;
      }
    }

    const kids = [];
    for (const c of el.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE) {
        const k = walk(c);
        if (k) kids.push(k);
      } else if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) {
        // Text mixed with block children: an anonymous text box.
        const range = document.createRange();
        range.selectNodeContents(c);
        const q = range.getBoundingClientRect();
        if (q.width > 0) {
          kids.push({
            tag: "#text",
            cls: "",
            component: null,
            box: box(q),
            style: styleOf(cs),
            text: [{ text: c.textContent.trim().replace(/\s+/g, " "), color: cs.color, fontWeight: parseInt(cs.fontWeight, 10), fontSize: parseFloat(cs.fontSize), textDecoration: cs.textDecorationLine }],
            textBox: box(q),
            lineCount: new Set(Array.from(range.getClientRects()).map((x) => Math.round(x.top))).size,
          });
        }
      }
    }
    node.children = kids;
    return node;
  }

  // Resolve every --color-* custom property on :root to rgb, so colors can be named by token.
  const tokens = {};
  const rootCs = getComputedStyle(document.documentElement);
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const scan = (list) => {
      for (const rule of Array.from(list)) {
        if (rule.style) {
          for (const prop of Array.from(rule.style)) {
            if (prop.startsWith("--color-") && !(prop in tokens)) {
              const v = rootCs.getPropertyValue(prop).trim();
              if (!v) continue;
              probe.style.color = `var(${prop})`;
              tokens[prop.slice(8)] = getComputedStyle(probe).color;
            }
            if (prop.startsWith("--shadow-") && !(`shadow:${prop}` in tokens)) {
              tokens[`shadow:${prop.slice(9)}`] = rootCs.getPropertyValue(prop).trim();
            }
          }
        }
        if (rule.cssRules) scan(rule.cssRules);
      }
    };
    scan(rules);
  }
  probe.remove();

  // React apps render into #root; a plain HTML page is the body itself
  const appRoot = document.getElementById("root") ? document.getElementById("root").firstElementChild : document.body;
  return {
    root: walk(appRoot),
    viewportHeight: window.innerHeight,
    docHeight: Math.max(document.documentElement.scrollHeight, window.innerHeight),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    tokens,
  };
}

const screens = JSON.parse(await readFile(screensFile, "utf8"));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  for (let i = 0; i < widths.length; i++) {
    const width = widths[i];
    const height = heights[i] || heights[heights.length - 1];
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    for (const screen of screens) {
      if (screen.widths && !screen.widths.includes(width)) continue;
      await page.goto(screen.url || base + screen.path, { waitUntil: "networkidle" });
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important} body:has(> #root)>:not(#root),#root>:not(:first-child),.tsqd-parent-container{display:none!important}",
      });
      await page.evaluate(() => document.fonts.ready);
      // a state to capture, e.g. an opened menu: "actions": [{ "click": "<selector>" }]
      for (const a of screen.actions || []) {
        if (a.click) await page.click(a.click);
      }
      await page.waitForTimeout(300);
      if (fullHeight) {
        for (let i = 0; i < 3; i++) {
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          const cur = page.viewportSize().height;
          if (h <= cur) break;
          await page.setViewportSize({ width, height: h });
          await page.waitForTimeout(300);
        }
      }
      const data = await page.evaluate(extractInPage, { componentNames: components, classComponents });
      data.standardViewport = { w: width, h: height };
      data.screen = screen;
      data.naming = screen.naming || null;
      const stem = path.join(out, `${screen.name}-${width}`);
      await writeFile(`${stem}.json`, JSON.stringify(data));
      await page.screenshot({ path: `${stem}.png`, fullPage: true });
      console.log(JSON.stringify({ screen: screen.name, width, docHeight: data.docHeight }));
      if (fullHeight) await page.setViewportSize({ width, height });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
