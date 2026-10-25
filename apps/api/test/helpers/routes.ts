import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { IS_PUBLIC, PERMISSIONS_KEY, ROLES_KEY } from '../../src/auth/decorators';
import { type TestApp } from './test-app';

export interface RouteInfo {
  /** e.g. `GET /students/:id` */
  key: string;
  isPublic: boolean;
  roles: string[] | null;
  permissions: { mode: string; keys: string[] } | null;
}

const join = (...parts: (string | undefined)[]) =>
  `/${parts
    .filter((p): p is string => typeof p === 'string' && p !== '' && p !== '/')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .join('/')}`;

/** Every route the running application registered, read from controller metadata. */
export function listRoutes(app: TestApp): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const ctor = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!ctor) continue;
      const bases = [
        Reflect.getMetadata(PATH_METADATA, ctor) as string | string[] | undefined,
      ].flat();
      const proto = ctor.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (path === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const meta = <T>(key: string) =>
          (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctor) ?? null) as T | null;
        for (const base of bases) {
          for (const p of [path].flat()) {
            routes.push({
              key: `${method} ${join(base, p)}`,
              isPublic: meta<boolean>(IS_PUBLIC) === true,
              roles: meta<string[]>(ROLES_KEY),
              permissions: meta<{ mode: string; keys: string[] }>(PERMISSIONS_KEY),
            });
          }
        }
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
