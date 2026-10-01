/**
 * The Linear provider until the linear stage: its descriptor only, which is all the `tracker` section ever needed
 * (links and ticket ids, evaluated by core/links.ts). Connecting an account is refused with a clear reason.
 */
import { defineProvider } from "../api.ts";
import type { Identity, ProviderError } from "../sdk.ts";
import { LINEAR_DESCRIPTOR } from "./model.ts";

export const linearProvider = defineProvider({
  descriptor: LINEAR_DESCRIPTOR,
  async connect(): Promise<Identity> {
    throw { code: "unsupported", message: "Linear is recognized in links and ticket ids only in this version: reading and writing tickets comes later", retryable: false, fatal: true } satisfies ProviderError;
  },
});
