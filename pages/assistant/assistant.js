const { streamChat } = require('../../utils/sse');
const ai = require('../../utils/ai');
const config = require('../../config');

const HISTORY_KEY = 'chat.messages';
const MAX_CONTEXT_MESSAGES = 40; // 最近 20 轮
const PUMP_TICK = 60; // 打字机 tick（ms），setData 跨线程不宜太快

const SYSTEM_PROMPT = [
  '你是一名软考中级备考助手。回答要求：',
  '1. 先给结论，再给依据；专业术语保留英文原文。',
  '2. 涉及知识点时标注所属章节，便于用户回查教材。',
  '3. 不确定的内容明确说不确定，不要编造。',
  '4. 用中文回答，数学公式用 $...$ 包裹。',
  '5. 回答尽量精炼，控制在 800 字以内。'
].join('\n');

const SUGGESTIONS = ['可用度怎么算？', '系统架构设计考什么？', '给我一份 4 周备考计划'];

let idSeq = Date.now();

Page({
  data: {
    messages: [],
    input: '',
    busy: false,
    canSend: false,
    scrollInto: '',
    showKeyModal: false,
    keyInput: '',
    hasKey: false,
    suggestions: SUGGESTIONS
  },

  // 非响应式运行时状态
  stream: null,       // { abort() }
  fullBuf: '',        // 网络已到的完整正文
  shownLen: 0,        // 已上屏的正文长度
  thinkingBuf: '',    // 思考过程
  pendingThinking: '',// 未上屏的思考增量
  replyIndex: -1,     // 当前回复在 messages 中的下标
  done: false,        // 网络侧是否已结束
  pumpTimer: null,

  onLoad() {
    this.setData({ hasKey: ai.hasApiKey() });
    const cached = wx.getStorageSync(HISTORY_KEY);
    if (Array.isArray(cached)) this.setData({ messages: cached });
  },

  onShow() {
    this.setData({ hasKey: ai.hasApiKey() });
  },

  onHide() {
    if (this.data.busy) this.stop();
  },

  onUnload() {
    if (this.data.busy) this.stop();
    this.clearPump();
  },

  // ---------- 输入 ----------
  onInput(e) {
    this.setData({ input: e.detail.value, canSend: !!e.detail.value.trim() && !this.data.busy });
  },

  onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.busy) return;
    this.setData({ input: '', canSend: false });

    const userMsg = { id: 'u' + (idSeq++), role: 'user', content: text };
    const replyMsg = {
      id: 'a' + (idSeq++),
      role: 'assistant',
      content: '',
      thinking: '',
      thinkOpen: false,
      streaming: true,
      elapsedMs: 0
    };
    const messages = this.data.messages.concat([userMsg, replyMsg]);
    this.replyIndex = messages.length - 1;

    // 重置运行时状态
    this.fullBuf = '';
    this.shownLen = 0;
    this.thinkingBuf = '';
    this.pendingThinking = '';
    this.done = false;

    this.setData({ messages: messages, busy: true, scrollInto: replyMsg.id });
    this.startedAt = Date.now();
    this.startPump();

    this.stream = streamChat({
      model: config.CHAT_MODEL,
      maxTokens: 2048,
      messages: this.buildContext(text),
      onDelta: (t) => { this.fullBuf += t; },
      onThinking: (t) => {
        this.thinkingBuf += t;
        this.pendingThinking += t;
      },
      onDone: (info) => {
        this.done = true;
        this.replyInfo = info;
        // 思考文本直接整段上屏（更新频率低）
        if (this.replyIndex >= 0) {
          this.setData({ ['messages[' + this.replyIndex + '].thinking']: this.thinkingBuf });
        }
        this.pendingThinking = '';
      },
      onError: (err) => {
        this.done = true;
        this.fullBuf += this.fullBuf ? '\n\n> ⚠️ ' + err.message : '⚠️ ' + err.message;
        if (this.replyIndex >= 0) {
          this.setData({ ['messages[' + this.replyIndex + '].thinking']: this.thinkingBuf });
        }
        this.pendingThinking = '';
      }
    });
  },

  /** 上下文：历史最近 20 轮 + 本条提问（不含 thinking） */
  buildContext(current) {
    const history = this.data.messages
      .filter((m) => !m.streaming && m.content)
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    return [{ role: 'system', content: SYSTEM_PROMPT }].concat(history);
  },

  // ---------- 打字机泵 ----------
  startPump() {
    this.clearPump();
    this.pumpTimer = setInterval(() => this.pumpTick(), PUMP_TICK);
  },

  clearPump() {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  },

  /** WXML 不支持函数调用，耗时格式化必须在 JS 侧完成 */
  formatElapsed(ms) {
    if (!ms || ms <= 0) return '-';
    return (ms / 1000).toFixed(1) + 's';
  },

  /** 弹层阻止冒泡用的空处理器 */
  noop() {},

  pumpTick() {
    const i = this.replyIndex;
    if (i < 0) { this.clearPump(); return; }

    // 思考过程增量上屏
    if (this.pendingThinking) {
      this.thinkingShown = (this.thinkingShown || '') + this.pendingThinking;
      this.pendingThinking = '';
      this.setData({ ['messages[' + i + '].thinking']: this.thinkingShown });
    }

    // 正文自适应步长：积压越多放得越快
    const pending = this.fullBuf.length - this.shownLen;
    if (pending > 0) {
      const step = Math.min(6, 1 + Math.floor(pending / 80));
      this.shownLen = Math.min(this.fullBuf.length, this.shownLen + step);
      this.setData({ ['messages[' + i + '].content']: this.fullBuf.slice(0, this.shownLen) });
    }

    // 收尾：网络结束 + 正文追平
    if (this.done && this.shownLen >= this.fullBuf.length && !this.pendingThinking) {
      const elapsed = this.replyInfo ? this.replyInfo.elapsedMs : (Date.now() - (this.startedAt || Date.now()));
      this.setData({
        ['messages[' + i + '].streaming']: false,
        ['messages[' + i + '].elapsedMs']: elapsed,
        ['messages[' + i + '].elapsedText']: this.formatElapsed(elapsed),
        busy: false
      });
      this.stream = null;
      this.replyInfo = null;
      this.clearPump();
      this.persistHistory();
    }
  },

  // ---------- 停止 ----------
  stop() {
    if (this.stream) {
      this.stream.abort();
      this.stream = null;
    }
    this.done = true;
    // 立即把剩余内容全部上屏（保留残缺回答）
    const i = this.replyIndex;
    if (i >= 0) {
      this.shownLen = this.fullBuf.length;
      this.thinkingShown = this.thinkingBuf;
      const elapsed = Date.now() - (this.startedAt || Date.now());
      this.setData({
        ['messages[' + i + '].content']: this.fullBuf,
        ['messages[' + i + '].thinking']: this.thinkingBuf,
        ['messages[' + i + '].streaming']: false,
        ['messages[' + i + '].elapsedMs']: elapsed,
        ['messages[' + i + '].elapsedText']: this.formatElapsed(elapsed),
        busy: false
      });
      this.pendingThinking = '';
      this.persistHistory();
    }
    this.clearPump();
  },

  // ---------- 思考折叠 ----------
  toggleThink(e) {
    const i = e.currentTarget.dataset.i;
    const cur = this.data.messages[i].thinkOpen;
    this.setData({ ['messages[' + i + '].thinkOpen']: !cur });
  },

  // ---------- 滚动 ----------
  scrollToEnd() {
    const last = this.data.messages.length
      ? this.data.messages[this.data.messages.length - 1].id : '';
    this.setData({ scrollInto: 'anchor-bottom' });
  },

  // ---------- 会话管理 ----------
  persistHistory() {
    const slim = this.data.messages
      .filter((m) => !m.streaming && m.content)
      .slice(-30)
      .map((m) => ({
        id: m.id, role: m.role, content: m.content,
        thinking: m.thinking || '', elapsedMs: m.elapsedMs || 0,
        elapsedText: m.elapsedText || '-'
      }));
    wx.setStorageSync(HISTORY_KEY, slim);
  },

  onClear() {
    wx.showModal({
      title: '清空对话',
      content: '确定清空全部对话记录？',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync(HISTORY_KEY);
          this.setData({ messages: [], busy: false });
          this.fullBuf = '';
          this.shownLen = 0;
          this.thinkingBuf = '';
          this.pendingThinking = '';
        }
      }
    });
  },

  onSuggestionTap(e) {
    this.setData({ input: e.currentTarget.dataset.text, canSend: !this.data.busy });
  },

  // ---------- Key 设置 ----------
  onOpenKeyModal() {
    this.setData({ showKeyModal: true, keyInput: ai.getApiKey() });
  },

  onCloseKeyModal() {
    this.setData({ showKeyModal: false });
  },

  onKeyInput(e) {
    this.setData({ keyInput: e.detail.value });
  },

  onSaveKey() {
    ai.setApiKey(this.data.keyInput);
    this.setData({ showKeyModal: false, hasKey: ai.hasApiKey() });
    wx.showToast({ title: '已保存', icon: 'success' });
  }
});
