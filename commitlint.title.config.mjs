import base from "./commitlint.config.mjs";

// The PR title becomes the squash subject on main, so it gets no exemptions:
// commitlint's default ignores (merge, revert, reapply, fixup!, semver
// subjects) only make sense for the commits inside a pull request.
export default { ...base, defaultIgnores: false };
