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

function buildRound(availableIds, courtFormats, partnerHist, opponentHist, sitOutCount, playerMap) {
  let bestRound = null;
  let bestScore = Infinity;

  for (let attempt = 0; attempt < 250; attempt++) {
    const pool = shuffleArr(availableIds)
      .sort((a, b) => (sitOutCount[b] || 0) - (sitOutCount[a] || 0));

    const used = new Set();
    const matches = [];

    for (const format of courtFormats) {
      const candidates = pool.filter((id) => !used.has(id));
      let actualFormat = format;

      if (format === 'Mixed Doubles') {
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
      matches.push({ format: actualFormat, teamA, teamB });
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

function applyCourtPreferences(matches, playerMap) {
  const arranged = [...matches];

  function preferenceHolder(match, strength) {
    if (!match) return null;
    const all = [...match.teamA, ...match.teamB].map((id) => playerMap[id]);
    return all.find((p) => p.preferredCourt && p.courtPreferenceStrength === strength) || null;
  }

  function applyPass(strength) {
    arranged.forEach((match, idx) => {
      const holder = preferenceHolder(match, strength);
      if (!holder) return;
      const targetIdx = holder.preferredCourt - 1;
      if (targetIdx < 0 || targetIdx >= arranged.length || targetIdx === idx) return;
      const occupantFirmHolder = preferenceHolder(arranged[targetIdx], 'firm');
      if (occupantFirmHolder && strength !== 'firm') return; // never bump a satisfied firm preference for a soft one
      const tmp = arranged[targetIdx];
      arranged[targetIdx] = arranged[idx];
      arranged[idx] = tmp;
    });
  }

  applyPass('firm');
  applyPass('soft');
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


function generateSchedule(players, courtFormats, roundCount) {
  const playerMap = {};
  players.forEach((p) => { playerMap[p.id] = p; });
  const ids = players.map((p) => p.id);

  const partnerHist = {};
  const opponentHist = {};
  const sitOutCount = {};
  ids.forEach((id) => { sitOutCount[id] = 0; });

  const rounds = [];
  for (let r = 0; r < roundCount; r++) {
    const round = buildRound(ids, courtFormats, partnerHist, opponentHist, sitOutCount, playerMap);
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
  courtpreferencestrength: 'courtPreferenceStrength',
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

      const preferredCourt = out.preferredCourt != null && out.preferredCourt !== '' ? Number(out.preferredCourt) : null;
      const strengthRaw = out.courtPreferenceStrength != null ? String(out.courtPreferenceStrength).trim().toLowerCase() : '';
      const courtPreferenceStrength = preferredCourt ? (strengthRaw === 'firm' ? 'firm' : 'soft') : null;

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
        courtPreferenceStrength,
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
    'Court Preference Strength': p.courtPreferenceStrength,
  }));
}

/* ================= app ================= */

const DIRECTORY_KEY = 'player-directory';
const WEEKLY_KEY = 'weekly-state-v2';
const HISTORY_KEY = 'match-history';
const PIN_KEY = 'directory-pin';
const DEFAULT_PIN = '1234';
// Set explicitly by the standalone build's entry point (main.jsx). Inside a Claude artifact
// this stays false, since that's the only environment where the AI-extraction call below
// is actually authenticated.
function isStandalone() {
  return typeof window !== 'undefined' && window.__CC_STANDALONE__ === true;
}
const SKILL_OPTIONS = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
const THIS_YEAR = new Date().getFullYear();

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

function formatBuildTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return '';
  }
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

const BLANK_FORM = {
  name: '', sex: 'M', usta: '', cta: '3.5', handedness: 'R',
  competitive: '3', serving: '', injuries: '', comments: '',
  preferredCourt: '', courtPreferenceStrength: 'soft', birthYear: '',
};

export default function TennisPairingApp() {
  const [directory, setDirectory] = useState([]);
  const [playingIds, setPlayingIds] = useState([]);
  const [courts, setCourts] = useState([
    { id: 'c1', format: 'Mixed Doubles' },
    { id: 'c2', format: 'Mixed Doubles' },
    { id: 'c3', format: 'Doubles' },
    { id: 'c4', format: 'Doubles' },
  ]);
  const [rounds, setRounds] = useState(3);
  const [schedule, setSchedule] = useState(null);
  const [history, setHistory] = useState([]);

  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState('today');
  const [search, setSearch] = useState('');
  const [todaySearch, setTodaySearch] = useState('');
  const [showInactiveToday, setShowInactiveToday] = useState(false);
  const [groupMeText, setGroupMeText] = useState('');
  const [namesText, setNamesText] = useState('');
  const [lastBulkMatchedIds, setLastBulkMatchedIds] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
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
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [changingPin, setChangingPin] = useState(false);
  const [newPinInput, setNewPinInput] = useState('');
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
    const [dirResult, weeklyResult, historyResult, pinResult] = await Promise.allSettled([
      window.storage.get(DIRECTORY_KEY, true),
      window.storage.get(WEEKLY_KEY, true),
      window.storage.get(HISTORY_KEY, true),
      window.storage.get(PIN_KEY, true),
    ]);

    if (dirResult.status === 'fulfilled' && dirResult.value && dirResult.value.value) {
      setDirectory(JSON.parse(dirResult.value.value));
    } else {
      setDirectory([]);
    }

    if (weeklyResult.status === 'fulfilled' && weeklyResult.value && weeklyResult.value.value) {
      const w = JSON.parse(weeklyResult.value.value);
      setPlayingIds(w.playingIds || []);
      if (w.courts) setCourts(w.courts);
      if (w.rounds) setRounds(w.rounds);
      setSchedule(w.schedule || null);
    }

    if (historyResult.status === 'fulfilled' && historyResult.value && historyResult.value.value) {
      setHistory(JSON.parse(historyResult.value.value));
    } else {
      setHistory([]);
    }

    if (pinResult.status === 'fulfilled' && pinResult.value && pinResult.value.value) {
      setDirectoryPin(pinResult.value.value);
    } else {
      setDirectoryPin(DEFAULT_PIN);
    }
  }, []);

  useEffect(() => { loadAll().then(() => setLoaded(true)); }, [loadAll]);

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

  async function persistWeekly(partial) {
    const next = {
      playingIds: partial.playingIds !== undefined ? partial.playingIds : playingIds,
      courts: partial.courts !== undefined ? partial.courts : courts,
      rounds: partial.rounds !== undefined ? partial.rounds : rounds,
      schedule: partial.schedule !== undefined ? partial.schedule : schedule,
    };
    if (partial.playingIds !== undefined) setPlayingIds(partial.playingIds);
    if (partial.courts !== undefined) setCourts(partial.courts);
    if (partial.rounds !== undefined) setRounds(partial.rounds);
    if (partial.schedule !== undefined) setSchedule(partial.schedule);
    try {
      await window.storage.set(WEEKLY_KEY, JSON.stringify(next), true);
      setSaveError('');
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
      courtPreferenceStrength: f.preferredCourt ? (f.courtPreferenceStrength || 'soft') : null,
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
      courtPreferenceStrength: p.courtPreferenceStrength || 'soft',
    });
  }

  function saveEdit() {
    const updated = formToEntry(editForm, editingId);
    persistDirectory(directory.map((p) => (p.id === editingId ? updated : p)));
    setEditingId(null);
  }

  function handleMatchNames() {
    const raw = parseNamesText(namesText).map((n) => {
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

  async function callGroupMeExtraction() {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: 'Below is copy-pasted text from a GroupMe group chat where people are replying '
            + 'to a callout about tennis signups. Some messages are RSVPs ("in", "I\'m in", "IN", '
            + '"in if numbers work", etc.), some are unrelated chatter, and some are just emoji '
            + 'reactions with no name attached - ignore all of those, they are not RSVPs.\n\n'
            + 'Watch for this specific pattern: the person who posted the original callout question '
            + '(e.g. "who else is in?") often later reports a running headcount ("We have 12", '
            + '"That\'s 10 so far") without ever writing "I\'m in" themselves, because they\'re '
            + 'assuming their own participation is understood. If the number of people who gave an '
            + 'explicit RSVP is exactly one less than the headcount that same person states, include '
            + 'that asker in the list too - the count implies they\'re part of it.\n\n'
            + 'Respond with ONLY a JSON array of the names of people who indicated they want to play. '
            + 'Nothing before it, nothing after it, no markdown fences, no explanation - the entire '
            + 'response must be parseable as JSON on its own.\n\nTranscript:\n' + groupMeText,
        }],
      }),
    });
    const data = await response.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    // Pull out the array even if the model added stray text around it, rather than
    // requiring the whole response to be pure JSON.
    const match = textBlocks.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function handleExtractFromGroupMe() {
    if (!groupMeText.trim()) return;
    setExtracting(true);
    setExtractError('');
    try {
      let names = await callGroupMeExtraction();
      if (!names) names = await callGroupMeExtraction(); // one silent retry before giving up
      if (names && names.length) {
        setNamesText((prev) => (prev ? prev + '\n' : '') + names.join('\n'));
      } else {
        setExtractError('Could not find any names in that text.');
      }
    } catch (e) {
      console.error('Extraction failed', e);
      setExtractError('Could not read that — you can still type names in directly below.');
    } finally {
      setExtracting(false);
    }
  }

  function toggleActive(id) {
    persistDirectory(directory.map((p) => (p.id === id ? { ...p, active: !p.active } : p)));
  }

  function removeFromDirectory(id) {
    persistDirectory(directory.filter((p) => p.id !== id));
    persistWeekly({ playingIds: playingIds.filter((pid) => pid !== id) });
  }

  function togglePlaying(id) {
    const next = playingIds.includes(id) ? playingIds.filter((pid) => pid !== id) : [...playingIds, id];
    persistWeekly({ playingIds: next });
  }

  function handleStartNewWeek() {
    persistWeekly({ playingIds: [], schedule: null });
    setConfirmingReset(false);
    setTab('today');
  }

  function handleUncheckAll() {
    persistWeekly({ playingIds: [] });
    setMatchResults(null);
    setNamesText('');
    setGroupMeText('');
    setConfirmingUncheck(false);
  }

  function tryUnlockDirectory() {
    if (pinInput.trim() === String(directoryPin)) {
      setDirectoryUnlocked(true);
      setPinInput('');
      setPinError('');
    } else {
      setPinError('Wrong PIN.');
    }
  }

  async function handleChangePin() {
    const next = newPinInput.trim();
    if (!next) return;
    setDirectoryPin(next);
    try {
      await window.storage.set(PIN_KEY, next, true);
      setSaveError('');
    } catch (e) {
      console.error('pin save failed', e);
      setSaveError("Your new PIN didn't save — check your connection and try again.");
    }
    setNewPinInput('');
    setChangingPin(false);
  }

  function addCourt() {
    persistWeekly({ courts: [...courts, { id: uid(), format: 'Doubles' }] });
  }
  function removeCourt(id) {
    persistWeekly({ courts: courts.filter((c) => c.id !== id) });
  }
  function setCourtFormat(id, format) {
    persistWeekly({ courts: courts.map((c) => (c.id === id ? { ...c, format } : c)) });
  }
  function setRoundsCount(n) {
    persistWeekly({ rounds: Math.max(1, n) });
  }

  function handleGenerate() {
    const players = directory.filter((p) => playingIds.includes(p.id));
    const result = generateSchedule(players, courts.map((c) => c.format), rounds);
    persistWeekly({ schedule: result });
    setTab('results');
  }

  function logResult(setNumber, court, format, teamA, teamB, winner) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const recordId = `${dateStr}-set${setNumber}-court${court}`;
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
  }

  function getLoggedWinner(setNumber, court) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const found = history.find((h) => h.id === `${dateStr}-set${setNumber}-court${court}`);
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
  const playingTodayList = todayFilter(activeDirectory.filter((p) => playingIds.includes(p.id)));
  const notPlayingTodayList = todayFilter(activeDirectory.filter((p) => !playingIds.includes(p.id)));
  const inactiveTodayFiltered = todayFilter(inactiveDirectory);

  const playingCount = playingIds.length;
  const neededPerRound = courts.reduce((s, c) => s + (c.format === 'Singles' ? 2 : 4), 0);
  const canGenerate = playingCount >= 2 && courts.length > 0;

  const records = {};
  directory.forEach((p) => { records[p.id] = { wins: 0, losses: 0, name: p.name }; });
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

  return (
    <div className="tp-root w-full" style={{ minHeight: '100%' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        .tp-root {
          --bg: #F6F7F4; --surface: #FFFFFF; --ink: #1C211D; --muted: #6B7268;
          --court: #1E5631; --court-tint: #E7F0E9; --clay: #A8532E; --clay-tint: #F3E4DC;
          --warn: #9C6B0B; --warn-tint: #F5EBD6; --neutral-fill: #9CA39A;
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
              <div className="tp-display text-2xl font-extrabold leading-none">COURT CALL</div>
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
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--court-tint)', color: 'var(--court)' }}>
                Tap a name to mark them in for today. This list is what resets when you start a new week — the full directory underneath stays put.
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

              <input
                value={todaySearch}
                onChange={(e) => setTodaySearch(e.target.value)}
                placeholder="Search…"
                className="tp-focus tp-input w-full px-3 py-2 text-sm"
              />

              <div className="tp-card p-4 space-y-3">
                <div className="text-sm font-semibold">Mark several people at once</div>

                {!isStandalone() && (
                  <details>
                    <summary className="text-xs cursor-pointer" style={{ color: 'var(--court)' }}>
                      Paste from GroupMe instead of typing names
                    </summary>
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={groupMeText}
                        onChange={(e) => setGroupMeText(e.target.value)}
                        placeholder="Paste the GroupMe thread here…"
                        rows={4}
                        className="tp-focus tp-input w-full px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={handleExtractFromGroupMe}
                        disabled={extracting || !groupMeText.trim()}
                        className="tp-btn-secondary tp-focus px-3 py-1.5 text-xs flex items-center gap-1.5"
                      >
                        {extracting && <Loader2 size={13} className="animate-spin" />}
                        {extracting ? 'Reading…' : 'Pull names from this'}
                      </button>
                      {extractError && <div className="text-xs" style={{ color: 'var(--clay)' }}>{extractError}</div>}
                    </div>
                  </details>
                )}

                <textarea
                  value={namesText}
                  onChange={(e) => setNamesText(e.target.value)}
                  placeholder="Just names, one per line — e.g. Robb Fox"
                  rows={4}
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
                            <select
                              value={r.cta}
                              onChange={(e) => updatePendingDraft(i, 'cta', e.target.value)}
                              className="tp-focus tp-input px-1.5 py-1.5 text-xs bg-white shrink-0"
                            >
                              {SKILL_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
                            </select>
                            <button type="button" onClick={() => addOnePending(i)} className="tp-input px-2 py-1.5 text-xs shrink-0" style={{ color: 'var(--court)' }}>
                              Add
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
                    <select value={form.cta} onChange={(e) => setForm({ ...form, cta: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                      {SKILL_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
                    </select>
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
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>Preferred court</label>
                          <select value={form.preferredCourt} onChange={(e) => setForm({ ...form, preferredCourt: e.target.value })} className="tp-focus tp-input w-full px-2 py-2 text-sm bg-white">
                            <option value="">No preference</option>
                            {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>Court {v}</option>)}
                          </select>
                        </div>
                        {form.preferredCourt !== '' && (
                          <div className="flex-1">
                            <label className="text-xs block mb-1" style={{ color: 'var(--muted)' }}>How firm?</label>
                            <div className="tp-input flex overflow-hidden">
                              {['soft', 'firm'].map((s) => (
                                <button key={s} type="button" onClick={() => setForm({ ...form, courtPreferenceStrength: s })}
                                  className="flex-1 px-3 py-2 text-sm font-semibold capitalize"
                                  style={{ background: form.courtPreferenceStrength === s ? 'var(--court-tint)' : 'transparent', color: form.courtPreferenceStrength === s ? 'var(--court)' : 'var(--muted)' }}>
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
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

              {directory.length === 0 && (
                <div className="text-sm text-center py-8" style={{ color: 'var(--muted)' }}>
                  No players in the directory yet. Add someone above, or head to the Directory tab to import a spreadsheet.
                </div>
              )}

              {directory.length > 0 && (
                <>
                  <div>
                    <div className="text-sm font-semibold mb-2">Playing today ({playingTodayList.length})</div>
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

          {tab === 'directory' && !directoryUnlocked && (
            <div className="px-4 sm:px-5 py-10 flex flex-col items-center text-center gap-3">
              <Lock size={22} style={{ color: 'var(--muted)' }} />
              <div className="text-sm font-semibold">This is the full member directory</div>
              <div className="text-xs max-w-xs" style={{ color: 'var(--muted)' }}>
                Meant for whoever helps manage the club, not everyone marking themselves in. Enter the PIN to continue.
              </div>
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

          {tab === 'directory' && directoryUnlocked && (
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
                <button type="button" onClick={() => setChangingPin(!changingPin)} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--muted)' }}>
                  <Lock size={14} />
                  Change PIN
                </button>
                <button type="button" onClick={() => setDirectoryUnlocked(false)} className="tp-focus tp-input flex items-center gap-1.5 text-sm px-3 py-1.5" style={{ color: 'var(--muted)' }}>
                  Lock &amp; Exit
                </button>
              </div>

              {changingPin && (
                <div className="tp-card p-3 flex items-center gap-2 text-sm">
                  <input value={newPinInput} onChange={(e) => setNewPinInput(e.target.value)} placeholder="New PIN" className="tp-focus tp-input flex-1 px-3 py-2 text-sm" />
                  <button type="button" onClick={handleChangePin} className="px-3 py-1.5 rounded-md font-semibold text-sm" style={{ background: 'var(--court)', color: '#fff' }}>Save</button>
                  <button type="button" onClick={() => setChangingPin(false)} className="text-sm" style={{ color: 'var(--muted)' }}>Cancel</button>
                </div>
              )}

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
                          <select value={editForm.cta} onChange={(e) => setEditForm({ ...editForm, cta: e.target.value })} className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white">
                            {SKILL_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(1)} CTA</option>)}
                          </select>
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
                        <div className="flex gap-2">
                          <select value={editForm.preferredCourt} onChange={(e) => setEditForm({ ...editForm, preferredCourt: e.target.value })} className="tp-focus tp-input flex-1 px-2 py-2 text-sm bg-white">
                            <option value="">No court preference</option>
                            {[1, 2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>Court {v}</option>)}
                          </select>
                          {editForm.preferredCourt !== '' && (
                            <div className="tp-input flex overflow-hidden flex-1">
                              {['soft', 'firm'].map((s) => (
                                <button key={s} type="button" onClick={() => setEditForm({ ...editForm, courtPreferenceStrength: s })}
                                  className="flex-1 px-3 py-2 text-sm font-semibold capitalize"
                                  style={{ background: editForm.courtPreferenceStrength === s ? 'var(--court-tint)' : 'transparent', color: editForm.courtPreferenceStrength === s ? 'var(--court)' : 'var(--muted)' }}>
                                  {s}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
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
                            <span style={{ color: p.courtPreferenceStrength === 'firm' ? 'var(--clay)' : 'var(--muted)' }}>
                              {p.courtPreferenceStrength === 'firm' ? 'Always' : 'Prefers'} Court {p.preferredCourt}
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
              <div>
                <div className="text-sm font-semibold mb-2">Courts this week</div>
                <div className="space-y-2">
                  {courts.map((c, i) => (
                    <div key={c.id} className="tp-card flex items-center gap-3 px-4 py-3">
                      <span className="tp-display font-bold text-sm w-6" style={{ color: 'var(--muted)' }}>{i + 1}</span>
                      <select value={c.format} onChange={(e) => setCourtFormat(c.id, e.target.value)} className="tp-focus tp-input flex-1 px-2 py-1.5 text-sm bg-white">
                        <option>Singles</option>
                        <option>Doubles</option>
                        <option>Mixed Doubles</option>
                      </select>
                      <button type="button" onClick={() => removeCourt(c.id)} style={{ color: 'var(--muted)' }} aria-label={`Remove court ${i + 1}`}>
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  {courts.length === 0 && (
                    <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>Add a court to set up this week's matches.</div>
                  )}
                </div>
                <button type="button" onClick={addCourt} className="tp-focus mt-2 flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border" style={{ borderColor: 'var(--line)', color: 'var(--court)' }}>
                  <Plus size={14} />
                  Add court
                </button>
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
                      Tap two players (including in Sitting out) to swap their spots.
                    </div>
                  )}
                  <div className="space-y-3">
                    {round.matches.map((m, mi) => {
                      const skillA = avgSkill(m.teamA, schedule.playerMap);
                      const skillB = avgSkill(m.teamB, schedule.playerMap);
                      const total = skillA + skillB || 1;
                      const court = String(mi + 1);
                      const winner = getLoggedWinner(ri + 1, court);
                      const notesA = m.teamA.map((id) => schedule.playerMap[id]).filter((pl) => pl.injuries || pl.comments);
                      const notesB = m.teamB.map((id) => schedule.playerMap[id]).filter((pl) => pl.injuries || pl.comments);
                      const editing = editingRoundIndex === ri;
                      const feedback = editing ? matchFeedback(m, schedule.rounds, ri, schedule.playerMap) : null;
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
                              {schedule.playerMap[id].name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className={`font-semibold text-sm ${align === 'right' ? 'text-right' : 'text-left'}`}>
                          {team.map((id) => schedule.playerMap[id].name).join(' & ')}
                        </div>
                      );
                      return (
                        <div key={mi} className="tp-card p-4">
                          <div className="text-xs font-semibold mb-2 tracking-wide" style={{ color: 'var(--muted)' }}>
                            COURT {court} · {m.format.toUpperCase()}
                          </div>
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
              <div>
                <div className="text-sm font-semibold mb-2">Win / loss record</div>
                {recordList.length === 0 ? (
                  <div className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>No results logged yet. Log winners from the Results tab and they'll show up here.</div>
                ) : (
                  <div className="space-y-1.5">
                    {recordList.map((r) => (
                      <div key={r.name} className="tp-card flex items-center justify-between px-4 py-2.5 text-sm">
                        <span className="font-medium">{r.name}</span>
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
                      <div key={h.id} className="tp-card px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                        <span className="font-semibold" style={{ color: 'var(--ink)' }}>{h.date}</span> · Set {h.setNumber} · Court {h.court} · {h.format}
                        <div className="mt-0.5">
                          <span style={{ fontWeight: h.winner === 'A' ? 700 : 400, color: h.winner === 'A' ? 'var(--court)' : 'var(--muted)' }}>{h.teamANames.join(' & ')}</span>
                          {' vs '}
                          <span style={{ fontWeight: h.winner === 'B' ? 700 : 400, color: h.winner === 'B' ? 'var(--court)' : 'var(--muted)' }}>{h.teamBNames.join(' & ')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {isStandalone() && (
            <div className="text-center py-4 text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>
              Built {formatBuildTime(typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '')} · Vick Shaker
            </div>
          )}
        </div>
      )}
    </div>
  );
}
