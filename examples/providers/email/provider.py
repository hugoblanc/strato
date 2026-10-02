#!/usr/bin/env python3
"""Email: a Strato provider for any mailbox reachable over IMAP and SMTP, standard library only.

Ingest: the unread messages of the inbox that are addressed to the person (To or Cc, theirs or an alias), plus the
messages of the mailing lists they watch. Context: a whole email thread, rebuilt from the References and In-Reply-To
headers across the inbox and the Sent folder. Act: a reply in a thread, sent over SMTP, only when Strato's gate calls
`act` after the person's Go on that exact text and those exact recipients.

The mail protocols are not HTTP, so every mail operation goes through a transport:

- ImapSmtp opens real IMAP (TLS, port 993) and SMTP (TLS or STARTTLS) connections with the app password;
- Fixture mirrors each of those operations as one `http.fetch` request to the account's own hosts, answered by the
  conformance harness from fixtures/*.json. It is used only when `initialize` says `offline: true`, and the real one
  never is then, so the harness checks the whole provider except the wire format of IMAP and SMTP.

Reads never change the mailbox: the inbox is opened with EXAMINE (read only) and bodies are fetched with BODY.PEEK,
so polling does not mark anything as read.

Protocol: JSON-RPC 2.0, one message per line on stdin and stdout. Stdout carries protocol messages only; logs go to
stderr. The guide: `strato provider guide`. The message types: strato-provider.d.ts (`strato provider types`).
"""
import base64
import calendar
import email
import email.header
import email.policy
import email.utils
import hashlib
import html.parser
import imaplib
import json
import re
import smtplib
import ssl
import sys
import time
import urllib.parse
from email.message import EmailMessage

SECRET = "EMAIL_APP_PASSWORD"
SECRET_ENV = "STRATO_EMAIL_APP_PASSWORD"
LINK_HOST = "mail.google.com"
# One socket operation never waits longer than this, so a request answers before Strato's own timeout (20 s for connect).
SOCKET_TIMEOUT = 15
# The first bytes of a message that ingest and context read: the text is at the start, attachments come after it.
FETCH_BYTES = 262144
FETCH_BATCH = 25
# At most this many unread headers are read in one poll; older unread mail is then dropped, as a capped pass does.
SCAN_LIMIT = 1000
MAX_TEXT = 100000
ITEM_TEXT = 20000
SENT_KEEP = 300


def text(en, fr):
    return {"en": en, "fr": fr}


