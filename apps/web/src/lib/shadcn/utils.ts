/**
 * @cytale/web — the shadcn convention seam (#150).
 *
 * `cn` is the class-joiner every shadcn component uses; `cva` re-exports
 * class-variance-authority so migrated components have one import site. Our
 * tokens stay the source of truth: shadcn's variable conventions are mapped
 * ONTO our `--tk-*` primitives in tokens.css, so a shadcn component rendered
 * in this app wears the house theme with zero per-component styling.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export { cva } from 'class-variance-authority';
export type { VariantProps } from 'class-variance-authority';
