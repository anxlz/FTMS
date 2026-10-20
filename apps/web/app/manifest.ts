import type { MetadataRoute } from 'next';
import { BRAND_COLORS } from '@ftms/core';

/** Web app manifest. Icons are derived from the official logo by `pnpm icons`. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس',
    short_name: 'التدريب الميداني',
    description: 'Field Training Management System — Faculty of Agriculture, Ain Shams University',
    lang: 'ar',
    dir: 'rtl',
    start_url: '/',
    display: 'standalone',
    background_color: BRAND_COLORS.white,
    theme_color: BRAND_COLORS.blue,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
