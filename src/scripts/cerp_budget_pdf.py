#!/usr/bin/env python3
"""CERP Budget PDF Generator
Replicates budgetExportPDF.ts (ERP frontend) using reportlab canvas.
Usage: python cerp_budget_pdf.py input.json output.pdf
"""
import sys, json, math, io
from datetime import datetime

try:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.colors import HexColor, white
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "reportlab", "-q"])
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.colors import HexColor, white

# ── Brand colors (from pdfTemplate.ts BRAND_COLORS) ──────────────────────────
C_PRIMARY = HexColor('#FE700B')
C_DARK    = HexColor('#1E1E1E')
C_GRAY    = HexColor('#747474')
C_LGRAY   = HexColor('#CBD5E1')
C_LIGHT   = HexColor('#F5F5F5')
C_E8     = HexColor('#E8E8E8')
C_CH0    = HexColor('#E2E8F0')   # chapter depth 0
C_CH1    = HexColor('#F1F5F9')   # chapter depth 1+
C_WHITE  = white

# ── Page geometry ─────────────────────────────────────────────────────────────
PW, PH = A4          # 595.28 × 841.89 pt
ML = MR = MT = MB = 15 * mm
CW = PW - ML - MR    # ~180 mm in pt

# ── Table layout – 11 cols matching ERP's [8,27,13,10,8,19,19,17,19,17,23]mm ─
COL_MM   = [8, 27, 13, 10, 8, 19, 19, 17, 19, 17, 23]
COL_W    = [w * mm for w in COL_MM]
COL_HDR  = ['#', 'Descripcion', 'Codigo', 'Cant.', 'Ud.',
            'Material', 'Mano de Obra', 'Equipos', 'Subcontratado', 'Gastos gen.', 'Total']

# Column descriptors: (key, header, width_mm, opt_flag). 'opt' marks a toggleable
# column driven by the company's PDF printing settings; None = always shown.
# The 'idx' of each column into the fixed 11-length cell list is its position here.
COL_DEFS = [
    ('num',           '#',             8,  None),
    ('desc',          'Descripcion',   27, None),
    ('code',          'Codigo',        13, None),
    ('qty',           'Cant.',         10, 'quantity'),
    ('unit',          'Ud.',           8,  'unit'),
    ('material',      'Material',      19, None),
    ('labor',         'Mano de Obra',  19, None),
    ('equipment',     'Equipos',       17, None),
    ('subcontracted', 'Subcontratado', 19, None),
    ('overhead',      'Gastos gen.',   17, None),
    ('total',         'Total',         23, 'total'),
]
# Right-aligned monetary columns (used across chapter/item rows).
VALUE_KEYS = {'material', 'labor', 'equipment', 'subcontracted', 'overhead', 'total'}


def resolve_pdf_settings(data):
    """Read PDF printing config embedded by the backend (get_budget_details).
    Falls back to showing everything when absent (backward compatible)."""
    budget = data.get('budget') or {}
    ps = budget.get('pdfSettings') or data.get('pdfSettings') or {}
    fields = ps.get('pdfFields') or {}
    pdf_fields = {
        'quantity': fields.get('quantity', True),
        'unit':     fields.get('unit', True),
        'total':    fields.get('total', True),
    }
    show_indirect = ps.get('showIndirectCosts', True)
    return pdf_fields, show_indirect


def build_active_cols(pdf_fields):
    """Filter toggleable columns and redistribute freed width to 'Descripcion'
    so the table keeps its 180mm total. Keeps each column's original cell index."""
    freed = 0.0
    active = []
    for idx, (key, hdr, mmw, opt) in enumerate(COL_DEFS):
        if opt is not None and not pdf_fields.get(opt, True):
            freed += mmw
        else:
            active.append({'key': key, 'hdr': hdr, 'mm': mmw, 'idx': idx})
    for col in active:
        if col['key'] == 'desc':
            col['mm'] += freed
            break
    for col in active:
        col['w'] = col['mm'] * mm
    return active


# Active columns for the current render (set by BudgetPDFGen before drawing).
_COLS = build_active_cols({'quantity': True, 'unit': True, 'total': True})

ROW_H_HDR  = 7  * mm
ROW_H_CH   = 6  * mm
ROW_H_ITEM = 5.5* mm
ROW_H_DESC = 7  * mm  # minimum
ROW_H_SUMM = 6  * mm

# ── Helpers ───────────────────────────────────────────────────────────────────
def fmt_date(s):
    if not s:
        return datetime.now().strftime('%d/%m/%Y')
    try:
        return datetime.fromisoformat(str(s)[:10]).strftime('%d/%m/%Y')
    except Exception:
        return str(s)[:10]

def fmt_money(n, sym='$'):
    try:
        v = float(n or 0)
        s = f"{v:,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
        return f"{sym} {s}"
    except Exception:
        return f"{sym} 0,00"

