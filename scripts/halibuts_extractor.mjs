#!/usr/bin/env node
/** Dependency-free Node extractor for Halibuts event pages. */

import { writeFile } from "node:fs/promises";

const BASE_URL = "https://halibuts.com/";
const EVENT_URL_RE = /https:\/\/halibuts\.com\/events\/eventdetail\/[^"'<>\s]+/gi;
const DATE_RE = /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i;
const TIME_RE = /(?:@|open\s*@)\s*(\d{1,2})\.(\d{2})\s*([ap]m)/i;
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const LARGE_VENUE_RE = /(?:arena|stadium|palace|apollo|o2|wembley|royal albert hall|roundhouse|eventim|troxy|indigo)/i;
const PUB_RE = /(?:arms|tavern|inn|pub|boogaloo|beehive|spice of life|magic garden|victoria|good mixer|fox and firkin|fighting cocks|half moon|ivy house|dublin castle|fiddlers elbow|cavendish arms|pelton arms|crown|royal oak|three wishes|sound lounge|bedford|george tavern)/i;
const BOROUGH_BY_VENUE = {
  "New Cross Inn": "Lewisham", "The Old Blue Last": "Hackney", "The Beehive": "Tower Hamlets",
  "The Spice of Life": "Westminster", "The Magic Garden": "Wandsworth", "Barfly Camden": "Camden",
  "The Victoria": "Hackney", "The Lexington": "Islington", "IndigO2": "Greenwich"
};

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "LondonGigPlanner/0.1 (personal research prototype)" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

async function fetchEventSearch(data) {
  const body = new FormData();
  body.append("data", data);
  body.append("event_name", "");
  body.append("limit", "0");
  body.append("page", "0");
  body.append("day_time", "");
  body.append("evening", "");
  body.append("tomorrow", "");
  body.append("exclude", "|");
  body.append("action", "eventSearch");
  const response = await fetch(`${BASE_URL}includes/ajax_functions.php`, {
    method: "POST",
    headers: {
      "User-Agent": "LondonGigPlanner/0.1 (personal research prototype)",
      "X-Requested-With": "XMLHttpRequest"
    },
    body
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!payload.status) throw new Error(payload.message || "Halibuts returned no events");
  return payload;
}

function decode(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&pound;/gi, "£").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"');
}

function visibleText(raw) {
  return decode(raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return visibleText(value).trim();
}

function detailValue(text, label) {
  const match = text.match(new RegExp(`${label}\\s*:?\\s*([^|]+?)(?=\\s+(?:Admission|Performer name|Age restriction|Update /Errors|Halibuts|$))`, "i"));
  return match?.[1]?.trim() || null;
}

function classifyVenue(venue) {
  if (!venue) return "Grassroots";
  if (LARGE_VENUE_RE.test(venue)) return "Large";
  if (PUB_RE.test(venue)) return "Pub";
  return "Grassroots";
}

function boroughForVenue(venue) {
  if (!venue) return null;
  return BOROUGH_BY_VENUE[venue] || "London";
}

function jsonLdEvent(raw) {
  const blocks = [...raw.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      if (parsed?.["@type"] === "Event" || parsed?.["@type"]?.includes?.("Event")) return parsed;
    } catch {
      // Ignore malformed analytics markup and continue to the visible HTML.
    }
  }
  return {};
}

function parseDate(match) {
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[match[2].slice(0, 3).toLowerCase()];
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function parseTime(match) {
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function urlDateTime(url) {
  const match = url.match(/-(\d{1,2})-([A-Za-z]{3,9})-(\d{4})-(\d{1,2})\.(\d{2})([ap]m)(?:$|[?#])/i);
  if (!match) return {};
  const dateMatch = [null, match[1], match[2], match[3]];
  const timeMatch = [null, match[4], match[5], match[6]];
  return { date: parseDate(dateMatch), time: parseTime(timeMatch) };
}

function searchTickets({ title, artist, venue, date }) {
  const query = [title, artist, venue, date, "tickets"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function formatHalibutsDate(date) {
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function londonToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
}

async function discoverEventUrls({ days, maxRecords }) {
  const from = londonToday();
  const fromDate = formatHalibutsDate(from);
  const toDate = formatHalibutsDate(addDays(from, Math.max(0, days - 1)));
  const pageSize = 25;
  const dataForPage = (page) => [
    `limit=${pageSize}`,
    `page=${page}`,
    `sortFromDate=${encodeURIComponent(fromDate)}`,
    `sortToDate=${encodeURIComponent(toDate)}`
  ].join("&");

  const urls = [];
  const seen = new Set();
  const firstPage = await fetchEventSearch(dataForPage(1));
  const totalPages = Number(firstPage.totalPages) || 1;
  const totalRecords = Number(firstPage.total_records) || null;
  const pages = Math.min(totalPages, Math.ceil(maxRecords / pageSize));

  for (let page = 1; page <= pages && urls.length < maxRecords; page += 1) {
    const payload = page === 1 ? firstPage : await fetchEventSearch(dataForPage(page));
    for (const event of payload.events || []) {
      const url = event.viewLink;
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
      if (urls.length >= maxRecords) break;
    }
  }

  return { urls, fromDate, toDate, totalPages, totalRecords };
}

async function parseDetail(url) {
  const raw = await fetchText(url);
  const text = visibleText(raw);
  const date = text.match(DATE_RE);
  const time = text.match(TIME_RE);
  const postcode = text.match(POSTCODE_RE);
  const schema = jsonLdEvent(raw);
  const title = schema.name || decode(raw.match(/<h2[^>]*>\s*([^<]+)\s*<\/h2>/i)?.[1] || "Untitled event").trim();
  const venue = schema.location?.name || null;
  const schemaDate = schema.startDate?.match?.(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  const schemaPostcode = schema.location?.address?.postalCode || postcode?.[1]?.toUpperCase() || null;
  const artist = schema.performer?.name || detailValue(text, "Performer name") || title;
  const urlSchedule = urlDateTime(url);
  const dateValue = urlSchedule.date || schemaDate?.[1] || (date ? parseDate(date) : null);
  const timeValue = urlSchedule.time || schemaDate?.[2] || (time ? parseTime(time) : null);
  const genreText = [...raw.matchAll(/<span[^>]*class=["'][^"']*genre[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .flatMap((match) => stripTags(match[1]).split(","))
    .map((genre) => genre.trim())
    .filter((genre) => genre && genre.toLowerCase() !== "genre");
  const genres = [...new Set(genreText)];
  const directTicket = raw.match(/event-links[\s\S]*?<a\s+href=["']([^"']+)["'][^>]*>\s*See this event/i)?.[1] || url;
  const bookingUrl = directTicket !== url ? directTicket : searchTickets({ title, artist, venue, date: dateValue });
  const venueType = classifyVenue(venue);
  return {
    event_name: title,
    artist,
    date: dateValue,
    time: timeValue,
    venue,
    postcode: schemaPostcode,
    borough: boroughForVenue(venue),
    venue_type: venueType,
    include_by_default: venueType !== "Large",
    genres,
    price: Number(detailValue(text, "Admission")?.replace("£", "")) || null,
    age_restriction: detailValue(text, "Age restriction"),
    ticket_url: bookingUrl,
    ticket_link_type: directTicket !== url ? "venue" : "search",
    venue_url: directTicket !== url ? directTicket : null,
    source_url: url,
    source: "Halibuts",
    status: text.includes("Sold Out") ? "sold_out" : text.includes("Postponed") ? "postponed" : "listed",
    description: schema.description ? stripTags(schema.description) : null,
    image_url: schema.image || null
  };
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const daysArg = process.argv.indexOf("--days");
  const outputArg = process.argv.indexOf("--output");
  const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1])) : Number.POSITIVE_INFINITY;
  const days = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1])) : 7;
  const output = outputArg >= 0 ? process.argv[outputArg + 1] : null;
  const maxRecords = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;
  const feed = await discoverEventUrls({ days, maxRecords });
  const urls = feed.urls;
  console.error(`Halibuts feed: ${feed.totalRecords ?? "?"} records from ${feed.fromDate} to ${feed.toDate}; importing ${urls.length} across ${feed.totalPages} pages.`);
  const records = [];
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      try { records.push(await parseDetail(url)); }
      catch (error) { console.error(`warning: could not parse ${url}: ${error.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  console.error(`Parsed ${records.length} event detail pages.`);
  const payload = JSON.stringify(records, null, 2) + "\n";
  if (output) await writeFile(output, payload, "utf8");
  else process.stdout.write(payload);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
