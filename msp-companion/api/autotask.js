// api/autotask.js — Vercel serverless function
// Proxies requests to Autotask PSA API to bypass browser CORS restrictions

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, UserName, Secret, ApiIntegrationCode, x-at-zone');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { path, method = 'GET' } = req.query;

    if (!path) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const zone   = req.headers['x-at-zone'] || '14';
    const atBase = `https://webservices${zone}.autotask.net/atservicesrest/v1.0`;
    const atUrl  = `${atBase}${path}`;

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'UserName':           req.headers['username']           || '',
        'Secret':             req.headers['secret']             || '',
        'ApiIntegrationCode': req.headers['apiintegrationcode'] || '',
      },
    };

    if (['POST', 'PATCH'].includes(req.method) && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(atUrl, fetchOptions);
    const text = await response.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
