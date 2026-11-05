# Court Call

Weekly pairing sheet for the Coastside Tennis Association, Half Moon Bay. Live at
**court-call.web.app**. Built and maintained by Vick; used every week by Robb Fox, the
club organizer, and increasingly by other members.

A session runs like this: people reply in the club's GroupMe chat, the organizer marks
them in, picks a format per set, generates pairings, shares the sheet back to the chat as
an image, and taps the winning pair as each set finishes.

---

## Architecture

A React PWA on Firebase Hosting with **no backend of its own**. The browser is the whole
application and talks to Firestore directly. Most constraints below follow from that one
fact: no scheduled jobs, no server-side reads, no credentials, no cross-client
transactions.

### The one structural rule

`TennisPairingApp.jsx` never imports Firebase. It calls four methods on `window.storage`
— `get`, `set`, `delete`, `list`. `firebaseStorage.js` is the only file that knows
Firestore exists, and `main.jsx` wires it up with a single line:

```js
window.storage = firebaseStorage;
```

That seam is why the test suite can drive every screen against a stand-in store with no
live project. Keep it.

### Files

| File | Role |
|---|---|
| `src/TennisPairingApp.jsx` | The entire app — one component, ~5.6k lines |
| `src/firebaseStorage.js` | The storage layer, and the only Firebase importer |
| `src/firebaseConfig.js` | Project keys (public by design; App Check is the control) |
| `src/main.jsx` | Entry point; wires storage in |
| `index.html` | Includes `noindex` — the app stays out of search engines |
| `public/robots.txt` | Site-wide crawler block |

React 19, Vite 8, Tailwind 4, `vite-plugin-pwa`.

### Deploy

GitHub Desktop → push to `main` → GitHub Actions runs `npm ci && npm run build` →
Firebase Hosting. About 45 seconds. No CLI in the loop.

App Check (reCAPTCHA Enterprise) is **enforced**: Firestore rejects any request without a
valid token. Enforcement and the Firestore rules live in the Firebase console, not in this
repo — nothing here can confirm them.

---

## Data

One Firestore collection, `court-call-data`, one document per key, each holding a JSON
string in a `value` field. **Every write replaces a whole document** — the most important
thing to know about this system's failure modes.

| Key | Holds | Scope |
|---|---|---|
| `player-directory` | Every member: name, sex, ratings, handedness, competitive and serving ratings, comments, court preference, active flag | Shared |
| `player-directory-backup` | Last 10 snapshots, each with timestamp, reason, author | Shared |
| `match-history` | Every logged result, keyed by date, set, court and players | Shared |
| `admin-registry` | Superuser and Admin PINs, each SHA-256 with its own salt | Shared |
| `audit-log` | Admin and Superuser actions, newest first, capped at 500 | Shared |
| `weekly-state-v2:<id>` | One week's sheet: who's playing, session window, set formats, schedule, plus audit fields `rev`, `writeId`, `writer` | Per browser |
| `usage-telemetry:<id>` | Visits, engagement, tab and action counts, device class | Per browser |

`<id>` is a random id each browser mints into `localStorage`. Weekly sheets are per
browser because a single shared one meant two organizers silently erased each other's
work — every save rewrote the whole document from that device's memory. Per browser rules
out collisions between organizers.

It does not rule them out within one browser. Two copies of the app there — two tabs, or
the home-screen app beside a browser tab — share the id and so the document. Every save
therefore reads first: if the stored `writeId` is not the last one this copy wrote or
loaded, another copy has saved since, and this copy takes that version and drops its own
change instead of overwriting it. A copy coming back to the foreground reloads the same
way. This is not a lock — Firestore cannot lock across copies — so a gap remains between
the read and the write. `rev` counts saves and `writer` names the copy that made each
one, so any collision is readable from the document alone.

Birth year and injury notes are still stored and exported but are **not shown or editable
anywhere in the app**, and nothing reads them.

### Retention

A weekly sheet is deleted when it has been **idle 8 days AND its date has passed** — both,
always. Anything dated today or later survives at any age. Capped at 3 deletions per app
load. Only weekly sheets are ever deleted.

