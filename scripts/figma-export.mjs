#!/usr/bin/env node
// Export every screen frame listed in a figma-build manifest as PNG (scale 1).
// Usage: node scripts/figma-export.mjs <manifest.json> <outDir>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectFigma } from "./lib/figma-ws.mjs";

const [manifestPath, outDir] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await mkdir(outDir, { recursive: true });
const figma = await connectFigma();
try {
  for (const [key, s] of Object.entries(manifest.screens)) {
    const r = await figma.call("export_node_as_image", { nodeId: s.id, scale: 1 }, 180000);
    const file = path.join(outDir, `${key}.png`);
    await writeFile(file, Buffer.from(r.imageData, "base64"));
    console.log(JSON.stringify({ key, file }));
  }
} finally {
  figma.close();
}
