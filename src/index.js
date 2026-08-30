// Apple은 UA 없는/봇성 요청과 공유 IP를 강하게 레이트리밋한다.
// 브라우저 UA를 붙이고, 실패 시 짧은 간격으로 재시도한다.
const ITUNES_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/javascript,*/*'
};

async function fetchItunesJson(itunesUrl, attempts = 3) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(itunesUrl, { headers: ITUNES_HEADERS });
      const text = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${text.slice(0, 100)}`; }
      else {
        try { return { data: JSON.parse(text) }; }
        catch { lastErr = `non-JSON: ${text.slice(0, 100)}`; }
      }
    } catch (e) {
      lastErr = e.message;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
  }
  return { error: lastErr };
}

// Apple의 itunes.apple.com이 Cloudflare Workers 공유 IP를 광범위하게 차단해서
// (그리고 일부 클라이언트 네트워크에서도 직접 접속이 막혀서) Deezer를 대체 소스로 사용한다.
// 응답은 iTunes 검색 결과와 동일한 필드 모양으로 변환해 프론트엔드 코드는 그대로 재사용한다.
function mapDeezerTrack(item) {
  return {
    trackId: item.id,
    trackName: item.title,
    artistName: item.artist?.name || '',
    artistId: item.artist?.id,
    collectionName: item.album?.title || '',
    collectionId: item.album?.id,
    artworkUrl60: item.album?.cover_small || '',
    artworkUrl100: item.album?.cover_medium || '',
    trackTimeMillis: (item.duration || 0) * 1000,
    previewUrl: item.preview || '',
    wrapperType: 'track',
    kind: 'song',
  };
}
function mapDeezerAlbum(item) {
  return {
    collectionId: item.id,
    collectionName: item.title,
    artistName: item.artist?.name || '',
    artistId: item.artist?.id,
    artworkUrl60: item.cover_small || '',
    artworkUrl100: item.cover_medium || '',
    trackCount: item.nb_tracks || 0,
    wrapperType: 'collection',
  };
}
function mapDeezerArtist(item) {
  return {
    artistId: item.id,
    artistName: item.name,
    primaryGenreName: '',
    wrapperType: 'artist',
  };
}

function mapMusicBrainzRecording(item) {
  return {
    trackId: item.id,
    trackName: item.title,
    artistName: item['artist-credit']?.[0]?.artist?.name || item['artist-credit']?.[0]?.name || '',
    collectionName: item.releases?.[0]?.title || '',
    releaseDate: item.releases?.[0]?.date || '',
    artworkUrl60: '',
    artworkUrl100: '',
    wrapperType: 'track',
    kind: 'song',
  };
}

async function musicBrainzSearch(q, limit) {
  const mbUrl = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&limit=${limit}&fmt=json`;
  const res = await fetch(mbUrl, { headers: { 'User-Agent': 'MusicAI/1.0 (https://kjseong0313.github.io)' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}: ${text.slice(0, 150)}`);
  const json = JSON.parse(text);
  return (json.recordings || []).map(mapMusicBrainzRecording);
}

async function deezerSearch(q, entity, limit, debug) {
  const path = entity === 'album' ? 'search/album' : entity === 'musicArtist' ? 'search/artist' : 'search';
  const dzUrl = `https://api.deezer.com/${path}?q=${encodeURIComponent(q)}&limit=${limit}`;

  let lastRaw = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(dzUrl);
    const text = await res.text();
    if (debug) throw new Error(`RAW status=${res.status}: ${text.slice(0, 400)}`);
    if (!res.ok) { lastRaw = `HTTP ${res.status}: ${text.slice(0, 150)}`; }
    else {
      const json = JSON.parse(text);
      if (json.error) { lastRaw = `API error: ${JSON.stringify(json.error).slice(0, 150)}`; }
      else {
        const items = json.data || [];
        // Deezer 게이트웨이가 간헐적으로 total>0인데 data만 빈 배열로 응답하는 버그가 있어 재시도한다.
        if (items.length || !json.total) {
          const mapper = entity === 'album' ? mapDeezerAlbum : entity === 'musicArtist' ? mapDeezerArtist : mapDeezerTrack;
          return items.map(mapper);
        }
        lastRaw = `empty data despite total=${json.total}`;
      }
    }
    if (i < 2) await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Deezer: ${lastRaw}`);
}

export default {
  async fetch(request, env, ctx) {
    // CORS 허용
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    const cache = caches.default;

    // ── iTunes 검색 프록시 (GET) ──
    if (url.pathname === '/itunes') {
      const q = url.searchParams.get('q');
      const entity = url.searchParams.get('entity') || 'song';
      const country = url.searchParams.get('country') || 'KR';
      const limit = url.searchParams.get('limit') || '50';

      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=${entity}&limit=${limit}&country=${country}`;
      const { data: appleData, error: appleError } = await fetchItunesJson(itunesUrl, 1);

      let data;
      const errs = [];
      if (!appleError && appleData?.results?.length) {
        data = { ...appleData, source: 'iTunes' };
      } else {
        appleError && errs.push(`iTunes: ${appleError}`);
        try {
          const results = await deezerSearch(q, entity, limit, url.searchParams.get('debug') === '1');
          data = { resultCount: results.length, results, source: 'Deezer' };
        } catch (e) {
          errs.push(`Deezer: ${e.message}`);
          if (entity === 'song') {
            try {
              const results = await musicBrainzSearch(q, limit);
              data = { resultCount: results.length, results, source: 'MusicBrainz' };
            } catch (e2) {
              errs.push(`MusicBrainz: ${e2.message}`);
            }
          }
        }
      }

      if (!data) {
        return new Response(JSON.stringify({ error: errs.join(' | ') }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800'
        }
      });
      if (data.results?.length) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // ── iTunes lookup 프록시 (GET) ──
    if (url.pathname === '/itunes-lookup') {
      const id = url.searchParams.get('id');
      const entity = url.searchParams.get('entity') || 'song';
      const country = url.searchParams.get('country') || 'US';
      const limit = url.searchParams.get('limit') || '200';

      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const lookupUrl = `https://itunes.apple.com/lookup?id=${id}&entity=${entity}&country=${country}&limit=${limit}`;
      const { data, error } = await fetchItunesJson(lookupUrl);
      if (error) {
        return new Response(JSON.stringify({ error }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const response = new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=1800'
        }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // ── Gemini 프록시 (POST) ──
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const body = await request.json();
    const keys = [env.GEMINI_KEY1, env.GEMINI_KEY2].filter(Boolean);

    if (keys.length === 0) {
      return new Response(JSON.stringify({ error: { message: '환경변수에 키가 없습니다' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let lastError = '';
    for (const key of keys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body.payload)
          }
        );
        const data = await res.json();
        if (data.error?.code === 429) { lastError = '429'; continue; }
        if (data.error) { lastError = data.error.message; continue; }
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch(e) {
        lastError = e.message;
      }
    }

    return new Response(JSON.stringify({ error: { message: '실패: ' + lastError } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
