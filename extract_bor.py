"""Step 2b: extract the Tenant Bill of Rights into one record per topic."""
import json
from pathlib import Path

from bs4 import BeautifulSoup

SRC = Path("data/tenant-bill-of-rights.html")
OUT = Path("build/bor_sections.json")

START = "As a New York City tenant"                 # content begins after this line
STOP = "Tenant Bill of Rights - Printable"          # flyers / language list begin here
RESOURCES = "For more information"                  # link lists at the end of a topic
# These two topics have no heading tag; they start with a lead-in sentence.
LEAD_INS = {
    "If you live in a rent stabilized unit": "Additional rights: rent stabilized units",
    "If you live in a building covered by Good Cause": "Additional rights: Good Cause Eviction buildings",
}


def main() -> None:
    soup = BeautifulSoup(SRC.read_text(errors="ignore"), "html.parser")
    root = soup.select_one("div.about-description")
    assert root is not None, "content container not found"

    # leaf blocks only, in document order; containers would duplicate their children
    items: list[tuple[str, str]] = []
    for el in root.find_all(["h3", "p", "li"]):
        if el.find(["h3", "p", "li"]):
            continue
        text = " ".join(el.get_text(" ", strip=True).split())
        if text:
            items.append((el.name, text))

    sections: list[dict] = []
    current: dict | None = None
    started = False
    for tag, text in items:
        if not started:
            started = text.startswith(START)
            continue
        if text.startswith(STOP):
            break
        lead = next((t for k, t in LEAD_INS.items() if text.startswith(k)), None)
        if tag == "h3" or lead:
            current = {"source": "tenant_bill_of_rights", "title": lead or text,
                       "lines": [text] if lead else [], "resources": []}
            sections.append(current)
        elif current is not None:
            in_resources = bool(current["resources"]) or text.startswith(RESOURCES)
            current["resources" if in_resources else "lines"].append(text)

    for i, s in enumerate(sections, 1):
        s["id"] = f"bor-{i}"
        s["text"] = "\n".join(s.pop("lines"))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(sections, indent=2, ensure_ascii=False))

    print(f"topics found: {len(sections)}")
    for s in sections:
        print(f"  {s['id']} | {s['title']} | {len(s['text'])} chars | {len(s['resources'])} resource lines")
    print("\nsample:\n", sections[0]["text"][:400] if sections else "NONE")


if __name__ == "__main__":
    main()