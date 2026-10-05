/**
 * @cytale/mobile — runtime bootstrap (plan 004 M5).
 *
 * Importing this module installs the Hermes/Expo globals the shared
 * `@cytale/*` packages need (`installShims()`, M1) as a module side effect.
 *
 * Why a module and not just a call in `app/_layout.tsx`: expo-router loads
 * every file in `app/` through its require context, and the layouts/route
 * modules are not guaranteed to be evaluated after `_layout.tsx` — a route
 * module that touched a shared package first would run before the shims
 * existed. Every module in `src/navigation` that imports a shared package
 * imports this one FIRST, so the invariant is local and cannot rot.
 *
 * `installShims()` is idempotent, so importing this from many places is free.
 *
 * The #88 error handlers are installed in `app/_layout.tsx` immediately AFTER
 * this module is imported — deliberately not here, because `installShims()`
 * must run before any `@cytale/*` module is evaluated and an ESM import of the
 * observer would be hoisted above it.
 */
import { installShims } from '../shims';

installShims();

export {};