DESCRIPTOR = {
    "id": "email",
    "label": text("Email", "E-mail"),
    "api": {"min": 1, "max": 1},
    "kinds": ["mail"],
    "capabilities": {
        "ingest": {"push": False, "poll": True},
        "participation": False,
        "context": True,
        "actions": ["reply"],
        "undo": [],
        "idempotent": ["reply"],
        "edits": False,
        "identity": False,
    },
    "auth": [
        {
            "id": "app-password",
            "kind": "app-password",
            "label": text("App password (IMAP and SMTP)", "Mot de passe d'application (IMAP et SMTP)"),
            "tradeoff": text(
                "Works with any mailbox that offers app passwords; it can read and send all of that mailbox's mail.",
                "Marche avec toute boîte qui propose des mots de passe d'application ; il peut lire et envoyer tout le courrier de cette boîte.",
            ),
            "docs": "https://support.google.com/accounts/answer/185833",
            "steps": [
                {
                    "kind": "open",
                    "url": "https://myaccount.google.com/apppasswords",
                    "say": text(
                        "Create an app password for this mailbox (Gmail here; Fastmail, iCloud and Yahoo pages are in the provider's README)",
                        "Créez un mot de passe d'application pour cette boîte (Gmail ici ; les pages Fastmail, iCloud et Yahoo sont dans le README du provider)",
                    ),
                },
                {
                    "kind": "paste",
                    "secret": SECRET,
                    "say": text("Paste the app password (it is not shown)", "Collez le mot de passe d'application (il ne s'affiche pas)"),
                },
                {"kind": "verify"},
            ],
            "stores": [{"name": SECRET, "env": [SECRET_ENV]}],
        }
    ],
    "settings": [
        {
            "key": "address",
            "type": "string",
            "label": text("Your email address", "Votre adresse e-mail"),
            "ask": text("What is your email address?", "Quelle est votre adresse e-mail ?"),
            "triage": "me",
        },
        {
            "key": "name",
            "type": "string",
            "label": text("Your name, as recipients see it", "Votre nom, tel que les destinataires le voient"),
            "default": "",
            "ask": text("Which name should your replies carry?", "Quel nom vos réponses doivent-elles porter ?"),
        },
        {
            "key": "login",
            "type": "string",
            "label": text("IMAP and SMTP login (default: the address)", "Identifiant IMAP et SMTP (par défaut : l'adresse)"),
            "default": "",
            "ask": text("What is your mail login, if it is not your address?", "Quel est votre identifiant mail, s'il n'est pas votre adresse ?"),
        },
        {
            "key": "imapServer",
            "type": "string",
            "label": text("IMAP server, as imaps://host[:port]", "Serveur IMAP, sous la forme imaps://hôte[:port]"),
            "ask": text(
                "What is your IMAP server (imaps://imap.gmail.com, imaps://imap.fastmail.com)?",
                "Quel est votre serveur IMAP (imaps://imap.gmail.com, imaps://imap.fastmail.com) ?",
            ),
        },
        {
            "key": "smtpServer",
            "type": "string",
            "label": text(
                "SMTP server: smtps://host (TLS, port 465) or smtp://host:587 (STARTTLS)",
                "Serveur SMTP : smtps://hôte (TLS, port 465) ou smtp://hôte:587 (STARTTLS)",
            ),
            "ask": text(
                "What is your SMTP server (smtps://smtp.gmail.com, smtp://smtp.mail.me.com:587)?",
                "Quel est votre serveur SMTP (smtps://smtp.gmail.com, smtp://smtp.mail.me.com:587) ?",
            ),
        },
        {"key": "mailbox", "type": "string", "label": text("Folder to read new mail from", "Dossier où lire le nouveau courrier"), "default": "INBOX"},
        {
            "key": "sentFolder",
            "type": "string",
            "label": text("Sent folder (default: the one the server marks as Sent)", "Dossier des envoyés (par défaut : celui que le serveur marque comme tel)"),
            "default": "",
        },
        {
            "key": "saveSent",
            "type": "boolean",
            "label": text(
                "Copy each reply into the Sent folder (off for Gmail, which does it by itself)",
                "Copier chaque réponse dans les envoyés (désactivé pour Gmail, qui le fait seul)",
            ),
            "default": False,
        },
        {
            "key": "aliases",
            "type": "string[]",
            "label": text("Your other addresses and team aliases", "Vos autres adresses et alias d'équipe"),
            "default": [],
            "ask": text(
                "Which other addresses or team aliases count as writing to you (support@acme.example)?",
                "Quelles autres adresses ou quels alias d'équipe valent un message pour vous (support@acme.example) ?",
            ),
            "triage": "groups",
        },
        {
            "key": "watch",
            "type": "string[]",
            "label": text("Watched mailing lists (List-Id)", "Listes de diffusion suivies (List-Id)"),
            "default": [],
            "ask": text(
                "Which mailing lists (their List-Id, such as ops.acme.example) should raise every message?",
                "Quelles listes de diffusion (leur List-Id, comme ops.acme.example) doivent remonter chaque message ?",
            ),
            "triage": "watch",
        },
        {
            "key": "ignoreAuthors",
            "type": "string[]",
            "label": text("Senders to set aside", "Expéditeurs à mettre de côté"),
            "default": [],
            "ask": text(
                "Which sender addresses (notifications, robots) do you not need to read?",
                "Quelles adresses d'expéditeurs (notifications, robots) n'avez-vous pas besoin de lire ?",
            ),
            "triage": "ignoreAuthors",
        },
    ],
    "vocabulary": {
        "item": text("email", "e-mail"),
        "thread": text("email thread", "fil d'e-mails"),
        "conversation": text("mailbox", "boîte"),
        "targetFormat": "the email thread's key, which is the Message-ID of its first email without angle brackets, such as email:CA1234.5678@mail.acme.example",
        "targetHint": "email thread",
    },
    "links": {
        "parse": [
            {
                "host": LINK_HOST,
                "pattern": "^/mail/(?:u/[0-9]{1,2}/)?#search/rfc822msgid(?::|%3[Aa])([A-Za-z0-9._+=-]{1,200}@[A-Za-z0-9.-]{1,200})$",
                "thread": "$1",
            }
        ],
        "of": [{"match": "^([A-Za-z0-9._+=-]{1,200}@[A-Za-z0-9.-]{1,200})$", "url": "https://" + LINK_HOST + "/mail/u/0/#search/rfc822msgid:$1"}],
    },
    "hosts": [LINK_HOST],
    "apiHosts": ["{settings.imapServer}", "{settings.smtpServer}"],
    "maxText": MAX_TEXT,
    # every reply names its recipients: the person sees them before the Go, and the reply goes to exactly those
    "audience": {"reply": {"to": True, "cc": True, "subject": True}},
}

state = {"secrets": {}, "settings": {}, "offline": False, "next": 1}


# ------------------------------------------------------------------ protocol plumbing


class ProviderError(Exception):
    """An error Strato reads: a JSON-RPC code, and a ProviderError in data (code, retryable, fatal, retryAfterMs, outcome)."""

    def __init__(self, rpc, code, message, retryable=False, fatal=False, retry_after_ms=None, outcome=None):
        super().__init__(message)
        self.rpc = rpc
        self.data = {"code": code, "message": message, "retryable": retryable, "fatal": fatal}
        if retry_after_ms is not None:
            self.data["retryAfterMs"] = retry_after_ms
        if outcome is not None:
            self.data["outcome"] = outcome


def auth_error(message):
    return ProviderError(-32002, "invalid_auth", message, fatal=True, outcome="none")


def send(message):
    sys.stdout.write(json.dumps(dict({"jsonrpc": "2.0"}, **message)) + "\n")
    sys.stdout.flush()


def log(level, message):
    sys.stderr.write("%s %s\n" % (level, message))
    sys.stderr.flush()


def ask_strato(method, params):
    """A request to Strato, answered while Strato's own request is pending."""
    rid = "p%d" % state["next"]
    state["next"] += 1
    send({"id": rid, "method": method, "params": params})
    while True:
        line = sys.stdin.readline()
        if not line:
            sys.exit(0)
        if not line.strip():
            continue
        message = json.loads(line)
        if message.get("id") == rid and "method" not in message:
            if "error" in message:
                error = message["error"]
                data = error.get("data") or {}
                raise ProviderError(
                    -32000,
                    data.get("code") or "host",
                    error.get("message", ""),
                    retryable=bool(data.get("retryable")),
                    fatal=bool(data.get("fatal")),
                    retry_after_ms=data.get("retryAfterMs"),
                )
            return message["result"]
        # a notification ($/cancel) while waiting: a single-threaded provider finishes its request instead


