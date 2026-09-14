'use strict';
/**
 * Asset generator based on the official Heroicons pack (MIT, https://heroicons.com).
 *
 * Produces:
 *   1. public/js/heroicons.js         — inline SVG registry for the sidebar UI
 *   2. public/assets/icon-*.png       — add-in ribbon icons (PNG, rasterized by resvg)
 *   3. public/assets/heroicons/       — copy of LICENSE + NOTICE (MIT attribution is required)
 *
 * Run: npm run assets
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HEROICONS_DIR = path.join(ROOT, 'node_modules', 'heroicons');
const OUT_JS = path.join(ROOT, 'public', 'js', 'heroicons.js');
const OUT_REACT_ICONS = path.join(ROOT, 'ui', 'src', 'lib', 'icons.js');
const OUT_ASSETS = path.join(ROOT, 'public', 'assets');
const OUT_LICENSE_DIR = path.join(OUT_ASSETS, 'heroicons');

/** Semantic name in the app → Heroicons file. */
const ICONS = {
  brand: ['24/solid', 'sparkles'],
  sparkles: ['24/outline', 'sparkles'],
  settings: ['24/outline', 'cog-6-tooth'],
  language: ['24/outline', 'language'],
  model: ['24/outline', 'cpu-chip'],
  key: ['24/outline', 'key'],
  send: ['24/outline', 'paper-airplane'],
  stop: ['24/outline', 'stop-circle'],
  refresh: ['24/outline', 'arrow-path'],
  undo: ['24/outline', 'arrow-uturn-left'],
  trash: ['24/outline', 'trash'],
  reset: ['24/outline', 'chat-bubble-left-right'],
  toolWrite: ['24/outline', 'pencil-square'],
  toolRead: ['24/outline', 'magnifying-glass'],
  toolCall: ['24/outline', 'wrench-screwdriver'],
  chart: ['24/outline', 'chart-bar'],
  table: ['24/outline', 'table-cells'],
  document: ['24/outline', 'document-text'],
  clock: ['24/outline', 'clock'],
  check: ['24/outline', 'check'],
  checkCircle: ['24/solid', 'check-circle'],
  close: ['24/outline', 'x-mark'],
  warning: ['24/outline', 'exclamation-triangle'],
  info: ['24/outline', 'information-circle'],
  // Markdown editor toolbar and rendered output
  bold: ['24/outline', 'bold'],
  italic: ['24/outline', 'italic'],
  code: ['24/outline', 'code-bracket'],
  link: ['24/outline', 'link'],
  listBullet: ['24/outline', 'list-bullet'],
  listNumbered: ['24/outline', 'numbered-list'],
  quote: ['24/outline', 'chat-bubble-left'],
  preview: ['24/outline', 'eye'],
  edit: ['24/outline', 'eye-slash'],
  copy: ['24/outline', 'clipboard-document'],
  // Gemini-like shell: history drawer, new chat, suggestions, personalization, cost meter
  menu: ['24/outline', 'bars-3'],
  newChat: ['24/outline', 'pencil-square'],
  history: ['24/outline', 'clock'],
  suggestion: ['24/outline', 'arrow-right'],
  personalization: ['24/outline', 'adjustments-horizontal'],
  balance: ['24/outline', 'banknotes'],
  reload: ['24/outline', 'arrow-path-rounded-square'],
  // Full-page settings: back arrow, row affordance, interface page
  chevronLeft: ['24/outline', 'chevron-left'],
  chevronRight: ['24/outline', 'chevron-right'],
  palette: ['24/outline', 'swatch'],
};

/** Icons used for the Excel ribbon icons (PNG required, Office does not support SVG). */
const RIBBON_SOURCE = ['24/solid', 'table-cells'];
const RIBBON_TILE = '#1D4ED8';
const RIBBON_TILE_RADIUS = 5;
const RIBBON_SCALE = 0.72;
const RIBBON_SIZES = [16, 32, 80];

/** Tool → semantic icon name mapping (used by the React UI). */
const READ_TOOL_ICONS = {
  get_workbook_overview: 'document',
  read_range: 'toolRead',
  get_tables: 'table',
  list_charts: 'chart',
  list_named_ranges: 'document',
  select_range: 'toolRead',
};

