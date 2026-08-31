let events;
for (const dataSource of ["data/halibuts-live.json", "data/events.json"]) {
  try {
    const response = await fetch(dataSource);
    if (response.ok) { events = await response.json(); break; }
  } catch {
    // Fall back to the curated sample when the live import is not present.
  }
}
events ||= [];

let artists = [];
try {
  const response = await fetch("data/artists.json");
  if (response.ok) artists = await response.json();
} catch {
  // Media enrichment is optional; the event list remains usable without it.
}

function mediaKey(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

const artistByName = new Map(artists.map((artist) => [mediaKey(artist.name), artist]));
let sharedFavouriteArtists = [];
try {
  const response = await fetch("data/favourite-artists.json");
  if (response.ok) {
    const payload = await response.json();
    sharedFavouriteArtists = Array.isArray(payload) ? payload : payload.artists || [];
  }
} catch {
  // Favourites are optional; the planner remains usable without the shared list.
}

const FAVOURITE_ARTISTS_STORAGE_KEY = "gig-planner-favourite-artists";
let customFavouriteArtists = null;
try {
  const stored = localStorage.getItem(FAVOURITE_ARTISTS_STORAGE_KEY);
  const parsed = stored === null ? null : JSON.parse(stored);
  if (Array.isArray(parsed)) customFavouriteArtists = parsed;
} catch {
  customFavouriteArtists = null;
}

function mergeFavouriteArtists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const artist of list || []) {
      const name = String(artist?.name || "").trim();
      const key = mediaKey(name);
      if (!key || merged.has(key)) continue;
      merged.set(key, { name, ...(artist.spotify_id ? { spotify_id: artist.spotify_id } : {}) });
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function activeFavouriteArtists() {
  return customFavouriteArtists !== null ? mergeFavouriteArtists(customFavouriteArtists) : mergeFavouriteArtists(sharedFavouriteArtists);
}

let favouriteRecords = activeFavouriteArtists();
let favouriteMatchCache = new Map();

function refreshFavouriteIndex() {
  favouriteRecords = activeFavouriteArtists();
  favouriteMatchCache = new Map();
}

function saveCustomFavouriteArtists() {
  if (customFavouriteArtists === null) localStorage.removeItem(FAVOURITE_ARTISTS_STORAGE_KEY);
  else localStorage.setItem(FAVOURITE_ARTISTS_STORAGE_KEY, JSON.stringify(customFavouriteArtists));
}

function parseFavouriteCsv(text) {
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
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
  const column = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const typeIndex = column("type");
  const trackIndex = column("track name");
  const artistIndex = column("artist name");
  const spotifyIndex = column("spotify - id", "spotify id");
  const imported = [];
  for (const values of rows) {
    const type = typeIndex >= 0 ? String(values[typeIndex] || "").trim().toLowerCase() : "";
    const name = String(values[type === "artist" && trackIndex >= 0 ? trackIndex : artistIndex >= 0 ? artistIndex : trackIndex] || "").trim();
    if (!name || (type && type !== "artist")) continue;
    imported.push({ name, ...(spotifyIndex >= 0 && values[spotifyIndex]?.trim() ? { spotify_id: values[spotifyIndex].trim() } : {}) });
  }
  return mergeFavouriteArtists(imported);
}

const state = {
  query: "",
  venueType: "all",
  includeLarge: false,
  genres: new Set(),
  postcodeAreas: new Set(),
  dateRange: "today",
  customDate: null,
  selectedEventKey: null,
  expressHidden: false,
  shortlisted: new Set(),
  rejected: new Set()
};
let mobileListScrollY = 0;

const eventsEl = document.querySelector("#events");
const emptyEl = document.querySelector("#emptyState");
const countEl = document.querySelector("#resultCount");
const keywordSearchEl = document.querySelector("#keywordSearch");
const genreEl = document.querySelector("#genreFilters");
const genrePickerEl = document.querySelector("#genrePicker");
const genreSelectionEl = document.querySelector("#genreSelection");
const calendarDateEl = document.querySelector("#calendarDate");
const postcodePickerEl = document.querySelector("#postcodePicker");
const postcodeSelectionEl = document.querySelector("#postcodeSelection");
const postcodeEl = document.querySelector("#postcodeFilters");
const excludeGenreEl = document.querySelector("#excludeGenreFilters");
const excludeCountEl = document.querySelector("#excludeCount");
const resultTitleEl = document.querySelector("#resultTitle");
const dateLabelEl = document.querySelector("#dateLabel");
const expressPanelEl = document.querySelector("#expressPanel");
const expressContentEl = document.querySelector("#expressContent");
const showExpressEl = document.querySelector("#showExpress");
const detailEl = document.querySelector("#eventDetail");
const detailContentEl = document.querySelector("#detailContent");
const favouriteCountEl = document.querySelector("#favouriteCount");
const favouriteStatusEl = document.querySelector("#favouriteStatus");
const favouriteCsvEl = document.querySelector("#favouriteCsv");
const mergeFavouritesEl = document.querySelector("#mergeFavourites");

const londonTodayParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).formatToParts(new Date()).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
const today = new Date(`${londonTodayParts.year}-${londonTodayParts.month}-${londonTodayParts.day}T12:00:00`);
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const todayKey = dateKey(today);
const importedDates = events.map((event) => event.date).filter(Boolean).sort();
calendarDateEl.min = importedDates[0] || todayKey;
calendarDateEl.max = importedDates.at(-1) || todayKey;

