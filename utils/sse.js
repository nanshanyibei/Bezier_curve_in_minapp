/**
 * 流式 AI 客户端：wx.request enableChunked + SSE 解析
 * 对接 OpenAI 兼容 /chat/completions (stream: true)。
 *
 * 事件回调：
 *   onDelta(text)      正文增量
 *   onThinking(text)   思考过程增量（reasoning_content，可不存在）
 *   onDone(info)       正常结束 { length, thinkingLength, elapsedMs }
 *   onError(err)       失败 { message }
 *
 * 兜底：iOS 真机 onChunkReceived 偶发不触发 → success 里用完整 body 一次性解析。
 */
const config = require('../config');
const { createUtf8Decoder, decodeAll } = require('./utf8');
const ai = require('./ai');

function findSep(s) {
  const i1 = s.indexOf('\n\n');
  const i2 = s.indexOf('\r\n\r\n');
  if (i1 < 0 && i2 < 0) return null;
  if (i1 < 0) return { idx: i2, len: 4 };
  if (i2 < 0) return { idx: i1, len: 2 };
  return i2 < i1 ? { idx: i2, len: 4 } : { idx: i1, len: 2 };
}

function streamChat(opts) {
  const decoder = createUtf8Decoder();
  let buf = '';
  let gotChunk = false;
  let finished = false;
  let contentLen = 0;
  let thinkingLen = 0;
  const startedAt = Date.now();

  function safeCall(fn, arg) {
    if (typeof fn === 'function') {
      try { fn(arg); } catch (e) { /* 回调异常不中断流 */ }
    }
  }

  function finish(normal) {
    if (finished) return;
    finished = true;
    if (normal) {
      safeCall(opts.onDone, {
        length: contentLen,
        thinkingLength: thinkingLen,
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  function handleFrame(frame) {
    // 只关心 data: 行（OpenAI 兼容流没有自定义 event）
    const dataLines = [];
    frame.split(/\r?\n/).forEach((line) => {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      finish(true);
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch (e) {
      return; // 心跳/注释帧，忽略
    }
    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      thinkingLen += delta.reasoning_content.length;
      safeCall(opts.onThinking, delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      contentLen += delta.content.length;
      safeCall(opts.onDelta, delta.content);
    }
  }

  function processText(text) {
    buf += text;
    let sep = findSep(buf);
    while (sep) {
      const frame = buf.slice(0, sep.idx);
      buf = buf.slice(sep.idx + sep.len);
      handleFrame(frame);
      if (finished) return;
      sep = findSep(buf);
    }
  }

  function processArrayBuffer(ab) {
    processText(decoder.push(new Uint8Array(ab)));
  }

  const task = wx.request({
    url: config.LLM_BASE_URL + '/chat/completions',
    method: 'POST',
    timeout: config.TIMEOUT,
    header: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + ai.getApiKey()
    },
    data: {
      model: opts.model || config.CHAT_MODEL,
      stream: true,
      temperature: opts.temperature != null ? opts.temperature : 0.7,
      max_tokens: opts.maxTokens || 2048,
      messages: opts.messages
    },
    responseType: 'arraybuffer',
    enableChunked: true,
    enableHttp2: false,
    success(res) {
      if (res.statusCode !== 200) {
        let msg = 'HTTP ' + res.statusCode;
        try {
          const body = JSON.parse(decodeAll(res.data));
          if (body.error && body.error.message) msg = body.error.message;
        } catch (e) { /* 保留状态码信息 */ }
        safeCall(opts.onError, { message: 'AI 请求失败：' + msg });
        finished = true;
        return;
      }
      // 兜底：一次 chunk 都没收到（iOS 偶发），用完整 body 一次性解析
      if (!gotChunk && res.data) {
        processArrayBuffer(res.data);
        decoder.flush();
        buf = '';
      }
      if (!finished) finish(true);
    },
    fail(err) {
      if (finished) return;
      const msg = err.errMsg || '';
      if (msg.indexOf('abort') >= 0) {
        finish(true); // 用户主动停止，按结束处理（保留已有内容）
      } else {
        safeCall(opts.onError, { message: '网络请求失败：' + msg });
        finished = true;
      }
    }
  });

  if (task && typeof task.onChunkReceived === 'function') {
    task.onChunkReceived(({ data }) => {
      if (finished) return;
      gotChunk = true;
      processArrayBuffer(data);
    });
  }

  return {
    abort() {
      try { task.abort(); } catch (e) { /* 已结束则忽略 */ }
    }
  };
}

module.exports = { streamChat };
