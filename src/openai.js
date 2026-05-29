import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { hasTools, injectToolCallContext, buildToolHint, detectToolIntent, parseToolCallsFromText } from './toolcall.js';

const MODE_SUFFIXES = {
  '-thinking':       { chatMode: 't2t', forceThinking: true },
  '-deep-research':  { chatMode: 'deep_research' },
  '-image':          { chatMode: 't2i' },
  '-t2i':            { chatMode: 't2i' },
  '-video':          { chatMode: 't2v' },
  '-t2v':            { chatMode: 't2v' },
  '-webdev':         { chatMode: 'web_dev' },
  '-web-dev':        { chatMode: 'web_dev' },
  '-slides':         { chatMode: 'slides' },
};

function parseModelSuffix(model) {
  for (const [suffix, config] of Object.entries(MODE_SUFFIXES)) {
    if (model.endsWith(suffix)) {
      return { baseModel: model.slice(0, -suffix.length), chatMode: config.chatMode, forceThinking: config.forceThinking || false };
    }
  }
  return { baseModel: model, chatMode: 't2t', forceThinking: false };
}

function isThinkingEnabled(model, forceThinking, enableThinking) {
  return forceThinking || enableThinking || false;
}

function isSearchEnabled(chatMode, enableSearch) {
  return enableSearch || chatMode === 'deep_research';
}

function buildQwenMessages(messages, chatMode) {
  const last = messages[messages.length - 1] || { role: 'user', content: '' };
  if (messages.length <= 1) {
    return [{ role: 'user', content: last.role === 'user' ? extractText(last.content) : `${last.role}:${extractText(last.content)}` }];
  }
  const history = messages.slice(0, -1).map(m => `${m.role}:${extractText(m.content)}`).join(';');
  return [{ role: 'user', content: `${history};${last.role}:${extractText(last.content)}` }];
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  return '';
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false } = req.body;
  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const { baseModel, chatMode, forceThinking } = parseModelSuffix(model);
  const thinkingEnabled = isThinkingEnabled(model, forceThinking, req.body.enable_thinking);
  const searchEnabled = isSearchEnabled(chatMode, req.body.enable_search);
  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 工具调用两阶段：有 tools 时只注入轻量 hint
  const toolcallEnabled = hasTools(req.body);
  let processedMessages = messages;
  if (toolcallEnabled) {
    processedMessages = buildToolHint(messages, req.body.tools);
  }

  const qwenMessages = buildQwenMessages(processedMessages, chatMode);
  let result;

  try {
    const slot = await enqueueRequest();
    try {
      result = await completion({ token: slot.token, model: baseModel, messages: qwenMessages, chatMode, thinkingEnabled, searchEnabled });
      result.slot = slot;
    } catch (err) {
      slot.release(); dispatchQueued();
      return res.status(500).json({ error: { message: err.message } });
    }
  } catch (err) {
    return res.status(503).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  try {
    // ===== 有 tools 的请求：服务端缓冲，不直接流给客户端 =====
    if (toolcallEnabled) {
      let fullContent = '';
      let fullThinking = '';
      let usage = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content' || event.type === 'image') fullContent += event.content;
        else if (event.type === 'thinking' || event.type === 'research') fullThinking += (event.type === 'research' ? `[${event.stage}] ` : '') + event.content;
        else if (event.type === 'done') usage = event.usage;
      }
      slot.release(); dispatchQueued();

      let finalContent = fullContent;
      let toolCalls = [];
      let finishReason = 'stop';

      // 检查第一阶段是否已包含 DSML tool_calls
      const parsed = parseToolCallsFromText(fullContent);
      if (parsed.toolCalls.length > 0) {
        finalContent = parsed.content;
        toolCalls = parsed.toolCalls;
        finishReason = 'tool_calls';
      } else if (detectToolIntent(fullContent, req.body.tools)) {
        // 第二阶段：注入完整 DSML schema
        const followupMessages = injectToolCallContext(
          [...messages, { role: 'assistant', content: fullContent }],
          req.body.tools
        );
        followupMessages.push({ role: 'user', content: 'Please proceed with the tool call using the exact DSML format specified above. Output ONLY the tool call block, nothing else.' });

        const followupQwenMessages = buildQwenMessages(followupMessages, chatMode);
        try {
          const slot2 = await enqueueRequest();
          try {
            const result2 = await completion({ token: slot2.token, model: baseModel, messages: followupQwenMessages, chatMode, thinkingEnabled, searchEnabled });
            let phase2Content = '';
            for await (const ev of parseSSEStream(result2.body)) {
              if (ev.type === 'content') phase2Content += ev.content;
              if (ev.type === 'done') usage = ev.usage || usage;
            }
            const parsed2 = parseToolCallsFromText(phase2Content);
            if (parsed2.toolCalls.length > 0) {
              finalContent = '';
              toolCalls = parsed2.toolCalls;
              finishReason = 'tool_calls';
            }
          } finally { slot2.release(); dispatchQueued(); }
        } catch (err) { console.error('Phase 2 tool call error:', err.message); }
      }

      // 统一输出给客户端（stream 或 non-stream）
      const message = { role: 'assistant', content: finalContent, ...(fullThinking ? { reasoning_content: fullThinking } : {}), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };

      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        if (finalContent) res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }] })}\n\n`);
        if (fullThinking) res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: fullThinking }, finish_reason: null }] })}\n\n`);
        if (toolCalls.length > 0) {
          const deltas = toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usage ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) } : undefined })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json({ id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: usage?.input_tokens || 0, completion_tokens: usage?.output_tokens || 0, total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0) } });
      }
      return;
    }

    // ===== 普通请求（无 tools）=====
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content') {
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }] })}\n\n`);
        } else if (event.type === 'thinking') {
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }] })}\n\n`);
        } else if (event.type === 'image') {
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }] })}\n\n`);
        } else if (event.type === 'research') {
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: `[${event.stage}] ${event.content}` }, finish_reason: null }] })}\n\n`);
        } else if (event.type === 'done') {
          res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: event.usage ? { prompt_tokens: event.usage.input_tokens || 0, completion_tokens: event.usage.output_tokens || 0, total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0) } : undefined })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
      }
      res.end();
    } else {
      let fullContent = '', fullThinking = '', usage = null;
      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content' || event.type === 'image') fullContent += event.content;
        else if (event.type === 'thinking' || event.type === 'research') fullThinking += (event.type === 'research' ? `[${event.stage}] ` : '') + event.content;
        else if (event.type === 'done') usage = event.usage;
      }
      res.json({ id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: fullContent, ...(fullThinking ? { reasoning_content: fullThinking } : {}) }, finish_reason: 'stop' }], usage: { prompt_tokens: usage?.input_tokens || 0, completion_tokens: usage?.output_tokens || 0, total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0) } });
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  } finally {
    slot.release(); dispatchQueued();
  }
}
