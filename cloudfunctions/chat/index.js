/**
 * 云函数 chat：AI 助手对话代理（2026-11，替代客户端直连硅基流动）
 *
 * 动机：
 *   1. 消除 request 合法域名限制 —— wx.cloud.callFunction 免域名免备案；
 *   2. LLM Key 不下发到客户端 —— 只存在云函数环境变量 SILICONFLOW_KEY。
 *
 * 入参（wx.cloud.callFunction）：{ messages, model?, temperature?, maxTokens?, apiKey? }
 *   messages: OpenAI 兼容格式 [{ role, content }]，服务端会再次裁剪防滥用。
 *   apiKey:   可选，「我的」页统一设置的本机 Key（仅开发调试用），未传回退环境变量。
 *
 * 出参：{ code, msg?, content, reasoning, usage }
 *   content:   assistant 正文
 *   reasoning: 思考过程（DeepSeek-R 系列才有，普通模型为空串）
 *
 * 非流式返回：小程序端用打字机泵逐步上屏，观感接近流式。
 * ⚠️ config.json 已配 timeout 55s：长回复可达 30~50s，默认 3s 会稳定超时。
 */
const LLM_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = process.env.SILICONFLOW_CHAT_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';

const MAX_MESSAGES = 60;    // 上下文轮数上限
const MAX_CHARS = 8000;     // 单条消息字符上限（防滥用/防注入超长文本）
const ALLOWED_ROLES = { system: 1, user: 1, assistant: 1 };

/** 裁剪客户端传来的 messages：只留白名单 role，截断超长文本 */
function sanitize(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !ALLOWED_ROLES[m.role]) continue;
    const content = typeof m.content === 'string' ? m.content.slice(0, MAX_CHARS) : '';
    if (!content) continue;
    out.push({ role: m.role, content });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

/** 非流式调用 OpenAI 兼容 /chat/completions，返回完整 message */
function callLLM(messages, key, opts) {
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: false
  });
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
          reject(new Error('LLM HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)));
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

exports.main = async (event) => {
  const e = event || {};
  const messages = sanitize(Array.isArray(e.messages) ? e.messages : []);
  if (!messages.length) return { code: 1, msg: '缺少有效的 messages' };

  const key = (e.apiKey && String(e.apiKey).trim()) || process.env.SILICONFLOW_KEY || '';
  if (!key) {
    console.error('[chat] 环境变量 SILICONFLOW_KEY 未配置');
    return { code: 2, msg: 'NO_LLM_KEY' };
  }

  try {
    const m = await callLLM(messages, key, {
      model: typeof e.model === 'string' && e.model ? e.model.slice(0, 80) : MODEL,
      temperature: e.temperature != null ? Number(e.temperature) || 0.7 : 0.7,
      maxTokens: Math.min(Number(e.maxTokens) || 2048, 4096)
    });
    return {
      code: 0,
      content: typeof m.content === 'string' ? m.content : '',
      reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : '',
      usage: m.usage || null
    };
  } catch (err) {
    console.error('[chat]', err.message);
    return { code: 1, msg: err.message };
  }
};
