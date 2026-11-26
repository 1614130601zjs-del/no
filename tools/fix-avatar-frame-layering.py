#!/usr/bin/env python3
"""Patch Kの未读冬日讯息 theme JSON: place the right avatar ring between avatars."""
import json, re, sys
from pathlib import Path
from urllib.parse import quote, unquote

if len(sys.argv) != 2:
    raise SystemExit('Usage: python fix-avatar-frame-layering.py <original-theme.json>')
source = Path(sys.argv[1])
data = json.loads(source.read_text(encoding='utf-8'))
css = data.get('custom_css')
if not isinstance(css, str):
    raise SystemExit('ERROR: custom_css is missing or is not text')

pattern = re.compile(r'(--ls-music-card:\s*url\("data:image/svg\+xml,)([^"]+)("\);)', re.S)
colors = []
def patch_svg(match):
    svg = unquote(match.group(2))
    found = re.findall(r'<g fill="none" stroke="(#[0-9a-fA-F]{6})" stroke-width="\.8">', svg)
    if len(found) != 1:
        raise SystemExit('ERROR: unexpected music-card SVG structure')
    color = found[0]
    ring = '<circle cx="104" cy="76" r="29"/>'
    if svg.count(ring) != 1:
        raise SystemExit('ERROR: expected exactly one visible right ring in each SVG')
    svg = svg.replace(ring, '', 1)  # leave the original two-circle mask untouched
    overlay = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 174" '
               f'preserveAspectRatio="none"><circle cx="104" cy="76" r="29" '
               f'fill="none" stroke="{color}" stroke-width=".8"/></svg>')
    colors.append(color)
    return (match.group(1) + quote(svg, safe='') + match.group(3) + '\n  '
            + '--ls-photo-right-frame: url("data:image/svg+xml,' + quote(overlay, safe='') + '");')

css, count = pattern.subn(patch_svg, css)
if count != 2 or len(colors) != 2:
    raise SystemExit(f'ERROR: expected 2 day/night music-card SVGs; found {count}')
replacements = [
 ('background-image:var(--ls-music-card),var(--ls-photo-left),var(--ls-photo-right)!important;',
  'background-image:var(--ls-music-card),var(--ls-photo-left),var(--ls-photo-right-frame),var(--ls-photo-right)!important;'),
 ('background-size:100% 100%,18% 35%,18% 35%!important;',
  'background-size:100% 100%,18% 35%,100% 100%,18% 35%!important;'),
 ('background-position:center,6.1% 39.8%,26.2% 39.8%!important;',
  'background-position:center,6.1% 39.8%,center,26.2% 39.8%!important;'),
]
for old, new in replacements:
    if css.count(old) != 2:
        raise SystemExit('ERROR: CSS declaration count mismatch; no output written')
    css = css.replace(old, new)
data['custom_css'] = css
output = source.with_name(source.stem + '_右框层级修复.json')
output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
check = json.loads(output.read_text(encoding='utf-8'))['custom_css']
assert check.count('--ls-photo-right-frame: url("data:image/svg+xml,') == 2
decoded = [unquote(x) for x in re.findall(r'--ls-music-card:\s*url\("data:image/svg\+xml,([^"]+)', check)]
assert len(decoded) == 2 and all(svg.count('fill="black"') == 2 for svg in decoded)
assert check.count('background-image:var(--ls-music-card),var(--ls-photo-left),var(--ls-photo-right-frame),var(--ls-photo-right)!important;') == 2
assert check.count('background-position:center,6.1% 39.8%,center,26.2% 39.8%!important;') == 2
print(f'OK: {output}')
print('Original avatar positions and sizes are unchanged; both SVG circle masks are retained.')
