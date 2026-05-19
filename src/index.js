export default {
  async fetch(request, env) {
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
    
    console.log('키 개수:', keys.length);
    console.log('모델:', body.model);
    
    if(keys.length === 0) {
      return new Response(JSON.stringify({ error: { message: '환경변수에 키가 없습니다' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    let lastError = '';
    for (const key of keys) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${key}`;
        console.log('시도 URL:', url.substring(0, 80));
        
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body.payload)
        });
        const data = await res.json();
        console.log('응답 status:', res.status, '에러:', data.error?.message);
        
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
        console.log('catch 에러:', e.message);
      }
    }

    return new Response(JSON.stringify({ error: { message: '실패: ' + lastError } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
