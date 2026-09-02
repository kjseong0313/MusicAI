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
    releaseDate: item.release_date || '',
    wrapperType: 'collection',
  };
}
function mapDeezerArtist(item) {
  return {
    artistId: item.id,
    artistName: item.name,
    artworkUrl60: item.picture_small || '',
    artworkUrl100: item.picture_medium || '',
    primaryGenreName: '',
    wrapperType: 'artist',
  };
}

// 커버 아트 아카이브. 없는 음반도 많아서(404) 프론트엔드에서 대체 아이콘으로 넘어간다.
const caaUrl = (kind, id, size) => id ? `https://coverartarchive.org/${kind}/${id}/front-${size}` : '';

function mapMusicBrainzRecording(item) {
  const release = item.releases?.[0];
  return {
    trackId: item.id,
    trackName: item.title,
    artistName: item['artist-credit']?.[0]?.artist?.name || item['artist-credit']?.[0]?.name || '',
    artistId: item['artist-credit']?.[0]?.artist?.id || '',
    collectionName: release?.title || '',
    collectionId: release?.['release-group']?.id || '',
    releaseDate: release?.date || '',
    artworkUrl60: caaUrl('release', release?.id, 250),
    artworkUrl100: caaUrl('release', release?.id, 500),
    wrapperType: 'track',
    kind: 'song',
  };
}

// Lucene 특수문자를 그대로 넘기면 400이 나거나 질의가 엉뚱하게 해석된다.
function escapeLucene(s) {
  return String(s || '').replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
}

// 넉넉한 길이의 낱말에는 ~를 붙여 오타를 허용한다(Lucene 퍼지 검색).
function mbQuery(q) {
  return String(q || '').split(/\s+/).filter(Boolean)
    .map(t => /^[\p{L}\p{N}]{4,}$/u.test(t) ? `${t}~` : escapeLucene(t))
    .join(' ');
}

// MusicBrainz의 score(0~100)는 인기도가 아니라 자체 관련도 점수다.
const mbPopularity = it => (it.score || 0) / 100;

async function mbSearch(kind, q, limit) {
  const want = Number(limit) || 50;
  const url = `https://musicbrainz.org/ws/2/${kind}/?query=${encodeURIComponent(mbQuery(q))}&limit=${Math.min(want * 2, 100)}&fmt=json`;
  return { json: await mbJson(url), want };
}

async function musicBrainzSearch(q, limit) {
  const { json, want } = await mbSearch('recording', q, limit);
  return rankResults(json.recordings || [], q, {
    title: it => it.title || '',
    artist: it => it['artist-credit']?.[0]?.artist?.name || it['artist-credit']?.[0]?.name || '',
    popularity: mbPopularity,
  }).slice(0, want).map(mapMusicBrainzRecording);
}

async function mbArtistSearch(q, limit) {
  const { json, want } = await mbSearch('artist', q, limit);
  return rankResults(json.artists || [], q, {
    title: it => it.name || '',
    artist: () => '',
    popularity: mbPopularity,
  }).slice(0, want).map(a => ({
    artistId: a.id,
    artistName: a.name,
    primaryGenreName: a.disambiguation || a.area?.name || '',
    wrapperType: 'artist',
  }));
}

async function mbAlbumSearch(q, limit) {
  const { json, want } = await mbSearch('release-group', q, limit);
  return rankResults(json['release-groups'] || [], q, {
    title: it => it.title || '',
    artist: it => it['artist-credit']?.[0]?.artist?.name || it['artist-credit']?.[0]?.name || '',
    popularity: mbPopularity,
  }).slice(0, want).map(rg => ({
    collectionId: rg.id,
    collectionName: rg.title,
    artistName: rg['artist-credit']?.[0]?.artist?.name || rg['artist-credit']?.[0]?.name || '',
    releaseDate: rg['first-release-date'] || '',
    artworkUrl60: caaUrl('release-group', rg.id, 250),
    artworkUrl100: caaUrl('release-group', rg.id, 500),
    trackCount: 0,
    wrapperType: 'collection',
  }));
}

