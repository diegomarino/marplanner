/** Wake the shared executor after a local action can enqueue print work. */
export const PRINT_INTENT_ENQUEUED_EVENT = "marplanner:print-intent-enqueued";

export function notifyPrintIntentEnqueued(): void {
  window.dispatchEvent(new Event(PRINT_INTENT_ENQUEUED_EVENT));
}
