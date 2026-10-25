import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The icon set generated from the official logo (`pnpm icons`) is complete and
 * current: every output listed in the branding manifest exists at its declared
 * size, and the web favicon, PWA icons and the Android launcher set (for the
 * later Tauri build) all come from the same source image.
 */
const ROOT = join(__dirname, '..', '..', '..');
const manifest = JSON.parse(
  readFileSync(join(ROOT, 'assets/branding/generated/manifest.json'), 'utf8'),
) as {
  source: string;
  sourceSha256: string;
  outputs: { file: string; size: string; bytes: number }[];
};

/** Width × height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): string {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

/** The sizes stored in an ICO directory. */
function icoSizes(bytes: Buffer): string[] {
  expect(bytes.readUInt16LE(2)).toBe(1); // type 1 = icon
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const w = bytes[6 + i * 16] || 256;
    const h = bytes[7 + i * 16] || 256;
    return `${w}x${h}`;
  });
}

describe('app icons (web and Android)', () => {
  it('come from the official logo, unchanged since generation', () => {
    const source = readFileSync(join(ROOT, manifest.source));
    expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.sourceSha256);
  });

  it('exist at the size the manifest declares', () => {
    for (const output of manifest.outputs) {
      const bytes = readFileSync(join(ROOT, output.file));
      expect([output.file, bytes.length]).toEqual([output.file, output.bytes]);
      const size = output.file.endsWith('.ico')
        ? icoSizes(bytes).join(',')
        : output.file.endsWith('.png')
          ? pngSize(bytes)
          : output.size;
      expect([output.file, size]).toEqual([output.file, output.size]);
    }
  });

  it('cover every Android launcher density, round and adaptive', () => {
    const files = manifest.outputs.map((o) => o.file);
    const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    const res = 'assets/branding/generated/android/res';
    for (const [density, px] of Object.entries(densities)) {
      for (const [name, size] of [
        ['ic_launcher', px],
        ['ic_launcher_round', px],
        ['ic_launcher_foreground', px * 2.25], // adaptive layer: 108dp
      ] as const) {
        const file = `${res}/mipmap-${density}/${name}.png`;
        expect(files).toContain(file);
        expect([file, pngSize(readFileSync(join(ROOT, file)))]).toEqual([file, `${size}x${size}`]);
      }
    }
    const adaptive = readFileSync(join(ROOT, `${res}/mipmap-anydpi-v26/ic_launcher.xml`), 'utf8');
    expect(adaptive).toContain('@mipmap/ic_launcher_foreground');
    expect(adaptive).toContain('@color/ic_launcher_background');
    expect(files).toContain('assets/branding/generated/android/playstore-icon-512.png');
  });
});
