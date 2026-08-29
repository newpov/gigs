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

const state = {
  search: "",
  venueType: "all",
  includeLarge: false,
  genres: new Set(),
  dateRange: "today",
  viewMode: "list"
};

const eventsEl = document.querySelector("#events");
const emptyEl = document.querySelector("#emptyState");
const countEl = document.querySelector("#resultCount");
const genreEl = document.querySelector("#genreFilters");
const excludeGenreEl = document.querySelector("#excludeGenreFilters");
const excludeCountEl = document.querySelector("#excludeCount");
const resultTitleEl = document.querySelector("#resultTitle");
const dateLabelEl = document.querySelector("#dateLabel");

const firstEventDate = events.map((event) => event.date).filter(Boolean).sort()[0];
const today = firstEventDate ? new Date(`${firstEventDate}T12:00:00`) : new Date();
today.setHours(0, 0, 0, 0);
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const todayKey = dateKey(today);

const DEFAULT_EXCLUDED_GENRES = ["Comedy", "Family", "Musical Theatre"];
const EXCLUDED_GENRES_STORAGE_KEY = "gig-scout-excluded-genres";
let savedExcludedGenres = DEFAULT_EXCLUDED_GENRES;
try {
  const storedExcludedGenres = localStorage.getItem(EXCLUDED_GENRES_STORAGE_KEY);
  if (storedExcludedGenres !== null) savedExcludedGenres = JSON.parse(storedExcludedGenres) || [];
} catch {
  savedExcludedGenres = DEFAULT_EXCLUDED_GENRES;
}
state.excludedGenres = new Set(savedExcludedGenres);

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

function saveExcludedGenres() {
  localStorage.setItem(EXCLUDED_GENRES_STORAGE_KEY, JSON.stringify([...state.excludedGenres].sort()));
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

document.querySelector("#search").addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  render();
});

document.querySelector("#venueType").addEventListener("change", (event) => {
  state.venueType = event.target.value;
  render();
});

document.querySelector("#includeLarge").addEventListener("change", (event) => {
  state.includeLarge = event.target.checked;
  render();
});

document.querySelectorAll(".view-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.viewMode = button.dataset.view;
    document.querySelectorAll(".view-button").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

document.querySelectorAll(".date-pill").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".date-pill").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.dateRange = button.dataset.range;
    document.querySelector("#resultTitle").textContent = state.dateRange === "today" ? "Tonight in London" : button.textContent;
    render();
  });
});

function filteredEvents() {
  return events.filter((event) => {
    if (state.dateRange === "today" && event.date !== todayKey) return false;
    if (state.dateRange === "tomorrow" && event.date !== dateAtOffset(1)) return false;
    if (state.dateRange === "week" && (!event.date || event.date < todayKey || event.date > dateAtOffset(6))) return false;
    if (!state.includeLarge && event.venue_type === "Large") return false;
    if (state.venueType !== "all" && event.venue_type !== state.venueType) return false;
    if ((event.genres || []).some((genre) => state.excludedGenres.has(genre))) return false;
    if (state.genres.size && !(event.genres || []).some((genre) => state.genres.has(genre))) return false;
    if (state.search) {
      const haystack = [event.artist, event.event_name, event.venue, event.postcode, event.borough, ...(event.genres || [])].join(" ").toLowerCase();
      if (!haystack.includes(state.search)) return false;
    }
    return true;
  });
}

function render() {
  const visible = filteredEvents();
  eventsEl.classList.toggle("list-view", state.viewMode === "list");
  eventsEl.classList.toggle("card-view", state.viewMode === "cards");
  countEl.textContent = `${visible.length} ${visible.length === 1 ? "event" : "events"}`;
  emptyEl.hidden = visible.length > 0;
  eventsEl.innerHTML = visible.map(card).join("");
  excludeCountEl.textContent = state.excludedGenres.size ? `(${state.excludedGenres.size} hidden)` : "";
  excludeGenreEl.querySelectorAll("button[data-genre]").forEach((button) => button.classList.toggle("active", state.excludedGenres.has(button.dataset.genre)));
  const selectedDate = state.dateRange === "tomorrow" ? dateAtOffset(1) : todayKey;
  dateLabelEl.textContent = state.dateRange === "week" ? `FROM ${formatHeaderDate(todayKey)} · 7 DAYS` : formatHeaderDate(selectedDate);
}

function card(event) {
  const price = event.price == null ? "Price not listed" : `£${event.price.toFixed(2)}`;
  const status = event.status !== "listed" ? `<span class="status">${escapeHtml(event.status)}</span>` : "";
  const booking = bookingLink(event);
  return `<article class="event-card">
    <div class="event-top"><span class="venue-type">${escapeHtml(event.venue_type)} ${status}</span><span class="event-time">${escapeHtml(formatDate(event.date))} · ${escapeHtml(formatTime(event.time))}</span></div>
    <div class="media-slot">${mediaMarkup(event)}</div>
    <h3>${escapeHtml(event.event_name)}</h3>
    <div class="venue">${escapeHtml(event.venue)}</div>
    <div class="location">${escapeHtml(event.borough)} · ${escapeHtml(event.postcode)}</div>
    <p class="description">${escapeHtml(event.description || "Details available on the source listing.")}</p>
    <div class="genre-list">${(event.genres || []).map((genre) => `<span class="genre-tag">${escapeHtml(genre)}</span>`).join("")}</div>
    <div class="card-footer"><span class="price">${price}</span><a class="ticket-link" href="${escapeAttribute(booking.url)}" target="_blank" rel="noreferrer">${escapeHtml(booking.label)} ↗</a></div>
  </article>`;
}

function mediaMarkup(event) {
  const names = String(event.artist || event.event_name).split(/\s*[,;|]\s*/).map((name) => name.trim()).filter(Boolean);
  const artist = names.map((name) => artistByName.get(mediaKey(name))).find(Boolean);
  if (!artist) return `<span class="media-label">Media search unavailable</span>`;

  const videos = artist.youtube?.videos || [];
  const videoBlock = videos.length
    ? `<div class="media-video-grid">${videos.slice(0, 2).map((video) => `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.video_id)}" title="${escapeAttribute(video.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`).join("")}</div>`
    : `<div class="media-actions"><a href="${escapeAttribute(artist.youtube?.live_search_url || `https://www.youtube.com/results?search_query=${encodeURIComponent(`${artist.name} live`)}`)}" target="_blank" rel="noreferrer">YouTube: ${escapeHtml(artist.name)} live ↗</a><a href="${escapeAttribute(artist.youtube?.search_url || `https://www.youtube.com/results?search_query=${encodeURIComponent(artist.name)}`)}" target="_blank" rel="noreferrer">Artist search ↗</a></div>`;
  const instagram = artist.instagram_url
    ? { label: "Instagram profile", url: artist.instagram_url }
    : artist.instagram_candidates?.[0] || { label: "Search artist Instagram", url: `https://www.google.com/search?q=${encodeURIComponent(`site:instagram.com "${artist.name}" musician`)}` };
  return `<div class="media-content"><span class="media-label">${escapeHtml(artist.name)} · media</span>${videoBlock}<div class="media-actions"><a href="${escapeAttribute(instagram.url)}" target="_blank" rel="noreferrer">${escapeHtml(instagram.label)} ↗</a></div></div>`;
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

render();
