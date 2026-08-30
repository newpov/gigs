# London Gig Planner

A first prototype for finding London gigs in pubs and grassroots venues, starting with Halibuts.

## Run the prototype

```powershell
cd "your folder"
node server.mjs
```

Open <http://localhost:8000>.

The UI is intentionally dependency-free: it is plain HTML, CSS and JavaScript, so it can later be moved into a larger app without replacing the data model.

## Extract Halibuts event pages

The extractor discovers Halibuts event-detail URLs from the main listing page and extracts the fields that are consistently available on an event detail page. The Node version runs in the current workspace without third-party packages.

```powershell
node scripts\halibuts_extractor.mjs --days 8 --output data\halibuts-live.json
```

The default import window is today plus the next seven calendar days, so the planner can show a full seven-day forward window without including today. Use `--days 1` for today's listings only, or `--limit 100` while testing. The importer uses Halibuts' public event-search feed, then visits each event detail page for genres, venue classification, dates/times and booking links.

`halibuts_extractor.py` documents the same adapter using only Python's standard library for environments where Python is available.

If Halibuts exposes a venue/promoter event URL, it is retained as the booking link. Otherwise the importer creates a Google event/tickets search fallback; the Halibuts listing itself is kept separately as `source_url`.

## Current data model

Each event includes:

- `artist` and `event_name`
- ISO `date` and `time`
- `venue`, `postcode` and `borough`
- `genres` as an array, not a single value
- `venue_type` and `include_by_default`
- optional `price`, `age_restriction`, `ticket_url`, `venue_url`
- `source_url`, `status` and `description`

Large venues are retained in the data but hidden by default through the `Include larger venues` toggle.

The default presentation is a compact list for scanning dates, venues, genres and booking actions. The optional Cards view is reserved for future media enrichment such as YouTube embeds and the latest Instagram content.

## Spotify favourite artists

`data/favourite-artists.json` contains the shared starter list of favourite artists. Matching events receive a star and a subtle highlighted row. The page also has a browser-local CSV importer under **Spotify favourites**. Imports can either merge new names into the active list or replace it for that browser, so other people can use their own Spotify export without changing the shared data.

To rebuild the shared list from a Spotify library export:

```powershell
node scripts\import_favourite_artists.mjs --input "path\to\My Spotify Library.CSV" --output data\favourite-artists.json
```

The importer recognises Spotify's `Type`, `Track name`, `Artist name` and `Spotify - id` columns, removes duplicates after normalising case/accents, and stores only artist names plus optional Spotify IDs.

## Quick rebuild and GitHub Pages

For a local refresh after the source data changes:

```powershell
.\rebuild.ps1
```

Pass a different window when needed, for example `.\rebuild.ps1 -Days 1` for today only.

The equivalent shortcuts are `npm run refresh`, `npm run enrich` and `npm run check` on a machine with npm configured.

The repository includes two GitHub Actions workflows. `refresh-halibuts.yml` refreshes today plus the next seven days once every 24 hours at 03:17 UTC, rebuilds the media assignments, and can be run manually from the Actions tab. `pages.yml` deploys the static app whenever `main` changes. After pushing the folder to a GitHub repository, select **GitHub Actions** as the Pages source in the repository's Settings → Pages.

The site itself is static, so GitHub Pages can serve it without a server or database. The scheduled workflow is what keeps `data/halibuts-live.json` current; it commits only when the listings change, which then triggers a new Pages deployment.

To create the repository and push it once:

```powershell
cd "your folder"
git init
git add .
git commit -m "Initial London gig planner"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/london-gig-planner.git
git push -u origin main
```

Replace the remote with the repository URL you create on GitHub. The Actions workflows then handle future feed refreshes and deployments; no manual regeneration on the laptop is needed.

## Media enrichment approach

The next layer should normalise each event's artist lineup into a separate artist table, then attach verified Instagram profiles and two or three YouTube video IDs to the artist record. YouTube searches should try `<artist name> live` first, then fall back to `<artist name>` if needed. Venue and promoter names are useful disambiguation signals for YouTube, but they should not be used as the artist identity.

Instagram matching should prioritise the artist profile, then the event promoter, and use the venue only as a last-resort fallback. Low-confidence matches should be shown for confirmation before being saved, because both Instagram and YouTube contain many same-name artists.

Run `node scripts\enrich_media.mjs` to rebuild `data/artists.json` from the current event feed. Without a `YOUTUBE_API_KEY`, it generates artist-first YouTube and Instagram review links. With a key, pass `--youtube-limit 25` (or another controlled batch size) to fetch up to three candidate video IDs per artist; this avoids spending the entire API quota on one large refresh. Verified assignments can then be saved into `artists.json` and rendered as privacy-enhanced YouTube embeds in Cards view.

### Enrich with a YouTube Data API key

Without a key the Cards/detail views show a "YouTube artist search" link. With a key, `enrich_media.mjs` fetches candidate videos, scores them by artist-name match plus a bonus for live footage, and stores the top three video IDs so the page embeds inline players instead of a search link.

Get a key (free):

1. Sign in at <https://console.cloud.google.com> and create (or select) a project.
2. **APIs & Services -> Library** -> search **YouTube Data API v3** -> **Enable**.
3. **APIs & Services -> Credentials -> Create Credentials -> API key**, then copy it.
4. Restrict the key (recommended): open the key, set **API restrictions** to **YouTube Data API v3**, and leave **Application restrictions** on **None** (it is called from a local Node script, not a browser). Save.

Free quota is 10,000 units/day; a search costs ~100 units, so about 100 artists per day.

Use it (PowerShell) - the key is read from the environment, there is no `.env` file:

```powershell
$env:YOUTUBE_API_KEY = "your-key-here"
node scripts\enrich_media.mjs --youtube-limit 25
```

`$env:...` sets the key for that terminal session only, so it is never written to disk. A run with no `--youtube-limit` (or limit `0`) makes zero API calls even when the key is set. Already-matched artists are skipped, so rerun on later days to enrich more without re-spending quota; reload the page and the Cards view shows the players. **Never commit the key or add it to a tracked file.** To enrich the deployed GitHub Pages site, add the key as a repository Actions secret and pass `--youtube-limit` in the refresh workflow.

Instagram profile URLs and YouTube links can be stored directly in the static JSON. YouTube embeds can use privacy-enhanced `youtube-nocookie.com` URLs; Instagram's latest-post/story data is more restricted and is best treated as an optional link/embed rather than something the public Pages site tries to scrape live.

Booking links use this order:

1. Direct venue/promoter booking URL from Halibuts.
2. External ticket URL discovered on the event page.
3. A Google search query containing the event, performers, venue, date and promoter when available.
