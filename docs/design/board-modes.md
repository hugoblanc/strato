# Board: reading first, two modes

Status: proposal, 2026-10-05.
Scope: the board page (`/board`), its card, its redraw, and the card-writing policy that feeds it.
Out of scope: the model of topics, tasks and gates, the sessions, the providers.

## 1. What the person does on the board

The event log of a real installation, over two weeks:

- **Instructions written to a session:** 221.
- **Drafts sent from the board:** 55.
- **Every other action** (close, snooze, stop, task done or dropped from the board): about 30 in total.

Reading is not logged, and it comes before all of these.
The person reads every card to know what is wanted from them, decides, and then either writes to the session or sends a draft.
The board is therefore a reading surface first, a conversation with sessions second, and a control panel last.

## 2. What goes wrong today

### 2.1 The card moves under the pointer

A card's position encodes the state of its session (`attend`, `revoir`, `travail`, `attente`).
The person's own action changes that state: a click on Go or Done wakes the session, the card leaves "waiting on you" for "working", and jumps down the page while the person is still reading it.

### 2.2 The redraw rebuilds the page

Every redraw fetches `/board/fragment` and replaces `#app` with `innerHTML`.
What the person had opened, typed or focused is then restored piece by piece (`details[id]`, `data-panel`, unsent instructions, drafts being edited, the active field, the scroll position).
Each new interactive element needs its own restore code, and any element without it resets every 30 seconds.

### 2.3 Every field is a row, and some are said twice

The card renders each field the session wrote, in a fixed order, at the same weight.
Nothing decides what the person needs first.
Observed on real cards:

- **The blocker repeats the task:** "Blocked on: the descriptor change needs your dashboard session", then the task "Rename X and Y in the dashboard".
- **The session's state is said three times:** the header badge ("2 tasks · 3 d"), the pane ("Session waits for your go"), and the action box ("Handed to session C, which handles it now"), which itself appears twice.
- **Two ages compete:** "card 1 min ago" and "last message: you, 1 min ago".
- **Internal identifiers are shown:** task numbers (`t14`), thread timestamps down to the second, channel ids.
- **Links pile up:** a topic followed for a week shows 15 thread links before its first sentence.

### 2.4 The rendering contradicts the writing policy

The card-writing policy says the plan (`steps`) is what the person reads before anything else.
The board hides it in the Details panel.

### 2.5 Rare actions take as much room as frequent ones

Later, Stop, Close, Revalidate, iTerm2 and claude.ai sit on every card, at the same level as the instruction field that is used 221 times.

## 3. Principles

1. **One question per card.** The card answers "what is wanted from me, and what does the session propose?" before anything else.
2. **A fixed reading order.** Title, then the need, then the proposal or the draft, then the action. Context comes after, summarized as counts, opened on demand.
3. **Nothing moves under the pointer.** A line the person touched keeps its place until they leave it.
4. **Act without opening.** The primary action of the first open task is one click in every mode.
5. **One state, said once.** The session's state has one place on the card.
6. **One content, two layouts.** Modes are layouts over a single card model, never two models.

## 4. The card, by levels

The same content is split into four levels.
A mode decides which levels it shows where; it never decides the content.

| Level | Contents | Where |
|---|---|---|
| L0 row | letter, title, the need (verb + object), its age, the proposal in one line, the primary button | list of the focus mode, folded card of the flow mode |
| L1 card | L0 + the plan strip (done / now / next), the open tasks (first expanded, the others on one line), the draft block, the instruction field | card of the flow mode, detail of the focus mode |
| L2 context | origin and threads, merge requests, due dates, why you, unverified, summary, finished tasks | folded under L1, one line of counts: "14 threads · 3 MR in prod · 2 due" |
| L3 report | the session's report, the transcript, the terminal | report page, terminal |

### 4.1 Field mapping

| Field | Today | Proposed |
|---|---|---|
| `title` | header | L0 |
| first open task `ask` | task block | L0, as the need |
| first open task `proposal` or `draft` | task block | L0 one line, L1 in full |
| `steps` | Details panel | L1, one horizontal strip, the `now` step in bold |
| `blocker` | row "Blocked on" | L1 only when it names someone other than the person served; dropped when it repeats the need |
| other open tasks | full blocks | L1, one line each, expanded on click |
| `summary` | row when no task | L1 when no task is open, L2 otherwise |
| origin and `threads` | header, all links | L2: the origin and the two latest threads, the rest folded |
| `mrs` | row per MR | L2, moving MRs in full, settled ones grouped |
| `due` | row | L1 when due within 24 h, L2 otherwise |
| `why`, `unverified` | Details | L2 |
| finished tasks | Details, all | L2, the last two, the rest in the report |
| session state, last word | badge + pane + action box | one status line in the header; the last word only when newer than the card |
| task ids (`t14`) | shown | hidden; kept in `data-` attributes and tooltips |

