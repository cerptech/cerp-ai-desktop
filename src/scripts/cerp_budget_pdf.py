#!/usr/bin/env python3
"""CERP Budget PDF Generator
Replicates budgetExportPDF.ts (ERP frontend) using reportlab canvas.

"PDF editables con IA": columns/header fields/Coeficiente K section/footer are
now driven by a DocumentTemplate config (see resolve_template_config() below)
instead of the old company-wide ModuleSettings.budget.pdfFields toggle. Field
ids and defaults mirror cerp-server/src/constants/documentTemplateCatalog.ts;
label text mirrors cerp-frontend/src/utils/pdf/pdfLabels.ts (kept in sync by
hand — see PDF_LABELS below).

Usage: python cerp_budget_pdf.py input.json output.pdf
"""
import sys, json, math, io, re
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

# ==============================================================================
# i18n — mirrors cerp-frontend/src/utils/pdf/pdfLabels.ts
# ==============================================================================
#
# Keys that match a BUDGET catalog fieldId (documentTemplateCatalog.ts) are
# named identically to that fieldId on purpose ('header.clientName',
# 'lines.desc', ...) so column/header labels resolve with a single
# get_label(field_id, locale) call. Keep this dict in sync BY HAND with
# pdfLabels.ts — there is no shared source between the TS and Python stacks.
PDF_LABELS = {
    'title.budget':       {'es': 'PRESUPUESTO', 'en': 'BUDGET'},
    'section.clientData': {'es': 'DATOS DEL CLIENTE', 'en': 'CLIENT DATA'},
    'section.budgetData': {'es': 'DATOS DEL PRESUPUESTO', 'en': 'BUDGET DATA'},

    'header.clientName':     {'es': 'Nombre', 'en': 'Name'},
    'header.clientAddress':  {'es': 'Direccion', 'en': 'Address'},
    'header.clientCity':     {'es': 'Localidad', 'en': 'City'},
    'header.clientCountry':  {'es': 'Pais', 'en': 'Country'},
    'header.budgetNumber':   {'es': 'N. Presupuesto', 'en': 'Budget No.'},
    'header.budgetRevision': {'es': 'Revision', 'en': 'Revision'},
    'header.issueDate':      {'es': 'Fecha de emisión', 'en': 'Issue date'},
    'header.expiryDate':     {'es': 'Válido hasta', 'en': 'Valid until'},

    'lines.num':           {'es': '#', 'en': '#'},
    'lines.desc':          {'es': 'Descripción', 'en': 'Description'},
    'lines.code':          {'es': 'Código', 'en': 'Code'},
    'lines.qty':           {'es': 'Cant.', 'en': 'Qty'},
    'lines.unit':          {'es': 'Ud.', 'en': 'Unit'},
    'lines.material':      {'es': 'Material', 'en': 'Material'},
    'lines.labor':         {'es': 'Mano de Obra', 'en': 'Labor'},
    'lines.equipment':     {'es': 'Equipos', 'en': 'Equipment'},
    'lines.subcontracted': {'es': 'Subcontratado', 'en': 'Subcontracted'},
    'lines.overhead':      {'es': 'Gastos gen.', 'en': 'Overhead'},
    'lines.total':         {'es': 'Total', 'en': 'Total'},

    'directCosts':           {'es': 'Costos Directos', 'en': 'Direct Costs'},
    'directCostsFooterTotal': {'es': 'Total Costos Directos', 'en': 'Total Direct Costs'},

    'coefficientKTitle':  {'es': 'Coeficiente K - Costos Indirectos', 'en': 'K Coefficient - Indirect Costs'},
    'coefficientKGroup1': {'es': 'Grupo 1 - Gastos Generales', 'en': 'Group 1 - Overhead'},
    'coefficientKGroup2': {'es': 'Grupo 2 - Beneficio e Impuestos', 'en': 'Group 2 - Profit and Taxes'},
    'coefficientKGroup3': {'es': 'Grupo 3 - Gastos Financieros', 'en': 'Group 3 - Financial Costs'},
    'variable':           {'es': 'Variable', 'en': 'Variable'},
    'fixed':              {'es': 'Fijo', 'en': 'Fixed'},
    'subtotal':           {'es': 'Subtotal', 'en': 'Subtotal'},
    'taxesHeading':       {'es': 'Impuestos', 'en': 'Taxes'},
    'withholdingSuffix':  {'es': ' - Retención', 'en': ' - Withholding'},
    'totalBudget':        {'es': 'Presupuesto total', 'en': 'Total Budget'},

    'summaryTitle':      {'es': 'Resumen del Presupuesto', 'en': 'Budget Summary'},
    'indirectCosts':     {'es': 'Costos Indirectos', 'en': 'Indirect Costs'},
    'coefficientKLabel': {'es': 'Coeficiente K', 'en': 'K Coefficient'},
    'subtotalNoTaxes':   {'es': 'Subtotal (sin impuestos)', 'en': 'Subtotal (before taxes)'},
    'withholdings':      {'es': 'Retenciones', 'en': 'Withholdings'},

    'footer.pageOf': {'es': 'Página {page} de {total}', 'en': 'Page {page} of {total}'},
}

