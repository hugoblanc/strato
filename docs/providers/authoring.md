# Writing a Strato provider

This guide is for a developer, or a model, who has never seen Strato's code and wants to connect one more tool to it.
It is self-contained: you need it, the types file that `strato provider types` prints, and the documentation of the tool you connect.
`strato provider guide` prints this file.

## 1. What Strato does, and where a provider fits

Strato routes the requests that reach one person into one Claude Code work session per topic, and shows the topics on a local board where the person approves every outgoing action (a "Go") before it happens.

The loop has four steps, and a provider takes part in three of them:

1. **Ingest.** A provider reads new items from its tool (a comment, a message, an issue event) by polling, or by a push connection.
2. **Triage.** Strato decides, for each item, whether it is ignored, set aside for a digest, or raised as a request.
   The provider does not decide: it states facts about each item (is the person mentioned, in which conversation, by whom).
3. **Context.** A work session reads a whole thread through the provider (`strato context`).
4. **Act.** When the person gives a Go on the board, Strato asks the provider to carry out that exact action (post a comment, change a status) and, within a short window, to undo it.
   A provider never decides to write: it only executes what Strato asks after a Go.

Slack and Linear are built in.
Any other tool (a ticket tracker, a CRM, a mailbox, a support desk) is an external provider, loaded from disk at runtime without recompiling Strato.

## 2. Words

| Word | Meaning |
| --- | --- |
| Provider | Your code: it connects Strato to one tool. |
| Account | One connection of your provider, with its own secrets and settings. Most people have one, named `default`. |
| Item | One unit of incoming content: a comment, a message, an event on an issue. |
| Thread | What a topic follows: an issue with its comments, a conversation thread, an email thread. |
| Conversation | Where threads live: a project, a team, a channel, a mailbox. |
| Native id | The id your tool gives a thread or an item (`OPS-7`, `msg-123`). Your provider only ever speaks native ids. |
| Key | What Strato builds from a native id: `<provider>[@<account>]:<native id>`, such as `tickets:OPS-7`. Strato escapes it for the shell; you never build one. |
| Target | Where an action goes: a thread, a conversation, an item, a ticket. |
| Action | One write: `comment`, `post`, `reply`, `react`, `delete`, `setStatus`, `assign`, `create`. |
| Gate | The one function in Strato that every write goes through: it refuses anything without a Go on the exact content, and everything in shadow mode. |

## 3. Two forms

| | TypeScript module | Executable |
| --- | --- | --- |
| Language | TypeScript or JavaScript | any: Python, Go, Ruby, a shell script |
| How Strato runs it | imports the file into its own process | starts one process per account and speaks JSON-RPC 2.0 over its stdin and stdout |
| Pure functions for the board (destinations written as text, rendering) | yes | no: destinations are typed keys, text is shown as plain text |
| Isolation | a convention: same process as Strato | a process boundary: it only sees what Strato sends it |
| Third-party packages | not supported (the compiled Strato cannot resolve them) | anything the program can use |

Both forms reach the tool through Strato (`ctx.fetch` in a module, the `http.fetch` request in an executable).
That is what lets the conformance harness check your provider offline, and it gives you Strato's timeouts and secret masking for free.

## 4. Quick start

```bash
strato provider new tickets                 # a TypeScript module in <state>/providers/tickets/
strato provider new tickets --exec python   # the same provider as a Python program, standard library only
strato provider test tickets-folder-or-id   # the offline conformance harness
```

The scaffold works as is: a fake tool on `tickets.example` with two items, a thread to read, and a `comment` action with undo, all answered by `fixtures/sample.json`.
Run the harness before changing anything, then change one thing at a time and run it again.

To use the provider:

1. Name it in `config.json` (`<state>/config.json`):

   ```json
   { "providers": { "tickets": { "source": { "module": "provider.ts" } } } }
   ```

   A relative path is read from `<state>/providers/<id>/`; `~` and absolute paths point anywhere else.
   An executable is `{ "exec": ["python3", "provider.py"] }`: a list of words, never a shell line.
2. Trust it, in your own terminal: `strato provider trust tickets`.
   Strato shows the folder, the command and its SHA-256, and asks a first `yes` before it runs the provider once, without secrets nor accounts, to read its descriptor.
   It then shows what the provider can reach, sign in with and do, and records the hash on a second typed `yes`.
   Any change to a file of that folder needs a new trust; until then Strato does not load it.
   Only git's own `.git/` folder and the JSON files directly in `fixtures/` are left out: code anywhere else counts, under `fixtures/` too, and so do Python's `__pycache__/` files (Strato starts your process with `PYTHONDONTWRITEBYTECODE=1`, so running it writes none).
