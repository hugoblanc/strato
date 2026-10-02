"""What the conformance harness cannot reach: the real SMTP transport (with smtplib replaced by a fake, nothing
leaves the machine) and the reply's recipients. Run with `python3 -m unittest` in this folder."""
import unittest

import provider


class FakeSMTP:
    """smtplib.SMTP and SMTP_SSL as far as the provider uses them, recording every call."""

    calls = []

    def __init__(self, host, port, timeout=None, context=None):
        FakeSMTP.calls.append(("connect", host, port))

    def starttls(self, context=None):
        FakeSMTP.calls.append(("starttls",))

    def login(self, user, password):
        FakeSMTP.calls.append(("login", user))

    def sendmail(self, sender, recipients, raw):
        FakeSMTP.calls.append(("sendmail", sender, tuple(recipients)))
        return {}

    def quit(self):
        FakeSMTP.calls.append(("quit",))


class Base(unittest.TestCase):
    def setUp(self):
        FakeSMTP.calls = []
        self.saved = (provider.smtplib.SMTP, provider.smtplib.SMTP_SSL, dict(provider.state))
        provider.smtplib.SMTP = FakeSMTP
        provider.smtplib.SMTP_SSL = FakeSMTP
        provider.state.update(
            secrets={provider.SECRET: "app-password-not-a-real-one"},
            settings={"address": "alice@acme.example", "imapServer": "imap.acme.example", "smtpServer": "smtp://smtp.acme.example:587"},
            offline=False,
        )

    def tearDown(self):
        provider.smtplib.SMTP, provider.smtplib.SMTP_SSL, saved = self.saved
        provider.state.clear()
        provider.state.update(saved)


class Send(Base):
    def test_starttls_then_login_then_one_message(self):
        provider.ImapSmtp().send("alice@acme.example", ["carol@acme.example"], b"raw", "k")
        self.assertEqual(
            FakeSMTP.calls,
            [("connect", "smtp.acme.example", 587), ("starttls",), ("login", "alice@acme.example"), ("sendmail", "alice@acme.example", ("carol@acme.example",)), ("quit",)],
        )

    def test_a_bare_host_is_tls_on_465(self):
        provider.state["settings"]["smtpServer"] = "smtp.acme.example"
        provider.ImapSmtp().send("alice@acme.example", ["carol@acme.example"], b"raw", "k")
        self.assertEqual(FakeSMTP.calls[0], ("connect", "smtp.acme.example", 465))
        self.assertNotIn(("starttls",), FakeSMTP.calls)


class Reply(Base):
    parent = {
        "id": "ca42@mail.acme.example",
        "references": ["ca41.root@mail.acme.example"],
        "subject": "Checkout fails",
        "from": ("Carol", "carol@acme.example"),
        "to": [("Alice", "alice@acme.example"), ("Dan", "dan@acme.example")],
        "replyTo": [],
    }

    def reply(self, audience, subject=None):
        action = {"kind": "reply", "text": "Fixed.", "audience": audience}
        if subject:
            action["subject"] = subject
        return provider.build_reply(action, self.parent, "email:ca41.root@mail.acme.example#t1#abcdef012345#1")

    def test_exactly_the_approved_recipients_never_a_reply_all(self):
        msg, sender, recipients = self.reply({"to": ["carol@acme.example"]})
        self.assertEqual((msg["To"], msg["Cc"], recipients), ("carol@acme.example", None, ["carol@acme.example"]))
        self.assertEqual(msg["In-Reply-To"], "<ca42@mail.acme.example>")
        self.assertEqual(msg["Subject"], "Re: Checkout fails")
        msg, _, recipients = self.reply({"to": ["carol@acme.example"], "cc": ["dan@acme.example"]}, subject="Checkout fixed")
        self.assertEqual((msg["Cc"], msg["Subject"], recipients), ("dan@acme.example", "Checkout fixed", ["carol@acme.example", "dan@acme.example"]))

    def test_no_recipient_or_a_header_in_an_address_is_refused(self):
        for audience in ({}, {"to": []}, {"to": ["carol@acme.example\r\nBcc: eve@evil.example"]}, {"to": ["carol"]}):
            with self.assertRaises(provider.ProviderError) as e:
                self.reply(audience)
            self.assertEqual(e.exception.data["outcome"], "none")


if __name__ == "__main__":
    unittest.main()
