/** Runtime deployment prefix. The portable client build never embeds a host's mount path. */
export function normalizeBasePath(value = ""): string {
  if (!value || value === "/") return "";
  const base = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(base) ||
    base.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "BASE_PATH must be an absolute path of plain segments without queries or escapes"
    );
  return base;
}

/** Exact mount boundary; a sibling such as /planner-other never belongs to /planner. */
export function stripBasePath(pathname: string, base: string): string | null {
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

export function requestAppPath(url: string, base: string): string | null {
  const raw = url.split("?")[0];
  try {
    return stripBasePath(decodeURIComponent(raw), base);
  } catch {
    return stripBasePath(raw, base);
  }
}
