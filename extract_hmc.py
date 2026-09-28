"""Step 2a: extract the NYC Housing Maintenance Code into one record per section.

Ground truth for section boundaries = the PDF's own bookmarks (doc.get_toc()).
The page text supplies the real wording, because bookmark titles have fused
words ("Legislativedeclaration").
"""
import json
import re
from pathlib import Path

import pymupdf

SRC = Path("data/HousingMaintenanceCode.pdf")
OUT = Path("build/hmc_sections.json")

NUM = r"27-\s*\d+(?:\.\d+)*"
HEADING = re.compile(rf"^§\s*({NUM})[.\s]*(.*)$")
BOOKMARK = re.compile(rf"^§\s*({NUM})")
STRUCT = re.compile(r"^(SUBCHAPTER\s+\d+|Article\s+\d+[A-Za-z]?)\s*:")
RUNNING_HEADER = [
    re.compile(r"TITLE 27\W+CHAPTER 2"),
    re.compile(r"NEW YORK CITY HOUSING MAINTENANCE CODE"),
    re.compile(r"\d+"),  # page number
]


def clean_num(num: str) -> str:
    return re.sub(r"\s+", "", num)


def sort_key(num: str) -> tuple[int, tuple[int, ...]]:
    """27-2017 < 27-2017.1 < 27-2017.10 < 27-2018 (numeric, not alphabetical)."""
    main, _, dec = num.removeprefix("27-").partition(".")
    return int(main), tuple(int(x) for x in dec.split(".")) if dec else ()


def load_hierarchy(doc: pymupdf.Document) -> dict[str, dict[str, str]]:
    """section number -> its subchapter and article, read from the bookmarks."""
    subchapter, article = "", ""
    meta: dict[str, dict[str, str]] = {}
    for level, title, _page in doc.get_toc():
        if level == 1:
            subchapter, article = title, ""
        elif level == 2:
            article = title
        else:
            m = BOOKMARK.match(title)
            if m:
                meta[clean_num(m.group(1))] = {"subchapter": subchapter, "article": article}
            else:
                print("non-section bookmark:", level, title)
    return meta


def strip_running_header(lines: list[str]) -> list[str]:
    i = 0
    for pattern in RUNNING_HEADER:
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines) and pattern.fullmatch(lines[i].strip()):
            i += 1
    return lines[i:]


def drop_structure_titles(stream: list[tuple[int, str]]) -> tuple[list[tuple[int, str]], int]:
    """Remove 'SUBCHAPTER n:' / 'Article n:' markers and their title lines."""
    out, skipping, dropped = [], False, 0
    for page, line in stream:
        text = line.strip()
        if STRUCT.match(text):
            skipping, dropped = True, dropped + 1
            continue
        if skipping:
            # a title is at most a few lines: stop at a blank line or a real heading
            if not text or HEADING.match(text):
                skipping = False
                if not text:
                    continue
            else:
                continue
        out.append((page, line))
    return out, dropped


def main() -> None:
    doc = pymupdf.open(SRC)
    meta = load_hierarchy(doc)

    stream: list[tuple[int, str]] = []
    for page_no, page in enumerate(doc.pages(), 1):
        lines = str(page.get_text()).splitlines()
        stream += [(page_no, ln.rstrip()) for ln in strip_running_header(lines)]
    stream, dropped = drop_structure_titles(stream)

    sections: list[dict] = []
    seen: set[str] = set()
    stray: list[tuple[int, str]] = []
    unbookmarked: list[str] = []
    current: dict | None = None
    last_key: tuple[int, tuple[int, ...]] = (0, ())
    for page_no, line in stream:
        m = HEADING.match(line.strip())
        num = clean_num(m.group(1)) if m else ""
        # a real heading is bookmarked, or comes later in numeric order than the last one
        # (cross-references that start a line would fail both tests in practice)
        if m and num not in seen and (num in meta or (current and sort_key(num) > last_key)):
            seen.add(num)
            last_key = sort_key(num)
            where = meta.get(num) or {"subchapter": current["subchapter"], "article": current["article"]}
            if num not in meta:
                unbookmarked.append(f"{num} (p{page_no})")
            current = {"source": "hmc", "id": num, "title": m.group(2).strip(),
                       **where, "bookmarked": num in meta,
                       "page_start": page_no, "page_end": page_no, "lines": []}
            sections.append(current)
            continue
        if m:
            stray.append((page_no, line.strip()[:70]))
        if current is not None and line.strip():
            current["lines"].append(line)
            current["page_end"] = page_no

    for s in sections:
        s["text"] = "\n".join(s.pop("lines"))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(sections, indent=2, ensure_ascii=False))

    # --- sanity report ---
    missing = [k for k in meta if k not in seen]
    sizes = sorted(sections, key=lambda s: len(s["text"]), reverse=True)
    lens = sorted(len(s["text"]) for s in sections)
    empty = [(s["id"], s["title"]) for s in sections if not s["text"]]
    print(f"sections written: {len(sections)} | bookmark sections: {len(meta)} | bookmarks not found in text: {missing}")
    print(f"headings found WITHOUT a bookmark ({len(unbookmarked)}): {unbookmarked}")
    print(f"'§' lines kept as body text, not headings ({len(stray)}): {stray}")
    print(f"structure markers dropped: {dropped} | bookmark levels 1+2: {sum(1 for l, _, _ in doc.get_toc() if l < 3)}")
    print(f"leftover running headers: {sum('HOUSING MAINTENANCE CODE' in s['text'] for s in sections)}")
    print(f"empty-text sections ({len(empty)}): {empty[:8]}")
    print(f"chars per section: min {lens[0]}, median {lens[len(lens) // 2]}, max {lens[-1]}")
    print("sections over 2000 / 4000 / 8000 chars:", *(sum(n > t for n in lens) for t in (2000, 4000, 8000)))
    print("largest:", [(s["id"], len(s["text"])) for s in sizes[:8]])
    for s in (sections[0], sections[len(sections) // 2]):
        print(f"\n--- {s['id']} | {s['title']} | {s['subchapter']} > {s['article']} "
              f"| p{s['page_start']}-{s['page_end']}\n{s['text'][:300]}")


if __name__ == "__main__":
    main()