3. Connect an account: `strato setup --connect tickets`.
   Strato walks the sign-in steps your descriptor declares, checks the secret with `connect`, and stores it in a file only the person can read.
4. `strato provider list` and `strato doctor` say where it stands.

## 5. The descriptor

The descriptor is data that Strato reads before calling anything.
Every user-facing text is `{ "en": "…", "fr": "…" }`, English required.

| Field | What it says |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, 2 to 31 characters, starting with a letter. It prefixes every key: never rename it once used. |
| `label` | The tool's name, as the board shows it. |
| `api` | `{ "min": 1, "max": 1 }`: the provider interface versions you wrote for. |
| `kinds` | `chat`, `tracker`, `mail`, `forge`. A `tracker` gets ticket-like defaults: a typed destination on it is a ticket, and a text action there is a `comment`. |
| `capabilities` | What you implement: `ingest.poll`, `ingest.push` (push requires poll), `participation`, `context`, `actions`, `undo`, `idempotent`, `edits`, `identity`. Strato never calls what is not declared, and every declared capability needs its method. |
| `auth` | The official ways to sign in (section 11): their steps, the secrets they store, and what they cannot do (`limits`). |
| `settings` | The account settings you read, with their type and, for the interview, an `ask` question. A setting with a `triage` role feeds triage (section 8). |
| `vocabulary` | Your tool's words for an item, a thread and a conversation, and `targetFormat`: one English sentence that tells a work session how to write a destination, such as "the item's key, such as tickets:OPS-7". |
| `links` | Your links as data (section 9). |
| `hosts` | The hosts of the links you build. The board opens those, and only those, for your keys. |
| `apiHosts` | The hosts your requests may reach. `{settings.baseUrl}` stands for the host of that setting. A request elsewhere fails. |
| `undoMs` | The undo window, in milliseconds, when `capabilities.undo` is not empty. |
| `maxText` | The longest text an action may carry. |
| `audience` | For a mail or support tool: the recipients or the visibility a text action requires. The person sees them before the Go. |
| `ticketIds` | `{ "prefixesFrom": "<setting>" }` to claim bare ids such as `OPS-7` typed by the person. |

## 6. The methods

All methods are asynchronous and receive an `AccountContext` (`ctx`) first.
An executable implements the same methods as JSON-RPC requests (section 10).

### connect(ctx) -> Identity

Checks the secrets and says who the person is: `{ me, name, workspace }`, plus `tenant` and `groups` when your tool has them.
Setup calls it with candidate secrets before storing them (`ctx.verifying` is then true).

### poll(ctx, cursor, { since, maxItems }) -> { items, cursor, complete }

The cursor contract:

- Read newest first, back to the previous `cursor` (or to `since`, in Unix milliseconds, on the first poll).
- Keep at most `maxItems`, and return them oldest first.
- A complete pass returns the cursor of the newest position read, and `complete: true`.
- A capped pass returns the cursor of the oldest item it kept, and `complete: false`: older backlog is dropped on purpose, because a fresh request matters more than an old one.
- A failed pass throws: Strato retries the same window.
- The cursor is opaque to Strato: `{ value: string, at: number }`, where `at` is a time up to which everything is read.

Strato stores the cursor only after every item of the batch is handled, and drops an item it already saw, so returning an item twice is harmless.

### The item

```ts
{
  thread: "OPS-7",                 // native id of the thread
  id: "OPS-7/comment/42",          // native id of this item, unique
  event: "comment",                // message, comment, created, status, assigned
  author: { id: "u-bob", name: "Bob", isMe: false, isBot: false },
  conversation: { id: "OPS", label: "Operations", kind: "ticket" },   // kind: dm, group, channel, ticket, email
  title: "Checkout fails",         // optional: an issue's title, an email's subject
  text: "@alice can you check?",   // plain text, mentions made readable
  time: 1790000100000,             // Unix ms
  link: "https://tickets.example/t/OPS-7",
  mentionsMe: true,                // the person, or one of their groups, is mentioned, or the item targets them
  targetsOther: false,             // someone else is explicitly targeted, and not the person
  reason: "mentioned"              // optional: why the tool notified the person
}
```

