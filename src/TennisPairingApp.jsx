import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, RefreshCw, X, Loader2, Shuffle, Upload, Download, Pencil, Check, RotateCcw, Lock, Settings } from 'lucide-react';
import * as XLSX from 'xlsx';

/* ================= pairing engine ================= */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(a, b) {
  return [a, b].sort().join('~');
}

function effSkill(p) {
  return (p.usta !== null && p.usta !== undefined) ? p.usta : p.cta;
}

function hasUsta(p) {
  return p.usta !== null && p.usta !== undefined;
}

function avgSkill(ids, playerMap) {
  return ids.reduce((s, id) => s + effSkill(playerMap[id]), 0) / ids.length;
}

function matchImbalance(teamA, teamB, playerMap) {
  return Math.abs(avgSkill(teamA, playerMap) - avgSkill(teamB, playerMap));
}

// Counts a player's current consecutive win streak, working backward from their most
// recent logged match. Purely a display stat - never touches ratings or pairing logic.
function computeWinStreak(playerId, history) {
  const relevant = history
    .filter((h) => h.winner && (h.teamA.includes(playerId) || h.teamB.includes(playerId)))
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.setNumber || 0) - (a.setNumber || 0);
    });
  let streak = 0;
  for (const h of relevant) {
    const won = (h.teamA.includes(playerId) && h.winner === 'A') || (h.teamB.includes(playerId) && h.winner === 'B');
    if (won) streak++;
    else break;
  }
  return streak;
}

// A match counts as an upset when the winning team's average skill was clearly lower
// than the losing team's - "clearly" meaning at least one full USTA rating tier (0.5).
function isUpset(match, playerMap, threshold = 0.5) {
  if (!match.winner) return false;
  const winners = match.winner === 'A' ? match.teamA : match.teamB;
  const losers = match.winner === 'A' ? match.teamB : match.teamA;
  if (!winners.every((id) => playerMap[id]) || !losers.every((id) => playerMap[id])) return false;
  const winnerAvg = avgSkill(winners, playerMap);
  const loserAvg = avgSkill(losers, playerMap);
  return loserAvg - winnerAvg >= threshold;
}

function competitiveSpread(ids, playerMap) {
  const vals = ids.map((id) => playerMap[id].competitive);
  return Math.max(...vals) - Math.min(...vals);
}

function repeatCost(partnerHist, opponentHist, teamA, teamB) {
  let cost = 0;
  if (teamA.length === 2) cost += (partnerHist[pairKey(teamA[0], teamA[1])] || 0) * 3;
  if (teamB.length === 2) cost += (partnerHist[pairKey(teamB[0], teamB[1])] || 0) * 3;
  teamA.forEach((a) => teamB.forEach((b) => {
    cost += (opponentHist[pairKey(a, b)] || 0) * 1;
  }));
  return cost;
}

function bestDoublesSplit(chosen, partnerHist, opponentHist, playerMap) {
  const [p1, p2, p3, p4] = chosen;
  const options = [
    { teamA: [p1, p2], teamB: [p3, p4] },
    { teamA: [p1, p3], teamB: [p2, p4] },
    { teamA: [p1, p4], teamB: [p2, p3] },
  ];
  let best = options[0];
  let bestC = Infinity;
  options.forEach((opt) => {
    const c = matchImbalance(opt.teamA, opt.teamB, playerMap) * 10 +
      repeatCost(partnerHist, opponentHist, opt.teamA, opt.teamB);
    if (c < bestC) { bestC = c; best = opt; }
  });
  return best;
}

function bestMixedSplit(men, women, partnerHist, opponentHist, playerMap) {
  const [m1, m2] = men;
  const [w1, w2] = women;
  const optA = { teamA: [m1, w1], teamB: [m2, w2] };
  const optB = { teamA: [m1, w2], teamB: [m2, w1] };
  const cA = matchImbalance(optA.teamA, optA.teamB, playerMap) * 10 +
    repeatCost(partnerHist, opponentHist, optA.teamA, optA.teamB);
  const cB = matchImbalance(optB.teamA, optB.teamB, playerMap) * 10 +
    repeatCost(partnerHist, opponentHist, optB.teamA, optB.teamB);
  return cA <= cB ? optA : optB;
}

function buildRound(availableIds, courtSlots, partnerHist, opponentHist, sitOutCount, playerMap) {
  let bestRound = null;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < 250; attempt++) {
    const pool = shuffleArr(availableIds)
      .sort((a, b) => (sitOutCount[b] || 0) - (sitOutCount[a] || 0));

    const used = new Set();
    const matches = [];

    for (const slot of courtSlots) {
      const candidates = pool.filter((id) => !used.has(id));
      let actualFormat = slot.format;

      if (actualFormat === 'Mixed Doubles') {
        const men = candidates.filter((id) => playerMap[id].sex === 'M');
        const women = candidates.filter((id) => playerMap[id].sex === 'F');
        if (men.length < 2 || women.length < 2) actualFormat = 'Doubles';
      }

      const need = actualFormat === 'Singles' ? 2 : 4;
      if (candidates.length < need) continue;

      let chosen;
      let teamA;
      let teamB;

      if (actualFormat === 'Mixed Doubles') {
        const men = shuffleArr(candidates.filter((id) => playerMap[id].sex === 'M')).slice(0, 2);
        const women = shuffleArr(candidates.filter((id) => playerMap[id].sex === 'F')).slice(0, 2);
        chosen = [...men, ...women];
        ({ teamA, teamB } = bestMixedSplit(men, women, partnerHist, opponentHist, playerMap));
      } else if (actualFormat === 'Doubles') {
        chosen = candidates.slice(0, 4);
        ({ teamA, teamB } = bestDoublesSplit(chosen, partnerHist, opponentHist, playerMap));
      } else {
        chosen = candidates.slice(0, 2);
        teamA = [chosen[0]];
        teamB = [chosen[1]];
      }

      chosen.forEach((id) => used.add(id));
      matches.push({ format: actualFormat, teamA, teamB, courtNumber: slot.courtNumber });
    }

    const sittingOut = availableIds.filter((id) => !used.has(id));

    let score = 0;
    matches.forEach((m) => {
      const all = [...m.teamA, ...m.teamB];
      score += matchImbalance(m.teamA, m.teamB, playerMap) * 10;
      score += repeatCost(partnerHist, opponentHist, m.teamA, m.teamB) * 3;
      score += competitiveSpread(all, playerMap) * 2;
    });
    const playingIds = availableIds.filter((id) => used.has(id));
    const avgSitOutPlaying = playingIds.reduce((s, id) => s + (sitOutCount[id] || 0), 0) /
      Math.max(1, playingIds.length);
    sittingOut.forEach((id) => {
      score += Math.max(0, avgSitOutPlaying - (sitOutCount[id] || 0)) * 1;
    });

    if (score < bestScore) {
      bestScore = score;
      bestRound = { matches, sittingOut };
    }
  }

  return bestRound;
}

// Parses court numbers out of a CTA calendar event title. Confirmed format from real
// examples: "Ct 6 - JC Lssn - OMat" (single court), "Cts 1-2: CTA Tennis" (hyphen range),
// "Cts 1,2,3 : USTA 8.0 MX" (comma list). Returns [] if the title doesn't match at all,
// so an unrecognized event safely blocks nothing rather than guessing.
function parseCourtsFromEventTitle(title) {
  if (!title) return [];
  const match = title.match(/^Cts?\s*([\d,\-\s]+)[:\-]/i);
  if (!match) return [];
  const body = match[1].trim();
  if (body.includes('-')) {
    const [a, b] = body.split('-').map((s) => parseInt(s.trim(), 10));
    if (Number.isNaN(a) || Number.isNaN(b)) return [];
    const nums = [];
    for (let n = a; n <= b; n++) nums.push(n);
    return nums;
  }
  if (body.includes(',')) {
    return body.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  }
  const single = parseInt(body, 10);
  return Number.isNaN(single) ? [] : [single];
}

function doTimesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Given calendar events (each {date: 'YYYY-MM-DD', startMinutes, endMinutes, title}) and a
// requested session window, returns which of courts 1-6 are blocked by a real overlap.
function computeBookedCourts(events, sessionDate, sessionStartMinutes, sessionEndMinutes) {
  const blocked = new Set();
  events.forEach((ev) => {
    if (ev.date !== sessionDate) return;
    if (!doTimesOverlap(sessionStartMinutes, sessionEndMinutes, ev.startMinutes, ev.endMinutes)) return;
    parseCourtsFromEventTitle(ev.title).forEach((n) => blocked.add(n));
  });
  return blocked;
}

// Converts one ICS DTSTART/DTEND value (e.g. "20260802T100000Z" or "20260802T100000") into
// {date: 'YYYY-MM-DD', minutes} in Half Moon Bay local time, per RFC 5545.
function icsDateTimeToLocal(dtValue) {
  const isUTC = dtValue.endsWith('Z');
  const clean = dtValue.replace('Z', '');
  const y = clean.slice(0, 4);
  const mo = clean.slice(4, 6);
  const d = clean.slice(6, 8);
  const h = clean.slice(9, 11);
  const mi = clean.slice(11, 13);
  if (!isUTC) {
    // No Z suffix: per RFC 5545 this is either a floating time or paired with a TZID
    // parameter. For this specific calendar (Half Moon Bay club events), the digits are
    // already the local wall-clock time, so no conversion is needed or safe to assume.
    return { date: `${y}-${mo}-${d}`, minutes: Number(h) * 60 + Number(mi) };
  }
  // Z suffix: genuinely UTC, needs real conversion to Pacific time. Routed through Intl
  // rather than a hardcoded offset, since that offset shifts with daylight saving.
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
  const localDateStr = dt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const localTimeStr = dt.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const [lh, lm] = localTimeStr.split(':').map(Number);
  return { date: localDateStr, minutes: lh * 60 + lm };
}

// Parses a raw ICS (iCalendar) document into {title, date, startMinutes, endMinutes} events.
// Handles RFC 5545 line folding (continuation lines start with a space) before extracting
// VEVENT blocks, so a SUMMARY or DTSTART split across physical lines still reads correctly.
function parseICS(icsText) {
  if (!icsText) return [];
  const rawLines = icsText.split(/\r\n|\n|\r/);
  const lines = [];
  rawLines.forEach((line) => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  });

  const events = [];
  let current = null;
  lines.forEach((line) => {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = { title: '', dtstart: '', dtend: '' };
    } else if (line.startsWith('END:VEVENT')) {
      if (current && current.dtstart && current.dtend) {
        const start = icsDateTimeToLocal(current.dtstart);
        const end = icsDateTimeToLocal(current.dtend);
        events.push({ title: current.title, date: start.date, startMinutes: start.minutes, endMinutes: end.minutes });
      }
      current = null;
    } else if (current) {
      if (line.startsWith('SUMMARY')) {
        current.title = line.slice(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('DTSTART')) {
        current.dtstart = line.slice(line.lastIndexOf(':') + 1).trim();
      } else if (line.startsWith('DTEND')) {
        current.dtend = line.slice(line.lastIndexOf(':') + 1).trim();
      }
    }
  });
  return events;
}

// Given a player count, returns the court setup that uses as many of them as possible:
// doubles courts first (4 each), with a leftover pair going to a singles court.
function idealCourtSetup(n) {
  if (n < 2) return [];
  const doublesCourts = Math.min(Math.floor(n / 4), 6);
  const remainder = n - doublesCourts * 4;
  const setup = Array.from({ length: doublesCourts }, () => 'Mixed Doubles');
  if (remainder === 2 && setup.length < 6) setup.push('Singles');
  return setup;
}

function computeCourtAssignments(courtsList, blockedNumbers, preferredNumbers) {
  // 1-4 always tried before 5-6, simply because ascending order already puts them first.
  // Numbers blocked by a real, overlapping calendar event are skipped the same way. A slot
  // with an explicit manual override always gets that number directly - overrides are also
  // reserved from the auto-assignment pool for other slots, so a manual pick isn't silently
  // handed to someone else too. (Two overrides pointing at the same number is still possible
  // and deliberately not prevented here - that's surfaced as a clash warning in the UI instead,
  // since silently resolving someone's explicit choice would be the wrong call.)
  //
  // Firm court preferences (for people actually playing today) are pulled to the front of the
  // priority order. Without this, a small session - say 4 people, one court needed - would
  // always number that lone court "1" by strict ascending order, even if the one person
  // playing has a firm preference for court 2 specifically. There'd be no court 2 in the
  // session at all for that preference to land on, no matter what applyCourtPreferences does
  // afterward - the number has to actually be among the assigned courts first.
  const blocked = blockedNumbers || new Set();
  const overriddenNumbers = new Set(courtsList.filter((c) => c.courtNumberOverride).map((c) => c.courtNumberOverride));
  const preferred = (preferredNumbers || []).filter((n, i, arr) => arr.indexOf(n) === i);
  const orderedCandidates = [...preferred, ...[1, 2, 3, 4, 5, 6].filter((n) => !preferred.includes(n))];
  const priority = orderedCandidates.filter((n) => !blocked.has(n) && !overriddenNumbers.has(n));
  const used = new Set();
  return courtsList.map((c) => {
    if (c.courtNumberOverride) {
      return { ...c, courtNumber: c.courtNumberOverride };
    }
    const num = priority.find((n) => !used.has(n));
    if (num !== undefined) used.add(num);
    return { ...c, courtNumber: num !== undefined ? num : null };
  });
}

function applyCourtPreferences(matches, playerMap) {
  const arranged = matches.map((m) => ({ ...m }));

  function preferenceHolder(match) {
    if (!match) return null;
    const all = [...match.teamA, ...match.teamB].map((id) => playerMap[id]);
    return all.find((p) => p.preferredCourt) || null;
  }

  function findByCourtNumber(courtNumber) {
    return arranged.findIndex((m) => m.courtNumber === courtNumber);
  }

  arranged.forEach((match) => {
    const holder = preferenceHolder(match);
    if (!holder) return;
    if (match.courtNumber === holder.preferredCourt) return; // already there
    const targetIdx = findByCourtNumber(holder.preferredCourt);
    if (targetIdx === -1) return; // that court number isn't in play this round
    const occupant = arranged[targetIdx];
    if (preferenceHolder(occupant)) return; // don't bump someone else's own preference to satisfy this one
    const myNumber = match.courtNumber;
    match.courtNumber = occupant.courtNumber;
    occupant.courtNumber = myNumber;
  });

  return arranged;
}

function swapPlayersInRound(round, idA, idB) {
  const newRound = {
    matches: round.matches.map((m) => ({ ...m, teamA: [...m.teamA], teamB: [...m.teamB] })),
    sittingOut: [...round.sittingOut],
  };
  function locate(id) {
    for (let mi = 0; mi < newRound.matches.length; mi++) {
      const m = newRound.matches[mi];
      if (m.teamA.includes(id)) return { arr: m.teamA, idx: m.teamA.indexOf(id) };
      if (m.teamB.includes(id)) return { arr: m.teamB, idx: m.teamB.indexOf(id) };
    }
    if (newRound.sittingOut.includes(id)) return { arr: newRound.sittingOut, idx: newRound.sittingOut.indexOf(id) };
    return null;
  }
  const locA = locate(idA);
  const locB = locate(idB);
  if (!locA || !locB) return round;
  const tmp = locA.arr[locA.idx];
  locA.arr[locA.idx] = locB.arr[locB.idx];
  locB.arr[locB.idx] = tmp;
  return newRound;
}

const SKILL_GAP_WARNING = 1.5;

function matchFeedback(match, allRounds, roundIndex, playerMap) {
  const gap = matchImbalance(match.teamA, match.teamB, playerMap);
  const warnings = [];
  if (gap >= SKILL_GAP_WARNING) {
    warnings.push(`Skill gap of ${gap.toFixed(1)} — a noticeably lopsided match.`);
  }
  if (match.format === 'Mixed Doubles') {
    const teamAOk = match.teamA.some((id) => playerMap[id].sex === 'M') && match.teamA.some((id) => playerMap[id].sex === 'F');
    const teamBOk = match.teamB.some((id) => playerMap[id].sex === 'M') && match.teamB.some((id) => playerMap[id].sex === 'F');
    if (!teamAOk || !teamBOk) warnings.push('Not a valid mixed doubles split anymore (needs one of each per team).');
  }
  const allPlayers = [...match.teamA, ...match.teamB];
  let repeatFound = false;
  allRounds.forEach((r, ri) => {
    if (ri === roundIndex) return;
    r.matches.forEach((m) => {
      const others = [...m.teamA, ...m.teamB];
      const overlap = allPlayers.filter((id) => others.includes(id));
      if (overlap.length >= 2) repeatFound = true;
    });
  });
  if (repeatFound) warnings.push('These players have already shared a court this session.');
  return { gap, warnings };
}

