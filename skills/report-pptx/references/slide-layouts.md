# Slide Layouts

python-pptx patterns for Inflexa-branded PowerPoint slides. All layouts use widescreen 16:9 dimensions.

## Presentation Setup

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
```

## Branding Constants

```python
# Colors
NAVY = RGBColor(0x1E, 0x29, 0x3B)       # #1e293b -- headers, titles
DARK_GRAY = RGBColor(0x33, 0x41, 0x55)   # #334155 -- body text
INDIGO = RGBColor(0x4F, 0x46, 0xE5)      # #4f46e5 -- accents, highlights
LIGHT_BG = RGBColor(0xF8, 0xFA, 0xFC)    # #f8fafc -- slide background
WHITE = RGBColor(0xFF, 0xFF, 0xFF)        # #ffffff -- text on dark backgrounds
BORDER_GRAY = RGBColor(0xE2, 0xE8, 0xF0) # #e2e8f0 -- table borders

# Typography
FONT_FAMILY = "Calibri"  # System-safe, available on Windows/Mac/Linux
TITLE_SIZE = Pt(36)
SUBTITLE_SIZE = Pt(20)
HEADING_SIZE = Pt(28)
BODY_SIZE = Pt(18)
CAPTION_SIZE = Pt(14)
SMALL_SIZE = Pt(12)

# Layout margins
MARGIN_LEFT = Inches(0.75)
MARGIN_TOP = Inches(0.75)
CONTENT_WIDTH = Inches(11.833)  # 13.333 - 2 * 0.75
CONTENT_HEIGHT = Inches(6.0)    # 7.5 - 2 * 0.75
```

## Font Fallback

python-pptx embeds font names but not font files. Calibri is the safest choice as it ships with Microsoft Office and is available on most systems. If rendering on a system without Calibri, PowerPoint will substitute Arial or a similar sans-serif font. Do not use web fonts or uncommon typefaces.

## Title Slide

Analysis title, date, and Inflexa branding.

```python
def add_title_slide(prs, title: str, subtitle: str, date_str: str):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank layout

    # Background fill
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = NAVY

    # Title
    txbox = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(2.0), CONTENT_WIDTH, Inches(1.5)
    )
    tf = txbox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = title
    p.font.size = TITLE_SIZE
    p.font.color.rgb = WHITE
    p.font.name = FONT_FAMILY
    p.font.bold = True
    p.alignment = PP_ALIGN.LEFT

    # Subtitle / date
    txbox2 = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(3.8), CONTENT_WIDTH, Inches(1.0)
    )
    tf2 = txbox2.text_frame
    tf2.word_wrap = True
    p2 = tf2.paragraphs[0]
    p2.text = f"{subtitle}  |  {date_str}"
    p2.font.size = SUBTITLE_SIZE
    p2.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)  # Muted gray
    p2.font.name = FONT_FAMILY
    p2.alignment = PP_ALIGN.LEFT

    # Accent bar
    shape = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        MARGIN_LEFT, Inches(3.5),
        Inches(3.0), Inches(0.06)
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = INDIGO
    shape.line.fill.background()

    return slide
```

## Content Slide

Section title with bullet points extracted from narrative text. Limit to 6 bullet points per slide; if the content exceeds that, split across multiple slides.

```python
def add_content_slide(prs, heading: str, bullets: list[str]):
    """Add one or more content slides, splitting at 6 bullets."""
    MAX_BULLETS = 6
    chunks = [bullets[i:i + MAX_BULLETS] for i in range(0, len(bullets), MAX_BULLETS)]

    slides = []
    for idx, chunk in enumerate(chunks):
        slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

        # Section heading
        txbox = slide.shapes.add_textbox(
            MARGIN_LEFT, MARGIN_TOP, CONTENT_WIDTH, Inches(0.8)
        )
        tf = txbox.text_frame
        p = tf.paragraphs[0]
        suffix = f" ({idx + 1}/{len(chunks)})" if len(chunks) > 1 else ""
        p.text = heading + suffix
        p.font.size = HEADING_SIZE
        p.font.color.rgb = NAVY
        p.font.name = FONT_FAMILY
        p.font.bold = True

        # Bullet points
        txbox2 = slide.shapes.add_textbox(
            MARGIN_LEFT, Inches(1.8), CONTENT_WIDTH, Inches(5.0)
        )
        tf2 = txbox2.text_frame
        tf2.word_wrap = True

        for i, bullet in enumerate(chunk):
            p = tf2.paragraphs[0] if i == 0 else tf2.add_paragraph()
            p.text = bullet
            p.font.size = BODY_SIZE
            p.font.color.rgb = DARK_GRAY
            p.font.name = FONT_FAMILY
            p.space_after = Pt(8)
            p.level = 0

        slides.append(slide)
    return slides
