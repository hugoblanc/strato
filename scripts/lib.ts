/**
 * Entry point of Strato's pure logic: no network call nor process in the re-exported modules, everything is tested.
 * The modules by domain:
 * - core/      the model (topics, keys and links, cards, deadlines, requests to the master, text) and the installation's profile;
 * - chat/      the message source (Slack: triage, permalinks, readable text, destination of a draft);
 * - claude/    what Strato reads from Claude Code (sessions, transcripts, sub-agents);
 * - forge/     merge requests and their path to production;
 * - terminal/  the iTerm2 integration (AppleScript, session -> topic);
 * - policy/    the prompts of the work sessions.
 */
export * from "./core/settings.ts";
export * from "./core/i18n.ts";
export * from "./core/text.ts";
export * from "./core/keys.ts";
export * from "./core/links.ts";
export * from "./core/targets.ts";
export * from "./core/sujet.ts";
export * from "./core/tasks.ts";
export * from "./core/due.ts";
export * from "./core/cards.ts";
export * from "./core/triage.ts";
export * from "./core/master.ts";
export * from "./core/version.ts";
export * from "./chat/slack-model.ts";
export * from "./claude/model.ts";
export * from "./claude/transcript.ts";
export * from "./forge/mr.ts";
export * from "./terminal/iterm.ts";
export * from "./policy/prompts.ts";
