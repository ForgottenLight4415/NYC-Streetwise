"""Step 2c: extract the ABCs of Housing tenant guide, one record per bookmarked heading.

The PDF's 37 bookmarks give the heading list, nesting level, and page. Each heading is
located in the page text (searched only on its bookmark's page, so the table of
contents page can never match), and a record's text runs until the next heading.
"""
import json
import re
from pathlib import Path

import pymupdf

SRC = Path("data/abcs-housing-tenant.pdf")
OUT = Path("build/abcs_sections.json")

SKIP = {"Front Cover", "Table of Contents"}
HEADER = re.compile(r"^ABCs OF HOUSING\W+TENANTS GUIDE\s*\d*$")
PAGE_NO = re.compile(r"^\d{1,2}$")


def norm(s: str) -> str:
    """Collapse tabs, thin spaces and runs of whitespace; ignore case."""
    return " ".join(s.split()).casefold()


def find_heading(stream: list[tuple[int, str]], start: int, page_no: int, title: str):
    """Return (line index, lines used, trailing text) or None."""
    target = norm(title)
    for i in range(start, len(stream)):
        pg = stream[i][0]
        if pg < page_no:
            continue
        if pg > page_no:
            break
        for k in (1, 2):  # a long heading may wrap onto a second line
            cand = norm(" ".join(ln for _, ln in stream[i:i + k]))
            if cand.startswith(target):
                return i, k, cand[len(target):].strip()
    return None


def main() -> None:
    doc = pymupdf.open(SRC)

    stream: list[tuple[int, str]] = []
    for page_no, page in enumerate(doc.pages(), 1):
        for i, ln in enumerate(str(page.get_text()).splitlines()):
            text = ln.strip()
            if i < 4 and (HEADER.match(text) or PAGE_NO.match(text)):
                continue  # running header and page number
            stream.append((page_no, ln.rstrip()))

    found: list[dict] = []
    unmatched: list[str] = []
    trailing: list[str] = []
    cursor = 0
    path: list[str] = []
    for level, title, page_no in doc.get_toc():
        if title.strip() in SKIP:
            continue
        hit = find_heading(stream, cursor, page_no, title)
        if hit is None:
            unmatched.append(f"p{page_no} {title!r}")
            continue
        idx, used, extra = hit
        cursor = idx + used
        if extra:
            trailing.append(f"{title!r} -> {extra[:40]!r}")
        del path[level - 1:]
        path.append(" ".join(title.split()))
        found.append({"level": level, "title": " ".join(title.split()), "path": " > ".join(path),
                      "page_start": page_no, "head": idx, "body": idx + used})

    sections: list[dict] = []
    empty: list[str] = []
    for j, f in enumerate(found):
        end = found[j + 1]["head"] if j + 1 < len(found) else len(stream)
        body = [(pg, ln) for pg, ln in stream[f["body"]:end] if ln.strip()]
        if not body:
            empty.append(f["title"])
            continue
        sections.append({"source": "abcs", "id": f"abcs-{len(sections) + 1}", "title": f["title"],
                         "path": f["path"], "level": f["level"], "page_start": f["page_start"],
                         "page_end": body[-1][0], "text": "\n".join(ln for _, ln in body)})

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(sections, indent=2, ensure_ascii=False))

    # --- sanity report ---
    lens = sorted(len(s["text"]) for s in sections)
    print(f"bookmarks used: {len(found) + len(unmatched)} | located in text: {len(found)} | unmatched: {unmatched}")
    print(f"headings with trailing text on the same line: {trailing}")
    print(f"headings with no body text (parents): {empty}")
    print(f"records written: {len(sections)} | chars: min {lens[0]}, median {lens[len(lens) // 2]}, max {lens[-1]}")
    print("largest:", [(s["title"], len(s["text"])) for s in sorted(sections, key=lambda s: -len(s["text"]))[:6]])
    for s in (sections[0], sections[len(sections) // 2], sections[-1]):
        print(f"\n--- {s['id']} | {s['path']} | p{s['page_start']}-{s['page_end']}\n{s['text'][:300]}")


if __name__ == "__main__":
    main()