def fmt_qty(n):
    try:
        v = float(n or 0)
        if v == int(v):
            return f"{int(v):,}".replace(',', '.')
        return f"{v:,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
    except Exception:
        return '0'

def clip(c, text, font, size, max_w):
    """Truncate text to fit max_w pts."""
    while len(text) > 1 and c.stringWidth(text, font, size) > max_w:
        text = text[:-1]
    return text

def y_rl(y_top):
    """Convert y-from-top (mm origin at top) to reportlab y (origin at bottom)."""
    return PH - y_top

# ── Company data extraction ───────────────────────────────────────────────────
def get_company(data):
    co = data.get('company') or {}
    bi = (co.get('settings') or {}).get('businessInfo') or {}
    ad = (co.get('settings') or {}).get('address') or {}
    parts = [
        ad.get('street', ''),
        ' '.join(filter(None, [ad.get('postalCode', ''), ad.get('city', '')])),
        ad.get('country', ''),
    ]
    address = ', '.join(p for p in parts if p)
    return {
        'name':    bi.get('legalName') or bi.get('commercialName') or co.get('name', ''),
        'taxId':   bi.get('taxId', ''),
        'phone':   bi.get('phone', ''),
        'email':   bi.get('email', ''),
        'address': address,
    }

# ── Price calculations ────────────────────────────────────────────────────────
def item_unit_price(item):
    snap = item.get('productSnapshot') or {}
    bd   = snap.get('costBreakdown') or {}
    base = sum(float(bd.get(k) or 0) for k in ('materials', 'labor', 'equipment', 'subcontracted'))
    oh   = float(item.get('overheadOverride') or snap.get('overheadPercentage') or 0)
    factor = 1 + oh / 100
    return base * factor, {
        'materials':     float(bd.get('materials') or 0) * factor,
        'labor':         float(bd.get('labor') or 0) * factor,
        'equipment':     float(bd.get('equipment') or 0) * factor,
        'subcontracted': float(bd.get('subcontracted') or 0) * factor,
        'overhead':      base * oh / 100,
    }

def collect_leaves(node, items_by_id):
    result = []
    for child in node.get('children') or []:
        if child.get('type') == 'item':
            result.append(items_by_id.get(child['_id']) or child)
        else:
            result.extend(collect_leaves(child, items_by_id))
    return result

def compute_totals(budget, leaf_items):
    direct = sum(item_unit_price(i)[0] * float(i.get('quantity') or 0) for i in leaf_items)
    cis = sorted(budget.get('costItems') or [], key=lambda x: x.get('order', 0))
    ct_types = ('calculated', 'variable')

    s1 = direct
    for ci in (c for c in cis if c.get('group') == 1):
        if ci.get('costType') in ct_types and ci.get('percentage'):
            s1 += direct * float(ci['percentage']) / 100
        elif ci.get('costType') == 'fixed':
            s1 += float(ci.get('fixedAmount') or 0)

    s2 = s1
    for ci in (c for c in cis if c.get('group') == 2):
        if ci.get('costType') in ct_types and ci.get('percentage'):
            s2 += s1 * float(ci['percentage']) / 100
        elif ci.get('costType') == 'fixed':
            s2 += float(ci.get('fixedAmount') or 0)

    total = s2
    for ci in (c for c in cis if c.get('group') == 3):
        if ci.get('costType') in ct_types and ci.get('percentage'):
            total += s2 * float(ci['percentage']) / 100
        elif ci.get('costType') == 'fixed':
            total += float(ci.get('fixedAmount') or 0)

    return direct, s1, s2, total

