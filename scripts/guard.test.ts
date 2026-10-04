import { describe, expect, test } from "bun:test";
import { reportPathAllowed } from "./core/text.ts";
import { hostAllowed, ORIGINLESS_ROUTES, originAllowed, terminalBasePath } from "./server/guard.ts";

describe("hostAllowed", () => {
  test("accepts 127.0.0.1 and localhost on the server port", () => {
    expect(hostAllowed("127.0.0.1:4343", 4343)).toBe(true);
    expect(hostAllowed("localhost:4343", 4343)).toBe(true);
  });
  test("refuses a domain resolving to 127.0.0.1 (DNS rebinding), another port, or a missing host", () => {
    expect(hostAllowed("evil.example:4343", 4343)).toBe(false);
    expect(hostAllowed("127.0.0.1:4344", 4343)).toBe(false);
    expect(hostAllowed("127.0.0.1", 4343)).toBe(false);
    expect(hostAllowed(null, 4343)).toBe(false);
  });
});

describe("originAllowed", () => {
  test("accepts the board page", () => {
    expect(originAllowed("http://127.0.0.1:4343", 4343)).toBe(true);
    expect(originAllowed("http://localhost:4343", 4343)).toBe(true);
  });
  test("refuses a page from another site or another port", () => {
    expect(originAllowed("https://evil.example", 4343)).toBe(false);
    expect(originAllowed("http://127.0.0.1:7700", 4343)).toBe(false);
    expect(originAllowed("null", 4343)).toBe(false);
  });
  test("refuses a missing origin, except on the iTerm2 script routes", () => {
    expect(originAllowed(null, 4343)).toBe(false);
    expect(originAllowed(null, 4343, ORIGINLESS_ROUTES.has("POST /api/focus"))).toBe(true);
    expect(ORIGINLESS_ROUTES.has("POST /api/post-draft")).toBe(false);
    expect(ORIGINLESS_ROUTES.has("POST /api/send")).toBe(false);
  });
});

test("terminalBasePath: 128 random bits, different for each terminal", () => {
  const a = terminalBasePath();
  expect(a).toMatch(/^\/[0-9a-f]{32}$/);
  expect(terminalBasePath()).not.toBe(a);
});

describe("reportPathAllowed", () => {
  test("follows a report stored in the reports folder", () => {
    expect(reportPathAllowed("/state/reports/C0ACME0001_1.2.md", "/state/reports")).toBe(true);
  });
  test("refuses a file outside the folder, a climb through .., or a file that is not a report", () => {
    expect(reportPathAllowed("/home/alice/.secrets/bank.env", "/state/reports")).toBe(false);
    expect(reportPathAllowed("/state/reports/../config.json", "/state/reports")).toBe(false);
    expect(reportPathAllowed("/state/reports-evil/x.md", "/state/reports")).toBe(false);
    expect(reportPathAllowed("/state/reports/x.env", "/state/reports")).toBe(false);
  });
});
