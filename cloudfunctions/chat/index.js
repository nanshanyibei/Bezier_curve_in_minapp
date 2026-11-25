/**
 * 云函数 chat：AI 助手代理（2026-11，替代客户端直连硅基流动）
 *
 * 动机：
 *   1. 消除 request 合法域名限制 —— wx.cloud.callFunction 免域名免备案；
 *   2. LLM Key 不下发到客户端 —— 只存在云函数环境变量 SILICONFLOW_KEY。
 *
 * 入参（wx.cloud.callFunction）：
 *   { messages, tools?, model?, temperature?, maxTokens?, apiKey? }
 *   messages: OpenAI 兼容格式，支持 system / user / assistant / tool
 *             （assistant 可带 tool_calls，tool 需带 tool_call_id）
 *   tools:    可选，原生 function calling 的工具 schema；不传就是普通对话
 *   apiKey:   可选，「我的」页统一设置的本机 Key（仅开发调试用），未传回退环境变量
 *
 * 出参：{ code, msg?, content, reasoning, toolCalls, toolsUnsupported, usage }
 *   content:         assistant 正文
 *   reasoning:       思考过程（DeepSeek-R 系列才有，普通模型为空串）
 *   toolCalls:       [{ id, name, arguments }]，arguments 为 JSON 字符串
 *   toolsUnsupported:模型不支持 tools，已自动去掉工具重试；客户端应切到 JSON 协议
 *
 * 非流式返回：小程序端用打字机泵逐步上屏，观感接近流式。
 * ⚠️ config.json 已配 timeout 55s：长回复可达 30~50s，默认 3s 会稳定超时。
 */
const LLM_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = process.env.SILICONFLOW_CHAT_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';

const MAX_MESSAGES = 60;     // 上下文条数上限
const MAX_CHARS = 8000;      // 单条消息字符上限（防滥用/防注入超长文本）
const MAX_TOOLS = 8;         // 工具数量上限
const MAX_TOOL_CALLS = 8;    // 单轮工具调用上限
const ALLOWED_ROLES = { system: 1, user: 1, assistant: 1, tool: 1 };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** 校验并裁剪 assistant 的 tool_calls */
function sanitizeToolCalls(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list.slice(0, MAX_TOOL_CALLS)) {
    const fn = c && c.function;
    if (!fn || typeof fn.name !== 'string' || !NAME_RE.test(fn.name)) continue;
    let args = '';
    if (typeof fn.arguments === 'string') args = fn.arguments.slice(0, MAX_CHARS);
    else args = JSON.stringify(fn.arguments || {});
    out.push({
      id: String(c.id || ('call_' + out.length)).slice(0, 64),
      type: 'function',
      function: { name: fn.name, arguments: args }
    });
  }
  return out.length ? out : null;
}

/** 校验并裁剪工具 schema */
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const t of tools.slice(0, MAX_TOOLS)) {
    const fn = t && t.type === 'function' && t.function;
    if (!fn || typeof fn.name !== 'string' || !NAME_RE.test(fn.name)) continue;
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: String(fn.description || '').slice(0, 500),
        parameters: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} }
      }
    });
  }
  return out.length ? out : null;
}

/** 裁剪客户端传来的 messages：只留白名单 role，截断超长文本 */
function sanitize(messages) {
  const out = [];
  const src = messages.slice(0, 200); // 先限输入规模，防超长数组
  for (const m of src) {
    if (!m || !ALLOWED_ROLES[m.role]) continue;

    if (m.role === 'tool') {
      const content = typeof m.content === 'string'
        ? m.content.slice(0, MAX_CHARS)
        : JSON.stringify(m.content || {});
      out.push({
        role: 'tool',
        tool_call_id: String(m.tool_call_id || '').slice(0, 64),
        content
      });
      continue;
    }

    if (m.role === 'assistant') {
      const calls = sanitizeToolCalls(m.tool_calls);
      const content = typeof m.content === 'string' ? m.content.slice(0, MAX_CHARS) : '';
      if (!content && !calls) continue;
      const item = { role: 'assistant', content };
      if (calls) item.tool_calls = calls;
      out.push(item);
      continue;
    }

    const content = typeof m.content === 'string' ? m.content.slice(0, MAX_CHARS) : '';
    if (!content) continue;
    out.push({ role: m.role, content });
  }

  // 超长时保留 system + 最近的消息；开头的孤立 tool 消息一并丢掉
  if (out.length > MAX_MESSAGES) {
    const system = out[0] && out[0].role === 'system' ? out[0] : null;
    const room = MAX_MESSAGES - (system ? 1 : 0);
    const tail = out.slice(out.length - room);
    while (tail.length && tail[0].role === 'tool') tail.shift();
    return (system ? [system] : []).concat(tail);
  }
  return out;
}

