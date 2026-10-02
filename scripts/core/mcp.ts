/**
 * The MCP servers of the connected tools, as sessions see them (docs/design/providers.md, section 9): which read tools
 * sessions may call without a permission prompt, and which tool a server belongs to, for the board's trail.
 *
 * Pure: the descriptors come from core/links.ts, the accounts from the profile.
 */
import { providerDescriptors } from "./links.ts";
import { resolveAccounts, type Settings, settings } from "./settings.ts";

/**
 * The Slack MCP read rules every session got before tools were providers: kept whatever the profile, so a session
 * started from an older prompt keeps reading its threads.
 */
const LEGACY_SLACK_READS = ["mcp__slack__conversations_replies", "mcp__slack__conversations_history", "mcp__slack__conversations_search_messages"];

/** A server or tool name a permission rule can carry as is. */
const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The configured accounts with the MCP server each one names (`mcpServer`, the tool's own server by default). */
function servers(s: Settings) {
  const descriptors = Object.fromEntries(providerDescriptors().map((d) => [d.id, d]));
  return resolveAccounts(s, descriptors).map(({ account, mcpServer }) => ({ provider: account.provider, server: mcpServer, mcp: descriptors[account.provider]?.mcp }));
}

/**
 * The MCP tools sessions may call without a permission prompt to read their topics: the read tools each configured
 * account's tool declares, on the account's server. A rule for a server the workspace does not have is never used.
 * Write tools are never listed here.
 */
export function mcpReadRules(s: Settings = settings()): string[] {
  const rules = servers(s).flatMap(({ server, mcp }) => (mcp && server && MCP_NAME.test(server) ? mcp.readTools.filter((tool) => MCP_NAME.test(tool)).map((tool) => `mcp__${server}__${tool}`) : []));
  return [...new Set([...LEGACY_SLACK_READS, ...rules])];
}

/**
 * The tool an MCP server belongs to: the server a configured account names, else the one a tool's descriptor declares.
 * Null for a server of no tool (a database, logs).
 */
export function mcpProvider(server: string, s: Settings = settings()): string | null {
  return servers(s).find((a) => a.server === server)?.provider ?? providerDescriptors().find((d) => d.mcp?.server === server)?.id ?? null;
}
