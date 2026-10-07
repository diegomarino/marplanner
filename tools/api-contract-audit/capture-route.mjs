// Attribute the deliberate encoded provisioning access form to its middleware boundary.
// Never persist raw URLs, credentials or query strings in synthetic captures.
export function captureRoute({ method, route, url, status, contentType, payload }) {
  const pathname = (url ?? "").split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return route;
  }
  return method === "POST" &&
    route === "/api/auth/provision" &&
    pathname !== decoded &&
    decoded === "/api/auth/provision" &&
    status === 200 &&
    contentType.split(";")[0] === "text/html" &&
    typeof payload === "string" &&
    payload.includes('<main data-testid="access-gate-form">')
    ? "(access-gate-form)"
    : route;
}
