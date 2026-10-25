/**
 * Prisma's `contains` becomes SQL `LIKE '%…%'` without escaping, so `%`, `_`
 * and `\` typed in a search box would act as wildcards. User text is matched
 * literally: those characters are escaped (PostgreSQL's default LIKE escape
 * character is the backslash). The value is still sent as a bound parameter.
 */
export const literal = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
