import { useEffect, useState, type CSSProperties } from "react";
import { useAdminUnlock } from "@/lib/adminUnlock";
import { authFetch } from "@/lib/credential";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { MemberCreateForm } from "@/admin/MemberCreateForm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MEMBER_COLOR_KEYS, Member, Role, type MemberColorKey } from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useTranslation } from "@/i18n";

/* ------------------------------------------------------------------ */
/* MembersManagement — two-tab admin UI with active/archived tabs */
/* Uses AdminPanel and shared density-token controls. Member identity */
/* is controlled, and colour selection uses generated member-colour */
/* tokens. */
/* ------------------------------------------------------------------ */

/** SC-007: replaces the previous `("members.birthdate.months." + String(i + 1)) as any` /
 * `` `members.birthdate.months.${member.birthDate.month}` as MessageKey `` casts. Every entry is a
 * real literal key in the `members.birthdate.months.*` namespace (verified against
 * `i18n/messages.ts`), indexed 0-based here so `BIRTH_MONTH_LABEL_KEYS[n - 1]` maps the 1-based
 * calendar month the API/UI already use straight to its key — no cast, no string concatenation. */
const BIRTH_MONTH_LABEL_KEYS: readonly MessageKey[] = [
  "members.birthdate.months.1",
  "members.birthdate.months.2",
  "members.birthdate.months.3",
  "members.birthdate.months.4",
  "members.birthdate.months.5",
  "members.birthdate.months.6",
  "members.birthdate.months.7",
  "members.birthdate.months.8",
  "members.birthdate.months.9",
  "members.birthdate.months.10",
  "members.birthdate.months.11",
  "members.birthdate.months.12",
];

/** Same shape as `BIRTH_MONTH_LABEL_KEYS`, for the 1-31 day-of-month range. */
const BIRTH_DAY_LABEL_KEYS: readonly MessageKey[] = [
  "members.birthdate.days.1",
  "members.birthdate.days.2",
  "members.birthdate.days.3",
  "members.birthdate.days.4",
  "members.birthdate.days.5",
  "members.birthdate.days.6",
  "members.birthdate.days.7",
  "members.birthdate.days.8",
  "members.birthdate.days.9",
  "members.birthdate.days.10",
  "members.birthdate.days.11",
  "members.birthdate.days.12",
  "members.birthdate.days.13",
  "members.birthdate.days.14",
  "members.birthdate.days.15",
  "members.birthdate.days.16",
  "members.birthdate.days.17",
  "members.birthdate.days.18",
  "members.birthdate.days.19",
  "members.birthdate.days.20",
  "members.birthdate.days.21",
  "members.birthdate.days.22",
  "members.birthdate.days.23",
  "members.birthdate.days.24",
  "members.birthdate.days.25",
  "members.birthdate.days.26",
  "members.birthdate.days.27",
  "members.birthdate.days.28",
  "members.birthdate.days.29",
  "members.birthdate.days.30",
  "members.birthdate.days.31",
];

const MEMBER_COLOR_LABEL_KEYS: Record<MemberColorKey, MessageKey> = {
  blue: "members.color.blue",
  sky: "members.color.sky",
  cyan: "members.color.cyan",
  teal: "members.color.teal",
  green: "members.color.green",
  lime: "members.color.lime",
  yellow: "members.color.yellow",
  amber: "members.color.amber",
  orange: "members.color.orange",
  red: "members.color.red",
  rose: "members.color.rose",
  pink: "members.color.pink",
  fuchsia: "members.color.fuchsia",
  purple: "members.color.purple",
  violet: "members.color.violet",
  indigo: "members.color.indigo",
};

/** Formats a member's birth date for display, localized month name + locale-appropriate word
 * order (unchanged behaviour from before this migration — only the month-name lookup lost its
 * cast). */
function formatBirthDate(
  t: (key: MessageKey) => string,
  language: string,
  birthDate: { month: number; day: number; year: number | null }
): string {
  // `birthDate.month` is typed `number`, not a 1-12 literal
  // union, so an out-of-range value indexes past the array and returns `undefined` — the
  // PREVIOUS `as MessageKey` cast merely degraded to the raw key string in that case (`t`
  // falls back to the key itself when the lookup misses), never crashing. Calling `t(undefined)`
  // does the same lookup-miss fallback and ALSO returns `undefined` (there is no key named
  // `undefined`), so `monthName.toLowerCase` below would throw in the `es` branch. Guarding
  // the lookup itself (not just the cast) preserves the old "degrade to something legible"
  // behaviour instead of just moving where it crashes.
  const monthKey = BIRTH_MONTH_LABEL_KEYS[birthDate.month - 1];
  const monthName = monthKey ? t(monthKey) : String(birthDate.month);
  return language === "es"
    ? `${birthDate.day} de ${monthName.toLowerCase()}${birthDate.year !== null ? ` de ${birthDate.year}` : ""}`
    : `${monthName} ${birthDate.day}${birthDate.year !== null ? `, ${birthDate.year}` : ""}`;
}

