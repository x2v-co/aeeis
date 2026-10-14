#!/usr/bin/env python3
"""Rebuild assets/fonts/NotoSansSC-GB2312.ttf (SIL OFL 1.1).

Input: NotoSansCJK-Regular.ttc from Debian fonts-noto-cjk (1:20240730).
Output: the Simplified Chinese face, subset to ASCII/Latin-1, general
punctuation, CJK symbols/full-width forms and all GB2312 characters, with CFF
outlines converted to TrueType (glyf) because pdf-lib/fontkit CFF subsets are
rejected by common PDF viewers. Requires fonttools>=4.40.
Usage: python3 scripts/build-cjk-font.py /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
"""
import sys
from fontTools.ttLib import TTCollection, newTable
from fontTools.subset import Subsetter, Options
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else 'assets/fonts/NotoSansSC-GB2312.ttf'
font = next(f for f in TTCollection(src).fonts if f['name'].getDebugName(6) == 'NotoSansCJKsc-Regular')
codes = set(range(0x20, 0x7F)) | set(range(0xA0, 0x180)) | set(range(0x2000, 0x2070)) | set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFF0))
for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
        try: codes.add(ord(bytes([hi, lo]).decode('gb2312')))
        except UnicodeDecodeError: pass
opts = Options(); opts.layout_features = []; opts.hinting = False; opts.name_IDs = ['*']; opts.notdef_outline = True
sub = Subsetter(opts); sub.populate(unicodes=codes); sub.subset(font)
order = font.getGlyphOrder(); gs = font.getGlyphSet(); glyphs = {}
for name in order:
    pen = TTGlyphPen(gs); gs[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True)); glyphs[name] = pen.glyph()
for tag in ('CFF ', 'VORG'):
    if tag in font: del font[tag]
glyf = newTable('glyf'); glyf.glyphOrder = order; glyf.glyphs = glyphs; font['glyf'] = glyf; font['loca'] = newTable('loca')
maxp = font['maxp']; maxp.tableVersion = 0x00010000
for k in ('maxZones','maxTwilightPoints','maxStorage','maxFunctionDefs','maxInstructionDefs','maxStackElements','maxSizeOfInstructions','maxComponentElements'): setattr(maxp, k, 0)
maxp.maxZones = 1
font['head'].indexToLocFormat = 0; font['head'].glyphDataFormat = 0
font['post'].formatType = 2.0; font['post'].extraNames = []; font['post'].mapping = {}
font.sfntVersion = '\x00\x01\x00\x00'
glyf.padding = 4  # fontkit's glyf subsetter needs 4-byte aligned glyph records
font.save(out)
print(out, len(codes), 'codepoints', len(order), 'glyphs')
