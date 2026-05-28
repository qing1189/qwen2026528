/**
 * 工具调用适配模块
 * 将 OpenAI 格式的 tool_calls 请求转换为 Qwen 可理解的 prompt，
 * 并从 Qwen 的文本响应中解析出 tool_calls 返回给客户端。
 *
 * 基于 DSML XML 协议格式，参考 Git-think/Qwen-Proxy 实现。
 */

const TC_OPEN = '<|DSML|tool_calls>';
const TC_CLOSE = '</|DSML|tool_calls>';

// ========== 请求侧：检测 & 注入 ==========

/**
 * 检测请求是否包含工具定义
 */
export function hasTools(reqBody) {
  return Array.isArray(reqBody?.tools) && reqBody.tools.length > 0;
}

/**
 * 构建工具 prompt（注入到 system message）
 */
export function buildToolPromptBlock(tools) {
  const toolList = tools || [];
  const decls = toolList.map(t => {
    const fn = t.function || t;
    const name = fn?.name || '';
    const desc = fn?.description || '';
    const params = fn?.parameters || fn?.input_schema;
    let paramsBlock = '{}';
    if (params) { try { paramsBlock = JSON.stringify(params); } catch {} }
    return `- ${name}: ${desc}\n  parameters: ${paramsBlock}`;
  }).join('\n');

  const namesList = toolList.map(t => ((t.function || t)?.name || '')).filter(Boolean);
  const namesLine = namesList.join(', ') || '(none)';

  return [
    `AVAILABLE TOOLS (all are real and callable): ${namesLine}`,
    '',
    'When you decide to call a tool, output the call EXACTLY in this format:',
    '',
    '<|DSML|tool_calls>',
    '  <|DSML|invoke name="TOOL_NAME">',
    '    <|DSML|parameter name="ARG_NAME"><![CDATA[ARG_VALUE]]></|DSML|parameter>',
    '  </|DSML|invoke>',
    '</|DSML|tool_calls>',
    '',
    'Rules:',
    '1. Wrap one or more <|DSML|invoke> in a single <|DSML|tool_calls> block.',
    '2. String parameters MUST use <![CDATA[...]]>.',
    '3. Numbers/booleans/null are plain text.',
    '4. Use only parameter names from the schemas below.',
    '5. Do NOT wrap in markdown fences. Do NOT explain after the block.',
    '6. If you call a tool, the block must be the last thing you output.',
    `7. EVERY tool listed above (${namesLine}) IS REAL and available. Do NOT refuse.`,
    '',
    'Tools available:',
    decls,
  ].join('\n');
}

/**
 * 序列化 assistant 的 tool_calls 为 DSML 格式（用于历史消息）
 */
export function serializeAssistantToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const blocks = [];
  for (const tc of toolCalls) {
    const fn = tc.function || tc;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    let args = fn?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch {}
    }
    blocks.push(renderInvoke(name, args));
  }
  if (blocks.length === 0) return '';
  return TC_OPEN + '\n' + blocks.join('\n') + '\n' + TC_CLOSE;
}

/**
 * 序列化 tool result 消息
 */
export function serializeToolResult(msg) {
  const id = msg?.tool_call_id || '';
  let content = msg?.content ?? '';
  if (typeof content !== 'string') {
    try { content = JSON.stringify(content); } catch { content = String(content); }
  }
  return `<|DSML|tool_result tool_use_id="${escapeAttr(id)}"><![CDATA[${escapeCDATA(content)}]]></|DSML|tool_result>`;
}

/**
 * 将带有 tools 的 OpenAI messages 转换为 Qwen 可处理的纯文本 messages
 */
export function injectToolCallContext(messages, tools) {
  const rewritten = (messages || []).map(m => {
    if (!m || typeof m !== 'object') return m;
    // assistant 带 tool_calls → 序列化为 DSML 追加到 content
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const dsml = serializeAssistantToolCalls(m.tool_calls);
      const baseText = typeof m.content === 'string' ? m.content : '';
      const merged = baseText ? baseText + '\n' + dsml : dsml;
      const out = { ...m, content: merged };
      delete out.tool_calls;
      return out;
    }
    // role:'tool' → 转为 user 消息
    if (m.role === 'tool') {
      return { role: 'user', content: serializeToolResult(m) };
    }
    return m;
  });
  const promptBlock = buildToolPromptBlock(tools);
  return [{ role: 'system', content: promptBlock }, ...rewritten];
}

// ========== 响应侧：解析 ==========

/**
 * 从非流式文本中解析 tool_calls
 */
export function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return { content: text || '', toolCalls: [] };
  const last = findLastClosedBlock(text);
  if (!last) return { content: text, toolCalls: [] };
  const block = text.slice(last.start, last.end);
  const calls = parseToolCallsBlock(block);
  if (calls.length === 0) return { content: text, toolCalls: [] };
  const content = text.slice(0, last.start).replace(/\s+$/, '');
  return { content, toolCalls: calls };
}

/**
 * 流式解析筛（sieve）— 用于流式响应中实时检测 tool_calls
 */
