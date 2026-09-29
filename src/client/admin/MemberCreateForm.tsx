import { useState, type ChangeEvent, type FormEvent } from "react";
import { useAdminUnlock } from "@/lib/adminUnlock";
import { authFetch } from "@/lib/credential";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MEMBER_COLOR_KEYS,
  Role,
  type CreateMemberRequest,
  type Error as ApiError,
  type MemberColorKey,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useT } from "@/i18n";

/* ------------------------------------------------------------------ */
/* MemberCreateForm — member identity fields, POSTs to /api/members */
/* Uses AdminPanel and shared density-token controls. The colour */
/* selector uses generated member-colour tokens and server-owned */
/* automatic assignment. */
/* ------------------------------------------------------------------ */

/** SC-007: the same typed month/day lookup MembersManagement.tsx uses, replacing the previous
 * `("members.birthdate.months." + String(i + 1)) as any` cast. See that file's own comment for
 * the full rationale — duplicated here rather than shared because these two files intentionally
 * have no third module between them (a two-user-only shared helper is not worth the indirection). */
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

interface MemberCreateFormProps {
  /** Called when creation succeeds (201). Form is cleared afterwards. */
  onSuccess?: () => void;
}

export function MemberCreateForm({ onSuccess }: MemberCreateFormProps) {
  const { unlocked } = useAdminUnlock();
  const t = useT();

  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [month, setMonth] = useState<number | "">("");
  const [day, setDay] = useState<number | "">("");
  const [year, setYear] = useState<string>("");
  const [colorKey, setColorKey] = useState<MemberColorKey | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"success" | "error" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const clearBirthdate = () => {
    setMonth("");
    setDay("");
    setYear("");
  };

  const isFormValid = displayName.trim().length > 0 && role !== "";

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isFormValid || submitting) return;

    setSubmitting(true);
    setStatus(null);
    setStatusMessage("");

    const body: CreateMemberRequest = {
      displayName: displayName.trim(),
      role: role as Role,
    };
    if (colorKey) body.colorKey = colorKey;

    const anySet = month !== "" || day !== "" || year.trim() !== "";
    const bothMonthDay = month !== "" && day !== "";
    if (anySet && !bothMonthDay) {
      setStatus("error");
      setStatusMessage(t("members.birthdate.errorPartial"));
      setSubmitting(false);
      return;
    }

    if (bothMonthDay) {
      const birthDate = {
        month: Number(month),
        day: Number(day),
        year: year.trim() ? parseInt(year, 10) : null,
      };
      if (
        birthDate.year !== null &&
        (isNaN(birthDate.year) ||
          birthDate.year < 1900 ||
          birthDate.year > new Date().getFullYear())
      ) {
        setStatus("error");
        setStatusMessage(t("members.birthdate.errorInvalidYear"));
        setSubmitting(false);
        return;
      }
      body.birthDate = birthDate;
    }

    authFetch("/api/members", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.status === 201) {
          setStatus("success");
          setStatusMessage(t("members.create.success"));
          setDisplayName("");
          setRole("");
          setMonth("");
          setDay("");
          setYear("");
          setColorKey(undefined);
          onSuccess?.();
          return;
        }
        if (res.status === 401) {
          setStatus("error");
          setStatusMessage(t("members.create.errorAuth"));
          return;
        }
        if (!res.ok) throw new Error(`POST /api/members: ${res.status}`);
        return res.json() as Promise<ApiError>;
      })
      .then((data) => {
        if (data && typeof data === "object" && "error" in data) {
          setStatus("error");
          setStatusMessage(
            (data as ApiError).message ||
              (data as ApiError).error ||
              t("members.create.errorGeneric")
          );
        }
      })
      .catch((err: ApiError | Error) => {
        const apiErr = err as ApiError;
        setStatus("error");
        setStatusMessage(apiErr?.message || apiErr?.error || t("members.create.errorGeneric"));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  /* -- gate: only render when admin is unlocked ------------------ */

  if (!unlocked) return null;

  return (
    <AdminPanel
      title={t("members.create.title")}
      description={t("members.create.description")}
      className="w-full max-w-[400px]"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="member-display-name">{t("members.create.displayName")}</Label>
          <Input
            id="member-display-name"
            type="text"
            autoComplete="off"
            value={displayName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)}
            placeholder={t("members.create.placeholder")}
            aria-invalid={status === "error"}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="member-role">{t("members.create.role")}</Label>
          <Select value={role} onValueChange={(val: Role) => setRole(val)} disabled={submitting}>
            <SelectTrigger id="member-role" aria-invalid={status === "error"}>
              <SelectValue placeholder={t("members.create.selectRole")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={Role.parent}>{t("members.create.parent")}</SelectItem>
              <SelectItem value={Role.child}>{t("members.create.child")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="member-color">{t("members.color.label")}</Label>
          <Select
            value={colorKey ?? "automatic"}
            onValueChange={(value: MemberColorKey | "automatic") =>
              setColorKey(value === "automatic" ? undefined : value)
            }
            disabled={submitting}
          >
            <SelectTrigger id="member-color">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="automatic">{t("members.color.automatic")}</SelectItem>
              {MEMBER_COLOR_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-full"
                    // eslint-disable-next-line no-restricted-syntax -- Closed keys select generated token custom properties only.
                    style={{
                      backgroundColor: `var(--color-member-${key}-500)`,
                      color: `var(--color-member-${key}-foreground)`,
                    }}
                  />
                  {t(MEMBER_COLOR_LABEL_KEYS[key])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          {/* This uses the shared control component instead of a raw `<span>` hand-copying
 `Label`'s own class string (`text-sm leading-none font-medium`, see
 `components/ui/label.tsx`) instead of importing it — the exact anti-pattern the
 recipe registry (`docs/development/style-guide.md`) exists to end for a class
 STRING; the same duplication risk applies to a component's classes copied by hand.
 `Label` renders fine with no `htmlFor` when it's referenced purely as a group
 caption via `aria-labelledby` rather than a single-control association. */}
          <Label id="member-birthdate-group-label">{t("members.birthdate.label")}</Label>
          <div
            role="group"
            aria-labelledby="member-birthdate-group-label"
            className="flex gap-2 items-center flex-wrap"
          >
            <Select
              value={month !== "" ? String(month) : ""}
              onValueChange={(val: string) => setMonth(val === "" ? "" : Number(val))}
              disabled={submitting}
            >
              <SelectTrigger aria-label={t("members.birthdate.selectMonth")} className="flex-1">
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
              value={day !== "" ? String(day) : ""}
              onValueChange={(val: string) => setDay(val === "" ? "" : Number(val))}
              disabled={submitting}
            >
              <SelectTrigger aria-label={t("members.birthdate.selectDay")} className="flex-1">
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
              value={year}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setYear(e.target.value)}
              disabled={submitting}
              className="flex-1 max-w-24"
            />

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearBirthdate}
              disabled={!month && !day && !year}
            >
              {t("members.birthdate.clear")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {status === "error" && <ErrorNotice message={statusMessage} />}
          {status === "success" && (
            <p
              data-testid="member-create-success"
              role="status"
              aria-live="polite"
              className="text-primary text-[length:var(--control-font-size)]"
            >
              {statusMessage}
            </p>
          )}
          <Button type="submit" disabled={submitting || !isFormValid}>
            {submitting ? t("members.create.creating") : t("members.create.title")}
          </Button>
        </div>
      </form>
    </AdminPanel>
  );
}
