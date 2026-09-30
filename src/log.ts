// Cloud Logging lifts severity and jsonPayload out of one JSON line on stdout. event_name is the
// key Kamai's other services use, so queries join across them.
export function logEvent(eventName: string, data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ severity: "INFO", event_name: eventName, event_data: data }) + "\n");
}
