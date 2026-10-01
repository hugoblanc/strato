/**
 * A fake ticket tool for the ingest tests: a provider whose answers the test writes, one per call, so that a test can
 * show two sources feeding the same triage, a tool that fails next to one that works, the cursor contract, and
 * hostile strings. Pure: the test script adds it to the registry (`addProvider`) in its own process.
 */
import { PROVIDER_API } from "./providers/api.ts";
import type { IngestCursor, Item, PollResult, Provider, ProviderDescriptor, ProviderError } from "./providers/sdk.ts";

/** An answer, or the error the call throws. */
type Answer<T> = T | { error: Partial<ProviderError> & { code: string } };

export interface FakeSpec {
  id: string;
  label: string;
  /** One answer per poll, the last one repeated; or a function of the call number (0 first) and the cursor. */
  polls?: Answer<PollResult>[] | ((n: number, cursor: IngestCursor | null) => Answer<PollResult>);
  /** The replies of a thread, by native id. */
  replies?: Record<string, Answer<Item[]>>;
  /** What `connect` throws, when it should fail. */
  connectError?: Partial<ProviderError> & { code: string };
  /** Threads the person took part in. */
  participated?: string[];
}

/** A ticket tool on `tickets.example`, its links `https://tickets.example/t/PLAT-12`. */
export function fakeDescriptor(id: string, label: string): ProviderDescriptor {
  const text = (en: string) => ({ en });
  return {
    id,
    label: text(label),
    api: { min: PROVIDER_API, max: PROVIDER_API },
    kinds: ["tracker"],
    capabilities: { ingest: { push: false, poll: true }, participation: true, context: false, actions: [], undo: [], idempotent: [], edits: false, identity: false },
    auth: [{ id: "api-key", kind: "api-key", label: text("API key"), docs: "https://tickets.example/docs/api-keys", steps: [{ kind: "paste", secret: "FAKE_API_KEY", say: text("Paste your API key") }], stores: [{ name: "FAKE_API_KEY" }] }],
    settings: [
      { key: "me", type: "string", label: text("Your user id"), ask: text("Your user id?"), triage: "me" },
      { key: "watchTeams", type: "string[]", label: text("Watched teams"), default: [], ask: text("Which teams?"), triage: "watch" },
      { key: "ignoreAuthors", type: "string[]", label: text("Ignored authors"), default: [], ask: text("Which bots?"), triage: "ignoreAuthors" },
    ],
    vocabulary: { item: text("comment"), thread: text("ticket"), conversation: text("team"), targetFormat: "the ticket id (PLAT-12)" },
    links: { parse: [{ host: "tickets.example", pattern: "^/t/([A-Z]+-\\d+)", thread: "$1" }], of: [{ match: "^([A-Z]+-\\d+)$", url: "https://tickets.example/t/$1" }] },
    hosts: ["tickets.example"],
    apiHosts: ["tickets.example"],
  };
}

function answer<T>(a: Answer<T>): T {
  if (a && typeof a === "object" && "error" in a) throw { retryable: true, fatal: false, message: a.error.code, ...a.error };
  return a as T;
}

/** The provider, with the calls it received (`poll`, `replies PLAT-12`…) in `calls`. */
export function fakeProvider(spec: FakeSpec): Provider & { calls: string[] } {
  const calls: string[] = [];
  let polls = 0;
  return {
    calls,
    descriptor: fakeDescriptor(spec.id, spec.label),
    async connect(ctx) {
      calls.push("connect");
      if (spec.connectError) throw { retryable: false, fatal: true, message: spec.connectError.code, ...spec.connectError };
      return { me: String(ctx.account.settings.me ?? "u-alice"), name: "Alice", workspace: "acme" };
    },
    async poll(_ctx, cursor) {
      const n = polls++;
      calls.push(`poll ${cursor?.value ?? "-"}`);
      const list = spec.polls ?? [];
      const a = typeof list === "function" ? list(n, cursor) : list[Math.min(n, list.length - 1)];
      return answer(a ?? { items: [], cursor: { value: String(n), at: n }, complete: true });
    },
    async replies(_ctx, thread) {
      calls.push(`replies ${thread}`);
      return answer(spec.replies?.[thread] ?? []);
    },
    async participated() {
      return spec.participated ?? [];
    },
  };
}

/** A comment on a ticket, by Bob, in team PLAT; `o` changes any field. */
export function ticketItem(o: Partial<Item> = {}): Item {
  const thread = o.thread ?? "PLAT-12";
  return {
    thread,
    id: `${thread}/comment/1`,
    event: "comment",
    author: { id: "u-bob", name: "Bob", isMe: false, isBot: false },
    conversation: { id: "PLAT", label: "Tickets PLAT", kind: "ticket" },
    text: "the checkout fails again",
    time: 1_790_000_100_000,
    link: `https://tickets.example/t/${thread}`,
    mentionsMe: false,
    targetsOther: false,
    ...o,
  };
}
