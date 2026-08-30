#!/usr/bin/env node
/** Build artist-level YouTube and Instagram assignments from the event feed. */

import { readFile, writeFile } from "node:fs/promises";

const INPUT = "data/halibuts-live.json";
const DEFAULT_OUTPUT = "data/artists.json";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3/search";

function canonical(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(value) {
  return canonical(value).replace(/\s+/g, "-").slice(0, 80);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Filler words that inflate a name's token count without identifying the act.
const NAME_STOPWORDS = new Set([
  "the", "and", "band", "trio", "duo", "quartet", "quintet", "sextet",
  "project", "orchestra", "ensemble", "collective", "feat", "ft", "presents", "dj"
]);
// Signals that a video is actually musical (used to gate close/generic names).
const MUSIC_CONTEXT = /(live|session|concert|acoustic|performance|band|music|gig|official|records|vevo|tour|festival)/i;
const LIVE_SIGNAL = /(live|session|concert|acoustic|performance)/i;

function distinctiveTokens(name) {
  return canonical(name).split(" ").filter((token) => token.length > 2 && !NAME_STOPWORDS.has(token));
}

// Decide whether a candidate video confidently belongs to the artist.
// Multi-word acts must have every distinctive token present; a one-word or
// generic name must appear as a whole phrase AND sit in a musical context,
// so "Bark" the band is not matched to a video about a dog barking.
function matchQuality(name, title, channel) {
  const text = `${title} ${channel}`;
  const haystack = canonical(text);
  const tokens = distinctiveTokens(name);
  const live = LIVE_SIGNAL.test(text) ? 1 : 0;
  if (tokens.length >= 2) {
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return { accepted: hits === tokens.length, score: hits * 10 + live };
  }
  const phrase = canonical(name);
  const wholeName = phrase.length > 0 && new RegExp(`(^| )${escapeRegex(phrase)}( |$)`).test(haystack);
  const accepted = Boolean(wholeName && MUSIC_CONTEXT.test(text));
  return { accepted, score: (accepted ? 10 : 0) + live };
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
}

function lineupNames(value) {
  const source = cleanName(value);
  if (!source) return [];
  const names = source.split(/\s*[,;|]\s*/).map(cleanName).filter(Boolean);
  return names.length ? names : [source];
}

function inferredPromoter(event) {
  if (event.promoter) return cleanName(event.promoter);
  const match = String(event.description || "").match(/(?:presented|promoted|hosted|curated)\s+by\s+([^.;]+)/i);
  return match ? cleanName(match[1]) : null;
}

function googleSearch(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function youtubeSearch(name, live = false) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name}${live ? " live" : ""}`.trim())}`;
}

function instagramCandidates({ name, promoters, venues }) {
  const candidates = [{
    role: "artist",
    label: "Research Instagram",
    query: `site:instagram.com "${name}" musician`,
    url: googleSearch(`site:instagram.com "${name}" musician`)
  }];
  for (const promoter of promoters) {
    candidates.push({
      role: "promoter",
      label: `Search ${promoter} Instagram`,
      query: `site:instagram.com "${promoter}" music promoter`,
      url: googleSearch(`site:instagram.com "${promoter}" music promoter`)
    });
  }
  for (const venue of venues) {
    candidates.push({
      role: "venue",
      label: `Search ${venue} Instagram`,
      query: `site:instagram.com "${venue}" London music`,
      url: googleSearch(`site:instagram.com "${venue}" London music`)
    });
  }
  return candidates;
}

async function youtubeVideos({ name, venues, promoters, apiKey }) {
  const fallback = {
    live_search_url: youtubeSearch(name, true),
    search_url: youtubeSearch(name),
    videos: [],
    status: "search_only"
  };
  if (!apiKey) return fallback;

  const context = [...promoters, ...venues].slice(0, 2).join(" ");
  const queries = [`${name} live`, name];
  const results = [];
  for (const query of queries) {
    const params = new URLSearchParams({
      key: apiKey,
      part: "snippet",
      type: "video",
      maxResults: "10",
      regionCode: "GB",
      relevanceLanguage: "en",
      q: context ? `${query} ${context}` : query
    });
    const response = await fetch(`${YOUTUBE_API}?${params}`);
    if (!response.ok) throw new Error(`YouTube API ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    for (const item of payload.items || []) {
      const videoId = item.id?.videoId;
      if (!videoId || results.some((video) => video.video_id === videoId)) continue;
      const title = item.snippet?.title || "Untitled video";
      const channel = item.snippet?.channelTitle || "YouTube";
      const { accepted, score } = matchQuality(name, title, channel);
      if (!accepted) continue;
      results.push({ video_id: videoId, title, channel, url: `https://www.youtube.com/watch?v=${videoId}`, score });
    }
    if (results.length >= 3) break;
  }
  results.sort((a, b) => b.score - a.score);
  return { ...fallback, videos: results.slice(0, 3).map(({ score, ...video }) => video), status: results.length ? "matched" : "search_only" };
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const limitIndex = process.argv.indexOf("--youtube-limit");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : DEFAULT_OUTPUT;
  const youtubeLimit = limitIndex >= 0 ? Math.max(0, Number(process.argv[limitIndex + 1])) : 0;
  const recheck = process.argv.includes("--recheck");
  const apiKey = process.env.YOUTUBE_API_KEY || "";
  const events = JSON.parse(await readFile(INPUT, "utf8"));
  let previousArtists = [];
  try {
    previousArtists = JSON.parse(await readFile(output, "utf8"));
  } catch {
    previousArtists = [];
  }
  const previousByName = new Map(previousArtists.map((artist) => [canonical(artist.name), artist]));
  const records = new Map();

  for (const event of events) {
    for (const name of lineupNames(event.artist || event.event_name)) {
      const key = canonical(name);
      if (!key) continue;
      const record = records.get(key) || { name, event_count: 0, venues: new Set(), promoters: new Set(), genres: new Set() };
      record.event_count += 1;
      if (event.venue) record.venues.add(event.venue);
      const promoter = inferredPromoter(event);
      if (promoter) record.promoters.add(promoter);
      for (const genre of event.genres || []) record.genres.add(genre);
      records.set(key, record);
    }
  }

  const artists = [];
  let apiLookups = 0;
  for (const record of records.values()) {
    const venues = [...record.venues].sort();
    const promoters = [...record.promoters].sort();
    const previous = previousByName.get(canonical(record.name));
    const alreadyMatched = previous?.youtube?.status === "matched";
    // With --recheck, matched names are looked up again (subject to the limit)
    // so the stricter rule can drop or replace earlier low-confidence videos.
    const shouldLookup = Boolean(apiKey && apiLookups < youtubeLimit && (recheck || !alreadyMatched));
    let youtube;
    if (shouldLookup) {
      apiLookups += 1;
      try {
        youtube = await youtubeVideos({ name: record.name, venues, promoters, apiKey });
      } catch (error) {
        console.error(`warning: YouTube lookup failed for ${record.name}: ${error.message}`);
        youtube = previous?.youtube || await youtubeVideos({ name: record.name, venues, promoters });
      }
    } else if (previous?.youtube) {
      // Not looked up this run (no key, over the limit, or already matched):
      // keep whatever we had rather than wiping it to a search link.
      youtube = previous.youtube;
    } else {
      youtube = await youtubeVideos({ name: record.name, venues, promoters });
    }
    artists.push({
      artist_id: slug(record.name),
      name: record.name,
      event_count: record.event_count,
      venues,
      promoters,
      genres: [...record.genres].sort(),
      youtube,
      instagram_url: previous?.instagram_url || null,
      instagram_candidates: instagramCandidates({ name: record.name, promoters, venues }),
      instagram_status: previous?.instagram_status || "review"
    });
  }

  artists.sort((a, b) => b.event_count - a.event_count || a.name.localeCompare(b.name));
  await writeFile(output, JSON.stringify(artists, null, 2) + "\n", "utf8");
  console.error(`Built ${artists.length} artist records from ${events.length} events.`);
  const matchedCount = artists.filter((artist) => artist.youtube?.status === "matched").length;
  console.error(apiKey
    ? `YouTube API lookups: ${apiLookups}${recheck ? " (recheck)" : ""}. Matched artists: ${matchedCount}/${artists.length}.`
    : "No YOUTUBE_API_KEY supplied; generated reviewable YouTube search links.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
