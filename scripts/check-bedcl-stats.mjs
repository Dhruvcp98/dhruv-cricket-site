#!/usr/bin/env node
// Daily BEDCL stats watcher for dhruv-patel-cricket.
//
// Source: the PUBLIC season tables on bedcl.cricket. No login, no session
// cookie, no secrets. Each page is a POST of "seasonid=<id>" and answers with a
// per-season, per-player table (#bedcl_table) covering every club in the league.
// This replaced the old client./stats.bedcl.cricket admin endpoints, which
// required an authenticated session that could not be held in CI.
//
// No dependencies. Node 18+. Never exits non-zero on a failed poll.
//
// IMPORTANT - squad-listed non-appearances ("phantoms"):
// BEDCL counts a player as having PLAYED whenever he was named in a squad, even
// if he neither batted nor bowled. The public tables expose only season
// aggregates, so this script CANNOT filter phantoms out on its own - the blank
// Overs cell that identifies them lives in the admin portal's per-match
// drill-down. What it does instead is flag the signature: a row that gains a
// match while overs, runs and wickets stand still is almost certainly a phantom.
// Those are called out in the PR body for a manual check before publishing.
// Match counts here are therefore RAW and may be one or two higher than the
// figures that belong on the site.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const PLAYERS = { '102165': 'Toronto Peshwas', '110830': 'GTA Peshwas', '111144': 'GTA Mitron' };
const ORIGIN = 'https://bedcl.cricket';
const PAGES = { bowling: '/bowling-by-season', batting: '/batting-by-season' };
const SNAP = 'data/bedcl-snapshot.json';
// Dhruv's first BEDCL season. The dropdown goes back to 1995; no point polling it.
const FIRST_YEAR = 2022;
// Columns that identify the row rather than describe performance.
const ID_COLS = ['division', 'team', 'playerid', 'playername'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(path, body = null, attempt = 1) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch(ORIGIN + path, {
      method: body ? 'POST' : 'GET',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'dhruv-cricket-site watcher',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      },
      body: body || undefined
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(4000 * attempt);
    return req(path, body, attempt + 1);
  }
}

const text = s => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();

