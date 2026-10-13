import { useEffect, useState, type CSSProperties } from "react";
import { Archive, ArchiveRestore, Plus } from "lucide-react";
import { useAdminUnlock } from "@/lib/adminUnlock";
import { cn } from "@/lib/utils";
import { authFetch } from "@/lib/credential";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
  teal: "members.color.teal",
  green: "members.color.green",
  lime: "members.color.lime",
  amber: "members.color.amber",
  orange: "members.color.orange",
  red: "members.color.red",
  pink: "members.color.pink",
  violet: "members.color.violet",
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

type MemberFormMode =
  | { kind: "create" }
  | { kind: "edit"; member: Member }
  // An archived member is shown, not edited: the only action is restoring it.
  | { kind: "archived"; member: Member };

const COLOR_NAVIGATION_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

function MembersManagementContent() {
  const { t, language } = useTranslation();

  const [tab, setTab] = useState<"active" | "archived">("active");
  const [members, setMembers] = useState<Member[]>([]);
  const [archivedMembers, setArchivedMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedLoaded, setArchivedLoaded] = useState(false);

  const [form, setForm] = useState<MemberFormMode | null>(null);
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState<Role | "">("");
  const [formMonth, setFormMonth] = useState<number | "">("");
  const [formDay, setFormDay] = useState<number | "">("");
  const [formYear, setFormYear] = useState<string>("");
  const [formColorKey, setFormColorKey] = useState<MemberColorKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "restore" | null>(null);

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

  const openForm = (mode: MemberFormMode) => {
    const member = mode.kind === "create" ? null : mode.member;
    setForm(mode);
    setFormName(member?.displayName ?? "");
    setFormRole(member?.role ?? "");
    setFormColorKey(member?.colorKey ?? null);
    setFormMonth(member?.birthDate?.month ?? "");
    setFormDay(member?.birthDate?.day ?? "");
    setFormYear(
      member?.birthDate?.year !== null && member?.birthDate?.year !== undefined
        ? String(member.birthDate.year)
        : ""
    );
    setFormError(null);
  };

  const closeForm = () => {
    setForm(null);
    setConfirming(null);
    setFormError(null);
  };

  const clearBirthdate = () => {
    setFormMonth("");
    setFormDay("");
    setFormYear("");
  };

  const readOnly = form?.kind === "archived";
  const formValid = formName.trim().length > 0 && formRole !== "";
  // A colour identifies one active member. Archived members hold no colour, matching the
  // server's own first-unused assignment.
  const takenColors = new Set(
    members
      .filter((member) => form?.kind === "create" || member.id !== form?.member.id)
      .map((member) => member.colorKey)
  );
  const unusedColors = MEMBER_COLOR_KEYS.filter((key) => !takenColors.has(key));
  // With every colour in use a repeat is unavoidable, so the whole palette opens up again.
  const freeColors = unusedColors.length > 0 ? unusedColors : [...MEMBER_COLOR_KEYS];

  const handleSave = () => {
    if (!form || form.kind === "archived" || !formValid || saving) return;
    setFormError(null);

    const anySet = formMonth !== "" || formDay !== "" || formYear.trim() !== "";
    const bothMonthDay = formMonth !== "" && formDay !== "";
    if (anySet && !bothMonthDay) {
      setFormError(t("members.birthdate.errorPartial"));
      return;
    }
    let birthDate: { month: number; day: number; year: number | null } | null = null;
    if (bothMonthDay) {
      birthDate = {
        month: Number(formMonth),
        day: Number(formDay),
        year: formYear.trim() ? parseInt(formYear, 10) : null,
      };
      if (
        birthDate.year !== null &&
        (isNaN(birthDate.year) ||
          birthDate.year < 1900 ||
          birthDate.year > new Date().getFullYear())
      ) {
        setFormError(t("members.birthdate.errorInvalidYear"));
        return;
      }
    }

    const creating = form.kind === "create";
    const body: Record<string, unknown> = { displayName: formName.trim(), role: formRole };
    if (formColorKey) body.colorKey = formColorKey;
    // Creating omits an unset birthday; editing sends null so a cleared one is removed.
    if (birthDate || !creating) body.birthDate = birthDate;

    setSaving(true);
    authFetch(creating ? "/api/members" : `/api/members/${form.member.id}`, {
      method: creating ? "POST" : "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (res.ok) {
          closeForm();
          refreshMembers();
          return;
        }
        const fallback =
          res.status === 401
            ? t("members.create.errorAuth")
            : creating
              ? t("members.create.errorGeneric")
              : t("members.management.saveError");
        const data = (await res.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        setFormError(res.status === 401 ? fallback : data?.message || data?.error || fallback);
      })
      .catch(() => {
        setFormError(
          creating ? t("members.create.errorGeneric") : t("members.management.saveError")
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const changeLifecycle = (action: "archive" | "restore") => {
    if (!form || form.kind === "create") return;
    setSaving(true);
    authFetch(`/api/members/${form.member.id}/${action}`, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${action} member: ${res.status}`);
        closeForm();
        refreshMembers();
        if (action === "restore") refreshArchivedMembers();
        else setArchivedLoaded(false);
      })
      .catch(() => {
        setConfirming(null);
        setFormError(t("members.management.lifecycleError"));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const handleTabChange = (newTab: "active" | "archived") => {
    setTab(newTab);
    if (newTab === "archived" && !archivedLoaded) {
      refreshArchivedMembers();
    }
  };

  const currentMembers = tab === "active" ? members : archivedMembers;
  const formMember = form && form.kind !== "create" ? form.member : null;

  return (
    <>
      <AdminPanel
        title={t("members.management.title")}
        className="w-full p-0"
        actions={
          <>
            <div
              role="group"
              aria-label={t("members.tab.label")}
              className="border-input flex overflow-hidden rounded-lg border"
            >
              {(["active", "archived"] as const).map((option) => (
                <Button
                  key={option}
                  variant="ghost"
                  type="button"
                  aria-pressed={tab === option}
                  data-testid={`members-tab-${option}`}
                  onClick={() => handleTabChange(option)}
                  className={cn(
                    "rounded-none px-4 font-medium",
                    tab === option
                      ? "bg-accent text-accent-foreground"
                      : "bg-background text-muted-foreground hover:bg-primary/10 hover:text-foreground"
                  )}
                >
                  {t(`members.tab.${option}`)}
                </Button>
              ))}
            </div>
            <Button data-testid="members-add-member" onClick={() => openForm({ kind: "create" })}>
              <Plus aria-hidden="true" />
              {t("members.create.new")}
            </Button>
          </>
        }
      >
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
              <li key={member.id}>
                {/* eslint-disable-next-line ui-policy/raw-controls -- The whole card is the control: a multi-line surface the token-sized Button cannot wrap. */}
                <button
                  type="button"
                  data-testid={`member-card-${member.id}`}
                  onClick={() => openForm({ kind: tab === "active" ? "edit" : "archived", member })}
                  className="bg-card hover:bg-primary/5 focus-visible:ring-ring/50 text-control flex min-h-[var(--control-height)] w-full cursor-pointer flex-col items-start gap-3 rounded-3xl border p-5 text-left shadow-sm outline-none focus-visible:ring-[3px]"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-member-avatar-foreground max-w-full truncate rounded-full bg-[var(--member-color)] px-4 py-1 text-lg font-bold shadow-sm"
                      // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
                      style={
                        {
                          "--member-color": `var(--color-member-${member.colorKey}-500)`,
                        } as CSSProperties
                      }
                    >
                      {member.displayName}
                    </span>
                    <span className="bg-muted rounded-full px-2.5 py-1 text-sm font-medium">
                      {t(`members.create.${member.role}`)}
                    </span>
                  </span>
                  {member.birthDate && (
                    <span className="text-muted-foreground text-sm">
                      {formatBirthDate(t, language, member.birthDate)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </AdminPanel>

      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !saving) closeForm();
        }}
      >
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
          closeLabel={t("members.action.cancel")}
          data-testid="member-form-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {form?.kind === "create"
                ? t("members.create.title")
                : form?.kind === "archived"
                  ? formMember?.displayName
                  : `${t("members.action.edit")} ${formMember?.displayName ?? ""}`}
            </DialogTitle>
            <DialogDescription className={form?.kind === "create" ? undefined : "sr-only"}>
              {form?.kind === "archived"
                ? t("members.management.archivedHint")
                : t("members.create.description")}
            </DialogDescription>
          </DialogHeader>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >
            {readOnly && (
              <p className="text-muted-foreground text-control">
                {t("members.management.archivedHint")}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-edit-display-name">{t("members.create.displayName")}</Label>
                <Input
                  id="member-edit-display-name"
                  type="text"
                  value={formName}
                  disabled={readOnly}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t("members.create.placeholder")}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="member-edit-role">{t("members.create.role")}</Label>
                <Select
                  value={formRole}
                  disabled={readOnly}
                  onValueChange={(val: Role) => setFormRole(val)}
                >
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
                className="grid w-fit grid-cols-5 gap-3"
              >
                {MEMBER_COLOR_KEYS.map((key) => {
                  const selected = formColorKey === key;
                  const taken = unusedColors.length > 0 && takenColors.has(key);
                  // One tab stop for the group: the chosen colour, else the first free one.
                  const tabStop = formColorKey ? selected : key === freeColors[0];
                  return (
                    <Button
                      variant="ghost"
                      size="icon"
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={tabStop ? 0 : -1}
                      onKeyDown={(event) => {
                        if (!COLOR_NAVIGATION_KEYS.includes(event.key)) return;
                        event.preventDefault();
                        if (freeColors.length === 0) return;
                        // Arrow keys move among the colours still free; taken ones are skipped.
                        const index = freeColors.indexOf(key);
                        const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
                        const next =
                          event.key === "Home"
                            ? freeColors[0]
                            : event.key === "End"
                              ? freeColors[freeColors.length - 1]
                              : freeColors[(index + step + freeColors.length) % freeColors.length];
                        setFormColorKey(next);
                        event.currentTarget.parentElement
                          ?.querySelector<HTMLButtonElement>(`[data-color-key="${next}"]`)
                          ?.focus();
                      }}
                      aria-label={
                        taken
                          ? `${t(MEMBER_COLOR_LABEL_KEYS[key])} — ${t("members.color.taken")}`
                          : t(MEMBER_COLOR_LABEL_KEYS[key])
                      }
                      title={taken ? t("members.color.taken") : undefined}
                      data-color-key={key}
                      data-state={selected ? "checked" : "unchecked"}
                      disabled={saving || readOnly || taken}
                      onClick={() => setFormColorKey(key)}
                      className="h-[var(--control-height)] w-[var(--control-height)] rounded-full border-4 border-background text-control shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-25 data-[state=checked]:opacity-100 data-[state=checked]:ring-2 data-[state=checked]:ring-[var(--member-color)] data-[state=checked]:ring-offset-2"
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
              {form?.kind === "create" && !formColorKey && (
                <p className="text-muted-foreground text-sm">{t("members.color.automatic")}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label id="members-edit-birthdate-group-label">{t("members.birthdate.label")}</Label>
              <div
                role="group"
                aria-labelledby="members-edit-birthdate-group-label"
                className="flex flex-wrap items-center gap-2"
              >
                <Select
                  value={formMonth !== "" ? String(formMonth) : ""}
                  disabled={readOnly}
                  onValueChange={(val: string) => setFormMonth(val === "" ? "" : Number(val))}
                >
                  <SelectTrigger className="w-40" aria-label={t("members.birthdate.selectMonth")}>
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
                  value={formDay !== "" ? String(formDay) : ""}
                  disabled={readOnly}
                  onValueChange={(val: string) => setFormDay(val === "" ? "" : Number(val))}
                >
                  <SelectTrigger className="w-24" aria-label={t("members.birthdate.selectDay")}>
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
                  className="w-24"
                  aria-label={t("members.birthdate.yearPlaceholder")}
                  placeholder={t("members.birthdate.yearPlaceholder")}
                  value={formYear}
                  disabled={readOnly}
                  onChange={(e) => setFormYear(e.target.value)}
                />

                {!readOnly && (
                  <Button type="button" variant="ghost" size="sm" onClick={clearBirthdate}>
                    {t("members.birthdate.clear")}
                  </Button>
                )}
              </div>
            </div>

            <ErrorNotice message={formError} />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {form?.kind === "edit" && (
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="member-archive"
                    disabled={saving}
                    onClick={() => setConfirming("archive")}
                  >
                    <Archive aria-hidden="true" />
                    {t("members.action.archive")}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={closeForm} disabled={saving}>
                  {t("members.action.cancel")}
                </Button>
                {form?.kind === "archived" ? (
                  <Button
                    type="button"
                    data-testid="member-restore"
                    disabled={saving}
                    onClick={() => setConfirming("restore")}
                  >
                    <ArchiveRestore aria-hidden="true" />
                    {t("members.action.restore")}
                  </Button>
                ) : (
                  <Button type="submit" data-testid="member-save" disabled={saving || !formValid}>
                    {form?.kind === "create"
                      ? saving
                        ? t("members.create.creating")
                        : t("members.create.submit")
                      : saving
                        ? t("members.management.updating")
                        : t("members.action.save")}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={
          confirming === "restore"
            ? t("members.confirm.restoreTitle")
            : t("members.confirm.archiveTitle")
        }
        description={`${formMember?.displayName ?? ""} — ${
          confirming === "restore"
            ? t("members.confirm.restoreDescription")
            : t("members.confirm.archiveDescription")
        }`}
        confirmLabel={
          confirming === "restore" ? t("members.action.restore") : t("members.action.archive")
        }
        cancelLabel={t("members.action.cancel")}
        confirmTestId="member-lifecycle-confirm"
        onConfirm={() => {
          if (confirming) changeLifecycle(confirming);
        }}
      />
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
