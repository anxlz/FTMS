#!/usr/bin/env node
/**
 * Derives every app icon from the single official logo (§2 "App icons and branding").
 *
 *   pnpm icons
 *
 * Source: assets/branding/source/agr-logo.png (the Faculty of Agriculture logo).
 * Set APP_ICON_SOURCE_URL to download a replacement source first; the downloaded
 * file overwrites the committed source so the change is reviewable in git.
 *
 * Small icons (favicon, launcher icons) use the obelisk-and-falcons EMBLEM cropped
 * from the logo, because the full lockup's text is unreadable below ~96 px. The
 * crop box is tied to the exact source file by its SHA-256; if the source changes,
 * the script falls back to the full (trimmed) logo and tells you to re-measure.
 * Set ICON_SUBJECT=full to always use the full logo.
 *
 * Outputs are committed, so builds never depend on image tooling or the network.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets/branding/source/agr-logo.png');
const WEB_APP = path.join(ROOT, 'apps/web/app');
const WEB_PUBLIC = path.join(ROOT, 'apps/web/public');
const GENERATED = path.join(ROOT, 'assets/branding/generated');

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Emblem bounding box measured on the source with this SHA-256 (2087×2088 px). */
const EMBLEM = {
  sourceSha256: '23d9b8d4ce22a929972abd1533b24f4d3f5863791595e36e33a4fe46d25abc60',
  box: { left: 405, top: 117, width: 1275, height: 1202 },
};

const ANDROID_DENSITIES = [
  { name: 'mdpi', legacy: 48, adaptive: 108 },
  { name: 'hdpi', legacy: 72, adaptive: 162 },
  { name: 'xhdpi', legacy: 96, adaptive: 216 },
  { name: 'xxhdpi', legacy: 144, adaptive: 324 },
  { name: 'xxxhdpi', legacy: 192, adaptive: 432 },
];

const outputs = [];

async function resolveSource() {
  const url = process.env.APP_ICON_SOURCE_URL?.trim();
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    if (!meta.width) throw new Error(`${url} is not a readable image`);
    await writeFile(SOURCE, await sharp(bytes).png().toBuffer());
    console.log(`Downloaded new source from ${url} → ${path.relative(ROOT, SOURCE)}`);
  }
  return readFile(SOURCE);
}

async function subjectFrom(source, sha256) {
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 1024) {
    throw new Error('Source logo must be at least 1024 px on its shorter side.');
  }
  const wanted = process.env.ICON_SUBJECT === 'full' ? 'full' : 'emblem';
  if (wanted === 'emblem' && sha256 === EMBLEM.sourceSha256) {
    return { kind: 'emblem', image: await sharp(source).extract(EMBLEM.box).png().toBuffer() };
  }
  if (wanted === 'emblem') {
    console.warn(
      'Source logo changed: emblem crop box no longer applies. Using the full logo; ' +
        're-measure EMBLEM.box in scripts/generate-icons.mjs to restore the emblem.',
    );
  }
  return {
    kind: 'full',
    image: await sharp(source)
      .flatten({ background: WHITE })
      .trim({ threshold: 10 })
      .png()
      .toBuffer(),
  };
}

/** Largest scale at which a w×h subject fits a box of `boxSide` (square) or a circle of `circleDiameter`. */
function fitScale(w, h, { boxSide, circleDiameter }) {
  const byBox = boxSide ? Math.min(boxSide / w, boxSide / h) : Infinity;
  const byCircle = circleDiameter ? circleDiameter / Math.hypot(w, h) : Infinity;
  return Math.min(byBox, byCircle);
}

/** Centers the subject on a size×size canvas within the given box/circle constraint. */
async function compose(subject, size, constraint, background = WHITE, circleMask = false) {
  const { width: w, height: h } = await sharp(subject).metadata();
  const scale = fitScale(w, h, constraint);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const resized = await sharp(subject).resize(tw, th, { kernel: 'lanczos3' }).png().toBuffer();
  let canvas = sharp({ create: { width: size, height: size, channels: 4, background } }).composite([
    { input: resized, left: Math.round((size - tw) / 2), top: Math.round((size - th) / 2) },
  ]);
  if (circleMask) {
    const r = size / 2;
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
    );
    canvas = sharp(await canvas.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
  }
  return canvas.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

async function emit(file, buffer, note) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  const meta = file.endsWith('.ico') ? null : await sharp(buffer).metadata();
  outputs.push({
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    size: meta ? `${meta.width}x${meta.height}` : note,
    bytes: buffer.length,
  });
}

