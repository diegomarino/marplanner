export interface TimeZoneOption {
  value: string;
  label: string;
}
export type TimeZoneGroupId =
  "current" | "utc" | "europe" | "americas" | "asiaPacific" | "africaMiddleEast";
export interface TimeZoneGroup {
  id: TimeZoneGroupId;
  options: TimeZoneOption[];
}

/** Zones the household picker offers, with friendly labels (place names are not translated). */
const CURATED: TimeZoneGroup[] = [
  { id: "utc", options: [{ value: "UTC", label: "UTC" }] },
  {
    id: "europe",
    options: [
      { value: "Europe/London", label: "London (GMT/BST)" },
      { value: "Europe/Madrid", label: "Madrid (CET/CEST)" },
      { value: "Europe/Paris", label: "Paris (CET/CEST)" },
      { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
      { value: "Europe/Rome", label: "Rome (CET/CEST)" },
      { value: "Europe/Amsterdam", label: "Amsterdam (CET/CEST)" },
      { value: "Europe/Brussels", label: "Brussels (CET/CEST)" },
      { value: "Europe/Lisbon", label: "Lisbon (WET/WEST)" },
      { value: "Europe/Helsinki", label: "Helsinki (EET/EEST)" },
      { value: "Europe/Athens", label: "Athens (EET/EEST)" },
      { value: "Europe/Moscow", label: "Moscow (MSK)" },
      { value: "Europe/Istanbul", label: "Istanbul (TRT)" },
    ],
  },
  {
    id: "americas",
    options: [
      { value: "America/New_York", label: "New York (EST/EDT)" },
      { value: "America/Chicago", label: "Chicago (CST/CDT)" },
      { value: "America/Denver", label: "Denver (MST/MDT)" },
      { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
      { value: "America/Anchorage", label: "Anchorage (AKST/AKDT)" },
      { value: "Pacific/Honolulu", label: "Honolulu (HST)" },
      { value: "America/Sao_Paulo", label: "Sao Paulo (BRT)" },
      { value: "America/Argentina/Buenos_Aires", label: "Buenos Aires (ART)" },
      { value: "America/Mexico_City", label: "Mexico City (CST/CDT)" },
      { value: "America/Bogota", label: "Bogota (COT)" },
      { value: "America/Toronto", label: "Toronto (EST/EDT)" },
    ],
  },
  {
    id: "asiaPacific",
    options: [
      { value: "Asia/Tokyo", label: "Tokyo (JST)" },
      { value: "Asia/Shanghai", label: "Shanghai (CST)" },
      { value: "Asia/Hong_Kong", label: "Hong Kong (HKT)" },
      { value: "Asia/Singapore", label: "Singapore (SGT)" },
      { value: "Asia/Kolkata", label: "Kolkata (IST)" },
      { value: "Asia/Dubai", label: "Dubai (GST)" },
      { value: "Asia/Bangkok", label: "Bangkok (ICT)" },
      { value: "Asia/Seoul", label: "Seoul (KST)" },
      { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
      { value: "Pacific/Auckland", label: "Auckland (NZST/NZDT)" },
    ],
  },
  {
    id: "africaMiddleEast",
    options: [
      { value: "Africa/Cairo", label: "Cairo (EET)" },
      { value: "Africa/Johannesburg", label: "Johannesburg (SAST)" },
      { value: "Africa/Lagos", label: "Lagos (WAT)" },
      { value: "Africa/Nairobi", label: "Nairobi (EAT)" },
    ],
  },
];

/**
 * The groups to render. A stored zone outside the curated list is offered in a leading
 * "current" group, so opening the page and saving never swaps it for something else.
 */
export function timeZoneGroups(current: string): TimeZoneGroup[] {
  const listed = CURATED.some((group) => group.options.some((option) => option.value === current));
  if (listed || current.trim() === "") return CURATED;
  return [
    { id: "current", options: [{ value: current, label: current.replaceAll("_", " ") }] },
    ...CURATED,
  ];
}
