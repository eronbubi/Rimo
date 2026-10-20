// Hugging Face Hub client: search GGUF repos, list a repo's files and fetch its model card.
const { groupVariants } = require('./quant');

const HF = 'https://huggingface.co';
const HEADERS = { 'User-Agent': 'Rimo/1.0 (+desktop app)' };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SORTS = new Set(['downloads', 'likes', 'trendingScore', 'lastModified', 'createdAt']);
const SEARCH_FIELDS = ['downloads', 'likes', 'lastModified', 'pipeline_tag', 'tags', 'gated'];

async function get(url, { json = true, allow404 = false } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error('Hugging Face ist nicht erreichbar. Bist du online?');
  }
  if (allow404 && (res.status === 404 || res.status === 401 || res.status === 403)) return { res, body: null };
  if (res.status === 404) throw new Error('Dieses Modell gibt es auf Hugging Face nicht.');
  if (res.status === 429) throw new Error('Hugging Face bremst gerade (zu viele Anfragen). Bitte kurz warten.');
  if (!res.ok) throw new Error(`Hugging Face antwortet mit Fehler ${res.status}.`);
  return { res, body: json ? await res.json() : await res.text() };
}

function nextCursor(res) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
  return m ? new URL(m[1]).searchParams.get('cursor') : null;
}

function tagValue(tags, prefix) {
  const t = (tags || []).find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
}

function summary(m) {
  const [author, name] = m.id.split('/');
  return {
    id: m.id,
    author,
    name,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    lastModified: m.lastModified || null,
    pipeline: m.pipeline_tag || null,
    gated: !!m.gated,
    license: tagValue(m.tags, 'license:'),
    baseModel: tagValue(m.tags, 'base_model:quantized:') || tagValue(m.tags, 'base_model:'),
  };
}

async function search({ query = '', sort = 'downloads', cursor = null } = {}) {
  const p = new URLSearchParams({ filter: 'gguf', sort: SORTS.has(sort) ? sort : 'downloads', direction: '-1', limit: '30' });
  if (query.trim()) p.set('search', query.trim());
  for (const f of SEARCH_FIELDS) p.append('expand[]', f);
  if (cursor) p.set('cursor', cursor);
  const { res, body } = await get(`${HF}/api/models?${p}`);
  return { items: body.map(summary), cursor: nextCursor(res) };
}

// Accepts "user/repo", "https://huggingface.co/user/repo/…" or "hf.co/user/repo:Q4_K_M".
function parseRepo(input) {
  const s = String(input || '').trim().replace(/^https?:\/\//, '').replace(/^(www\.)?(huggingface\.co|hf\.co)\//, '');
  const [user, repo] = s.split(/[/?#]/);
  const id = repo ? `${user}/${repo.split(':')[0]}` : '';
  return REPO_RE.test(id) ? id : null;
}

async function listFiles(id) {
  const files = [];
  let url = `${HF}/api/models/${id}/tree/main?recursive=true`;
  for (let page = 0; url && page < 10; page++) {
    const { res, body } = await get(url);
    files.push(...body);
    const cursor = nextCursor(res);
    url = cursor ? `${HF}/api/models/${id}/tree/main?recursive=true&cursor=${encodeURIComponent(cursor)}` : null;
  }
  return files;
}

async function readme(id) {
  const { body } = await get(`${HF}/${id}/raw/main/README.md`, { json: false, allow404: true });
  return body ? body.slice(0, 200000) : '';
}

async function model(id) {
  if (!REPO_RE.test(id)) throw new Error('Ungültiger Modellname. Format: autor/modell');
  const fields = ['gguf', 'cardData', 'gated', 'downloads', 'likes', 'tags', 'lastModified', 'pipeline_tag'];
  const q = fields.map((f) => `expand[]=${f}`).join('&');
  const [{ body: info }, files, card] = await Promise.all([get(`${HF}/api/models/${id}?${q}`), listFiles(id), readme(id)]);
  const gguf = info.gguf || {};
  return {
    ...summary(info),
    params: gguf.total || null,
    architecture: gguf.architecture || null,
    contextLength: gguf.context_length || null,
    variants: groupVariants(files),
    readme: card,
  };
}

module.exports = { search, model, parseRepo };
