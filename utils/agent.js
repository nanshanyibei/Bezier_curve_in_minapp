/**
 * Agent 循环（与载体无关）
 *
 * 职责：调模型 → 模型要工具就执行 → 结果回灌 → 继续，直到模型给出最终回答。
 * 工具在客户端执行（见 agentTools），模型调用由外部注入 callModel，方便将来
 * 换成云托管 / 本地 server 而不动这里。
 *
 * 兜底：如果服务端发现模型不支持原生 function calling，会返回 toolsUnsupported，
 * 这里自动切换到「JSON 协议」——让模型只输出 {"tool":"...","args":{...}}。
 */
const agentTools = require('./agentTools');

const MAX_ROUNDS = 3;       // 最多 3 轮工具调用，防云函数 60s 超时
const TOOL_TIMEOUT = 8000;  // 单个工具执行上限
const MAX_CALLS_PER_ROUND = 6;

const JSON_PROTOCOL = [
  '【工具调用协议】当前模型不支持原生 function calling，请用 JSON 表达工具调用。',
  '可用工具：',
  '1. searchAttractions {"keyword":"关键词","province":"省名或adcode","city":"城市","limit":8} — 查5A景区',
  '2. getFootprint {"status":"visited|want|all","province":"省名","includeMemories":true} — 查旅行足迹',
  '3. getWardrobe {"category":"top|bottom|outer|shoes|bag|accessory","season":"all|spring|summer|autumn|winter","limit":20} — 查电子衣橱',
  '4. saveDiaryDraft {"date":"YYYY-MM-DD","text":"日记正文"} — 生成日记草稿（不会直接保存）',
  '需要调用工具时，只输出一个 JSON 对象：{"tool":"工具名","args":{...}}，不要输出解释或其他文字。',
  '工具结果会以【工具结果 工具名】开头的用户消息返回。不需要工具时直接用中文回答。'
].join('\n');

/** 解析模型给出的参数；容忍 ```json 包裹与前后废话 */
function safeParse(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch (e) { /* 继续尝试 */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch (e2) { /* ignore */ }
  }
  const l = text.indexOf('{');
  const r = text.lastIndexOf('}');
  if (l >= 0 && r > l) {
    try { return JSON.parse(text.slice(l, r + 1)); } catch (e3) { /* ignore */ }
  }
  return {};
}

/** JSON 协议模式下从模型正文里提取动作 */
function parseJsonAction(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(raw))) candidates.push(m[1]);
  candidates.push(raw);
  const l = raw.indexOf('{');
  const r = raw.lastIndexOf('}');
  if (l >= 0 && r > l) candidates.push(raw.slice(l, r + 1));

  for (let i = 0; i < candidates.length; i++) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && typeof obj.tool === 'string' && obj.tool) {
        return {
          tool: obj.tool,
          args: obj.args && typeof obj.args === 'object' ? obj.args : {}
        };
      }
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 把 JSON 协议说明拼进 system prompt（复制一份，不改原数组） */
function withJsonProtocol(messages) {
  const out = messages.slice();
  const idx = out.findIndex(function (m) { return m.role === 'system'; });
  if (idx >= 0) {
    out[idx] = Object.assign({}, out[idx], {
      content: out[idx].content + '\n\n' + JSON_PROTOCOL
    });
  } else {
    out.unshift({ role: 'system', content: JSON_PROTOCOL });
  }
  return out;
}

function normalizeCalls(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_CALLS_PER_ROUND).map(function (c, i) {
    return {
      id: String((c && c.id) || ('call_' + i)),
      name: String((c && c.name) || ''),
      arguments: typeof (c && c.arguments) === 'string'
        ? c.arguments
        : JSON.stringify((c && c.arguments) || {})
    };
  }).filter(function (c) { return !!c.name; });
}

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error(label + ' 执行超时'));
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * 运行 Agent
 * @param {object} opts
 * @param {Array}  opts.messages     初始上下文（system + 历史 + 本次提问）
 * @param {Function} opts.callModel  ({ messages, tools }) => Promise<{ content, toolCalls, toolsUnsupported }>
 * @param {Function} [opts.onToolStart] ({ id, name, label, args }) => void
 * @param {Function} [opts.onToolEnd]   ({ id, name, ok, summary, result, error }) => void
 * @param {Function} [opts.isCancelled] () => boolean
 * @param {number} [opts.maxRounds]
 * @returns {Promise<{ content, reasoning, messages, rounds, cancelled, exhausted }>}
 */