const DEFAULT_EXCLUDED_GENRES = ["Comedy", "Family", "Musical Theatre"];
const EXCLUDED_GENRES_STORAGE_KEY = "gig-scout-excluded-genres";
let savedExcludedGenres = DEFAULT_EXCLUDED_GENRES;
try {
  const storedExcludedGenres = localStorage.getItem(EXCLUDED_GENRES_STORAGE_KEY);
  if (storedExcludedGenres !== null) savedExcludedGenres = JSON.parse(storedExcludedGenres) || [];
} catch {
  savedExcludedGenres = DEFAULT_EXCLUDED_GENRES;
}
const urlExcludedGenres = new URLSearchParams(window.location.search).get("exclude");
if (urlExcludedGenres !== null) savedExcludedGenres = urlExcludedGenres ? urlExcludedGenres.split("|").filter(Boolean) : [];
state.excludedGenres = new Set(savedExcludedGenres);

const SHORTLIST_STORAGE_KEY = "gig-planner-shortlisted-events";
try {
  state.shortlisted = new Set(JSON.parse(localStorage.getItem(SHORTLIST_STORAGE_KEY) || "[]"));
} catch {
  state.shortlisted = new Set();
}

const REJECTED_STORAGE_KEY = "gig-planner-rejected-events";
try {
  state.rejected = new Set(JSON.parse(localStorage.getItem(REJECTED_STORAGE_KEY) || "[]"));
} catch {
  state.rejected = new Set();
}
function saveRejected() {
  try { localStorage.setItem(REJECTED_STORAGE_KEY, JSON.stringify([...state.rejected])); } catch { /* ignore */ }
}

function dateAtOffset(offset) {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  return dateKey(date);
}

function formatDate(dateValue) {
  if (!dateValue) return "Date TBC";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${dateValue}T12:00:00`));
}

function formatHeaderDate(dateValue) {
  if (!dateValue) return "London listings";
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${dateValue}T12:00:00`)).toUpperCase();
}

const allGenres = [...new Set(events.flatMap((event) => event.genres || []))].sort((a, b) => a.localeCompare(b));
genreEl.innerHTML = allGenres.map((genre) => `<button class="genre-filter" data-genre="${escapeHtml(genre)}">${escapeHtml(genre)}</button>`).join("");
excludeGenreEl.innerHTML = allGenres.map((genre) => `<button class="genre-filter exclude-genre-filter" data-genre="${escapeHtml(genre)}">${escapeHtml(genre)}</button>`).join("");

function postcodeArea(postcode) {
  return String(postcode || "").toUpperCase().match(/^([A-Z]{1,2})\d/)?.[1] || "";
}

function saveExcludedGenres() {
  localStorage.setItem(EXCLUDED_GENRES_STORAGE_KEY, JSON.stringify([...state.excludedGenres].sort()));
  const url = new URL(window.location.href);
  const value = [...state.excludedGenres].sort().join("|");
  if (value) url.searchParams.set("exclude", value);
  else url.searchParams.delete("exclude");
  window.history.replaceState({}, "", url);
}

function saveShortlisted() {
  localStorage.setItem(SHORTLIST_STORAGE_KEY, JSON.stringify([...state.shortlisted]));
}

genreEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-genre]");
  if (!button) return;
  const genre = button.dataset.genre;
  if (state.genres.has(genre)) state.genres.delete(genre);
  else state.genres.add(genre);
  button.classList.toggle("active", state.genres.has(genre));
  render();
});

postcodeEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-postcode-area]");
  if (!button) return;
  const area = button.dataset.postcodeArea;
  if (state.postcodeAreas.has(area)) state.postcodeAreas.delete(area);
  else state.postcodeAreas.add(area);
  render();
});

excludeGenreEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-genre]");
  if (!button) return;
  const genre = button.dataset.genre;
  if (state.excludedGenres.has(genre)) state.excludedGenres.delete(genre);
  else state.excludedGenres.add(genre);
  saveExcludedGenres();
  render();
});

document.querySelector("#resetExcluded").addEventListener("click", () => {
  state.excludedGenres = new Set(DEFAULT_EXCLUDED_GENRES);
  saveExcludedGenres();
  render();
});

favouriteCsvEl.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = parseFavouriteCsv(await file.text());
    if (!imported.length) throw new Error("No artist rows found");
    const previous = activeFavouriteArtists();
    const shouldMerge = mergeFavouritesEl.checked;
    customFavouriteArtists = shouldMerge ? mergeFavouriteArtists(previous, imported) : imported;
    saveCustomFavouriteArtists();
    refreshFavouriteIndex();
    favouriteStatusEl.textContent = `${customFavouriteArtists.length} artists active · ${shouldMerge ? Math.max(0, customFavouriteArtists.length - previous.length) : customFavouriteArtists.length} imported`;
    render();
  } catch {
    favouriteStatusEl.textContent = "Could not read that CSV. Choose a Spotify library export.";
  }
  event.target.value = "";
});

document.querySelector("#resetFavourites").addEventListener("click", () => {
  customFavouriteArtists = null;
  saveCustomFavouriteArtists();
  refreshFavouriteIndex();
  render();
});

document.querySelector("#copyPreferences").addEventListener("click", async () => {
  const url = new URL(window.location.href);
  const value = [...state.excludedGenres].sort().join("|");
  if (value) url.searchParams.set("exclude", value);
  else url.searchParams.delete("exclude");
  try {
    await navigator.clipboard.writeText(url.toString());
    document.querySelector("#copyStatus").textContent = "Copied";
  } catch {
    document.querySelector("#copyStatus").textContent = "Copy the URL above";
  }
  setTimeout(() => { document.querySelector("#copyStatus").textContent = ""; }, 2200);
});

document.querySelector("#venueType").addEventListener("change", (event) => {
  state.venueType = event.target.value;
  render();
});

keywordSearchEl.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

document.querySelector("#hideExpress").addEventListener("click", () => {
  state.expressHidden = true;
  renderExpress(filteredEvents());
});

showExpressEl.addEventListener("click", () => {
  state.expressHidden = false;
  renderExpress(filteredEvents());
});

document.querySelector("#includeLarge").addEventListener("change", (event) => {
  state.includeLarge = event.target.checked;
  render();
});

eventsEl.addEventListener("click", (event) => {
  const rejectButton = event.target.closest(".reject-button");
  if (!rejectButton) return;
  event.stopPropagation();
  const key = rejectButton.dataset.eventKey;
  if (state.rejected.has(key)) state.rejected.delete(key);
  else state.rejected.add(key);
  saveRejected();
  render();
});

eventsEl.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".shortlist-checkbox");
  if (!checkbox) return;
  if (checkbox.checked) state.shortlisted.add(checkbox.dataset.eventKey);
  else state.shortlisted.delete(checkbox.dataset.eventKey);
  saveShortlisted();
  render();
});

detailEl.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".shortlist-checkbox");
  if (!checkbox) return;
  if (checkbox.checked) state.shortlisted.add(checkbox.dataset.eventKey);
  else state.shortlisted.delete(checkbox.dataset.eventKey);
  saveShortlisted();
  render();
});

eventsEl.addEventListener("click", (event) => {
  const item = event.target.closest("[data-event-key]");
  if (!item || event.target.closest("a, button, input, label, iframe")) return;
  openEvent(item.dataset.eventKey);
});

eventsEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-event-key]");
  if (!item || event.target.closest("a, button, input, label, iframe")) return;
  event.preventDefault();
  openEvent(item.dataset.eventKey);
});

expressContentEl.addEventListener("click", (event) => {
  const item = event.target.closest("[data-event-key]");
  if (!item || event.target.closest("a, button, iframe")) return;
  openEvent(item.dataset.eventKey);
});

expressContentEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-event-key]");
  if (!item || event.target.closest("a, button, iframe")) return;
  event.preventDefault();
  openEvent(item.dataset.eventKey);
});

document.querySelector("#closeDetail").addEventListener("click", () => {
  const shouldRestoreScroll = window.matchMedia("(max-width: 700px)").matches;
  state.selectedEventKey = null;
  render();
  if (shouldRestoreScroll) setTimeout(() => window.scrollTo({ top: mobileListScrollY, behavior: "instant" }), 0);
});

