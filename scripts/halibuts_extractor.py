#!/usr/bin/env python3
"""Small, dependency-free Halibuts event extractor.

It discovers event-detail URLs from Halibuts' listing page, then parses the
stable fields exposed on individual event pages. The resulting JSON is meant
to feed the prototype UI or become an input to a fuller database importer.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin
from urllib.request import Request, urlopen

BASE_URL = "https://halibuts.com/"
EVENT_RE = re.compile(r"https://halibuts\.com/events/eventdetail/[^\"'<> ]+", re.I)
DATE_RE = re.compile(r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", re.I)
TIME_RE = re.compile(r"(?:@|open\s*@)\s*(\d{1,2})\.(\d{2})\s*([ap]m)", re.I)
POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", re.I)


class TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.links: list[str] = []

    def handle_data(self, data: str) -> None:
        text = re.sub(r"\s+", " ", html.unescape(data)).strip()
        if text:
            self.parts.append(text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attributes = dict(attrs)
        href = attributes.get("href")
        if href:
            self.links.append(urljoin(BASE_URL, href))


def fetch(url: str) -> str:
    request = Request(url, headers={"User-Agent": "LondonGigPlanner/0.1 (personal research prototype)"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_detail(url: str, source: str) -> dict[str, object]:
    parser = TextParser()
    parser.feed(fetch(url))
    text = parser.parts
    joined = " | ".join(text)

    date_match = DATE_RE.search(joined)
    time_match = TIME_RE.search(joined)
    postcode_match = POSTCODE_RE.search(joined)
    venue = next((item for item in text if postcode_match and postcode_match.group(1) in item), "")
    title = next((item for item in text if item.startswith("## ")), "")
    title = title.removeprefix("## ").strip() or next((item for item in text if item.lower() not in {"halibuts", "more information"}), "Untitled event")

    price_match = re.search(r"Admission:\s*£\s*([\d.]+)", joined, re.I)
    age_match = re.search(r"Age restriction:\s*([^|]+)", joined, re.I)
    performer_match = re.search(r"Performer name:\s*([^|]+)", joined, re.I)

    return {
        "event_name": title,
        "artist": performer_match.group(1).strip() if performer_match else title,
        "date": iso_date(date_match) if date_match else None,
        "time": time_24h(time_match) if time_match else None,
        "venue": venue.rsplit(",", 1)[0].strip() if venue else None,
        "postcode": postcode_match.group(1).upper() if postcode_match else None,
        "genres": [],
        "price": float(price_match.group(1)) if price_match else None,
        "age_restriction": age_match.group(1).strip() if age_match else None,
        "ticket_url": url,
        "source_url": url,
        "source": source,
        "status": "listed",
        "description": description_from(text),
    }


def iso_date(match: re.Match[str]) -> str:
    from datetime import datetime
    month_format = "%b" if len(match.group(2)) <= 3 else "%B"
    return datetime.strptime(f"{match.group(1)} {match.group(2)} {match.group(3)}", f"%d {month_format} %Y").date().isoformat()


def time_24h(match: re.Match[str]) -> str:
    hour = int(match.group(1)) % 12
    if match.group(3).lower() == "pm":
        hour += 12
    return f"{hour:02d}:{match.group(2)}"


def description_from(parts: list[str]) -> str | None:
    ignored = {"More Information", "Halibuts", "Back", "Update /Errors ? Contact us."}
    candidates = [part for part in parts if len(part) > 45 and part not in ignored]
    return candidates[0] if candidates else None


def discover(limit: int) -> list[dict[str, object]]:
    parser = TextParser()
    parser.feed(fetch(BASE_URL))
    urls = list(dict.fromkeys(url for url in parser.links if "/events/eventdetail/" in url))
    # Some pages render event links in script/HTML fragments rather than a
    # normal anchor, so inspect the raw HTML as a fallback.
    if len(urls) < limit:
        urls.extend(url for url in EVENT_RE.findall(fetch(BASE_URL)) if url not in urls)
    records: list[dict[str, object]] = []
    for url in urls[:limit]:
        try:
            records.append(parse_detail(url, "Halibuts"))
        except Exception as exc:  # keep one broken listing from aborting a run
            print(f"warning: could not parse {url}: {exc}", file=sys.stderr)
    return records


def main() -> int:
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--limit", type=int, default=10)
    argument_parser.add_argument("--output", type=str)
    args = argument_parser.parse_args()
    records = discover(max(1, args.limit))
    payload = json.dumps(records, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