function formatScheduleForGroupMe(schedule) {
  const lines = ['🎾 Court Call pairings'];
  schedule.rounds.forEach((round, ri) => {
    lines.push('');
    lines.push(`SET ${ri + 1}`);
    round.matches.forEach((m, mi) => {
      const teamA = m.teamA.map((id) => schedule.playerMap[id].name).join(' & ');
      const teamB = m.teamB.map((id) => schedule.playerMap[id].name).join(' & ');
      lines.push(`Court ${mi + 1} (${m.format}): ${teamA} vs ${teamB}`);
    });
    if (round.sittingOut.length > 0) {
      lines.push(`Sitting out: ${round.sittingOut.map((id) => schedule.playerMap[id].name).join(', ')}`);
    }
  });
  return lines.join('\n');
}


function generateSchedule(players, courtSlots, roundCount) {
  const playerMap = {};
  players.forEach((p) => { playerMap[p.id] = p; });
  const ids = players.map((p) => p.id);

  const partnerHist = {};
  const opponentHist = {};
  const sitOutCount = {};
  ids.forEach((id) => { sitOutCount[id] = 0; });

  const rounds = [];
  for (let r = 0; r < roundCount; r++) {
    const round = buildRound(ids, courtSlots, partnerHist, opponentHist, sitOutCount, playerMap);
    if (!round) break;
    round.matches = applyCourtPreferences(round.matches, playerMap);
    round.matches.forEach((m) => {
      if (m.teamA.length === 2) {
        const k = pairKey(m.teamA[0], m.teamA[1]);
        partnerHist[k] = (partnerHist[k] || 0) + 1;
      }
      if (m.teamB.length === 2) {
        const k = pairKey(m.teamB[0], m.teamB[1]);
        partnerHist[k] = (partnerHist[k] || 0) + 1;
      }
      m.teamA.forEach((a) => m.teamB.forEach((b) => {
        const k = pairKey(a, b);
        opponentHist[k] = (opponentHist[k] || 0) + 1;
      }));
    });
    round.sittingOut.forEach((id) => { sitOutCount[id] = (sitOutCount[id] || 0) + 1; });
    rounds.push(round);
  }
  return { rounds, playerMap };
}

/* ================= import / export helpers ================= */

function normalizeHeader(h) {
  return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP = {
  fullname: 'name', name: 'name',
  ustarating: 'usta', usta: 'usta',
  ctarating: 'cta', cta: 'cta',
  sex: 'sex', gender: 'sex',
  age: 'age',
  lrhanded: 'handedness', handed: 'handedness', handedness: 'handedness',
  competitiverating15: 'competitive', competitiverating: 'competitive', competitive: 'competitive',
  servingrating15: 'serving', servingrating: 'serving', serving: 'serving',
  injuries: 'injuries',
  commentssuggestions: 'comments', comments: 'comments',
  availability: 'active', activemember: 'active',
  preferredcourt: 'preferredCourt', courtpreference: 'preferredCourt',
};

function rowsToDirectory(rows, referenceYear) {
  const keys = Object.keys(rows[0] || {});
  const keyToField = {};
  keys.forEach((k) => {
    const norm = normalizeHeader(k);
    if (HEADER_MAP[norm]) keyToField[k] = HEADER_MAP[norm];
  });
  const nameKey = keys.find((k) => keyToField[k] === 'name');

  return rows
    .filter((r) => nameKey && r[nameKey] != null && String(r[nameKey]).trim() !== '')
    .map((r) => {
      const out = {};
      keys.forEach((k) => {
        const field = keyToField[k];
        if (field) out[field] = r[k];
      });

      const age = out.age != null && out.age !== '' ? Number(out.age) : null;
      const birthYear = age != null && !Number.isNaN(age) ? referenceYear - age : null;

      const sexRaw = out.sex != null ? String(out.sex).trim().toUpperCase() : '';
      const sex = sexRaw.startsWith('F') ? 'F' : 'M';

      const handRaw = out.handedness != null ? String(out.handedness).trim().toUpperCase() : '';
      const handedness = handRaw.startsWith('L') ? 'L' : handRaw.startsWith('R') ? 'R' : null;

      // Note: the source file's Availability column is a stale snapshot from whenever
      // it was created, not a reliable signal for who's active today - so every import
      // starts active, and the organizer can mark individual exceptions from the Directory tab.
      const active = true;

      const usta = out.usta != null && out.usta !== '' ? Number(out.usta) : null;
      const cta = out.cta != null && out.cta !== '' ? Number(out.cta) : (usta != null ? usta : 3.5);

      // Forgiving of whatever got typed in the cell - "2", "Court 2", "court2" all mean
      // the same thing. Pulls the first number found and validates it's a real court (1-6).
      const preferredCourt = (() => {
        if (out.preferredCourt == null || out.preferredCourt === '') return null;
        const match = String(out.preferredCourt).match(/\d+/);
        if (!match) return null;
        const num = Number(match[0]);
        return num >= 1 && num <= 6 ? num : null;
      })();

      return {
        id: uid(),
        name: String(out.name).trim(),
        sex,
        usta,
        cta,
        birthYear,
        handedness,
        competitive: out.competitive != null && out.competitive !== '' ? Number(out.competitive) : 3,
        serving: out.serving != null && out.serving !== '' ? Number(out.serving) : null,
        injuries: out.injuries != null ? String(out.injuries).trim() : '',
        comments: out.comments != null ? String(out.comments).trim() : '',
        active,
        preferredCourt,
      };
    });
}

function findDirectorySheet(wb) {
  const byName = wb.SheetNames.find((n) => n.toLowerCase().includes('directory'));
  if (byName) return byName;
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
    if (rows.length) {
      const keys = Object.keys(rows[0]).map((k) => normalizeHeader(k));
      if (keys.some((k) => HEADER_MAP[k] === 'name')) return name;
    }
  }
  return wb.SheetNames[0];
}

function directoryToRows(directory, asOfYear) {
  return directory.map((p) => ({
    'Full Name': p.name,
    'USTA Rating': p.usta,
    'CTA Rating': p.cta,
    Sex: p.sex,
    Age: p.birthYear != null ? asOfYear - p.birthYear : null,
    'Birth Year': p.birthYear,
    'L/R Handed': p.handedness,
    'Competitive rating (1-5)': p.competitive,
    'Serving rating (1-5)': p.serving,
    Injuries: p.injuries,
    'Comments/suggestions': p.comments,
    'Active Member': p.active ? 'y' : 'n',
    'Preferred Court': p.preferredCourt,
  }));
}

/* ================= app ================= */

const DIRECTORY_KEY = 'player-directory';
const WEEKLY_KEY = 'weekly-state-v2';
const HISTORY_KEY = 'match-history';
const PIN_KEY = 'directory-pin';
const ADMIN_REGISTRY_KEY = 'admin-registry';
const AUDIT_LOG_KEY = 'audit-log';
const DEFAULT_PIN = '1234';
// Set explicitly by the standalone build's entry point (main.jsx). Inside a Claude artifact
// this stays false, since that's the only environment where the AI-extraction call below
// is actually authenticated.
function isStandalone() {
  return typeof window !== 'undefined' && window.__CC_STANDALONE__ === true;
}
const SKILL_OPTIONS = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
const THIS_YEAR = new Date().getFullYear();
function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + ':' + pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makePinRecord(pin) {
  const salt = generateSalt();
  const hash = await hashPin(pin, salt);
  return { hash, salt };
}

async function pinMatches(enteredPin, record) {
  if (!record || !record.hash || !record.salt) return false;
  const attemptHash = await hashPin(enteredPin.trim(), record.salt);
  return attemptHash === record.hash;
}

// A rejected window.storage.get() can mean two very different things: the key
// genuinely doesn't exist yet (safe to treat as empty / first-time setup), or the
// request simply couldn't complete - network down, a browser privacy shield blocking
// App Check's verification script, permission denied, etc. Treating those two cases
// identically is exactly what let a connectivity failure look like "no data has ever
// been saved," silently resetting access to an insecure default. The real,
// Firestore-backed storage layer (firebaseStorage.js) always tags which case it hit;
// the claude.ai artifact preview environment doesn't provide this tag at all, so an
// untagged error there is treated as its one documented failure mode (key not found).
// An explicit 'unavailable' tag - only ever possible on the real deployment - is never
// treated as "safe to proceed," regardless of environment.
function isConfirmedNotFound(rejectionReason) {
  if (!rejectionReason) return true;
  if (rejectionReason.storageErrorType === 'unavailable') return false;
  return true;
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatSessionDate(iso) {
  if (!iso) return 'today';
  const [y, m, d] = iso.split('-').map(Number);
  // Built from local year/month/day components on purpose - parsing "YYYY-MM-DD" directly
  // with `new Date(iso)` reads it as UTC midnight, which can silently roll back to the
  // previous day once displayed in a timezone behind UTC (exactly the kind of off-by-one
  // this whole feature exists to prevent).
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
// Half Moon Bay, CA (94019) - city center coordinates
const WEATHER_LAT = 37.4636;
const WEATHER_LON = -122.4286;
// Half Moon Bay Airport - the nearest active NWS observation station, confirmed directly
// against weather.gov for these coordinates. A real station reading, not a model estimate.
const NWS_STATION_ID = 'KHAF';

function uvCategory(uv) {
  if (uv == null) return null;
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very High';
  return 'Extreme';
}

function weatherDisplay(code) {
  // WMO weather interpretation codes, per Open-Meteo's documented table.
  if (code === 0) return { icon: '☀️', label: 'Clear', color: '#D97706' };
  if (code === 1 || code === 2) return { icon: '🌤️', label: 'Mostly clear', color: '#D97706' };
  if (code === 3) return { icon: '☁️', label: 'Overcast', color: '#64748B' };
  if (code === 45 || code === 48) return { icon: '🌫️', label: 'Fog', color: '#64748B' };
  if ([51, 53, 55, 56, 57].includes(code)) return { icon: '🌦️', label: 'Drizzle', color: '#2563EB' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { icon: '🌧️', label: 'Rain', color: '#2563EB' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: '❄️', label: 'Snow', color: '#0EA5E9' };
  if ([95, 96, 99].includes(code)) return { icon: '⛈️', label: 'Storms', color: '#7C3AED' };
  return { icon: '🌡️', label: '', color: 'var(--muted)' };
}

// NWS text descriptions are generated by a phrase system that isn't a fixed, documented
// set of strings (confirmed by NWS API maintainers) - so this matches on keywords rather
// than trying to enumerate every possible phrase, showing the real NWS wording as the label.
function nwsDisplay(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('thunder')) return { icon: '⛈️', color: '#7C3AED' };
  if (t.includes('snow') || t.includes('sleet') || t.includes('ice')) return { icon: '❄️', color: '#0EA5E9' };
  if (t.includes('rain') || t.includes('shower') || t.includes('drizzle')) return { icon: '🌧️', color: '#2563EB' };
  if (t.includes('fog') || t.includes('mist') || t.includes('haze')) return { icon: '🌫️', color: '#64748B' };
  if (t.includes('overcast') || t.includes('cloudy')) return { icon: '☁️', color: '#64748B' };
  if (t.includes('partly') || t.includes('few clouds') || t.includes('scattered')) return { icon: '🌤️', color: '#D97706' };
  if (t.includes('clear') || t.includes('sunny') || t.includes('fair')) return { icon: '☀️', color: '#D97706' };
  return { icon: '🌡️', color: 'var(--muted)' };
}

const TIME_OPTIONS = (() => {
  const opts = [];
  for (let mins = 8 * 60; mins <= 20 * 60; mins += 30) {
    const h = String(Math.floor(mins / 60)).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    opts.push(`${h}:${m}`);
  }
  return opts;
})();
function formatSessionTime(hhmm) {
  if (!hhmm) return '';
  const [h, min] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${period}`;
}
const DURATION_OPTIONS = [30, 60, 90, 120, 150, 180, 210, 240]; // minutes: 30min up to 4hr
function formatDuration(mins) {
  const m = Number(mins);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} min`;
  if (rem === 0) return `${h} hr`;
  return `${h}.5 hr`;
}
function addMinutesToTime(hhmm, minsToAdd) {
  const [h, min] = hhmm.split(':').map(Number);
  const total = h * 60 + min + Number(minsToAdd);
  const endH = Math.floor(total / 60) % 24;
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}
function formatSessionDateTime(iso, hhmm, durationMins) {
  const datePart = formatSessionDate(iso);
  if (!hhmm) return datePart;
  const startPart = formatSessionTime(hhmm);
  if (!durationMins) return `${datePart} at ${startPart}`;
  const endPart = formatSessionTime(addMinutesToTime(hhmm, durationMins));
  return `${datePart}, ${startPart} - ${endPart}`;
}

function PlayerToggleRow({ p, playing, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="tp-focus w-full flex items-center gap-3 px-4 py-3 text-left"
      style={{
        borderRadius: 14,
        border: playing ? '2px solid var(--court)' : '1px solid var(--line)',
        background: playing ? 'var(--court-tint)' : 'var(--surface)',
      }}
    >
      <span
        className="flex items-center justify-center shrink-0"
        style={{
          width: 22, height: 22, borderRadius: 7,
          border: playing ? 'none' : '2px solid var(--line)',
          background: playing ? 'var(--court)' : 'transparent',
        }}
      >
        {playing && <Check size={14} color="#fff" />}
      </span>
      <span className={`text-xs font-bold px-2 py-1 rounded-md tp-chip-${p.sex}`}>{p.sex}</span>
      <span className="flex-1 font-medium text-sm truncate">{p.name}</span>
      <span className="text-xs px-2 py-1 rounded-md font-medium whitespace-nowrap" style={{ background: '#F1F1EE', color: 'var(--muted)' }}>
        {effSkill(p).toFixed(1)} {hasUsta(p) ? 'USTA' : 'CTA'}
      </span>
    </button>
  );
}

function normalizeName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function levenshtein1(a, b) {
  // Returns true only if a and b differ by exactly one single-character edit
  // (substitution, insertion, or deletion). Cheap on purpose - this only needs
  // to catch near-miss spellings like "Marc" vs "Mark", not fuzzy-match everything.
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length === b.length) { i += 1; j += 1; }
    else if (a.length > b.length) { i += 1; }
    else { j += 1; }
  }
  edits += (a.length - i) + (b.length - j);
  return edits === 1;
}

function matchNameToDirectory(inputName, directory) {
  const norm = normalizeName(inputName);
  if (!norm) return null;
  const exact = directory.find((p) => normalizeName(p.name) === norm);
  if (exact) return { input: inputName, status: 'matched', player: exact };

  const inputTokens = norm.split(' ');

  if (inputTokens.length === 1) {
    // Single word given (typical GroupMe short name) - matching on first name alone is safe,
    // since no surname was supplied that could contradict it.
    const candidates = directory.filter((p) => normalizeName(p.name).split(' ')[0] === inputTokens[0]);
    if (candidates.length === 1) {
      // Safety net: even with one exact match, check for a differently-spelled but
      // easily-confused first name (Marc vs Mark) - surface it as a choice rather
      // than silently picking, since a one-letter difference is an easy typo to make either way.
      const nearMiss = directory.filter((p) => {
        const firstName = normalizeName(p.name).split(' ')[0];
        return p.id !== candidates[0].id && levenshtein1(firstName, inputTokens[0]);
      });
      if (nearMiss.length > 0) {
        return { input: inputName, status: 'ambiguous', candidates: [...candidates, ...nearMiss] };
      }
      return { input: inputName, status: 'matched', player: candidates[0] };
    }
    if (candidates.length > 1) return { input: inputName, status: 'ambiguous', candidates };
    return { input: inputName, status: 'unmatched' };
  }

  // A full name was given - only match if one name is genuinely a superset/subset of the
  // other (e.g. "Letizia Pileggi" vs "Letizia Pileggi Murphy"). Sharing just a first name
  // with a different surname means a different person, not a match.
  const candidates = directory.filter((p) => {
    const pNorm = normalizeName(p.name);
    return pNorm.includes(norm) || norm.includes(pNorm);
  });
  if (candidates.length === 1) return { input: inputName, status: 'matched', player: candidates[0] };
  if (candidates.length > 1) return { input: inputName, status: 'ambiguous', candidates };
  return { input: inputName, status: 'unmatched' };
}