document.querySelectorAll(".date-pill").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".date-pill").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.dateRange = button.dataset.range;
    state.customDate = null;
    calendarDateEl.value = "";
    render();
  });
});

calendarDateEl.addEventListener("change", (event) => {
  if (!event.target.value) return;
  document.querySelectorAll(".date-pill").forEach((item) => item.classList.remove("active"));
  state.dateRange = "custom";
  state.customDate = event.target.value;
  render();
});

function filteredEvents({ includePostcode = true } = {}) {
  return events.filter((event) => {
    if (state.dateRange === "today" && event.date !== todayKey) return false;
    if (state.dateRange === "tomorrow" && event.date !== dateAtOffset(1)) return false;
    if (state.dateRange === "week" && (!event.date || event.date <= todayKey || event.date > dateAtOffset(7))) return false;
    if (state.dateRange === "custom" && event.date !== state.customDate) return false;
    if (!state.includeLarge && event.venue_type === "Large") return false;
    if (state.venueType !== "all" && event.venue_type !== state.venueType) return false;
    if (includePostcode && state.postcodeAreas.size && !state.postcodeAreas.has(postcodeArea(event.postcode))) return false;
    if ((event.genres || []).some((genre) => state.excludedGenres.has(genre))) return false;
    if (state.genres.size && !(event.genres || []).some((genre) => state.genres.has(genre))) return false;
    if (state.query && !searchableEventText(event).includes(mediaKey(state.query))) return false;
    return true;
  }).sort((a, b) => eventSortRank(a) - eventSortRank(b));
}

function searchableEventText(event) {
  return mediaKey([
    event.event_name,
    event.artist,
    event.venue,
    event.borough,
    event.postcode,
    event.promoter,
    event.description,
    ...(event.genres || [])
  ].filter(Boolean).join(" "));
}

function eventFlags(event) {
  const status = mediaKey(event.status || "");
  const titleAndArtist = mediaKey([event.event_name, event.artist].filter(Boolean).join(" "));
  const fullDetails = mediaKey([event.event_name, event.artist, event.description].filter(Boolean).join(" "));
  return {
    soldOut: status === "sold out" || /\bsold out\b/.test(titleAndArtist),
    tribute: /\btribute\b/.test(fullDetails)
  };
}

function eventSortRank(event) {
  const flags = eventFlags(event);
  if (state.rejected.has(eventKey(event))) return 4;
  if (flags.soldOut || flags.tribute) return 3;
  if (state.shortlisted.has(eventKey(event))) return 0;
  if (favouriteArtistForEvent(event)) return 1;
  return 2;
}

// Rejected, sold-out and tribute rows sink to the bottom of their time band.
function isDeprioritised(event) {
  const flags = eventFlags(event);
  return state.rejected.has(eventKey(event)) || flags.soldOut || flags.tribute;
}

function render() {
  const postcodeScope = filteredEvents({ includePostcode: false });
  const availablePostcodeAreas = new Set(postcodeScope.map((event) => postcodeArea(event.postcode)).filter(Boolean));
  state.postcodeAreas = new Set([...state.postcodeAreas].filter((area) => availablePostcodeAreas.has(area)));
  postcodeEl.innerHTML = [...availablePostcodeAreas].sort().map((area) => `<button class="postcode-filter" data-postcode-area="${escapeHtml(area)}">${escapeHtml(area)}</button>`).join("");
  postcodeSelectionEl.textContent = state.postcodeAreas.size ? `(${state.postcodeAreas.size} selected)` : `(${availablePostcodeAreas.size} available)`;
  const visible = filteredEvents();
  countEl.textContent = `${visible.length} ${visible.length === 1 ? "event" : "events"}`;
  emptyEl.hidden = visible.length > 0;
  eventsEl.innerHTML = renderTimeline(visible);
  genreSelectionEl.textContent = state.genres.size ? `(${state.genres.size} selected)` : "";
  excludeCountEl.textContent = state.excludedGenres.size ? `(${state.excludedGenres.size} hidden)` : "";
  const favouriteArtists = activeFavouriteArtists();
  favouriteCountEl.textContent = favouriteArtists.length ? `(${favouriteArtists.length})` : "(none)";
  favouriteStatusEl.textContent = customFavouriteArtists === null
    ? `${favouriteArtists.length} shared artists active · import a CSV to customise this list`
    : `${favouriteArtists.length} imported artists active · use shared list to reset`;
  excludeGenreEl.querySelectorAll("button[data-genre]").forEach((button) => button.classList.toggle("active", state.excludedGenres.has(button.dataset.genre)));
  postcodeEl.querySelectorAll("button[data-postcode-area]").forEach((button) => button.classList.toggle("active", state.postcodeAreas.has(button.dataset.postcodeArea)));
  const selectedDate = state.dateRange === "tomorrow" ? dateAtOffset(1) : state.dateRange === "custom" ? state.customDate : todayKey;
  resultTitleEl.textContent = state.dateRange === "today" ? "Tonight in London" : state.dateRange === "tomorrow" ? "Tomorrow in London" : state.dateRange === "week" ? "Next 7 days" : formatDate(state.customDate);
  dateLabelEl.textContent = state.dateRange === "week" ? `FROM ${formatHeaderDate(dateAtOffset(1))} · 7 DAYS` : formatHeaderDate(selectedDate);
  renderExpress(visible);
  renderDetail(visible);
}

