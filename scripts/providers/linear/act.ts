/**
 * The Linear provider's writes: a comment on an issue (an answer in a comment's thread when the target is a comment),
 * a status change, an assignment, and taking each back within the undo window. Kept apart from the rest of the
 * provider on purpose: only the registry imports this module, and only app/act.ts, behind the gate, reaches what it
 * exports (docs/design/providers.md, section 8.2).
 *
 * A comment is created with an id derived from the idempotency key, so that a replay of the same Go after an unknown
 * outcome cannot create it twice: when Linear refuses the id, the comment that already carries it is the result. A
 * status or an assignee records the value it replaces, which Undo puts back.
 */
import { linkOfNative } from "../../core/links.ts";
import type { AccountContext, ActInput, ActResult, Provider, ProviderError } from "../sdk.ts";
import { actFailed, networkWriteError, undoDeadline } from "../api.ts";
import { LinearError, linearQuery } from "./client.ts";
import { commentNative, LINEAR_DESCRIPTOR, type LinearComment, type LinearPerson, pickAssignee, pickState, stableUuid, ticketOfNative } from "./model.ts";

const ISSUE_FOR_WRITE = `query StratoIssueForWrite($id: String!) {
  issue(id: $id) {
    id identifier url
    state { id name } assignee { id name displayName }
    team { states(first: 100) { nodes { id name } } }
    comments(first: 250) { nodes { id } }
  }
}`;
const USERS = "query StratoUsers { viewer { id } users(first: 250) { nodes { id name displayName email active } } }";
const COMMENT_BY_ID = "query StratoComment($id: String!) { comment(id: $id) { id url } }";
const COMMENT_CREATE = "mutation StratoCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }";
const COMMENT_DELETE = "mutation StratoCommentDelete($id: String!) { commentDelete(id: $id) { success } }";
const ISSUE_UPDATE = "mutation StratoIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";

interface IssueForWrite {
  id: string;
  identifier: string;
  url?: string | null;
  state?: { id: string; name: string } | null;
  assignee?: LinearPerson | null;
  team?: { states?: { nodes: { id: string; name: string }[] } | null } | null;
  comments?: { nodes: { id: string }[] } | null;
}

/**
 * A failed write. Linear answered with an error: nothing was written (`outcome: "none"`). A request that may have
 * reached Linear without an answer (the network, a timeout, a server failure) may have written: `outcome: "unknown"`.
 */
function writeError(e: unknown, sent: boolean): ProviderError {
  if (e instanceof LinearError) return { ...e.toProviderError(), outcome: e.answered || !sent ? "none" : "unknown" };
  return networkWriteError(e, sent);
}

const failed = actFailed;
const refused = (code: string, message: string): ActResult => failed({ code, message, retryable: false, fatal: false, outcome: "none" });
const undoUntil = () => undoDeadline(LINEAR_DESCRIPTOR);

/** The issue a write targets, read before anything is written: its id, its state and assignee, its team's states. */
async function issueForWrite(ctx: AccountContext, identifier: string): Promise<IssueForWrite | null> {
  const data = await linearQuery<{ issue?: IssueForWrite | null }>(ctx, ISSUE_FOR_WRITE, { id: identifier });
  return data.issue ?? null;
}

/** The link of an issue, from Linear's answer when it is one of its links, else from the account's patterns. */
const issueLink = (ctx: AccountContext, issue: IssueForWrite) => (issue.url?.startsWith("https://linear.app/") ? issue.url : (linkOfNative("linear", ctx.account.id, issue.identifier) ?? ""));

/** A comment, created with the id the idempotency key gives; a replay finds the comment that already has it. */
async function comment(ctx: AccountContext, input: ActInput, text: string, ticket: { issue: string; comment: string | null }): Promise<ActResult> {
  let sent = false;
  try {
    const issue = await issueForWrite(ctx, ticket.issue);
    if (!issue) return refused("not_found", `Linear: no issue ${ticket.issue}`);
    // an answer in a comment's thread: the comment named by its id, or by the short id its link carries
    let parentId: string | null = null;
    if (ticket.comment) {
      const c = ticket.comment.toLowerCase();
      parentId = (issue.comments?.nodes ?? []).find((x) => x.id === c || x.id.startsWith(c))?.id ?? null;
      if (!parentId) return refused("not_found", `Linear: no comment ${ticket.comment} on ${issue.identifier}`);
    }
    const id = stableUuid(input.idempotencyKey);
    if (input.dryRun) return { ok: true, ref: "", link: "", dry: `comment on ${issue.identifier}${parentId ? ` in reply to ${parentId}` : ""} (${text.length} characters)` };
    let created: LinearComment | null = null;
    try {
      sent = true;
      const r = await linearQuery<{ commentCreate?: { success?: boolean; comment?: LinearComment | null } }>(ctx, COMMENT_CREATE, { input: { id, issueId: issue.id, body: text, ...(parentId ? { parentId } : {}) } });
      created = r.commentCreate?.success ? (r.commentCreate.comment ?? { id }) : null;
    } catch (e) {
      // a replay of the same Go: the comment with this id is the one already created
      if (!(e instanceof LinearError && e.answered)) throw e;
      const existing = await linearQuery<{ comment?: LinearComment | null }>(ctx, COMMENT_BY_ID, { id }).catch(() => ({ comment: null }));
      if (!existing.comment?.id) throw e;
      created = existing.comment;
    }
    if (!created) return refused("refused", "Linear did not create the comment");
    const native = commentNative(issue.identifier, created.id);
    const link = created.url?.startsWith("https://linear.app/") ? created.url : issueLink(ctx, issue);
    return { ok: true, ref: native, link, undo: { token: `comment:${created.id}`, until: undoUntil() } };
  } catch (e) {
    return failed(writeError(e, sent));
  }
}