# CERP-IA-only chrome without a counterpart in pdfLabels.ts — "Resumen por
# Capitulos", "Presupuesto Detallado" and "Condiciones Generales" belong to
# the "cotización" document CERP-IA prints (see systemPrompt.ts's
# "Estructura profesional del PDF de cotizacion") and don't exist in the
# ERP's plain budgetExportPDF.ts. Kept in sync by hand; move a key up into
# PDF_LABELS if the frontend ever grows the same section.
PDF_LABELS_EXTRA = {
    'chaptersSummaryTitle':  {'es': 'Resumen por Capitulos', 'en': 'Chapter Summary'},
    'chaptersSummaryNum':    {'es': 'N.', 'en': 'No.'},
    'chaptersSummaryDesc':   {'es': 'Descripcion', 'en': 'Description'},
    'chaptersSummaryAmount': {'es': 'Importe', 'en': 'Amount'},
    'chaptersSummaryTotal':  {'es': 'TOTAL COSTOS DIRECTOS (PEM)', 'en': 'TOTAL DIRECT COSTS (PEM)'},
    'detailTableTitle':      {'es': 'Presupuesto Detallado', 'en': 'Detailed Budget'},
    'conditionsTitle':       {'es': 'Condiciones Generales', 'en': 'General Conditions'},
    'header.pageLabel':      {'es': 'Pagina', 'en': 'Page'},
    'common.of':             {'es': 'de', 'en': 'of'},
}

CONDITIONS_TEXT = {
    'es': [
        "1. VALIDEZ: La presente oferta tiene validez hasta {validity}.",
        "2. FORMA DE PAGO: Segun acuerdo entre las partes, previo a la ejecucion de los trabajos.",
        "3. PLAZO: El plazo de ejecucion sera confirmado con el plan de obra aprobado.",
        "4. PRECIOS: Los precios indicados no incluyen impuestos salvo indicacion expresa.",
        "5. ALCANCE: Comprende unicamente los trabajos expresamente descritos en el presente documento.",
        "6. MODIFICACIONES: Cualquier cambio al alcance requiere presupuesto adicional por escrito.",
        "7. VIGENCIA: Precios sujetos a revision ante variaciones de mercado superiores al 5%.",
        "8. ACEPTACION: La firma o comunicacion escrita implica conformidad total con estas condiciones.",
    ],
    'en': [
        "1. VALIDITY: This offer is valid until {validity}.",
        "2. PAYMENT TERMS: As agreed between the parties, prior to the execution of the works.",
        "3. TIMELINE: The execution timeline will be confirmed with the approved work plan.",
        "4. PRICES: Listed prices do not include taxes unless expressly stated.",
        "5. SCOPE: Covers only the work explicitly described in this document.",
        "6. CHANGES: Any change in scope requires an additional written quotation.",
        "7. PRICE VALIDITY: Prices subject to revision for market variations above 5%.",
        "8. ACCEPTANCE: Signature or written communication implies full agreement with these conditions.",
    ],
}

CONDITIONS_VALIDITY_FALLBACK = {
    'es': '30 dias desde la fecha de emision',
    'en': '30 days from the issue date',
}