Cleanup runs when somebody opens the app. With no server there are no scheduled jobs, so a
quiet month deletes nothing until the next visit. Firestore TTL would fix that without a
backend but cannot express a two-condition rule.

---

## The pairing engine

Pure functions, no I/O. Each set runs **250 shuffled attempts**, scores each, keeps the
cheapest. Every criterion becomes one comparable number so they can be weighed at once.

| × | Penalty |
|---|---|
| 10 | Skill imbalance between the two teams |
| 3 | Partners who have already played together |
| 2 | Spread of competitive ratings on one court |
| 2 | Serving imbalance between the two teams |
| 2 | Both weak servers (1–2 of 5) on the same team |
| 1 | Opponents already faced this session |

A 0.5 rating gap costs 5, so skill dominates and everything else breaks ties beneath it.
Sit-outs carry their own penalty and counts carry between sets.

**Six fields reach the engine, no more:** CTA rating (skill, the club's own scale, applied
to everyone), USTA rating (skill, only for players with no CTA rating), competitive 1–5
(grouping temperaments on a court), serving 1–5 (team composition only), sex (mixed and
split formats), preferred court (honoured every set).

Handedness, age, comments and match results never reach it. Ratings are set by hand and
**results never change them**.

Partner variety is session-scoped: it works across the sets of one session and starts
fresh next time.

### Formats belong to the set

**Mixed** — mixed doubles, plus a singles court when exactly two would otherwise have
nothing to fill. **Split by sex** — women's and men's doubles wherever four of a sex are
playing, women on the higher courts. **Singles** — the whole set, two per court.

Single-sex courts must fill *first*. Courts fill in list order, so one placed last would
find the mixed courts had already taken the women and would silently degrade to ordinary
doubles.

---

## Session semantics

The subtlest part of the app, and the source of most of its bug reports. A generated sheet
is stamped with the session date it was built for (`schedule.generatedFor`). From that,
three states — see `scheduleIsForSession`:

1. **The sheet holds exactly who is marked in** → it is this session's sheet, whatever the
   stamp says. An organizer who generates before setting the date, or corrects the date
   afterwards, has not thrown their pairings away. If the stamp names another day, a quiet
   note says so and offers a re-roll.
2. **People differ, same day (or no stamp)** → somebody arrived or left since it was made.
   Pairings still shown, with a warning naming who is on the sheet but not playing and who
   is playing but absent, plus a Regenerate button.
3. **People differ and the stamp names another day** → a previous session's sheet. Not
   shown; explained instead, with a way to generate.

**The people are the ground truth, not the date.** Judging on the stamp alone hides good
pairings; ignoring it entirely lets last week's sheet pass as this week's.

### Watching versus copying

Each browser has its own sheet, so the sessions panel offers both:

- **Watch** re-reads another browser's sheet live and renders it in place of your own.
  Hand adjustments included. Neither sheet is modified. Persisted per browser, so it
  survives a return visit. Adjust and Re-roll are hidden while watching — they would edit
  your own sheet, not the one on screen.
- **Copy** pulls it onto this browser to work on, replacing whatever was there. Reads
  fresh at the moment of copying, not from the cached session list.

Logging a winner while watching binds to **that** sheet's date and player map, not yours.
Results go to the shared history either way.

---

## Access

Three tiers, no user accounts, no login list to maintain.

| Tier | Opens | Unlocked by |
|---|---|---|
| Open | Marking who's playing, generating and adjusting pairings, logging winners, reading history | Nothing |
| Admin | The directory, plus editing and deleting history | A named PIN |
| Superuser | All the above, plus granting/revoking Admin, snapshots and restore, full export, activity log, usage | One PIN, behind five taps on the logo |

Idle locks: Admin and history editing 10 minutes, Superuser 5, with a warning 60 seconds
before.

PINs are **hashed, not encrypted** — SHA-256 with a unique 16-byte salt each. With no
server, any decryption key would ship in the public bundle beside what it protects.

The admin registry lives in its own document because Admins can already edit the
directory; a flag stored there would sit inside the thing it controls.

**Storage failures must not downgrade access.** The storage layer tags every read error as
`not-found` or `unavailable`. First-time setup runs only on a confirmed `not-found`, and
every PIN check refuses *any* PIN — including a correct one — when the registry cannot be
confirmed either way. Without that distinction a browser unable to reach Firestore looks
identical to a fresh install, and the app rebuilds default access in memory.

