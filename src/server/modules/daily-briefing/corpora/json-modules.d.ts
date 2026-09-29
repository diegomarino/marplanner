/** Ambient module declaration for `.json` asset imports (trap-sweep probe,
 * revised after an in-task dist-mode probe — see loader.ts's header comment for the full
 * rationale). Lets `tsc -b` type-check a static `import x from "./y.json"` WITHOUT setting
 * `resolveJsonModule` in `tsconfig.server.json` (a batch-A shared config file outside this module's
 * touch-set) — TypeScript honors a wildcard ambient module declaration like this one instead of
 * requiring the compiler flag. Each corpus's real shape is asserted by an explicit `as Type[]`
 * cast at the import site (loader.ts), mirroring v1's own `require("./x.json") as Type[]` pattern.
 */
declare module "*.json" {
  const value: unknown;
  export default value;
}
