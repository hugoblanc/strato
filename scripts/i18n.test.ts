import { afterEach, describe, expect, test } from "bun:test";
import { boardPage, gateLabel } from "./board.ts";
import { clientMessages, DICTIONARIES, locale, t } from "./core/i18n.ts";
import { resolveSettings, useSettings } from "./core/settings.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => useSettings(TEST_SETTINGS));

const withLocale = (l: unknown) => useSettings(resolveSettings({ ...TEST_SETTINGS, ui: { ...TEST_SETTINGS.ui, locale: l } }));

describe("dictionaries", () => {
  test("en and fr have exactly the same keys", () => {
    expect(Object.keys(DICTIONARIES.fr).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });
  test("no empty text, no em dash", () => {
    for (const dict of Object.values(DICTIONARIES))
      for (const [k, v] of Object.entries(dict)) {
        expect(v.trim(), k).not.toBe("");
        expect(v, k).not.toContain("—");
      }
  });
  test("both dictionaries use the same variables for a key", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(DICTIONARIES.en)) expect(vars(DICTIONARIES.fr[k as keyof typeof DICTIONARIES.fr]), k).toEqual(vars(v));
  });
});

describe("t", () => {
  test("English by default, French on ui.locale fr, English for an unknown locale", () => {
    useSettings(resolveSettings({}));
    expect(locale()).toBe("en");
    expect(t("board.header.refresh")).toBe("Refresh");
    withLocale("fr");
    expect(t("board.header.refresh")).toBe("Rafraîchir");
    withLocale("de");
    expect(locale()).toBe("en");
  });
  test("variables are replaced; an unknown one stays visible", () => {
    withLocale("en");
    expect(t("board.gate.other", { gate: "ticket" })).toBe("gate ticket");
    expect(t("board.gate.other")).toBe("gate {gate}");
    expect(gateLabel("draft")).toBe("review the draft");
  });
  test("only board.js.* strings are shipped to the page", () => {
    withLocale("fr");
    expect(Object.keys(clientMessages()).every((k) => k.startsWith("board.js."))).toBe(true);
    expect(clientMessages()["board.js.theme.auto"]).toBe("thème auto");
  });
});

describe("board page", () => {
  const scriptOf = (page: string) => {
    const all = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    return all[all.length - 1];
  };
  test("English header and lang on the default locale, French with fr", () => {
    withLocale("en");
    const en = boardPage("");
    expect(en).toContain('<html lang="en">');
    expect(en).toContain(">Refresh</button>");
    expect(en).toContain("<title>Strato</title>");
    withLocale("fr");
    const fr = boardPage("");
    expect(fr).toContain('<html lang="fr">');
    expect(fr).toContain(">Rafraîchir</button>");
  });
  test("the client script parses, and the strings script too", () => {
    withLocale("fr");
    const page = boardPage("");
    const transpiler = new Bun.Transpiler({ loader: "js" });
    expect(() => transpiler.transformSync(scriptOf(page))).not.toThrow();
    const strings = page.match(/<script>(window\.STRATO_I18N = [\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(strings).toContain("thème auto");
    expect(() => transpiler.transformSync(strings)).not.toThrow();
  });
});
