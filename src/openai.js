import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { getModels } from './models.js';
import { hasTools, injectToolCallContext, parseToolCallsFromText, createSieve } from './toolcall.js';

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
      const baseModel = model.slice(0, -suffix.length);
      return { baseModel, chatMode: config.chatMode, forceThinking: config.forceThinking || false };
    }
  }
  return { baseModel: model, chatMode: 't2t', forceThinking: false };
}

function isThinkingEnabled(model, forceThinking, enableThinking) {
  if (forceThinking) return true;
  if (enableThinking) return true;
  return false;
}

function isSearchEnabled(chatMode, enableSearch) {
  if (enableSearch) return true;
  if (chatMode === 'deep_research') return true;
  return false;
}

function buildQwenMessages(messages, chatMode) {
  const last = messages[messages.length - 1] || { role: 'user', content: '' };

  if (messages.length <= 1) {
    const msg = last;
    return [{
      role: 'user',
      content: msg.role === 'user'
        ? (typeof msg.content === 'string' ? msg.content : extractText(msg.content))
        : `${msg.role}:${typeof msg.content === 'string' ? msg.content : extractText(msg.content)}`,
    }];
  }

  const history = messages.slice(0, -1);
  const historyParts = history.map(m => {
    const text = typeof m.content === 'string' ? m.content : extractText(m.content);
    return `${m.role}:${text}`;
  }).join(';');

  const lastText = typeof last.content === 'string' ? last.content : extractText(last.content);
  const combinedText = historyParts ? `${historyParts};${last.role}:${lastText}` : `${last.role}:${lastText}`;

  return [{ role: 'user', content: combinedText }];
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  }
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

  // 工具调用支持：如果请求带有 tools，注入工具上下文
  const toolcallEnabled = hasTools(req.body);
  let processedMessages = messages;
  if (toolcallEnabled) {
    processedMessages = injectToolCallContext(messages, req.body.tools);
  }

  const qwenMessages = buildQwenMessages(processedMessages, chatMode);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result;

  try {
    const slot = await enqueueRequest();

    try {
      result = await completion({
        token: slot.token,
        model: baseModel,
        messages: qwenMessages,
        chatMode,
        thinkingEnabled,
        searchEnabled,
      });
      result.slot = slot;
    } catch (err) {
      slot.release();
      dispatchQueued();
      console.error('Completion error:', err.message);
      return res.status(500).json({ error: { message: err.message } });
    }
  } catch (err) {
    return res.status(503).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      res.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      const sieve = toolcallEnabled ? createSieve() : null;
      let toolCallsEmitted = false;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content') {
          if (sieve) {
            const out = sieve.push(event.content);
            if (out.textDelta) {
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { content: out.textDelta }, finish_reason: null }],
              })}\n\n`);
            }
            if (out.toolCallsDelta) {
              toolCallsEmitted = true;
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { tool_calls: out.toolCallsDelta }, finish_reason: null }],
              })}\n\n`);
            }
          } else {
            res.write(`data: ${JSON.stringify({
              id: requestId, object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (event.type === 'thinking') {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'image') {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'research') {
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { reasoning_content: `[${event.stage}] ${event.content}` }, finish_reason: null }],
          })}\n\n`);
        } else if (event.type === 'done') {
          // flush sieve
          if (sieve) {
            const out = sieve.flush();
            if (out.textDelta) {
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { content: out.textDelta }, finish_reason: null }],
              })}\n\n`);
            }
            if (out.toolCallsDelta) {
              toolCallsEmitted = true;
              res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { tool_calls: out.toolCallsDelta }, finish_reason: null }],
              })}\n\n`);
            }
          }

          const finishReason = toolCallsEmitted ? 'tool_calls' : 'stop';
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: event.usage ? {
              prompt_tokens: event.usage.input_tokens || 0,
              completion_tokens: event.usage.output_tokens || 0,
              total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
            } : undefined,
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
      }
      res.end();
    } else {
      let fullContent = '';
      let fullThinking = '';
      let usage = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (event.type === 'content' || event.type === 'image') {
          fullContent += event.content;
        } else if (event.type === 'thinking' || event.type === 'research') {
          const prefix = event.type === 'research' ? `[${event.stage}] ` : '';
          fullThinking += prefix + event.content;
        } else if (event.type === 'done') {
          usage = event.usage;
        }
      }

      const message = {
        role: 'assistant',
        content: fullContent,
        ...(fullThinking ? { reasoning_content: fullThinking } : {}),
      };

      let finishReason = 'stop';

      // 工具调用解析
      if (toolcallEnabled && fullContent) {
        const parsed = parseToolCallsFromText(fullContent);
        if (parsed.toolCalls.length > 0) {
          message.content = parsed.content;
          message.tool_calls = parsed.toolCalls;
          finishReason = 'tool_calls';
        }
      }

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason,
        }],
        usage: {
          prompt_tokens: usage?.input_tokens || 0,
          completion_tokens: usage?.output_tokens || 0,
          total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        },
      };
      res.json(response);
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    slot.release();
    dispatchQueued();
  }
}
