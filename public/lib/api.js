export async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('O servidor não respondeu. Tente novamente.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'O servidor não respondeu.'), { status: response.status });
  return data;
}