def get_label(key, locale):
    entry = PDF_LABELS.get(key) or PDF_LABELS_EXTRA.get(key)
    if not entry:
        return key
    return entry.get(locale) or entry.get('es') or key


_LABEL_TOKEN_RE = re.compile(r'\{(\w+)\}')


def format_label(key, locale, **values):
    """get_label() variant for entries with single-brace {token} placeholders
    (currently only 'footer.pageOf'). Mirrors pdfLabels.ts's formatPdfLabel()."""
    template = get_label(key, locale)
    return _LABEL_TOKEN_RE.sub(lambda m: str(values.get(m.group(1), '')), template)


def resolve_pdf_locale(raw):
    """Mirrors cerp-frontend/src/utils/pdf/pdfLabels.ts's resolvePdfLocale().
    Contact.preferences.language is free text (maxlength 10, no server enum) —
    never assume it arrives well-formed. Defaults to 'es' for anything empty,
    None, or not recognizably English."""
    if not isinstance(raw, str):
        return 'es'
    normalized = raw.strip().lower()
    if normalized.startswith('en'):
        return 'en'
    return 'es'


def resolve_locale(data):
    """Mirrors budgetExportPDF.ts's locale resolution
    (`contact?.preferences?.language ?? budget.contactSnapshot?.language`).

    Fallback chain, highest priority first:
      1. top-level `contactLanguage` — explicit override the agent may pass
         after looking the contact up (equivalent to the frontend's live
         Contact.preferences.language). Always wins when present.
      2. `budget.contactLanguage` — same override nested under budget.
      3. `budget.contactSnapshot.language` — written by the backend on every
         budget, so it works even when the agent skips the contact lookup.
         Without this the web PDF and the CERP-IA PDF disagree for any
         non-Spanish client.
    """
    budget = data.get('budget') or {}
    snapshot = budget.get('contactSnapshot') or {}
    raw = (
        data.get('contactLanguage')
        or budget.get('contactLanguage')
        or snapshot.get('language')
    )
    return resolve_pdf_locale(raw)


# ==============================================================================
# Table columns — 11 cols matching ERP's [8,27,13,10,8,19,19,17,19,17,23]mm
# ==============================================================================
#
# Column descriptors: (key, catalog fieldId, width_mm). The 'idx' assigned to
# each column in build_active_cols() below is its position in THIS fixed list
# — that's what lets a reordered/filtered column still read the right value
# out of a row's fixed-position `cells` list (see flatten_tree()). Keep this
# technique: do NOT change `cells` construction order without also updating
# every `col['idx']` consumer (draw_chapter_row, draw_item_row).
COL_DEFS = [
    ('num',           'lines.num',           8),
    ('desc',          'lines.desc',          27),
    ('code',          'lines.code',          13),
    ('qty',           'lines.qty',           10),
    ('unit',          'lines.unit',          8),
    ('material',      'lines.material',      19),
    ('labor',         'lines.labor',         19),
    ('equipment',     'lines.equipment',     17),
    ('subcontracted', 'lines.subcontracted', 19),
    ('overhead',      'lines.overhead',      17),
    ('total',         'lines.total',         23),
]
# Right-aligned monetary columns (used across chapter/item rows).
VALUE_KEYS = {'material', 'labor', 'equipment', 'subcontracted', 'overhead', 'total'}

HEADER_CLIENT_FIELD_IDS = ['header.clientName', 'header.clientAddress', 'header.clientCity', 'header.clientCountry']
HEADER_BUDGET_FIELD_IDS = ['header.budgetNumber', 'header.budgetRevision', 'header.issueDate', 'header.expiryDate']

# Default footer template — reproduces addFooter()'s legacy hardcoded line
# composition via {{variables}} (see constants/pdfVariables.ts). Matches
# documentTemplateSeed/templateContent.ts's DEFAULT_FOOTER_TEXT.BUDGET, which
# is what a company's seeded system template actually carries.
DEFAULT_BUDGET_FOOTER_TEMPLATE = (
    '{{company.name}}  \xb7  {{company.address}}  \xb7  Tel: {{company.phone}}  \xb7  e-mail: {{company.email}}\n{{company.taxId}}'
)