```

## Figure Slide

Full-width image with caption below. Scales the image to fit within the content area while preserving aspect ratio.

```python
from PIL import Image as PILImage

def add_figure_slide(prs, image_path: str, caption: str, heading: str = ""):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

    # Optional heading
    if heading:
        txbox = slide.shapes.add_textbox(
            MARGIN_LEFT, Inches(0.4), CONTENT_WIDTH, Inches(0.6)
        )
        tf = txbox.text_frame
        p = tf.paragraphs[0]
        p.text = heading
        p.font.size = HEADING_SIZE
        p.font.color.rgb = NAVY
        p.font.name = FONT_FAMILY
        p.font.bold = True

    # Calculate image dimensions preserving aspect ratio
    img = PILImage.open(image_path)
    img_w, img_h = img.size
    aspect = img_w / img_h

    max_w = Inches(11.0)
    max_h = Inches(5.0)
    img_top = Inches(1.2)

    if aspect > (11.0 / 5.0):
        # Wide image: constrain by width
        width = max_w
        height = int(max_w / aspect)
    else:
        # Tall image: constrain by height
        height = max_h
        width = int(max_h * aspect)

    left = int((prs.slide_width - width) / 2)  # Center horizontally

    slide.shapes.add_picture(image_path, left, img_top, width, height)

    # Caption
    txbox2 = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(6.5), CONTENT_WIDTH, Inches(0.6)
    )
    tf2 = txbox2.text_frame
    tf2.word_wrap = True
    p2 = tf2.paragraphs[0]
    p2.text = caption
    p2.font.size = CAPTION_SIZE
    p2.font.color.rgb = DARK_GRAY
    p2.font.name = FONT_FAMILY
    p2.font.italic = True
    p2.alignment = PP_ALIGN.CENTER

    return slide
```

## Table Slide

python-pptx table with formatted header row and borders.

```python
def add_table_slide(prs, heading: str, headers: list[str], rows: list[list[str]]):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

    # Heading
    txbox = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(0.4), CONTENT_WIDTH, Inches(0.6)
    )
    tf = txbox.text_frame
    p = tf.paragraphs[0]
    p.text = heading
    p.font.size = HEADING_SIZE
    p.font.color.rgb = NAVY
    p.font.name = FONT_FAMILY
    p.font.bold = True

    # Table dimensions
    num_rows = len(rows) + 1  # +1 for header
    num_cols = len(headers)
    table_width = CONTENT_WIDTH
    table_height = Inches(min(5.0, 0.5 * num_rows))

    table_shape = slide.shapes.add_table(
        num_rows, num_cols,
        MARGIN_LEFT, Inches(1.4),
        table_width, table_height
    )
    table = table_shape.table

    # Header row
    for col_idx, header_text in enumerate(headers):
        cell = table.cell(0, col_idx)
        cell.text = header_text
        cell.fill.solid()
        cell.fill.fore_color.rgb = NAVY
        for paragraph in cell.text_frame.paragraphs:
            paragraph.font.size = Pt(14)
            paragraph.font.color.rgb = WHITE
            paragraph.font.name = FONT_FAMILY
            paragraph.font.bold = True

    # Data rows
    for row_idx, row_data in enumerate(rows):
        for col_idx, cell_text in enumerate(row_data):
            cell = table.cell(row_idx + 1, col_idx)
            cell.text = str(cell_text)
            # Alternate row shading
            if row_idx % 2 == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = LIGHT_BG
            for paragraph in cell.text_frame.paragraphs:
                paragraph.font.size = Pt(13)
                paragraph.font.color.rgb = DARK_GRAY
                paragraph.font.name = FONT_FAMILY

    # Set column widths evenly
    col_width = int(table_width / num_cols)
    for col_idx in range(num_cols):
        table.columns[col_idx].width = col_width

    return slide
