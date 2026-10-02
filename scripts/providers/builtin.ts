/**
 * The pure parts of the built-in providers (descriptors, targets, rendering, deep links): installed into core/links.ts
 * at startup (app/env.ts) so that keys, links, targets and drafts resolve without loading any network code. The
 * provider objects themselves live in providers/registry.ts.
 */
import { LINEAR_DESCRIPTOR, linearDeepLink } from "./linear/model.ts";
import type { ProviderDescriptor, ProviderPure } from "./sdk.ts";
import { SLACK_PURE } from "./slack/model.ts";

export const BUILTIN_PURE: readonly ProviderPure[] = [SLACK_PURE, { descriptor: LINEAR_DESCRIPTOR, deepLink: (url, account) => linearDeepLink(url, account) }];

export const BUILTIN_DESCRIPTORS: readonly ProviderDescriptor[] = BUILTIN_PURE.map((p) => p.descriptor);