function card(event) {
  const price = event.price == null ? "Price not listed" : `£${event.price.toFixed(2)}`;
  const status = event.status !== "listed" ? `<span class="status">${escapeHtml(event.status)}</span>` : "";
  const booking = bookingLink(event);
  const favourite = favouriteArtistForEvent(event);
  const flags = eventFlags(event);
  const selectedClass = state.selectedEventKey === eventKey(event) ? " selected" : "";
  const favouriteClass = favourite ? " favourite-event" : "";
  const deprioritisedClass = flags.soldOut || flags.tribute ? " deprioritised-event" : "";
  const favouriteMark = favourite ? `<span class="favourite-star" title="Favourite artist: ${escapeAttribute(favourite.name)}" aria-label="Favourite artist ${escapeAttribute(favourite.name)}">★</span>` : "";
  const eventFlagsMarkup = [flags.soldOut ? `<span class="event-flag sold-out-flag">Sold out</span>` : "", flags.tribute ? `<span class="event-flag tribute-flag">Tribute</span>` : ""].join("");
  return `<article class="event-card${selectedClass}${favouriteClass}${deprioritisedClass}" data-event-key="${escapeAttribute(eventKey(event))}" tabindex="0" role="button" aria-label="Open details for ${escapeAttribute(event.event_name)}${favourite ? ` · favourite artist ${escapeAttribute(favourite.name)}` : ""}">
    <div class="event-top"><span class="venue-type">${escapeHtml(event.venue_type)} ${status}${eventFlagsMarkup}</span><span class="event-time">${escapeHtml(formatDate(event.date))} · ${escapeHtml(formatTime(event.time))}</span><label class="shortlist-toggle"><input class="shortlist-checkbox" data-event-key="${escapeAttribute(eventKey(event))}" type="checkbox" ${state.shortlisted.has(eventKey(event)) ? "checked" : ""} /><span>Shortlist</span></label></div>
    <div class="media-slot">${mediaMarkup(event)}</div>
    <div class="event-title-line">${favouriteMark}<h3>${escapeText(event.event_name)}</h3></div>
    <div class="venue-block"><div class="venue">${escapeText(event.venue)}</div><div class="location">${escapeText(event.borough)} · ${escapeHtml(event.postcode)}</div></div>
    <p class="description">${escapeText(event.description || "Details available on the source listing.")}</p>
    <div class="genre-list">${(event.genres || []).map((genre) => `<span class="genre-tag">${escapeText(genre)}</span>`).join("")}</div>
    <div class="card-footer"><span class="price">${price}</span><a class="ticket-link" href="${escapeAttribute(booking.url)}" target="_blank" rel="noreferrer">${escapeHtml(booking.label)} ↗</a></div>
  </article>`;
}

function timeBand(event) {
  if (!event.time) return { key: 5, label: "Time to be confirmed", note: "" };
  const hour = Number(event.time.split(":")[0]);
  if (Number.isNaN(hour)) return { key: 5, label: "Time to be confirmed", note: "" };
  if (hour < 17) return { key: 1, label: "Daytime", note: "before 5pm" };
  if (hour < 19) return { key: 2, label: "Early evening", note: "5–7pm" };
  if (hour < 21) return { key: 3, label: "Prime time", note: "7–9pm" };
  return { key: 4, label: "Late", note: "9pm onward" };
}