# ==============================================================================
# Template config resolution — "PDF editables con IA"
# ==============================================================================

def _normalize_field_configs(entries):
    """entries: DocumentTemplateFieldConfig[] / DocumentTemplateSectionConfig[]
    ({fieldId, visible, order}). Returns (visible_by_id, order_by_id) dicts.
    Tolerates malformed/missing entries — never throws."""
    visible, order = {}, {}
    for i, entry in enumerate(entries or []):
        if not isinstance(entry, dict):
            continue
        field_id = entry.get('fieldId')
        if not field_id:
            continue
        visible[field_id] = bool(entry.get('visible', True))
        order[field_id] = entry.get('order', i)
    return visible, order


def _config_from_new_template(tpl):
    header_visible, header_order = _normalize_field_configs(tpl.get('header'))
    lines_visible, lines_order = _normalize_field_configs(tpl.get('lines'))
    sections_visible, _ = _normalize_field_configs(tpl.get('sections'))
    footer = tpl.get('footer') or {}
    footer_text = footer.get('text') if isinstance(footer, dict) else None
    if not footer_text:
        footer_text = DEFAULT_BUDGET_FOOTER_TEMPLATE
    return {
        'header_visible': header_visible, 'header_order': header_order,
        'lines_visible': lines_visible, 'lines_order': lines_order,
        'show_indirect': sections_visible.get('section.indirectCosts', True),
        'footer_text': footer_text,
    }


def _config_from_legacy(ps):
    """ps: the old ModuleSettings.budget shape ({pdfFields:{quantity,unit,total}, showIndirectCosts}).
    Only qty/unit/total are toggleable and nothing is reorderable — matches
    what that config was ever able to express."""
    fields = ps.get('pdfFields') or {}
    lines_visible = {
        'lines.qty':   fields.get('quantity', True),
        'lines.unit':  fields.get('unit', True),
        'lines.total': fields.get('total', True),
    }
    return {
        'header_visible': {}, 'header_order': {},
        'lines_visible': lines_visible, 'lines_order': {},
        'show_indirect': ps.get('showIndirectCosts', True),
        'footer_text': None,  # signal: compute the legacy dynamic footer composition
    }


def _config_show_all():
    return {
        'header_visible': {}, 'header_order': {},
        'lines_visible': {}, 'lines_order': {},
        'show_indirect': True,
        'footer_text': None,
    }


def resolve_template_config(data):
    """Resolve the effective BUDGET document-template config for this render.

    Fallback chain (client-side mirror of the spirit of
    documentTemplateResolverService.ts's server-side resolution order):
      1. budget.documentTemplateConfig — the new "PDF editables con IA" shape.
         GET /api/budgets/:id always includes this since Fase 2 (never null).
      2. budget.pdfSettings — the legacy ModuleSettings.budget.pdfFields /
         .showIndirectCosts shape. Kept for backward compat with older cached
         JSON payloads or a report-generator run that hasn't been updated.
      3. Show everything, fixed catalog order — last resort (e.g. a hand-built
         JSON with neither field). MUST NEVER THROW — this is a normal state
         for a budget predating this feature, not an error.

    Tolerates "grandfathered" entries where a mandatory fieldId (lines.total,
    header.clientName, etc.) carries visible:false — that's LEGAL for
    companies migrated before the editor's mandatory-field rule existed (see
    documentTemplateCatalog.ts's long comment on this). This function renders
    whatever the config says without second-guessing `mandatory`.
    """
    budget = data.get('budget') or {}

    tpl = budget.get('documentTemplateConfig')
    if tpl is None:
        tpl = data.get('documentTemplateConfig')
    if isinstance(tpl, dict) and tpl:
        return _config_from_new_template(tpl)

    legacy = budget.get('pdfSettings')
    if legacy is None:
        legacy = data.get('pdfSettings')
    if isinstance(legacy, dict) and legacy:
        return _config_from_legacy(legacy)

    return _config_show_all()


