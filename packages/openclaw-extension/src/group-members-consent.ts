export function hasExplicitGroupMemberConsent(params: Record<string, unknown>): boolean {
  return params.confirmed === true;
}
