import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({ extend: { classGroups: { "font-size": ["text-control"] } } });

/** Merge Tailwind classes with correct conflict resolution. The only class-merge helper. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