# ── Tree flattening (mirrors ERP's flattenTree) ───────────────────────────────
def flatten_tree(tree, items_by_id, sym, depth=0):
    rows = []
    for node in tree:
        ntype = node.get('type', 'item')
        item_doc = items_by_id.get(node.get('_id', '')) or node

        if ntype == 'chapter':
            leaves = collect_leaves(node, items_by_id)
            agg = {'materials': 0, 'labor': 0, 'equipment': 0, 'subcontracted': 0, 'overhead': 0, 'total': 0}
            for lf in leaves:
                up, bd = item_unit_price(lf)
                qty = float(lf.get('quantity') or 0)
                for k in agg:
                    agg[k] += (bd[k] if k != 'total' else up) * qty

            hn   = node.get('hierarchyNumber') or item_doc.get('hierarchyNumber', '')
            name = node.get('name') or item_doc.get('name', '')
            rows.append({
                'rtype': 'chapter', 'depth': depth,
                'cells': [
                    hn, name, '', '', '',
                    fmt_money(agg['materials'], sym),
                    fmt_money(agg['labor'], sym),
                    fmt_money(agg['equipment'], sym),
                    fmt_money(agg['subcontracted'], sym),
                    fmt_money(agg['overhead'], sym),
                    fmt_money(agg['total'], sym),
                ],
                'raw': '',
            })

            desc = (item_doc.get('description') or '').strip()
            if desc:
                rows.append({'rtype': 'desc', 'depth': depth, 'cells': [], 'raw': desc})

            rows.extend(flatten_tree(node.get('children') or [], items_by_id, sym, depth + 1))

        else:  # item
            up, bd = item_unit_price(item_doc)
            qty  = float(item_doc.get('quantity') or 0)
            snap = item_doc.get('productSnapshot') or {}
            hn   = node.get('hierarchyNumber', '')
            name = node.get('name') or item_doc.get('name', '')
            rows.append({
                'rtype': 'item', 'depth': depth,
                'cells': [
                    hn, name,
                    snap.get('code', ''),
                    fmt_qty(qty) if qty else '-',
                    snap.get('unit', '-'),
                    fmt_money(bd['materials'] * qty, sym),
                    fmt_money(bd['labor'] * qty, sym),
                    fmt_money(bd['equipment'] * qty, sym),
                    fmt_money(bd['subcontracted'] * qty, sym),
                    fmt_money(bd['overhead'] * qty, sym),
                    fmt_money(up * qty, sym),
                ],
                'raw': '',
            })
    return rows

# ── Low-level drawing (canvas primitives) ────────────────────────────────────
def fill_rect(c, x, y_top, w, h, color):
    c.setFillColor(color)
    c.rect(x, y_rl(y_top + h), w, h, stroke=0, fill=1)

def hline(c, x1, x2, y_top, color, lw=0.3):
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    c.line(x1, y_rl(y_top), x2, y_rl(y_top))

def text_l(c, x, y_top, txt, font, size, color):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(x, y_rl(y_top), txt)

def text_r(c, x, y_top, txt, font, size, color):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawRightString(x, y_rl(y_top), txt)

def text_c(c, x, y_top, txt, font, size, color):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawCentredString(x, y_rl(y_top), txt)

def text_mid(c, x, y_top, h, txt, font, size, color, align='left', x2=None):
    """Draw text vertically centered within a row of height h."""
    # Vertical center: baseline ≈ y_top + h/2 + size*0.35mm (approx cap-height half)
    baseline = y_top + h / 2 + size * 0.12 * mm
    if align == 'right' and x2 is not None:
        text_r(c, x2, baseline, txt, font, size, color)
    elif align == 'center' and x2 is not None:
        text_c(c, (x + x2) / 2, baseline, txt, font, size, color)
    else:
        text_l(c, x, baseline, txt, font, size, color)

# ── Header (drawBudgetHeader) ─────────────────────────────────────────────────
def draw_header(c, budget, company, page_num, total_pages):
    """Draw repeating page header. Returns y_top where content starts."""
    left  = ML
    right = PW - MR
    y = MT

    LOGO_AREA_H = 15 * mm

    # "PRESUPUESTO" 15pt bold-italic right-aligned (baseline at y + 9mm)
    c.setFont('Helvetica-BoldOblique', 15)
    c.setFillColor(C_DARK)
    c.drawRightString(right, y_rl(y + 9 * mm), 'PRESUPUESTO')

    # Company name 7pt bold orange below logo area
    co_name = company['name']
    if co_name:
        c.setFont('Helvetica-Bold', 7)
        c.setFillColor(C_PRIMARY)
        c.drawString(left, y_rl(y + LOGO_AREA_H + 1.5 * mm), co_name)

    y += LOGO_AREA_H + (7 * mm if co_name else 3 * mm)

    # Orange separator 0.6pt
    hline(c, left, right, y, C_PRIMARY, lw=0.6)
    y += 4 * mm

    # Two-column data block
    col_w  = (right - left - 5 * mm) / 2
    lx     = left
    rx     = left + col_w + 5 * mm
    ROW_H  = 4.2 * mm

    # Column labels 6.5pt bold gray
    c.setFont('Helvetica-Bold', 6.5)
    c.setFillColor(C_GRAY)
    c.drawString(lx, y_rl(y), 'DATOS DEL CLIENTE')
    c.drawString(rx, y_rl(y), 'DATOS DEL PRESUPUESTO')
    y += ROW_H + 0.5 * mm

    def draw_field(x, fy, label, value):
        lbl = label + ':'
        c.setFont('Helvetica-Bold', 7)
        c.setFillColor(C_GRAY)
        c.drawString(x, y_rl(fy), lbl)
        lbl_w = c.stringWidth(lbl, 'Helvetica-Bold', 7) + 1.5 * mm
        c.setFont('Helvetica', 7)
        c.setFillColor(C_DARK)
        val = clip(c, str(value), 'Helvetica', 7, col_w - lbl_w - 2 * mm)
        c.drawString(x + lbl_w, y_rl(fy), val)

    snap = budget.get('contactSnapshot') or {}
    client_fields = [(l, v) for l, v in [
        ('Nombre',    snap.get('name', '')),
        ('Direccion', snap.get('street', '')),
        ('Localidad', snap.get('city', '')),
        ('Pais',      snap.get('country', '')),
    ] if v]

    issue = budget.get('issueDate') or budget.get('createdAt')
    budget_fields = [(l, v) for l, v in [
        ('N. Presupuesto',   str(budget['budgetNumber'])  if budget.get('budgetNumber')  else None),
        ('Revision',         str(budget['revision'])      if budget.get('revision') is not None else None),
        ('Fecha de emision', fmt_date(issue)),
        ('Valido hasta',     fmt_date(budget['expiryDate']) if budget.get('expiryDate') else None),
        ('Pagina',           f"{page_num} de {total_pages}"),
    ] if v]

    max_rows = max(len(client_fields), len(budget_fields), 3)
    for i in range(max_rows):
        if i < len(client_fields):
            draw_field(lx, y, client_fields[i][0], client_fields[i][1])
        if i < len(budget_fields):
            draw_field(rx, y, budget_fields[i][0], budget_fields[i][1])
        y += ROW_H

    # Gray bottom separator
    y += 2 * mm
    hline(c, left, right, y, C_LGRAY, lw=0.3)
    y += 4 * mm

    return y   # content starts here

