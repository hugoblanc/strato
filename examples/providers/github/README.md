# GitHub

A Strato provider for the requests that reach you on github.com: review requests, mentions, assignments, and comments on the issues and pull requests you are involved in.
It is a TypeScript module, started with `strato provider new github` and written against the author guide (`strato provider guide`) only.

## What it does

| Step | How |
| --- | --- |
| Sign in | A fine-grained personal access token, pasted once, kept in the account's secret file as `GITHUB_TOKEN`. |
| Ingest | Polling: the issue search for `involves:@me` and `review-requested:@me`, then the timeline of each issue or pull request that moved. |
| Context | The issue or pull request: its description, comments, reviews, and when it was closed, reopened or merged. |
| Act | A comment on an issue or a pull request, only after your Go on the exact text, and deleted again if you undo within a minute. |
| Links | `github.com/<owner>/<repo>/issues/<n>` and `/pull/<n>`, with `#issuecomment-` and `#pullrequestreview-` anchors. |

A thread's native id is `owner/repo#number`.
Its key escapes the `#`, as Strato escapes every character a shell could read: `github:acme/api%2342`, which is how a session writes a typed destination (`to=`).
A destination written as text (`draftTo`) can be `acme/api#42`, a github.com link, or `#42` for an issue of the topic's own repository.

## Why not GitHub's notifications inbox

GitHub's notifications API (`GET /notifications`) only accepts a classic personal access token, and a classic token reaches every repository you can see.
This provider asks for a fine-grained token instead, limited to the repositories you choose, and rebuilds the same events from the search and the timelines:

| GitHub notification reason | What this provider reads |
| --- | --- |
| `review_requested` | a `review_requested` timeline event naming you, or one of your teams (the `teams` setting): an item with event `assigned` and reason `review_requested` |
| `mention`, `team_mention` | a comment or a review whose text mentions `@you` or `@org/team`, outside code |
| `assign` | an `assigned` timeline event naming you |
| `comment`, `author` | any other comment or review on an issue or pull request you are involved in |

What that costs:

- Only the repositories the token was given are read: a mention in any other repository is not seen.
- GitHub's search index lags behind by seconds to minutes; each poll searches again over the last ten minutes and skips what it already returned.
- Every poll makes two search requests (GitHub allows 30 a minute) and one to four timeline requests per issue or pull request that moved.
  A thread with more than three pages of new events since the last poll keeps its newest three, and the poll says it is not complete.
- An issue or pull request the search still lists but that can no longer be read (deleted, made private, or not shared with the token) is skipped and written to the account's log; the rest of the poll goes on.

## Creating the token

`strato setup --connect github` opens <https://github.com/settings/personal-access-tokens/new>.
Choose the repositories, then these repository permissions:

- Issues: read and write (reading issues and their timelines, writing comments on issues).
- Pull requests: read and write (the same on pull requests).
- Metadata: read (always selected).

## Files

- `provider.ts`: the provider.
- `provider.test.ts`: what the conformance harness does not reach (mentions in code, a capped poll, a thread a poll cannot read, a long timeline, typed destinations); run `bun test` here.
- `strato-provider.d.ts`: the types of the provider interface, as `strato provider types` prints them.
- `fixtures/sample.json`: a pull request and an issue on `acme`, answered offline to the conformance harness, with GitHub's two kinds of 403 (a rate limit, a repository the token was not given) as error cases.
- `fixtures/paged.json`: the same, with a timeline on two pages.

## Check it, then install it

```bash
STRATO_STATE="$(mktemp -d)" strato provider test <path to this folder>
```

1. Add it to `config.json`, with the path to this folder:

   ```json
   { "providers": { "github": { "source": { "module": "<path to this folder>/provider.ts" } } } }
   ```

2. Read the code, then trust it, in your own terminal: `strato provider trust github`.
   Any later change to this folder needs a new trust.
3. Connect your account: `strato setup --connect github`.
4. Once the offline run passes, check it against your own account: `strato provider test github --live`.