def store_read(name, fallback):
    answer = ask_strato("store.read", {"name": name})
    if not answer or answer.get("value") is None:
        return fallback
    return answer["value"]


def store_write(name, value):
    ask_strato("store.write", {"name": name, "value": value})


def setting(key, default=None):
    value = state["settings"].get(key)
    return default if value is None or value == "" else value


def my_address():
    return str(setting("address", "")).strip().lower()


def server(key):
    """(scheme, host, port) of a server setting: `imaps://host[:port]`, `smtps://host[:port]` or `smtp://host[:port]`.

    A bare host is read as the TLS scheme of its protocol. Plain-text connections do not exist here: `smtp://` always
    upgrades with STARTTLS, and refuses to log in if the server cannot.
    """
    value = str(setting(key, "")).strip()
    default = "imaps" if key == "imapServer" else "smtps"
    if value and "://" not in value:
        value = default + "://" + value
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        parts, port = None, None
    allowed = ("imaps",) if key == "imapServer" else ("smtps", "smtp")
    if not parts or parts.scheme not in allowed or not parts.hostname or not re.match(r"^[A-Za-z0-9.-]{1,253}$", parts.hostname):
        raise ProviderError(-32002, "missing_setting", "%s is not set, or is not %s://host[:port]" % (key, "/".join(allowed)), fatal=True, outcome="none")
    ports = {"imaps": 993, "smtps": 465, "smtp": 587}
    return parts.scheme, parts.hostname.lower(), port or ports[parts.scheme]


def my_addresses():
    return {a for a in [my_address()] + [str(x).strip().lower() for x in setting("aliases", [])] if a}


# ------------------------------------------------------------------ untrusted header values

# A Message-ID without its angle brackets: printable ASCII without space, quote, backslash nor brackets. Anything else
# is refused before it reaches an IMAP command line, since an id comes from a third party's headers.
MSGID = re.compile(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]{1,250}$")
UID_ID = re.compile(r"^uid-([0-9]{1,10})-([0-9]{1,10})$")
ADDRESS = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def bare_ids(value):
    """The Message-IDs of a References or In-Reply-To header, without brackets, the unusable ones left out."""
    found = re.findall(r"<([^<>\s]{1,250})>", value or "")
    if not found and value and MSGID.match(value.strip().strip("<>")):
        found = [value.strip().strip("<>")]
    return [i for i in found if MSGID.match(i)]


def imap_quote(value):
    """An IMAP quoted string. Values reaching it are checked first; this only guards against a mistake."""
    if CONTROL.search(value) or "\n" in value or "\r" in value:
        raise ProviderError(-32602, "invalid_id", "refused: control characters in an IMAP argument")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def check_address(value):
    """One recipient as the person approved it: a bare address, without name, comment nor line break."""
    name, addr = email.utils.parseaddr(value or "")
    addr = addr.strip()
    if not ADDRESS.match(addr):
        raise ProviderError(-32602, "invalid_recipient", "not an email address: %r" % (value,), outcome="none")
    return addr


def clean(value, limit):
    """Third-party text for Strato: no carriage returns nor control characters, at most `limit` characters."""
    value = CONTROL.sub("", (value or "").replace("\r\n", "\n").replace("\r", "\n"))
    return value[:limit]


def decoded(header):
    """A header as text, encoded words decoded; never raises on a malformed one."""
    if header is None:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(str(header))))
    except Exception:
        return str(header)


# ------------------------------------------------------------------ reading a message


