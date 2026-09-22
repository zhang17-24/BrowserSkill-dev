import { i18n } from "@browser-skill/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HitCount } from "../hit-count";

/**
 * The wording is the payload here, so it is what the test pins: a rule stuck at
 * zero should read as a diagnosis ("never fired") rather than as a number, and
 * the last-fired time belongs in the tooltip so a rule that *stopped* firing is
 * distinguishable from one that never started.
 *
 * Keys are written out rather than passed through a helper: `i18n.t` is typed
 * against the catalogue's literal key union, so a `string` parameter would not
 * compile — and losing that check is how a typo'd key ships.
 */

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
});

describe("HitCount", () => {
  it("says a rule has never fired rather than showing a zero", () => {
    render(<HitCount hits={undefined} />);
    expect(screen.getByText(i18n.t("mock.neverHit", { ns: "extension" }))).toBeTruthy();
  });

  it("reports the count and keeps the last-fired time in the tooltip", () => {
    const lastAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    render(<HitCount hits={{ count: 3, lastAt }} />);

    const node = screen.getByText(i18n.t("mock.hitCount", { count: 3, ns: "extension" }));
    expect(node.getAttribute("title")).toBe(new Date(lastAt).toLocaleString());
  });

  it("omits the tooltip when there is nothing to report", () => {
    render(<HitCount hits={undefined} />);
    const node = screen.getByText(i18n.t("mock.neverHit", { ns: "extension" }));
    expect(node.getAttribute("title")).toBeNull();
  });
});
