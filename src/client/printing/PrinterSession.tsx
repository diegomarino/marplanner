import type { ReactNode } from "react";

import { PrintExecutor, usePrinterSession, type PrintExecutorProps } from "./PrintExecutor";

/** The single application-level printer owner. It owns the existing executor lifecycle and
 * exposes its truthful session state to presentation surfaces without starting another session.
 */
export function PrinterSessionProvider({
  children,
  ...executorProps
}: { children: ReactNode } & Omit<PrintExecutorProps, "children">): React.JSX.Element {
  return <PrintExecutor {...executorProps}>{children}</PrintExecutor>;
}

export { usePrinterSession };