### 4.2 The session status line

One line replaces the badge, the pane title and the action-box status.
It reads like a sentence: "Waits for your go · 3 d", "Working: reading the thread", "Waits for Zoé · 2 h", "Stopped".
The pulsing dot of a working session stays on it.

## 5. Two modes

Both modes live side by side.
The header has a switch, the URL carries it (`/board?mode=focus`), and the browser remembers it.
The flow mode stays the default until the focus mode has proven itself.

### 5.1 Flow mode (today's board, rewritten on the card model)

- Cards stacked by block, as today, at L1 with L2 folded.
- Every primary action stays one click on the card.
- A click on the title, or Enter on the selected card, opens the detail in a sheet that slides in from the left, so it never fights the terminal docked on the right. Escape closes it.

### 5.2 Focus mode (new)

- **Left, the list:** L0 rows on two lines (title and need, then proposal and primary button). Not compact to the point of hiding the proposal: the one-click actions of the flow mode remain possible from the list.
- **Centre, the detail:** L1 and L2 of the selected topic, with the instruction field always visible, since writing to the session is the main action.
- **Right, the terminal:** the existing drawer docked on the right.
- **Keyboard:** `j` / `k` to move, Enter to open, `⌘↩` to send, `e` to edit the draft, `d` done, `x` drop, `s` later.
- **After an action:** the selection moves to the next line waiting on the person, instead of following the line that just left.

## 6. Architecture

### 6.1 Today

`board.ts` holds 2,700 lines: the model (`classify`, `buildBoard`, pure and tested), the HTML views as template strings, and a client script of about 1,150 lines inlined in the page.
The redraw replaces the whole fragment.

### 6.2 Target

```
core model          BoardModel / BoardLine            unchanged
presentation model  cardOf(line, now) -> CardView      new, pure, tested
views               views/parts.ts  rows, card, task, draft, status
                    views/flow.ts   blocks of cards
                    views/focus.ts  list + detail
client              client/actions.js   every data-* action, mode independent
                    client/sync.js      redraw by morphing, pin, selection
                    client/flow.js      sheet
                    client/focus.js     list, keyboard
                    client/drawer.js    terminals
```

- **`CardView` is the only place that decides what is said and in which order.** It applies the deduplication rules of section 4.1 (blocker that repeats the need, single status, ages). Both modes render it. Unit tests cover each rule.
- **The client is split into modules served as static files.** They are embedded at build time (`import … with { type: "text" }`), so the compiled binary keeps working without the source tree.
- **The redraw morphs instead of replacing.** Elements are matched by `data-key` and stable ids; the focused field, the caret, open panels and typed text survive by construction. Candidate: idiomorph, pinned on jsDelivr with an integrity hash like Tailwind today, or a small keyed patcher if its size matters. The restore code of section 2.2 goes away.
- **Stable placement is decided by the server.** The client sends `pin=<key>` with each fragment request: the line selected, under the pointer, or acted on last. `buildBoard` keeps a pinned line in the block and position it had at the previous render, with its new state shown in place. The pin is released when the person moves to another line, presses Escape, or after two minutes without interaction. Doing it on the server keeps both modes identical and testable.
- **Endpoint:** `GET /board/fragment?mode=flow|focus&pin=<key>&sel=<key>`. `mode` only picks the layout.

### 6.3 The writing side

The card's quality depends on what sessions write.
Two changes to the card-writing policy:

- **`blocker` names who or what blocks, never the task again.** When the person served is the blocker, the open task already says it.
- **The first open task carries the need.** Its `ask` starts with a verb and fits 80 characters; the board uses it as the card's headline.

No new field is needed.

## 7. Delivery in slices

Each slice ships on its own and leaves the board working.

1. **Stability:** pin and morphing redraw. Fixes the jump and the resets.
2. **Card model:** `CardView` and its rules; the flow mode renders through it. This is the visible reading improvement.
3. **Client split:** the inline script becomes modules, without behaviour change. The golden tests guard it.
4. **Focus mode** behind the switch.
5. **Sheet** in the flow mode.
6. **Policy update** for the sessions' card writing.

## 8. Tests

- `CardView`: one unit test per rule (deduplication, levels, ages, folding).
- Golden render per mode on the same fixture.
- Pin: a line acted on keeps its block and index across a render where its state changed; it moves once unpinned.
- A browser check of both modes on a copy of a real state before each merge.

## 9. Open questions

- **Default mode** once the focus mode exists.
- **The plan strip in L1:** the policy says it is read first; showing it on every card costs one line.
- **Finished tasks:** keep the last two in L2, or move them all to the report.
- **The sheet:** from the left as proposed, or a centred modal.
