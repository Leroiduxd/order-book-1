import 'dotenv/config';

const ENDPOINT = process.env.ENDPOINT?.replace(/\/+$/, '');
if (!ENDPOINT) throw new Error('ENDPOINT manquant dans .env (ex: http://127.0.0.1:9304)');

const json = (x) => JSON.stringify(x);
const ok = (res) => {
  if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
  return res;
};

export async function get(pathWithQuery, { headers = {} } = {}) {
  const res = await fetch(`${ENDPOINT}/${pathWithQuery}`, { headers });
  if (!res.ok) throw new Error(`GET ${pathWithQuery} -> HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

export async function postArray(pathWithQuery, arr, { headers = {} } = {}) {
  const res = await fetch(`${ENDPOINT}/${pathWithQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal, resolution=ignore-duplicates',
      ...headers
    },
    body: json(arr)
  });
  return ok(res);
}

export async function patch(pathWithQuery, body, { headers = {} } = {}) {
  const res = await fetch(`${ENDPOINT}/${pathWithQuery}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...headers
    },
    body: json(body)
  });
  return ok(res);
}

export async function del(pathWithQuery, { headers = {} } = {}) {
  const res = await fetch(`${ENDPOINT}/${pathWithQuery}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal', ...headers }
  });
  return ok(res);
}
