import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const inputPath = argument("--input");
const outputPath = argument("--output") || "data/favourite-artists.json";

if (!inputPath) {
  console.error("Usage: node scripts/import_favourite_artists.mjs --input <spotify-library.csv> [--output data/favourite-artists.json]");
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function normalise(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const rows = parseCsv(fs.readFileSync(inputPath, "utf8"));
if (!rows.length) throw new Error("The CSV has no rows.");

const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
const column = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
const typeIndex = column("type");
const trackIndex = column("track name");
const artistIndex = column("artist name");
const spotifyIndex = column("spotify - id", "spotify id");
const artists = new Map();

for (const values of rows) {
  const type = typeIndex >= 0 ? String(values[typeIndex] || "").trim().toLowerCase() : "";
  const name = String(values[type === "artist" && trackIndex >= 0 ? trackIndex : artistIndex >= 0 ? artistIndex : trackIndex] || "").trim();
  if (!name || (type && type !== "artist")) continue;
  const key = normalise(name);
  if (!key || artists.has(key)) continue;
  artists.set(key, {
    name,
    ...(spotifyIndex >= 0 && values[spotifyIndex]?.trim() ? { spotify_id: values[spotifyIndex].trim() } : {})
  });
}

const output = {
  source: "Spotify library export",
  artists: [...artists.values()].sort((a, b) => a.name.localeCompare(b.name))
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Imported ${output.artists.length} unique artists into ${outputPath}`);
