// MSP Companion — Anthropic Claude API module
// Single export: callAI(systemPrompt, messages) → string
// Call init(getSettings) once at boot before using callAI.

let _getSettings;

export function init(getSettings) { _getSettings = getSettings; }

export async function callAI(systemPrompt, messages) {
  const key = _getSettings().anthropicKey;
  if (!key) throw new Error('Anthropic API key not configured. Go to Settings.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true' },
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1024, system:systemPrompt, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`AI API ${res.status}: ${data?.error?.message||'Unknown error'}`);
  return data.content?.find(b=>b.type==='text')?.text || 'No response received.';
}
