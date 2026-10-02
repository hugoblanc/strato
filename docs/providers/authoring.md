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
| Key | What Strato builds from a native id: `<provider>[@<account>]:<native id>`, such as `tickets:OPS-7`. Strato escapes it for the shell (below); you never build one, but your `targetFormat` shows one. |
| Target | Where an action goes: a thread, a conversation, an item, a ticket. |
| Action | One write: `comment`, `post`, `reply`, `react`, `delete`, `setStatus`, `assign`, `create`. |
| Gate | The one function in Strato that every write goes through: it refuses anything without a Go on the exact content, and everything in shadow mode. |

How a key escapes a native id: letters, digits and `. _ : / + = @ , -` stay as they are; every other character becomes `%XX`, the hex of its UTF-8 bytes.
So `OPS-7` gives `tickets:OPS-7`, a Message-ID `CA1234.5678+x=y@mail.acme.example` gives `email:CA1234.5678+x=y@mail.acme.example` unchanged, `acme/api#42` gives `github:acme/api%2342`, and `a&b` gives `a%26b`.
A key longer than 200 characters carries a hash of the native id instead, which Strato maps back.
The harness prints the key of each polled thread on its `keys` line: write your `targetFormat` example in that form, since a session writes it as is in `to=`.

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

### Tools that are not HTTP

Some tools speak another protocol: IMAP and SMTP, XMPP, a database.
A provider may open those connections itself, live: list their hosts in `apiHosts` all the same, so that `strato provider trust` shows the person where the provider connects.
Strato cannot see such a connection, so the harness cannot check it: a provider whose items come without any request through Strato reads "not verifiable offline", and no real write is checked.

The pattern that keeps the harness useful is a transport with two implementations, chosen once from `initialize`'s `offline` flag (in a module, from the absence of any other way to tell, a setting such as `transport: "fixtures"`):

- live, the real protocol, over the connections the provider opens;
- offline, each protocol operation mirrored as one `http.fetch` request to the account's own hosts (`GET https://imap.acme.example/imap/search?mailbox=INBOX&criteria=UNSEEN`), which the fixtures answer.

The harness then checks everything but the bytes of the protocol itself: parsing, threading, triage facts, the cursor, the written message, and the gate.
Test the live transport with your language's own fakes (`examples/providers/email/` replaces `smtplib` in its unit tests).

## 4. Quick start

```bash
strato provider new tickets                 # a TypeScript module in <state>/providers/tickets/
strato provider new tickets --dir ./tickets # the same, in the folder ./tickets itself
strato provider new tickets --exec python   # the same provider as a Python program, standard library only
strato provider test tickets-folder-or-id   # the offline conformance harness
strato provider test ./tickets --trace      # the same, printing every call, answer and request
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
| `kinds` | What the tool is, which decides how a typed destination (a key in `to=`) is read; see "How a text becomes an action" in section 6. `tracker`: a key names a ticket, and a text there is a `comment`. `mail`: a key names an email thread, and a text there is a `reply`. `chat`: no default; a key is a thread only if `threadInfo` reads it as one, else a conversation, where a text is a `post`. `forge` (merge requests): no default of its own today; a forge that also has issues declares `tracker` too. A tool may declare several: `tracker` is applied first. |
| `capabilities` | What you implement: `ingest.poll`, `ingest.push` (push requires poll), `participation`, `context`, `actions`, `undo`, `idempotent`, `edits`, `identity`. Strato never calls what is not declared, and every declared capability needs its method. |
| `auth` | The official ways to sign in (section 11): their steps, the secrets they store, and what they cannot do (`limits`). |
| `settings` | The account settings you read, with their type and, for the interview, an `ask` question. A setting with a `triage` role feeds triage (section 8). |
| `vocabulary` | Your tool's words for an item, a thread and a conversation, and `targetFormat`: one English sentence that tells a work session how to write a destination, such as "the item's key, such as tickets:OPS-7". |
| `links` | Your links as data (section 9). |
| `hosts` | The hosts of the links you build. The board opens those, and only those, for your keys. |
| `apiHosts` | The hosts your requests may reach. `{settings.baseUrl}` stands for the host of that setting, written as a URL of any scheme (`https://tickets.example`, `imaps://imap.acme.example:993`) or as a bare host with an optional port (`imap.acme.example`). A request elsewhere fails, and the error names a placeholder whose setting names no host. |
| `undoMs` | The undo window, in milliseconds, when `capabilities.undo` is not empty. |
| `maxText` | The longest text an action may carry. |
| `audience` | For a mail or support tool, per text action kind: `{ "reply": { "to": true, "cc": true, "subject": true } }`, or `{ "comment": { "visibility": { "default": "internal" } } }`. A session writes them on its draft task (`audience.to="carol@acme.example, dan@acme.example"`, `audience.cc=…`, `subject=…`, `visibility=public\|internal`), Strato keeps the fields you declare, the board shows them under the draft, the Go covers them, and your `act` receives them in `action.audience` and `action.subject`. A declared `to` or `visibility` is required: a plan without it is refused before your provider is called. |
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
  `value` is at most 64 KiB: room for the ids of an overlap window, not for a copy of the items.

