#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (request, response) => {
  const relative = request.url === "/" ? "/index.html" : request.url;
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) { response.writeHead(403); response.end("Forbidden"); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
}).listen(8000, () => console.log("London Gig Planner: http://localhost:8000"));
