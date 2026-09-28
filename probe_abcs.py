import pymupdf

doc = pymupdf.open("data/abcs-housing-tenant.pdf")
for level, title, page in doc.get_toc():
    print(level, page, repr(title))
print(repr(str(doc.load_page(4).get_text())[:1500]))