function renderTimeline(visible) {
  if (!visible.length) return "";
  const sorted = [...visible].sort((a, b) =>
    (isDeprioritised(a) ? 1 : 0) - (isDeprioritised(b) ? 1 : 0)
    || (a.time || "99:99").localeCompare(b.time || "99:99"));
  const bands = new Map();
  for (const event of sorted) {
    const band = timeBand(event);
    if (!bands.has(band.key)) bands.set(band.key, { meta: band, items: [] });
    bands.get(band.key).items.push(event);
  }
  return [...bands.keys()].sort((a, b) => a - b).map((key) => {
    const { meta, items } = bands.get(key);
    const note = meta.note ? `<span class="tl-note">${escapeHtml(meta.note)}</span>` : "";
    return `<section class="tl-band"><header class="tl-head"><span class="tl-label">${escapeHtml(meta.label)}</span>${note}<span class="tl-rule"></span><span class="tl-count">${items.length} ${items.length === 1 ? "gig" : "gigs"}</span></header><div class="tl-rows">${items.map(timelineRow).join("")}</div></section>`;
  }).join("");
}

function timelineRow(event) {
  const key = eventKey(event);
  const favourite = favouriteArtistForEvent(event);
  const flags = eventFlags(event);
  const booking = bookingLink(event);
  const rejected = state.rejected.has(key);
  const shortlisted = state.shortlisted.has(key);
  const selectedClass = state.selectedEventKey === key ? " selected" : "";
  const favouriteClass = favourite ? " favourite-event" : "";
  const deprioritisedClass = flags.soldOut || flags.tribute ? " deprioritised-event" : "";
  const rejectedClass = rejected ? " rejected-event" : "";
  const favouriteMark = favourite ? `<span class="favourite-star" title="Favourite artist: ${escapeAttribute(favourite.name)}" aria-label="Favourite artist ${escapeAttribute(favourite.name)}">★</span>` : "";
  const eventFlagsMarkup = [flags.soldOut ? `<span class="event-flag sold-out-flag">Sold out</span>` : "", flags.tribute ? `<span class="event-flag tribute-flag">Tribute</span>` : ""].join("");
  const price = event.price == null ? `<span class="tl-price tl-price-none" title="Price not listed">—</span>` : `<span class="tl-price">£${event.price.toFixed(2)}</span>`;
  return `<article class="tl-row${selectedClass}${favouriteClass}${deprioritisedClass}${rejectedClass}" data-event-key="${escapeAttribute(key)}" tabindex="0" role="button" aria-label="Open details for ${escapeAttribute(event.event_name)}${favourite ? ` · favourite artist ${escapeAttribute(favourite.name)}` : ""}">
    <div class="tl-time"><span class="tl-hour">${escapeHtml(formatTime(event.time))}</span><span class="tl-type">${escapeHtml(event.venue_type)}</span></div>
    <div class="tl-body">
      <div class="tl-title">${favouriteMark}<h3>${escapeText(event.event_name)}</h3>${eventFlagsMarkup}</div>
      <div class="tl-where">${escapeText(event.venue)} · ${escapeText(event.borough)} · ${escapeHtml(event.postcode)}</div>
      <div class="tl-tags">${(event.genres || []).map((genre) => `<span class="genre-tag">${escapeText(genre)}</span>`).join("")}</div>
    </div>
    <div class="tl-side">
      ${price}
      <div class="tl-actions">
        <label class="shortlist-toggle tl-shortlist"><input class="shortlist-checkbox" data-event-key="${escapeAttribute(key)}" type="checkbox" ${shortlisted ? "checked" : ""} /><span>Shortlist</span></label>
        <button class="reject-button" type="button" data-event-key="${escapeAttribute(key)}" aria-pressed="${rejected ? "true" : "false"}" title="${rejected ? "Move back up" : "Not interested — move to bottom"}">${rejected ? "Undo" : "Not for me"}</button>
        <a class="tl-book ticket-link" href="${escapeAttribute(booking.url)}" target="_blank" rel="noreferrer">${escapeHtml(booking.label)} ↗</a>
      </div>
    </div>
  </article>`;
}

function eventArtistNames(event) {
  const raw = String(event.artist || "").trim();
  if (!raw) return [];
  const looksLikeEventTitle = mediaKey(raw) === mediaKey(event.event_name) && /\b(presents?|live music|weekender|candlelight|experience|nights?|party|fest(?:ival)?|cabaret|sessions?|show|at|special|signing|world music)\b/i.test(raw);
  if (looksLikeEventTitle) return [];
  return raw.split(/\s*(?:[,;|]|\+|&)\s*/).map((name) => name.trim()).filter(Boolean);
}