function MembersManagementContent() {
  const { t, language } = useTranslation();

  const [tab, setTab] = useState<"active" | "archived">("active");
  const [members, setMembers] = useState<Member[]>([]);
  const [archivedMembers, setArchivedMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRole, setEditRole] = useState<Role | "">("");
  const [editMonth, setEditMonth] = useState<number | "">("");
  const [editDay, setEditDay] = useState<number | "">("");
  const [editYear, setEditYear] = useState<string>("");
  const [editColorKey, setEditColorKey] = useState<MemberColorKey | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Load the active-members list when this panel mounts. The Refresh control invokes the same
  // loader; this panel needs no household-timezone gating.
  useEffect(() => {
    refreshMembers();
  }, []);

  const refreshMembers = () => {
    setLoading(true);
    setError(null);

    authFetch("/api/members", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`list members: ${res.status}`);
        return res.json() as Promise<Member[]>;
      })
      .then((data) => {
        setMembers(data);
      })
      .catch(() => {
        setError(t("members.management.error"));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const refreshArchivedMembers = () => {
    setLoading(true);
    setError(null);

    authFetch("/api/members?lifecycle=archived", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`list archived members: ${res.status}`);
        return res.json() as Promise<Member[]>;
      })
      .then((data) => {
        setArchivedMembers(data);
        setArchivedLoaded(true);
      })
      .catch(() => {
        setError(t("members.management.error"));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const startEditingMember = (member: Member) => {
    setEditingMember(member);
    setEditDisplayName(member.displayName);
    setEditRole(member.role);
    setEditColorKey(member.colorKey);
    if (member.birthDate) {
      setEditMonth(member.birthDate.month);
      setEditDay(member.birthDate.day);
      setEditYear(member.birthDate.year !== null ? String(member.birthDate.year) : "");
    } else {
      setEditMonth("");
      setEditDay("");
      setEditYear("");
    }
  };

  const cancelEditingMember = () => {
    setEditingMember(null);
    setEditDisplayName("");
    setEditRole("");
    setEditMonth("");
    setEditDay("");
    setEditYear("");
    setEditColorKey(null);
  };

  const clearEditBirthdate = () => {
    setEditMonth("");
    setEditDay("");
    setEditYear("");
  };

  const handleSaveEdit = () => {
    if (!editingMember) return;

    setSavingEdit(true);
    setError(null);

    const updates: Partial<Member> & {
      birthDate?: { month: number; day: number; year: number | null } | null;
    } = {
      displayName: editDisplayName.trim(),
      role: editRole as Role,
    };
    if (editColorKey) updates.colorKey = editColorKey;

    const anySet = editMonth !== "" || editDay !== "" || editYear.trim() !== "";
    const bothMonthDay = editMonth !== "" && editDay !== "";
    if (anySet && !bothMonthDay) {
      setError(t("members.birthdate.errorPartial"));
      setSavingEdit(false);
      return;
    }

    if (bothMonthDay) {
      const birthDate = {
        month: Number(editMonth),
        day: Number(editDay),
        year: editYear.trim() ? parseInt(editYear, 10) : null,
      };
      if (
        birthDate.year !== null &&
        (isNaN(birthDate.year) ||
          birthDate.year < 1900 ||
          birthDate.year > new Date().getFullYear())
      ) {
        setError(t("members.birthdate.errorInvalidYear"));
        setSavingEdit(false);
        return;
      }
      updates.birthDate = birthDate;
    } else {
      updates.birthDate = null;
    }

    authFetch(`/api/members/${editingMember.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updates),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`update member: ${res.status}`);
        return res.json() as Promise<Member>;
      })
      .then((updatedMember) => {
        if (tab === "active") {
          setMembers((prev) => prev.map((m) => (m.id === updatedMember.id ? updatedMember : m)));
        } else {
          setArchivedMembers((prev) =>
            prev.map((m) => (m.id === updatedMember.id ? updatedMember : m))
          );
        }
        cancelEditingMember();
      })
      .catch((err) => {
        if (err instanceof Error && "response" in err && err["response"] instanceof Response) {
          const response = err["response"] as Response;
          if (response.ok) {
            setError(t("members.management.error"));
            return;
          }
          response
            .json()
            .then((data: { message?: string; error?: string }) => {
              setError(data.message || data.error || t("members.management.error"));
            })
            .catch(() => {
              setError(t("members.management.error"));
            });
        } else {
          setError(t("members.management.error"));
        }
      })
      .finally(() => {
        setSavingEdit(false);
      });
  };

  const handleArchive = (id: string) => {
    authFetch(`/api/members/${id}/archive`, { method: "POST", credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`archive member: ${res.status}`);
        return res.json() as Promise<Member>;
      })
      .then(() => {
        refreshMembers();
        setArchivedLoaded(false);
      })
      .catch(() => {
        setError(t("members.management.error"));
      });
  };

  const handleRestore = (id: string) => {
    authFetch(`/api/members/${id}/restore`, { method: "POST", credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`restore member: ${res.status}`);
        return res.json() as Promise<Member>;
      })
      .then(() => {
        refreshArchivedMembers();
        refreshMembers();
      })
      .catch(() => {
        setError(t("members.management.error"));
      });
  };

  const handleTabChange = (newTab: "active" | "archived") => {
    setTab(newTab);
    if (newTab === "archived" && !archivedLoaded) {
      refreshArchivedMembers();
    }
  };

  const currentMembers = tab === "active" ? members : archivedMembers;

  return (
    <>
      <AdminPanel
        title={t("members.management.title")}
        className="w-full"
        actions={
          <Button data-testid="members-add-member" onClick={() => setCreateOpen(true)}>
            {t("members.create.title")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button
              onClick={() => handleTabChange("active")}
              variant={tab === "active" ? "default" : "outline"}
            >
              {t("members.tab.active")}
            </Button>
            <Button
              onClick={() => handleTabChange("archived")}
              variant={tab === "archived" ? "default" : "outline"}
            >
              {t("members.tab.archived")}
            </Button>
          </div>
          <Button
            onClick={tab === "active" ? refreshMembers : refreshArchivedMembers}
            disabled={loading}
            variant="outline"
          >
            {loading ? t("members.management.refreshing") : t("members.management.refresh")}
          </Button>
        </div>

        <ErrorNotice message={error} />

        {tab === "active" && members.length === 0 && !loading && (
          <p className="text-muted-foreground text-control">{t("members.management.noMembers")}</p>
        )}

        {tab === "archived" && archivedMembers.length === 0 && !loading && (
          <p className="text-muted-foreground text-control">
            {t("members.management.archived.noMembers")}
          </p>
        )}

        {currentMembers.length > 0 && (
          <ul
            data-testid="members-card-grid"
            className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3"
          >
            {currentMembers.map((member) => (
              <li
                key={member.id}
                data-testid={`member-card-${member.id}`}
                className="bg-card flex min-h-48 flex-col justify-between gap-5 rounded-3xl border border-[var(--member-color)] p-5 shadow-sm"
                // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
                style={
                  {
                    "--member-color": `var(--color-member-${member.colorKey}-500)`,
                  } as CSSProperties
                }
              >
                <div className="flex items-start gap-4">
                  <div
                    aria-hidden="true"
                    className="flex size-14 shrink-0 items-center justify-center rounded-full bg-[var(--member-color)] text-lg font-bold text-member-avatar-foreground shadow-sm"
                  >
                    {member.displayName.trim().slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-lg">{member.displayName}</strong>
                    <div className="mt-1 flex flex-wrap gap-2 text-sm">
                      <span className="rounded-full bg-background/80 px-2.5 py-1 font-medium">
                        {t(`members.create.${member.role}`)}
                      </span>
                      <span className="text-muted-foreground rounded-full border px-2.5 py-1">
                        {t(`members.lifecycle.${member.lifecycle}`)}
                      </span>
                    </div>
                    {member.birthDate && (
                      <p className="text-muted-foreground mt-3 text-sm">
                        {formatBirthDate(t, language, member.birthDate)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => startEditingMember(member)}>
                    {t("members.action.edit")}
                  </Button>
                  {tab === "active" ? (
                    <Button size="sm" variant="outline" onClick={() => handleArchive(member.id)}>
                      {t("members.action.archive")}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => handleRestore(member.id)}>
                      {t("members.action.restore")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </AdminPanel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto p-0 sm:max-w-xl"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("members.create.title")}</DialogTitle>
            <DialogDescription>{t("members.create.description")}</DialogDescription>
          </DialogHeader>
          <MemberCreateForm
            onSuccess={() => {
              setCreateOpen(false);
              refreshMembers();
            }}
          />
          <div className="flex justify-end px-4 pb-4">
            <DialogClose asChild>
              <Button variant="outline">{t("members.action.cancel")}</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingMember !== null}
        onOpenChange={(open) => {
          if (!open) cancelEditingMember();
        }}
      >
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>
              {t("members.action.edit")} {editingMember?.displayName}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("members.management.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-edit-display-name">{t("members.create.displayName")}</Label>
                <Input
                  id="member-edit-display-name"
                  type="text"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  placeholder={t("members.create.placeholder")}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-edit-role">{t("members.create.role")}</Label>
                <Select value={editRole} onValueChange={(val: Role) => setEditRole(val)}>
                  <SelectTrigger id="member-edit-role">
                    <SelectValue placeholder={t("members.create.selectRole")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={Role.parent}>{t("members.create.parent")}</SelectItem>
                    <SelectItem value={Role.child}>{t("members.create.child")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label id="member-edit-color-label">{t("members.color.label")}</Label>
              <div
                role="radiogroup"
                aria-labelledby="member-edit-color-label"
                data-testid="member-edit-color-palette"
                className="grid w-fit grid-cols-4 gap-3 sm:grid-cols-8"
              >
                {MEMBER_COLOR_KEYS.map((key) => {
                  const selected = editColorKey === key;
                  return (
                    <Button
                      variant="ghost"
                      size="icon"
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const index = MEMBER_COLOR_KEYS.indexOf(key);
                        const next =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? MEMBER_COLOR_KEYS.length - 1
                              : (index +
                                  (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
                                  MEMBER_COLOR_KEYS.length) %
                                MEMBER_COLOR_KEYS.length;
                        setEditColorKey(MEMBER_COLOR_KEYS[next]);
                        const radios =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]'
                          );
                        radios?.[next]?.focus();
                      }}
                      aria-label={t(MEMBER_COLOR_LABEL_KEYS[key])}
                      data-state={selected ? "checked" : "unchecked"}
                      disabled={savingEdit}
                      onClick={() => setEditColorKey(key)}
                      className="h-[var(--control-height)] w-[var(--control-height)] rounded-full border-4 border-background text-control shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:ring-2 data-[state=checked]:ring-[var(--member-color)] data-[state=checked]:ring-offset-2"
                      // eslint-disable-next-line ui-policy/debt -- Closed keys select generated semantic token custom properties only.
                      style={
                        {
                          "--member-color": `var(--color-member-${key}-500)`,
                          backgroundColor: `var(--color-member-${key}-500)`,
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </div>
            </div>

            <Label id="members-edit-birthdate-group-label">{t("members.birthdate.label")}</Label>
            <div
              role="group"
              aria-labelledby="members-edit-birthdate-group-label"
              className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto]"
            >
              <Select
                value={editMonth !== "" ? String(editMonth) : ""}
                onValueChange={(val: string) => setEditMonth(val === "" ? "" : Number(val))}
              >
                <SelectTrigger aria-label={t("members.birthdate.selectMonth")}>
                  <SelectValue placeholder={t("members.birthdate.selectMonth")} />
                </SelectTrigger>
                <SelectContent>
                  {BIRTH_MONTH_LABEL_KEYS.map((key, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>
                      {t(key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={editDay !== "" ? String(editDay) : ""}
                onValueChange={(val: string) => setEditDay(val === "" ? "" : Number(val))}
              >
                <SelectTrigger aria-label={t("members.birthdate.selectDay")}>
                  <SelectValue placeholder={t("members.birthdate.selectDay")} />
                </SelectTrigger>
                <SelectContent>
                  {BIRTH_DAY_LABEL_KEYS.map((key, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>
                      {t(key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                type="number"
                aria-label={t("members.birthdate.yearPlaceholder")}
                placeholder={t("members.birthdate.yearPlaceholder")}
                value={editYear}
                onChange={(e) => setEditYear(e.target.value)}
              />

              <Button type="button" variant="outline" size="sm" onClick={clearEditBirthdate}>
                {t("members.birthdate.clear")}
              </Button>
            </div>

            <ErrorNotice message={error} />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={cancelEditingMember}>
                {t("members.action.cancel")}
              </Button>
              <Button onClick={handleSaveEdit} disabled={savingEdit}>
                {savingEdit ? t("members.management.updating") : t("members.action.save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MembersManagement() {
  const { unlocked } = useAdminUnlock();

  if (!unlocked) {
    return (
      <div className="text-muted-foreground p-4 text-control">
        Admin unlock required to access member management.
      </div>
    );
  }

  return <MembersManagementContent />;
}