const NON_NAME_WORDS = new Set([
  'in', 'out', 'im', 'yes', 'yeah', 'yep', 'no', 'maybe', 'yesterday', 'today', 'tomorrow',
  'who', 'else', 'will', 'play', 'plays', 'playing', 'if', 'not', 'too', 'late', 'work', 'works',
  'thursday', 'friday', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'have', 'we',
]);

function looksLikeName(s) {
  const t = s.trim();
  if (!t || t.length > 40) return false;
  if (!/[a-zA-Z]/.test(t)) return false; // must contain a letter - rejects bare numbers/emoji
  if (/[?!]/.test(t)) return false;
  if (/^[A-Z]{2}$/.test(t)) return false; // GroupMe's own avatar-initials line (e.g. "TL", "RF")
  if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(t)) return false; // a bare timestamp
  const words = t.toLowerCase().replace(/[.,]/g, '').split(/\s+/);
  if (words.some((w) => NON_NAME_WORDS.has(w))) return false;
  return true;
}

function parseNamesText(text) {
  const candidates = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).filter(looksLikeName);
  const seen = new Set();
  const deduped = [];
  candidates.forEach((n) => {
    const key = n.toLowerCase();
    if (!seen.has(key)) { seen.add(key); deduped.push(n); }
  });
  return deduped;
}

const TIME_SUFFIX_RE = /\s*(?:\d{1,2}:\d{2}\s*[AP]M\.?|Just now)\s*$/i;
const YOU_SUFFIX_RE = /\s*\(you\)\s*$/i;