# ── Footer (addFooter) ────────────────────────────────────────────────────────
def draw_footer(c, company, page_num, total_pages):
    """Draw footer. Mirrors addFooter() from budgetExportPDF.ts."""
    left  = ML
    right = PW - MR
    cx    = PW / 2
    cw    = right - left

    FOOTER_LINE_Y_FROM_BOTTOM = MB + 2 * mm   # pt from bottom
    LINE_SPACING = 4 * mm

    # Company info parts
    co = company
    parts = [p for p in [
        co['name'],
        co['address'],
        f"Tel: {co['phone']}" if co['phone'] else '',
        f"e-mail: {co['email']}" if co['email'] else '',
    ] if p]
    full_line = '  \xb7  '.join(parts)

    c.setFont('Helvetica', 6.5)
    if c.stringWidth(full_line, 'Helvetica', 6.5) > cw and len(parts) > 2:
        mid = math.ceil(len(parts) / 2)
        footer_lines = [
            '  \xb7  '.join(parts[:mid]),
            '  \xb7  '.join(parts[mid:]),
        ]
    else:
        footer_lines = [full_line]

    if co['taxId']:
        footer_lines.append(co['taxId'])

    # Separator line
    hline(c, left, right, PH - FOOTER_LINE_Y_FROM_BOTTOM, C_LGRAY, lw=0.3)

    # base_y (pt from bottom) = footer_line + LINE_SPACING
    base_y = FOOTER_LINE_Y_FROM_BOTTOM + LINE_SPACING

    c.setFont('Helvetica', 6.5)
    c.setFillColor(C_DARK)
    for idx, line in enumerate(footer_lines):
        if line:
            c.drawCentredString(cx, base_y + idx * LINE_SPACING, line)

    # Page number right on last line
    page_y = base_y + (len(footer_lines) - 1) * LINE_SPACING
    c.setFillColor(C_GRAY)
    c.drawRightString(right, page_y, f"Pagina {page_num} de {total_pages}")

# ── Table row drawers ─────────────────────────────────────────────────────────
def draw_tbl_header_row(c, y):
    fill_rect(c, ML, y, CW, ROW_H_HDR, C_PRIMARY)
    c.setFont('Helvetica-Bold', 6)
    c.setFillColor(C_WHITE)
    cx = ML
    for col in _COLS:
        w = col['w']
        txt = clip(c, col['hdr'], 'Helvetica-Bold', 6, w - 3 * mm)
        c.drawString(cx + 1.5 * mm, y_rl(y + ROW_H_HDR / 2 + 0.5 * mm), txt)
        cx += w
    return y + ROW_H_HDR