// The stats table carries id="bedcl_table". Its thead holds a filter row of
// <select>s as well as the real header, so find the header by looking for the
// "Player Id" cell rather than assuming a position.
function parseTable(html) {
  const tbl = /<table[^>]*id\s*=\s*["']bedcl_table["'][\s\S]*?<\/table>/i.exec(html);
  if (!tbl) return null;
  const rows = [...tbl[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => text(c[1])));
  const hi = rows.findIndex(r => r.some(c => /^player\s*id$/i.test(c)));
  if (hi < 0) return null;
  const head = rows[hi].map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  const idCol = head.indexOf('playerid');
  if (idCol < 0) return null;
  // Real data rows only: the filter row's Player Id cell is not a number.
  const body = rows.slice(hi + 1)
    .filter(r => r.length === head.length && /^\d+$/.test(r[idCol] || ''));
  return { head, idCol, body };
}

function parseSeasons(html) {
  const sel = /<select[^>]*name\s*=\s*["']seasonid["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value\s*=\s*["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi)]
    .map(o => ({ id: o[1], label: text(o[2]) }))
    .filter(s => {
      const y = /^(\d{4})/.exec(s.label);
      return y && Number(y[1]) >= FIRST_YEAR;
    });
}

async function collect(prev) {
  const data = {}, problems = [], carried = [];
  const failedSeasons = new Set();

  let seasons;
  try {
    seasons = parseSeasons(await req(PAGES.bowling));
  } catch (e) {
    problems.push('season list: ' + e.message);
    return { data: null, problems, carried };
  }
  if (!seasons.length) {
    problems.push('season dropdown empty - the page markup may have changed');
    return { data: null, problems, carried };
  }

  for (const season of seasons) {
    for (const kind of ['bowling', 'batting']) {
      let t = null;
      try {
        t = parseTable(await req(PAGES[kind], 'seasonid=' + season.id));
        if (!t) throw new Error('no #bedcl_table in response');
      } catch (e) {
        problems.push(kind + ' / ' + season.label + ': ' + e.message);
        failedSeasons.add(season.label);
        continue;
      }
      for (const row of t.body) {
        const pid = row[t.idCol];
        if (!PLAYERS[pid]) continue;
        const cell = name => {
          const i = t.head.indexOf(name);
          return i < 0 ? '' : row[i];
        };
        const key = [pid, season.label, cell('division'), cell('team')].join('|');
        const rec = data[key] || (data[key] = {
          playerId: pid,
          club: PLAYERS[pid],
          season: season.label,
          division: cell('division'),
          team: cell('team'),
          batting: {},
          bowling: {}
        });
        t.head.forEach((h, i) => {
          if (ID_COLS.includes(h)) return;
          rec[kind][h] = row[i];
        });
      }
      await sleep(600);
    }
  }

  // A season we could not read this run must not look like a season that was
  // deleted. Carry its previous rows forward untouched and say so in the PR.
  for (const [k, v] of Object.entries(prev)) {
    if (data[k]) continue;
    if (failedSeasons.has(v.season || k.split('|')[1])) {
      data[k] = v;
      carried.push(k);
    }
  }

  return { data, problems, carried };
}

function diff(a, b) {
  const out = [];
  for (const k of Object.keys(b)) {
    if (!a[k]) { out.push({ k, type: 'new' }); continue; }
    for (const kind of ['batting', 'bowling']) {
      const x = a[k][kind] || {}, y = b[k][kind] || {};
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (String(x[f] ?? '') !== String(y[f] ?? ''))
          out.push({ k, type: 'changed', kind, field: f, from: x[f] ?? '-', to: y[f] ?? '-' });
    }
  }
  for (const k of Object.keys(a)) if (!b[k]) out.push({ k, type: 'missing' });
  return out;
}

// A row that gains a match while overs, runs and wickets stand still is the
// signature of a squad-listed non-appearance. Flag it; do not guess.
function suspectPhantoms(edits) {
  const byKey = {};
  edits.forEach(c => { (byKey[c.k] = byKey[c.k] || []).push(c); });
  const out = [];
  for (const [k, cs] of Object.entries(byKey)) {
    const bowl = cs.filter(c => c.kind === 'bowling');
    const mat = bowl.find(c => c.field === 'matches');
    if (!mat || !(Number(mat.to) > Number(mat.from))) continue;
    const workMoved = bowl.some(c => ['overs', 'runs', 'wickets', 'maidens'].includes(c.field));
    if (!workMoved) out.push({ k, from: mat.from, to: mat.to });
  }
  return out;
}

function summarise(changes, problems, carried, after) {
  const L = [];

  if (!changes.length) L.push('No change in BEDCL figures since the last check.');
  else {
    L.push('### ' + changes.length + ' change(s) detected', '');

    const news = changes.filter(c => c.type === 'new');
    if (news.length) {
      L.push('**New season rows**', '');
      news.forEach(c => L.push('- \x60' + c.k + '\x60'));
      L.push('');
    }

    const edits = changes.filter(c => c.type === 'changed');
    if (edits.length) {
      L.push('| Season row | Stat | Was | Now |', '|---|---|---|---|');
      edits.forEach(c => {
        const p = c.k.split('|');
        L.push('| ' + p[3] + ' - ' + p[1] + ' | ' + c.kind + '.' + c.field + ' | ' + c.from + ' | ' + c.to + ' |');
      });
      L.push('');
    }

    const gone = changes.filter(c => c.type === 'missing');
    if (gone.length) {
      L.push('**Rows that vanished** (usually a de-ratification - worth a look)', '');
      gone.forEach(c => L.push('- \x60' + c.k + '\x60'));
      L.push('');
    }

    const suspect = suspectPhantoms(edits);
    if (suspect.length) {
      L.push('> **Check for squad-only appearances before publishing.**');
      L.push('>');
      L.push('> These rows gained a match while overs, runs and wickets stayed put - the signature of being named in a squad without batting or bowling:');
      suspect.forEach(s => L.push('> - \x60' + s.k + '\x60 (' + s.from + ' -> ' + s.to + ' matches)'));
      L.push('>');
      L.push('> Confirm in the admin portal drill-down (stats.bedcl.cricket, SeasonBowlingPlayerStats): a BLANK Overs cell means it does not count. Leave it out of the site totals.');
      L.push('');
    }
  }

  let mat = 0, runs = 0, wkts = 0;
  for (const x of Object.values(after)) {
    mat += Number(x.bowling?.matches ?? x.batting?.matches ?? 0);
    runs += Number(x.batting?.runs ?? 0);
    wkts += Number(x.bowling?.wickets ?? 0);
  }
  L.push('**BEDCL raw totals now:** ' + mat + ' matches, ' + runs + ' runs, ' + wkts + ' wickets', '');
  L.push('> Match count is RAW. The public season tables cannot distinguish a squad-listed non-appearance from a real one, so subtract any phantom confirmed in the drill-down before these go on the site. Runs, overs and wickets are unaffected - a phantom contributes nothing to them.');
  L.push('');
  L.push('> Only ratified fixtures appear here - BEDCL excludes unratified matches until the league signs them off, so these are the publishable numbers.');
  L.push('');
  L.push('Apply to \x60index.html\x60: the affected season row(s) in \x60SB\x60, then let the format tables, year table, career footer, hero key stats and meta tags follow. CricClubs leagues are not covered by this job and still need a manual pull.');

  if (carried.length) {
    L.push('', '**Carried forward unchanged** (season could not be read this run, so its previous values were kept rather than reported as removed)', '');
    carried.forEach(k => L.push('- \x60' + k + '\x60'));
  }
  if (problems.length) {
    L.push('', '**Requests that did not answer** (throttling is normal; usually recovers next run)', '');
    problems.forEach(p => L.push('- ' + p));
  }
  return L.join('\n');
}

const before = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {};
const { data, problems, carried } = await collect(before);

if (!data || !Object.keys(data).length) {
  console.log('No data at all - treating as a transient outage, snapshot untouched.');
  problems.forEach(p => console.log('  ' + p));
  process.exit(0);
}

const changes = diff(before, data);
const summary = summarise(changes, problems, carried, data);
writeFileSync(SNAP, JSON.stringify(data, null, 2) + '\n');
writeFileSync('stats-summary.md', summary + '\n');
console.log(summary);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + (changes.length > 0) + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'count=' + changes.length + '\n');
}
