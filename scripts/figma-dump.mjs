#!/usr/bin/env node
// Write the structure of a node (or the current page) to a JSON file.
// Usage: node scripts/figma-dump.mjs <nodeId|page> <out.json> [maxDepth]
import { writeFile } from "node:fs/promises";
import { connectFigma } from "./lib/figma-ws.mjs";

const [nodeId, out, depth] = process.argv.slice(2);
const figma = await connectFigma();
try {
  const tree = await figma.call("dump_tree", { nodeId: nodeId === "page" ? undefined : nodeId, maxDepth: Number(depth || 50) }, 120000);
  await writeFile(out, JSON.stringify(tree));
  console.log(JSON.stringify({ saved: out, name: tree.name, type: tree.type }));
} finally {
  figma.close();
}