def draw_chapter_row(c, cells, depth, y):
    bg = C_CH0 if depth == 0 else C_CH1
    fill_rect(c, ML, y, CW, ROW_H_CH, bg)
    cx = ML
    for col in _COLS:
        w   = col['w']
        key = col['key']
        cell = str(cells[col['idx']])
        if key == 'num':
            txt = clip(c, cell, 'Helvetica-Bold', 7, w - 3 * mm)
            text_mid(c, cx + 1.5 * mm, y, ROW_H_CH, txt, 'Helvetica-Bold', 7, C_DARK)
        elif key == 'desc':
            indent = 1.5 * mm + depth * 2 * mm
            txt = clip(c, cell, 'Helvetica-Bold', 7, w - indent - 2 * mm)
            text_mid(c, cx + indent, y, ROW_H_CH, txt, 'Helvetica-Bold', 7, C_DARK)
        elif key in VALUE_KEYS:
            txt = clip(c, cell, 'Helvetica-Bold', 7, w - 3 * mm)
            text_mid(c, cx, y, ROW_H_CH, txt, 'Helvetica-Bold', 7, C_DARK, align='right', x2=cx + w - 1.5 * mm)
        # code/qty/unit are blank on chapter rows → nothing to draw
        cx += w
    return y + ROW_H_CH

def draw_desc_row(c, raw, depth, y):
    if not raw.strip():
        return y
    bg = C_CH0 if depth == 0 else C_CH1
    desc_x   = ML + COL_W[0] + 1.5 * mm + depth * 2 * mm
    avail_w  = PW - MR - desc_x - 2 * mm

    # Wrap text
    c.setFont('Helvetica-Oblique', 6.5)
    words = raw.split()
    lines_text = ['']
    for word in words:
        test = (lines_text[-1] + ' ' + word).strip()
        if c.stringWidth(test, 'Helvetica-Oblique', 6.5) <= avail_w:
            lines_text[-1] = test
        else:
            lines_text.append(word)

    line_h = 6.5 * 0.3528 * 1.15 * mm
    row_h  = max(ROW_H_DESC, len(lines_text) * line_h + 3 * mm)

    fill_rect(c, ML, y, CW, row_h, bg)
    c.setFont('Helvetica-Oblique', 6.5)
    c.setFillColor(C_GRAY)
    ty = y + 3 * mm
    for ln in lines_text:
        c.drawString(desc_x, y_rl(ty), ln)
        ty += line_h

    return y + row_h

def draw_item_row(c, cells, depth, item_idx, y):
    if item_idx % 2 == 0:
        fill_rect(c, ML, y, CW, ROW_H_ITEM, C_LIGHT)
    cx = ML
    for col in _COLS:
        w   = col['w']
        key = col['key']
        cell = str(cells[col['idx']])
        if key == 'num':
            txt = clip(c, cell, 'Helvetica', 6, w - 3 * mm)
            text_mid(c, cx + 1.5 * mm, y, ROW_H_ITEM, txt, 'Helvetica', 6, C_DARK)
        elif key == 'desc':
            indent = 1.5 * mm + depth * 2 * mm
            txt = clip(c, cell, 'Helvetica', 6, w - indent - 2 * mm)
            text_mid(c, cx + indent, y, ROW_H_ITEM, txt, 'Helvetica', 6, C_DARK)
        elif key == 'code':
            txt = clip(c, cell, 'Helvetica', 5.5, w - 3 * mm)
            text_mid(c, cx + 1.5 * mm, y, ROW_H_ITEM, txt, 'Helvetica', 5.5, C_GRAY)
        else:  # qty, unit and monetary columns → right aligned
            txt = clip(c, cell, 'Helvetica', 6, w - 3 * mm)
            text_mid(c, cx, y, ROW_H_ITEM, txt, 'Helvetica', 6, C_DARK, align='right', x2=cx + w - 1.5 * mm)
        cx += w
    return y + ROW_H_ITEM

def draw_tbl_total_row(c, direct, sym, y):
    H = ROW_H_CH + 1 * mm
    fill_rect(c, ML, y, CW, H, C_LGRAY)
    text_mid(c, ML + 2 * mm, y, H, 'Total Costos Directos', 'Helvetica-Bold', 7, C_DARK)
    text_mid(c, ML, y, H, fmt_money(direct, sym), 'Helvetica-Bold', 7, C_DARK,
             align='right', x2=ML + CW - 1.5 * mm)
    return y + H

SECTION_H = 8 * mm + 4 * mm  # rect + spacing

def draw_section_title(c, title, y):
    fill_rect(c, ML, y, CW, 8 * mm, C_LIGHT)
    c.setFont('Helvetica-Bold', 11)
    c.setFillColor(C_PRIMARY)
    c.drawString(ML + 3 * mm, y_rl(y + 6 * mm), title)
    return y + 8 * mm + 4 * mm