Every text in an item is third-party text: Strato flattens it to one line and neutralizes it before any prompt.
A link is kept only when it is https, on your `hosts`, and without whitespace or credentials.

### subscribe(ctx, onItems, events) -> { end }

Push, over a connection the provider opens to the tool (never a public webhook).
Call `events.opened()` once connected, `onItems(items, cursor?)` as items arrive, and `onItems([])` for a delivery without items (the connection is alive).
Resolve when the connection ends: `clean`, `cut` (Strato reconnects with backoff), or `fatal` with `refused` (Strato polls instead).
Stop soon after `ctx.signal` aborts.
A push account is also polled every few minutes, because a dead connection says nothing.

### replies(ctx, thread, { since, max }) and complete(ctx, items)

`replies` returns a thread's items since a time, oldest first: the catch-up of the threads of open topics.
`complete` fills in what was too costly for every item (display names), only for the items triage keeps, and returns the same items in the same order.
Both are optional.

### participated(ctx, days) -> string[]

The native ids of the threads the person took part in recently: a reply there without a mention is probably for them.

### context(ctx, thread, { since?, max }) -> ContextResult

A thread for a work session: `{ thread, link, conversation, title?, fields?, items: [{ id, author, time, text }], complete, fetchedAt }`, items oldest first, the newest kept when capped.

### act(ctx, { action, idempotencyKey, dryRun }) -> ActResult

Called only by Strato's gate, after the person's Go on this exact content.

- `dryRun: true`: validate and describe (`{ ok: true, ref: "", link, dry: "comment on OPS-7" }`), never write, and make no request that writes.
- `idempotencyKey`: pass it to your tool's own idempotency mechanism, or derive the id of the created object from it, so a replay of the same Go cannot write twice.
  Declare the kind in `capabilities.idempotent` only then.
- On success: `{ ok: true, ref, link, undo?: { token, until } }`.
- On failure: `{ ok: false, error }` (section 7).

### undo(ctx, token) -> ActResult

Takes back what `act` did, within `undoMs`, from the token it returned.

### Pure functions (modules only)

`parseTarget(text, topic, account)` reads a destination written as text; `threadInfo(native)` says what a thread id carries by itself (its conversation, its time); `render.plain(text)` turns your markup into plain text.
They run on the board's synchronous paths: keep them fast and side-effect free.
A throw there reads as "nothing to say".
Strato shows a module's text as plain text, escaped by Strato: a provider never sends HTML to the board.

### What Strato gives you: the AccountContext

| Member | Use |
| --- | --- |
| `account` | `{ provider, id, label, auth, ingest, settings }` |
| `identity` | What `connect` returned, once connected. |
| `secret(name)` | A secret your auth method declares in `stores`, from the account's secret file. Never anything else. |
| `setSecret(name, value)` | Stores a refreshed secret (an OAuth token). |
| `fetch` | `fetch` limited to `apiHosts` over https, with a timeout, `ctx.signal`, and secrets masked in errors. |
| `log(level, message)` | A line in the account's log. |
| `store.read(name, fallback)`, `store.write(name, value)` | Small JSON files in the account's own folder. |
| `signal` | Aborted when Strato no longer needs the answer. |
| `locale` | `en` or `fr`. |

A provider never receives the state folder, other accounts' secrets, the topics, nor a way to start a session.

## 7. Errors

Throw, or return in `act` and `undo`, a `ProviderError`: `{ code, message, retryable, fatal, retryAfterMs?, outcome? }`.
In a module, throwing an object whose `code` is a string is enough; missing fields default to not retryable and not fatal.
Anything else thrown is read as a crash: retryable, and during a write `outcome: "unknown"`.

| What happened | What to say |
| --- | --- |
| 401 or 403 | `fatal: true`: the account needs setup again, Strato stops calling it. |
| 404 | `code: "not_found"`. |
| 429 | `code: "rate_limited"`, `retryable: true`, `retryAfterMs` from `Retry-After`. |
| 5xx | `retryable: true`. |
| A timeout or a network failure | `retryable: true`. |
| A write that may or may not have happened | `outcome: "unknown"`, which is also the default: Strato then asks the person to check, and never retries it by itself. Say `outcome: "none"` only when you are sure nothing was written. |