function extractNamesFromPaste(rawText) {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const timeStampedLines = lines.filter((l) => TIME_SUFFIX_RE.test(l));

  if (timeStampedLines.length === 0) {
    // No lines carry a "Name ... 7:22 AM" pattern - this is a plain list of names,
    // not a pasted chat thread. Use the simple one-per-line parser as before.
    return parseNamesText(rawText);
  }

  // Looks like a pasted chat thread. Only lines ending in a timestamp are genuine
  // "who said this" attribution lines - message content, reaction counts, date
  // separators ("Today"/"Yesterday"), and avatar-initials lines never end in a
  // timestamp, so they're excluded automatically rather than needing their own rules.
  const names = [];
  const seen = new Set();
  timeStampedLines.forEach((line) => {
    let name = line.replace(TIME_SUFFIX_RE, '').trim();
    name = name.replace(YOU_SUFFIX_RE, '').trim();
    if (!name || !looksLikeName(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return; // the same person posting more than once shouldn't duplicate
    seen.add(key);
    names.push(name);
  });
  return names;
}

const BLANK_FORM = {
  name: '', sex: 'M', usta: '', cta: '3.5', handedness: 'R',
  competitive: '3', serving: '', injuries: '', comments: '',
  preferredCourt: '', birthYear: '',
};

export default function TennisPairingApp() {
  const [directory, setDirectory] = useState([]);
  const [playingIds, setPlayingIds] = useState([]);
  const [courts, setCourts] = useState([
    { id: 'c1', format: 'Mixed Doubles', courtNumber: 1 },
    { id: 'c2', format: 'Mixed Doubles', courtNumber: 2 },
    { id: 'c3', format: 'Doubles', courtNumber: 3 },
    { id: 'c4', format: 'Doubles', courtNumber: 4 },
  ]);
  const [sessionDate, setSessionDate] = useState(todayISO());
  const [sessionTime, setSessionTime] = useState('');
  const [sessionDuration, setSessionDuration] = useState('');
  const [weather, setWeather] = useState(null);
  const [weatherStatus, setWeatherStatus] = useState('idle'); // idle | loading | ready | unavailable | error
  const [nwsConditionText, setNwsConditionText] = useState(null);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarStatus, setCalendarStatus] = useState('idle'); // idle | loading | ready | error
  const [rounds, setRounds] = useState(3);
  const [schedule, setSchedule] = useState(null);
  const [history, setHistory] = useState([]);

  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState('today');
  const [search, setSearch] = useState('');
  const [todaySearch, setTodaySearch] = useState('');
  const [showInactiveToday, setShowInactiveToday] = useState(false);
  const [namesText, setNamesText] = useState('');
  const [lastBulkMatchedIds, setLastBulkMatchedIds] = useState([]);
  const [matchResults, setMatchResults] = useState(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [showMoreFields, setShowMoreFields] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(BLANK_FORM);

  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingUncheck, setConfirmingUncheck] = useState(false);
  const [directoryPin, setDirectoryPin] = useState(DEFAULT_PIN);
  const [directoryUnlocked, setDirectoryUnlocked] = useState(false);
  const [adminRegistry, setAdminRegistry] = useState({ superuserPin: DEFAULT_PIN, admins: [] });
  const [registryUnavailable, setRegistryUnavailable] = useState(false); // true when the admin registry couldn't be confirmed either way - blocks all PIN checks until resolved
  const [directoryLoadError, setDirectoryLoadError] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [auditLog, setAuditLog] = useState([]);
  const [currentAdminName, setCurrentAdminName] = useState(null); // who unlocked Admin this session
  const [superuserUnlocked, setSuperuserUnlocked] = useState(false);
  const [superuserPinInput, setSuperuserPinInput] = useState('');
  const [superuserPinError, setSuperuserPinError] = useState('');
  const [showSuperuserGate, setShowSuperuserGate] = useState(false);
  const [newAdminPlayerId, setNewAdminPlayerId] = useState('');
  const [newAdminPin, setNewAdminPin] = useState('');
  const [newAdminPinError, setNewAdminPinError] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [clearHistoryStep, setClearHistoryStep] = useState('idle'); // idle | pin | unlocked | confirm
  const [clearHistoryPinInput, setClearHistoryPinInput] = useState('');
  const [clearHistoryPinError, setClearHistoryPinError] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackEmail, setFeedbackEmail] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState('idle'); // idle | sending | sent | error
  const [searchSuggestOpen, setSearchSuggestOpen] = useState(false);
  const [celebratingMatchId, setCelebratingMatchId] = useState(null);
  const [logoTapState, setLogoTapState] = useState({ count: 0, lastTime: 0 });
  const [editingRoundIndex, setEditingRoundIndex] = useState(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [copyFallbackText, setCopyFallbackText] = useState('');
  const [importYear, setImportYear] = useState(String(THIS_YEAR));
  const [importStatus, setImportStatus] = useState('');
  const [pendingImport, setPendingImport] = useState(null);
  const fileInputRef = useRef(null);
  const copyFallbackRef = useRef(null);

  useEffect(() => {
    if (copyStatus === 'fallback' && copyFallbackRef.current) {
      copyFallbackRef.current.focus();
      copyFallbackRef.current.select();
    }
  }, [copyStatus]);

  const loadAll = useCallback(async () => {
    const [dirResult, weeklyResult, historyResult, pinResult, registryResult, auditResult] = await Promise.allSettled([
      window.storage.get(DIRECTORY_KEY, true),
      window.storage.get(WEEKLY_KEY, true),
      window.storage.get(HISTORY_KEY, true),
      window.storage.get(PIN_KEY, true),
      window.storage.get(ADMIN_REGISTRY_KEY, true),
      window.storage.get(AUDIT_LOG_KEY, true),
    ]);

    if (dirResult.status === 'fulfilled' && dirResult.value && dirResult.value.value) {
      setDirectory(JSON.parse(dirResult.value.value));
      setDirectoryLoadError(false);
    } else if (dirResult.status === 'rejected' && !isConfirmedNotFound(dirResult.reason)) {
      // Couldn't confirm whether a real roster exists - leave whatever was already
      // loaded untouched rather than silently showing "no players," which is exactly
      // what made a connectivity failure look like data loss.
      setDirectoryLoadError(true);
    } else {
      setDirectory([]);
      setDirectoryLoadError(false);
    }

    if (weeklyResult.status === 'fulfilled' && weeklyResult.value && weeklyResult.value.value) {
      const w = JSON.parse(weeklyResult.value.value);
      setPlayingIds(w.playingIds || []);
      if (w.courts) setCourts(w.courts);
      const loadedDate = w.sessionDate || todayISO();
      setSessionDate(loadedDate < todayISO() ? todayISO() : loadedDate);
      setSessionTime(w.sessionTime || '');
      setSessionDuration(w.sessionDuration || '');
      if (w.rounds) setRounds(w.rounds);
      setSchedule(w.schedule || null);
    }
    // No explicit else here, deliberately: on an ambiguous failure this leaves the
    // in-memory state exactly as it already was, rather than resetting anything.

    if (historyResult.status === 'fulfilled' && historyResult.value && historyResult.value.value) {
      setHistory(JSON.parse(historyResult.value.value));
      setHistoryLoadError(false);
    } else if (historyResult.status === 'rejected' && !isConfirmedNotFound(historyResult.reason)) {
      setHistoryLoadError(true);
    } else {
      setHistory([]);
      setHistoryLoadError(false);
    }

    let legacyPin = DEFAULT_PIN;
    if (pinResult.status === 'fulfilled' && pinResult.value && pinResult.value.value) {
      legacyPin = pinResult.value.value;
      setDirectoryPin(pinResult.value.value);
    } else {
      setDirectoryPin(DEFAULT_PIN);
    }

    // Migration only ever runs when the registry is CONFIRMED not to exist yet - never
    // on an ambiguous failure that merely looks the same. This is the actual fix for the
    // incident: a blocked App Check script (or any other connectivity failure) used to
    // be indistinguishable from "first time this has ever loaded," which silently
    // rebuilt a fresh registry defaulting to 1234 - bypassing whatever real PIN had
    // actually been set. Now, any failure that isn't confirmed as "genuinely not found"
    // blocks all PIN access entirely until the connection is confirmed one way or the other.
    if (registryResult.status === 'fulfilled' && registryResult.value && registryResult.value.value) {
      setAdminRegistry(JSON.parse(registryResult.value.value));
      setRegistryUnavailable(false);
    } else if (registryResult.status === 'rejected' && !isConfirmedNotFound(registryResult.reason)) {
      setRegistryUnavailable(true);
      // Deliberately do NOT touch adminRegistry here - it stays at its safe initial
      // value, which cannot successfully match any real PIN (see pinMatches: a plain
      // default string has no .hash/.salt to compare against).
    } else {
      const migratedRecord = await makePinRecord(legacyPin);
      const migratedRegistry = { superuserPin: migratedRecord, admins: [] };
      setAdminRegistry(migratedRegistry);
      setRegistryUnavailable(false);
      try {
        await window.storage.set(ADMIN_REGISTRY_KEY, JSON.stringify(migratedRegistry), true);
      } catch (e) {
        console.error('registry migration save failed', e);
      }
    }

    if (auditResult.status === 'fulfilled' && auditResult.value && auditResult.value.value) {
      setAuditLog(JSON.parse(auditResult.value.value));
    } else {
      setAuditLog([]);
    }
  }, []);

  useEffect(() => { loadAll().then(() => setLoaded(true)); }, [loadAll]);

  useEffect(() => {
    if (!sessionDate) { setWeatherStatus('idle'); return; }
    let cancelled = false;
    const isToday = sessionDate === todayISO();
    if (!isToday) setNwsConditionText(null); // don't show a stale "right now" reading for a different date

    function fetchOpenMeteo() {
      setWeatherStatus((prev) => (prev === 'ready' ? prev : 'loading')); // don't flash "loading" on background refreshes
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}`
        + `&daily=temperature_2m_max,temperature_2m_min,uv_index_max,weather_code&temperature_unit=fahrenheit`
        + `&timezone=America%2FLos_Angeles&start_date=${sessionDate}&end_date=${sessionDate}`;
      fetch(url)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          const hi = data && data.daily && data.daily.temperature_2m_max ? data.daily.temperature_2m_max[0] : null;
          const lo = data && data.daily && data.daily.temperature_2m_min ? data.daily.temperature_2m_min[0] : null;
          const uv = data && data.daily && data.daily.uv_index_max ? data.daily.uv_index_max[0] : null;
          const dailyCode = data && data.daily && data.daily.weather_code ? data.daily.weather_code[0] : null;
          if (hi == null && lo == null) {
            setWeatherStatus('unavailable'); // date outside the forecast window (too far out)
            setWeather(null);
          } else {
            setWeather({ hi, lo, uv, code: dailyCode });
            setWeatherStatus('ready');
          }
        })
        .catch(() => { if (!cancelled) { setWeatherStatus('error'); setWeather(null); } });
    }

    // Today specifically also gets a real, physical station reading from NWS - a live
    // observation rather than a model-derived estimate, for the actual "what does it look
    // like right now" question. Open-Meteo's daily high/low/UV above are unaffected either
    // way. Kept in its own state slot (not merged into `weather`) so this and the Open-Meteo
    // fetch can resolve in either order without one overwriting or discarding the other -
    // merging into a single object caused exactly that race before this fix.
    function fetchNwsCurrent() {
      fetch(`https://api.weather.gov/stations/${NWS_STATION_ID}/observations/latest`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          const text = data && data.properties && data.properties.textDescription ? data.properties.textDescription : null;
          if (text) setNwsConditionText(text);
        })
        .catch(() => { /* silent - Open-Meteo's own condition code remains the fallback */ });
    }

    fetchOpenMeteo();
    if (isToday) fetchNwsCurrent();
    // Both sources update on a similar cadence at their end (Open-Meteo's regional model
    // every 1-3 hours; NWS station observations roughly hourly) - 30 minutes catches a new
    // reading from either reasonably promptly without polling faster than either changes.
    const intervalId = isToday ? setInterval(() => { fetchOpenMeteo(); fetchNwsCurrent(); }, 30 * 60 * 1000) : null;
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  }, [sessionDate]);

  useEffect(() => {
    let cancelled = false;
    setCalendarStatus('loading');
    // CTA Court Schedule calendar ID, decoded from the public embed URL on coastsidetennis.com.
    const CALENDAR_ID = 'p17l7jan7vro6mlh22hialkcng@group.calendar.google.com';
    const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;
    fetch(icsUrl)
      .then((res) => {
        if (!res.ok) throw new Error('calendar fetch failed: ' + res.status);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setCalendarEvents(parseICS(text));
        setCalendarStatus('ready');
      })
      .catch((e) => {
        // Expected to be the most fragile part of this feature - CORS, the calendar not
        // truly being public, or the feed format differing are all real possibilities this
        // sandbox can't rule out ahead of time. Failing here should never break the rest of
        // the app - it just means court availability isn't calendar-verified this session.
        console.error('calendar fetch failed', e);
        if (!cancelled) { setCalendarStatus('error'); setCalendarEvents([]); }
      });
    return () => { cancelled = true; };
  }, []);

  async function persistDirectory(next) {
    setDirectory(next);
    try {
      await window.storage.set(DIRECTORY_KEY, JSON.stringify(next), true);
      setSaveError('');
      return true;
    } catch (e) {
      console.error('directory save failed', e);
      setSaveError("Your directory change didn't save — check your connection and try that action again.");
      return false;
    }
  }

  const MAX_PLAYING = 24; // 6 courts x 4 - the real ceiling this app can ever pair at once
  async function persistWeekly(partial) {
    let incomingPlayingIds = partial.playingIds;
    let capNotice = '';
    if (incomingPlayingIds !== undefined && incomingPlayingIds.length > MAX_PLAYING) {
      capNotice = `Only the first ${MAX_PLAYING} stuck — that's the most this app can pair at once (6 courts × 4).`;
      incomingPlayingIds = incomingPlayingIds.slice(0, MAX_PLAYING);
    }
    let nextCourts = partial.courts !== undefined ? partial.courts : courts;
    if (incomingPlayingIds !== undefined && partial.courts === undefined) {
      // Court count and format track the player count automatically - 8 playing means
      // exactly 2 courts, not whatever was left over from a previous, different-sized group.
      // Any manual court-number override is preserved by position where a slot still exists,
      // so toggling one player doesn't silently discard a deliberate override on another slot.
      const formats = idealCourtSetup(incomingPlayingIds.length);
      nextCourts = formats.map((format, i) => {
        const prior = courts[i];
        const entry = { id: prior ? prior.id : uid(), format };
        if (prior && prior.courtNumberOverride) entry.courtNumberOverride = prior.courtNumberOverride;
        return entry;
      });
    }
    const next = {
      playingIds: incomingPlayingIds !== undefined ? incomingPlayingIds : playingIds,
      courts: nextCourts,
      sessionDate: partial.sessionDate !== undefined ? partial.sessionDate : sessionDate,
      sessionTime: partial.sessionTime !== undefined ? partial.sessionTime : sessionTime,
      sessionDuration: partial.sessionDuration !== undefined ? partial.sessionDuration : sessionDuration,
      rounds: partial.rounds !== undefined ? partial.rounds : rounds,
      schedule: partial.schedule !== undefined ? partial.schedule : schedule,
    };
    if (incomingPlayingIds !== undefined) setPlayingIds(incomingPlayingIds);
    setCourts(nextCourts);
    if (partial.sessionDate !== undefined) setSessionDate(partial.sessionDate);
    if (partial.sessionTime !== undefined) setSessionTime(partial.sessionTime);
    if (partial.sessionDuration !== undefined) setSessionDuration(partial.sessionDuration);
    if (partial.rounds !== undefined) setRounds(partial.rounds);
    if (partial.schedule !== undefined) setSchedule(partial.schedule);
    try {
      await window.storage.set(WEEKLY_KEY, JSON.stringify(next), true);
      setSaveError(capNotice);
    } catch (e) {
      console.error('weekly save failed', e);
      setSaveError("Your last change didn't save — check your connection and try that action again.");
    }
  }

  async function persistHistory(next) {
    setHistory(next);
    try {
      await window.storage.set(HISTORY_KEY, JSON.stringify(next), true);
      setSaveError('');
    } catch (e) {
      console.error('history save failed', e);
      setSaveError("Your match result didn't save — check your connection and try again.");
    }
  }

  async function handleRefresh() {
    setSyncing(true);
    await loadAll();
    setTodaySearch('');
    setSyncing(false);
  }

  function formToEntry(f, existingId) {
    return {
      id: existingId || uid(),
      name: f.name.trim(),
      sex: f.sex,
      usta: f.usta === '' ? null : Number(f.usta),
      cta: Number(f.cta),
      birthYear: f.birthYear === '' || f.birthYear == null ? null : Number(f.birthYear),
      handedness: f.handedness || null,
      competitive: Number(f.competitive),
      serving: f.serving === '' ? null : Number(f.serving),
      injuries: f.injuries.trim(),
      comments: f.comments.trim(),
      active: f.active !== undefined ? f.active : true,
      preferredCourt: f.preferredCourt === '' || f.preferredCourt == null ? null : Number(f.preferredCourt),
    };
  }

  function handleAddPlayer() {
    if (!form.name.trim()) return;
    const entry = formToEntry(form);
    persistDirectory([...directory, entry]);
    persistWeekly({ playingIds: [...playingIds, entry.id] });
    setForm(BLANK_FORM);
    setShowAddForm(false);
    setShowMoreFields(false);
  }

  function startEdit(p) {
    setEditingId(p.id);
    setEditForm({
      name: p.name, sex: p.sex, usta: p.usta === null ? '' : String(p.usta),
      cta: String(p.cta), handedness: p.handedness || 'R', competitive: String(p.competitive),
      serving: p.serving === null ? '' : String(p.serving), injuries: p.injuries || '',
      comments: p.comments || '', birthYear: p.birthYear == null ? '' : String(p.birthYear), active: p.active,
      preferredCourt: p.preferredCourt == null ? '' : String(p.preferredCourt),
    });
  }

  function saveEdit() {
    const updated = formToEntry(editForm, editingId);
    const before = directory.find((p) => p.id === editingId);
    logAudit(currentAdminName || 'Admin', 'directory.edit', `Edited ${before ? before.name : updated.name}`);
    persistDirectory(directory.map((p) => (p.id === editingId ? updated : p)));
    setEditingId(null);
  }

  function handleMatchNames() {
    const raw = extractNamesFromPaste(namesText).map((n) => {
      const r = matchNameToDirectory(n, directory);
      return r && r.status === 'unmatched' ? { ...r, sex: 'M', cta: '3.5' } : r;
    });
    const seenPlayerIds = new Set();
    const results = raw.filter((r) => {
      if (r && r.status === 'matched') {
        if (seenPlayerIds.has(r.player.id)) return false;
        seenPlayerIds.add(r.player.id);
      }
      return true;
    });
    const matchedIds = results.filter((r) => r && r.status === 'matched').map((r) => r.player.id);

    // Anyone this exact box marked playing last time, who isn't in this new submission, gets
    // taken back out - but only people this box itself added. Anyone marked playing some other
    // way (tapping their row, a different device) is never touched by this.
    const droppedFromThisBox = lastBulkMatchedIds.filter((id) => !matchedIds.includes(id));
    const nextPlayingIds = playingIds.filter((id) => !droppedFromThisBox.includes(id));
    const finalIds = Array.from(new Set([...nextPlayingIds, ...matchedIds]));

    if (matchedIds.length || droppedFromThisBox.length) {
      persistWeekly({ playingIds: finalIds });
    }
    setLastBulkMatchedIds(matchedIds);
    setMatchResults(results);
  }

  function resolveAmbiguous(index, player) {
    setMatchResults((prev) => prev.map((r, i) => (i === index ? { ...r, status: 'matched', player } : r)));
    persistWeekly({ playingIds: Array.from(new Set([...playingIds, player.id])) });
  }

  function markAmbiguousAsNew(index) {
    setMatchResults((prev) => prev.map((r, i) => (i === index ? { ...r, status: 'unmatched', sex: 'M', cta: '3.5' } : r)));
  }

  function updatePendingDraft(index, field, value) {
    setMatchResults((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function dismissPending(index) {
    setMatchResults((prev) => prev.filter((_, i) => i !== index));
  }

  function addOnePending(index) {
    const r = matchResults[index];
    if (!r) return;
    const entry = {
      id: uid(), name: r.input.trim(), sex: r.sex || 'M', usta: null,
      cta: Number(r.cta || '3.5'), birthYear: null, handedness: null,
      competitive: 3, serving: null, injuries: '', comments: '', active: true,
    };
    persistDirectory([...directory, entry]);
    persistWeekly({ playingIds: [...playingIds, entry.id] });
    setMatchResults((prev) => prev.map((r2, i) => (i === index ? { ...r2, status: 'matched', player: entry } : r2)));
  }

  function addAllPending() {
    const pendingIdx = matchResults.map((r, i) => (r && r.status === 'unmatched' ? i : -1)).filter((i) => i >= 0);
    if (!pendingIdx.length) return;
    const newEntries = pendingIdx.map((idx) => {
      const r = matchResults[idx];
      return {
        id: uid(), name: r.input.trim(), sex: r.sex || 'M', usta: null,
        cta: Number(r.cta || '3.5'), birthYear: null, handedness: null,
        competitive: 3, serving: null, injuries: '', comments: '', active: true,
      };
    });
    persistDirectory([...directory, ...newEntries]);
    persistWeekly({ playingIds: [...playingIds, ...newEntries.map((e) => e.id)] });
    setMatchResults((prev) => prev.map((r, i) => {
      const pos = pendingIdx.indexOf(i);
      return pos >= 0 ? { ...r, status: 'matched', player: newEntries[pos] } : r;
    }));
  }

  function toggleActive(id) {
    const p = directory.find((pl) => pl.id === id);
    logAudit(currentAdminName || 'Admin', 'directory.toggle_active', p ? `${p.active ? 'Deactivated' : 'Activated'} ${p.name}` : `Toggled active for ${id}`);
    persistDirectory(directory.map((p) => (p.id === id ? { ...p, active: !p.active } : p)));
  }

  function removeFromDirectory(id) {
    const p = directory.find((pl) => pl.id === id);
    logAudit(currentAdminName || 'Admin', 'directory.delete', p ? `Removed ${p.name} from the Directory` : `Removed player ${id}`);
    persistDirectory(directory.filter((p) => p.id !== id));
    persistWeekly({ playingIds: playingIds.filter((pid) => pid !== id) });
  }

  function togglePlaying(id) {
    const next = playingIds.includes(id) ? playingIds.filter((pid) => pid !== id) : [...playingIds, id];
    persistWeekly({ playingIds: next });
    setTodaySearch('');
  }

  function handleStartNewWeek() {
    persistWeekly({ playingIds: [], schedule: null, sessionDate: todayISO(), sessionTime: '', sessionDuration: '' });
    setMatchResults(null);
    setNamesText('');
    setTodaySearch('');
    setLastBulkMatchedIds([]);
    setConfirmingReset(false);
    setTab('today');
  }

  function handleUncheckAll() {
    persistWeekly({ playingIds: [] });
    setMatchResults(null);
    setNamesText('');
    setConfirmingUncheck(false);
  }

  async function findAdminByPin(pin) {
    for (const a of adminRegistry.admins) {
      if (await pinMatches(pin, a.pin)) return a;
    }
    return null;
  }

  async function persistAdminRegistry(next) {
    setAdminRegistry(next);
    try {
      await window.storage.set(ADMIN_REGISTRY_KEY, JSON.stringify(next), true);
      setSaveError('');
    } catch (e) {
      console.error('admin registry save failed', e);
      setSaveError("That didn't save — check your connection and try again.");
    }
  }

  async function logAudit(actor, action, detail) {
    const entry = { id: uid(), timestamp: new Date().toISOString(), actor, action, detail };
    const next = [entry, ...auditLog].slice(0, 500); // capped so this can't grow unbounded
    setAuditLog(next);
    try {
      await window.storage.set(AUDIT_LOG_KEY, JSON.stringify(next), true);
    } catch (e) {
      console.error('audit log save failed', e);
    }
  }

  async function tryUnlockDirectory() {
    if (registryUnavailable) {
      setPinError("Can't verify access right now — check your connection and try again.");
      return;
    }
    const trimmed = pinInput.trim();
    const admin = await findAdminByPin(trimmed);
    if (admin) {
      setDirectoryUnlocked(true);
      setCurrentAdminName(admin.name);
      setPinInput('');
      setPinError('');
    } else if (await pinMatches(trimmed, adminRegistry.superuserPin)) {
      setDirectoryUnlocked(true);
      setCurrentAdminName('Superuser');
      setPinInput('');
      setPinError('');
    } else {
      setPinError('Wrong PIN.');
    }
  }

  async function tryUnlockSuperuser() {
    if (registryUnavailable) {
      setSuperuserPinError("Can't verify access right now — check your connection and try again.");
      return;
    }
    if (await pinMatches(superuserPinInput, adminRegistry.superuserPin)) {
      setSuperuserUnlocked(true);
      setSuperuserPinInput('');
      setSuperuserPinError('');
    } else {
      setSuperuserPinError('Wrong PIN.');
    }
  }

  function handleLogoTap() {
    const now = Date.now();
    setLogoTapState((prev) => {
      const nextCount = now - prev.lastTime < 2000 ? prev.count + 1 : 1;
      if (nextCount >= 5) {
        setTab('directory');
        setShowSuperuserGate(true);
        return { count: 0, lastTime: now };
      }
      return { count: nextCount, lastTime: now };
    });
  }

  async function addAdmin() {
    if (!newAdminPlayerId || !newAdminPin.trim()) return;
    for (const a of adminRegistry.admins) {
      if (await pinMatches(newAdminPin, a.pin)) {
        setNewAdminPinError('That PIN is already assigned to another admin.');
        return;
      }
    }
    const player = directory.find((p) => p.id === newAdminPlayerId);
    if (!player) return;
    const pinRecord = await makePinRecord(newAdminPin.trim());
    const next = {
      ...adminRegistry,
      admins: [...adminRegistry.admins, { id: uid(), playerId: player.id, name: player.name, pin: pinRecord }],
    };
    persistAdminRegistry(next);
    logAudit('Superuser', 'admin.grant', `Granted Admin access to ${player.name}`);
    setNewAdminPlayerId('');
    setNewAdminPin('');
    setNewAdminPinError('');
  }

  function revokeAdmin(adminId) {
    const admin = adminRegistry.admins.find((a) => a.id === adminId);
    const next = { ...adminRegistry, admins: adminRegistry.admins.filter((a) => a.id !== adminId) };
    persistAdminRegistry(next);
    if (admin) logAudit('Superuser', 'admin.revoke', `Revoked Admin access from ${admin.name}`);
  }

  async function tryClearHistoryPin() {
    if (registryUnavailable) {
      setClearHistoryPinError("Can't verify access right now — check your connection and try again.");
      return;
    }
    const trimmed = clearHistoryPinInput.trim();
    const admin = await findAdminByPin(trimmed);
    if (admin || await pinMatches(trimmed, adminRegistry.superuserPin)) {
      setCurrentAdminName(admin ? admin.name : 'Superuser');
      setClearHistoryStep('unlocked');
      setClearHistoryPinInput('');
      setClearHistoryPinError('');
    } else {
      setClearHistoryPinError('Wrong PIN.');
    }
  }

  function confirmClearHistory() {
    logAudit(currentAdminName || 'Admin', 'history.clear_all', `Cleared all ${loggedMatches.length} logged matches`);
    persistHistory([]);
    setClearHistoryStep('idle');
  }

  function cancelClearHistory() {
    setClearHistoryStep('idle');
    setClearHistoryPinInput('');
    setClearHistoryPinError('');
  }

  function deleteHistoryEntry(id) {
    const entry = history.find((h) => h.id === id);
    logAudit(currentAdminName || 'Admin', 'history.delete', entry ? `Deleted match: ${entry.date} Set ${entry.setNumber}` : `Deleted match ${id}`);
    persistHistory(history.filter((h) => h.id !== id));
  }

  async function handleSubmitFeedback() {
    if (!feedbackMessage.trim()) return;
    setFeedbackStatus('sending');
    try {
      const res = await fetch('https://formspree.io/f/xjgnnyyb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: feedbackEmail.trim() || undefined, message: feedbackMessage.trim() }),
      });
      if (res.ok) {
        setFeedbackStatus('sent');
        setFeedbackMessage('');
        setFeedbackEmail('');
      } else {
        setFeedbackStatus('error');
      }
    } catch (e) {
      setFeedbackStatus('error');
    }
  }

  function closeFeedback() {
    setFeedbackOpen(false);
    setFeedbackStatus('idle');
  }

  function setRoundsCount(n) {
    persistWeekly({ rounds: Math.max(1, n) });
  }

  function setCourtSlotOverride(courtId, value) {
    const num = value === '' ? null : Number(value);
    const next = courts.map((c) => {
      if (c.id !== courtId) return c;
      if (num === null) {
        const { courtNumberOverride, ...rest } = c;
        return rest;
      }
      return { ...c, courtNumberOverride: num };
    });
    persistWeekly({ courts: next });
  }

  function handleGenerate() {
    const players = directory.filter((p) => playingIds.includes(p.id));
    const usableCourts = assignedCourts.filter((c) => c.courtNumber !== null);
    const result = generateSchedule(players, usableCourts.map((c) => ({ format: c.format, courtNumber: c.courtNumber })), rounds);
    persistWeekly({ schedule: result });
    setTab('results');
  }

  function matchIdentity(teamA, teamB) {
    return [...teamA, ...teamB].slice().sort().join('-');
  }

  function logResult(setNumber, court, format, teamA, teamB, winner) {
    const dateStr = sessionDate;
    const recordId = `${dateStr}-set${setNumber}-court${court}-${matchIdentity(teamA, teamB)}`;
    const nameOf = (id) => (schedule.playerMap[id] ? schedule.playerMap[id].name : '?');
    const entry = {
      id: recordId,
      date: dateStr,
      setNumber,
      court,
      format,
      teamA,
      teamB,
      teamANames: teamA.map(nameOf),
      teamBNames: teamB.map(nameOf),
      winner,
    };
    const withoutOld = history.filter((h) => h.id !== recordId);
    persistHistory([...withoutOld, entry]);
    if (winner) {
      setCelebratingMatchId(recordId);
      setTimeout(() => setCelebratingMatchId((cur) => (cur === recordId ? null : cur)), 1400);
    }
  }

  function getLoggedWinner(setNumber, court, teamA, teamB) {
    const dateStr = sessionDate;
    const found = history.find((h) => h.id === `${dateStr}-set${setNumber}-court${court}-${matchIdentity(teamA, teamB)}`);
    return found ? found.winner : null;
  }

  function handlePlayerTap(playerId) {
    if (!selectedPlayerId) {
      setSelectedPlayerId(playerId);
      return;
    }
    if (selectedPlayerId === playerId) {
      setSelectedPlayerId(null);
      return;
    }
    const ri = editingRoundIndex;
    const newRound = swapPlayersInRound(schedule.rounds[ri], selectedPlayerId, playerId);
    const newRounds = schedule.rounds.map((r, i) => (i === ri ? newRound : r));
    persistWeekly({ schedule: { ...schedule, rounds: newRounds } });
    setSelectedPlayerId(null);
  }

  function setCourtNumberOverride(roundIndex, matchIndex, newCourtNumber) {
    const round = schedule.rounds[roundIndex];
    const newMatches = round.matches.map((m, i) => (i === matchIndex ? { ...m, courtNumber: newCourtNumber } : m));
    const newRounds = schedule.rounds.map((r, i) => (i === roundIndex ? { ...r, matches: newMatches } : r));
    persistWeekly({ schedule: { ...schedule, rounds: newRounds } });
  }

  async function handleCopyForGroupMe() {
    let latest = schedule;
    try {
      const res = await window.storage.get(WEEKLY_KEY, true);
      if (res && res.value) {
        const w = JSON.parse(res.value);
        if (w.schedule) latest = w.schedule;
      }
    } catch (e) {
      // storage read failed - fall back to whatever's already in memory
    }
    if (!latest) return;
    const text = formatScheduleForGroupMe(latest);
    setCopyFallbackText(text);

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus(''), 2500);
      return;
    } catch (e) {
      // modern Clipboard API blocked - try the older method before giving up
    }

    try {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.focus();
      temp.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(temp);
      if (ok) {
        setCopyStatus('copied');
        setTimeout(() => setCopyStatus(''), 2500);
        return;
      }
    } catch (e) {
      // this method failed too - fall through to manual selection
    }

    setCopyStatus('fallback');
  }

  async function handleFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setImportStatus('Reading file and saving…');
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = findDirectorySheet(wb);
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
      if (!rows.length) { setImportStatus('That file looks empty.'); return; }
      const incoming = rowsToDirectory(rows, Number(importYear) || THIS_YEAR);
      if (!incoming.length) {
        setImportStatus(`Couldn't find player rows on the "${sheetName}" tab. Check it has a Full Name column.`);
        return;
      }

      const incomingNames = new Set(incoming.map((inc) => inc.name.trim().toLowerCase()));
      let added = 0;
      let updated = 0;
      const merged = [...directory];
      incoming.forEach((inc) => {
        const key = inc.name.trim().toLowerCase();
        const existingIdx = merged.findIndex((p) => p.name.trim().toLowerCase() === key);
        if (existingIdx >= 0) {
          merged[existingIdx] = { ...inc, id: merged[existingIdx].id };
          updated += 1;
        } else {
          merged.push(inc);
          added += 1;
        }
      });
      const missing = directory.filter((p) => !incomingNames.has(p.name.trim().toLowerCase()));

      if (missing.length === 0) {
        const ok = await persistDirectory(merged);
        setImportStatus(ok
          ? `Imported: ${added} added, ${updated} matched to existing names and updated.`
          : "That didn't save — check your connection and try importing again.");
      } else {
        setPendingImport({ merged, missing, added, updated });
        setImportStatus('');
      }
    } catch (err) {
      console.error(err);
      setImportStatus('Could not read that file. Make sure it is a .xlsx or .csv export.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function resolveImportRemove() {
    if (!pendingImport) return;
    const missingIds = new Set(pendingImport.missing.map((p) => p.id));
    const final = pendingImport.merged.filter((p) => !missingIds.has(p.id));
    const ok = await persistDirectory(final);
    setImportStatus(ok
      ? `Imported: ${pendingImport.added} added, ${pendingImport.updated} updated, ${pendingImport.missing.length} removed to match the file.`
      : "That didn't save — check your connection and try again.");
    setPendingImport(null);
  }

  async function resolveImportKeep() {
    if (!pendingImport) return;
    const ok = await persistDirectory(pendingImport.merged);
    setImportStatus(ok
      ? `Imported: ${pendingImport.added} added, ${pendingImport.updated} updated. Kept ${pendingImport.missing.length} not in the file.`
      : "That didn't save — check your connection and try again.");
    setPendingImport(null);
  }

  function handleExport() {
    const rows = directoryToRows(directory, THIS_YEAR);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Directory');
    XLSX.writeFile(wb, `court-call-directory-${THIS_YEAR}.xlsx`);
  }

  const visibleDirectory = directory
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));

  const activeDirectory = directory.filter((p) => p.active);
  const inactiveDirectory = directory.filter((p) => !p.active);
  const todayFilter = (list) => list
    .filter((p) => p.name.toLowerCase().includes(todaySearch.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const playingTodayAll = activeDirectory.filter((p) => playingIds.includes(p.id));
  const playingTodayList = todayFilter(playingTodayAll);
  const notPlayingTodayList = todayFilter(activeDirectory.filter((p) => !playingIds.includes(p.id)));
  const inactiveTodayFiltered = todayFilter(inactiveDirectory);
  const searchSuggestions = todaySearch.trim()
    ? activeDirectory
        .filter((p) => p.name.toLowerCase().includes(todaySearch.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 5)
    : [];

  const playingCount = playingIds.length;
  const preferredCourtNumbers = directory
    .filter((p) => playingIds.includes(p.id) && p.preferredCourt)
    .map((p) => p.preferredCourt);
  const sessionStartMinutes = sessionTime ? (() => { const [h, m] = sessionTime.split(':').map(Number); return h * 60 + m; })() : null;
  const sessionEndMinutes = sessionStartMinutes !== null && sessionDuration ? sessionStartMinutes + Number(sessionDuration) : null;
  const blockedCourtNumbers = sessionStartMinutes !== null && sessionEndMinutes !== null
    ? computeBookedCourts(calendarEvents, sessionDate, sessionStartMinutes, sessionEndMinutes)
    : new Set();
  const assignedCourts = computeCourtAssignments(courts, blockedCourtNumbers, preferredCourtNumbers);
  const neededPerRound = courts.reduce((s, c) => s + (c.format === 'Singles' ? 2 : 4), 0);
  const canFillAtLeastOneCourt = courts.some((c) => playingCount >= (c.format === 'Singles' ? 2 : 4));
  const canGenerate = playingCount >= 2 && courts.length > 0 && canFillAtLeastOneCourt;

  const records = {};
  directory.forEach((p) => { records[p.id] = { id: p.id, wins: 0, losses: 0, name: p.name }; });
  history.forEach((h) => {
    if (!h.winner) return;
    const winners = h.winner === 'A' ? h.teamA : h.teamB;
    const losers = h.winner === 'A' ? h.teamB : h.teamA;
    winners.forEach((id) => { if (records[id]) records[id].wins += 1; });
    losers.forEach((id) => { if (records[id]) records[id].losses += 1; });
  });
  const recordList = Object.values(records)
    .filter((r) => r.wins + r.losses > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const loggedMatches = [...history].sort((a, b) => (a.date < b.date ? 1 : -1));
  const winStreaks = {};
  directory.forEach((p) => { winStreaks[p.id] = computeWinStreak(p.id, history); });

  return (
    <div className="tp-root w-full" style={{ minHeight: '100%' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .tp-root {
          --bg: #F6F7F4; --surface: #FFFFFF; --ink: #1C211D; --muted: #6B7268;
          --court: #1E5631; --court-tint: #E7F0E9; --clay: #A8532E; --clay-tint: #F3E4DC;
          --warn: #9C6B0B; --warn-tint: #F5EBD6; --neutral-fill: #C17F5D;
          --line: #E2E5DF;
          font-family: 'IBM Plex Sans', sans-serif; background: var(--bg); color: var(--ink);
        }
        .tp-display { font-family: 'Big Shoulders Display', sans-serif; letter-spacing: 0.01em; }
        .tp-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
        .tp-tab { font-weight: 600; border-radius: 999px; transition: all .15s ease; white-space: nowrap; }
        .tp-btn-primary {
          background: var(--court); color: #fff; font-weight: 600; border-radius: 10px;
          transition: opacity .15s ease, transform .1s ease;
        }
        .tp-btn-primary:hover { opacity: .92; }
        .tp-btn-primary:active { transform: scale(0.98); }
        .tp-btn-primary:disabled { opacity: .4; cursor: not-allowed; }
        .tp-btn-secondary {
          background: var(--surface); color: var(--court); font-weight: 600; border-radius: 10px;
          border: 1px solid var(--line);
        }
        .tp-pill-on { background: var(--court-tint); color: var(--court); font-weight: 600; }
        .tp-pill-off { background: #F1F1EE; color: var(--muted); font-weight: 600; }
        .tp-chip-M { background: var(--court-tint); color: var(--court); }
        .tp-chip-F { background: var(--clay-tint); color: var(--clay); }
        .tp-vs { font-family: 'Big Shoulders Display', sans-serif; color: var(--muted); font-weight: 700; }
        .tp-focus:focus-visible { outline: 2px solid var(--court); outline-offset: 2px; }
        .tp-input { border: 1px solid var(--line); border-radius: 10px; }
        .tp-winbtn { border: 1px solid var(--line); border-radius: 8px; font-weight: 600; }
        .tp-winbtn[data-won="true"] { background: var(--court); color: #fff; border-color: var(--court); }
        .tp-confetti-piece {
          position: absolute;
          width: 7px; height: 7px;
          border-radius: 1px;
          animation: tp-confetti-burst 1.1s ease-out forwards;
          animation-delay: var(--delay);
          opacity: 0;
        }
        @keyframes tp-confetti-burst {
          0% { transform: translate(-50%, -50%) rotate(0deg); opacity: 1; }
          100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) rotate(var(--rot)); opacity: 0; }
        }
        .tp-confetti-pop {
          position: absolute;
          font-size: 1.8rem;
          animation: tp-confetti-pop-anim 1s ease-out forwards;
        }
        @keyframes tp-confetti-pop-anim {
          0% { transform: scale(0.3); opacity: 0; }
          30% { transform: scale(1.15); opacity: 1; }
          70% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `}</style>

      {!loaded ? (
        <div className="flex items-center justify-center" style={{ minHeight: '260px' }}>
          <Loader2 className="animate-spin" size={22} style={{ color: 'var(--court)' }} />
        </div>
      ) : (
        <div className="max-w-xl mx-auto">
          {saveError && (
            <div className="px-4 sm:px-5 py-2.5 flex items-center gap-2 text-sm" style={{ background: 'var(--warn-tint)', color: 'var(--warn)' }}>
              <span className="flex-1">⚠ {saveError}</span>
              <button type="button" onClick={() => setSaveError('')} className="tp-focus font-semibold text-xs underline">
                Dismiss
              </button>
            </div>
          )}
          <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b" style={{ borderColor: 'var(--line)' }}>
            <div>
              <div className="flex items-center gap-2">
                <div className="tp-display text-2xl font-extrabold leading-none" onClick={handleLogoTap}>COURT CALL</div>
                <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--court-tint)', color: 'var(--court)', letterSpacing: '0.03em' }}>BETA</span>
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Weekly pairing sheet</div>
            </div>
            <div className="text-right">
              <div className="tp-display text-2xl font-bold leading-none">{playingCount}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>playing this week</div>
              <button
                type="button"
                onClick={() => setTab('directory')}
                className="tp-focus flex items-center gap-1 text-xs mt-1 ml-auto"
                style={{ color: 'var(--muted)' }}
              >
                <Settings size={12} />
                Directory
              </button>
            </div>
          </div>

          <div className="flex gap-1.5 px-4 sm:px-5 pt-4 overflow-x-auto">
            {[
              { key: 'today', label: 'Today' },
              { key: 'courts', label: 'Courts' },
              { key: 'results', label: 'Results' },
              { key: 'history', label: 'History' },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className="tp-tab tp-focus px-3.5 py-2 text-sm"
                style={{
                  background: tab === t.key ? 'var(--court)' : 'transparent',
                  color: tab === t.key ? '#fff' : 'var(--muted)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'today' && (
            <div className="px-4 sm:px-5 py-4 space-y-5">
              <div className="tp-card p-3">
                <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--muted)' }}>Playing on</label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={sessionDate}
                    onChange={(e) => persistWeekly({ sessionDate: e.target.value })}
                    className="tp-focus tp-input px-3 py-2 text-sm flex-1"
                  />
                  <select
                    value={sessionTime}
                    onChange={(e) => persistWeekly({ sessionTime: e.target.value })}
                    className="tp-focus tp-input px-3 py-2 text-sm flex-1 bg-white"
                  >
                    <option value="">Time?</option>
                    {TIME_OPTIONS.map((t) => <option key={t} value={t}>{formatSessionTime(t)}</option>)}
                  </select>
                  <select
                    value={sessionDuration}
                    onChange={(e) => persistWeekly({ sessionDuration: e.target.value })}
                    disabled={!sessionTime}
                    className="tp-focus tp-input px-3 py-2 text-sm flex-1 bg-white"
                    style={{ opacity: sessionTime ? 1 : 0.5 }}
                  >
                    <option value="">For how long?</option>
                    {DURATION_OPTIONS.map((d) => <option key={d} value={d}>{formatDuration(d)}</option>)}
                  </select>
                </div>
                {weatherStatus === 'loading' && (
                  <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Checking weather…</div>
                )}
                {weatherStatus === 'ready' && weather && (() => {
                  const nws = nwsConditionText ? nwsDisplay(nwsConditionText) : null;
                  const wd = nws || weatherDisplay(weather.code);
                  const label = nwsConditionText || weatherDisplay(weather.code).label;
                  return (
                    <div className="flex items-center gap-2 mt-2 px-2 py-1.5 rounded-lg" style={{ background: `${wd.color}14` }}>
                      <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{wd.icon}</span>
                      <div className="text-xs">
                        <span className="font-semibold" style={{ color: wd.color }}>
                          {label ? `${label}, ` : ''}{Math.round(weather.hi)}°F / {Math.round(weather.lo)}°F
                        </span>
                        {weather.uv != null && (
                          <span style={{ color: 'var(--muted)' }}> · Sun exposure: {uvCategory(weather.uv)} (UV {Math.round(weather.uv)})</span>
                        )}
                        <span style={{ color: 'var(--muted)' }}> · Half Moon Bay</span>
                      </div>
                    </div>
                  );
                })()}
                {weatherStatus === 'unavailable' && (
                  <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>Forecast isn't available this far out yet — check back closer to the date.</div>
                )}
              </div>
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                Tap a name to mark them in for {formatSessionDateTime(sessionDate, sessionTime, sessionDuration)}. This list is what resets when you start a new week — the full directory underneath stays put.
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={handleRefresh} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--muted)' }}>
                  <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingUncheck(true)}
                  disabled={playingCount === 0}
                  className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5"
                  style={{ color: playingCount === 0 ? 'var(--muted)' : 'var(--court)', opacity: playingCount === 0 ? 0.5 : 1 }}
                >
                  <RotateCcw size={14} />
                  Uncheck All
                </button>
                <button type="button" onClick={() => setConfirmingReset(true)} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--clay)' }}>
                  <X size={14} />
                  Start New Week
                </button>
              </div>

              {confirmingUncheck && (
                <div className="tp-card p-3 flex items-center justify-between text-sm gap-2">
                  <span>Uncheck all {playingCount} people currently marked playing? Courts, sets, and any pairings you&apos;ve already generated stay as they are.</span>
                  <div className="flex gap-2 shrink-0">
                    <button type="button" onClick={handleUncheckAll} className="px-3 py-1 rounded-md font-semibold" style={{ background: 'var(--court)', color: '#fff' }}>Uncheck</button>
                    <button type="button" onClick={() => setConfirmingUncheck(false)} className="px-3 py-1 rounded-md" style={{ color: 'var(--muted)' }}>Cancel</button>
                  </div>
                </div>
              )}

              {confirmingReset && (
                <div className="tp-card p-3 flex items-center justify-between text-sm gap-2">
                  <span>Clear who&apos;s playing and this week&apos;s pairings? Player profiles and history stay saved.</span>
                  <div className="flex gap-2 shrink-0">
                    <button type="button" onClick={handleStartNewWeek} className="px-3 py-1 rounded-md font-semibold" style={{ background: 'var(--clay)', color: '#fff' }}>Clear</button>
                    <button type="button" onClick={() => setConfirmingReset(false)} className="px-3 py-1 rounded-md" style={{ color: 'var(--muted)' }}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="relative">
                <input
                  value={todaySearch}
                  onChange={(e) => { setTodaySearch(e.target.value); setSearchSuggestOpen(true); }}
                  onFocus={() => setSearchSuggestOpen(true)}
                  onBlur={() => setTimeout(() => setSearchSuggestOpen(false), 150)}
                  placeholder="Search…"
                  className="tp-focus tp-input w-full px-3 py-2 text-sm"
                />
                {searchSuggestOpen && searchSuggestions.length > 0 && (
                  <div className="tp-card absolute left-0 right-0 mt-1 py-1 z-10 shadow-lg">
                    {searchSuggestions.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setTodaySearch(p.name); setSearchSuggestOpen(false); }}
                        className="tp-focus w-full text-left px-3 py-2 text-sm flex items-center justify-between"
                        style={{ background: 'transparent' }}
                      >
                        <span>{p.name}</span>
                        {playingIds.includes(p.id) && <span className="text-xs" style={{ color: 'var(--court)' }}>Playing</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="tp-card p-4 space-y-3">
                <div className="text-sm font-semibold">Mark several people at once</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  Type names one per line, or paste a chat thread straight in — timestamps, banter, and reactions get filtered out automatically.
                </div>

                <textarea
                  value={namesText}
                  onChange={(e) => setNamesText(e.target.value)}
                  placeholder="Just names, one per line — or paste a chat thread here"
                  rows={5}
                  className="tp-focus tp-input w-full px-3 py-2 text-sm"
                />
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  Resubmitting this box syncs to exactly what's typed — take a name out and press the button again, and they're removed from today too. This only ever affects people this box itself added, never anyone marked playing another way.
                </div>
                <button
                  type="button"
                  onClick={handleMatchNames}
                  disabled={!namesText.trim()}
                  className="tp-btn-primary tp-focus w-full py-2 text-sm"
                >
                  Match &amp; Mark Playing
                </button>

                {matchResults && (
                  <div className="space-y-2 pt-1">
                    {matchResults.some((r) => r && r.status === 'matched') && (
                      <div className="text-xs" style={{ color: 'var(--court)' }}>
                        Marked playing: {matchResults.filter((r) => r && r.status === 'matched').map((r) => r.player.name).join(', ')}
                      </div>
                    )}
                    {matchResults.map((r, i) => (r && r.status === 'ambiguous') ? (
                      <div key={i} className="tp-card p-2 text-xs">
                        <div className="mb-1.5">&ldquo;{r.input}&rdquo; — which one?</div>
                        <div className="flex flex-wrap gap-1.5">
                          {r.candidates.map((c) => (
                            <button key={c.id} type="button" onClick={() => resolveAmbiguous(i, c)} className="tp-input px-2 py-1" style={{ color: 'var(--court)' }}>
                              {c.name}
                            </button>
                          ))}
                          <button type="button" onClick={() => markAmbiguousAsNew(i)} className="tp-input px-2 py-1" style={{ color: 'var(--clay)' }}>
                            Someone new
                          </button>
                        </div>
                      </div>
                    ) : null)}

                    {matchResults.some((r) => r && r.status === 'unmatched') && (
                      <div className="tp-card p-3 space-y-2">
                        <div className="text-xs font-semibold">
                          New to your directory — set Sex and CTA for each, then add them.
                        </div>
                        {matchResults.map((r, i) => (r && r.status === 'unmatched') ? (
                          <div key={i} className="flex items-center gap-1.5">
                            <span className="flex-1 text-sm truncate min-w-[70px]">{r.input}</span>
                            <div className="tp-input flex overflow-hidden shrink-0">
                              {['M', 'F'].map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  onClick={() => updatePendingDraft(i, 'sex', s)}
                                  className="px-2.5 py-1.5 text-xs font-semibold"
                                  style={{
                                    background: r.sex === s ? (s === 'M' ? 'var(--court-tint)' : 'var(--clay-tint)') : 'transparent',
                                    color: r.sex === s ? (s === 'M' ? 'var(--court)' : 'var(--clay)') : 'var(--muted)',
                                  }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                            <input
                              type="number"
                              step="0.1"
                              min="1.0"
                              max="7.0"
                              value={r.cta}
                              onChange={(e) => updatePendingDraft(i, 'cta', e.target.value)}
                              className="tp-focus tp-input px-1.5 py-1.5 text-xs bg-white shrink-0"
                              style={{ width: '4.5rem' }}
                            />
                            <button type="button" onClick={() => addOnePending(i)} className="tp-input px-2 py-1.5 text-xs shrink-0" style={{ color: 'var(--court)' }}>
                              Add
                            </button>
                            <button type="button" onClick={() => dismissPending(i)} className="tp-input px-2 py-1.5 text-xs shrink-0" style={{ color: 'var(--muted)' }} aria-label={`Dismiss ${r.input}`}>
                              <X size={13} />
                            </button>
                          </div>
                        ) : null)}
                        <button type="button" onClick={addAllPending} className="tp-btn-primary tp-focus w-full py-2 text-xs mt-1">
                          Add All &amp; Mark Playing
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!showAddForm ? (
                <button type="button" onClick={() => setShowAddForm(true)} className="tp-btn-secondary tp-focus w-full py-2 text-sm flex items-center justify-center gap-1.5">
                  <Plus size={15} />
                  Add someone new
                </button>
              ) : (
                <div className="tp-card p-4 space-y-3">
                  <div className="text-sm font-semibold">Add a player</div>
                  <div className="flex gap-2">
                    <input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="Name"
                      className="tp-focus tp-input flex-1 min-w-[100px] px-3 py-2 text-sm"
                    />
                    <div className="tp-input flex overflow-hidden">
                      {['M', 'F'].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setForm({ ...form, sex: s })}
                          className="px-3 py-2 text-sm font-semibold"
                          style={{
                            background: form.sex === s ? (s === 'M' ? 'var(--court-tint)' : 'var(--clay-tint)') : 'transparent',
                            color: form.sex === s ? (s === 'M' ? 'var(--court)' : 'var(--clay)') : 'var(--muted)',
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>CTA rating</label>
                    <input
                      type="number"
                      step="0.1"
                      min="1.0"
                      max="7.0"
                      value={form.cta}
                      onChange={(e) => setForm({ ...form, cta: e.target.value })}
                      className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white"
                    />
                  </div>

                  {!showMoreFields ? (
                    <button type="button" onClick={() => setShowMoreFields(true)} className="text-xs font-medium" style={{ color: 'var(--court)' }}>
                      + More details (USTA, handedness, ratings, notes)
                    </button>
                  ) : (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>USTA rating</label>
                        <select value={form.usta} onChange={(e) => setForm({ ...form, usta: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                          <option value="">No USTA rating</option>
                          {SKILL_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Birth year</label>
                        <input
                          value={form.birthYear}
                          onChange={(e) => setForm({ ...form, birthYear: e.target.value })}
                          placeholder="e.g. 1980"
                          inputMode="numeric"
                          className="tp-focus tp-input w-full px-3 py-2 text-sm"
                        />
                        <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                          {form.birthYear && !Number.isNaN(Number(form.birthYear))
                            ? `Age updates on its own — currently ${THIS_YEAR - Number(form.birthYear)}`
                            : 'Stored as birth year so age never goes stale'}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Handedness</label>
                          <div className="tp-input flex overflow-hidden">
                            {['L', 'R'].map((h) => (
                              <button key={h} type="button" onClick={() => setForm({ ...form, handedness: h })}
                                className="flex-1 px-3 py-2 text-sm font-semibold"
                                style={{ background: form.handedness === h ? 'var(--court-tint)' : 'transparent', color: form.handedness === h ? 'var(--court)' : 'var(--muted)' }}>
                                {h}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex-1">
                          <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Competitive (1-5)</label>
                          <select value={form.competitive} onChange={(e) => setForm({ ...form, competitive: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                          <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>How much they play to win — affects pairing</div>
                        </div>
                        <div className="flex-1">
                          <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Serving (1-5)</label>
                          <select value={form.serving} onChange={(e) => setForm({ ...form, serving: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                            <option value="">—</option>
                            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                          <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Serve strength — reference only</div>
                        </div>
                      </div>
                      <input value={form.injuries} onChange={(e) => setForm({ ...form, injuries: e.target.value })} placeholder="Injuries (optional)" className="tp-focus tp-input w-full px-3 py-2 text-sm" />
                      <input value={form.comments} onChange={(e) => setForm({ ...form, comments: e.target.value })} placeholder="Comments/suggestions (optional)" className="tp-focus tp-input w-full px-3 py-2 text-sm" />
                      <div>
                        <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Preferred court</label>
                        <select value={form.preferredCourt} onChange={(e) => setForm({ ...form, preferredCourt: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                          <option value="">No preference</option>
                          {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>Court {v}</option>)}
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button type="button" onClick={handleAddPlayer} className="tp-btn-primary tp-focus flex-1 py-2 text-sm flex items-center justify-center gap-1">
                      <Plus size={15} />
                      Add &amp; mark playing
                    </button>
                    <button type="button" onClick={() => { setShowAddForm(false); setShowMoreFields(false); setForm(BLANK_FORM); }} className="tp-focus px-4 py-2 text-sm" style={{ color: 'var(--muted)' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {directoryLoadError && (
                <div className="text-sm text-center py-8 px-4 rounded-lg" style={{ color: 'var(--clay)', background: 'var(--clay-tint)' }}>
                  <strong>Couldn't load the player directory.</strong> This does not mean your players are gone — it means this device couldn't confirm either way. Check your connection (or an ad/privacy-blocker extension) and refresh before assuming anything's missing.
                </div>
              )}

              {!directoryLoadError && directory.length === 0 && (
                <div className="text-sm text-center py-8" style={{ color: 'var(--muted)' }}>
                  No players in the directory yet. Add someone above, or head to the Directory tab to import a spreadsheet.
                </div>
              )}

              {directory.length > 0 && (
                <>
                  <div>
                    <div className="text-sm font-semibold mb-2">Playing today ({playingTodayAll.length})</div>
                    {todaySearch && playingTodayList.length < playingTodayAll.length && (
                      <div className="text-xs mb-2 px-3 py-1.5 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                        Search is narrowing this list — {playingTodayAll.length - playingTodayList.length} other{playingTodayAll.length - playingTodayList.length === 1 ? '' : 's'} still marked playing, just hidden. Clear search to see everyone.
                      </div>
                    )}
                    {playingTodayList.length === 0 ? (
                      <div className="text-sm py-2" style={{ color: 'var(--muted)' }}>Nobody marked in yet — tap names below.</div>
                    ) : (
                      <div className="space-y-2">
                        {playingTodayList.map((p) => (
                          <PlayerToggleRow key={p.id} p={p} playing onToggle={() => togglePlaying(p.id)} />
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-sm font-semibold mb-2">Not marked in</div>
                    {notPlayingTodayList.length === 0 ? (
                      <div className="text-sm py-2" style={{ color: 'var(--muted)' }}>Everyone active is already marked in.</div>
                    ) : (
                      <div className="space-y-2">
                        {notPlayingTodayList.map((p) => (
                          <PlayerToggleRow key={p.id} p={p} playing={false} onToggle={() => togglePlaying(p.id)} />
                        ))}
                      </div>
                    )}
                  </div>

                  {inactiveDirectory.length > 0 && (
                    <div>
                      <button type="button" onClick={() => setShowInactiveToday(!showInactiveToday)} className="text-xs font-medium" style={{ color: 'var(--court)' }}>
                        {showInactiveToday ? 'Hide' : 'Show'} {inactiveDirectory.length} inactive member{inactiveDirectory.length === 1 ? '' : 's'}
                      </button>
                      {showInactiveToday && (
                        <div className="space-y-2 mt-2">
                          {inactiveTodayFiltered.map((p) => (
                            <PlayerToggleRow key={p.id} p={p} playing={playingIds.includes(p.id)} onToggle={() => togglePlaying(p.id)} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'directory' && !directoryUnlocked && !showSuperuserGate && !superuserUnlocked && (
            <div className="px-4 sm:px-5 py-10 flex flex-col items-center text-center gap-3">
              <Lock size={22} style={{ color: 'var(--muted)' }} />
              <div className="text-sm font-semibold">Enter PIN</div>
              {registryUnavailable && (
                <div className="text-xs max-w-xs px-3 py-2 rounded-lg" style={{ color: 'var(--clay)', background: 'var(--clay-tint)' }}>
                  Can't confirm access right now — this device couldn't reach the server. No PIN will work until this is resolved. Check your connection (or an ad/privacy-blocker extension) and refresh.
                </div>
              )}
              <input
                value={pinInput}
                onChange={(e) => { setPinInput(e.target.value); setPinError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') tryUnlockDirectory(); }}
                placeholder="PIN"
                type="password"
                inputMode="numeric"
                className="tp-focus tp-input px-3 py-2 text-sm text-center w-32"
              />
              {pinError && <div className="text-xs" style={{ color: 'var(--clay)' }}>{pinError}</div>}
              <div className="flex gap-2">
                <button type="button" onClick={tryUnlockDirectory} className="tp-btn-primary tp-focus px-5 py-2 text-sm">Unlock</button>
                <button type="button" onClick={() => setTab('today')} className="tp-focus px-4 py-2 text-sm" style={{ color: 'var(--muted)' }}>Back to Today</button>
              </div>
            </div>
          )}

          {showSuperuserGate && !superuserUnlocked && (
            <div className="px-4 sm:px-5 py-10 flex flex-col items-center text-center gap-3">
              <Lock size={22} style={{ color: 'var(--clay)' }} />
              <div className="text-sm font-semibold">Superuser</div>
              <div className="text-xs max-w-xs" style={{ color: 'var(--muted)' }}>
                Manages who has Admin access and reviews the activity log. A different PIN from the regular Admin one.
              </div>
              <input
                value={superuserPinInput}
                onChange={(e) => { setSuperuserPinInput(e.target.value); setSuperuserPinError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') tryUnlockSuperuser(); }}
                placeholder="Superuser PIN"
                type="password"
                inputMode="numeric"
                className="tp-focus tp-input px-3 py-2 text-sm text-center w-40"
              />
              {superuserPinError && <div className="text-xs" style={{ color: 'var(--clay)' }}>{superuserPinError}</div>}
              <div className="flex gap-2">
                <button type="button" onClick={tryUnlockSuperuser} className="tp-focus px-5 py-2 text-sm font-semibold rounded-lg" style={{ background: 'var(--clay)', color: '#fff' }}>Unlock</button>
                <button type="button" onClick={() => { setShowSuperuserGate(false); setSuperuserPinInput(''); setSuperuserPinError(''); }} className="tp-focus px-4 py-2 text-sm" style={{ color: 'var(--muted)' }}>Cancel</button>
              </div>
            </div>
          )}

          {superuserUnlocked && (
            <div className="px-4 sm:px-5 py-4 space-y-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold" style={{ color: 'var(--clay)' }}>Superuser console</div>
                <button type="button" onClick={() => { setSuperuserUnlocked(false); setShowSuperuserGate(false); }} className="tp-focus text-xs" style={{ color: 'var(--muted)' }}>Exit</button>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Admins</div>
                <div className="space-y-1.5">
                  {adminRegistry.admins.length === 0 && (
                    <div className="text-xs py-2" style={{ color: 'var(--muted)' }}>No admins granted yet.</div>
                  )}
                  {adminRegistry.admins.map((a) => (
                    <div key={a.id} className="tp-card flex items-center justify-between px-4 py-2.5 text-sm">
                      <span>{a.name}</span>
                      <button type="button" onClick={() => revokeAdmin(a.id)} className="tp-focus text-xs" style={{ color: 'var(--clay)' }}>Revoke</button>
                    </div>
                  ))}
                </div>
                <div className="tp-card p-3 mt-2 space-y-2">
                  <div className="text-xs font-semibold">Grant Admin access</div>
                  <select value={newAdminPlayerId} onChange={(e) => setNewAdminPlayerId(e.target.value)} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                    <option value="">Choose a player…</option>
                    {directory.filter((p) => !adminRegistry.admins.some((a) => a.playerId === p.id)).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <input
                    value={newAdminPin}
                    onChange={(e) => { setNewAdminPin(e.target.value); setNewAdminPinError(''); }}
                    placeholder="Assign a PIN"
                    inputMode="numeric"
                    className="tp-focus tp-input w-full px-3 py-2 text-sm"
                  />
                  {newAdminPinError && <div className="text-xs" style={{ color: 'var(--clay)' }}>{newAdminPinError}</div>}
                  <button type="button" onClick={addAdmin} disabled={!newAdminPlayerId || !newAdminPin.trim()} className="tp-btn-primary tp-focus w-full py-2 text-sm disabled:opacity-50">Grant</button>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Superuser PIN</div>
                <div className="flex gap-2">
                  <input
                    value={newPinInput}
                    onChange={(e) => setNewPinInput(e.target.value)}
                    placeholder="New superuser PIN"
                    inputMode="numeric"
                    className="tp-focus tp-input flex-1 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={async () => { if (newPinInput.trim()) { const rec = await makePinRecord(newPinInput.trim()); persistAdminRegistry({ ...adminRegistry, superuserPin: rec }); setNewPinInput(''); } }}
                    className="tp-btn-secondary tp-focus px-4 py-2 text-sm"
                  >
                    Update
                  </button>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Activity log</div>
                {auditLog.length === 0 ? (
                  <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>Nothing logged yet.</div>
                ) : (
                  <div className="space-y-1.5">
                    {auditLog.map((entry) => (
                      <div key={entry.id} className="tp-card px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                        <span className="font-semibold" style={{ color: 'var(--ink)' }}>{entry.actor}</span> · {new Date(entry.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        <div className="mt-0.5">{entry.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'directory' && directoryUnlocked && !showSuperuserGate && !superuserUnlocked && (
            <div className="px-4 sm:px-5 py-4 space-y-4">
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                The full member list — names, ratings, and notes. It does not reset week to week; use the Today tab to mark who's playing.
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={handleRefresh} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--muted)' }}>
                  <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                  Refresh
                </button>
                <button type="button" onClick={() => fileInputRef.current && fileInputRef.current.click()} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--court)' }}>
                  <Upload size={14} />
                  Import
                </button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFileSelected} style={{ display: 'none' }} />
                <button type="button" onClick={handleExport} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--court)' }}>
                  <Download size={14} />
                  Export
                </button>
                <button type="button" onClick={() => setDirectoryUnlocked(false)} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--muted)' }}>
                  Lock &amp; Exit
                </button>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs whitespace-nowrap" style={{ color: 'var(--muted)' }}>Ages in file are as of year</label>
                <input
                  value={importYear}
                  onChange={(e) => setImportYear(e.target.value)}
                  className="tp-focus tp-input w-20 px-2 py-1 text-sm"
                />
              </div>
              {importStatus && (
                <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                  {importStatus === 'Reading file and saving…' && <Loader2 size={12} className="animate-spin" />}
                  {importStatus}
                </div>
              )}

              {pendingImport && (
                <div className="tp-card p-3 space-y-2">
                  <div className="text-xs font-semibold">
                    {pendingImport.missing.length} {pendingImport.missing.length === 1 ? 'person is' : 'people are'} in your directory but not in this file:
                  </div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    {pendingImport.missing.map((p) => p.name).join(', ')}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    Remove them to match the file exactly, or keep them and just add/update everyone else.
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={resolveImportRemove} className="flex-1 px-3 py-1.5 rounded-md font-semibold text-xs" style={{ background: 'var(--clay)', color: '#fff' }}>
                      Remove them
                    </button>
                    <button type="button" onClick={resolveImportKeep} className="flex-1 px-3 py-1.5 rounded-md font-semibold text-xs" style={{ background: 'var(--court)', color: '#fff' }}>
                      Keep them
                    </button>
                  </div>
                </div>
              )}

              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the directory…"
                className="tp-focus tp-input w-full px-3 py-2 text-sm"
              />

              <div className="space-y-2">
                {visibleDirectory.length === 0 && (
                  <div className="text-sm text-center py-8" style={{ color: 'var(--muted)' }}>
                    {directory.length === 0 ? 'No players in the directory yet. Import a spreadsheet, or add someone from the Today tab.' : 'No matches for that search.'}
                  </div>
                )}
                {visibleDirectory.map((p) => (
                  <div key={p.id} className="tp-card px-4 py-3" style={{ opacity: p.active ? 1 : 0.55 }}>
                    {editingId === p.id ? (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="tp-focus tp-input flex-1 px-3 py-2 text-sm" />
                          <div className="tp-input flex overflow-hidden">
                            {['M', 'F'].map((s) => (
                              <button key={s} type="button" onClick={() => setEditForm({ ...editForm, sex: s })} className="px-3 py-2 text-sm font-semibold"
                                style={{ background: editForm.sex === s ? 'var(--court-tint)' : 'transparent', color: editForm.sex === s ? 'var(--court)' : 'var(--muted)' }}>
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            step="0.1"
                            min="1.0"
                            max="7.0"
                            value={editForm.cta}
                            onChange={(e) => setEditForm({ ...editForm, cta: e.target.value })}
                            placeholder="CTA"
                            className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white"
                          />
                          <select value={editForm.usta} onChange={(e) => setEditForm({ ...editForm, usta: e.target.value })} className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white">
                            <option value="">No USTA</option>
                            {SKILL_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(1)} USTA</option>)}
                          </select>
                        </div>
                        <div className="flex gap-2 items-center">
                          <input
                            value={editForm.birthYear}
                            onChange={(e) => setEditForm({ ...editForm, birthYear: e.target.value })}
                            placeholder="Birth year"
                            inputMode="numeric"
                            className="tp-focus tp-input flex-1 px-3 py-2 text-sm"
                          />
                          <span className="text-xs flex-1" style={{ color: 'var(--muted)' }}>
                            {editForm.birthYear && !Number.isNaN(Number(editForm.birthYear))
                              ? `Age ${THIS_YEAR - Number(editForm.birthYear)}`
                              : 'No birth year set'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditForm({ ...editForm, active: !editForm.active })}
                            className="tp-focus text-xs px-3 py-2 rounded-md font-semibold whitespace-nowrap"
                            style={{ background: editForm.active ? 'var(--court-tint)' : '#F1F1EE', color: editForm.active ? 'var(--court)' : 'var(--muted)' }}
                          >
                            {editForm.active ? 'Active' : 'Inactive'}
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <div className="tp-input flex overflow-hidden flex-1">
                            {['L', 'R'].map((h) => (
                              <button key={h} type="button" onClick={() => setEditForm({ ...editForm, handedness: h })} className="flex-1 px-3 py-2 text-sm font-semibold"
                                style={{ background: editForm.handedness === h ? 'var(--court-tint)' : 'transparent', color: editForm.handedness === h ? 'var(--court)' : 'var(--muted)' }}>
                                {h}
                              </button>
                            ))}
                          </div>
                          <select value={editForm.competitive} onChange={(e) => setEditForm({ ...editForm, competitive: e.target.value })} className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white">
                            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v} competitive</option>)}
                          </select>
                          <select value={editForm.serving} onChange={(e) => setEditForm({ ...editForm, serving: e.target.value })} className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white">
                            <option value="">— serving</option>
                            {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v} serving</option>)}
                          </select>
                        </div>
                        <div className="text-xs -mt-2" style={{ color: 'var(--muted)' }}>
                          Competitive: how much they play to win, affects pairing. Serving: serve strength, reference only.
                        </div>
                        <input value={editForm.injuries} onChange={(e) => setEditForm({ ...editForm, injuries: e.target.value })} placeholder="Injuries" className="tp-focus tp-input w-full px-3 py-2 text-sm" />
                        <input value={editForm.comments} onChange={(e) => setEditForm({ ...editForm, comments: e.target.value })} placeholder="Comments/suggestions" className="tp-focus tp-input w-full px-3 py-2 text-sm" />
                        <select value={editForm.preferredCourt} onChange={(e) => setEditForm({ ...editForm, preferredCourt: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                          <option value="">No court preference</option>
                          {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>Court {v}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <button type="button" onClick={saveEdit} className="tp-btn-primary tp-focus flex-1 py-2 text-sm flex items-center justify-center gap-1"><Check size={14} />Save</button>
                          <button type="button" onClick={() => setEditingId(null)} className="tp-focus px-4 py-2 text-sm" style={{ color: 'var(--muted)' }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-bold px-2 py-1 rounded-md tp-chip-${p.sex}`}>{p.sex}</span>
                          <span className="flex-1 font-medium text-sm truncate min-w-[80px]">{p.name}</span>
                          <span className="text-xs px-2 py-1 rounded-md font-medium whitespace-nowrap" style={{ background: '#F1F1EE', color: 'var(--muted)' }}>
                            {effSkill(p).toFixed(1)} {hasUsta(p) ? 'USTA' : 'CTA'}
                          </span>
                          <button type="button" onClick={() => startEdit(p)} className="tp-focus" style={{ color: 'var(--muted)' }} aria-label={`Edit ${p.name}`}>
                            <Pencil size={14} />
                          </button>
                          <button type="button" onClick={() => removeFromDirectory(p.id)} className="tp-focus" style={{ color: 'var(--muted)' }} aria-label={`Remove ${p.name}`}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 pl-9 flex-wrap text-xs" style={{ color: 'var(--muted)' }}>
                          {p.handedness && <span>{p.handedness === 'L' ? 'Lefty' : 'Righty'}</span>}
                          <span>Competitive {p.competitive}/5</span>
                          {p.serving != null && <span>Serve {p.serving}/5</span>}
                          {p.birthYear != null && <span>Age {THIS_YEAR - p.birthYear}</span>}
                          {p.preferredCourt != null && (
                            <span style={{ color: 'var(--clay)' }}>
                              Always Court {p.preferredCourt}
                            </span>
                          )}
                          <button type="button" onClick={() => toggleActive(p.id)} className="underline">
                            {p.active ? 'Active member' : 'Inactive — tap to reactivate'}
                          </button>
                        </div>
                        {(p.injuries || p.comments) && (
                          <div className="mt-1.5 pl-9 text-xs italic" style={{ color: 'var(--clay)' }}>
                            {p.injuries && <div>{p.injuries}</div>}
                            {p.comments && <div style={{ color: 'var(--muted)' }}>{p.comments}</div>}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'courts' && (
            <div className="px-4 sm:px-5 py-4 space-y-4">
              <div className="tp-card p-4" style={{ borderColor: 'var(--court)', borderWidth: '2px' }}>
                <div className="flex items-start gap-3">
                  <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>📅</span>
                  <div>
                    <div className="text-sm font-bold" style={{ color: 'var(--court)' }}>Double-check the real CTA calendar</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--ink)' }}>
                      Court numbers below are this app's best automatic guess — always confirm against the real calendar before you play, especially for USTA matches or pro lessons.
                    </div>
                    <a
                      href="https://www.coastsidetennis.com/court-schedule"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tp-focus inline-block mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg"
                      style={{ background: 'var(--court)', color: '#fff' }}
                    >
                      Open the CTA court schedule ↗
                    </a>
                  </div>
                </div>
              </div>

              {calendarStatus === 'loading' && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                  Checking the CTA calendar for real court bookings…
                </div>
              )}
              {calendarStatus === 'ready' && !sessionTime && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                  Set a time on Today to check these courts against real CTA calendar bookings.
                </div>
              )}
              {calendarStatus === 'ready' && sessionTime && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                  {blockedCourtNumbers.size === 0
                    ? 'Checked against the CTA calendar — no conflicts for this time.'
                    : `Checked against the CTA calendar — court${blockedCourtNumbers.size === 1 ? '' : 's'} ${Array.from(blockedCourtNumbers).sort().join(', ')} booked during this time, skipped automatically.`}
                </div>
              )}
              <div>
                <div className="text-sm font-semibold mb-2">Courts this week</div>
                <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
                  Court count and format follow how many are marked playing on Today — {playingCount} playing sets up {assignedCourts.length === 0 ? 'no courts yet' : `${assignedCourts.length} court${assignedCourts.length === 1 ? '' : 's'}`} automatically. Court numbers default to 1 through 4 first, 5 and 6 only if needed — tap a number below to override it for every set this week. Need a one-off exception for just a single set instead? Use Results › Adjust.
                </div>
                <div className="space-y-2">
                  {assignedCourts.map((c, i) => {
                    const clash = assignedCourts.some((other, j) => j !== i && other.courtNumber !== null && other.courtNumber === c.courtNumber);
                    return (
                      <div key={c.id} className="tp-card flex items-center gap-3 px-4 py-3">
                        <select
                          value={c.courtNumberOverride || ''}
                          onChange={(e) => setCourtSlotOverride(c.id, e.target.value)}
                          className="tp-focus tp-input font-bold text-sm bg-white px-1.5 py-1"
                          style={{ color: clash || !c.courtNumber ? 'var(--warn)' : 'var(--court)', width: '4.5rem' }}
                          aria-label={`Court number for row ${i + 1}`}
                        >
                          <option value="">{c.courtNumber || '—'}</option>
                          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <div className="flex-1 text-sm font-medium">{c.format}</div>
                        {!c.courtNumber && (
                          <div className="text-xs w-full" style={{ color: 'var(--warn)' }}>⚠ No court number left to assign</div>
                        )}
                        {clash && c.courtNumber && (
                          <div className="text-xs w-full" style={{ color: 'var(--warn)' }}>⚠ Same court number used more than once below</div>
                        )}
                      </div>
                    );
                  })}
                  {courts.length === 0 && (
                    <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>Mark people playing on Today to set up this week's courts.</div>
                  )}
                </div>
              </div>

              <div className="tp-card p-4">
                <div className="text-sm font-semibold mb-2">Sets today</div>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => setRoundsCount(rounds - 1)} className="tp-focus w-8 h-8 rounded-full border font-bold" style={{ borderColor: 'var(--line)' }} aria-label="Fewer sets">−</button>
                  <span className="tp-display text-2xl font-bold w-8 text-center">{rounds}</span>
                  <button type="button" onClick={() => setRoundsCount(rounds + 1)} className="tp-focus w-8 h-8 rounded-full border font-bold" style={{ borderColor: 'var(--line)' }} aria-label="More sets">+</button>
                </div>
                <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                  Partners rotate after each set, balancing skill first, then avoiding repeats, then mixed-doubles gender balance, then grouping similar competitive ratings on the same court, then fair sit-out rotation. Anyone with a firm court preference plays there every set; a soft preference is honored unless it conflicts with someone else's firm one.
                </div>
              </div>

              <div className="text-xs px-1" style={{ color: 'var(--muted)' }}>
                {playingCount} playing this week · up to {neededPerRound} needed per set for this court setup
                {playingCount > 0 && playingCount < neededPerRound ? ' — with fewer than that, sit-outs rotate fairly across the sets.' : ''}
                {playingCount > neededPerRound ? ' — more than fits at once, so who sits out rotates set to set.' : ''}
              </div>

              {playingCount >= 1 && courts.length === 0 && (
                <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--warn-tint)', color: 'var(--warn)' }}>
                  ⚠ {playingCount} playing isn't enough to fill a court (Doubles/Mixed need 4, Singles needs 2, and a lone leftover of 1 or 3 can't fill anything on its own). Mark more people playing to enable pairing.
                </div>
              )}

              <button type="button" onClick={handleGenerate} disabled={!canGenerate} className="tp-btn-primary tp-focus w-full py-3 flex items-center justify-center gap-2">
                <Shuffle size={17} />
                Generate Pairings
              </button>
            </div>
          )}

          {tab === 'results' && (
            <div className="px-4 sm:px-5 py-4 space-y-6">
              {!schedule && (
                <div className="text-sm text-center py-10" style={{ color: 'var(--muted)' }}>No pairings yet. Set up your courts and sets, then generate.</div>
              )}
              {schedule && schedule.rounds.map((round, ri) => (
                <div key={ri}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="tp-display text-lg font-bold" style={{ color: 'var(--court)' }}>SET {ri + 1}</div>
                    <button
                      type="button"
                      onClick={() => { setEditingRoundIndex(editingRoundIndex === ri ? null : ri); setSelectedPlayerId(null); }}
                      className="tp-focus text-xs px-3 py-1 rounded-full font-semibold"
                      style={{
                        background: editingRoundIndex === ri ? 'var(--court)' : 'var(--court-tint)',
                        color: editingRoundIndex === ri ? '#fff' : 'var(--court)',
                      }}
                    >
                      {editingRoundIndex === ri ? 'Done' : 'Adjust'}
                    </button>
                  </div>
                  {editingRoundIndex === ri && (
                    <div className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
                      Tap two players (including in Sitting out) to swap their spots, or use the dropdown to change which court a match is on.
                    </div>
                  )}
                  <div className="space-y-3">
                    {round.matches.map((m, mi) => {
                      const skillA = avgSkill(m.teamA, schedule.playerMap);
                      const skillB = avgSkill(m.teamB, schedule.playerMap);
                      const total = skillA + skillB || 1;
                      const court = String(m.courtNumber || (mi + 1));
                      const winner = getLoggedWinner(ri + 1, court, m.teamA, m.teamB);
                      const recordId = `${sessionDate}-set${ri + 1}-court${court}-${matchIdentity(m.teamA, m.teamB)}`;
                      const isCelebrating = celebratingMatchId === recordId;
                      const upset = winner ? isUpset({ teamA: m.teamA, teamB: m.teamB, winner }, schedule.playerMap) : false;
                      const notesA = m.teamA.map((id) => schedule.playerMap[id]).filter((pl) => pl.injuries || pl.comments);
                      const notesB = m.teamB.map((id) => schedule.playerMap[id]).filter((pl) => pl.injuries || pl.comments);
                      const editing = editingRoundIndex === ri;
                      const feedback = editing ? matchFeedback(m, schedule.rounds, ri, schedule.playerMap) : null;
                      const otherCourtNumbers = round.matches.filter((_, i) => i !== mi).map((om, omi) => String(om.courtNumber || (omi + 1)));
                      const courtClash = editing && otherCourtNumbers.includes(court);
                      const renderTeam = (team, align) => editing ? (
                        <div className={`flex flex-wrap gap-1 ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
                          {team.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => handlePlayerTap(id)}
                              className="tp-focus text-xs font-semibold px-2 py-1 rounded-md"
                              style={{
                                background: selectedPlayerId === id ? 'var(--court)' : 'var(--court-tint)',
                                color: selectedPlayerId === id ? '#fff' : 'var(--court)',
                              }}
                            >
                              {schedule.playerMap[id].name}{winStreaks[id] >= 3 ? ' 🔥' : ''}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className={`font-semibold text-sm ${align === 'right' ? 'text-right' : 'text-left'}`}>
                          {team.map((id) => schedule.playerMap[id].name + (winStreaks[id] >= 3 ? ' 🔥' : '')).join(' & ')}
                        </div>
                      );
                      return (
                        <div key={mi} className="tp-card p-4 relative overflow-hidden">
                          {isCelebrating && (
                            <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
                              {Array.from({ length: 16 }).map((_, ci) => (
                                <span
                                  key={ci}
                                  className="tp-confetti-piece"
                                  style={{
                                    '--tx': `${(Math.random() - 0.5) * 220}px`,
                                    '--ty': `${-60 - Math.random() * 120}px`,
                                    '--rot': `${Math.random() * 720 - 360}deg`,
                                    '--delay': `${Math.random() * 0.15}s`,
                                    background: ['var(--court)', 'var(--clay)', '#D4A017'][ci % 3],
                                    left: '50%',
                                    top: '50%',
                                  }}
                                />
                              ))}
                              <span className="tp-confetti-pop">🎉</span>
                            </div>
                          )}
                          {upset && (
                            <div className="absolute top-2 right-2 text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--clay)', color: '#fff' }}>
                              Upset!
                            </div>
                          )}                          {editing ? (
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-semibold tracking-wide" style={{ color: 'var(--muted)' }}>COURT</span>
                              <select
                                value={court}
                                onChange={(e) => setCourtNumberOverride(ri, mi, e.target.value)}
                                className="tp-focus tp-input px-2 py-1 text-xs font-semibold bg-white"
                                style={{ color: courtClash ? 'var(--warn)' : 'var(--court)' }}
                              >
                                {[1, 2, 3, 4, 5, 6].map((n) => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                              <span className="text-xs font-semibold tracking-wide" style={{ color: 'var(--muted)' }}>· {m.format.toUpperCase()}</span>
                              {courtClash && <span className="text-xs" style={{ color: 'var(--warn)' }}>⚠ also used below</span>}
                            </div>
                          ) : (
                            <div className="text-xs font-semibold mb-2 tracking-wide" style={{ color: 'var(--muted)' }}>
                              COURT {court} · {m.format.toUpperCase()}
                            </div>
                          )}
                          <div className="flex items-center gap-3">
                            <div className="flex-1">{renderTeam(m.teamA, 'right')}</div>
                            <div className="tp-vs text-sm px-1">VS</div>
                            <div className="flex-1">{renderTeam(m.teamB, 'left')}</div>
                          </div>
                          <div className="mt-3 h-1.5 rounded-full overflow-hidden flex" style={{ background: 'var(--line)' }}>
                            <div style={{ width: `${(skillA / total) * 100}%`, background: 'var(--court)' }} />
                            <div style={{ width: `${(skillB / total) * 100}%`, background: 'var(--neutral-fill)' }} />
                          </div>
                          {feedback && feedback.warnings.length > 0 && (
                            <div className="mt-2 space-y-0.5">
                              {feedback.warnings.map((w, wi) => (
                                <div key={wi} className="text-xs" style={{ color: 'var(--warn)' }}>⚠ {w}</div>
                              ))}
                            </div>
                          )}
                          {(notesA.length > 0 || notesB.length > 0) && (
                            <div className="mt-2 text-xs italic" style={{ color: 'var(--muted)' }}>
                              {[...notesA, ...notesB].map((pl) => `${pl.name}: ${[pl.injuries, pl.comments].filter(Boolean).join(' — ')}`).join(' · ')}
                            </div>
                          )}
                          {!editing && (
                            <div className="mt-3 flex items-center gap-2">
                              <span className="text-xs" style={{ color: 'var(--muted)' }}>Winner:</span>
                              <button
                                type="button"
                                onClick={() => logResult(ri + 1, court, m.format, m.teamA, m.teamB, winner === 'A' ? null : 'A')}
                                className="tp-winbtn tp-focus flex-1 py-1.5 text-xs"
                                data-won={winner === 'A'}
                              >
                                {m.teamA.map((id) => schedule.playerMap[id].name).join(' & ')}
                              </button>
                              <button
                                type="button"
                                onClick={() => logResult(ri + 1, court, m.format, m.teamA, m.teamB, winner === 'B' ? null : 'B')}
                                className="tp-winbtn tp-focus flex-1 py-1.5 text-xs"
                                data-won={winner === 'B'}
                              >
                                {m.teamB.map((id) => schedule.playerMap[id].name).join(' & ')}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {round.matches.length === 0 && (
                      <div className="text-sm" style={{ color: 'var(--muted)' }}>No matches could be formed this set.</div>
                    )}
                  </div>
                  {round.sittingOut.length > 0 && (
                    <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {editingRoundIndex === ri ? (
                        <div className="flex items-center flex-wrap gap-1">
                          <span className="mr-1">Sitting out:</span>
                          {round.sittingOut.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => handlePlayerTap(id)}
                              className="tp-focus text-xs font-semibold px-2 py-1 rounded-md"
                              style={{
                                background: selectedPlayerId === id ? 'var(--court)' : '#F1F1EE',
                                color: selectedPlayerId === id ? '#fff' : 'var(--muted)',
                              }}
                            >
                              {schedule.playerMap[id].name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <>Sitting out: {round.sittingOut.map((id) => schedule.playerMap[id].name).join(', ')}</>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {schedule && (
                <div className="space-y-2">
                  <button type="button" onClick={handleGenerate} className="tp-focus w-full py-2.5 flex items-center justify-center gap-2 text-sm rounded-lg border" style={{ borderColor: 'var(--line)', color: 'var(--court)' }}>
                    <Shuffle size={15} />
                    Re-roll pairings
                  </button>
                  <button type="button" onClick={handleCopyForGroupMe} className="tp-btn-secondary tp-focus w-full py-2.5 flex items-center justify-center gap-2 text-sm">
                    <Upload size={15} />
                    {copyStatus === 'copied' ? 'Copied!' : 'Copy for GroupMe'}
                  </button>
                  {copyFallbackText && (
                    <div className="tp-card p-3 space-y-2">
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>
                        {copyStatus === 'fallback'
                          ? 'Auto-copy is blocked here — the text below is already selected, just press copy (Ctrl/Cmd+C):'
                          : 'This is exactly what was copied — drag the corner to see more or less:'}
                      </div>
                      <textarea
                        ref={copyFallbackRef}
                        readOnly
                        value={copyFallbackText}
                        rows={Math.min(30, Math.max(6, copyFallbackText.split('\n').length + 1))}
                        className="tp-input w-full px-3 py-2 text-xs"
                        style={{ resize: 'vertical' }}
                        onClick={(e) => e.target.select()}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="px-4 sm:px-5 py-4 space-y-6">
              {clearHistoryStep === 'idle' && (loggedMatches.length > 0 || recordList.length > 0) && (
                <button
                  type="button"
                  onClick={() => setClearHistoryStep('pin')}
                  className="tp-focus text-xs px-3 py-1.5 rounded-lg border"
                  style={{ borderColor: 'var(--clay)', color: 'var(--clay)' }}
                >
                  Edit history…
                </button>
              )}
              {clearHistoryStep === 'pin' && (
                <div className="tp-card p-4 space-y-2">
                  <div className="text-sm font-semibold">Enter PIN to edit history</div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>Same PIN as the Directory — lets you remove individual matches or clear everything at once.</div>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={clearHistoryPinInput}
                    onChange={(e) => setClearHistoryPinInput(e.target.value)}
                    className="tp-focus tp-input w-full px-3 py-2 text-sm"
                    placeholder="PIN"
                  />
                  {clearHistoryPinError && <div className="text-xs" style={{ color: 'var(--clay)' }}>{clearHistoryPinError}</div>}
                  <div className="flex gap-2">
                    <button type="button" onClick={tryClearHistoryPin} className="tp-btn-primary tp-focus flex-1 py-2 text-sm">Continue</button>
                    <button type="button" onClick={cancelClearHistory} className="tp-btn-secondary tp-focus flex-1 py-2 text-sm">Cancel</button>
                  </div>
                </div>
              )}
              {clearHistoryStep === 'unlocked' && (
                <div className="tp-card p-3 flex items-center justify-between gap-2" style={{ borderColor: 'var(--court)' }}>
                  <div className="text-xs" style={{ color: 'var(--court)' }}>
                    Editing unlocked — tap ✕ next to any match below to remove just that one.
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {loggedMatches.length > 0 && (
                      <button type="button" onClick={() => setClearHistoryStep('confirm')} className="tp-focus text-xs px-2 py-1 rounded-md" style={{ color: 'var(--clay)' }}>Clear all…</button>
                    )}
                    <button type="button" onClick={cancelClearHistory} className="tp-btn-secondary tp-focus text-xs px-2 py-1">Done</button>
                  </div>
                </div>
              )}
              {clearHistoryStep === 'confirm' && (
                <div className="tp-card p-4 space-y-2" style={{ borderColor: 'var(--clay)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--clay)' }}>⚠ This can't be undone</div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    This will permanently delete all {loggedMatches.length} logged match{loggedMatches.length === 1 ? '' : 'es'} and every player's win/loss record. Are you sure?
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={confirmClearHistory} className="tp-focus flex-1 py-2 text-sm font-semibold rounded-lg" style={{ background: 'var(--clay)', color: '#fff' }}>Yes, clear everything</button>
                    <button type="button" onClick={() => setClearHistoryStep('unlocked')} className="tp-btn-secondary tp-focus flex-1 py-2 text-sm">Cancel</button>
                  </div>
                </div>
              )}

              <div>
                <div className="text-sm font-semibold mb-2">Win / loss record</div>
                {recordList.length === 0 ? (
                  <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>No results logged yet. Log winners from the Results tab and they'll show up here.</div>
                ) : (
                  <div className="space-y-1.5">
                    {recordList.map((r) => (
                      <div key={r.name} className="tp-card flex items-center justify-between px-4 py-2.5 text-sm">
                        <span className="font-medium">{r.name}{winStreaks[r.id] >= 3 ? ' 🔥' : ''}</span>
                        <span style={{ color: 'var(--muted)' }}>{r.wins}-{r.losses}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Logged matches</div>
                {loggedMatches.length === 0 ? (
                  <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>Nothing logged yet.</div>
                ) : (
                  <div className="space-y-1.5">
                    {loggedMatches.map((h) => (
                      <div key={h.id} className="tp-card px-4 py-2.5 text-xs flex items-start gap-2" style={{ color: 'var(--muted)' }}>
                        <div className="flex-1">
                          <span className="font-semibold" style={{ color: 'var(--ink)' }}>{h.date}</span> · Set {h.setNumber} · Court {h.court} · {h.format}
                          <div className="mt-0.5">
                            <span style={{ fontWeight: h.winner === 'A' ? 700 : 400, color: h.winner === 'A' ? 'var(--court)' : 'var(--muted)' }}>{h.teamANames.join(' & ')}</span>
                            {' vs '}
                            <span style={{ fontWeight: h.winner === 'B' ? 700 : 400, color: h.winner === 'B' ? 'var(--court)' : 'var(--muted)' }}>{h.teamBNames.join(' & ')}</span>
                          </div>
                        </div>
                        {clearHistoryStep === 'unlocked' && (
                          <button type="button" onClick={() => deleteHistoryEntry(h.id)} className="tp-focus shrink-0" style={{ color: 'var(--clay)' }} aria-label={`Delete match: ${h.date} set ${h.setNumber}`}>
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {isStandalone() && (
            <div className="text-center py-4 text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>
              <div>v{typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : '—'} · Design by Vick Shaker</div>
              <button type="button" onClick={() => setFeedbackOpen(true)} className="tp-focus underline mt-0.5" style={{ color: 'inherit' }}>
                Feedback or questions?
              </button>
            </div>
          )}

          {feedbackOpen && (
            <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={closeFeedback}>
              <div className="tp-card w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
                {feedbackStatus === 'sent' ? (
                  <>
                    <div className="text-sm font-semibold" style={{ color: 'var(--court)' }}>Thanks — sent!</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>We'll get back to you if you left an email.</div>
                    <button type="button" onClick={closeFeedback} className="tp-btn-primary tp-focus w-full py-2 text-sm">Close</button>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-semibold">Feedback or questions?</div>
                    <input
                      type="email"
                      value={feedbackEmail}
                      onChange={(e) => setFeedbackEmail(e.target.value)}
                      placeholder="Your email (optional)"
                      className="tp-focus tp-input w-full px-3 py-2 text-sm"
                    />
                    <textarea
                      value={feedbackMessage}
                      onChange={(e) => setFeedbackMessage(e.target.value)}
                      placeholder="What's on your mind…"
                      rows={4}
                      className="tp-focus tp-input w-full px-3 py-2 text-sm"
                    />
                    {feedbackStatus === 'error' && (
                      <div className="text-xs" style={{ color: 'var(--clay)' }}>Couldn't send that — check your connection and try again.</div>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSubmitFeedback}
                        disabled={!feedbackMessage.trim() || feedbackStatus === 'sending'}
                        className="tp-btn-primary tp-focus flex-1 py-2 text-sm disabled:opacity-50"
                      >
                        {feedbackStatus === 'sending' ? 'Sending…' : 'Send'}
                      </button>
                      <button type="button" onClick={closeFeedback} className="tp-btn-secondary tp-focus flex-1 py-2 text-sm">Cancel</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