# ── Generator class ───────────────────────────────────────────────────────────
class BudgetPDFGen:
    def __init__(self, data, dest, total_pages=1):
        self.data         = data
        self.budget       = data.get('budget') or {}
        self.items        = data.get('items') or []
        self.tree         = data.get('tree') or []
        self.company      = get_company(data)
        self.sym          = data.get('currencySymbol') or '$'
        self.total_pages  = total_pages

        # PDF printing config (columns + indirect costs) from company settings.
        self.pdf_fields, self.show_indirect = resolve_pdf_settings(data)
        self._cols = build_active_cols(self.pdf_fields)

        self.items_by_id  = {it['_id']: it for it in self.items if it.get('_id')}
        self.leaves       = [i for i in self.items if i.get('type') == 'item']
        self.direct, self.s1, self.s2, self.grand = compute_totals(self.budget, self.leaves)
        self.flat_rows    = flatten_tree(self.tree, self.items_by_id, self.sym)

        self.c            = rl_canvas.Canvas(dest, pagesize=A4)
        self.page_num     = 0

    def _header_height(self):
        co_name = self.company['name']
        LOGO_AREA_H = 15 * mm
        snap = self.budget.get('contactSnapshot') or {}
        client_rows = sum(1 for v in [snap.get('name'), snap.get('street'), snap.get('city'), snap.get('country')] if v)
        budget_rows = sum(1 for v in [
            self.budget.get('budgetNumber'), self.budget.get('revision'),
            True, self.budget.get('expiryDate'), True
        ] if v)
        rows = max(client_rows, budget_rows, 3)
        y  = MT
        y += LOGO_AREA_H + (7 * mm if co_name else 3 * mm)
        y += 4 * mm       # orange line
        y += 4.2 * mm + 0.5 * mm  # labels row
        y += rows * 4.2 * mm
        y += 2 * mm + 4 * mm      # bottom separator + gap
        return y

    def _content_bottom(self):
        return PH - MB - 10 * mm   # leave room for footer

    def _new_page(self):
        if self.page_num > 0:
            self.c.showPage()
        self.page_num += 1
        draw_header(self.c, self.budget, self.company, self.page_num, self.total_pages)
        draw_footer(self.c, self.company, self.page_num, self.total_pages)
        return self._header_height()

    def _need_break(self, y, h):
        return y + h > self._content_bottom()

    def _check_break(self, y, h):
        if self._need_break(y, h):
            y = self._new_page()
        return y

    # ── Sections ─────────────────────────────────────────────────────────────
    def _draw_resumen_capitulos(self, y):
        y = self._check_break(y, SECTION_H + ROW_H_HDR)
        y = draw_section_title(self.c, 'Resumen por Capitulos', y)

        ROW_H = ROW_H_SUMM
        # Header row
        fill_rect(self.c, ML, y, CW, ROW_H, C_PRIMARY)
        c = self.c
        c.setFont('Helvetica-Bold', 7)
        c.setFillColor(C_WHITE)
        c.drawString(ML + 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), 'N.')
        c.drawString(ML + 20 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), 'Descripcion')
        c.drawRightString(ML + CW - 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), 'Importe')
        y += ROW_H

        total_direct = 0
        for i, node in enumerate([n for n in self.tree if n.get('type') == 'chapter']):
            y = self._check_break(y, ROW_H)
            bg = C_LIGHT if i % 2 == 0 else C_WHITE
            fill_rect(self.c, ML, y, CW, ROW_H, bg)

            leaves = collect_leaves(node, self.items_by_id)
            ch_tot = sum(item_unit_price(lf)[0] * float(lf.get('quantity') or 0) for lf in leaves)
            total_direct += ch_tot

            hn   = node.get('hierarchyNumber', '')
            name = node.get('name', '')
            c.setFont('Helvetica', 7)
            c.setFillColor(C_DARK)
            c.drawString(ML + 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), str(hn))
            c.drawString(ML + 20 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm),
                         clip(c, name, 'Helvetica', 7, CW - 60 * mm))
            c.drawRightString(ML + CW - 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm),
                              fmt_money(ch_tot, self.sym))
            y += ROW_H

        # Total row
        y = self._check_break(y, ROW_H + 2 * mm)
        fill_rect(self.c, ML, y, CW, ROW_H + 2 * mm, C_LGRAY)
        c.setFont('Helvetica-Bold', 8)
        c.setFillColor(C_DARK)
        c.drawString(ML + 2 * mm, y_rl(y + (ROW_H + 2 * mm) / 2 + 0.5 * mm),
                     'TOTAL COSTOS DIRECTOS (PEM)')
        c.drawRightString(ML + CW - 2 * mm, y_rl(y + (ROW_H + 2 * mm) / 2 + 0.5 * mm),
                          fmt_money(total_direct, self.sym))
        return y + ROW_H + 2 * mm + 6 * mm

    def _draw_detail_table(self, y):
        y = self._check_break(y, SECTION_H + ROW_H_HDR)
        y = draw_section_title(self.c, 'Presupuesto Detallado', y)

        y = self._check_break(y, ROW_H_HDR)
        y = draw_tbl_header_row(self.c, y)

        item_idx = 0
        for row in self.flat_rows:
            rtype = row['rtype']
            if rtype == 'chapter':
                h = ROW_H_CH
                if self._need_break(y, h):
                    y = self._new_page()
                    y = draw_tbl_header_row(self.c, y)
                y = draw_chapter_row(self.c, row['cells'], row['depth'], y)

            elif rtype == 'desc':
                if self._need_break(y, ROW_H_DESC):
                    y = self._new_page()
                    y = draw_tbl_header_row(self.c, y)
                y = draw_desc_row(self.c, row['raw'], row['depth'], y)

            elif rtype == 'item':
                h = ROW_H_ITEM
                if self._need_break(y, h):
                    y = self._new_page()
                    y = draw_tbl_header_row(self.c, y)
                y = draw_item_row(self.c, row['cells'], row['depth'], item_idx, y)
                item_idx += 1

        y = self._check_break(y, ROW_H_CH + 2 * mm)
        y = draw_tbl_total_row(self.c, self.direct, self.sym, y)
        return y + 4 * mm

    def _draw_coeff_k(self, y):
        y = self._check_break(y, SECTION_H)
        y = draw_section_title(self.c, 'Coeficiente K - Costos Indirectos', y)

        ROW_H = 6 * mm
        # Direct costs row
        y = self._check_break(y, ROW_H)
        fill_rect(self.c, ML, y, CW, ROW_H, C_LIGHT)
        text_mid(self.c, ML + 2 * mm, y, ROW_H, 'Costos Directos', 'Helvetica-Bold', 9, C_DARK)
        text_mid(self.c, ML, y, ROW_H, fmt_money(self.direct, self.sym), 'Helvetica-Bold', 9, C_DARK,
                 align='right', x2=ML + CW - 2 * mm)
        y += ROW_H + 3 * mm

        cost_items = sorted(self.budget.get('costItems') or [], key=lambda x: x.get('order', 0))
        if not cost_items:
            cost_items = [
                {'name': 'Gastos Generales',     'costType': 'variable', 'percentage': 13, 'group': 1, 'order': 0},
                {'name': 'Beneficio Industrial', 'costType': 'variable', 'percentage': 6,  'group': 2, 'order': 0},
                {'name': 'IVA',                  'costType': 'variable', 'percentage': 21, 'group': 3, 'order': 0},
            ]

        GROUP_TITLES = {
            1: 'GRUPO 1 - GASTOS GENERALES',
            2: 'GRUPO 2 - BENEFICIO E IMPUESTOS',
            3: 'GRUPO 3 - GASTOS FINANCIEROS',
        }
        bases    = {1: self.direct, 2: self.s1, 3: self.s2}
        subtots  = {1: self.s1,     2: self.s2, 3: self.grand}

        for g in (1, 2, 3):
            g_items = [ci for ci in cost_items if ci.get('group') == g]
            if not g_items:
                continue
            base = bases[g]

            y = self._check_break(y, ROW_H * (len(g_items) + 3))
            self.c.setFont('Helvetica-Bold', 8)
            self.c.setFillColor(C_GRAY)
            self.c.drawString(ML + 2 * mm, y_rl(y + 4 * mm), GROUP_TITLES.get(g, f'GRUPO {g}'))
            y += 6 * mm

            for i, ci in enumerate(g_items):
                y = self._check_break(y, ROW_H + 2 * mm)
                if i % 2 == 0:
                    fill_rect(self.c, ML, y, CW, ROW_H, C_LIGHT)

                label = ci.get('name', '')
                ct    = ci.get('costType', '')
                pct   = ci.get('percentage')
                if ct in ('variable', 'calculated') and pct:
                    label += f" ({pct}%)"

                text_mid(self.c, ML + 8 * mm, y, ROW_H, label, 'Helvetica', 8, C_DARK)
                text_mid(self.c, ML + CW * 0.55, y, ROW_H,
                         'Variable' if ct in ('variable', 'calculated') else 'Fijo',
                         'Helvetica', 7, C_GRAY)

                amount = (base * float(pct) / 100
                          if ct in ('variable', 'calculated') and pct
                          else float(ci.get('fixedAmount') or 0))
                text_mid(self.c, ML, y, ROW_H, fmt_money(amount, self.sym),
                         'Helvetica', 8, C_DARK, align='right', x2=ML + CW - 2 * mm)
                y += ROW_H

            # Subtotal line
            hline(self.c, ML, ML + CW, y, C_GRAY, lw=0.3)
            y += 1 * mm
            self.c.setFont('Helvetica-Bold', 9)
            self.c.setFillColor(C_DARK)
            self.c.drawString(ML + 2 * mm, y_rl(y + 4 * mm), f'Subtotal {g}')
            self.c.drawRightString(ML + CW - 2 * mm, y_rl(y + 4 * mm),
                                   fmt_money(subtots[g], self.sym))
            y += 8 * mm

        return y

    def _draw_summary(self, y):
        y = self._check_break(y, 50 * mm)
        y = draw_section_title(self.c, 'Resumen del Presupuesto', y)

        ROW_H   = 7 * mm
        indirect = self.grand - self.direct
        k_val    = self.grand / self.direct if self.direct > 0 else 1

        rows = [
            {'lbl': 'Costos Directos',   'val': fmt_money(self.direct, self.sym),   'bold': False, 'clr': None},
        ]
        if self.show_indirect:
            rows.append({'lbl': 'Costos Indirectos', 'val': fmt_money(indirect, self.sym), 'bold': False, 'clr': None})
            rows.append({'lbl': 'Coeficiente K',     'val': f'K = {k_val:.4f}',           'bold': False, 'clr': C_PRIMARY})
        rows.append({'lbl': 'Presupuesto total', 'val': fmt_money(self.grand, self.sym), 'bold': True, 'clr': None})

        for i, row in enumerate(rows):
            rh = ROW_H + 2 * mm if row['bold'] else ROW_H
            y  = self._check_break(y, rh)

            if row['bold']:
                fill_rect(self.c, ML, y, CW, rh, C_E8)
            elif i % 2 == 0:
                fill_rect(self.c, ML, y, CW, rh, C_LIGHT)

            fs   = 11 if row['bold'] else 9
            font = 'Helvetica-Bold' if row['bold'] else 'Helvetica'
            text_mid(self.c, ML + 4 * mm, y, rh, row['lbl'], font, fs, C_DARK)

            vc   = row['clr'] or C_DARK
            vfnt = 'Helvetica-Bold' if (row['bold'] or row['clr']) else 'Helvetica'
            text_mid(self.c, ML, y, rh, row['val'], vfnt, fs, vc,
                     align='right', x2=ML + CW - 4 * mm)
            y += rh

        return y + 4 * mm

    def _draw_condiciones(self, y):
        y = draw_section_title(self.c, 'Condiciones Generales', y)

        validity = fmt_date(self.budget.get('expiryDate')) if self.budget.get('expiryDate') else '30 dias desde la fecha de emision'
        conditions = [
            f"1. VALIDEZ: La presente oferta tiene validez hasta {validity}.",
            "2. FORMA DE PAGO: Segun acuerdo entre las partes, previo a la ejecucion de los trabajos.",
            "3. PLAZO: El plazo de ejecucion sera confirmado con el plan de obra aprobado.",
            "4. PRECIOS: Los precios indicados no incluyen impuestos salvo indicacion expresa.",
            "5. ALCANCE: Comprende unicamente los trabajos expresamente descritos en el presente documento.",
            "6. MODIFICACIONES: Cualquier cambio al alcance requiere presupuesto adicional por escrito.",
            "7. VIGENCIA: Precios sujetos a revision ante variaciones de mercado superiores al 5%.",
            "8. ACEPTACION: La firma o comunicacion escrita implica conformidad total con estas condiciones.",
        ]

        LINE_H = 5 * mm
        self.c.setFont('Helvetica', 8)
        self.c.setFillColor(C_DARK)
        for cond in conditions:
            words  = cond.split()
            line   = ''
            max_w  = CW - 4 * mm
            for word in words:
                test = (line + ' ' + word).strip()
                if self.c.stringWidth(test, 'Helvetica', 8) <= max_w:
                    line = test
                else:
                    if line:
                        y = self._check_break(y, LINE_H)
                        self.c.drawString(ML + 2 * mm, y_rl(y), line)
                        y += LINE_H
                    line = word
            if line:
                y = self._check_break(y, LINE_H)
                self.c.drawString(ML + 2 * mm, y_rl(y), line)
                y += LINE_H
            y += 2 * mm
        return y

    # ── Two-pass generate ─────────────────────────────────────────────────────
    def _full_render(self):
        # Activate this instance's column layout for the module-level row drawers.
        global _COLS
        _COLS = self._cols
        y = self._new_page()
        y = self._draw_resumen_capitulos(y)
        y = self._draw_detail_table(y)
        if self.show_indirect:
            y = self._draw_coeff_k(y)
        y = self._draw_summary(y)
        # Condiciones on a new page
        self._new_page()
        self._draw_condiciones(self._header_height())
        self.c.save()

    def generate(self):
        # First pass: render to memory to get page count
        buf       = io.BytesIO()
        temp      = BudgetPDFGen(self.data, buf, total_pages=99)
        temp._full_render()
        total     = temp.page_num

        # Second pass: render to real file with correct page count
        self.total_pages = total
        self._full_render()
        print(f"PDF generado: {self.c._filename} ({total} paginas)", flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print("Uso: python cerp_budget_pdf.py input.json output.pdf")
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
    BudgetPDFGen(data, sys.argv[2]).generate()


if __name__ == '__main__':
    main()
