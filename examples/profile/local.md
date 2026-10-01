# Strato notes for Alice (Acme)

Read by the master at startup.
Everything here is fictional: it is the template the setup interview aims at.

## Who I am

Alice, lead of the Platform team at Acme.
I own the public API (`acme/api`), the web app's backend-for-frontend (`acme/web`), deployments and authentication.
I am on call one week in three.
What lands on me: API errors reported by support, integration questions from partners, deploy and release decisions, access requests to production.

## My team

Slack group: `@platform` (S_EXAMPLE_PLATFORM).
A mention of `@platform` means "someone from the team", not me.

| Who | Role | Takes |
| --- | --- | --- |
| Bob | Backend engineer | API bugs, webhooks, rate limits |
| Carol | Frontend engineer | Web app, login screens, browser issues |

If Bob or Carol already answered in a thread, they own it: do not prepare anything for me.

## Ownership map

Who to point to when a request is not for me ("not for you, it's X").

| Area | Owner | Where to send people |
| --- | --- | --- |
| Invoices, refunds, pricing | Erin (Billing lead) | #billing-requests |
| Data warehouse, dashboards, exports | Dan (Data team) | #data-help |
| Customer accounts, onboarding, KYC | Frank (Support lead) | #support |
| Mobile apps | Grace (Mobile lead) | #mobile |
| Security incidents | Heidi (Security) | #security, page through PagerDuty |
| API, deploys, auth, production access | Platform (me, Bob, Carol) | #platform-requests |

## Never without my go

- Any message on my behalf, in any channel or DM.
- Any production write: database, configuration, feature flags, deploy, release from `dev` to `main`.
- Granting or revoking access to production or to customer data.
- Anything posted in #exec or sent to a customer or a partner.
- Closing or reassigning a ticket someone else filed.

## Notes

- Release train: `dev` is deployed to staging continuously, `main` is production, released on Tuesdays and Thursdays.
- Partner questions often arrive in shared channels named `ext-<partner>`: answer in the thread, never in DM.
- Draft tone: short, direct, no greeting line, English in shared channels.
- Voice file for drafts: none yet.
