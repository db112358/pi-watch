# watch — settle on a condition, not a clock

Run a command and settle on a condition instead of a clock, and hand the matched output to a
pi session that investigates it and reports back.

## Why

`bash` returns when the command exits or its timeout expires. A build, a test suite, or a CI
run therefore costs a guess at the duration and a poll loop afterwards: one turn per poll, and
the output between polls is lost.

`watch` streams the output into a bounded buffer plus a full log file, and returns when the
command actually settles. One call covers the run, and only the tail reaches the model.

## Structure

```
watch/
├── index.ts        # watch/watch_status/watch_ask/watch_cancel, /watch command, Watch process wrapper
├── escalation.ts   # Escalator: resumable pi child sessions
└── model.ts        # which model investigations run on, and where that choice is stored
```

`install.fish` symlinks `watch/` into `~/.pi/agent/extensions`.

`escalation.ts` imports nothing from `index.ts`. It knows how to run a prompt in a resumable
pi session and nothing about watches, so the prompt itself is built in `index.ts`. `model.ts`
imports neither, so it cannot depend on watch state.

## Tools

| Tool | Purpose |
|------|---------|
| `watch` | Run a command, settle on a condition, optionally escalate — takes a required `title`; interim check-ins fold to one row |
| `watch_status` | Read progress without waiting, for answering a person |
| `watch_ask` | Continue an investigating agent's session |
| `watch_cancel` | Kill the command tree and any running investigation |

## Settling

`watch` returns on the first of:

- a line matching `until` — success, and the trigger for `onMatch`
- a line matching `fail` — checked before `until`, so a failure that also matches the success
  pattern still reports as a failure
- the process exiting — exit code preserved
- `timeout` elapsing — the accumulated output is returned too, so a timeout is a free checkpoint

Settling early kills the process group (SIGTERM, then SIGKILL after 3s), so `until: "Ready"`
on a server that keeps running does not leak it. Patterns are matched against every chunk as
it arrives with an 8KB overlap, so a match split across two writes is not missed.

The result carries the tail (`tail`, default 80 lines), the total output size, and a path to
the full log, because the model rarely needs the whole thing and can read a file if it does.

## Foreground and background

Prefer `background: true`. It returns a handle immediately, the report arrives later as a message
with `triggerTurn: true` that starts a new turn, and in between `watch_status` answers "how is it
going" and `watch_cancel` stops it — the same read-and-decide loop as tailing a log, without the
sleeping or the polling.

Foreground (the default) holds the tool call until the command settles and streams progress
through `onUpdate`, so a long build at least shows its last line instead of a frozen row. What it
cannot show is the middle: you cannot look at how far it has got, decide to stop, or extend the
budget without aborting the call, which kills the command.

Background needs an interactive session. Print/JSON mode exits when the turn ends and takes the
watch with it, so \`background\` is refused there rather than promising a report that cannot arrive.

So use foreground only for runs you know finish inside ~10 seconds — a probe, `--version`, a
single test file. Anything whose duration is a guess belongs in the background.

`progress: <seconds>` adds interim messages to a background watch: each carries the elapsed time,
the bytes produced and the last five lines, so a run can be watched unfolding rather than only
seen settled. They are skipped when the command produced nothing new, the floor is 5s, and every
one of them starts a turn — treat it as "check in on this run" (30–60s), not a `tail -f`. The
settled report supersedes them.

Each check-in folds to a single row: a dim `watch` lead, the run's title, and the outcome
right-aligned in the dim register zen gives an action's summary —

```
 watch draft PR CI                                     still running · 10.0s · 35B
 watch draft PR CI                                           matched after 30.4s