def build_active_cols(lines_visible, lines_order, locale):
    """Filter+reorder the 11 fixed line columns per config, redistributing the
    width freed by hidden columns to 'Descripcion' so the table keeps its
    180mm total. Each column keeps its original `idx` into COL_DEFS (see the
    module-level comment on COL_DEFS) — that's what makes reordering safe
    without touching row-building code."""
    freed = 0.0
    active = []
    for idx, (key, field_id, mmw) in enumerate(COL_DEFS):
        if not lines_visible.get(field_id, True):
            freed += mmw
            continue
        active.append({
            'key': key,
            'field_id': field_id,
            'hdr': get_label(field_id, locale),
            'mm': mmw,
            'idx': idx,
            'order': lines_order.get(field_id, idx),
        })
    active.sort(key=lambda col: col['order'])

    for col in active:
        if col['key'] == 'desc':
            col['mm'] += freed
            break
    else:
        # 'desc' itself hidden (shouldn't happen — mandatory in the catalog,
        # but grandfathered data is tolerated) — dump the freed width on the
        # first visible column so nothing is silently lost.
        if active:
            active[0]['mm'] += freed

    for col in active:
        col['w'] = col['mm'] * mm
    return active


# Active columns for the current render (set by BudgetPDFGen before drawing).
_COLS = build_active_cols({}, {}, 'es')

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

def wrap_text(c, text, font, size, max_w):
    """Word-wrap `text` to max_w pts, returning a list of lines."""
    words = text.split()
    lines = ['']
    for word in words:
        test = (lines[-1] + ' ' + word).strip()
        if c.stringWidth(test, font, size) <= max_w:
            lines[-1] = test
        else:
            lines.append(word)
    return lines if lines[0] else []

FOOTER_SEPARATOR = '  \xb7  '

def wrap_footer_template_lines(c, text, max_w, separator=FOOTER_SEPARATOR):
    """Exact port of cerp-frontend/src/utils/pdf/pdfTemplate.ts's
    wrapFooterTemplateLines() — parity is the point here, not "better" wrapping.
    Splits on explicit '\\n'. For a resulting line that doesn't fit max_w AND
    contains the separator with >2 parts, balances it into two halves at
    separator boundaries (mirrors the historical company-info-line split).
    A long line with NO separator (or only <=2 parts) is pushed AS-IS,
    unwrapped — same as the frontend, even though that can overflow the page
    for pathological footer text with no '·' in it. Font must already be set
    on `c` (stringWidth measurement) before calling. Assumes the caller only
    invokes this for the current template's footer.text, not the legacy
    dynamic composition (which has its own, different, splitting rule)."""
    forced_lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
    out = []
    for line in forced_lines:
        if c.stringWidth(line, 'Helvetica', 6.5) > max_w and separator in line:
            parts = [p for p in line.split(separator) if p]
            if len(parts) > 2:
                mid = math.ceil(len(parts) / 2)
                out.append(separator.join(parts[:mid]))
                out.append(separator.join(parts[mid:]))
                continue
        out.append(line)
    return out

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

# ── Header field values (header.* catalog fieldIds) ──────────────────────────
def header_field_value(field_id, budget):
    snap = budget.get('contactSnapshot') or {}
    if field_id == 'header.clientName':
        return snap.get('name') or ''
    if field_id == 'header.clientAddress':
        return snap.get('street') or ''
    if field_id == 'header.clientCity':
        return snap.get('city') or ''
    if field_id == 'header.clientCountry':
        return snap.get('country') or ''
    if field_id == 'header.budgetNumber':
        return str(budget['budgetNumber']) if budget.get('budgetNumber') else ''
    if field_id == 'header.budgetRevision':
        return str(budget['revision']) if budget.get('revision') is not None else ''
    if field_id == 'header.issueDate':
        # No explicit issueDate → print TODAY (not createdAt), matching
        # budgetExportPDF.ts's `fmtDate(new Date().toISOString())`.
        return fmt_date(budget.get('issueDate') or datetime.now().isoformat())
    if field_id == 'header.expiryDate':
        return fmt_date(budget['expiryDate']) if budget.get('expiryDate') else ''
    return ''

