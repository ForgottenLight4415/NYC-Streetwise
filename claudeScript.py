import json
print([s["id"] for s in json.load(open("build/hmc_sections.json")) if s["id"].startswith("27-2017")])