const MB_HEADERS = { 'User-Agent': 'MusicAI/1.0 (https://kjseong0313.github.io)' };

async function mbJson(url) {
  const res = await fetch(url, { headers: MB_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text);
}

// Deezer는 이 헤더로 카탈로그와 표기 언어를 정한다. ko-KR을 쓰면 한국 카탈로그가 오는데
// 라이선스 때문에 유명 원곡이 통째로 빠져 있어(Ed Sheeran, IU, BTS 등 검색 불가) 쓸 수 없다.
// en-US는 카탈로그가 가장 넓고 가수 이름도 로마자로 온다.
const DEEZER_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };

// Deezer 게이트웨이가 간헐적으로 유효한 ID에도 빈 배열을 응답하는 버그가 있어,
// 배열이 비어 있으면 몇 번 재시도한다 (ID 기반 조회는 결과가 진짜로 비어있을 일이 거의 없다).
async function deezerFetchRetry(url, extract) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: DEEZER_HEADERS });
      const text = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${text.slice(0, 150)}`; }
      else {
        const json = JSON.parse(text);
        if (json.error) { lastErr = `API error: ${JSON.stringify(json.error).slice(0, 150)}`; }
        else {
          const items = extract(json);
          if (items.length) return items;
          lastErr = 'empty response';
        }
      }
    } catch (e) { lastErr = e.message; }
    if (i < 2) await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Deezer: ${lastErr}`);
}

// 가수 -> 앨범 목록 (Deezer)
async function deezerArtistAlbums(id) {
  const items = await deezerFetchRetry(`https://api.deezer.com/artist/${id}/albums?limit=100`, json => json.data || []);
  return items.map(mapDeezerAlbum);
}

// 앨범 -> 트랙 목록 (Deezer)
async function deezerAlbumTracks(id) {
  const items = await deezerFetchRetry(`https://api.deezer.com/album/${id}`, json => json.tracks?.data || []);
  return items.map((t, i) => ({
    trackId: t.id,
    trackName: t.title,
    artistName: t.artist?.name || '',
    trackNumber: t.track_position || i + 1,
    trackTimeMillis: (t.duration || 0) * 1000,
    previewUrl: t.preview || '',
    wrapperType: 'track',
    kind: 'song',
  }));
}

