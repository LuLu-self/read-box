// Small DOM helpers shared by the two pages. Data from the library only ever goes in as text.

import { BRANDS } from './brands.mjs';
import { getBlobUrl } from './gh.mjs';
import { PLATFORM_LABEL } from './data.mjs';

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false && k !== '') n.append(k);
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';

function glyph(name) {
  const b = BRANDS[name];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', b.path);
  path.setAttribute('fill', b.color || 'currentColor');
  svg.append(path);
  return svg;
}

const favicons = new Map();

// Platform logo, or the website's own icon (stored in the library, loaded with the token).
export function brandMark(item, cfg) {
  const label = item.platform === 'web' ? (item.site_name || '網站') : (PLATFORM_LABEL[item.platform] || item.platform);
  const span = el('span', { class: 'brand' });
  if (BRANDS[item.platform]) span.append(glyph(item.platform));
  else if (item.favicon && cfg && /^media\/favicons\/[a-z0-9.-]+\.png$/.test(item.favicon)) {
    const img = el('img', { alt: '', width: '16', height: '16' });
    span.append(img);
    if (!favicons.has(item.favicon)) favicons.set(item.favicon, getBlobUrl(cfg, item.favicon));
    favicons.get(item.favicon).then((u) => { if (u) img.src = u; else img.remove(); });
  }
  span.append(el('b', { text: label }));
  return span;
}
