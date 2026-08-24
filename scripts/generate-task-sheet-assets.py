from __future__ import annotations

from datetime import datetime
from pathlib import Path

from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
OUTPUT_PATH = OUTPUT / "内库-取备货作业单-样张.pdf"

PAGE_WIDTH, PAGE_HEIGHT = landscape(letter)
MARGIN = 30
TABLE_TOP = 495
HEADER_HEIGHT = 34
ROW_HEIGHT = 47
ROWS_PER_PAGE = 9
COLUMN_WIDTHS = (140, 125, 125, 220, 122)
HEADERS = ("SKU", "备货库位", "主库位", "作业结果", "备注")
FONT_NAME = "STSong-Light"
FONT_PATH = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")


def register_fonts() -> None:
    if not FONT_PATH.exists():
        raise FileNotFoundError(f"缺少生成中文 PDF 样张所需的字体：{FONT_PATH}")
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_PATH)))


def column_edges() -> list[float]:
    edges = [MARGIN]
    for width in COLUMN_WIDTHS:
        edges.append(edges[-1] + width)
    return edges


def fit_text(value: str, max_width: float, preferred: float = 12, minimum: float = 8) -> tuple[str, float]:
    text = value.strip() or "-"
    size = preferred
    while size > minimum and pdfmetrics.stringWidth(text, FONT_NAME, size) > max_width:
        size -= 0.5
    if pdfmetrics.stringWidth(text, FONT_NAME, size) <= max_width:
        return text, size
    shortened = text
    while len(shortened) > 1 and pdfmetrics.stringWidth(f"{shortened}…", FONT_NAME, size) > max_width:
        shortened = shortened[:-1]
    return f"{shortened}…", size


def centered_text(pdf: canvas.Canvas, value: str, left: float, right: float, center_y: float, preferred: float = 12) -> None:
    text, size = fit_text(value, right - left - 10, preferred)
    pdf.setFont(FONT_NAME, size)
    pdf.drawCentredString((left + right) / 2, center_y - size * 0.34, text)


def draw_checkbox(pdf: canvas.Canvas, x: float, center_y: float, label: str) -> None:
    size = 11
    pdf.rect(x, center_y - size / 2, size, size, stroke=1, fill=0)
    pdf.setFont(FONT_NAME, 10.5)
    pdf.drawString(x + size + 3, center_y - 3.6, label)


def draw_page(
    pdf: canvas.Canvas,
    task_id: str,
    generated_at: str,
    page_index: int,
    page_count: int,
    rows: list[tuple[str, str, str]],
) -> None:
    pdf.setFillColorRGB(0, 0, 0)
    pdf.setStrokeColorRGB(0, 0, 0)
    pdf.setLineWidth(1)
    pdf.setFont(FONT_NAME, 25)
    pdf.drawString(MARGIN, PAGE_HEIGHT - 45, "内库 · 取备货作业单")

    meta_y = PAGE_HEIGHT - 78
    pdf.setFont(FONT_NAME, 12.5)
    pdf.drawString(MARGIN, meta_y, f"任务号：{task_id}")
    pdf.drawCentredString(PAGE_WIDTH / 2, meta_y, f"日期：{generated_at}")
    pdf.drawRightString(PAGE_WIDTH - MARGIN, meta_y, f"页码：{page_index + 1} / {page_count}")
    pdf.setLineWidth(1.5)
    pdf.line(MARGIN, meta_y - 11, PAGE_WIDTH - MARGIN, meta_y - 11)

    edges = column_edges()
    table_bottom = TABLE_TOP - HEADER_HEIGHT - ROWS_PER_PAGE * ROW_HEIGHT
    pdf.setLineWidth(1)
    for x in edges:
        pdf.line(x, TABLE_TOP, x, table_bottom)
    pdf.line(edges[0], TABLE_TOP, edges[-1], TABLE_TOP)
    pdf.line(edges[0], TABLE_TOP - HEADER_HEIGHT, edges[-1], TABLE_TOP - HEADER_HEIGHT)
    for row_index in range(1, ROWS_PER_PAGE + 1):
        y = TABLE_TOP - HEADER_HEIGHT - row_index * ROW_HEIGHT
        pdf.line(edges[0], y, edges[-1], y)

    header_center_y = TABLE_TOP - HEADER_HEIGHT / 2
    for index, header in enumerate(HEADERS):
        centered_text(pdf, header, edges[index], edges[index + 1], header_center_y, 14)

    for row_index, row in enumerate(rows):
        center_y = TABLE_TOP - HEADER_HEIGHT - row_index * ROW_HEIGHT - ROW_HEIGHT / 2
        centered_text(pdf, row[0], edges[0], edges[1], center_y, 18)
        centered_text(pdf, row[1], edges[1], edges[2], center_y, 17)
        centered_text(pdf, row[2], edges[2], edges[3], center_y, 17)
        result_left = edges[3] + 8
        choice_width = (edges[4] - edges[3] - 16) / 3
        for choice_index, label in enumerate(("全部取出", "部分取出", "退回备货")):
            draw_checkbox(pdf, result_left + choice_index * choice_width, center_y, label)


def main() -> None:
    register_fonts()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = [
        (f"SKU-{index:04d}-A", f"A-A-{index:03d}", f"A-B-{index + 10:03d}")
        for index in range(1, 13)
    ]
    pages = [rows[index:index + ROWS_PER_PAGE] for index in range(0, len(rows), ROWS_PER_PAGE)]
    pdf = canvas.Canvas(str(OUTPUT_PATH), pagesize=landscape(letter), pageCompression=1)
    pdf.setTitle("内库 - 取备货作业单样张")
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    for page_index, page_rows in enumerate(pages):
        draw_page(pdf, "PICK-20260728-001", generated_at, page_index, len(pages), page_rows)
        pdf.showPage()
    pdf.save()
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