export function createSieve() {
  let buffer = '';
  let inside = false;
  let blockBuf = '';
  let nextIndex = 0;
  let finished = false;

  function push(chunk) {
    if (finished) return { textDelta: '', toolCallsDelta: null };
    if (!inside) {
      buffer += chunk;
      const idx = buffer.indexOf(TC_OPEN);
      if (idx >= 0) {
        const before = buffer.slice(0, idx);
        blockBuf = buffer.slice(idx + TC_OPEN.length);
        buffer = '';
        inside = true;
        const closed = flushBlock();
        return { textDelta: before, toolCallsDelta: closed };
      }
      // 检查部分匹配（跨 chunk 的情况）
      for (let n = TC_OPEN.length - 1; n > 0; n--) {
        if (buffer.endsWith(TC_OPEN.slice(0, n))) {
          const out = buffer.slice(0, buffer.length - n);
          buffer = buffer.slice(buffer.length - n);
          return { textDelta: out, toolCallsDelta: null };
        }
      }
      const out = buffer; buffer = '';
      return { textDelta: out, toolCallsDelta: null };
    }
    blockBuf += chunk;
    const closed = flushBlock();
    return { textDelta: '', toolCallsDelta: closed };
  }

  function flushBlock() {
    const idx = blockBuf.indexOf(TC_CLOSE);
    if (idx < 0) return null;
    const inner = blockBuf.slice(0, idx);
    finished = true;
    inside = false;
    blockBuf = '';
    const wrapped = TC_OPEN + inner + TC_CLOSE;
    const calls = parseToolCallsBlock(wrapped);
    if (calls.length === 0) return null;
    return calls.map(c => ({
      index: nextIndex++,
      id: c.id,
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments },
    }));
  }

  function flush() {
    if (finished) return { textDelta: '', toolCallsDelta: null };
    if (!inside && buffer) {
      const out = buffer; buffer = '';
      return { textDelta: out, toolCallsDelta: null };
    }
    if (inside && blockBuf) {
      const wrapped = TC_OPEN + blockBuf + TC_CLOSE;
      const calls = parseToolCallsBlock(wrapped);
      if (calls.length > 0) {
        finished = true; inside = false; blockBuf = '';
        return { textDelta: '', toolCallsDelta: calls.map(c => ({
          index: nextIndex++, id: c.id, type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        })) };
      }
      const out = TC_OPEN + blockBuf;
      blockBuf = ''; inside = false;
      return { textDelta: out, toolCallsDelta: null };
    }
    return { textDelta: '', toolCallsDelta: null };
  }

  return { push, flush };
}

// ========== 内部工具函数 ==========

function findLastClosedBlock(text) {
  let lastStart = -1, lastEnd = -1, cursor = 0;
  while (true) {
    const s = text.indexOf(TC_OPEN, cursor);
    if (s < 0) break;
    const e = text.indexOf(TC_CLOSE, s + TC_OPEN.length);
    if (e < 0) break;
    lastStart = s; lastEnd = e + TC_CLOSE.length; cursor = lastEnd;
  }
  if (lastStart < 0) return null;
  return { start: lastStart, end: lastEnd };
}

function parseToolCallsBlock(block) {
  let inner = block;
  if (inner.startsWith(TC_OPEN)) inner = inner.slice(TC_OPEN.length);
  if (inner.endsWith(TC_CLOSE)) inner = inner.slice(0, -TC_CLOSE.length);

  const calls = [];
  const invokeRe = /<\|DSML\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|invoke>/g;
  let m;
  while ((m = invokeRe.exec(inner)) !== null) {
    const name = m[1];
    const body = m[2];
    const params = parseParameters(body);
    calls.push({
      id: 'call_' + randomHex(),
      type: 'function',
      function: { name, arguments: JSON.stringify(params) },
    });
  }
  return calls;
}

function parseParameters(body) {
  const out = {};
  const paramRe = /<\|DSML\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|parameter>/g;
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    out[m[1]] = decodeParamValue(m[2]);
  }
  return out;
}

function decodeParamValue(raw) {
  const cdataMatch = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdataMatch) {
    const s = cdataMatch[1];
    try { return JSON.parse(s); } catch {}
    return s;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  return trimmed;
}

function renderInvoke(name, args) {
  const lines = [`  <|DSML|invoke name="${escapeAttr(name)}">`];
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of Object.keys(args)) {
      lines.push('    ' + renderParam(key, args[key]));
    }
  } else if (typeof args === 'string' && args.length > 0) {
    lines.push('    ' + renderParam('content', args));
  }
  lines.push('  </|DSML|invoke>');
  return lines.join('\n');
}

function renderParam(name, value) {
  if (value === null || value === undefined) {
    return `<|DSML|parameter name="${escapeAttr(name)}"></|DSML|parameter>`;
  }
  if (typeof value === 'string') {
    return `<|DSML|parameter name="${escapeAttr(name)}"><![CDATA[${escapeCDATA(value)}]]></|DSML|parameter>`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `<|DSML|parameter name="${escapeAttr(name)}">${String(value)}</|DSML|parameter>`;
  }
  let json = '{}';
  try { json = JSON.stringify(value); } catch {}
  return `<|DSML|parameter name="${escapeAttr(name)}"><![CDATA[${escapeCDATA(json)}]]></|DSML|parameter>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeCDATA(s) {
  return String(s).replace(/]]>/g, ']]]]><![CDATA[>');
}

function randomHex() {
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}
