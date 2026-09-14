'use strict';
/**
 * Asset tests: ribbon icons are genuinely valid PNGs containing Heroicons glyphs,
 * the icon registry is complete, and the MIT license attribution is available.
 *
 * PNGs are decoded by hand (IHDR + inflate IDAT + unfilter) so the pixel checks
 * stay real without extra dependencies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'public', 'assets');
const heroicons = require('../public/js/heroicons.js');

function decodePng(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'bukan berkas PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, 'bit depth harus 8');
  assert.equal(colorType, 6, 'warna harus RGBA');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`filter PNG tidak dikenal: ${filter}`);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels, stride };
}

function rgbaAt(image, x, y) {
  const offset = y * image.stride + x * 4;
  return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2], image.pixels[offset + 3]];
}

for (const size of [16, 32, 80]) {
  test(`icon-${size}.png is valid and contains a blue tile + white glyph`, () => {
    const file = path.join(assetsDir, `icon-${size}.png`);
    assert.ok(fs.existsSync(file), `berkas hilang: icon-${size}.png`);
    const image = decodePng(fs.readFileSync(file));
    assert.equal(image.width, size);
    assert.equal(image.height, size);

    // Rounded corners → the corner pixels are transparent.
    assert.equal(rgbaAt(image, 0, 0)[3], 0, 'sudut kiri-atas harus transparan (tile rounded)');
    assert.equal(rgbaAt(image, size - 1, size - 1)[3], 0, 'sudut kanan-bawah harus transparan');

    // The top edge of the middle section must contain the tile color (#1D4ED8).
    const [r, g, b, a] = rgbaAt(image, Math.floor(size / 2), 1);
    assert.equal(a, 255, 'tepi atas harus opak');
    assert.ok(Math.abs(r - 0x1d) < 40 && Math.abs(g - 0x4e) < 40 && Math.abs(b - 0xd8) < 40, `warna tile tidak sesuai: ${[r, g, b]}`);

    // There must be white pixels (the rasterized Heroicons glyph).
    let white = 0;
    let blue = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const [pr, pg, pb, pa] = rgbaAt(image, x, y);
        if (pa === 0) continue;
        if (pr > 200 && pg > 200 && pb > 200) white += 1;
        else if (pb > 120 && pb > pr) blue += 1;
      }
    }
    const total = size * size;
    assert.ok(white / total > 0.03, `glyph putih terlalu sedikit: ${white}/${total}`);
    assert.ok(blue / total > 0.2, `area tile biru terlalu sedikit: ${blue}/${total}`);
  });
}

test('Heroicons registry contains the icons the UI needs', () => {
  assert.ok(heroicons.names.length >= 20, `hanya ${heroicons.names.length} ikon`);
  for (const name of ['brand', 'settings', 'language', 'send', 'undo', 'trash', 'reset', 'toolRead', 'toolWrite', 'warning', 'check', 'close', 'info', 'model']) {
    assert.ok(heroicons.has(name), `ikon "${name}" tidak ada`);
  }
  const markup = heroicons.svg('settings', { className: 'icon' });
  assert.match(markup, /^<svg /);
  assert.match(markup, /viewBox="0 0 24 24"/);
  assert.match(markup, /class="icon"/);
  assert.match(markup, /stroke="currentColor"/);
  assert.equal(heroicons.svg('tidak-ada'), '');
  assert.equal(heroicons.body('tidak-ada'), '');
});

test('icon markup contains no scripts or dangerous attributes', () => {
  for (const name of heroicons.names) {
    const markup = heroicons.svg(name);
    assert.equal(/<script/i.test(markup), false, `${name} memuat <script>`);
    assert.equal(/\son\w+\s*=/i.test(markup), false, `${name} memuat atribut on*`);
    assert.equal(/javascript:/i.test(markup), false, `${name} memuat javascript:`);
  }
});

test('Heroicons license attribution is available', () => {
  const licenseDir = path.join(assetsDir, 'heroicons');
  assert.ok(fs.existsSync(path.join(licenseDir, 'LICENSE')), 'LICENSE Heroicons hilang');
  assert.ok(fs.existsSync(path.join(licenseDir, 'NOTICE.md')), 'NOTICE.md hilang');
  const notice = fs.readFileSync(path.join(licenseDir, 'NOTICE.md'), 'utf8');
  assert.match(notice, /Heroicons/);
  assert.match(notice, /MIT/);
  const banner = fs.readFileSync(path.join(root, 'public', 'js', 'heroicons.js'), 'utf8');
  assert.match(banner, /Heroicons v\d/);
  assert.match(banner, /MIT/);
});

test('scripts/build-assets.js uses the official pack, not home-made icons', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build-assets.js'), 'utf8');
  assert.match(source, /node_modules['"],\s*['"]heroicons/);
  assert.match(source, /@resvg\/resvg-js/);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'make-icons.js')), false, 'generator ikon lama masih ada');
});
