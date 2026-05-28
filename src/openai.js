import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { hasTools, injectToolCallContext, buildToolHint, detectToolIntent, parseToolCallsFromText, createSieve } from './toolcall.js';

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

  // 工具调用支持：两阶段方案
  // 第一阶段：只带轻量 hint（工具名称），降低特征
  // 第二阶段：如果模型暗示需要调用工具，再发一次带完整 DSML schema 的请求
  const toolcallEnabled = hasTools(req.body);
  let processedMessages = messages;
  if (toolcallEnabled) {
    // 第一阶段：注入轻量 hint 而非完整 schema
    processedMessages = buildToolHint(messages, req.body.tools);
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

      // 工具调用解析 — 两阶段
      if (toolcallEnabled && fullContent) {
        // 先检查第一阶段回复中是否已经包含 DSML tool_calls（模型自发输出）
        const parsed = parseToolCallsFromText(fullContent);
        if (parsed.toolCalls.length > 0) {
          message.content = parsed.content;
          message.tool_calls = parsed.toolCalls;
          finishReason = 'tool_calls';
        } else if (detectToolIntent(fullContent, req.body.tools)) {
          // 第二阶段：模型暗示要调用工具，发送带完整 DSML schema 的跟进请求
          slot.release();
          dispatchQueued();

          const followupMessages = injectToolCallContext(
            [...messages, { role: 'assistant', content: fullContent }],
            req.body.tools
          );
          // 追加指令让模型输出结构化调用
          followupMessages.push({
            role: 'user',
            content: 'Please proceed with the tool call using the exact DSML format specified above.',
          });

          const followupQwenMessages = buildQwenMessages(followupMessages, chatMode);

          try {
            const slot2 = await enqueueRequest();
            try {
              const result2 = await completion({
                token: slot2.token,
                model: baseModel,
                messages: followupQwenMessages,
                chatMode,
                thinkingEnabled,
                searchEnabled,
              });

              let phase2Content = '';
              for await (const ev of parseSSEStream(result2.body)) {
                if (ev.type === 'content') phase2Content += ev.content;
                if (ev.type === 'done') usage = ev.usage || usage;
              }

              const parsed2 = parseToolCallsFromText(phase2Content);
              if (parsed2.toolCalls.length > 0) {
                message.content = parsed2.content || fullContent;
                message.tool_calls = parsed2.toolCalls;
                finishReason = 'tool_calls';
              }
            } finally {
              slot2.release();
              dispatchQueued();
            }
          } catch (err) {
            console.error('Phase 2 tool call error:', err.message);
            // 第二阶段失败，返回第一阶段的原始回复
          }

          // 已经手动释放了 slot，跳过 finally 中的释放
          const response = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: usage?.input_tokens || 0, completion_tokens: usage?.output_tokens || 0, total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0) },
          };
          return res.json(response);
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