function favouriteArtistForEvent(event) {
  const cacheKey = eventKey(event);
  if (favouriteMatchCache.has(cacheKey)) return favouriteMatchCache.get(cacheKey);
  const titleAndArtistText = mediaKey([event.event_name, event.artist].filter(Boolean).join(" "));
  const descriptionText = mediaKey(event.description || "");
  const match = favouriteRecords.find((artist) => {
    const phrase = mediaKey(artist.name);
    if (!phrase) return false;
    const phrasePattern = new RegExp(`(^| )${escapeRegex(phrase)}( |$)`);
    if (phrasePattern.test(titleAndArtistText)) return true;
    return phrase.split(" ").length > 1 && phrasePattern.test(descriptionText);
  }) || null;
  favouriteMatchCache.set(cacheKey, match);
  return match;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function primaryArtist(event) {
  return eventArtistNames(event).map((name) => artistByName.get(mediaKey(name))).find(Boolean) || null;
}

// Matched artist records for a lineup, de-duplicated, capped so multi-act
// bills surface a couple of different performers rather than only the headliner.
function eventArtists(event, limit = 3) {
  const seen = new Set();
  const matched = [];
  for (const name of eventArtistNames(event)) {
    const artist = artistByName.get(mediaKey(name));
    if (!artist) continue;
    const key = mediaKey(artist.name);
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(artist);
    if (matched.length >= limit) break;
  }
  return matched;
}

function eventKey(event) {
  return event.source_url || [event.date, event.time, event.event_name, event.venue].filter(Boolean).join("|");
}

function openEvent(key) {
  if (window.matchMedia("(max-width: 700px)").matches) mobileListScrollY = window.scrollY;
  state.selectedEventKey = key;
  render();
  if (window.matchMedia("(min-width: 901px)").matches) {
    requestAnimationFrame(() => detailEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }));
  }
}

function expressMediaLinks(event) {
  const artist = primaryArtist(event);
  if (!artist) {
    const fallbackName = event.promoter || event.venue;
    return fallbackName ? `<a href="${escapeAttribute(instagramResearchUrl(fallbackName, event.promoter ? "promoter" : "venue"))}" target="_blank" rel="noreferrer">Instagram research ↗</a>` : "";
  }
  const video = artist.youtube?.videos?.[0];
  const youtubeUrl = video?.url || artist.youtube?.live_search_url || artist.youtube?.search_url;
  const instagram = artist.instagram_url || artist.instagram_candidates?.[0]?.url;
  return [
    youtubeUrl ? `<a href="${escapeAttribute(youtubeUrl)}" target="_blank" rel="noreferrer">YouTube ↗</a>` : "",
    instagram ? `<a href="${escapeAttribute(instagram)}" target="_blank" rel="noreferrer">Instagram ↗</a>` : ""
  ].join("");
}

function renderExpress(visible) {
  const selectedGenres = [...state.genres];
  const shouldShow = selectedGenres.length > 0;
  expressPanelEl.hidden = !shouldShow || state.expressHidden;
  showExpressEl.hidden = !shouldShow || !state.expressHidden;
  if (!shouldShow) return;
  expressContentEl.innerHTML = selectedGenres.map((genre) => {
    const picks = visible.filter((event) => (event.genres || []).includes(genre)).slice(0, 3);
    return `<section class="express-group"><div class="express-group-title"><h4>${escapeHtml(genre)}</h4><span>${picks.length} picks</span></div>${picks.length ? `<ol>${picks.map((event) => `<li class="express-pick" data-event-key="${escapeAttribute(eventKey(event))}" tabindex="0" role="button" aria-label="Open details for ${escapeAttribute(event.event_name)}"><div><strong>${escapeText(event.event_name)}</strong><span>${escapeText(event.venue)} · ${escapeHtml(formatTime(event.time))}</span></div><div class="express-links">${expressMediaLinks(event)}</div></li>`).join("")}</ol>` : `<p class="express-empty">No matching events in the current view.</p>`}</section>`;
  }).join("");
}