```

## Two-Column Comparison

Side-by-side layout using positioned text boxes. Useful for comparing conditions, before/after, or original vs. new findings.

```python
def add_comparison_slide(
    prs,
    heading: str,
    left_title: str,
    left_bullets: list[str],
    right_title: str,
    right_bullets: list[str],
):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

    # Heading
    txbox = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(0.4), CONTENT_WIDTH, Inches(0.6)
    )
    tf = txbox.text_frame
    p = tf.paragraphs[0]
    p.text = heading
    p.font.size = HEADING_SIZE
    p.font.color.rgb = NAVY
    p.font.name = FONT_FAMILY
    p.font.bold = True

    col_width = Inches(5.5)
    col_gap = Inches(0.833)

    for col_idx, (col_title, bullets) in enumerate([
        (left_title, left_bullets),
        (right_title, right_bullets),
    ]):
        col_left = MARGIN_LEFT + col_idx * (col_width + col_gap)

        # Column title with accent underline
        title_box = slide.shapes.add_textbox(
            col_left, Inches(1.4), col_width, Inches(0.5)
        )
        tf = title_box.text_frame
        p = tf.paragraphs[0]
        p.text = col_title
        p.font.size = Pt(22)
        p.font.color.rgb = INDIGO
        p.font.name = FONT_FAMILY
        p.font.bold = True

        # Accent underline
        bar = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE,
            col_left, Inches(1.95),
            Inches(2.0), Inches(0.04)
        )
        bar.fill.solid()
        bar.fill.fore_color.rgb = INDIGO
        bar.line.fill.background()

        # Bullet content
        content_box = slide.shapes.add_textbox(
            col_left, Inches(2.2), col_width, Inches(4.5)
        )
        tf = content_box.text_frame
        tf.word_wrap = True
        for i, bullet in enumerate(bullets):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = bullet
            p.font.size = BODY_SIZE
            p.font.color.rgb = DARK_GRAY
            p.font.name = FONT_FAMILY
            p.space_after = Pt(6)

    return slide
```

## Summary Slide

Key statistics displayed in large boxes with a findings count. Used for the final slide to highlight top-level results.

```python
def add_summary_slide(
    prs,
    heading: str,
    stats: list[dict],  # [{"label": "DEGs", "value": "1,247", "detail": "FDR < 0.05"}]
    findings_count: int | None = None,
):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank

    # Heading
    txbox = slide.shapes.add_textbox(
        MARGIN_LEFT, Inches(0.4), CONTENT_WIDTH, Inches(0.6)
    )
    tf = txbox.text_frame
    p = tf.paragraphs[0]
    p.text = heading
    p.font.size = HEADING_SIZE
    p.font.color.rgb = NAVY
    p.font.name = FONT_FAMILY
    p.font.bold = True

    # Stat boxes -- up to 4 across
    num_stats = min(len(stats), 4)
    box_width = Inches(2.5)
    box_height = Inches(2.5)
    total_width = num_stats * box_width + (num_stats - 1) * Inches(0.4)
    start_left = int((prs.slide_width - total_width) / 2)

    for i, stat in enumerate(stats[:4]):
        left = start_left + i * (box_width + Inches(0.4))
        top = Inches(2.0)

        # Box background
        box = slide.shapes.add_shape(
            MSO_SHAPE.ROUNDED_RECTANGLE,
            left, top, box_width, box_height
        )
        box.fill.solid()
        box.fill.fore_color.rgb = LIGHT_BG
        box.line.color.rgb = BORDER_GRAY
        box.line.width = Pt(1)

        # Value (large number)
        val_box = slide.shapes.add_textbox(
            left, Inches(2.2), box_width, Inches(1.2)
        )
        tf = val_box.text_frame
        p = tf.paragraphs[0]
        p.text = str(stat["value"])
        p.font.size = Pt(44)
        p.font.color.rgb = INDIGO
        p.font.name = FONT_FAMILY
        p.font.bold = True
        p.alignment = PP_ALIGN.CENTER

        # Label
        lbl_box = slide.shapes.add_textbox(
            left, Inches(3.3), box_width, Inches(0.5)
        )
        tf = lbl_box.text_frame
        p = tf.paragraphs[0]
        p.text = stat["label"]
        p.font.size = Pt(16)
        p.font.color.rgb = NAVY
        p.font.name = FONT_FAMILY
        p.font.bold = True
        p.alignment = PP_ALIGN.CENTER

        # Detail (optional)
        if stat.get("detail"):
            det_box = slide.shapes.add_textbox(
                left, Inches(3.8), box_width, Inches(0.4)
            )
            tf = det_box.text_frame
            p = tf.paragraphs[0]
            p.text = stat["detail"]
            p.font.size = SMALL_SIZE
            p.font.color.rgb = DARK_GRAY
            p.font.name = FONT_FAMILY
            p.alignment = PP_ALIGN.CENTER

    # Findings count footer
    if findings_count is not None:
        footer_box = slide.shapes.add_textbox(
            MARGIN_LEFT, Inches(5.5), CONTENT_WIDTH, Inches(0.5)
        )
        tf = footer_box.text_frame
        p = tf.paragraphs[0]
        p.text = f"{findings_count} key findings identified across all analyses"
        p.font.size = Pt(16)
        p.font.color.rgb = DARK_GRAY
        p.font.name = FONT_FAMILY
        p.alignment = PP_ALIGN.CENTER

    return slide
```

## Saving the Presentation

```python
output_path = "/session/results/report/report.pptx"
prs.save(output_path)
```

Always save to the step's output artifacts directory under `/session/results/{outputPrefix}/`.
