import { createContext, useContext, useState, type ReactNode } from "react";

interface AdminUnlockContextValue {
  /** Whether the client-side admin gate has been unlocked by the user. */
  unlocked: boolean;
  /** Set the admin-unlock state. Does NOT affect server authority. */
  setUnlocked: (v: boolean) => void;
}

const AdminUnlockContext = createContext<AdminUnlockContextValue>({
  unlocked: false,
  setUnlocked: () => {
    /* no-op */
  },
});

export function isAdminPinBypassEnabled(): boolean {
  return (
    import.meta.env.MODE !== "test" &&
    import.meta.env.VITE_E2E_HOOKS !== "true" &&
    import.meta.env.VITE_DEV_BYPASS_ADMIN_PIN === "1" &&
    ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
  );
}

export function AdminUnlockProvider({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(isAdminPinBypassEnabled);
  return (
    <AdminUnlockContext.Provider value={{ unlocked, setUnlocked }}>
      {children}
    </AdminUnlockContext.Provider>
  );
}

export function useAdminUnlock() {
  return useContext(AdminUnlockContext);
}
