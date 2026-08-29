# London Gig Planner

A first prototype for finding London gigs in pubs and grassroots venues, starting with Halibuts.

## Run the prototype

```powershell
cd "C:\Users\plik\OneDrive\Documenti\Codes\london-gig-planner"
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
cd "C:\Users\plik\OneDrive\Documenti\Codes\london-gig-planner"
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

Instagram profile URLs and YouTube links can be stored directly in the static JSON. YouTube embeds can use privacy-enhanced `youtube-nocookie.com` URLs; Instagram's latest-post/story data is more restricted and is best treated as an optional link/embed rather than something the public Pages site tries to scrape live.

Booking links use this order:

1. Direct venue/promoter booking URL from Halibuts.
2. External ticket URL discovered on the event page.
3. A Google search query containing the event, performers, venue, date and promoter when available.
