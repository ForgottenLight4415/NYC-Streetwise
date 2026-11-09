import re
import unicodedata
from pathlib import Path
from typing import Any

import pymupdf
from bs4 import BeautifulSoup, Tag


def show(s: str):
    odd = {c: unicodedata.name(c, "?") for c in set(s) if ord(c) > 127}
    return repr(s), odd


# 1. HMC: provenance, bookmarks, table of contents, real heading format
hmc = pymupdf.open("data/HousingMaintenanceCode.pdf")
print("HMC metadata:", hmc.metadata)
toc = hmc.get_toc()
print("HMC bookmarks:", len(toc), toc[:6])
pages = [pg.get_text() for pg in hmc.pages()]
print("HMC page 2 text:", repr(pages[1][:1500]))
hits = [(n, i) for n, t in enumerate(pages, 1)
        for i, ln in enumerate(t.splitlines()) if "Short title" in ln]
print("\n'Short title' occurrences (page, line):", hits[:4])
for n, i in hits[:2]:
    lines = pages[n - 1].splitlines()
    for ln in lines[max(0, i - 1): i + 2]:
        print(f"  p{n}:", show(ln))

# 2. ABCs: bookmarks, contents page, bold lines on a body page
abcs = pymupdf.open("data/abcs-housing-tenant.pdf")
print("\nABCs bookmarks:", len(abcs.get_toc()))
print("ABCs page 3 text:", repr(abcs.load_page(2).get_text()[:1500]))
d: Any = abcs.load_page(3).get_text("dict")
print("ABCs page 4 all-bold lines:")
for b in d["blocks"]:
    for ln in b.get("lines", []):
        spans = [s for s in ln["spans"] if s["text"].strip()]
        if spans and all(s["flags"] & 16 for s in spans):
            print("  ", round(spans[0]["size"], 1),
                  repr(" ".join(s["text"].strip() for s in spans)))

# 3. Bill of Rights: everything after the intro, plus where keyword hits live
soup = BeautifulSoup(Path("data/tenant-bill-of-rights.html").read_text(errors="ignore"), "html.parser")
lines = soup.get_text("\n", strip=True).splitlines()
start = next(i for i, ln in enumerate(lines) if ln.startswith("The purpose of this page"))
print(f"\nBill of Rights: {len(lines) - start} lines after the intro starts")
for ln in lines[start:]:
    print("  ", len(ln), ln[:80])
print("\nWhere 'security deposit' occurs:")
for n in soup.find_all(string=re.compile("security deposit", re.I)):
    chain = []
    for p in n.parents:
        if not isinstance(p, Tag) or p.name in ("body", "html"):
            break
        cls = p.get("class") or []
        if isinstance(cls, str):
            cls = cls.split()
        chain.append(f"{p.name}.{'.'.join(cls)}")
        if len(chain) == 4:
            break
    print("  ", " < ".join(chain))