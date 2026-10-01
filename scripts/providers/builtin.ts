/**
 * The descriptors of the built-in providers, pure: installed into core/links.ts at startup (app/env.ts) so that keys
 * and links resolve without loading any network code. The provider objects themselves live in providers/registry.ts.
 */
import { LINEAR_DESCRIPTOR } from "./linear/model.ts";
import type { ProviderDescriptor } from "./sdk.ts";
import { SLACK_DESCRIPTOR } from "./slack/model.ts";

export const BUILTIN_DESCRIPTORS: readonly ProviderDescriptor[] = [SLACK_DESCRIPTOR, LINEAR_DESCRIPTOR];