def resolve_header_rows(field_ids, header_visible, header_order, budget, locale):
    """Filters+orders a header column's fieldIds per config, dropping hidden
    fields and fields with no value (mirrors the old hardcoded "only show
    non-empty fields" behavior)."""
    rows = []
    for i, field_id in enumerate(field_ids):
        if not header_visible.get(field_id, True):
            continue
        value = header_field_value(field_id, budget)
        if not value:
            continue
        rows.append((header_order.get(field_id, i), get_label(field_id, locale), value))
    rows.sort(key=lambda r: r[0])
    return [(label, value) for _, label, value in rows]

# ── Footer variables ({{company.name}} etc, see constants/pdfVariables.ts) ───
def resolve_footer_variables(company, budget, locale):
    """Mirrors budgetExportPDF.ts's buildFooterVariables() exactly. NOTE: the
    HEADER and the FOOTER deliberately disagree on the missing-date fallback,
    and both sides (web + CERP-IA) implement the same disagreement:
      - header_field_value()'s 'header.issueDate' falls back to TODAY.
      - the FOOTER's 'budget.issueDate'/'budget.expiryDate' variables resolve
        to '' — a footer variable literally vanishes rather than printing a
        guessed date.
    Don't "unify" these."""
    snap = budget.get('contactSnapshot') or {}
    return {
        'company.name':      company.get('name') or '',
        'company.taxId':     company.get('taxId') or '',
        'company.address':   company.get('address') or '',
        'company.phone':     company.get('phone') or '',
        'company.email':     company.get('email') or '',
        'budget.number':     str(budget['budgetNumber']) if budget.get('budgetNumber') else '',
        'budget.issueDate':  fmt_date(budget['issueDate']) if budget.get('issueDate') else '',
        'budget.expiryDate': fmt_date(budget['expiryDate']) if budget.get('expiryDate') else '',
        'client.name':       snap.get('name') or '',
    }

_VAR_RE = re.compile(r'\{\{\s*([^{}]+?)\s*\}\}')

def render_footer_text(template_text, variables):
    def repl(m):
        return variables.get(m.group(1).strip(), '')
    return _VAR_RE.sub(repl, template_text or '')

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
def draw_header(c, budget, company, page_num, total_pages, tpl, locale):
    """Draw repeating page header. Returns y_top where content starts.
    `tpl` is the normalized config from resolve_template_config()."""
    left  = ML
    right = PW - MR
    y = MT

    LOGO_AREA_H = 15 * mm
    header_visible = tpl['header_visible']
    header_order   = tpl['header_order']

    # "PRESUPUESTO" 15pt bold-italic right-aligned (baseline at y + 9mm)
    c.setFont('Helvetica-BoldOblique', 15)
    c.setFillColor(C_DARK)
    c.drawRightString(right, y_rl(y + 9 * mm), get_label('title.budget', locale))

    # header.companyLogo is toggleable in the template config, but CERP-IA's
    # JSON payload has no binary logo data (unlike the frontend, which fetches
    # it client-side via getRelevantLogoForPDF) — there's nothing to draw
    # either way today. Read the flag for forward compat only.
    _show_logo = header_visible.get('header.companyLogo', True)  # noqa: F841

    # Company name 7pt bold orange below logo area
    show_name = header_visible.get('header.companyName', True)
    co_name = company['name'] if show_name else ''
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
    c.drawString(lx, y_rl(y), get_label('section.clientData', locale))
    c.drawString(rx, y_rl(y), get_label('section.budgetData', locale))
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

    client_fields = resolve_header_rows(HEADER_CLIENT_FIELD_IDS, header_visible, header_order, budget, locale)
    budget_fields = resolve_header_rows(HEADER_BUDGET_FIELD_IDS, header_visible, header_order, budget, locale)
    # "Pagina X de Y" isn't a catalog fieldId (not toggleable/reorderable) —
    # always appended last, exactly like the pre-template behavior.
    budget_fields = budget_fields + [(
        get_label('header.pageLabel', locale),
        f"{page_num} {get_label('common.of', locale)} {total_pages}",
    )]

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
def draw_footer(c, company, budget, page_num, total_pages, footer_text, locale):
    """Draw footer. If `footer_text` is a template string (possibly containing
    {{variables}}), render it via wrap_footer_template_lines() — the exact
    port of budgetExportPDF.ts/pdfTemplate.ts's wrapFooterTemplateLines(), for
    pixel-parity with the frontend on the common (default footer) case. If
    `footer_text` is None (legacy/no config), fall back to the old dynamic
    composition mirroring the PRE-template addFooter() from budgetExportPDF.ts."""
    left  = ML
    right = PW - MR
    cx    = PW / 2
    cw    = right - left

    FOOTER_LINE_Y_FROM_BOTTOM = MB + 2 * mm   # pt from bottom
    LINE_SPACING = 4 * mm

    c.setFont('Helvetica', 6.5)

    if footer_text is not None:
        resolved = render_footer_text(footer_text, resolve_footer_variables(company, budget, locale))
        footer_lines = wrap_footer_template_lines(c, resolved, cw)
    else:
        # Legacy dynamic composition (no template config resolved at all).
        parts = [p for p in [
            company['name'],
            company['address'],
            f"Tel: {company['phone']}" if company['phone'] else '',
            f"e-mail: {company['email']}" if company['email'] else '',
        ] if p]
        full_line = '  \xb7  '.join(parts)

        if c.stringWidth(full_line, 'Helvetica', 6.5) > cw and len(parts) > 2:
            mid = math.ceil(len(parts) / 2)
            footer_lines = [
                '  \xb7  '.join(parts[:mid]),
                '  \xb7  '.join(parts[mid:]),
            ]
        else:
            footer_lines = [full_line] if full_line else []

        if company['taxId']:
            footer_lines.append(company['taxId'])

    if not footer_lines:
        footer_lines = ['']

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
    c.drawRightString(right, page_y, format_label('footer.pageOf', locale, page=page_num, total=total_pages))

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
    # Mirrors budgetExportPDF.ts's `numSkipWidth` (post-reorder fix): only
    # skip past the '#' column's width if 'num' is STILL the first column in
    # the active/reordered layout. If 'num' has been reordered away from
    # position 0 (or hidden), there's nothing there to skip past — indent
    # starts flush with the table's left edge instead of guessing.
    num_skip = _COLS[0]['w'] if _COLS and _COLS[0]['key'] == 'num' else 0.0
    desc_x   = ML + num_skip + 1.5 * mm + depth * 2 * mm
    avail_w  = PW - MR - desc_x - 2 * mm

    lines_text = wrap_text(c, raw, 'Helvetica-Oblique', 6.5, avail_w)

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

