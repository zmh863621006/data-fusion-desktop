"""Mechanically capture the supplied BIFF8 permit template (requires xlrd and olefile).

Usage: python scripts/extract-permit-template.py INPUT.xls OUTPUT.json
Optional --dependency-path points to a directory containing xlrd and olefile.
The source is read-only; the generated descriptor is embedded in the application.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
parser.add_argument('--dependency-path')
args = parser.parse_args()
if args.dependency_path:
    sys.path.insert(0, args.dependency_path)
import xlrd
import olefile

book = xlrd.open_workbook(str(args.source), formatting_info=True)
if book.nsheets != 1:
    raise ValueError('Expected exactly one template sheet')
sheet = book.sheet_by_index(0)
if sheet.ncols != 32 or sheet.nrows < 3:
    raise ValueError('Expected 32 columns and a two-row header')
if any(sheet.cell_value(row, col) != '' for row in range(2, sheet.nrows) for col in range(sheet.ncols)):
    raise ValueError('Template contains nonempty data rows; do not discard their content')

def color(index):
    rgb = book.colour_map.get(index)
    return {'argb': 'FF' + ''.join(f'{part:02X}' for part in rgb)} if rgb else {'argb': 'FF000000'}

def font(index):
    item = book.font_list[index]
    result = {'name': item.name, 'size': item.height / 20, 'color': color(item.colour_index),
              'bold': bool(item.bold), 'italic': bool(item.italic), 'strike': bool(item.struck_out),
              'family': item.family, 'charset': item.character_set}
    if item.underline_type:
        result['underline'] = {1: 'single', 2: 'double', 0x21: 'singleAccounting', 0x22: 'doubleAccounting'}[item.underline_type]
    if item.escapement:
        result['vertAlign'] = {1: 'superscript', 2: 'subscript'}[item.escapement]
    return result

def style(index):
    item = book.xf_list[index]
    alignment = item.alignment
    border = {}
    line_styles = ['none', 'thin', 'medium', 'dashed', 'dotted', 'thick', 'double', 'hair',
                   'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot']
    for edge in ['left', 'right', 'top', 'bottom']:
        width = getattr(item.border, edge + '_line_style')
        if width:
            border[edge] = {'style': line_styles[width], 'color': color(getattr(item.border, edge + '_colour_index'))}
    if item.border.diag_up or item.border.diag_down:
        raise ValueError('Unimplemented diagonal border; do not silently drop it')
    if item.background.fill_pattern not in [0, 1]:
        raise ValueError('Unimplemented fill pattern; do not silently drop it')
    fill = {'type': 'pattern', 'pattern': 'solid', 'fgColor': color(item.background.pattern_colour_index)} if item.background.fill_pattern else {'type': 'pattern', 'pattern': 'none'}
    result = {'font': font(item.font_index), 'border': border, 'fill': fill,
              'alignment': {'vertical': {0:'top',1:'middle',2:'bottom',3:'justify',4:'distributed'}[alignment.vert_align],
                            'wrapText': bool(alignment.text_wrapped), 'shrinkToFit': bool(alignment.shrink_to_fit),
                            'indent': alignment.indent_level},
              'numFmt': book.format_map[item.format_key].format_str,
              'protection': {'locked': bool(item.protection.cell_locked), 'hidden': bool(item.protection.formula_hidden)}}
    if alignment.hor_align:
        result['alignment']['horizontal'] = {1:'left',2:'center',3:'right',4:'fill',5:'justify',6:'centerContinuous',7:'distributed'}[alignment.hor_align]
    if alignment.rotation:
        result['alignment']['textRotation'] = 'vertical' if alignment.rotation == 255 else alignment.rotation if alignment.rotation <= 90 else 90 - alignment.rotation
    return result

def cell(row, col):
    value = sheet.cell_value(row, col)
    runs = sheet.rich_text_runlist_map.get((row, col), [])
    if runs:
        positions = [(0, book.xf_list[sheet.cell_xf_index(row,col)].font_index), *runs, (len(value), None)]
        value = {'richText': [{'font': font(index), 'text': value[start:end]} for (start, index),(end, _) in zip(positions, positions[1:]) if end > start]}
    return {'value': value or None, 'style': style(sheet.cell_xf_index(row, col))}

def address(row, col):
    letters = ''
    col += 1
    while col:
        col, remainder = divmod(col - 1, 26)
        letters = chr(65 + remainder) + letters
    return f'{letters}{row + 1}'

def parse_validation(data):
    flags, = struct.unpack_from('<I', data)
    offset = 4
    texts = []
    for _ in range(4):
        count, options = struct.unpack_from('<HB', data, offset)
        offset += 3
        if options not in [0, 1]:
            raise ValueError('Unsupported rich/phonetic DV string')
        size = count * (2 if options else 1)
        texts.append(data[offset:offset+size].decode('utf-16-le' if options else 'latin1').replace('\x00', ''))
        offset += size
    formulas = []
    for _ in range(2):
        size, _reserved = struct.unpack_from('<HH', data, offset)
        offset += 4
        formulas.append(data[offset:offset+size])
        offset += size
    count, = struct.unpack_from('<H', data, offset)
    offset += 2
    ranges = []
    for _ in range(count):
        first_row, last_row, first_col, last_col = struct.unpack_from('<HHHH', data, offset)
        offset += 8
        ranges.append(f'{address(first_row,first_col)}:{address(last_row,last_col)}')
    if offset != len(data):
        raise ValueError('Unparsed DV bytes')
    kind = flags & 15
    validation = {'type': {0:'any',3:'list'}[kind], 'allowBlank': bool(flags & 0x100),
                  'showInputMessage': bool(flags & 0x40000), 'showErrorMessage': bool(flags & 0x80000),
                  'errorStyle': {0:'stop',1:'warning',2:'information'}[(flags >> 4) & 7],
                  'promptTitle': texts[0], 'errorTitle': texts[1], 'prompt': texts[2], 'error': texts[3], 'formulae': []}
    if kind == 3:
        token = formulas[0]
        if len(token) < 3 or token[0] != 0x17 or token[2] not in [0,1]:
            raise ValueError('Unsupported DV list formula')
        size = token[1] * (2 if token[2] else 1)
        if len(token) != size + 3:
            raise ValueError('Incomplete DV list formula')
        choices = token[3:].decode('utf-16-le' if token[2] else 'latin1').split('\x00')
        if any(',' in item or '"' in item for item in choices):
            raise ValueError('Unsupported embedded list delimiter')
        validation['formulae'] = ['"' + ','.join(choices) + '"']
        if formulas[1]:
            raise ValueError('Unexpected second list formula')
    return {'ranges': ranges, 'validation': validation}

with olefile.OleFileIO(str(args.source)) as ole:
    binary = ole.openstream('Workbook').read()
offset = 0
validations = []
while offset < len(binary):
    code, length = struct.unpack_from('<HH', binary, offset)
    data = binary[offset+4:offset+4+length]
    if len(data) != length:
        raise ValueError('Truncated BIFF record')
    if code == 0x01BE:
        validations.append(parse_validation(data))
    offset += 4 + length
if len(validations) != 38:
    raise ValueError(f'Expected 38 validation records, found {len(validations)}')
if sheet.cell_note_map:
    raise ValueError('Unimplemented template comments; do not silently drop them')
descriptor = {
    'source': {'filename': args.source.name, 'sha256': hashlib.sha256(args.source.read_bytes()).hexdigest(), 'format': 'BIFF8'},
    'name': sheet.name,
    'showGridLines': bool(sheet.show_grid_lines),
    'defaultRowHeight': sheet.default_row_height / 20,
    'columns': [{'width': sheet.colinfo_map[col].width / 256, 'hidden': bool(sheet.colinfo_map[col].hidden), 'style': style(sheet.colinfo_map[col].xf_index)} for col in range(32)],
    'headerRows': [{'height': sheet.rowinfo_map[row].height / 20, 'cells': [cell(row,col) for col in range(32)]} for row in range(2)],
    'dataRow': {'height': sheet.rowinfo_map[2].height / 20, 'cells': [cell(2,col) for col in range(32)]},
    'merges': [f'{address(r1,c1)}:{address(r2-1,c2-1)}' for r1,r2,c1,c2 in sheet.merged_cells],
    'validations': validations,
}
args.destination.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Extracted {len(descriptor["merges"])} merges and {len(validations)} validation rules to {args.destination}')