```

The id is not in the row: `w2` exists to address a watch in `watch_status`, `watch_ask` and
`watch_cancel`, and the tool result that starts it — a reader glancing at the transcript does not
need it.

The title takes whatever room the outcome leaves, so nothing is cut for a fixed budget. Both rows
wear the standard custom-message frame, and clicking either opens the tail (and any investigation)
beneath it.

`ctrl+o` deliberately does not unfold them: a check-in is a glance, several arrive per run, and
the click is the door.

The click needs an `invalidate` handle on `MessageRenderOptions`, which upstream pi does not
pass. The pi fork in `~/scratchpad/pi` adds it (optional, so watch still loads on a stock build),
exactly as it added `setThinkingRow` for zen's thinking row.

This is what a `tail`-in-a-loop cannot do: that loop runs inside one tool call, so its intermediate
output only reaches the model at the end, by which time the decision it was meant to inform has
passed.

## The status card

Live watches draw a card below the editor, underneath andon's: one line per watch (at most
three), a glyph for its state (`⏳` running, `✓` done, `✗` failed), its title and how long it has
been going. It paints from live state on a one-second tick, so the elapsed time never freezes at
what it was when the watch started. A lone watch also shows
the last line it produced, so the card says what the run is *doing*, not just that it exists.
It replaces the footer status line, which had room for an id and a duration and nothing else.

That is what `title` is for, and it is required: the card is scanned, not read, so
`"draft PR CI for AI-1493"` earns its space where `"gh pr checks 1869"` does not. The same title
labels the interim messages, the settled report and `watch_status`.

## Escalation

```ts
watch({
  title: "typecheck the API package",
  command: "npm run build",
  until: "error TS",
  onMatch: {
    task: "The build failed. Find which file and line, and what type mismatch caused it.",
  },
})
```

On an `until` match the extension spawns a pi child with the command, exit code, matched line,
log path, the last 400 lines of output, and the brief. Its reply is appended to the result under
`--- investigation ---`. The child gets a session with tools, not the raw text, so it can open
the failing file instead of guessing from the log.

Escalation fires only on a `matched` result. A `fail` pattern means the parent already knows
what went wrong, so there is nothing to investigate.

| Option | Default | Notes |
|--------|---------|-------|
| `onMatch.task` | required | What to find out. The agent sees the output, not your conversation |
| `onMatch.tools` | `read, grep, find, ls` | Add `bash` only when it must reproduce or query something |
| `onMatch.model` | cheapest configured | See below |

Usage is reported with the result, so cost does not disappear into a turn nobody watched:

```
[investigation: 12k in / 2k out, $0.04 · session w3-investigation in ~/.pi/agent/watch-sessions]
```

### Model

An investigation reads output and answers a question, so it defaults to the cheap tier
(`fireworks/accounts/fireworks/models/glm-5p3-flash`) rather than inheriting the parent's model.
Pick a different one with `/watch`:

| Command | Effect |
|---------|--------|
| `/watch` | Print the effective model, where it came from, and the config path |
| `/watch model` | pi's own `/model` picker |
| `/watch model <spec>` | Accepts `provider/id`, a bare id, or a fragment (`haiku`, `glm`) |
| `/watch model default` | Clear the override |

The picker is the same `ModelSelectorComponent` the built-in `/model` command builds, so search,
scope toggle, catalog refresh and auth filtering behave identically, and the model currently in
effect is preselected. A fragment matching several models opens it with the search prefilled
rather than guessing. Only TUI can render a custom component: RPC falls back to a plain dialog
list, and `-p` reports how to set the model from a file or env var.

The choice is written to `~/.pi/agent/watch.json` and applies to every session.

Resolution order:

1. `onMatch.model` — a single investigation, set by the model
2. `/watch model` — persisted per user
3. `PI_WATCH_INVESTIGATION_MODEL`
4. the cheap default, if that provider has credentials and is in the session's scoped models
5. otherwise the parent's model

The persisted choice outranks the env var because it is the deliberate one. Steps 4 and 5 are
fallbacks, so an unconfigured default provider is not an error and the feature works on any
provider at all.

## Asking how it's going

A watch reports itself, so nobody needs to poll it. For a person asking mid-flight:

- **The status row** shows every running watch with elapsed time, and whether an investigation
  is running.
- **`watch_status(id)`** returns status, elapsed, exit code, matched line, the last lines of
  output, and the escalation's state. It is deterministic and costs no tokens.
- **Resume the investigating agent directly.** Its session lives outside the project's session
  list but stays resumable, and `watch_status` prints the exact command:

  ```sh
  pi -p --session w3-investigation --session-dir ~/.pi/agent/watch-sessions
  ```

- **`watch_ask(id, message)`** sends that agent a follow-up as a user message, so it keeps its
  context. This is cheaper and more precise than escalating again.

`watch_ask` refuses while the agent is still working. pi does not lock session files, so a
second process writing the same session would corrupt it: wait for the report, or cancel.

`watch_status` answers a person's question; it is not a way to wait.

## Security model

This tool runs commands with the same OS permissions as pi, and `onMatch` starts a child pi that
inherits the cwd and environment.

- **The default investigation tool set is read-only** (`read`, `grep`, `find`, `ls`). Granting
  `bash` makes the investigating agent able to run anything, which is a different risk class:
  it acts without a person to approve its commands, because a headless child has no TUI.
- **The brief is trusted input.** Whatever the parent model writes in `onMatch.task` steers an
  agent that may hold write or bash tools if you granted them.
- **Escalation sessions are conversation transcripts** and are kept under
  `~/.pi/agent/watch-sessions`, not in the project's session list. Remove that directory to
  discard them.
- The matched output is attacker-influenced if the command's output is. A build log from
  untrusted input is untrusted input.

## Installation

```sh
fish install.fish
```

That symlinks `watch/` into `~/.pi/agent/extensions` and points this repo's
`node_modules` at the active pi release for editor types. To do it by hand, or to
load it for one run without installing:

```sh
ln -sfn "$(pwd)/watch" ~/.pi/agent/extensions/watch
pi --extension ./watch
```

Editing a renderer needs a restart, not `/reload`: the reload swaps tools, but a message already
rendered with the old closure keeps it, so a row can look a commit out of date until the process
comes back.

## Limitations

- **No concurrency cap.** Four parallel watches that all match start four investigating agents.
- **The status row only refreshes on output.** A silent command leaves the elapsed time stale
  until it produces something — and sends no `progress` messages at all.
- **Settled watches pin their buffers.** The last 10 are kept for `watch_status`, each up to 256KB.
- **`-p` exits when the turn ends.** A background watch that outlives its turn dies with the
  process, so in print/JSON mode use a foreground watch (or `until`) instead of `background`.
- **A cancelled background watch still sends a report** saying the investigation was cancelled.
  The parent asked for a notification and should learn the watch ended.
- **`/watch model` needs interactive mode.** In `-p` or JSON mode, set the model with
  `PI_WATCH_INVESTIGATION_MODEL` or by editing `~/.pi/agent/watch.json`.
- **The built-in picker reaches into `ModelRegistry`'s private `runtime`.** The class is exported
  and aliased to the running build, but the catalog it reads is not, so the field is read through
  a cast. If that field disappears, `/watch model` falls back to a plain dialog instead of failing.