class _Text(html.parser.HTMLParser):
    """The text of an HTML body, for messages that have no text/plain part."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        elif tag in ("br", "p", "div", "tr", "li", "blockquote"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def part_text(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        return payload.decode(part.get_content_charset() or "utf-8", errors="replace")


def body_text(message):
    """The readable text of a message: its first text/plain part, else its HTML made plain."""
    plain = html_part = None
    for part in message.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        kind = part.get_content_type()
        if kind == "text/plain" and plain is None:
            plain = part
        elif kind == "text/html" and html_part is None:
            html_part = part
    if plain is not None:
        return part_text(plain)
    if html_part is not None:
        parser = _Text()
        parser.feed(part_text(html_part))
        return re.sub(r"\n{3,}", "\n\n", "".join(parser.out))
    return ""


QUOTE_HEAD = re.compile(r"^(On .{1,300} wrote:|Le .{1,300} a écrit\s?:|-{2,} ?Original Message ?-{2,}|-{2,} ?Message d'origine ?-{2,})\s*$", re.I)


def without_quotes(value):
    """A reply without the text it quotes: what follows a quote header, and lines starting with `>`."""
    kept = []
    for line in value.split("\n"):
        if QUOTE_HEAD.match(line.strip()):
            break
        if not line.lstrip().startswith(">"):
            kept.append(line)
    out = "\n".join(kept).strip()
    return out or value.strip()


def people(values):
    """(name, lowercase address) of every well-formed address in some address headers."""
    out = []
    for name, addr in email.utils.getaddresses([decoded(v) for v in values if v]):
        addr = addr.strip().lower()
        if ADDRESS.match(addr):
            out.append((name.strip(), addr))
    return out


def read_message(raw, uid, validity, arrived_ms):
    """The facts of one raw RFC 5322 message that items, threads and replies need."""
    message = email.message_from_bytes(raw, policy=email.policy.default)
    own = bare_ids(str(message.get("Message-ID", "")))
    message_id = own[0] if own else "uid-%s-%s" % (validity, uid)
    references = bare_ids(str(message.get("References", "")))
    in_reply_to = bare_ids(str(message.get("In-Reply-To", "")))
    root = references[0] if references else (in_reply_to[0] if in_reply_to else message_id)
    sender = people(message.get_all("From", []))
    list_id = bare_ids(str(message.get("List-Id", "")))
    auto = str(message.get("Auto-Submitted", "no")).strip().lower()
    precedence = str(message.get("Precedence", "")).strip().lower()
    date_ms = arrived_ms
    if not date_ms:
        try:
            date_ms = int(email.utils.parsedate_to_datetime(str(message.get("Date"))).timestamp() * 1000)
        except Exception:
            date_ms = 0
    return {
        "uid": uid,
        "id": message_id,
        "root": root,
        "references": references,
        "inReplyTo": in_reply_to,
        "subject": clean(decoded(message.get("Subject", "")), 998).replace("\n", " "),
        "from": sender[0] if sender else ("", ""),
        "replyTo": people(message.get_all("Reply-To", [])),
        "to": people(message.get_all("To", [])),
        "cc": people(message.get_all("Cc", [])),
        "list": list_id[0].lower() if list_id else "",
        "listPost": [a.lower() for a in re.findall(r"<mailto:([^>?\s]{1,254})", str(message.get("List-Post", "")), re.I)],
        "listName": clean(decoded(message.get("List-Id", "")).split("<")[0].strip().strip('"'), 200).replace("\n", " "),
        "bot": auto not in ("", "no") or precedence in ("bulk", "list", "junk") or message.get("List-Unsubscribe") is not None,
        "text": clean(without_quotes(body_text(message)), MAX_TEXT),
        "time": date_ms,
    }


def link_of(message_id):
    """The Gmail search link of a Message-ID, when the id is a plain one (README, "Links")."""
    if re.match(DESCRIPTOR["links"]["of"][0]["match"], message_id):
        return "https://%s/mail/u/0/#search/rfc822msgid:%s" % (LINK_HOST, message_id)
    return ""


def who(person):
    name, addr = person
    return "%s <%s>" % (name, addr) if name else addr


def item_of(m, mailbox):
    """One message as an item, or None when it is neither addressed to the person nor on a watched list."""
    mine = my_addresses()
    to = {a for _, a in m["to"]}
    cc = {a for _, a in m["cc"]}
    watched = m["list"] and m["list"] in {str(w).strip().lower() for w in setting("watch", [])}
    if not (to | cc) & mine and not watched:
        return None
    name, addr = m["from"]
    on_list = bool(m["list"])
    item = {
        "thread": m["root"],
        "id": m["id"],
        "event": "message",
        "author": {"id": addr, "name": clean(name or addr, 200).replace("\n", " "), "isMe": addr in mine, "isBot": m["bot"]},
        "conversation": {"id": m["list"], "label": m["listName"] or m["list"], "kind": "email"}
        if on_list
        else {"id": mailbox, "label": mailbox, "kind": "email"},
        "title": m["subject"],
        "text": m["text"][:ITEM_TEXT],
        "time": m["time"],
        "link": link_of(m["id"]) or link_of(m["root"]),
    }
    others = to - mine - set(m["listPost"])
    if to & mine:
        # written to the person, or to one of their aliases: it targets them
        item["mentionsMe"], item["targetsOther"], item["reason"] = True, False, "mentioned"
    elif cc & mine:
        # only copied: a thread they follow, raised unless someone else is the one written to
        item["mentionsMe"], item["targetsOther"], item["reason"] = False, bool(others), "subscribed"
    else:
        # a watched list's message: it targets someone only when it names people in To
        item["mentionsMe"], item["targetsOther"], item["reason"] = False, bool(others), "watched"
    return item


# ------------------------------------------------------------------ transports


class ImapSmtp:
    """Real IMAP over TLS and SMTP over TLS or STARTTLS, with the app password. Never used under the harness."""

    def __init__(self):
        self.imap = None
        self.selected = None

    def login_name(self):
        return str(setting("login", "") or my_address())

    def password(self):
        password = state["secrets"].get(SECRET)
        if not password:
            raise auth_error("no app password: run strato setup --connect email, or set %s" % SECRET_ENV)
        return password

    def _imap(self):
        if self.imap is None:
            _, host, port = server("imapServer")
            try:
                self.imap = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=SOCKET_TIMEOUT)
            except (OSError, imaplib.IMAP4.error) as e:
                raise ProviderError(-32000, "network", "IMAP %s: %s" % (host, e), retryable=True)
            try:
                self.imap.login(self.login_name(), self.password())
            except imaplib.IMAP4.error as e:
                said = str(e)
                self.imap = None
                if re.search(r"UNAVAILABLE|THROTTLED|LIMIT|Too many", said, re.I):
                    raise ProviderError(-32003, "rate_limited", "IMAP login: " + said, retryable=True, retry_after_ms=60000)
                raise auth_error("IMAP login refused: " + said)
        return self.imap

    def _call(self, what, run):
        """One IMAP command; a cut connection or a timeout is retryable, a NO or BAD answer is not."""
        try:
            return run(self._imap())
        except ProviderError:
            raise
        except (imaplib.IMAP4.abort, OSError) as e:
            self.close()
            raise ProviderError(-32000, "network", "IMAP %s: %s" % (what, e), retryable=True)
        except imaplib.IMAP4.error as e:
            raise ProviderError(-32000, "imap", "IMAP %s: %s" % (what, e))

    def login(self):
        self._imap()

    def mailboxes(self):
        def run(c):
            typ, data = c.list()
            out = []
            for line in data or []:
                if isinstance(line, tuple):
                    line = line[0] + b" " + line[1]
                found = re.match(rb'^\((?P<flags>[^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?P<name>.+)$', line or b"")
                if found:
                    name = found.group("name").decode("utf-8", "replace").strip()
                    if name.startswith('"') and name.endswith('"'):
                        name = re.sub(r"\\(.)", r"\1", name[1:-1])
                    out.append({"name": name, "flags": found.group("flags").decode("ascii", "replace").split()})
            return out

        return self._call("LIST", run)

    def examine(self, mailbox):
        def run(c):
            typ, data = c.status(imap_quote(mailbox), "(UIDVALIDITY UIDNEXT)")
            line = (data or [b""])[0] or b""
            line = line.decode("ascii", "replace") if isinstance(line, bytes) else str(line)
            validity = re.search(r"UIDVALIDITY (\d+)", line)
            nxt = re.search(r"UIDNEXT (\d+)", line)
            typ, _ = c.select(imap_quote(mailbox), readonly=True)
            if typ != "OK":
                raise ProviderError(-32000, "not_found", "no folder " + mailbox)
            self.selected = mailbox
            return {"uidvalidity": int(validity.group(1)) if validity else 0, "uidnext": int(nxt.group(1)) if nxt else 0}

        return self._call("EXAMINE", run)

    def _select(self, mailbox):
        if self.selected != mailbox:
            self.examine(mailbox)

    def search(self, mailbox, criteria):
        self._select(mailbox)

        def run(c):
            typ, data = c.uid("SEARCH", criteria)
            return [int(u) for u in b" ".join(d for d in data or [] if d).split()]

        return self._call("SEARCH", run)

    def fetch(self, mailbox, uids, part):
        """`part`: "header" for the headers only, "full" for the first FETCH_BYTES of the message. Never sets \\Seen."""
        self._select(mailbox)
        what = "BODY.PEEK[HEADER]" if part == "header" else "BODY.PEEK[]<0.%d>" % FETCH_BYTES

        def run(c):
            typ, data = c.uid("FETCH", ",".join(str(u) for u in uids), "(UID INTERNALDATE %s)" % what)
            out, meta, raw = [], b"", None
            for part in list(data or []) + [None]:
                # a message is a (meta, literal) tuple, then the rest of its meta (the closing parenthesis) as bytes
                if part is None or isinstance(part, tuple):
                    if raw is not None:
                        uid = re.search(rb"UID (\d+)", meta)
                        internal = re.search(rb'INTERNALDATE "([^"]+)"', meta)
                        if uid:
                            out.append({"uid": int(uid.group(1)), "internalDate": internal_ms(internal.group(1).decode()) if internal else 0, "raw": raw})
                    if part is not None:
                        meta, raw = part[0], part[1]
                elif raw is not None:
                    meta += b" " + part
            return out

        return self._call("FETCH", run)

    def append(self, mailbox, raw):
        self._call("APPEND", lambda c: c.append(imap_quote(mailbox), "(\\Seen)", imaplib.Time2Internaldate(time.time()), raw))

    def send(self, sender, recipients, raw, key):
        """Sends over SMTP. Its errors say whether the message may have left: `none` only when the server refused it."""
        scheme, host, port = server("smtpServer")
        context = ssl.create_default_context()
        try:
            if scheme == "smtps":
                smtp = smtplib.SMTP_SSL(host, port, timeout=SOCKET_TIMEOUT, context=context)
            else:
                smtp = smtplib.SMTP(host, port, timeout=SOCKET_TIMEOUT)
                smtp.starttls(context=context)
            smtp.login(self.login_name(), self.password())
        except smtplib.SMTPAuthenticationError as e:
            raise auth_error("SMTP login refused: %s" % (e,))
        except (OSError, smtplib.SMTPException) as e:
            raise ProviderError(-32000, "network", "SMTP %s: %s" % (host, e), retryable=True, outcome="none")
        try:
            refused = smtp.sendmail(sender, recipients, raw)
        except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as e:
            raise ProviderError(-32000, "refused", "SMTP refused the message: %s" % (e,), outcome="none")
        except (OSError, smtplib.SMTPException) as e:
            raise ProviderError(-32000, "network", "SMTP cut while sending: %s" % (e,), retryable=True, outcome="unknown")
        finally:
            try:
                smtp.quit()
            except Exception:
                pass
        if refused:
            log("warn", "SMTP refused some recipients: %s" % ", ".join(sorted(refused)))
        return "250"

    def close(self):
        if self.imap is not None:
            try:
                self.imap.logout()
            except Exception:
                pass
        self.imap = None
        self.selected = None


class Fixture:
    """The same operations as one https request each to the account's hosts, through Strato's `http.fetch`.

    Used only under the conformance harness (`initialize` says `offline: true`), which answers them from
    fixtures/*.json. The README, "Fixture mode", lists the requests.
    """

    def _base(self, key):
        return "https://" + server(key)[1]

    def _request(self, method, base, path, query=None, body=None, writing=False):
        url = self._base(base) + path
        if query:
            url += "?" + urllib.parse.urlencode(query, quote_via=urllib.parse.quote)
        password = state["secrets"].get(SECRET) or ""
        login = str(setting("login", "") or my_address())
        params = {
            "method": method,
            "url": url,
            "headers": {"authorization": "Basic " + base64.b64encode((login + ":" + password).encode()).decode(), "content-type": "application/json"},
        }
        if body is not None:
            params["body"] = json.dumps(body)
        try:
            response = ask_strato("http.fetch", params)
        except ProviderError as e:
            # a timeout or a network failure: retryable, and a write may have happened
            if writing:
                e.data["outcome"] = "unknown"
            raise
        status = response["status"]
        refused = "none" if writing else None
        if status in (401, 403):
            raise ProviderError(-32002, "invalid_auth", "login refused", fatal=True, outcome=refused)
        if status == 429:
            retry = (response.get("headers") or {}).get("retry-after", "60")
            seconds = float(retry) if re.match(r"^[0-9.]+$", retry) else 60
            raise ProviderError(-32003, "rate_limited", "rate limited", retryable=True, retry_after_ms=int(seconds * 1000), outcome=refused)
        if status == 404:
            raise ProviderError(-32000, "not_found", "%s %s: not found" % (method, path), outcome=refused)
        if status >= 500:
            raise ProviderError(-32000, "server", "%s %s: %d" % (method, path, status), retryable=True, outcome="unknown" if writing else None)
        if status >= 400:
            raise ProviderError(-32000, "refused", "%s %s: %d" % (method, path, status), outcome=refused)
        return json.loads(response["body"]) if response.get("body") else {}

    def login(self):
        self._request("GET", "imapServer", "/imap/login")

    def mailboxes(self):
        return self._request("GET", "imapServer", "/imap/list").get("mailboxes", [])

    def examine(self, mailbox):
        return self._request("GET", "imapServer", "/imap/examine", {"mailbox": mailbox})

    def search(self, mailbox, criteria):
        return [int(u) for u in self._request("GET", "imapServer", "/imap/search", {"mailbox": mailbox, "criteria": criteria}).get("uids", [])]

    def fetch(self, mailbox, uids, part):
        answer = self._request("GET", "imapServer", "/imap/fetch", {"mailbox": mailbox, "uids": ",".join(str(u) for u in uids), "part": part})
        out = []
        for m in answer.get("messages", []):
            raw = base64.b64decode(m["rawBase64"]) if "rawBase64" in m else m["raw"].replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
            out.append({"uid": int(m["uid"]), "internalDate": int(m.get("internalDate", 0)), "raw": raw})
        return out

    def append(self, mailbox, raw):
        self._request("POST", "imapServer", "/imap/append", {"mailbox": mailbox}, {"raw": raw.decode("utf-8", "replace")}, writing=True)

    def send(self, sender, recipients, raw, key):
        body = {"from": sender, "rcpt": recipients, "idempotencyKey": key, "raw": raw.decode("utf-8", "replace")}
        return self._request("POST", "smtpServer", "/smtp/send", None, body, writing=True).get("queued", "")

    def close(self):
        pass


def transport():
    return Fixture() if state["offline"] else ImapSmtp()


MONTHS = {m: i + 1 for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def internal_ms(value):
    """An IMAP INTERNALDATE ("17-Jul-1996 02:44:25 -0700") in Unix ms, without the locale-dependent strptime."""
    found = re.match(r"^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$", value)
    if not found or found.group(2).title() not in MONTHS:
        return 0
    d, mon, y, hh, mm, ss, sign, oh, om = found.groups()
    seconds = calendar.timegm((int(y), MONTHS[mon.title()], int(d), int(hh), int(mm), int(ss), 0, 0, 0))
    offset = (int(oh) * 3600 + int(om) * 60) * (1 if sign == "+" else -1)
    return (seconds - offset) * 1000


# ------------------------------------------------------------------ methods


def connect(params):
    t = transport()
    try:
        t.login()
    finally:
        t.close()
    me = my_address()
    if not me:
        raise ProviderError(-32002, "missing_setting", "the address setting is not set", fatal=True)
    domain = me.split("@")[-1]
    aliases = sorted(my_addresses() - {me})
    identity = {"me": me, "name": str(setting("name", "") or me), "workspace": domain}
    if aliases:
        identity["groups"] = aliases
    return identity


def poll(params):
    """The unread messages addressed to the person since the cursor, oldest first; the newest ones when capped.

    The cursor is `<UIDVALIDITY>:<UID>`: the last UID read in the folder. A rebuilt folder (another UIDVALIDITY) is read
    again from the cursor's time. A pass asks for the unread UIDs, reads their headers newest first (stopping at the
    first message older than `since` on a first poll, and after SCAN_LIMIT headers), and fetches the bodies of the
    messages it keeps only.
    """
    started = int(time.time() * 1000)
    mailbox = str(setting("mailbox", "INBOX"))
    cursor = params.get("cursor")
    since = int(params.get("since") or 0)
    max_items = max(0, int(params.get("maxItems") or 0))
    t = transport()
    try:
        box = t.examine(mailbox)
        validity = int(box.get("uidvalidity") or 0)
        last = None
        if cursor:
            v, _, u = str(cursor.get("value", "")).partition(":")
            if v == str(validity) and u.isdigit():
                last = int(u)
            else:
                since = max(since, int(cursor.get("at") or 0))
        criteria = "UNSEEN UID %d:*" % (last + 1) if last is not None else "UNSEEN"
        # `n:*` always includes the newest UID, even below n: keep only what is past the cursor
        uids = sorted({u for u in t.search(mailbox, criteria) if last is None or u > last}, reverse=True)
        kept, scanned, capped, done = [], 0, False, False
        for start in range(0, len(uids), FETCH_BATCH):
            for head in sorted(t.fetch(mailbox, uids[start : start + FETCH_BATCH], "header"), key=lambda r: r["uid"], reverse=True):
                m = read_message(head["raw"], head["uid"], validity, head["internalDate"])
                if last is None and m["time"] <= since:
                    done = True
                    break
                scanned += 1
                if item_of(m, mailbox) is None:
                    continue
                if len(kept) >= max_items:
                    capped = done = True
                    break
                kept.append(head["uid"])
            if done:
                break
            if scanned >= SCAN_LIMIT and start + FETCH_BATCH < len(uids):
                # a huge unread backlog: what is older than this is dropped, as a capped pass does
                capped = True
                break
        items = []
        if kept:
            for raw in t.fetch(mailbox, kept, "full"):
                item = item_of(read_message(raw["raw"], raw["uid"], validity, raw["internalDate"]), mailbox)
                if item is not None:
                    items.append((raw["uid"], item))
    finally:
        t.close()
    items.sort(key=lambda pair: pair[0])
    if capped:
        # older backlog is dropped on purpose: the cursor is the oldest item kept, else the newest UID read
        oldest_uid = items[0][0] if items else uids[0]
        at = items[0][1]["time"] if items else started
        return {"items": [i for _, i in items], "cursor": {"value": "%d:%d" % (validity, oldest_uid), "at": at}, "complete": False}
    newest = max([last or 0, int(box.get("uidnext") or 1) - 1] + uids)
    return {"items": [i for _, i in items], "cursor": {"value": "%d:%d" % (validity, newest), "at": started}, "complete": True}


def sent_folder(t):
    """The folder sent mail lands in: the setting, else the one the server flags \\Sent (RFC 6154), else none."""
    named = str(setting("sentFolder", ""))
    if named:
        return named
    for box in t.mailboxes():
        if "\\Sent" in box.get("flags", []):
            return box["name"]
    return ""


def thread_messages(t, thread):
    """Every message of a thread, oldest first: the root, and what names it in References or In-Reply-To."""
    folders = [str(setting("mailbox", "INBOX"))]
    sent = sent_folder(t)
    if sent and sent not in folders:
        folders.append(sent)
    found, uid_id = {}, UID_ID.match(thread)
    for folder in folders:
        box = t.examine(folder)
        validity = int(box.get("uidvalidity") or 0)
        if uid_id:
            # a message without a Message-ID: its thread is itself, read by UID in the folder it came from
            if folder != folders[0] or uid_id.group(1) != str(validity):
                continue
            criteria = "UID " + uid_id.group(2)
        else:
            q = imap_quote(thread)
            criteria = "OR OR HEADER Message-ID %s HEADER References %s HEADER In-Reply-To %s" % (q, q, q)
        uids = sorted(t.search(folder, criteria))
        for start in range(0, len(uids), FETCH_BATCH):
            for raw in t.fetch(folder, uids[start : start + FETCH_BATCH], "full"):
                m = read_message(raw["raw"], raw["uid"], validity, raw["internalDate"])
                # HEADER matches substrings: keep only the messages that carry this exact id
                if uid_id or thread in [m["id"], m["root"]] + m["references"] + m["inReplyTo"]:
                    found.setdefault(m["id"], m)
    return sorted(found.values(), key=lambda m: (m["time"], m["id"]))


def check_thread(thread):
    if not isinstance(thread, str) or not (MSGID.match(thread) or UID_ID.match(thread)):
        raise ProviderError(-32602, "invalid_thread", "not an email thread id: %r" % (thread,), outcome="none")
    return thread


def context(params):
    thread = check_thread(params.get("thread"))
    max_items = max(1, int(params.get("max") or 50))
    since = params.get("since")
    t = transport()
    try:
        messages = thread_messages(t, thread)
    finally:
        t.close()
    if not messages:
        raise ProviderError(-32000, "not_found", "no email in thread " + thread)
    if since:
        messages = [m for m in messages if m["time"] > int(since)]
    kept = messages[-max_items:]
    first = messages[0]
    last = messages[-1]
    mailbox = str(setting("mailbox", "INBOX"))
    fields = {"from": who(last["from"]), "to": ", ".join(who(p) for p in last["to"]), "lastMessageId": last["id"]}
    if last["cc"]:
        fields["cc"] = ", ".join(who(p) for p in last["cc"])
    if last["replyTo"]:
        fields["replyTo"] = ", ".join(who(p) for p in last["replyTo"])
    return {
        "thread": thread,
        "link": link_of(thread),
        "conversation": {"id": first["list"], "label": first["listName"] or first["list"], "kind": "email"}
        if first["list"]
        else {"id": mailbox, "label": mailbox, "kind": "email"},
        "title": first["subject"],
        "fields": fields,
        "items": [{"id": m["id"], "author": clean(who(m["from"]), 300).replace("\n", " "), "time": m["time"], "text": m["text"], "link": link_of(m["id"])} for m in kept],
        "complete": len(kept) == len(messages),
        "fetchedAt": int(time.time() * 1000),
    }


def act_error(code, message, outcome="none", retryable=False, fatal=False):
    return {"ok": False, "error": {"code": code, "message": message, "retryable": retryable, "fatal": fatal, "outcome": outcome}}


def message_id_for(key, sender):
    """A Message-ID derived from the idempotency key: a replay of the same Go builds the same message."""
    return "strato.%s@%s" % (hashlib.sha256(key.encode("utf-8")).hexdigest()[:32], sender.split("@")[-1])


def reply_subject(action, parent):
    subject = action.get("subject") or parent["subject"] or ""
    subject = clean(subject, 900).replace("\n", " ").strip()
    if not action.get("subject") and not re.match(r"^(re|aw|sv|réf?)\s*:", subject, re.I):
        subject = "Re: " + subject
    return subject


def build_reply(action, parent, key):
    sender = my_address()
    if not ADDRESS.match(sender):
        raise ProviderError(-32002, "missing_setting", "the address setting is not a valid address", fatal=True, outcome="none")
    # the recipients the person approved with the text, exactly: never a default, never a reply-all
    audience = action.get("audience") or {}
    to = [check_address(a) for a in audience.get("to") or []]
    cc = [check_address(a) for a in audience.get("cc") or []]
    if not to:
        raise ProviderError(-32602, "missing_recipients", "no recipient for this reply: name them on the plan (audience.to)", outcome="none")
    body = action.get("text") or ""
    if not body.strip():
        raise ProviderError(-32602, "empty", "an empty reply", outcome="none")
    if len(body) > MAX_TEXT:
        raise ProviderError(-32602, "too_long", "the reply is longer than %d characters" % MAX_TEXT, outcome="none")
    msg = EmailMessage(policy=email.policy.SMTP)
    name = clean(str(setting("name", "")), 200).replace("\n", " ")
    msg["From"] = email.utils.formataddr((name, sender)) if name else sender
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = reply_subject(action, parent)
    msg["Date"] = email.utils.formatdate(usegmt=True)
    msg["Message-ID"] = "<%s>" % message_id_for(key, sender)
    if not UID_ID.match(parent["id"]):
        msg["In-Reply-To"] = "<%s>" % parent["id"]
        chain = parent["references"] + [parent["id"]]
        if len(chain) > 20:
            chain = chain[:1] + chain[-19:]
        msg["References"] = " ".join("<%s>" % i for i in chain)
    plain = all(ord(c) < 128 for c in body) and all(len(line) <= 900 for line in body.split("\n"))
    msg.set_content(body.replace("\r\n", "\n"), cte="7bit" if plain else "quoted-printable")
    return msg, sender, to + [a for a in cc if a not in to]


def act(params):
    """A reply in an email thread, only ever called by Strato's gate after the person's Go on this exact text and audience."""
    action = params.get("action") or {}
    key = str(params.get("idempotencyKey") or "")
    dry = bool(params.get("dryRun"))
    if action.get("kind") != "reply":
        return act_error("unsupported", "%s is not supported: this provider only replies" % action.get("kind"))
    target = action.get("target") or {}
    # a key of a mail tool names an email thread (its first Message-ID): a text there is a reply in it.
    # A new email to a mailbox or an address is not supported, and check_thread refuses it.
    try:
        thread = check_thread(target.get("native"))
        if not key:
            raise ProviderError(-32602, "missing_key", "no idempotency key", outcome="none")
        t = transport()
        try:
            messages = thread_messages(t, thread)
            if not messages:
                raise ProviderError(-32000, "not_found", "no email in thread " + thread, outcome="none")
            # the reply answers the newest message of the thread, whoever wrote it
            parent = messages[-1]
            msg, sender, recipients = build_reply(action, parent, key)
            link = link_of(message_id_for(key, sender)) or link_of(thread)
            described = 'reply "%s" to %s' % (msg["Subject"], ", ".join(recipients))
            if dry:
                return {"ok": True, "ref": "", "link": link_of(thread), "dry": described}
            ref = message_id_for(key, sender)
            sent = store_read("sent", {})
            record = sent.get(ref)
            if record and record.get("state") == "sent":
                # the same Go replayed: it already left, nothing is sent twice
                return {"ok": True, "ref": ref, "link": link}
            if record:
                return act_error("maybe_sent", "a send of this reply was interrupted; check the Sent folder before trying again", outcome="unknown")
            sent[ref] = {"state": "sending", "at": int(time.time() * 1000)}
            store_write("sent", sent)
            raw = msg.as_bytes()
            try:
                t.send(sender, recipients, raw, key)
            except ProviderError as e:
                if e.data.get("outcome") == "none":
                    sent.pop(ref, None)
                    store_write("sent", sent)
                raise
            sent[ref] = {"state": "sent", "at": int(time.time() * 1000)}
            if len(sent) > SENT_KEEP:
                for old in sorted(sent, key=lambda r: sent[r].get("at", 0))[: len(sent) - SENT_KEEP]:
                    sent.pop(old)
            store_write("sent", sent)
            if setting("saveSent", False):
                folder = sent_folder(t)
                if folder:
                    try:
                        t.append(folder, raw)
                    except ProviderError as e:
                        log("warn", "the reply left, but its copy in %s failed: %s" % (folder, e))
            return {"ok": True, "ref": ref, "link": link}
        finally:
            t.close()
    except ProviderError as e:
        data = dict(e.data)
        data.setdefault("outcome", "unknown")
        return {"ok": False, "error": data}


def describe(params):
    return {"api": 1, "descriptor": DESCRIPTOR}


def initialize(params):
    state["secrets"] = params.get("secrets") or {}
    state["settings"] = (params.get("account") or {}).get("settings") or {}
    state["offline"] = bool(params.get("offline"))
    return {"ok": True}


HANDLERS = {"describe": describe, "initialize": initialize, "connect": connect, "poll": poll, "context": context, "act": act}


def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError:
            send({"id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        if "id" not in message or "method" not in message:
            continue  # a notification ($/cancel), or a late answer: nothing to do
        rid, method = message["id"], message["method"]
        if method == "shutdown":
            send({"id": rid, "result": {"ok": True}})
            return
        handler = HANDLERS.get(method)
        if handler is None:
            send({"id": rid, "error": {"code": -32601, "message": "no method " + method}})
            continue
        try:
            send({"id": rid, "result": handler(message.get("params") or {})})
        except ProviderError as e:
            send({"id": rid, "error": {"code": e.rpc, "message": e.data["message"], "data": e.data}})
        except Exception as e:  # a bug: Strato reads it as a crash of this request
            log("error", "%s: %r" % (method, e))
            send({"id": rid, "error": {"code": -32000, "message": "internal error in %s" % method}})


if __name__ == "__main__":
    main()