/** 非流式调用 OpenAI 兼容 /chat/completions，返回完整 message */
function callLLM(messages, key, opts) {
  const payload = {
    model: opts.model,
    messages: messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: false
  };
  if (opts.tools && opts.tools.length) payload.tools = opts.tools;
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = require('https').request(LLM_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 50000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error('LLM HTTP ' + res.statusCode + ': ' + raw.slice(0, 200));
          err.status = res.statusCode;
          reject(err);
          return;
        }
        try {
          const data = JSON.parse(raw);
          resolve((data.choices && data.choices[0] && data.choices[0].message) || {});
        } catch (e) {
          reject(new Error('LLM 响应解析失败'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('LLM 请求超时')); });
    req.write(body);
    req.end();
  });
}

/** 统一出参：把 message.tool_calls 拍平成客户端好用的结构 */
function respond(message) {
  const m = message || {};
  const calls = Array.isArray(m.tool_calls)
    ? m.tool_calls.slice(0, MAX_TOOL_CALLS).map((c, i) => {
      const fn = c && c.function;
      return {
        id: String((c && c.id) || ('call_' + i)),
        name: (fn && fn.name) || '',
        arguments: (fn && fn.arguments) || '{}'
      };
    }).filter((c) => !!c.name)
    : [];

  return {
    code: 0,
    content: typeof m.content === 'string' ? m.content : '',
    reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : '',
    toolCalls: calls,
    usage: m.usage || null
  };
}

/** 判断错误是否可能因为模型/服务不支持 tools */
function looksLikeToolRejection(err) {
  if (!err) return false;
  if (err.status === 400 || err.status === 422) return true;
  return /tool|function.?call/i.test(String(err.message || ''));
}

exports.main = async (event) => {
  const e = event || {};
  const messages = sanitize(Array.isArray(e.messages) ? e.messages : []);
  if (!messages.length) return { code: 1, msg: '缺少有效的 messages' };

  const key = (e.apiKey && String(e.apiKey).trim()) || process.env.SILICONFLOW_KEY || '';
  if (!key) {
    console.error('[chat] 环境变量 SILICONFLOW_KEY 未配置');
    return { code: 2, msg: 'NO_LLM_KEY' };
  }

  const tools = sanitizeTools(e.tools);
  const opts = {
    model: typeof e.model === 'string' && e.model ? e.model.slice(0, 80) : MODEL,
    temperature: e.temperature != null ? Number(e.temperature) || 0.5 : 0.5,
    maxTokens: Math.min(Number(e.maxTokens) || 2048, 4096),
    tools: tools
  };

  try {
    const m = await callLLM(messages, key, opts);
    return respond(m);
  } catch (err) {
    // 模型不支持原生工具调用：去掉 tools 再试一次，并让客户端切到 JSON 协议
    if (tools && looksLikeToolRejection(err)) {
      try {
        const m2 = await callLLM(messages, key, Object.assign({}, opts, { tools: null }));
        const out = respond(m2);
        out.toolsUnsupported = true;
        return out;
      } catch (err2) {
        console.error('[chat] 去掉 tools 重试仍失败:', err2.message);
      }
    }
    console.error('[chat]', err.message);
    return { code: 1, msg: err.message };
  }
};