Strato stores the cursor only after every item of the batch is handled, and drops an item it already saw, so returning an item twice is harmless.

A tool whose index lags (a search API that shows a change a minute late) needs an overlap window: read again from a little before the newest item each time, and keep in the cursor the ids already returned within that window, so that the overlap does not return them twice (`examples/providers/github/` reads ten minutes again).

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
  link: "https://tickets.example/t/OPS-7",   // "" when the tool has no link
  mentionsMe: true,                // the person, or one of their groups, is mentioned, or the item targets them
  targetsOther: false,             // someone else is explicitly targeted, and not the person
  reason: "mentioned"              // optional: assigned, review_requested, mentioned, subscribed, watched
}
```

`event: "assigned"` covers every event that asks the person to act: an assignment, a review request (with `reason: "review_requested"`).
`reason` is informative, except `subscribed`, which triage reads as a thread the person follows (section 8).

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

**How a text becomes an action.** A session writes a text task with a destination: a key (`to=`) or, for a module with `parseTarget`, words (`draftTo=`).
Strato reads a key in this order, and the first rule that applies decides the target's scope and the text's action kind:

| Rule | Scope | Action |
| --- | --- | --- |
| your `threadInfo` reads the native id as a thread | `thread` | `reply` |
| your `kinds` include `tracker` | `ticket` | `comment` |
| your `kinds` include `mail` | `thread` (an email thread) | `reply` |
| none of these | `conversation` | `post` (a separate message) |

A `parseTarget` result gives its scope directly.
Declare the action kinds these rules lead to: declaring `threadInfo` on a tracker turns its texts into replies, and a `chat` executable, which has no `threadInfo`, only ever receives `post`.
The harness fails a declared `post`, `reply` or `comment` that no task reaches, and says which rule sent the text elsewhere.

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
Strato shows a module's text as plain text, escaped by Strato: a provider never sends HTML to the board, so implement `render.plain` only (`render.html` exists for the built-in providers).

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
| 401, or any answer that says the credential itself is refused (revoked, expired) | `fatal: true`: the account needs setup again, Strato stops calling it. |
| 403 that is a rate limit (GitHub sends `x-ratelimit-remaining: 0` or `retry-after` with a 403) | `code: "rate_limited"`, `retryable: true`, `retryAfterMs`. |
| 403 on one resource (a repository or a project the credential was not given) | `code: "forbidden"`, not fatal: the account keeps working elsewhere. |
| 404 | `code: "not_found"`. |
| 429 | `code: "rate_limited"`, `retryable: true`, `retryAfterMs` from `Retry-After`. |
| 5xx | `retryable: true`. |
| A timeout or a network failure | `retryable: true`. |
| A write that may or may not have happened | `outcome: "unknown"`, which is also the default: Strato then asks the person to check, and never retries it by itself. Say `outcome: "none"` only when you are sure nothing was written. |

## 8. Triage: how your facts become a request

Strato classifies each item; you supply facts and settings, never rules.
The kinds keep the stored names Strato writes in its event log; a fixture may use either the stored name or the English one.

| Kind (stored) | English name | When | Where it goes |
| --- | --- | --- | --- |
| `suite`, `moi` | `followup`, `mine` | the item is in the thread of an open topic (by someone else, by the person) | the topic's session |
| `dm` | `dm` | `conversation.kind` is `dm`, or `group` without someone else targeted | raised |
| `mention` | `mention` | `mentionsMe` | raised |
| `canal` | `watched` | the conversation is in a `watch` setting | raised |
| `fil` | `thread` | a thread the person took part in (`participated`), or one they follow (`reason: "subscribed"`) | raised |
| `tiers` | `others` | one of the above, but `targetsOther` | the digest |
| `bot` | `bot` | the author is in an `ignoreAuthors` setting, or `isBot` on a ticket without `mentionsMe` | the digest |

A `status` event outside an open topic is ignored, and so is anything the person wrote.
Settings feed the rules through their `triage` role: `me` (the person's id), `groups`, `watch`, `ignore`, `ignoreAuthors`, `teammates`.
Triage itself never compares ids: `mentionsMe`, `isMe` and `targetsOther` are your facts, computed with `ctx.identity` (what `connect` returned).
A `me` setting is only needed when `connect` cannot tell who the person is; when set, it replaces `identity.me` in `ctx.identity`, and the `groups` settings add to `identity.groups`.

For a ticket tool, a worked mapping: a comment that mentions the person is a `mention`; a new issue in a watched project is a `canal`; a comment on an issue they commented is a `fil`.

For a mail tool, a worked mapping (`examples/providers/email/`):

| The message | `mentionsMe` | `targetsOther` | `reason` | Kind |
| --- | --- | --- | --- | --- |
| the person, or an alias, in `To` | true | false | `mentioned` | `mention` |
| the person only in `Cc`, someone else in `To` | false | true | `subscribed` | `tiers` |
| the person only in `Cc`, no one else in `To` | false | false | `subscribed` | `fil` |
| on a list whose `List-Id` is in `watch`, not to the person | false | true when `To` names people other than the list | `watched` | `canal` or `tiers` |

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
`replies`, `complete`, `setup.detect` and `setup.check` may answer -32601: Strato stops asking for that process, and a connect goes on with nothing detected and nothing to check.

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

| `kind` | For | Example |
| --- | --- | --- |
| `api-key` | a key or a personal access token the person creates in the tool's settings and pastes | a ticket tool's API key, a GitHub fine-grained token |
| `app-password` | a password the tool generates for one program | an IMAP and SMTP app password |
| `user-token` | a token issued to an app the person creates in the tool | a Slack app's user token |
| `oauth2` | the authorization code flow on a loopback redirect, with PKCE where supported | Linear's OAuth |

`scopes` are informative: setup prints them, and Strato does not check them, since many tools do not say which scopes a token holds.
A provider that can tell reports a missing scope from `setup.check`, as a `missing` line.

A secret in `stores` may name `env`, environment variables Strato also reads it from, for the account named `default` only and only when its secret file does not hold it.
Strato reads them in its own environment and hands the value over like any secret (`ctx.secret`, or `initialize` for an executable): your provider never reads its environment, which Strato keeps minimal for an executable.

## 12. Testing

`strato provider test <id | path>` runs the conformance harness offline, on a throwaway state folder.
By path, it runs the code there as it is: that is how you test a provider before trusting it.
By id, it runs a configured provider only as the person trusted it; an untrusted or changed folder is refused, with the path form to use instead.

- Every request goes through `ctx.fetch` or `http.fetch` and is answered from `fixtures/*.json` (one run per file); the process's own global `fetch` is refused, and a request no fixture matches fails the run.
- Secrets come from the fixture, never from the person's files.
- Writes go only through Strato's gate: a dry run for each action kind a task can carry, then a real act against the fake, then its undo.
  The real act runs only once the provider was seen talking through the fake (its `connect` or its `poll` made requests there).
- Each fixture file is a run of its own: an executable is started again for it, with that file's `settings` and `secrets`.

What the harness asks, so you can write the matching URLs:

- `connect`, then, with the identity it returned in `ctx.identity` as Strato does, `poll` with `cursor: null`, `since: 0` (1970-01-01) and `maxItems: 50`; then a poll from the cursor that one returned, with the same `since` and `maxItems`.
  With two items or more, a poll with `maxItems: 1`, then a poll from its cursor with `maxItems: 50`.
  Your later polls reuse your own cursor, so their URLs carry what you put in it: for a query with a date, use `queryContains` (below).
- `context` on the fixture's `act.thread`, else on the first thread a poll returned, with `max: 50`.
- A text task to that thread's key: `kind=draft`, text `"Strato conformance check"` unless `act.text` gives one, with `act.audience` and `act.subject` when your tool declares an audience.
  When you declare `post`, a second text task to the key of that thread's conversation.
  Then `act=setStatus value=<act.status or "Done">` and `act=assign value=<act.assignee or "me">` when declared.
- For each: a dry run, a real act, its undo, then the same act again as a second attempt (idempotency key ending `#2`) while every request that writes times out.

A fixture file:

```json
{
  "secrets": { "TICKETS_API_KEY": "test-key" },
  "settings": { "me": "u-alice", "watch": ["OPS"] },
  "exchanges": [
    { "request": { "method": "GET", "url": "https://tickets.example/api/activity" }, "response": { "body": [] }, "repeat": true },
    { "request": { "method": "GET", "url": "https://tickets.example/api/search", "queryContains": ["q=assignee:me"] }, "response": { "body": [], "headers": { "link": "<https://tickets.example/api/search?page=2>; rel=\"next\"" } }, "repeat": true },
    { "request": { "method": "POST", "url": "https://tickets.example/api/threads/OPS-7/comments", "bodyContains": ["Strato conformance check"] }, "response": { "status": 201, "body": { "id": "c-1" } } }
  ],
  "expect": {
    "items": [{ "id": "a-1", "kind": "mention" }, { "id": "a-2", "kind": null, "rules": { "watch": [] } }, { "id": "a-4", "kind": "watched" }],
    "targets": [{ "draftTo": "OPS-7", "target": { "scope": "ticket", "native": "OPS-7" } }],
    "push": ["a-3"]
  },
  "act": { "thread": "OPS-7", "text": "Strato conformance check" },
  "errors": [{ "name": "403 on one project", "response": { "status": 403, "body": { "error": "forbidden" } }, "expect": { "fatal": false, "code": "forbidden" } }]
}
```

Matching: the method, then the URL (scheme, host, path, and the query as a set of decoded pairs), then the body, compared as canonical JSON with `body` or by substrings with `bodyContains`.
With `queryContains`, the query is matched by those substrings of its decoded text (`q=assignee:me updated:>=2026-09-21`) instead of as a whole: use it for a list endpoint whose query carries a date or a cursor.
Headers are not matched, since they carry secrets.
A response gives `status` (200 by default), `body` (JSON, or a string sent as text) and `headers` (a pagination `link`, a `retry-after`).
An exchange answers once unless it says `"repeat": true`: the poll checks poll several times, so give your list endpoints `repeat`.
An exchange that answers once and is never reached fails the network check, so a fixture cannot go unused silently (the writes are not counted when the acts were not verifiable offline).
A GET, or an exchange marked `"safe": true`, writes nothing: the only requests a dry run may make, and the only ones answered while the timeout check times out the writes.
`act` names the thread, the text, the `status` and `assignee` values, and for a tool that declares an audience the `audience` (`{ "to": [...], "cc": [...], "visibility": "internal" }`) and `subject` of the sample task.
`errors` adds cases to the errors check: every request is answered with `response`, then a read (a poll, else `connect`) must fail as `expect` says: `fatal`, `retryable`, `retryAfterMs: true` (a positive wait), `code`.
`expect.push` lists the ids of the items a subscription delivers while the push check listens, in order; leave it out for a provider that does not push.

| Check | What it verifies |
| --- | --- |
| descriptor | the schema, official auth kinds, English labels, hosts, `ask` on triage settings, push with poll, link patterns that compile and do not stall |
| protocol (executables) | an unknown method answers -32601 |
| connect | an identity with `me` |
| poll | required fields, oldest first, a cursor value of at most 64 KiB; polling again from the cursor returns nothing already returned; a capped poll (`maxItems: 1`) then a poll from its cursor comes back complete |
| links | `of` then `parse` gives back every polled thread |
| keys | the key of every polled thread reads back as that thread, in its one stored form; the line shows the keys |
| triage | each `expect.items` entry gets its kind (stored or English name) |
| context | the shape `strato context` checks before printing (a conversation label, `complete`, items with id, author, time and text), items oldest first |
| text | no control characters in ids and names, texts under 1 MiB |
| targets (modules) | `parseTarget` on each `expect.targets` sample |
| act, dry | a dry result through the gate, and no request that writes |
| act | the write carries the text and, for an idempotent kind, the idempotency key |
| act (unreached) | every declared `post`, `reply` and `comment` is reached by a task; otherwise a fail that names the rule of "How a text becomes an action" that sent the text elsewhere |
| undo | the act is undone through the gate |
| act, timeout | a write that times out never says `outcome: "none"`; reads are answered, so a provider that reads before it writes reaches its write; skipped when no write was attempted |
| errors | a 401 is fatal, a 429 is retryable with `retryAfterMs`, a timeout is retryable; then each of the fixture's `errors` cases |
| push | a subscription delivers items and says how it ended; with `expect.push`, the ids it delivered, in order |
| network | every request matched a fixture, and every exchange that answers once was reached |

Each line says `ok`, `fail` with the reason, `skip`, or `not verifiable offline`: a provider that returned items without any request through the fake opened its own connection, which the harness cannot see, so it runs no real act for it; neither does it for a provider whose `connect` and `poll` made no request through the fake.
A provider that reads through the fake but writes on a connection of its own is caught only after its write: its act line fails, since no write reached the fake.
The exit code is 1 on any failure.

`--trace` adds `trace` lines: each call Strato makes to your provider with its parameters and its answer (an `act` with its kind, target, audience and idempotency key), each request your provider made with its body, and an executable's stderr and `log` notifications, secrets masked.

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
- **Secrets.** Only the secrets your auth method declares, from the account's own file (or, for the default account, an `env` variable Strato reads in its own environment, section 11); never in `config.json`, never passed to your provider in an argument or an environment variable, masked in logs.

## 14. Checklist

- `strato provider test` passes, with fixtures recorded from your tool's real answers, trimmed of secrets and of anyone's messages.
- Every declared capability is implemented, and nothing else is declared.
- Errors follow section 7; a write never claims `outcome: "none"` unless nothing was sent.
- `act` honors `dryRun` and, when declared, `idempotencyKey`.
- Links round-trip; patterns are anchored and simple.
- No text on stdout but protocol messages (executables); no global `fetch` (modules).
