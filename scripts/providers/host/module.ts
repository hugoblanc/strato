/**
 * External providers written as a TypeScript or JavaScript module (docs/design/providers.md, section 13.1): imported
 * at runtime from their absolute file URL, which also works from the compiled binary, without Bun installed. The
 * module's default export is a provider object; it imports types only (the file `strato provider types` prints), and
 * every runtime service comes through the `AccountContext` its methods receive.
 *
 * A module runs inside Strato's process: its isolation is a convention, not a boundary (section 13.4).
 */
import { pathToFileURL } from "node:url";
import { t } from "../../core/i18n.ts";
import { descriptorProblems } from "../check.ts";
import type { Capabilities, Provider } from "../sdk.ts";

/** A pure function of a module that answers `fallback` instead of throwing. */
function guarded<A extends unknown[], R>(fn: (...a: A) => R, fallback: (e: unknown) => R): (...a: A) => R {
  return (...a: A) => {
    try {
      return fn(...a);
    } catch (e) {
      return fallback(e);
    }
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A provider that cannot be loaded, with every reason. */
export class LoadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "LoadError";
  }
}

/** The members of a provider object Strato reads from a module; anything else it exports is ignored. */
const METHODS = ["connect", "poll", "subscribe", "replies", "complete", "participated", "context", "act", "undo", "parseTarget", "threadInfo"] as const;

/** The method each declared capability needs: a provider never declares what it does not implement. */
export function missingMethods(c: Capabilities, has: (m: string) => boolean): string[] {
  const need: [boolean, string, string][] = [
    [c.ingest.poll, "capabilities.ingest.poll", "poll"],
    [c.ingest.push, "capabilities.ingest.push", "subscribe"],
    [c.participation, "capabilities.participation", "participated"],
    [c.context, "capabilities.context", "context"],
    [c.actions.length > 0, "capabilities.actions", "act"],
    [c.undo.length > 0, "capabilities.undo", "undo"],
  ];
  return need.filter(([declared, , m]) => declared && !has(m)).map(([, path, method]) => t("cli.provider.check.missingMethod", { path, method }));
}

/**
 * The provider a module exports, its descriptor checked against the id the profile gives it. Only the known members
 * are kept, and `deepLink` never: it is for built-in providers.
 */
export async function importModule(file: string, id: string): Promise<Provider> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (e) {
    throw new LoadError([t("cli.provider.load.import", { file, error: (e as Error).message ?? String(e) })]);
  }
  const raw = (mod.default ?? mod.provider) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") throw new LoadError([t("cli.provider.load.noExport", { file })]);
  const problems = descriptorProblems(raw.descriptor, id, { timing: false });
  if (typeof raw.connect !== "function") problems.push(t("cli.provider.check.missingMethod", { path: "connect", method: "connect" }));
  if (problems.length) throw new LoadError(problems);
  const p = raw as unknown as Provider;
  const missing = missingMethods(p.descriptor.capabilities, (m) => typeof raw[m] === "function");
  if (missing.length) throw new LoadError(missing);
  const out: Record<string, unknown> = { descriptor: p.descriptor };
  for (const m of METHODS) if (typeof raw[m] === "function") out[m] = (raw[m] as (...a: unknown[]) => unknown).bind(raw);
  // the pure parts run inside the board's synchronous rendering: one that throws reads as "nothing to say"
  if (out.parseTarget) out.parseTarget = guarded(out.parseTarget as NonNullable<Provider["parseTarget"]>, (e) => ({ error: { en: `${id}: ${String((e as Error)?.message ?? e)}` } }));
  if (out.threadInfo) out.threadInfo = guarded(out.threadInfo as NonNullable<Provider["threadInfo"]>, () => null);
  // the board shows HTML built by Strato only: a module's markup becomes plain text, escaped here
  const render = raw.render as Partial<NonNullable<Provider["render"]>> | undefined;
  if (render && typeof render.plain === "function") {
    const plain = guarded((text: string) => String((render.plain as (x: string) => unknown).call(render, text) ?? ""), () => "");
    out.render = { plain, html: (text: string) => escapeHtml(plain(text)) };
  }
  const setup = raw.setup as Provider["setup"] | undefined;
  if (setup && typeof setup === "object") out.setup = { ...(typeof setup.detect === "function" ? { detect: setup.detect.bind(setup) } : {}), ...(typeof setup.check === "function" ? { check: setup.check.bind(setup) } : {}) };
  return out as unknown as Provider;
}
