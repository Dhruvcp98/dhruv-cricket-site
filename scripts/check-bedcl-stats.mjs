#!/usr/bin/env node
// Daily BEDCL stats watcher for dhruv-patel-cricket.
// Polls the public BEDCL player endpoints, normalises them, and diffs against
// data/bedcl-snapshot.json. Writes the new snapshot + stats-summary.md.
// No dependencies. Node 18+. Never exits non-zero on a failed poll.
//
// IMPORTANT — squad-listed non-appearances:
// The portal's season summary counts a player as having PLAYED whenever he was
// named in a squad, even if he neither batted nor bowled. Taking `mat` at face
// value therefore drifts upward every time Dhruv is named and does not play.
// Those fixtures are identifiable in the per-match drill-down: the Overs cell
// is BLANK, whereas a genuine appearance always carries an explicit figure
// (even 0.0 or 0.5). We fetch the drill-down per season and publish
// `matPlayed` = mat - nonAppearances. Always use matPlayed on the site.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const PLAYERS = { '102165': 'Toronto Peshwas', '110830': 'GTA Peshwas', '111144': 'GTA Mitron' };
// `overs` is NOT a format filter: BEDCL files every 2026 season under overs=50
// whatever the real format. Always poll all three buckets for every player.
const BUCKETS = ['20', '25', '50'];
const BASE = 'https://client.bedcl.cricket';
const REST = 'https://stats.bedcl.cricket/stats_rest.php';
const SNAP = 'data/bedcl-snapshot.json';
const BAT = ['mat','inns','no','runs','ave','hs','hundreds','fifties','fours','sixes'];
const BOWL = ['mat','overs','mdns','runs','wkts','ave','econ','w3plus','w4plus','w5plus'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, attempt = 1) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'dhruv-cricket-site watcher' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(4000 * attempt);
    return get(url, attempt + 1);
  }
}

