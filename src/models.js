import { requestHeaders } from './headers.js';

const BASE_URL = 'https://chat.qwen.ai';
let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function fetchModels(token) {
  const res = await fetch(`${BASE_URL}/api/models`, {
    headers: {
      'authorization': `Bearer ${token}`,
      ...requestHeaders(),
    },
  });
  const json = await res.json();
  return json.data || [];
}

export async function getModels(token) {
  if (cachedModels && Date.now() - cacheTime < CACHE_TTL) return cachedModels;
  cachedModels = await fetchModels(token);
  cacheTime = Date.now();
  return cachedModels;
}

export function clearModelCache() {
  cachedModels = null;
  cacheTime = 0;
}

export function handleOpenAIModels(modelList) {
  const variants = [];

  for (const m of modelList) {
    const meta = m.info?.meta || {};
    const caps = meta.capabilities || {};
    const chatTypes = meta.chat_type || [];

    const has = {
      vision: !!caps.vision,
      thinking: !!caps.thinking,
      search: !!caps.search,
      deep_research: chatTypes.includes('deep_research'),
      image_gen: chatTypes.includes('t2i'),
      video_gen: chatTypes.includes('t2v'),
      web_dev: chatTypes.includes('web_dev'),
      slides: chatTypes.includes('slides'),
    };

    const base = { object: 'model', created: 1700000000, owned_by: 'qwen', capabilities: has };

    // Base model
    variants.push({ id: m.id, ...base });

    // Suffixed variants based on capabilities
    if (has.thinking)       variants.push({ id: m.id + '-thinking', ...base });
    if (has.deep_research)  variants.push({ id: m.id + '-deep-research', ...base });
    if (has.image_gen)      variants.push({ id: m.id + '-image', ...base });
    if (has.video_gen)      variants.push({ id: m.id + '-video', ...base });
    if (has.web_dev)        variants.push({ id: m.id + '-webdev', ...base });
    if (has.slides)         variants.push({ id: m.id + '-slides', ...base });
  }

  return { object: 'list', data: variants };
}
