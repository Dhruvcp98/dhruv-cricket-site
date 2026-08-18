#!/usr/bin/env node
// Daily BEDCL stats watcher for dhruv-patel-cricket.
// Polls the public BEDCL player endpoints, normalises them, and diffs against
// data/bedcl-snapshot.json. Writes the new snapshot + stats-summary.md.
// No dependencies. Node 18+. Never exits non-zero on a failed poll.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const PLAYERS = { '102165': 'Toronto Peshwas', '110830': 'GTA Peshwas', '111144': 'GTA Mitron' };
// `overs` is NOT a format filter: BEDCL files every 2026 season under overs=50
// whatever the real format. Always poll all three buckets for every player.
const BUCKETS = ['20', '25', '50'];
const BASE = 'https://client.bedcl.cricket';
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

const rows = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
  [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(c => c[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()));

// Season rows are: ['', season, 'Division H', team, ...numbers]
// The bare word "Division" is the header cell, so require something after it.
function parseSeasons(html, cols) {
  const out = [];
  for (const c of rows(html)) {
    const i = c.findIndex(x => /^Division\s+\S/i.test(x));
    if (i < 1) continue;
    const season = c[i - 1];
    if (!season || /grand total/i.test(season) || /^season$/i.test(season)) continue;
    const nums = c.slice(i + 2);
    if (!nums.length) continue;
    const rec = { season, division: c[i], team: c[i + 1] };
    cols.forEach((k, n) => { rec[k] = nums[n] ?? null; });
    out.push(rec);
  }
  return out;
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
            const { season, division, team, ...stats } = r;
            data[k][kind] = stats;
          }
        } catch (e) {
          problems.push(id + ' overs=' + overs + ' ' + kind + ': ' + e.message);
        }
        await sleep(1500); // the portal throttles hard
      }
    }
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
  let m = 0, r = 0, w = 0;
  for (const x of Object.values(after)) {
    m += Number(x.bowling?.mat ?? x.batting?.mat ?? 0);
    r += Number(x.batting?.runs ?? 0);
    w += Number(x.bowling?.wkts ?? 0);
  }
  L.push('**BEDCL totals now:** ' + m + ' matches, ' + r + ' runs, ' + w + ' wickets', '');
  L.push('> Only ratified fixtures appear here - BEDCL excludes unratified matches until the league signs them off, so these are the publishable numbers.');
  L.push('', 'Apply to `index.html`: the BEDCL league-footprint row, the affected season row(s) in `SB`, then let the format tables, hero and meta tags follow.');
  if (problems.length) { L.push('', '**Endpoints that did not answer** (throttling is normal; usually recovers next run)\n'); problems.forEach(p => L.push('- ' + p)); }
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
