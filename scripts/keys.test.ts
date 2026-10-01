/**
 * The key grammar (core/keys.ts, docs/design/providers.md section 5): legacy keys read as before, qualified keys
 * round-trip, native ids are escaped so that a key survives any shell, long ids are hashed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  canonicalKey,
  escapeNative,
  formatKey,
  isDefaultSlackKey,
  KEY_MAX,
  longNativeId,
  parseKey,
  permalinkOfKey,
  providerKeyLabel,
  reportFile,
  resolveSettings,
  sujetKey,
  threadOfKey,
  unescapeNative,
  useSettings,
} from "./lib.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => useSettings(TEST_SETTINGS));

describe("legacy keys", () => {
  test("a bare Slack key is Slack on the default account, its native id the key itself", () => {
    expect(parseKey("C0ACME0001:1759219200.000100")).toEqual({ provider: "slack", account: "default", native: "C0ACME0001:1759219200.000100", legacy: true, long: false });
    // the loose shapes stored by older code and used across the tests read as Slack too
    expect(parseKey("CX:1")).toMatchObject({ provider: "slack", account: "default", legacy: true });
    expect(parseKey("D0ACME0001:1759219200.000100")?.provider).toBe("slack");
  });

  test("a linear: key is Linear on the default account", () => {
    expect(parseKey("linear:ENG-12")).toEqual({ provider: "linear", account: "default", native: "ENG-12", legacy: false, long: false });
  });

  test("the canonical form of every key on disk today is its stored form", () => {
    for (const k of ["C0ACME0001:1759219200.000100", "CX:1", "linear:ENG-12", "linear:OPS-262", "D0ACME0002:1759219200.000300"]) expect(canonicalKey(k)).toBe(k);
  });

  test("a new item of the default Slack account keeps producing the bare key, byte for byte", () => {
    expect(formatKey("slack", "default", "C0ACME0001:1759219200.000100")).toBe("C0ACME0001:1759219200.000100");
    expect(canonicalKey("slack:C0ACME0001:1759219200.000100")).toBe("C0ACME0001:1759219200.000100");
    expect(canonicalKey("slack@default:C0ACME0001:1759219200.000100")).toBe("C0ACME0001:1759219200.000100");
  });

  test("threadOfKey keeps its result on the default Slack account, and is null for any other key", () => {
    expect(threadOfKey("C0ACME0001:1759219200.000100")).toEqual({ channel: "C0ACME0001", ts: "1759219200.000100" });
    expect(threadOfKey("CX:1")).toEqual({ channel: "CX", ts: "1" });
    expect(threadOfKey("linear:ENG-12")).toBeNull();
    expect(threadOfKey("slack@partners:C0ACME0002:1759219200.000300")).toBeNull();
    expect(threadOfKey("fake:T-1")).toBeNull();
    expect(threadOfKey("nothing")).toBeNull();
    expect(isDefaultSlackKey("slack:C0ACME0001:1759219200.000100")).toBe(true);
    expect(isDefaultSlackKey("slack@partners:C0ACME0002:1759219200.000300")).toBe(false);
  });
});

describe("qualified keys", () => {
  test("provider, account and native round-trip, the default account never written", () => {
    expect(formatKey("slack", "partners", "C0ACME0002:1759219200.000300")).toBe("slack@partners:C0ACME0002:1759219200.000300");
    expect(parseKey("slack@partners:C0ACME0002:1759219200.000300")).toEqual({ provider: "slack", account: "partners", native: "C0ACME0002:1759219200.000300", legacy: false, long: false });
    expect(formatKey("linear", "default", "ENG-12")).toBe("linear:ENG-12");
    expect(formatKey("mail", "work", "<q3f9@mail.example>")).toBe("mail@work:%3Cq3f9@mail.example%3E");
    expect(parseKey("mail@work:%3Cq3f9@mail.example%3E")?.native).toBe("<q3f9@mail.example>");
  });

  test("bad names and unmappable native ids are refused", () => {
    expect(formatKey("Slack", "default", "x")).toBeNull();
    expect(formatKey("s", "default", "x")).toBeNull();
    expect(formatKey("mail", "Work", "x")).toBeNull();
    expect(formatKey("mail", "work", "")).toBeNull();
    expect(formatKey("mail", "work", "x".repeat(64 * 1024 + 1))).toBeNull();
    expect(parseKey("mail@work:%3c")).toBeNull();
    expect(parseKey("mail@work:a b")).toBeNull();
    expect(parseKey("nothing")).toBeNull();
  });

  test("escaping: the key alphabet stays, everything else is percent-encoded UTF-8, % included", () => {
    expect(escapeNative("a.b_c:d/e+f=g@h,i-j")).toBe("a.b_c:d/e+f=g@h,i-j");
    expect(escapeNative("100% sûr ~x")).toBe("100%25%20s%C3%BBr%20%7Ex");
    expect(escapeNative("<$(id)@x>")).toBe("%3C%24%28id%29@x%3E");
    expect(unescapeNative("100%25%20s%C3%BBr%20%7Ex")).toBe("100% sûr ~x");
    expect(unescapeNative("%E2%28")).toBeNull();
  });

  test("a native id too long for a key is replaced by its %h hash, and its key stays parseable", () => {
    const native = `<${"x".repeat(300)}@mail.example>`;
    const key = formatKey("mail", "work", native) as string;
    expect(key).toBe(`mail@work:${longNativeId(native)}`);
    expect(key.length).toBeLessThanOrEqual(KEY_MAX);
    expect(key).toMatch(/^mail@work:%h[a-z2-7]{26}$/);
    expect(parseKey(key)).toMatchObject({ provider: "mail", account: "work", native: longNativeId(native), long: true });
    expect(canonicalKey(key)).toBe(key);
    // `%h` cannot come out of percent-encoding: a native id starting with "h_" or "%h" stays distinct
    expect(formatKey("mail", "work", "%habc")).toBe("mail@work:%25habc");
    expect(longNativeId(native)).not.toBe(longNativeId(`${native}.`));
  });
});

describe("keys in a shell", () => {
  const shapes = [
    "C0ACME0001:1759219200.000100",
    "CX:1",
    "linear:ENG-12",
    formatKey("slack", "partners", "C0ACME0002:1759219200.000300") as string,
    formatKey("mail", "work", "<q3f9@mail.example>") as string,
    formatKey("mail", "work", "<$(id)@x> `rm -rf ~` ; & | * ? [a] {b,c} ~user !x #y 'q' \"d\"") as string,
    formatKey("tickets", "default", "~ABC") as string,
    formatKey("mail", "work", `<${"x".repeat(300)}@mail.example>`) as string,
  ];
  const script = shapes.map((k) => `printf '%s\\n' ${k} to=${k}`).join("\n");
  const expected = shapes.flatMap((k) => [k, `to=${k}`]).join("\n");
  const shell = (argv: string[]) => {
    const p = Bun.spawnSync([...argv, script], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trimEnd(), err: p.stderr.toString() };
  };
  const has = (bin: string) => Bun.which(bin) !== null;

  test("every key shape comes out of bash unchanged, bare and as to=<key>", () => {
    expect(shell(["bash", "-c"])).toEqual({ code: 0, out: expected, err: "" });
  });

  test.skipIf(!has("zsh"))("and out of zsh with extended_glob and magic_equal_subst", () => {
    expect(shell(["zsh", "-o", "extended_glob", "-o", "magic_equal_subst", "-c"])).toEqual({ code: 0, out: expected, err: "" });
  });
});

describe("keys and links", () => {
  test("sujetKey and permalinkOfKey keep their results on today's keys", () => {
    expect(sujetKey("linear:OPS-262")).toBe("linear:OPS-262");
    expect(sujetKey("ENG-2636")).toBe("linear:ENG-2636");
    expect(sujetKey("voir eng-12 merci")).toBe("linear:ENG-12");
    expect(sujetKey("https://acme.slack.com/archives/C0ACME0001/p1759219200000100")).toBe("C0ACME0001:1759219200.000100");
    expect(sujetKey("C0ACME0001:1759219200.000100")).toBeNull();
    expect(sujetKey("fcf1dc26")).toBeNull();
    expect(sujetKey("re:deploy")).toBeNull();
    expect(permalinkOfKey("C0ACME0001:1759219200.000100")).toBe("https://acme.slack.com/archives/C0ACME0001/p1759219200000100");
    expect(permalinkOfKey("C0ACME0001:1759219200.000100", "acme-old")).toBe("https://acme-old.slack.com/archives/C0ACME0001/p1759219200000100");
    expect(permalinkOfKey("linear:ENG-12")).toBe("https://linear.app/acme/issue/ENG-12");
    // an id outside the configured prefixes never linked, and still does not
    expect(permalinkOfKey("linear:FOO-1")).toBeNull();
    expect(permalinkOfKey("CX:1")).toBeNull();
  });

  test("a key of a configured account is found as is; one of an unknown tool is not a reference", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { workspace: "acme-partners" } } } } }));
    expect(sujetKey("slack@partners:C0ACME0002:1759219200.000300")).toBe("slack@partners:C0ACME0002:1759219200.000300");
    expect(sujetKey("slack:C0ACME0001:1759219200.000100")).toBe("C0ACME0001:1759219200.000100");
    expect(sujetKey("slack@nobody:C0ACME0002:1759219200.000300")).toBeNull();
    expect(sujetKey("maildir:x")).toBeNull();
  });

  test("a key of another tool reads with that tool's label, the account named when it is not the default", () => {
    expect(providerKeyLabel("linear:ENG-12")).toBe("Linear ENG-12");
    expect(providerKeyLabel("slack@partners:C0ACME0002:1759219200.000300")).toBe("Slack (partners) C0ACME0002:1759219200.000300");
    expect(providerKeyLabel("tickets:T-1")).toBe("tickets T-1");
  });
});

describe("report names", () => {
  test("unchanged for bare Slack keys and linear: keys, where sessions write today", () => {
    expect(reportFile("C0ACME0001:1759219200.000100")).toBe("C0ACME0001_1759219200.000100.md");
    expect(reportFile("linear:ENG-12")).toBe("linear_ENG-12.md");
    expect(reportFile("CX:1")).toBe("CX_1.md");
  });

  test("any other key gets a hash suffix, so two keys never share a file", () => {
    const a = reportFile("slack@partners:C0ACME0002:1759219200.000300");
    const b = reportFile("slack@partners:C0ACME0002/1759219200.000300");
    expect(a).toMatch(/^slack_partners_C0ACME0002_1759219200\.000300-[0-9a-f]{6}\.md$/);
    expect(b).toMatch(/^slack_partners_C0ACME0002_1759219200\.000300-[0-9a-f]{6}\.md$/);
    expect(a).not.toBe(b);
  });
});
