"""Extract all 250 Loop2Scenic scenarios from the datasheet page into JSON/CSV.

    curl -sL -o bench.html https://yuangao-tum.github.io/loop2scenic-bench/
    python3 extract_bench.py bench.html <out_dir>

The page is ~10 MB and inlines every §9 card, so nothing needs JS, a headless
browser, or a download of benchmark_drive/. Fetch it RAW — summarising fetchers
truncate it after §1 and the whole datasheet then looks unavailable.

Two things the markup does not hand over cleanly:

  * Only 150 of the 250 cards carry a visible <p class="gdesc">: the three
    text-bearing splits. The 100 image-only / video-only cards render the media
    and nothing else, and their text survives ONLY inside the card's
    `data-search` attribute — lowercased, with the source name and the tag list
    appended. `_desc_from_search` strips those trailing tokens, but the casing
    is gone for good. Such an entry is flagged desc_source="data-search" and
    lowercase=true; treat it as the benchmark's own annotation of the media,
    not as a verbatim prompt, and read the real image/video under `media` if a
    detail matters.
  * A tag may be the literal "unlabelled" (16 cards) — a card outside the
    taxonomy, not a 51st type. Those are kept in `tags` and excluded from the
    type census.

The datasheet contains TWO type censuses and they disagree, so this script emits
both rather than picking one. §4's ranked table says 50 types / 301 assignments;
the §9 cards carry 47 types / 315. `tag_census.csv` puts them side by side and
the console diff names every type that moved. Prefer the CARD count when
selecting scenarios — it is attached to the description you actually reproduce —
and the §4 total when weighting a coverage rollup, since that is the taxonomy's
own statement of what the benchmark is made of.
"""
import csv, html, json, re, sys
from collections import Counter

CARD = re.compile(r'<article class="gcard".*?</article>', re.S)
# base64 media makes some cards ~45 kB; strip before any other regex touches them
DATA_URI = re.compile(r'src="data:[^"]*"')


def _text(chunk, cls, tag="div"):
    m = re.search(r'<%s class="%s">(.*?)</%s>' % (tag, cls, tag), chunk, re.S)
    return html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""


def _desc_from_search(search, cid, source, tags):
    """Recover a media-only card's annotation from its data-search haystack.

    Layout is `<id> <description> <source> <tag><tag>…`, all lowercased and
    space-joined. Peel the known head and tail off rather than guessing.
    """
    s = search
    if s.startswith(cid.lower()):
        s = s[len(cid):].strip()
    for token in [t.lower() for t in tags][::-1] + [source.lower()]:
        if s.endswith(token):
            s = s[: -len(token)].strip()
    return s


def parse(page):
    rows = []
    for chunk in CARD.findall(page):
        chunk = DATA_URI.sub("", chunk)
        cid = _text(chunk, "gcid")
        source = re.search(r'data-source="([^"]*)"', chunk).group(1)
        tags = [html.unescape(t) for t in
                re.findall(r'<span class="gtag(?: unl)?">([^<]+)</span>', chunk)]
        desc = _text(chunk, "gdesc", "p")
        search = html.unescape(re.search(r'data-search="([^"]*)"', chunk).group(1))
        rows.append({
            "id": cid,
            "split": re.search(r'data-split="([^"]+)"', chunk).group(1),
            "source": source,
            "tags": tags,
            "context": _text(chunk, "gctx"),
            "description": desc or _desc_from_search(search, cid, source, tags),
            "desc_source": "gdesc" if desc else "data-search",
            "lowercase": not desc,
            "media": (re.search(r'data-full="([^"]*)"', chunk) or [None, None])[1]
            if 'data-full="' in chunk else None,
        })
    return rows


def parse_s4(page):
    """§4's ranked table -> {type: total}. Empty if the section moves or goes."""
    start = page.find('id="s4"')
    if start < 0:
        return {}
    end = page.find('id="s5"')
    section = page[start:end if end > start else start + 60_000]
    out = {}
    for row in re.findall(r"<tr>(.*?)</tr>", section, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if len(cells) >= 2 and cells[1].isdigit():
            out[cells[0]] = int(cells[1])
    return out


def main(src, out):
    page = open(src, encoding="utf-8").read()
    rows = parse(page)
    json.dump(rows, open(f"{out}/benchmark_index.json", "w"), indent=1)
    with open(f"{out}/benchmark_index.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "split", "source", "tags", "context", "description",
                    "desc_source", "media"])
        for r in rows:
            w.writerow([r["id"], r["split"], r["source"], "|".join(r["tags"]),
                        r["context"], r["description"], r["desc_source"],
                        r["media"] or ""])

    cards = Counter(t for r in rows for t in r["tags"] if t != "unlabelled")
    print(f"{len(rows)} scenarios; splits {dict(Counter(r['split'] for r in rows))}")
    print(f"{len(cards)} distinct types over {sum(cards.values())} assignments (§9 cards)")
    print("recovered from data-search:", sum(r["lowercase"] for r in rows))
    print("no description at all:", [r["id"] for r in rows if not r["description"]])

    s4 = parse_s4(page)
    with open(f"{out}/tag_census.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["type", "s4_total", "card_total", "delta"])
        for t in sorted(set(s4) | set(cards), key=lambda t: (-s4.get(t, 0), t)):
            a, b = s4.get(t, 0), cards.get(t, 0)
            w.writerow([t, a or "", b or "", b - a])
    print(f"\n§4 table: {len(s4)} types over {sum(s4.values())} assignments")
    only4 = sorted(set(s4) - set(cards))
    only9 = sorted(set(cards) - set(s4))
    moved = sorted((t for t in set(s4) & set(cards) if s4[t] != cards[t]),
                   key=lambda t: -abs(s4[t] - cards[t]))
    print(f"  in §4 but on no card ({len(only4)}): {', '.join(only4) or 'none'}")
    print(f"  on a card but not in §4 ({len(only9)}): {', '.join(only9) or 'none'}")
    print(f"  counted differently ({len(moved)}): " + ", ".join(
        f"{t} {s4[t]}->{cards[t]}" for t in moved[:6]) + (" ..." if len(moved) > 6 else ""))
    print(f"  cards tagged 'unlabelled': "
          f"{sum('unlabelled' in r['tags'] for r in rows)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