## 8. Triage: how your facts become a request

Strato classifies each item; you supply facts and settings, never rules.

| Kind | When | Where it goes |
| --- | --- | --- |
| `suite`, `moi` | the item is in the thread of an open topic (by someone else, by the person) | the topic's session |
| `dm` | `conversation.kind` is `dm`, or `group` without someone else targeted | raised |
| `mention` | `mentionsMe` | raised |
| `canal` | the conversation is in a `watch` setting | raised |
| `fil` | a thread the person took part in (`participated`), or one they follow (`reason: "subscribed"`) | raised |
| `tiers` | one of the above, but `targetsOther` | the digest |
| `bot` | the author is in an `ignoreAuthors` setting, or `isBot` on a ticket without `mentionsMe` | the digest |

A `status` event outside an open topic is ignored, and so is anything the person wrote.
Settings feed the rules through their `triage` role: `me` (the person's id), `groups`, `watch`, `ignore`, `ignoreAuthors`, `teammates`.
For a ticket tool, a worked mapping: a comment that mentions the person is a `mention`; a new issue in a watched project is a `canal`; a comment on an issue they commented is a `fil`.

## 9. Links

Links are data, evaluated by Strato on synchronous paths:

```json
{
  "parse": [{ "host": "tickets.example", "pattern": "^/t/([A-Za-z0-9_-]+)", "thread": "$1" }],
  "of": [{ "match": "^([A-Za-z0-9_-]+)$", "url": "https://tickets.example/t/$1" }]
}
```

- `parse` turns a pasted link into native ids: `host` compared without case (`*.` matches any subdomain, `{settings.workspace}` is substituted), `pattern` a regular expression on the path and query anchored at the start, `thread` (and `item`) built from its groups.
- `of` turns a native id into a link, first match wins.
- The harness checks that for every thread a poll returns, `of` then `parse` gives the same thread back, and times each pattern on long inputs: write patterns that cannot backtrack for long.

## 10. The exec protocol

**Framing.** JSON-RPC 2.0, one message per line, UTF-8, on the process's stdin and stdout, at most 4 MiB a line.
Stdout carries protocol messages only: a stray `print` there is a protocol error, and the process is restarted.
Write logs on stderr; Strato keeps them in the account's `provider.log`, secrets masked.
Exit when stdin closes.

**The process.** Strato starts the command of `source.exec` (a list of words, no shell) in the provider's folder, once per account, at the first call.
Its environment is minimal: `PATH`, `HOME`, `LANG`, `TZ`, `STRATO_PROVIDER_PROTOCOL=1`, and the proxy and certificate variables when the person sets them (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`).
Secrets never travel in an argument or a variable: they come in `initialize`.

**Handshake.** `describe` takes no secret and returns `{ api: 1, descriptor, concurrent? }`; Strato offers the versions it speaks in `{ apis: [1] }`.
Then `initialize` gives `{ api, strato, locale, account: { id, label, auth, settings }, secrets: { NAME: value }, offline }`, once per process; `offline` is true under the harness.

**Requests from Strato.**

| Method | Params | Result | Timeout |
| --- | --- | --- | --- |
| `describe` | `{ apis }` | `{ api, descriptor, concurrent? }` | 5 s |
| `initialize` | see above | `{ ok: true }` | 15 s |
| `connect` | `{}` | `Identity` | 20 s |
| `poll` | `{ cursor, since, maxItems }` | `PollResult` | 60 s |
| `subscribe` | `{}` | `{ ok: true }` once open, then `items` notifications | 15 s |
| `unsubscribe` | `{}` | `{ ok: true }` | 5 s |
| `participated` | `{ days }` | `{ threads }` | 30 s |
| `replies` | `{ thread, since, max }` | `{ items }` | 30 s |
| `complete` | `{ items }` | `{ items }` | 30 s |
| `context` | `{ thread, since?, max }` | `ContextResult` | 30 s |
| `act` | `{ action, idempotencyKey, dryRun }` | `ActResult` | 30 s |
| `undo` | `{ token }` | `ActResult` | 30 s |
| `setup.detect` | `{}` | `{ fields }` | 30 s |
| `setup.check` | `{}` | `{ items }` | 30 s |
| `shutdown` | `{}` | `{ ok: true }`, then exit | 5 s |

A method you do not implement answers error -32601; its capability must then be absent from the descriptor.
`replies` and `complete` may answer -32601: Strato stops asking for that process.

**Requests from the provider**, answered by Strato while its own request is pending (or while subscribed):

| Method | Params | Result |
| --- | --- | --- |
| `http.fetch` | `{ method, url, headers?, body? or bodyBase64? }` | `{ status, headers, body }`; only to `apiHosts` over https, 30 s; a timeout or a network failure is an error whose `data` says `retryable: true` |
| `store.read` | `{ name }` | `{ value }`, or null |
| `store.write` | `{ name, value }` | `{ ok: true }`; names `^[a-z0-9-]{1,40}$`, 1 MiB each |
| `secret.set` | `{ name, value }` | `{ ok: true }`; names your auth method declares only |

**Notifications from the provider.** `items` `{ items, cursor? }` while subscribed; `subscription.end` `{ end, retryAfterMs?, refused? }`; `log` `{ level, message }`; `health` `{ status, detail? }`.

**Concurrency.** One request at a time per process, unless `describe` answered `concurrent: true`.
A single-threaded program works: while it waits for its own `http.fetch` answer it reads stdin line by line until the matching id arrives.
Each timeout counts from when Strato wrote the request.

**Cancellation.** On a timeout, Strato sends the notification `$/cancel` `{ id }`.
Answer it with error -32004 (or the result) within 5 seconds, or the process is killed and restarted.
A write that timed out is reported with `outcome: "unknown"`.

**Errors.** JSON-RPC error objects, with a `ProviderError` in `data`:

| Code | Meaning |
| --- | --- |
| -32700, -32600, -32602 | parse error, invalid request, invalid params |
| -32601 | method not found |
| -32000 | provider error, details in `data` |
| -32001 | protocol version not supported |
| -32002 | authentication: the account needs setup |
| -32003 | rate limited (`retryAfterMs` in `data`) |
| -32004 | cancelled |

**Restarts.** A process idle for 10 minutes is shut down and started again at the next call.
A crash fails only that account's calls (a write's outcome is then unknown), and the next start waits 1 s, 2 s, 4 s… up to 5 minutes; five crashes within ten minutes mark the account down for fifteen.
A process that speaks another protocol version, or answers to another id, is marked down at once, and tried again every fifteen minutes.

## 11. Signing in

Official flows only: a token from an app the person creates, OAuth 2.0 on a loopback redirect with PKCE where the service supports it, a personal API key, an app password.
Never read a session cookie or a token out of a browser or another application's storage.
An auth method lists its `steps` (`open` a documented page, `paste` a secret without echo, `oauth`, `verify`), the secrets it `stores`, the `scopes` it asks for, and the capabilities it cannot provide (`limits`).

## 12. Testing

`strato provider test <id | path>` runs the conformance harness offline, on a throwaway state folder.
By path, it runs the code there as it is: that is how you test a provider before trusting it.
By id, it runs a configured provider only as the person trusted it; an untrusted or changed folder is refused, with the path form to use instead.

- Every request goes through `ctx.fetch` or `http.fetch` and is answered from `fixtures/*.json` (one run per file); the process's own global `fetch` is refused, and a request no fixture matches fails the run.
- Secrets come from the fixture, never from the person's files.
- Writes go only through Strato's gate: a dry run for each action kind a task can carry, then a real act against the fake, then its undo.
  The real act runs only once the provider was seen talking through the fake (its `connect` or its `poll` made requests there).

A fixture file:

```json
{
  "secrets": { "TICKETS_API_KEY": "test-key" },
  "settings": { "me": "u-alice", "watch": ["OPS"] },
  "exchanges": [
    { "request": { "method": "GET", "url": "https://tickets.example/api/activity" }, "response": { "body": [] }, "repeat": true },
    { "request": { "method": "POST", "url": "https://tickets.example/api/threads/OPS-7/comments", "bodyContains": ["Strato conformance check"] }, "response": { "status": 201, "body": { "id": "c-1" } } }
  ],
  "expect": {
    "items": [{ "id": "a-1", "kind": "mention" }, { "id": "a-2", "kind": null, "rules": { "watch": [] } }],
    "targets": [{ "draftTo": "OPS-7", "target": { "scope": "ticket", "native": "OPS-7" } }],
    "push": ["a-3"]
  },
  "act": { "thread": "OPS-7", "text": "Strato conformance check" }
}
```

Matching: the method, then the URL (scheme, host, path, and the query as a set), then the body, compared as canonical JSON with `body` or by substrings with `bodyContains`.
Headers are not matched, since they carry secrets.
An exchange answers once unless it says `"repeat": true`: the poll checks poll several times, so give your list endpoints `repeat`.
A GET, or an exchange marked `"safe": true`, writes nothing: the only requests a dry run may make.
`expect.push` lists the ids of the items a subscription delivers while the push check listens, in order; leave it out for a provider that does not push.

| Check | What it verifies |
| --- | --- |
| descriptor | the schema, official auth kinds, English labels, hosts, `ask` on triage settings, push with poll, link patterns that compile and do not stall |
| protocol (executables) | an unknown method answers -32601 |
| connect | an identity with `me` |
| poll | required fields, oldest first; polling again from the cursor returns nothing already returned; a capped poll (`maxItems: 1`) then a poll from its cursor comes back complete |
| links | `of` then `parse` gives back every polled thread |
| keys | the key of every polled thread reads back as that thread, in its one stored form |
| triage | each `expect.items` entry gets its kind |
| context | the shape `strato context` checks before printing (a conversation label, `complete`, items with id, author, time and text), items oldest first |
| text | no control characters in ids and names, texts under 1 MiB |
| targets (modules) | `parseTarget` on each `expect.targets` sample |
| act, dry | a dry result through the gate, and no request that writes |
| act | the write carries the text and, for an idempotent kind, the idempotency key |
| undo | the act is undone through the gate |
| act, timeout | a write that times out never says `outcome: "none"` |
| errors | a 401 is fatal, a 429 is retryable with `retryAfterMs`, a timeout is retryable |
| push | a subscription delivers items and says how it ended; with `expect.push`, the ids it delivered, in order |
| network | every request matched a fixture |

Each line says `ok`, `fail` with the reason, `skip`, or `not verifiable offline`: a provider that returned items without any request through the fake opened its own connection, which the harness cannot see, so it runs no real act for it; neither does it for a provider whose `connect` and `poll` made no request through the fake.
A provider that reads through the fake but writes on a connection of its own is caught only after its write: its act line fails, since no write reached the fake.
The exit code is 1 on any failure.

`strato provider test <id> --live [--account <name>]` runs the read checks (descriptor, connect, poll, links, context, text, and push for a few seconds) against the person's own configured account and its real secrets, never an act nor the error checks.
Run it yourself, in your own terminal, once the offline run passes.

## 13. Security

- **Opt-in.** Strato never scans a folder for providers: nothing loads unless `config.json` names it in `providers.<id>.source`.
- **Pinned.** It runs only when its folder hashes to what the person trusted with `strato provider trust`, typed in their own terminal.
  A work session is refused `provider trust`, `new` and `test`; it still runs the trusted provider through `strato context` and the other commands it uses.
  That refusal reads the `STRATO_CALLER` variable sessions are started with: a convention that keeps sessions on the right path, not a security boundary, since a session with a shell can unset it.
  The boundary is the terminal: trusting needs typed answers on a TTY.
  A provider that writes into its own folder breaks its pin: keep state with `store`.
- **Same privileges as the person.** A provider runs as the person, with their files and their network; Strato cannot sandbox it.
  Installing one is the same decision as installing any command-line tool: read it, or trust its author.
  A module shares Strato's process; an executable only gets what Strato sends it.
- **The gate still holds.** Your `act` and `undo` are reachable only through Strato's gate, after a Go on the exact content, and never in shadow mode.
  A provider that writes on its own initiative is malicious, and pinning is the defense.
- **Your output is untrusted.** Strato flattens and neutralizes every string you return before it reaches a prompt, escapes native ids into keys, keeps only https links on your hosts, and never puts any of it on a command line.
- **Secrets.** Only the secrets your auth method declares, from the account's own file; never in `config.json`, never in an argument or an environment variable, masked in logs.

## 14. Checklist

- `strato provider test` passes, with fixtures recorded from your tool's real answers, trimmed of secrets and of anyone's messages.
- Every declared capability is implemented, and nothing else is declared.
- Errors follow section 7; a write never claims `outcome: "none"` unless nothing was sent.
- `act` honors `dryRun` and, when declared, `idempotencyKey`.
- Links round-trip; patterns are anchored and simple.
- No text on stdout but protocol messages (executables); no global `fetch` (modules).