function runAgent(opts) {
  const callModel = opts.callModel;
  const onToolStart = opts.onToolStart || function () {};
  const onToolEnd = opts.onToolEnd || function () {};
  const isCancelled = opts.isCancelled || function () { return false; };
  const maxRounds = opts.maxRounds || MAX_ROUNDS;
  const messages = (opts.messages || []).slice();

  let useJson = false;
  let round = 0;

  function finish(content, extra) {
    return Object.assign({
      content: content || '',
      reasoning: '',
      messages: messages,
      rounds: round
    }, extra || {});
  }

  function runCalls(calls) {
    return calls.reduce(function (p, call) {
      return p.then(function () {
        if (isCancelled()) return null;
        const args = safeParse(call.arguments);
        onToolStart({
          id: call.id,
          name: call.name,
          label: agentTools.toolLabel(call.name),
          args: args
        });
        return withTimeout(
          Promise.resolve().then(function () { return agentTools.runTool(call.name, args); }),
          TOOL_TIMEOUT,
          agentTools.toolLabel(call.name)
        ).then(function (result) {
          onToolEnd({
            id: call.id,
            name: call.name,
            ok: true,
            summary: agentTools.summarize(call.name, result),
            result: result
          });
          messages.push(toolResultMessage(call, result, useJson));
        }, function (err) {
          const msg = (err && err.message) || '工具执行失败';
          onToolEnd({ id: call.id, name: call.name, ok: false, summary: msg, error: msg });
          messages.push(toolResultMessage(call, { error: msg }, useJson));
        });
      });
    }, Promise.resolve());
  }

  function toolResultMessage(call, result, jsonMode) {
    const body = agentTools.serializeResult(result);
    if (jsonMode) {
      return {
        role: 'user',
        content: '【工具结果 ' + call.name + '】\n' + body +
          '\n\n请基于结果继续。需要再调用工具时，只输出 {"tool":"...","args":{...}} 这一个 JSON；否则直接回答用户。'
      };
    }
    return { role: 'tool', tool_call_id: call.id, content: body };
  }

  function next() {
    if (isCancelled()) return Promise.resolve(finish('', { cancelled: true }));
    if (round >= maxRounds) {
      return Promise.resolve(finish(
        '这个任务需要的步骤有点多，我先停在这里。你可以补充一个关键信息，或者把任务拆成两步再问我。',
        { exhausted: true }
      ));
    }
    round++;

    const req = {
      messages: useJson ? withJsonProtocol(messages) : messages,
      tools: useJson ? null : agentTools.TOOL_SCHEMAS
    };

    return Promise.resolve(callModel(req)).then(function (res) {
      const r = res || {};

      // 模型不支持原生工具调用：切到 JSON 协议重来一轮（不消耗轮次）
      if (r.toolsUnsupported && !useJson) {
        useJson = true;
        round--;
        return next();
      }

      let calls = [];
      let content = r.content || '';
      let rawContent = '';

      if (useJson) {
        const action = parseJsonAction(content);
        if (action) {
          calls = [{
            id: 'json_' + round + '_' + Date.now(),
            name: action.tool,
            arguments: JSON.stringify(action.args || {})
          }];
          rawContent = content;
          content = '';
        }
      } else {
        calls = normalizeCalls(r.toolCalls);
      }

      if (!calls.length) {
        return finish(content, { reasoning: r.reasoning || '' });
      }

      // 记录 assistant 这一轮的动作，供下一轮回灌
      if (useJson) {
        messages.push({ role: 'assistant', content: rawContent });
      } else {
        messages.push({
          role: 'assistant',
          content: content || '',
          tool_calls: calls.map(function (c) {
            return {
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments }
            };
          })
        });
      }

      return runCalls(calls).then(next);
    });
  }

  return next();
}

module.exports = { runAgent: runAgent };
