// Returns the newest videos across the club YouTube channels.
//
// Why this exists: YouTube's per-channel RSS feed is public and needs no API
// key, but it sends no CORS headers, so the browser cannot read it directly.
// This runs server-side on Netlify, so it can. Cached at the CDN for 30
// minutes, which keeps the page fast and avoids hammering YouTube.
//
// No API key, no token to expire, nothing to maintain.

const CHANNELS = [
  { id: 'UCJK7R-i9JUNp_xqlOeP1UYA', name: 'Toronto Peshwas' },
  { id: 'UCHar5jJ8ldK-8xUVwrzSjSw', name: 'Super 6ixers' }
];

const LIMIT = 3;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&nbsp;': ' '
};

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;|&#\d+;/gi, m => ENTITIES[m.toLowerCase()] ?? m)
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? decode(m[1]) : '';
}

export function parseFeed(xml, channelName) {
  const out = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const id = pick(block, 'yt:videoId');
    if (!id) continue;
    out.push({
      id,
      title: pick(block, 'title'),
      published: pick(block, 'published'),
      channel: channelName
    });
  }
  return out;
}

export default async function handler() {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800, s-maxage=1800',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const results = await Promise.allSettled(
      CHANNELS.map(async c => {
        const res = await fetch(
          'https://www.youtube.com/feeds/videos.xml?channel_id=' + c.id,
          { headers: { 'User-Agent': 'dhruv-cricket-site/1.0' } }
        );
        if (!res.ok) throw new Error(c.name + ': HTTP ' + res.status);
        return parseFeed(await res.text(), c.name);
      })
    );

    const videos = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(v => v.published)
      .sort((a, b) => new Date(b.published) - new Date(a.published))
      .slice(0, LIMIT);

    if (!videos.length) {
      return new Response(JSON.stringify({ videos: [], error: 'no entries' }), {
        status: 502, headers
      });
    }

    return new Response(JSON.stringify({ videos }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ videos: [], error: String(err) }), {
      status: 502, headers
    });
  }
}
