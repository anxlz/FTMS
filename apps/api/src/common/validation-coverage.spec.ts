import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Every controller source file under `src`. */
function controllers(dir = path.join(__dirname, '..')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'generated') return [];
    if (statSync(full).isDirectory()) return controllers(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

/**
 * §17 "input validation": nothing a client sends reaches a handler unchecked.
 * Bodies and query strings go through a shared Zod schema; path parameters
 * through a UUID or Zod pipe. The two signed-token parameters are verified by
 * their services (HMAC), which reject anything else.
 */
describe('input validation on every route', () => {
  const files = controllers();
  const sources = files.map((file) => ({
    file: path.relative(path.join(__dirname, '..'), file),
    text: readFileSync(file, 'utf8'),
  }));

  it('finds the controllers', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('validates every body and query string with a shared schema', () => {
    const unchecked = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/@(Body|Query)\(([^)]*)\)?/g)]
        .filter((m) => !m[2]!.includes('ZodValidationPipe'))
        .map((m) => `${file}: ${m[0]}`),
    );
    expect(unchecked).toEqual([]);
  });

  it('validates every path parameter, except signed tokens checked by their service', () => {
    const unchecked = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/@Param\(([^)]*)\)/g)]
        .filter((m) => !m[1]!.includes(','))
        .map((m) => `${file}: ${m[0]}`),
    );
    expect(unchecked.sort()).toEqual([
      "attendance/attendance.controller.ts: @Param('token')",
      "storage/local-files.controller.ts: @Param('token')",
    ]);
  });
});
