// Returns the newest Instagram posts across the accounts we hold tokens for.
//
// Tokens live in Netlify environment variables, never in this repo:
//   IG_TOKEN_DHRUV     @dhruvpatell.07
//   IG_TOKEN_PESHWAS   @torontopeshwas
//   IG_TOKEN_SUPER6    @super6ixers
//
// Any account without a token is skipped silently, and if a token has expired
// that account is dropped rather than breaking the rest. If nothing resolves,
// the page keeps showing profile links only — no empty box, no error state.
//
// Instagram long-lived tokens last ~60 days. Refresh with:
//   https://graph.instagram.com/refresh_access_token
//     ?grant_type=ig_refresh_token&access_token=CURRENT_TOKEN
// then paste the new value back into the Netlify env var.

const ACCOUNTS = [
  { env: 'IG_TOKEN_DHRUV',   handle: 'dhruvpatell.07' },
  { env: 'IG_TOKEN_PESHWAS', handle: 'torontopeshwas' },
  { env: 'IG_TOKEN_SUPER6',  handle: 'super6ixers' }
];

const PER_ACCOUNT = 3;
const TOTAL = 6;
const FIELDS = 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp';

function trim(caption) {
  if (!caption) return '';
  const oneLine = caption.replace(/\s+/g, ' ').trim();
  return oneLine.length > 110 ? oneLine.slice(0, 109).trimEnd() + '\u2026' : oneLine;
}

function normalise(item, handle) {
  const isVideo = item.media_type === 'VIDEO';
  const image = isVideo ? item.thumbnail_url : item.media_url;
  if (!image || !item.permalink) return null;
  return {
    id: item.id,
    handle,
    image,
    permalink: item.permalink,
    caption: trim(item.caption),
    timestamp: item.timestamp || '',
    video: isVideo
  };
}

async function fetchAccount({ env, handle }) {
  const token = process.env[env];
  if (!token) return [];
  const url = 'https://graph.instagram.com/me/media'
    + '?fields=' + FIELDS
    + '&limit=' + PER_ACCOUNT
    + '&access_token=' + encodeURIComponent(token);
  const res = await fetch(url);
  if (!res.ok) throw new Error(handle + ': HTTP ' + res.status);
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) throw new Error(handle + ': no data');
  return body.data.map(i => normalise(i, handle)).filter(Boolean);
}

export default async function handler() {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800, s-maxage=1800',
    'Access-Control-Allow-Origin': '*'
  };

  const configured = ACCOUNTS.filter(a => process.env[a.env]);
  if (!configured.length) {
    return new Response(JSON.stringify({ posts: [], configured: 0 }), {
      status: 200, headers
    });
  }

  const settled = await Promise.allSettled(configured.map(fetchAccount));

  const posts = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, TOTAL);

  const failed = settled
    .filter(r => r.status === 'rejected')
    .map(r => String(r.reason && r.reason.message ? r.reason.message : r.reason));

  return new Response(
    JSON.stringify({ posts, configured: configured.length, failed }),
    { status: 200, headers }
  );
}