/** Minimal ICO container with PNG-compressed entries (supported by every current browser). */
function toIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  const source = await resolveSource();
  const sha256 = createHash('sha256').update(source).digest('hex');
  const subject = await subjectFrom(source, sha256);
  const S = subject.image;

  // --- Web (Next.js metadata files + manifest icons) ---
  const icoSizes = [16, 32, 48];
  const icoPngs = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      data: await compose(S, size, { boxSide: size * 0.94 }),
    })),
  );
  await emit(
    path.join(WEB_APP, 'favicon.ico'),
    toIco(icoPngs),
    icoSizes.map((s) => `${s}x${s}`).join(','),
  );
  await emit(path.join(WEB_APP, 'icon.png'), await compose(S, 192, { boxSide: 192 * 0.9 }));
  await emit(path.join(WEB_APP, 'apple-icon.png'), await compose(S, 180, { boxSide: 180 * 0.8 }));
  for (const size of [192, 512]) {
    await emit(
      path.join(WEB_PUBLIC, `icons/icon-${size}.png`),
      await compose(S, size, { boxSide: size * 0.86 }),
    );
  }
  // Maskable: everything important inside the central circle of 80 % diameter.
  await emit(
    path.join(WEB_PUBLIC, 'icons/maskable-512.png'),
    await compose(S, 512, { circleDiameter: 512 * 0.8 }),
  );

  // Full logo for in-page display (2× the 320 px CSS size).
  const fullLogo = await sharp(source)
    .flatten({ background: WHITE })
    .trim({ threshold: 10 })
    .toBuffer();
  const framedLogo = await compose(fullLogo, 640, { boxSide: 640 * 0.96 });
  await emit(path.join(WEB_PUBLIC, 'brand/agr-logo.png'), framedLogo);

  // --- Future Tauri mobile build (§2, §18.4) ---
  await emit(
    path.join(GENERATED, 'app-icon-1024.png'),
    await compose(S, 1024, { boxSide: 1024 * 0.86 }),
  );
  await emit(
    path.join(GENERATED, 'android/playstore-icon-512.png'),
    await compose(S, 512, { boxSide: 512 * 0.8 }),
  );

  const res = path.join(GENERATED, 'android/res');
  for (const d of ANDROID_DENSITIES) {
    const dir = path.join(res, `mipmap-${d.name}`);
    await emit(
      path.join(dir, 'ic_launcher.png'),
      await compose(S, d.legacy, { boxSide: d.legacy * 0.86 }),
    );
    await emit(
      path.join(dir, 'ic_launcher_round.png'),
      await compose(S, d.legacy, { circleDiameter: d.legacy * 0.92 }, WHITE, true),
    );
    // Adaptive foreground: 108 dp canvas; launcher masks may cut anything outside the 66 dp circle.
    await emit(
      path.join(dir, 'ic_launcher_foreground.png'),
      await compose(S, d.adaptive, { circleDiameter: (d.adaptive * 66) / 108 }, TRANSPARENT),
    );
  }
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const file = path.join(res, 'mipmap-anydpi-v26', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, adaptiveXml);
    outputs.push({
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      size: 'xml',
      bytes: adaptiveXml.length,
    });
  }
  const colorXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>
`;
  const colorFile = path.join(res, 'values/ic_launcher_background.xml');
  await mkdir(path.dirname(colorFile), { recursive: true });
  await writeFile(colorFile, colorXml);
  outputs.push({
    file: path.relative(ROOT, colorFile).split(path.sep).join('/'),
    size: 'xml',
    bytes: colorXml.length,
  });

  // Reproducibility record (no timestamps, so regenerating unchanged input is a no-op diff).
  const manifest = {
    source: path.relative(ROOT, SOURCE).split(path.sep).join('/'),
    sourceSha256: sha256,
    subject: subject.kind,
    emblemCropBox: subject.kind === 'emblem' ? EMBLEM.box : null,
    generator: 'scripts/generate-icons.mjs',
    outputs,
  };
  await writeFile(path.join(GENERATED, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Generated ${outputs.length} files from ${manifest.source} (subject: ${subject.kind}).`,
  );
  for (const o of outputs) console.log(`  ${o.size.padEnd(12)} ${o.file}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