def draw_tbl_total_row(c, direct, sym, y, locale):
    H = ROW_H_CH + 1 * mm
    fill_rect(c, ML, y, CW, H, C_LGRAY)
    text_mid(c, ML + 2 * mm, y, H, get_label('directCostsFooterTotal', locale), 'Helvetica-Bold', 7, C_DARK)
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

        # Language + template config ("PDF editables con IA") for this render.
        self.locale = resolve_locale(data)
        self.tpl    = resolve_template_config(data)
        self.show_indirect = self.tpl['show_indirect']
        self._cols  = build_active_cols(self.tpl['lines_visible'], self.tpl['lines_order'], self.locale)

        self.items_by_id  = {it['_id']: it for it in self.items if it.get('_id')}
        self.leaves       = [i for i in self.items if i.get('type') == 'item']
        self.direct, self.s1, self.s2, self.grand = compute_totals(self.budget, self.leaves)
        self.flat_rows    = flatten_tree(self.tree, self.items_by_id, self.sym)

        self.c            = rl_canvas.Canvas(dest, pagesize=A4)
        self.page_num     = 0

    def _header_height(self):
        show_name = self.tpl['header_visible'].get('header.companyName', True)
        co_name = self.company['name'] if show_name else ''
        LOGO_AREA_H = 15 * mm
        client_fields = resolve_header_rows(
            HEADER_CLIENT_FIELD_IDS, self.tpl['header_visible'], self.tpl['header_order'], self.budget, self.locale)
        budget_fields = resolve_header_rows(
            HEADER_BUDGET_FIELD_IDS, self.tpl['header_visible'], self.tpl['header_order'], self.budget, self.locale)
        # +1 for the always-appended "Pagina X de Y" row (not a catalog field).
        rows = max(len(client_fields), len(budget_fields) + 1, 3)
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
        draw_header(self.c, self.budget, self.company, self.page_num, self.total_pages, self.tpl, self.locale)
        draw_footer(self.c, self.company, self.budget, self.page_num, self.total_pages,
                    self.tpl['footer_text'], self.locale)
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
        y = draw_section_title(self.c, get_label('chaptersSummaryTitle', self.locale), y)

        ROW_H = ROW_H_SUMM
        # Header row
        fill_rect(self.c, ML, y, CW, ROW_H, C_PRIMARY)
        c = self.c
        c.setFont('Helvetica-Bold', 7)
        c.setFillColor(C_WHITE)
        c.drawString(ML + 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), get_label('chaptersSummaryNum', self.locale))
        c.drawString(ML + 20 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), get_label('chaptersSummaryDesc', self.locale))
        c.drawRightString(ML + CW - 2 * mm, y_rl(y + ROW_H / 2 + 0.5 * mm), get_label('chaptersSummaryAmount', self.locale))
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
                     get_label('chaptersSummaryTotal', self.locale))
        c.drawRightString(ML + CW - 2 * mm, y_rl(y + (ROW_H + 2 * mm) / 2 + 0.5 * mm),
                          fmt_money(total_direct, self.sym))
        return y + ROW_H + 2 * mm + 6 * mm

    def _draw_detail_table(self, y):
        y = self._check_break(y, SECTION_H + ROW_H_HDR)
        y = draw_section_title(self.c, get_label('detailTableTitle', self.locale), y)

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
        y = draw_tbl_total_row(self.c, self.direct, self.sym, y, self.locale)
        return y + 4 * mm

    def _draw_coeff_k(self, y):
        y = self._check_break(y, SECTION_H)
        y = draw_section_title(self.c, get_label('coefficientKTitle', self.locale), y)

        ROW_H = 6 * mm
        # Direct costs row
        y = self._check_break(y, ROW_H)
        fill_rect(self.c, ML, y, CW, ROW_H, C_LIGHT)
        text_mid(self.c, ML + 2 * mm, y, ROW_H, get_label('directCosts', self.locale), 'Helvetica-Bold', 9, C_DARK)
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
            1: get_label('coefficientKGroup1', self.locale).upper(),
            2: get_label('coefficientKGroup2', self.locale).upper(),
            3: get_label('coefficientKGroup3', self.locale).upper(),
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
                         get_label('variable', self.locale) if ct in ('variable', 'calculated') else get_label('fixed', self.locale),
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
            self.c.drawString(ML + 2 * mm, y_rl(y + 4 * mm), f"{get_label('subtotal', self.locale)} {g}")
            self.c.drawRightString(ML + CW - 2 * mm, y_rl(y + 4 * mm),
                                   fmt_money(subtots[g], self.sym))
            y += 8 * mm

        return y

    def _draw_summary(self, y):
        y = self._check_break(y, 50 * mm)
        y = draw_section_title(self.c, get_label('summaryTitle', self.locale), y)

        ROW_H   = 7 * mm
        indirect = self.grand - self.direct
        k_val    = self.grand / self.direct if self.direct > 0 else 1

        rows = [
            {'lbl': get_label('directCosts', self.locale), 'val': fmt_money(self.direct, self.sym), 'bold': False, 'clr': None},
        ]
        if self.show_indirect:
            rows.append({'lbl': get_label('indirectCosts', self.locale), 'val': fmt_money(indirect, self.sym), 'bold': False, 'clr': None})
            rows.append({'lbl': get_label('coefficientKLabel', self.locale), 'val': f'K = {k_val:.4f}', 'bold': False, 'clr': C_PRIMARY})
        rows.append({'lbl': get_label('totalBudget', self.locale), 'val': fmt_money(self.grand, self.sym), 'bold': True, 'clr': None})

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
        y = draw_section_title(self.c, get_label('conditionsTitle', self.locale), y)

        expiry = self.budget.get('expiryDate')
        validity = fmt_date(expiry) if expiry else CONDITIONS_VALIDITY_FALLBACK.get(self.locale, CONDITIONS_VALIDITY_FALLBACK['es'])
        conditions = [
            text.format(validity=validity)
            for text in CONDITIONS_TEXT.get(self.locale, CONDITIONS_TEXT['es'])
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