function artistMediaBlock(artist, maxVideos) {
  const videos = artist.youtube?.videos || [];
  const videoBlock = videos.length
    ? `<div class="media-video-grid">${videos.slice(0, maxVideos).map((video) => `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.video_id)}" title="${escapeAttribute(video.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`).join("")}</div>`
    : `<div class="media-actions"><a href="${escapeAttribute(artist.youtube?.search_url || `https://www.youtube.com/results?search_query=${encodeURIComponent(artist.name)}`)}" target="_blank" rel="noreferrer">YouTube artist search ↗</a></div>`;
  const instagram = artist.instagram_url
    ? { label: "Instagram profile", url: artist.instagram_url }
    : artist.instagram_candidates?.[0] || { label: "Research Instagram", url: instagramResearchUrl(artist.name, "artist") };
  return `<div class="media-artist"><span class="media-label">${escapeText(artist.name)} · media</span>${videoBlock}<div class="media-actions"><a href="${escapeAttribute(instagram.url)}" target="_blank" rel="noreferrer">${escapeHtml(instagram.label)} ↗</a></div></div>`;
}

function mediaMarkup(event) {
  const artists = eventArtists(event, 3);
  if (!artists.length) {
    const fallbackName = event.promoter || event.venue;
    const fallbackUrl = fallbackName ? instagramResearchUrl(fallbackName, event.promoter ? "promoter" : "venue") : "";
    return `<div class="media-content"><span class="media-label">Artist details not listed</span>${fallbackUrl ? `<div class="media-actions"><a href="${escapeAttribute(fallbackUrl)}" target="_blank" rel="noreferrer">Research ${escapeHtml(event.promoter ? "promoter" : "venue")} Instagram ↗</a></div>` : ""}</div>`;
  }
  // One clip each across a multi-act bill; a solo act keeps two clips.
  const maxVideos = artists.length > 1 ? 1 : 2;
  return `<div class="media-content">${artists.map((artist) => artistMediaBlock(artist, maxVideos)).join("")}</div>`;
}

function renderDetail(visible) {
  const selected = visible.find((event) => eventKey(event) === state.selectedEventKey);
  detailEl.hidden = !selected;
  detailEl.parentElement.classList.toggle("detail-open", Boolean(selected));
  detailEl.classList.toggle("deprioritised-detail", Boolean(selected && (eventFlags(selected).soldOut || eventFlags(selected).tribute)));
  if (!selected) {
    detailContentEl.innerHTML = "";
    return;
  }
  const price = selected.price == null ? "Price not listed" : `£${selected.price.toFixed(2)}`;
  const booking = bookingLink(selected);
  const favourite = favouriteArtistForEvent(selected);
  const favouriteMark = favourite ? `<span class="favourite-star" title="Favourite artist: ${escapeAttribute(favourite.name)}" aria-label="Favourite artist ${escapeAttribute(favourite.name)}">★</span>` : "";
  detailContentEl.innerHTML = `<div class="detail-media">${mediaMarkup(selected)}</div><div class="detail-meta"><p class="detail-kicker">${escapeHtml(selected.venue_type)} · ${escapeHtml(formatDate(selected.date))} · ${escapeHtml(formatTime(selected.time))}</p><label class="shortlist-toggle"><input class="shortlist-checkbox" data-event-key="${escapeAttribute(eventKey(selected))}" type="checkbox" ${state.shortlisted.has(eventKey(selected)) ? "checked" : ""} /><span>Shortlist</span></label></div><div class="detail-title-line">${favouriteMark}<h3>${escapeText(selected.event_name)}</h3></div><div class="venue-block"><div class="venue">${escapeText(selected.venue)}</div><div class="location">${escapeText(selected.borough)} · ${escapeHtml(selected.postcode)}</div></div><p class="description">${escapeText(selected.description || "Details available on the source listing.")}</p><div class="genre-list">${(selected.genres || []).map((genre) => `<span class="genre-tag">${escapeText(genre)}</span>`).join("")}</div><div class="detail-footer"><span class="price">${price}</span><a class="ticket-link" href="${escapeAttribute(booking.url)}" target="_blank" rel="noreferrer">${escapeHtml(booking.label)} ↗</a></div>`;
}

function instagramResearchUrl(name, role = "artist") {
  const suffix = role === "artist" ? "musician" : role === "promoter" ? "music promoter" : "London music venue";
  return `https://www.google.com/search?q=${encodeURIComponent(`site:instagram.com "${name}" ${suffix}`)}`;
}

function bookingLink(event) {
  if (event.venue_url) return { url: event.venue_url, label: "Venue tickets" };
  if (event.ticket_url && !event.ticket_url.includes("halibuts.com")) return { url: event.ticket_url, label: "Tickets" };
  const query = [event.event_name, event.artist, event.venue, event.borough, event.date, event.promoter, "tickets"]
    .filter(Boolean).join(" ");
  return { url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, label: "Find tickets" };
}

function formatTime(time) {
  if (!time) return "Time TBC";
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")}${suffix}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[char]));
}

function escapeAttribute(value) { return escapeHtml(value); }

const entityDecoder = document.createElement("textarea");
function decodeEntities(value) {
  const raw = String(value ?? "");
  if (!raw.includes("&")) return raw;
  entityDecoder.innerHTML = raw;
  return entityDecoder.value;
}
// Source listings carry HTML entities (e.g. &ldquo; &oacute;). Decode to real
// characters, then re-escape for safe insertion — never inject decoded markup.
function escapeText(value) { return escapeHtml(decodeEntities(value)); }

render();
