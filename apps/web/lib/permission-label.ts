/**
 * Message key for a permission label. Permission keys contain dots, which
 * next-intl reads as nesting, so the catalogs store them with underscores.
 * Accepts any string: keys arriving from the API are looked up with `t.has`.
 */
export const permissionMessageKey = (key: string): string =>
  `permissions.${key.replaceAll('.', '_')}`;