---

## Testing

```
npm install
node test/run.mjs
```

The runner rebuilds the bundle from `src/` first, so it always tests current source. The
app is driven headlessly in jsdom against a mock `window.storage` that reproduces the real
error tagging. Tests click real buttons and assert on what reaches storage rather than
calling internals.

10 suites: `drift`, `layout`, `legacy`, `logging`, `persist`, `session`, `share`, `smoke`,
`stamp`, `watch`. 170 assertions.

Lint with `npx oxlint src/TennisPairingApp.jsx`. Baseline is 9 warnings — treat any
increase as a regression.

This suite has repeatedly caught things a linter could not: a crash from a hook declared
before its callback, a snapshot written before the user confirmed anything, a copy
silently using stale data, and a late arrival making a whole sheet vanish.

---

## Do not undo these without reading why

- **Import merges field by field.** Only fields the spreadsheet supplies are written; a
  blank cell means "nothing to say", never "erase this". Replacing the record instead
  silently resets every hand-entered value a names-and-ratings roster does not carry.
- **The admin registry stays in its own document.** Moving it onto player records permits
  self-escalation.
- **Single-sex courts fill first.** Otherwise they degrade to ordinary doubles with no
  error.
- **A failed read is not an empty one.** The `not-found` / `unavailable` distinction is
  load-bearing for access control.
- **The people decide which session a sheet belongs to**, with the date stamp as a
  secondary signal. Both have been tried alone and both fail.
- **Badges stay rare and positive.** The streak flame needs 3+ wins. Everything derived
  from logged results is distorted by incomplete logging — an unlogged loss does not break
  a streak — so the flame can overstate, not just lag.
- **Every weekly save reads before it writes.** Without the `writeId` check, a second copy
  of the app in the same browser writes its stale schedule over a newer one.
- **Delete dead code rather than leaving it.** Code that cannot work misleads the next
  reader.

---

## Known limits, accepted

- **Court numbers are unverified.** Assigned from headcount alone; the club calendar
  cannot be read from a browser, so the app links out to it instead. A printed court
  number carries no guarantee it is free.
- **Directory writes are whole-document.** Two Admins editing simultaneously overwrite
  each other silently. Snapshots make it recoverable. One document per player is the real
  fix and is a migration, not a patch.
- **Analytics under-counts.** Privacy-blocking browsers drop the script; the in-app usage
  panel counts those people and Google Analytics does not. The in-app figures are the
  honest ones.
- **`xlsx` carries open advisories** with no patched release. Import is Admin-only and
  needs a crafted file, so practical risk is low.
- **Sharing depends on the browser.** `navigator.share` with files is the primary path;
  the fallback saves the PNG. Brave is the one to watch — it has broken this app before by
  blocking the App Check script.

## Open, not started

- **Open bug: a generated schedule can fail to reach Firestore** while fresh `playingIds`
  do, leaving last session's sheet in the document. Seen live on v0.82.0. Reproduced as a
  second copy of the app in the same browser writing its stale schedule back. Fixed in
  v0.83.0 (the `writeId` check above); not yet confirmed with the organizer that this was
  his case. Full briefing, evidence and what has been ruled out:
  `docs/open-bug-schedule-persistence.md`

- Per-player directory documents, removing the last write conflict
- Repeat-partner avoidance across weeks, now that match history is real
- A limitation flag for players returning from injury, with a review cycle
- A computed form signal from match history, kept separate from the organizer's rating
- Multi-club support — currently one shared directory and one shared history for everyone

---

## Working with Vick

- Summarize what is in a release and get an explicit go-ahead **before** packaging files,
  especially for anything touching access or data.
- The directory and match history are irreplaceable. Pairings regenerate in seconds;
  hand-entered player data and logged results cannot be reconstructed. Any change touching
  either needs explicit preservation tests before it ships, not after.
- Ask which version is deployed before bumping — do not infer it from the working copy.
- For multi-step setup, one command at a time, and wait for the result before the next.
- Reference docs describe current state only, with the version dated in the footer.

---

*Court Call v0.83.0 · 5 November 2026*
