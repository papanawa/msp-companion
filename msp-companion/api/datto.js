// api/datto.js — Vercel serverless function
// Proxies requests to Datto RMM API to bypass browser CORS restrictions

export default async function handler(req, res) {
  // CORS headers — allow our PWA to call this proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    // Get the Authorization header from the request (Bearer token or Basic auth)
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    // Get platform URL from header
    const platformUrl = (req.headers['x-platform-url'] || 'https://concord-api.centrastage.net').replace(/\/$/, '');

    // Build the Datto API URL
    const dattoUrl = path.startsWith('/auth/')
      ? `${platformUrl}${path}`
      : `${platformUrl}/api/v2${path}`;

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    // Pass body for POST requests (auth token request)
    if (req.method === 'POST' && req.body) {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      fetchOptions.body = body;
      fetchOptions.headers['Content-Type'] = path.startsWith('/auth/')
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const response = await fetch(dattoUrl, fetchOptions);
    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
