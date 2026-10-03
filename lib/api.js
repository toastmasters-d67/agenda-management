'use client';

// Shared fetch helper for calling the backend through the same-origin
// /svc/* proxy (see app/svc/**). The proxy reads the httpOnly auth cookie
// and attaches it as a Bearer token to the real FastAPI backend, so callers
// here never need to know about tokens — just `credentials: 'include'`.

async function request(path, { method = 'GET', body, headers, ...rest } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const finalHeaders = { ...headers };
  let finalBody = body;
  if (body !== undefined && !isFormData) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }
  return fetch(`/svc${path}`, {
    method,
    headers: finalHeaders,
    body: finalBody,
    credentials: 'include',
    ...rest,
  });
}

// Raw Response, for callers that need status codes / blobs / streaming.
export function apiFetch(path, options) {
  return request(path, options);
}

// Parses JSON and throws with the backend's error detail on non-2xx.
export async function apiJson(path, options) {
  const res = await request(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no JSON body (e.g. 204)
  }
  if (!res.ok) {
    throw new Error((data && (data.detail || data.message)) || `Request failed (${res.status})`);
  }
  return data;
}