// Keep the opening <tr ...> attributes: the drill-down season/division IDs live
// there as data-param1 / data-param2 and are not present anywhere in the text.
const trList = html => [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/gi)].map(m => ({
  attrs: m[1],
  cells: [...m[2].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(c => c[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
}));

const attr = (attrs, name) => {
  const m = new RegExp(name + '\\s*=\\s*["\']?(\\d+)', 'i').exec(attrs || '');
  return m ? m[1] : null;
};

// Season rows are: ['', season, 'Division H', team, ...numbers]
// The bare word "Division" is the header cell, so require something after it.
function parseSeasons(html, cols) {
  const out = [];
  for (const { attrs, cells: c } of trList(html)) {
    const i = c.findIndex(x => /^Division\s+\S/i.test(x));
    if (i < 1) continue;
    const season = c[i - 1];
    if (!season || /grand total/i.test(season) || /^season$/i.test(season)) continue;
    const nums = c.slice(i + 2);
    if (!nums.length) continue;
    const rec = {
      season, division: c[i], team: c[i + 1],
      seasonId: attr(attrs, 'data-param1'),
      divisionId: attr(attrs, 'data-param2')
    };
    cols.forEach((k, n) => { rec[k] = nums[n] ?? null; });
    out.push(rec);
  }
  return out;
}

// Per-match drill-down. Columns: Date | # | Opposition | Ground | Overs | Mdns | Runs | Wkts | Ave
async function squadCheck(seasonId, divisionId, playerId) {
  const html = await get(REST + '?seasonId=' + seasonId + '&divisionId=' + divisionId +
                         '&playerid=' + playerId + '&q=SDO');
  const played = trList(html).map(t => t.cells)
    .filter(c => c.length > 4 && /^\d{4}-\d{2}-\d{2}/.test(c[0]));
  const blank = played.filter(c => !c[4] || c[4] === '');
  return {
    listed: played.length,
    nonAppearances: blank.length,
    fixtures: blank.map(c => c[0] + ' v ' + (c[2] || '?'))
  };
}

async function collect() {
  const data = {}, problems = [];
  for (const id of Object.keys(PLAYERS)) {
    for (const overs of BUCKETS) {
      for (const [kind, file, cols] of [['batting','PlayerBattingStats.php',BAT], ['bowling','PlayerBowlingStats.php',BOWL]]) {
        try {
          for (const r of parseSeasons(await get(BASE + '/' + file + '?playerid=' + id + '&overs=' + overs), cols)) {
            const k = id + '|' + r.season + '|' + r.division + '|' + r.team;
            data[k] ??= { playerId: id, club: PLAYERS[id], season: r.season, division: r.division, team: r.team };
            if (r.seasonId) data[k].seasonId = r.seasonId;
            if (r.divisionId) data[k].divisionId = r.divisionId;
            const { season, division, team, seasonId, divisionId, ...stats } = r;
            data[k][kind] = stats;
          }
        } catch (e) {
          problems.push(id + ' overs=' + overs + ' ' + kind + ': ' + e.message);
        }
        await sleep(1500); // the portal throttles hard
      }
    }
  }

  // Second pass: correct every season's match count for squad-listed non-appearances.
  for (const [k, x] of Object.entries(data)) {
    const raw = Number(x.bowling?.mat ?? x.batting?.mat ?? 0);
    if (!x.seasonId || !x.divisionId) {
      x.nonAppearances = null;         // unknown, not zero - do not silently trust `mat`
      x.matPlayed = raw;
      problems.push(k + ': no drill-down IDs on the season row, match count unverified');
      continue;
    }
    try {
      const s = await squadCheck(x.seasonId, x.divisionId, x.playerId);
      x.nonAppearances = s.nonAppearances;
      x.nonAppearanceFixtures = s.fixtures;
      x.matPlayed = raw - s.nonAppearances;
      if (s.listed !== raw) {
        problems.push(k + ': drill-down lists ' + s.listed + ' fixtures but summary says mat=' + raw);
      }
    } catch (e) {
      x.nonAppearances = null;
      x.matPlayed = raw;
      problems.push(k + ' squad check: ' + e.message);
    }
    await sleep(1500);
  }
  return { data, problems };
}

function diff(a, b) {
  const out = [];
  for (const k of Object.keys(b)) {
    if (!a[k]) { out.push({ k, type: 'new' }); continue; }
    for (const kind of ['batting','bowling']) {
      const x = a[k][kind] || {}, y = b[k][kind] || {};
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (String(x[f] ?? '') !== String(y[f] ?? ''))
          out.push({ k, type: 'changed', kind, field: f, from: x[f] ?? '-', to: y[f] ?? '-' });
    }
    for (const f of ['matPlayed','nonAppearances'])
      if (String(a[k][f] ?? '') !== String(b[k][f] ?? ''))
        out.push({ k, type: 'changed', kind: 'squad', field: f, from: a[k][f] ?? '-', to: b[k][f] ?? '-' });
  }
  for (const k of Object.keys(a)) if (!b[k]) out.push({ k, type: 'missing' });
  return out;
}

function summarise(changes, problems, after) {
  const L = [];
  if (!changes.length) L.push('No change in BEDCL figures since the last check.');
  else {
    L.push('### ' + changes.length + ' change(s) detected\n');
    const news = changes.filter(c => c.type === 'new');
    if (news.length) { L.push('**New season rows**\n'); news.forEach(c => L.push('- `' + c.k + '`')); L.push(''); }
    const ed = changes.filter(c => c.type === 'changed');
    if (ed.length) {
      L.push('| Season row | Stat | Was | Now |', '|---|---|---|---|');
      ed.forEach(c => { const p = c.k.split('|'); L.push('| ' + p[3] + ' - ' + p[1] + ' | ' + c.kind + '.' + c.field + ' | ' + c.from + ' | ' + c.to + ' |'); });
      L.push('');
    }
    const gone = changes.filter(c => c.type === 'missing');
    if (gone.length) { L.push('**Rows that vanished** (usually a de-ratification - worth a look)\n'); gone.forEach(c => L.push('- `' + c.k + '`')); L.push(''); }
  }

  let m = 0, mRaw = 0, r = 0, w = 0, na = 0, unverified = 0;
  const naList = [];
  for (const x of Object.values(after)) {
    const raw = Number(x.bowling?.mat ?? x.batting?.mat ?? 0);
    mRaw += raw;
    m += Number(x.matPlayed ?? raw);
    r += Number(x.batting?.runs ?? 0);
    w += Number(x.bowling?.wkts ?? 0);
    if (x.nonAppearances == null) unverified++;
    else { na += x.nonAppearances; (x.nonAppearanceFixtures || []).forEach(f => naList.push(x.team + ' - ' + f)); }
  }
  L.push('**BEDCL totals now:** ' + m + ' matches, ' + r + ' runs, ' + w + ' wickets', '');
  L.push('Use **' + m + '** on the site, not the portal\'s ' + mRaw + '. The difference is ' + na +
         ' squad-listed fixture(s) Dhruv did not play (blank overs in the per-match drill-down).');
  if (naList.length) { L.push('', '**Squad-listed, did not play — excluded**\n'); naList.forEach(f => L.push('- ' + f)); }
  if (unverified) L.push('', '> ' + unverified + ' season row(s) could not be squad-checked; their match counts are the portal\'s raw figure and may be inflated.');
  L.push('', '> Only ratified fixtures appear here - BEDCL excludes unratified matches until the league signs them off, so these are the publishable numbers.');
  L.push('', 'Apply to `index.html`: the BEDCL league-footprint row, the affected season row(s) in `SB`, then let the format tables, year table, hero and meta tags follow. Match counts come from `matPlayed`.');
  if (problems.length) { L.push('', '**Endpoints that did not answer / need a look** (throttling is normal; usually recovers next run)\n'); problems.forEach(p => L.push('- ' + p)); }
  return L.join('\n');
}

const { data, problems } = await collect();
if (!Object.keys(data).length) {
  console.log('No data at all - treating as a transient outage, snapshot untouched.');
  process.exit(0);
}
const before = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {};
const changes = diff(before, data);
const summary = summarise(changes, problems, data);
writeFileSync(SNAP, JSON.stringify(data, null, 2) + '\n');
writeFileSync('stats-summary.md', summary + '\n');
console.log(summary);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + (changes.length > 0) + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'count=' + changes.length + '\n');
}
