/**
 * OpenAI 兼容 /chat/completions 封装（开发期直连硅基流动）
 * API Key 存本地 storage：wx.setStorageSync('llm.apiKey', 'sk-xxx')
 */
const config = require('../config');

const API_KEY_STORAGE = 'llm.apiKey';

function getApiKey() {
  return wx.getStorageSync(API_KEY_STORAGE) || '';
}

function setApiKey(key) {
  wx.setStorageSync(API_KEY_STORAGE, (key || '').trim());
}

function hasApiKey() {
  return getApiKey().length > 0;
}

/**
 * 非流式对话（用于日记分析等一次性任务）
 * @param {object} opts { model, messages, temperature, maxTokens }
 * @returns {Promise<string>} 助手回复文本
 */
function chatCompletion(opts) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return Promise.reject(new Error('未配置 API Key，请在「AI 助手」页右上角设置'));
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: config.LLM_BASE_URL + '/chat/completions',
      method: 'POST',
      timeout: config.TIMEOUT,
      header: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      data: {
        model: opts.model || config.INSIGHT_MODEL,
        temperature: opts.temperature != null ? opts.temperature : 0.4,
        max_tokens: opts.maxTokens || 4096,
        stream: false,
        messages: opts.messages
      },
      success(res) {
        if (res.statusCode !== 200) {
          const msg = (res.data && res.data.error && res.data.error.message) ||
            ('HTTP ' + res.statusCode);
          reject(new Error('AI 请求失败：' + msg));
          return;
        }
        const content = res.data &&
          res.data.choices && res.data.choices[0] &&
          res.data.choices[0].message && res.data.choices[0].message.content;
        if (typeof content !== 'string') {
          reject(new Error('AI 返回格式异常'));
          return;
        }
        resolve(content);
      },
      fail(err) {
        reject(new Error('网络请求失败：' + (err.errMsg || 'unknown')));
      }
    });
  });
}

module.exports = {
  getApiKey,
  setApiKey,
  hasApiKey,
  chatCompletion
};
