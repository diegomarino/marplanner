import { normalizeBasePath, stripBasePath } from "../../shared/base-path";

export function clientBasePath(): string {
  return normalizeBasePath(
    document.querySelector<HTMLMetaElement>('meta[name="mp-base-path"]')?.content
  );
}

/** Convert an application-relative URL for native links, history and API transports. */
export function appUrl(path: string): string {
  return `${clientBasePath()}${path}`;
}

export function appPathname(): string {
  return stripBasePath(window.location.pathname, clientBasePath()) ?? window.location.pathname;
}
