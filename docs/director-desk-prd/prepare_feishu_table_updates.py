from __future__ import annotations

import copy
import json
from pathlib import Path
import xml.etree.ElementTree as ET


BASE = Path("docs/director-desk-prd")
DOC_TOKEN = "B9cbdWifxoDzTtxq28NckEXknwh"


def strip_ids(node: ET.Element) -> ET.Element:
    for item in node.iter():
        item.attrib.pop("id", None)
    return node


def paragraph_with_text(text: str, bold: bool = False) -> ET.Element:
    p = ET.Element("p")
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if index:
            ET.SubElement(p, "br")
        if bold:
            b = ET.SubElement(p, "b")
            b.text = line
        else:
            if index == 0:
                p.text = line
            else:
                br = p[-1]
                br.tail = line
    return p


def text_content(node: ET.Element) -> str:
    parts: list[str] = []
    if node.text:
        parts.append(node.text)
    for child in node:
        if child.tag == "br":
            parts.append("\n")
        parts.append(text_content(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def clean_table(table: ET.Element) -> ET.Element:
    new_table = ET.Element("table")
    colgroup = ET.SubElement(new_table, "colgroup")
    ET.SubElement(colgroup, "col", {"width": "270"})
    ET.SubElement(colgroup, "col", {"width": "610"})
    ET.SubElement(colgroup, "col", {"width": "330"})
    tbody = ET.SubElement(new_table, "tbody")

    rows = table.findall("./tbody/tr")
    header = ET.SubElement(tbody, "tr")
    for title in ["功能", "操作 / 输入 / 输出 / 边界", "原型截图"]:
        td = ET.SubElement(header, "td")
        td.append(paragraph_with_text(title, bold=True))

    for old_row in rows[1:]:
        cells = old_row.findall("./td")
        if len(cells) < 5:
            continue
        tr = ET.SubElement(tbody, "tr")

        feature = ET.SubElement(tr, "td")
        feature.append(strip_ids(copy.deepcopy(cells[1][0])))

        combined = ET.SubElement(tr, "td")
        operation = text_content(cells[2]).strip()
        io = text_content(cells[3]).strip()
        combined.append(paragraph_with_text(f"操作：{operation}\n{io}"))

        screenshot = ET.SubElement(tr, "td")
        for child in cells[4]:
            screenshot.append(strip_ids(copy.deepcopy(child)))

    return new_table


def main() -> None:
    raw = json.loads((BASE / "feishu-current.json").read_text(encoding="utf-16"))
    content = raw["data"]["document"]["content"]
    root = ET.fromstring(f"<root>{content}</root>")
    out_dir = BASE / "feishu-updates"
    out_dir.mkdir(exist_ok=True)

    index = []
    for i, table in enumerate(root.findall("table"), 1):
        block_id = table.attrib["id"]
        new_table = clean_table(table)
        xml = ET.tostring(new_table, encoding="unicode", short_empty_elements=True)
        path = out_dir / f"table-{i}.xml"
        path.write_text(xml, encoding="utf-8")
        index.append({"block_id": block_id, "file": str(path).replace("\\", "/")})

    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(index, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
