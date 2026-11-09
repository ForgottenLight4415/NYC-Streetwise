from typing import Any

import pymupdf

doc = pymupdf.open("data/abcs-housing-tenant.pdf")
for page_no, page in enumerate(doc.pages(), 1):
    if page_no < 4:
        continue
    data: Any = page.get_text("dict")
    prev = ""
    for block in data["blocks"]:
        lines = block.get("lines", [])
        texts, sizes = [], []
        for ln in lines:
            spans = [s for s in ln["spans"] if s["text"].strip()]
            if spans:
                texts.append(" ".join(s["text"].strip() for s in spans))
                sizes.append(min(s["size"] for s in spans))
        if not texts:
            continue
        text = " ".join(texts)
        if text.isdigit() or text.startswith(("ABCs OF HOUSING", "TENANTS GUIDE")):
            continue
        if min(sizes) < 9.6 or text.startswith("TIP"):
            print(f"p{page_no} {min(sizes):.1f}pt | after: {prev[-45:]!r} | {text[:55]!r}")
        prev = text