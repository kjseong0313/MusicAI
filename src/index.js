export default {
  async fetch(request, env) {
    // CORS 허용
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.json();
    const keys = [env.GEMINI_KEY1, env.GEMINI_KEY2].filter(Boolean);
    
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
        return new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch(e) { lastError = e.message; }
    }

    return new Response(JSON.stringify({ error: { message: '모든 키 한도 초과: ' + lastError } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
