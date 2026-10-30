/**
 * OpenClaw 2026.10 still exports `openclaw/plugin-sdk/channel-targets` at runtime but no
 * longer ships its .d.ts. Declare the two helpers this plugin uses.
 */
declare module "openclaw/plugin-sdk/channel-targets" {
  export function buildChannelKeyCandidates(
    ...keys: Array<string | undefined | null>
  ): string[];
  export function resolveChannelEntryMatchWithFallback<T>(params: {
    entries?: Record<string, T>;
    keys: string[];
    parentKeys?: string[];
    wildcardKey?: string;
    normalizeKey?: (value: string) => string;
  }): {
    entry?: T;
    key?: string;
    wildcardEntry?: T;
    wildcardKey?: string;
    parentEntry?: T;
    parentKey?: string;
    matchKey?: string;
    matchSource?: "direct" | "parent" | "wildcard";
  };
}
