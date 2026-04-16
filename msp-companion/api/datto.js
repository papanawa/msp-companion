export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-platform-url');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { path, method = 'GET' } = req.query;
    if (!path) { res.status(400).json({ error: 'Missing path' }); return; }

    const platformUrl = (req.headers['x-platform-url'] || 'https://concord-api.centrastage.net').replace(/\/$/, '');
    const authHeader  = req.headers['authorization'];
    const isAuth      = path.startsWith('/auth/');

    // Build the real Datto URL
    const dattoUrl = isAuth
      ? `${platformUrl}${path}`
      : `${platformUrl}/api/v2${path}`;

    const headers = {
      'Authorization': authHeader || '',
    };

    let body = undefined;
    if (method.toUpperCase() === 'POST') {
      if (isAuth) {
        // Auth requests need form-encoded body — read raw body
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        // Reconstruct body from req.body (Vercel parses it as object)
        if (req.body && typeof req.body === 'object') {
          body = new URLSearchParams(req.body).toString();
        } else if (typeof req.body === 'string') {
          body = req.body;
        }
      } else {
        headers['Content-Type'] = 'application/json';
        body = req.body ? JSON.stringify(req.body) : undefined;
      }
    }

    const response = await fetch(dattoUrl, {
      method: method.toUpperCase(),
      headers,
      body,
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
}
