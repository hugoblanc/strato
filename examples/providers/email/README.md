# Email

A Strato provider for any mailbox reachable over IMAP and SMTP, written as an executable in Python 3, standard library only.
It reads the unread mail written to you, gives a work session the whole email thread, and sends a reply in that thread when you give a Go on its exact text.

| Step | What it does |
| --- | --- |
| Ingest | Polls the inbox over IMAP for unread messages addressed to you (To or Cc, your address or one of your aliases), plus every message of the mailing lists you watch. |
| Context | Rebuilds a thread from the `References` and `In-Reply-To` headers, across the inbox and the Sent folder. |
| Act | Replies in a thread over SMTP, only when Strato's gate calls it after your Go. |
| Links | A Gmail search link per Message-ID (see "Links"). |
| Auth | Your IMAP and SMTP login with an app password. |

It needs Python 3.9 or later.

## Install it

1. Copy this folder where you keep providers, for example `<state>/providers/email/`, and add it to `<state>/config.json`:

   ```json
   {
     "providers": {
       "email": {
         "source": { "exec": ["python3", "provider.py"] }
       }
     }
   }
   ```

   A relative path is read from `<state>/providers/email/`.
2. Read `provider.py`, then trust it, in your own terminal: `strato provider trust email`.
   Any later change to this folder needs a new trust.
3. Create an app password (next section), then connect: `strato setup --connect email`.
   Setup asks for your address, your servers and the app password, and checks them with a real IMAP login before storing anything.

## The app password

An app password is a password your mail provider generates for one program, next to your real password.
It is the only sign-in this provider uses: it never asks for your real password, and never reads a session out of a browser.
Most providers offer one only once two-step verification is on.

