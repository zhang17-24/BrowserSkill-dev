import type { MockRule } from "@/transport/types";

/**
 * URL-glob matching for mock rules.
 *
 * Kept free of any browser API so the semantics can be tested directly —
 * "which rule wins for this request" is the part that is expensive to get
 * wrong, because a wrong answer silently rewrites traffic.
 *
 * Glob semantics, deliberately small:
 *
 * - `*` matches any run of characters, **including `/`**. A rule written for
 *   `https://api.example.com/api/user/*` must match
 *   `https://api.example.com/api/user/42/posts`, so `*` cannot stop at a
 *   separator the way a pathname glob would.
 * - `?` matches exactly one character.
 * - Everything else is literal.
 * - Matching is case-sensitive and anchored to the whole URL, including the
 *   query string. Predictability beats convenience here: a rule that
 *   silently matches more than it looks like it does is worse than one that
 *   needs an extra `*`.
 */

/** How many compiled patterns to keep before evicting the oldest. */
const PATTERN_CACHE_LIMIT = 256;

const patternCache = new Map<string, RegExp>();

/**
 * Compile a rule glob into an anchored regular expression.
 *
 * Results are cached because a page under test can issue hundreds of
 * requests, and recompiling the same handful of patterns per request shows
 * up in a profile.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;

  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escapeRegExpChar(char);
    }
  }
  source += "$";

  const compiled = new RegExp(source);
  if (patternCache.size >= PATTERN_CACHE_LIMIT) {
    const oldest = patternCache.keys().next();
    if (!oldest.done) patternCache.delete(oldest.value);
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Clear the compiled-pattern cache. Test-only. */
export function resetPatternCache(): void {
  patternCache.clear();
}

/**
 * Does this rule apply to the request?
 *
 * A disabled rule never matches, whatever its pattern says. An absent
 * `method` matches every method; a present one is compared case-insensitively
 * against the request's method so a rule written as `get` still works.
 */
export function matchesRule(rule: MockRule, url: string, method: string): boolean {
  if (!rule.enabled) return false;
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  return globToRegExp(rule.url_pattern).test(url);
}

/**
 * Pick the rule that should answer this request.
 *
 * The **first** match in rule order wins, and that order is the one the user
 * sees on the rules page. Last-wins or best-match semantics would make the
 * page a lie about which rule is in effect.
 */
export function findMatchingRule(
  rules: readonly MockRule[],
  url: string,
  method: string,
): MockRule | null {
  for (const rule of rules) {
    if (matchesRule(rule, url, method)) return rule;
  }
  return null;
}