// 가수 -> 앨범 목록 (MusicBrainz release-group)
async function mbArtistAlbums(id) {
  const json = await mbJson(`https://musicbrainz.org/ws/2/release-group?artist=${id}&type=album|ep&fmt=json&limit=100`);
  return (json['release-groups'] || [])
    .map(rg => ({
      collectionId: rg.id,
      collectionName: rg.title,
      releaseDate: rg['first-release-date'] || '',
      artworkUrl60: caaUrl('release-group', rg.id, 250),
      artworkUrl100: caaUrl('release-group', rg.id, 500),
      wrapperType: 'collection',
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}

// 앨범(release-group) -> 트랙 목록 (MusicBrainz)
async function mbAlbumTracks(releaseGroupId) {
  const json = await mbJson(`https://musicbrainz.org/ws/2/release?release-group=${releaseGroupId}&fmt=json&inc=recordings&limit=1`);
  const release = json.releases?.[0];
  if (!release) return [];
  const tracks = [];
  for (const medium of release.media || []) {
    for (const t of medium.tracks || []) {
      tracks.push({
        trackId: t.recording?.id || t.id,
        trackName: t.title || t.recording?.title || '',
        trackNumber: t.position || tracks.length + 1,
        trackTimeMillis: t.length || t.recording?.length || 0,
        wrapperType: 'track',
        kind: 'song',
      });
    }
  }
  return tracks;
}

// ── 검색 결과 재순위 ──
// Deezer/MusicBrainz는 iTunes만큼 정렬이 좋지 않다(인기 없는 커버·가라오케·다른 언어
// 재발매가 위로 올라온다). 관련도와 인기도를 직접 계산해 다시 정렬한다.
const JAPANESE_RE = /[぀-ヿ]/;
const JUNK_RE = /karaoke|tribute|made popular by|originally performed|as made famous|backing track|instrumental version|8[\s-]?bit|lullaby|가라오케|노래방|반주/i;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\(.*?\)|\[.*?\]/g, ' ')   // (feat. X), [Remastered] 같은 부가 표기
    .replace(/\bfeat\.?\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // 구두점 제거 → 표기 차이를 흡수
    .trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0(무관) ~ 1(완전 일치). 오타와 단어 생략을 모두 감안한다.
function similarity(q, target) {
  if (!q || !target) return 0;
  if (q === target) return 1;
  if (target.startsWith(q)) return 0.95;   // "bohemian" → "Bohemian Rhapsody"
  if (target.includes(q)) return 0.85;
  const qTokens = q.split(' ').filter(Boolean);
  const tTokens = new Set(target.split(' ').filter(Boolean));
  const hits = qTokens.filter(t => tTokens.has(t)).length;
  const byToken = qTokens.length ? hits / qTokens.length : 0;                      // 단어 생략 허용
  // 오타 허용. 글자 한두 개 차이는 거의 감점하지 않아야 철자가 똑같이 틀린 무명 커버가
  // 원곡을 밀어내지 않는다.
  const byEdit = 1 - editDistance(q, target) / Math.max(q.length, target.length);
  return Math.max(byToken * 0.8, byEdit);
}

// 검색어는 "제목", "가수", "가수 제목" 중 무엇이든 될 수 있어 모두 견줘 최고점을 쓴다.
function relevance(qNorm, title, artist) {
  const t = normalize(title);
  const a = normalize(artist);
  return Math.max(
    similarity(qNorm, t),
    similarity(qNorm, a) * 0.9,
    a && t ? similarity(qNorm, `${a} ${t}`) : 0,
    a && t ? similarity(qNorm, `${t} ${a}`) : 0
  );
}

// popularity는 0~1로 정규화된 인기도. 관련도가 비슷한 후보들 사이의 순서를 가른다.
function rankResults(items, q, { title, artist, popularity }) {
  const qNorm = normalize(q);
  const queryIsJapanese = JAPANESE_RE.test(q);
  const queryWantsJunk = JUNK_RE.test(q);

  const scored = items.map(item => {
    const t = title(item) || '';
    const a = artist(item) || '';
    // 관련도가 주(主), 인기도는 비슷한 후보들 사이에서 유명한 쪽을 끌어올리는 역할이다.
    let score = relevance(qNorm, t, a) + (popularity(item) || 0) * 0.45;
    // 걸러내지 않고 점수만 깎는다. 진짜 그것뿐인 검색어면 그대로 보여주는 게 맞다.
    if (!queryWantsJunk && JUNK_RE.test(`${t} ${a}`)) score -= 0.5;
    // 제목만 본다. Cloudflare 엣지가 일본을 경유하면 Deezer가 원곡의 가수 이름을
    // 일본어로 준다("Shape of You — エド・シーラン"). 그건 원곡이므로 감점하면 안 된다.
    if (!queryIsJapanese && JAPANESE_RE.test(t)) score -= 0.35;
    return { item, score };
  });
  scored.sort((x, y) => y.score - x.score);

  // 컴필레이션·재발매 탓에 같은 곡이 여러 번 나오므로 점수가 높은 쪽만 남긴다.
  const seen = new Set();
  const out = [];
  for (const { item } of scored) {
    const key = `${normalize(title(item))}|${normalize(artist(item))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function deezerSearch(q, entity, limit, debug) {
  const path = entity === 'album' ? 'search/album' : entity === 'musicArtist' ? 'search/artist' : 'search';
  const want = Number(limit) || 50;
  // 걸러내고 다시 정렬할 재료가 있어야 하므로 필요한 개수보다 넉넉히 받아온다.
  const dzUrl = `https://api.deezer.com/${path}?q=${encodeURIComponent(q)}&limit=${Math.min(want * 2, 100)}&order=RANKING`;

  let lastRaw = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(dzUrl, { headers: DEEZER_HEADERS });
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
          const ranked = rankResults(items, q, {
            title: it => it.title || it.name || '',
            artist: it => it.artist?.name || '',
            // 트랙의 rank는 0~약 100만, 가수의 nb_fan은 팬 수다.
            popularity: it => entity === 'musicArtist'
              ? Math.min((it.nb_fan || 0) / 5000000, 1)
              : Math.min((it.rank || 0) / 800000, 1),
          }).slice(0, want);
          const mapper = entity === 'album' ? mapDeezerAlbum : entity === 'musicArtist' ? mapDeezerArtist : mapDeezerTrack;
          return ranked.map(mapper);
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
      const q = (url.searchParams.get('q') || '').trim();
      const entity = url.searchParams.get('entity') || 'song';
      const country = url.searchParams.get('country') || 'KR';
      const limit = url.searchParams.get('limit') || '50';

      if (!q) {
        return new Response(JSON.stringify({ error: '검색어가 없습니다' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=${entity}&limit=${limit}&country=${country}`;
      // iTunes 결과가 가장 좋으므로 한 번 더 시도한다. Deezer는 지역에 따라 카탈로그가
      // 비거나 표기가 일본어로 오기 때문에 곧바로 넘어가면 검색 품질이 크게 떨어진다.
      const { data: appleData, error: appleError } = await fetchItunesJson(itunesUrl, 2);

      let data;
      const errs = [];
      if (!appleError && appleData?.results?.length) {
        data = { ...appleData, source: 'iTunes' };
      } else {
        appleError && errs.push(`iTunes: ${appleError}`);
        const debug = url.searchParams.get('debug') === '1';
        try {
          const results = await deezerSearch(q, entity, limit, debug);
          data = { resultCount: results.length, results, source: 'Deezer' };
        } catch (e) {
          errs.push(e.message);
          // debug 모드에서는 Deezer 응답을 그대로 봐야 하므로 폴백으로 넘어가지 않는다.
          if (debug) {
            return new Response(JSON.stringify({ error: e.message }), {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }
          try {
            const results = entity === 'musicArtist' ? await mbArtistSearch(q, limit)
              : entity === 'album' ? await mbAlbumSearch(q, limit)
              : await musicBrainzSearch(q, limit);
            data = { resultCount: results.length, results, source: 'MusicBrainz' };
          } catch (e2) {
            errs.push(`MusicBrainz: ${e2.message}`);
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

    // ── Deezer/MusicBrainz 출처 결과의 가수→앨범, 앨범→트랙 조회 (GET) ──
    const browseRoutes = {
      '/deezer-artist-albums': () => deezerArtistAlbums(url.searchParams.get('id')),
      '/deezer-album-tracks': () => deezerAlbumTracks(url.searchParams.get('id')),
      '/mb-artist-albums': () => mbArtistAlbums(url.searchParams.get('id')),
      '/mb-album-tracks': () => mbAlbumTracks(url.searchParams.get('id')),
    };
    if (browseRoutes[url.pathname]) {
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const results = await browseRoutes[url.pathname]();
        const response = new Response(JSON.stringify({ results }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=1800'
          }
        });
        if (results.length) ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
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

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: { message: '잘못된 요청 형식입니다' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 모델명이 그대로 URL 경로에 들어가므로 형식을 확인한다.
    if (!/^[\w.-]+$/.test(body.model || '')) {
      return new Response(JSON.stringify({ error: { message: '알 수 없는 모델입니다' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

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