const WRITE_TOOL_ICONS = {
  create_chart: 'chart',
  create_table: 'table',
};

/** 'table-cells' → 'TableCellsIcon' (export name of @heroicons/react). */
function pascalIconName(name) {
  return `${name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Icon`;
}

function readIcon([folder, name]) {
  const file = path.join(HEROICONS_DIR, folder, `${name}.svg`);
  if (!fs.existsSync(file)) throw new Error(`Heroicons icon not found: ${folder}/${name}.svg`);
  const svg = fs.readFileSync(file, 'utf8');
  const match = /<svg([^>]*)>([\s\S]*)<\/svg>/.exec(svg);
  if (!match) throw new Error(`Unrecognized SVG file: ${file}`);
  const attrs = match[1];
  const viewBox = (/viewBox="([^"]+)"/.exec(attrs) || [, '0 0 24 24'])[1];
  const fill = (/fill="([^"]+)"/.exec(attrs) || [, 'none'])[1];
  const strokeWidth = (/stroke-width="([^"]+)"/.exec(attrs) || [, '1.5'])[1];
  return { viewBox, fill, strokeWidth, body: sanitizeBody(match[2]) };
}

/** Strip anything that does not need to be executed from the markup (defense in depth). */
function sanitizeBody(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRegistry() {
  const icons = {};
  for (const [key, source] of Object.entries(ICONS)) {
    icons[key] = readIcon(source);
  }
  return icons;
}

function writeRegistry(icons, version) {
  const banner = [
    '/* eslint-disable */',
    '/**',
    ' * THIS FILE IS GENERATED AUTOMATICALLY by scripts/build-assets.js — do not edit it manually.',
    ` * Icon source: Heroicons v${version} (https://heroicons.com), MIT license.`,
    ' * Regenerate with: npm run assets',
    ' */',
  ].join('\n');

  const content = `${banner}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.DSX = root.DSX || {};
    root.DSX.heroicons = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const version = ${JSON.stringify(version)};
  const icons = ${JSON.stringify(icons, null, 2)};

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Full <svg> markup; the color follows currentColor. */
  function svg(name, options) {
    const icon = icons[name];
    if (!icon) return '';
    const opts = options || {};
    const className = opts.className ? \` class="\${escapeXml(opts.className)}"\` : '';
    const size = opts.size ? \` width="\${escapeXml(opts.size)}" height="\${escapeXml(opts.size)}"\` : '';
    const title = opts.title ? \`<title>\${escapeXml(opts.title)}</title>\` : '';
    const paint = icon.fill === 'none'
      ? \` fill="none" stroke="currentColor" stroke-width="\${icon.strokeWidth}"\`
      : ' fill="currentColor"';
    return \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="\${icon.viewBox}"\${paint}\${className}\${size} aria-hidden="true" focusable="false">\${title}\${icon.body}</svg>\`;
  }

  return {
    version,
    names: Object.keys(icons),
    has: (name) => Boolean(icons[name]),
    svg,
    body: (name) => (icons[name] ? icons[name].body : ''),
  };
});
`;
  fs.writeFileSync(OUT_JS, content);
  return OUT_JS;
}

/** Icon barrel for the React UI (@heroicons/react), so the icon list stays single-sourced. */
function writeReactIcons(version) {
  // Sets keep the imports unique: the same Heroicon may back several semantic names.
  const outline = new Set();
  const solid = new Set();
  const mapEntries = [];
  for (const [key, [folder, name]] of Object.entries(ICONS)) {
    const icon = pascalIconName(name);
    if (folder === '24/solid') {
      // Solid icons always get an alias so an icon used in both styles never clashes.
      solid.add(icon);
      mapEntries.push(`  ${key}: ${icon}Solid,`);
    } else {
      outline.add(icon);
      mapEntries.push(`  ${key}: ${icon},`);
    }
  }
  const outlineImports = [...outline].sort().join(', ');
  const solidImports = [...solid].sort().map((icon) => `${icon} as ${icon}Solid`).join(', ');
  const content = `/* eslint-disable */
/**
 * THIS FILE IS GENERATED AUTOMATICALLY by scripts/build-assets.js — do not edit it manually.
 * Icon source: Heroicons v${version} (https://heroicons.com), MIT license.
 * Regenerate with: npm run assets
 */
import { ${outlineImports} } from '@heroicons/react/24/outline';
import { ${solidImports} } from '@heroicons/react/24/solid';

/** Semantic name → Heroicons icon component. */
export const icons = {
${mapEntries.join('\n')}
};

/** Icons for read tools (also used by scripts/build-assets.js). */
export const READ_TOOL_ICONS = ${JSON.stringify(READ_TOOL_ICONS, null, 2)};

/** Icons for write tools. */
export const WRITE_TOOL_ICONS = ${JSON.stringify(WRITE_TOOL_ICONS, null, 2)};
`;
  fs.mkdirSync(path.dirname(OUT_REACT_ICONS), { recursive: true });
  fs.writeFileSync(OUT_REACT_ICONS, content);
  return OUT_REACT_ICONS;
}

function ribbonSvg(size, body) {  const inset = (24 - 24 * RIBBON_SCALE) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
  <rect x="0" y="0" width="24" height="24" rx="${RIBBON_TILE_RADIUS}" fill="${RIBBON_TILE}"/>
  <g transform="translate(${inset} ${inset}) scale(${RIBBON_SCALE})" fill="#FFFFFF">${body}</g>
</svg>`;
}

async function writeRibbonPngs() {
  let Resvg;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch (err) {
    throw new Error(
      'The @resvg/resvg-js package is not installed, so the PNG icons cannot be created. '
      + 'Run: npm install',
    );
  }
  const icon = readIcon(RIBBON_SOURCE);
  const written = [];
  for (const size of RIBBON_SIZES) {
    const svg = ribbonSvg(size, icon.body);
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
    const file = path.join(OUT_ASSETS, `icon-${size}.png`);
    fs.writeFileSync(file, png);
    written.push({ file, size, bytes: png.length });
  }
  return written;
}

function writeAttribution(version) {
  fs.mkdirSync(OUT_LICENSE_DIR, { recursive: true });
  const licenseSrc = path.join(HEROICONS_DIR, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(OUT_LICENSE_DIR, 'LICENSE'));
  }
  const notice = [
    '# Icon attribution',
    '',
    `The icons in this folder and the file \`public/js/heroicons.js\` come from **Heroicons v${version}**`,
    '(https://heroicons.com), created by Tailwind Labs, licensed under **MIT**.',
    '',
    'The ribbon icons (`icon-16.png`, `icon-32.png`, `icon-80.png`) are a rasterization of the',
    '`24/solid/table-cells.svg` icon above on a blue canvas, because the Office Add-in manifest',
    'only accepts raster files (PNG/JPG/GIF) for ribbon buttons.',
    '',
    'The full license is in `LICENSE` in this folder.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_LICENSE_DIR, 'NOTICE.md'), notice);
  return OUT_LICENSE_DIR;
}

async function main() {
  if (!fs.existsSync(HEROICONS_DIR)) {
    throw new Error('The heroicons package is not installed. Run: npm install');
  }
  const version = JSON.parse(fs.readFileSync(path.join(HEROICONS_DIR, 'package.json'), 'utf8')).version;
  fs.mkdirSync(OUT_ASSETS, { recursive: true });

  const icons = buildRegistry();
  const registryFile = writeRegistry(icons, version);
  const reactIconsFile = writeReactIcons(version);
  const pngs = await writeRibbonPngs();
  const licenseDir = writeAttribution(version);

  console.log(`Heroicons v${version} — ${Object.keys(icons).length} icons used by the UI.`);
  console.log(`Registry  : ${path.relative(ROOT, registryFile)} (classic pane)`);
  console.log(`React icons: ${path.relative(ROOT, reactIconsFile)} (React pane + shadcn)`);
  for (const png of pngs) {
    console.log(`Ribbon icon: ${path.relative(ROOT, png.file)} (${png.size}px, ${png.bytes} bytes)`);
  }
  console.log(`Attribution: ${path.relative(ROOT, licenseDir)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed to build assets: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ICONS,
  RIBBON_SIZES,
  RIBBON_SOURCE,
  READ_TOOL_ICONS,
  WRITE_TOOL_ICONS,
  buildRegistry,
  ribbonSvg,
  pascalIconName,
};
