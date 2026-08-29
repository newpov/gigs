param(
  [int]$Days = 7
)

$ErrorActionPreference = "Stop"

node scripts\halibuts_extractor.mjs --days $Days --output data\halibuts-live.json
if ($LASTEXITCODE -ne 0) { throw "Halibuts refresh failed." }

node --check app.js
node --check scripts\halibuts_extractor.mjs
node --check server.mjs

Write-Host "Gig Scout rebuilt for the next $Days day(s)."
