export function normalizeCallFailureReason(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function isVerifiedNoAnswer(value: unknown): boolean {
  return normalizeCallFailureReason(value) === "no-answer";
}