| Provider | Where to create it | IMAP server | SMTP server |
| --- | --- | --- | --- |
| Gmail, Google Workspace | <https://myaccount.google.com/apppasswords> (help: <https://support.google.com/accounts/answer/185833>) | `imaps://imap.gmail.com` | `smtps://smtp.gmail.com` |
| Fastmail | Settings, Privacy and Security, App passwords (help: <https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords>) | `imaps://imap.fastmail.com` | `smtps://smtp.fastmail.com` |
| iCloud Mail | <https://account.apple.com>, Sign-In and Security, App-Specific Passwords (help: <https://support.apple.com/en-us/102654>) | `imaps://imap.mail.me.com` | `smtp://smtp.mail.me.com:587` |
| Yahoo Mail | Account security, Generate app password (help: <https://help.yahoo.com/kb/SLN15241.html>) | `imaps://imap.mail.yahoo.com` | `smtps://smtp.mail.yahoo.com` |

Outlook.com and Microsoft 365 are retiring password sign-in for IMAP and SMTP in favor of OAuth 2.0, which this provider does not implement.

Setup stores the app password in the account's secret file, readable by you only.
You can instead set it in the environment Strato runs in, as `STRATO_EMAIL_APP_PASSWORD`: Strato reads it there, when the secret file has none, and hands it to the provider at start.
The provider itself never reads its own environment, which Strato keeps minimal, and never receives the password in an argument.
Strato reads that variable for the account named `default` only, so a second mailbox always goes through setup.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `address` | Your address. It is your id for triage, and the `From` of your replies. | required |
| `name` | The name your replies carry. | none |
| `login` | The IMAP and SMTP login, when it is not your address (iCloud uses the part before the `@` for IMAP on some accounts). | the address |
| `imapServer` | `imaps://host[:port]`: IMAP over TLS, port 993 by default. A bare host (`imap.acme.example`) is read as `imaps://`. | required |
| `smtpServer` | `smtps://host[:port]` for TLS (465 by default), or `smtp://host[:port]` for STARTTLS (587 by default). A bare host is read as `smtps://`. Plain-text connections are never made. | required |
| `mailbox` | The folder new mail is read from. | `INBOX` |
| `sentFolder` | The Sent folder, read for context. | the folder the server flags `\Sent` |
| `saveSent` | Copy each reply into the Sent folder. Gmail files SMTP mail there by itself: turn it on only if your provider does not, or you get two copies. | `false` |
| `aliases` | Your other addresses and team aliases (`support@acme.example`): mail to them counts as mail to you. | none |
| `watch` | The `List-Id` of the mailing lists whose every message is a request for you (`ops.acme.example`). | none |
| `ignoreAuthors` | Sender addresses set aside in the digest (notifications, robots). | none |

Both server settings feed the descriptor's `apiHosts` (`{settings.imapServer}`, `{settings.smtpServer}`), so `strato provider trust` shows which hosts the provider reaches; the provider opens its own IMAP and SMTP connections to them (see "Fixture mode").

## What reaches Strato

The provider reads without changing anything: it opens the folder with `EXAMINE` (read only) and fetches with `BODY.PEEK`, so nothing is marked as read.

A poll asks the server for the unread UIDs past its cursor (`<UIDVALIDITY>:<last UID>`), reads their headers newest first, and fetches the body of the messages it keeps only.
A first poll stops at the first message older than Strato's `since`.
One poll reads at most 1,000 unread headers: older unread mail is then dropped, as Strato asks of a capped pass.
When the folder is rebuilt (another `UIDVALIDITY`), the next poll reads again from the cursor's time.

Each kept message becomes one item, with these facts for triage:

| The message | `mentionsMe` | `targetsOther` | `reason` | Strato's usual verdict |
| --- | --- | --- | --- | --- |
| You, or an alias, in `To` | true | false | `mentioned` | raised |
| You only in `Cc`, someone else in `To` | false | true | `subscribed` | the digest |
| You only in `Cc`, no one else in `To` | false | false | `subscribed` | raised |
| On a watched list, not to you | false | true when `To` names people other than the list | `watched` | raised, or the digest |
| Anything else (newsletters, Bcc) | not ingested | | | |

The author is marked as a robot when the message says `Auto-Submitted`, `Precedence: bulk` or `list`, or carries `List-Unsubscribe`.
The item's text is the first `text/plain` part (else the HTML made plain), without the text it quotes (lines starting with `>`, and what follows "On ... wrote:").

## Threads and keys

An email thread's native id is the Message-ID of its first email, without angle brackets: the first id of `References`, else `In-Reply-To`, else the message's own Message-ID.
Its key is `email:<that id>`, such as `email:CA1234.5678@mail.acme.example`.
A message with no Message-ID gets `uid-<UIDVALIDITY>-<UID>`, a thread of its own.
A reply that carries only `In-Reply-To`, pointing to a message that is not the first one, starts a separate thread: mail clients that drop `References` are rare.

Ids come from other people's headers, so the provider only accepts printable ASCII without spaces, quotes nor backslashes in them before they reach an IMAP command.

## Links

IMAP has no web link to a message, so this provider uses one scheme, documented here:

```
https://mail.google.com/mail/u/0/#search/rfc822msgid:<Message-ID>
```

It opens the message in Gmail, and in any Google Workspace mailbox, for the first signed-in account.
Pasted on the board, such a link (with `u/<n>/` or without, `:` or `%3A`) reads back as the thread of that Message-ID.
With another provider the link opens Gmail and finds nothing: search the Message-ID in your own mail client instead.
Ids with characters outside `A-Z a-z 0-9 . _ + = -` before the `@` get no link at all.

## Replies

A key of a mail tool names an email thread, so a text task on it arrives from Strato as a `reply` in that thread.
It never starts a new email, and has no other action.

- The reply answers the newest message of the thread: `In-Reply-To` is that message, `References` is its chain plus that message, the subject is `Re:` and the thread's subject unless the task gives one.
- Recipients: the descriptor declares an `audience` (`to`, `cc`, `subject`), so every reply names its recipients.
  A session writes them on the task: `strato task <topic> add kind=draft to=email:<thread id> draft="…" audience.to="carol@acme.example" audience.cc="dan@acme.example"`.
  The board shows them under the draft before the Go, the Go covers them, and the reply goes to exactly those: never a default, never a reply-all.
  A plan without `audience.to` is refused by Strato's gate before the provider is called.
- Idempotent: the Message-ID is derived from Strato's idempotency key, and the provider records each key it sent in its store; a replay of the same Go sends nothing.
  A send cut in the middle is reported with `outcome: "unknown"`, and a replay then asks you to check the Sent folder rather than send again.
- No undo: SMTP cannot take back a message.
- `outcome: "none"` only when the server refused the message (login, sender or recipients refused, data rejected), or nothing was sent.

## Fixture mode

IMAP and SMTP are not HTTP, so every mail operation goes through a transport.
The real one opens IMAP and SMTP connections itself.
Under `strato provider test`, where `initialize` says `offline: true`, the provider uses the other one: each IMAP or SMTP operation becomes one `http.fetch` request to the account's own servers, answered from `fixtures/*.json`.
The real transport is never used offline, and the fixture one never online.
The harness thus checks everything but the bytes of IMAP and SMTP themselves: parsing, threading, triage facts, the cursor, the reply's headers, and the gate.

| Operation | Request | Answer |
| --- | --- | --- |
| `LOGIN` | `GET https://<imap host>/imap/login` (Basic authorization) | `{}`, or 401 when refused |
| `LIST` | `GET /imap/list` | `{ "mailboxes": [{ "name", "flags" }] }` |
| `STATUS` and `EXAMINE` | `GET /imap/examine?mailbox=<name>` | `{ "uidvalidity", "uidnext" }` |
| `UID SEARCH` | `GET /imap/search?mailbox=<name>&criteria=<the IMAP search criteria>` | `{ "uids": [...] }` |
| `UID FETCH` | `GET /imap/fetch?mailbox=<name>&uids=<43,42>&part=<header or full>` | `{ "messages": [{ "uid", "internalDate" (Unix ms), "raw" or "rawBase64" }] }` |
| SMTP `MAIL`, `RCPT`, `DATA` | `POST https://<smtp host>/smtp/send` with `{ from, rcpt, idempotencyKey, raw }` | `{ "queued" }` |
| `APPEND` | `POST /imap/append?mailbox=<name>` with `{ raw }` | `{}` |

`raw` is the RFC 5322 message as text, with plain line feeds.
`test_provider.py` covers what the harness cannot reach, with `smtplib` replaced by a fake: the real SMTP transport (STARTTLS, login, one message) and the recipients of a reply; run `python3 -m unittest` in this folder.

Run the harness from a Strato checkout:

```bash
STRATO_STATE="$(mktemp -d)" strato provider test path/to/email
```

Each fixture file starts the provider again, with that file's `settings` and `secrets`: `alias-encoded.json` gives the IMAP server as a bare host.
Each file's `act.audience` gives the recipients of the harness's sample reply.

## Limits

- Poll only, no push (IMAP `IDLE` would need a second connection held open).
- A request runs single-threaded: each IMAP or SMTP operation times out after 15 seconds, so a slow server makes a call fail and retry rather than hang.
- Mail is fetched up to its first 256 KiB: enough for the text of nearly every message, never the attachments.
- No OAuth 2.0, so no Outlook.com nor Microsoft 365.
