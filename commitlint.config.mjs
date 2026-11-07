// Conventional Commits for PR titles (the squash-merge subject on main) and for
// the commits inside a pull request. CONTRIBUTING.md describes the convention.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Scopes stay open (auth, deploy, deps-dev, ...) until a closed list is worth
    // maintaining. Subjects may open with a UI label or an HTTP verb, such as
    // "Schedule tab ..." or "POST /api/...", so their case is not checked.
    "subject-case": [0],
    // Bodies are wrapped prose and Dependabot bodies carry long release-note
    // URLs, so only the header is length-limited.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
