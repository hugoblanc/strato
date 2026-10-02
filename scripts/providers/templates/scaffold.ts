/**
 * The files `strato provider new` writes (docs/design/providers.md, section 13.7): a provider that works as is against
 * its fixtures, as a TypeScript module or as a Python program speaking the exec protocol, the SDK types, a fixture
 * file and a README. Pure: the texts are embedded in the binary, the command writes them.
 */
import exec from "./exec.py.txt" with { type: "text" };
import fixture from "./fixture.json.txt" with { type: "text" };
import module from "./module.ts.txt" with { type: "text" };
import readme from "./readme.md.txt" with { type: "text" };

/** The languages `--exec` scaffolds; any other language speaks the same protocol, from the guide. */
export const EXEC_LANGUAGES = ["python"] as const;
export type ExecLanguage = (typeof EXEC_LANGUAGES)[number];

/** `tickets` -> `Tickets`, `my-crm` -> `My Crm`. */
export const labelOf = (id: string) => id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
/** The secret a scaffold stores: `tickets` -> `TICKETS_API_KEY`. */
export const secretOf = (id: string) => `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);

/**
 * The files of a new provider, by relative path. `sdk` is the SDK types file; `folder` is where they go, and `home`
 * whether it is the provider's own folder in the state, where config.json can name the entry file by a relative path.
 */
export function scaffold(id: string, opts: { exec?: ExecLanguage; sdk: string; folder: string; home: boolean; cli: string }): { files: Record<string, string>; source: Record<string, unknown> } {
  const entry = opts.exec ? "provider.py" : "provider.ts";
  const where = opts.home ? entry : `${opts.folder}/${entry}`;
  const source = opts.exec ? { exec: ["python3", where] } : { module: where };
  const snippet = JSON.stringify({ providers: { [id]: { source } } }, null, 2).replace(/\n/g, "\n   ");
  const vars = { id, label: labelOf(id), host: `${id}.example`, SECRET: secretOf(id), entry, snippet, test: `${opts.cli} provider test ${opts.folder}` };
  return {
    files: {
      [entry]: fill(opts.exec ? exec : module, vars),
      "strato-provider.d.ts": opts.sdk,
      "fixtures/sample.json": fill(fixture, vars),
      "README.md": fill(readme, vars),
    },
    source,
  };
}
