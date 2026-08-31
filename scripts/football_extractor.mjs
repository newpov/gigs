#!/usr/bin/env node
/**
 * Build a list of upcoming TV football fixtures from live-footballontv.com so
 * the planner can warn when a gig clashes with a match you want to watch.
 *
 * Only fixture, date and time are kept (times are already UK/London local).
 * No third-party packages; mirrors the Halibuts adapter's plain-fetch style.
 *
 *   node scripts/football_extractor.mjs --days 8 --output data/football-live.json
 */

import { writeFile } from "node:fs/promises";

const PAGES = [
  "https://www.live-footballontv.com/live-champions-league-football-on-tv.html",
  "https://www.live-footballontv.com/live-uefa-europa-league-football-on-tv.html",
  "https://www.live-footballontv.com/live-italian-football-on-tv.html",
  "https://www.live-footballontv.com/live-premier-league-football-on-tv.html"
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

const stripTags = (value) => String(value || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function parseDate(text) {
  const match = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!month || !day || !year) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseFixtures(html) {
  const tokenRe = /class="[^"]*(fixture-date|fixture__time|fixture__teams)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/g;
  const fixtures = [];
  let currentDate = null;
  let pendingTime = null;
  for (const match of html.matchAll(tokenRe)) {
    const type = match[1];
    const text = stripTags(match[2]);
    if (type === "fixture-date") {
      currentDate = parseDate(text);
      pendingTime = null;
    } else if (type === "fixture__time") {
      pendingTime = (text.match(/\d{1,2}:\d{2}/) || [])[0] || null;
    } else if (type === "fixture__teams") {
      if (currentDate && pendingTime && /\sv\s/i.test(text)) {
        fixtures.push({ fixture: text, date: currentDate, time: pendingTime });
      }
      pendingTime = null;
    }
  }
  return fixtures;
}

function londonToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date()).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const daysIndex = process.argv.indexOf("--days");
  const outputIndex = process.argv.indexOf("--output");
  const days = daysIndex >= 0 ? Math.max(1, Number(process.argv[daysIndex + 1])) : 8;
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "data/football-live.json";

  const today = londonToday();
  const until = addDays(today, days);

  const seen = new Set();
  const fixtures = [];
  for (const url of PAGES) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (gig-planner football adapter)" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      for (const fixture of parseFixtures(html)) {
        if (fixture.date < today || fixture.date >= until) continue;
        const key = `${fixture.date}|${fixture.time}|${fixture.fixture.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fixtures.push(fixture);
      }
    } catch (error) {
      console.error(`warning: could not read ${url}: ${error.message}`);
    }
  }

  fixtures.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.fixture.localeCompare(b.fixture));
  await writeFile(output, JSON.stringify(fixtures, null, 2) + "\n", "utf8");
  console.error(`Wrote ${fixtures.length} fixtures (${today} .. ${until}) to ${output}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
