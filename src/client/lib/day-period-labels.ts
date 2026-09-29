import type { PeriodId } from "../../shared";
import type { MessageKey } from "@/i18n/messages";

export const DAY_PERIOD_LABEL_KEYS: Record<PeriodId, MessageKey> = {
  morning: "dayPeriod.morning",
  afternoon: "dayPeriod.afternoon",
  evening: "dayPeriod.evening",
  night: "dayPeriod.night",
};
