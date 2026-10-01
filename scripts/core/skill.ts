/**
 * The SKILL.md that `strato install-skill` writes for an installed binary, in pure functions.
 *
 * The repository's SKILL.md is a template: every command is written `$STRATO <command>`, and the block between
 * `<!-- strato:command -->` and `<!-- /strato:command -->` explains what `$STRATO` stands for in each install mode.
 * A development clone is used as is (the master substitutes `bun <base>/scripts/strato.ts` itself). For a binary,
 * the command is known: the block is replaced by one sentence and every `$STRATO` by the command, so the master
 * reads `strato doctor` and never has to guess a path.
 */

/** Starts the line that marks a SKILL.md written by install-skill: only such a file is overwritten without --force. */
export const SKILL_MARKER = "<!-- written by `strato install-skill`";

const COMMAND_BLOCK = /<!-- strato:command -->[\s\S]*?<!-- \/strato:command -->\n?/;

/** True when `text` was written by install-skill (and may be rewritten by it). */
export const isGeneratedSkill = (text: string) => text.includes(SKILL_MARKER);

/**
 * Renders the template for a given command (`strato`, or `/Users/a/.local/bin/strato`).
 * The marker goes right after the front matter: Claude Code reads the skill's name and description from the first lines.
 */
export function renderSkill(template: string, command: string, version: string, compiled = true): string {
  const how = compiled ? "as a binary" : "from a development clone";
  const explained = `Strato is installed on this machine ${how} (version ${version}), and its command is \`${command}\`: every command below is written with it, type it as is.\n`;
  const body = template.replace(COMMAND_BLOCK, explained).replaceAll("$STRATO", command);
  const marker = `${SKILL_MARKER} (v${version}). Rerun \`${command} install-skill\` rather than editing it: an update rewrites it. -->`;
  const fm = /^---\n[\s\S]*?\n---\n/.exec(body);
  return fm ? `${fm[0]}\n${marker}\n${body.slice(fm[0].length)}` : `${marker}\n\n${body}`;
}

/** The command a generated SKILL.md was written with, read back from its marker; null for any other file. */
export function skillCommandOf(text: string): string | null {
  const line = text.split("\n").find((l) => l.startsWith(SKILL_MARKER));
  return line ? (/Rerun `(.+?) install-skill`/.exec(line)?.[1] ?? null) : null;
}