/** A status change or an assignment, recording the value it replaces for Undo. */
async function update(ctx: AccountContext, input: ActInput, ticket: { issue: string }): Promise<ActResult> {
  const a = input.action;
  let sent = false;
  try {
    const issue = await issueForWrite(ctx, ticket.issue);
    if (!issue) return refused("not_found", `Linear: no issue ${ticket.issue}`);
    let patch: { stateId: string } | { assigneeId: string | null };
    let token: string;
    let what: string;
    if (a.kind === "setStatus") {
      const state = pickState(a.status, issue.team?.states?.nodes ?? []);
      if (!state) return refused("not_found", `Linear: ${issue.identifier} has no status "${a.status}" (${(issue.team?.states?.nodes ?? []).map((s) => s.name).join(", ")})`);
      patch = { stateId: state.id };
      token = `state:${issue.id}:${issue.state?.id ?? "-"}`;
      what = `status of ${issue.identifier} to ${state.name}`;
    } else if (a.kind === "assign") {
      const users = await linearQuery<{ viewer?: { id: string }; users?: { nodes: (LinearPerson & { email?: string | null; active?: boolean | null })[] } }>(ctx, USERS);
      const who = pickAssignee(a.assignee, users.users?.nodes ?? [], users.viewer?.id ?? ctx.identity?.me ?? "");
      if ("error" in who) return refused("not_found", `Linear: ${who.error}`);
      patch = { assigneeId: who.id };
      token = `assignee:${issue.id}:${issue.assignee?.id ?? "-"}`;
      what = `assignee of ${issue.identifier}`;
    } else return refused("unsupported", `Linear cannot ${a.kind}`);
    if (input.dryRun) return { ok: true, ref: "", link: "", dry: what };
    sent = true;
    const r = await linearQuery<{ issueUpdate?: { success?: boolean } }>(ctx, ISSUE_UPDATE, { id: issue.id, input: patch });
    if (!r.issueUpdate?.success) return refused("refused", `Linear did not change the ${what}`);
    return { ok: true, ref: issue.identifier, link: issueLink(ctx, issue), undo: { token, until: undoUntil() } };
  } catch (e) {
    return failed(writeError(e, sent));
  }
}

export const linearWrites: Required<Pick<Provider, "act" | "undo">> = {
  async act(ctx: AccountContext, input: ActInput): Promise<ActResult> {
    const a = input.action;
    const ticket = ticketOfNative(a.target.native);
    if (!ticket) return refused("not_found", `not a Linear issue: ${a.target.native}`);
    if (a.kind === "comment" || a.kind === "reply") return comment(ctx, input, a.text, ticket);
    if (a.kind === "setStatus" || a.kind === "assign") return update(ctx, input, ticket);
    return refused("unsupported", `Linear cannot ${a.kind}`);
  },

  /** Deletes the comment, or puts the previous status or assignee back, from the token `act` returned. */
  async undo(ctx: AccountContext, token: string): Promise<ActResult> {
    const m = token.match(/^(comment|state|assignee):([A-Za-z0-9-]+)(?::([A-Za-z0-9-]+))?$/);
    if (!m || (m[1] !== "comment" && !m[3])) return refused("bad_token", `not a Linear undo token: ${token}`);
    try {
      if (m[1] === "comment") {
        const r = await linearQuery<{ commentDelete?: { success?: boolean } }>(ctx, COMMENT_DELETE, { id: m[2] });
        return r.commentDelete?.success ? { ok: true, ref: m[2], link: "" } : refused("refused", "Linear did not delete the comment");
      }
      if (m[1] === "state" && m[3] === "-") return refused("unsupported", "the issue had no status to put back");
      const input = m[1] === "state" ? { stateId: m[3] } : { assigneeId: m[3] === "-" ? null : m[3] };
      const r = await linearQuery<{ issueUpdate?: { success?: boolean } }>(ctx, ISSUE_UPDATE, { id: m[2], input });
      return r.issueUpdate?.success ? { ok: true, ref: m[2], link: "" } : refused("refused", "Linear did not put the previous value back");
    } catch (e) {
      return failed(writeError(e, true));
    }
  },
};
