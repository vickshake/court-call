# Open bug: schedule never reaches Firestore

Briefing as written, unedited.

```text
SYMPTOM
On Thu 5 Nov, Robb Fox (club organizer) generated a correct sheet for 16
players on his phone and shared it to GroupMe as an image. A second admin
watching his sheet from another browser saw 12 DIFFERENT players from the
1 Nov session. The correct schedule existed in Robb's browser -- it
rendered and drew to canvas for the share image -- but never reached
Firestore.

EVIDENCE (Firestore backup, that morning)
Document weekly-state-v2:mt6kwpi5oru1ek (Robb's browser):
  playingIds             16 ids, all correct for 5 Nov
  schedule.generatedFor  "2026-11-01"
  schedule contents      12 players, none matching the 16 (Sarah Simnett,
                         Prakhar Mansukhani, Dustin Friedman, Vinay,
                         Sudipta Biswas, others)
  updatedAt              Thu 5 Nov 08:49

The playingIds write landed; the schedule write did not. Writes replace the
whole document, so the 08:49 write carried correct playingIds alongside a
stale schedule. Either the in-memory schedule at that write was still the
old one, or the write carrying the new schedule never completed and a later
write overwrote it with state excluding it.

TELEMETRY (usage-telemetry:mt6kwpi5oru1ek)
generate 9, reroll 42, share_image 10, mark_player 225, winner 0,
Adjust opened 3x ever, lastSeen 08:49. Match history stops 31 Oct.
The 42:9 reroll:generate ratio matters -- many schedule writes in quick
succession, share immediately after.

TRIED AND FAILED
v0.81.0 rebuilt persistWeekly onto a weeklyRef + weeklyWriteRef promise
chain: serialized writes, 3 retries with backoff, read-back verification
for any write carrying a schedule. Did not fix it.

v0.82.0 (current, live) made handleGenerate async and awaited
persistWeekly({ schedule: result }) -- previously fire-and-forget while
setTab('results') ran immediately -- and gated handleShareSheet on awaiting
weeklyWriteRef.current, refusing to share with an 'unsaved' status when
scheduleSavedRef.current is false. Hypothesis: tapping Share opens the
native share sheet, backgrounds the browser, the phone freezes the tab, and
the in-flight write dies with a promise that neither resolves nor rejects,
so no retry fires and no error surfaces. Did not fix it, so that hypothesis
is wrong or incomplete.

RULED OUT
- Not a missing generate. The shared image proves a correct sheet existed.
- Not the session-date gating (scheduleIsForSession). The stale data is in
  Firestore itself, not a display decision.
- Not two admins overwriting each other. Weekly sheets are per-browser,
  keyed by a localStorage device id.

WHERE TO LOOK
1. Whether persistWeekly's read-back verification can pass against a stale
   cached read. The Firestore client SDK can serve a local cache hit; a
   read-back seeing its own pending write, or a cached doc, reports success
   without the write reaching the server.
2. Whether anything writes weekly state outside the weeklyWriteRef chain --
   a stray persistWeekly call, an effect, or the retention/purge path --
   and could clobber the schedule with an older snapshot of state.
3. Whether a queued write's closure holds a stale schedule. A retry
   re-sending an older partial after a newer one succeeded reproduces this
   exactly.
4. App Check token expiry mid-write. App Check is enforced, so a rejected
   write surfaces as a permission error -- check whether the error path
   swallows it.
5. Add a write-audit trail: a monotonic counter plus timestamp written
   beside the schedule, so the next occurrence is diagnosable from the
   document alone.

START HERE
Write a failing test that reproduces stale-schedule-with-fresh-playingIds
in one document, BEFORE changing any source. The persist suite has 22
assertions covering this path, but the test written for v0.81.0 did not
reproduce the bug -- it passed against the old code too. Treat the suite as
insufficient, not as proof.

CONSTRAINTS
Every write replaces the whole document; no cross-client transactions.
Touch nothing in player-directory or match-history -- irreplaceable. Ask
before packaging a release or bumping the version; current is v0.82.0.
```
