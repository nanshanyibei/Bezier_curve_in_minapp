const ai = require('../../utils/ai');
const md = require('../../utils/markdown');
const cb = require('../../utils/cb');
const config = require('../../config');
const agent = require('../../utils/agent');
const diaryStore = require('../../utils/diaryStore');

const HISTORY_KEY = 'chat.messages';
const HISTORY_TS_KEY = 'chat.updatedAt';
const MAX_CONTEXT_MESSAGES = 40; // 最近 20 轮
const PUMP_TICK = 60;            // 打字机 tick（ms），setData 跨线程不宜太快
const MAX_PERSIST_STEPS = 8;     // 每条回复最多保留的工具步骤

const SYSTEM_PROMPT = [
  '你是「南山工作台」里的旅行与生活助手，可以调用工具读取用户的真实数据并执行操作。',
  '',
  '工作方式：',
  '1. 需要真实数据时必须调用工具，不要凭空编造：景点用 searchAttractions，旅行记录用 getFootprint，衣橱用 getWardrobe。',
  '2. 能从用户的话里提取的参数就直接用；缺关键信息（比如要写日记但没说内容）先追问一句。',
  '3. 工具返回后，用简洁自然的中文给结论和建议，不要复述原始 JSON 或坐标。',
  '4. 写操作（saveDiaryDraft）只生成草稿，必须由用户确认后才会保存。不要声称已经保存。',
  '5. 工具失败或没有数据时如实说明，并给出替代办法。',
  '6. 口语化、有温度，不堆攻略腔；需要时用短列表，回答控制在 600 字以内。',
  '7. 推荐地点时说明适合的季节、人群和玩法；提醒出行前核实开放信息。'
].join('\n');

const SUGGESTIONS = [
  '我今年去过哪些省？',
  '成都有哪些必去的5A景区？',
  '按 3 月的天气帮我配几套穿搭',
  '帮我给今天写篇日记'
];

let idSeq = Date.now();

function todayStr() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 历史消息补齐渲染字段（AI 正文用 rich-text 展示 markdown，工具步骤补空数组） */
function hydrate(messages) {
  return (messages || []).map(function (m) {
    const item = Object.assign({ steps: [] }, m);
    if (m.role === 'assistant') item.nodes = md.toNodes(m.content || '');
    return item;
  });
}

/** 单条消息持久化时只留必要字段，confirm 草稿不跨会话保留 */
function slimMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking || '',
    elapsedMs: m.elapsedMs || 0,
    elapsedText: m.elapsedText || '-',
    steps: (m.steps || []).slice(-MAX_PERSIST_STEPS).map(function (s) {
      return {
        id: s.id,
        name: s.name,
        label: s.label,
        status: s.status,
        stateText: s.stateText,
        summary: s.summary || ''
      };
    })
  };
}

Page({
  data: {
    messages: [],
    input: '',
    busy: false,
    canSend: false,
    scrollInto: '',
    hasKey: false,
    suggestions: SUGGESTIONS
  },

  // 非响应式运行时状态
  runSeq: 0,          // 每次发送自增，用来丢弃过期的异步结果
  cancelled: false,
  replyIndex: -1,     // 当前回复在 messages 中的下标
  fullBuf: '',        // 网络已到的完整正文
  shownLen: 0,        // 已上屏的正文长度
  thinkingBuf: '',    // 思考过程
  replyInfo: null,
  done: false,        // 网络侧是否已结束
  pumpTimer: null,
  stepSeq: 0,
  activeStepId: '',

  onLoad() {
    this.setData({ hasKey: ai.hasApiKey() });
    const cached = wx.getStorageSync(HISTORY_KEY);
    if (Array.isArray(cached)) this.setData({ messages: hydrate(cached) });
    this.pullCloudHistory();
  },

  /** 拉云端对话记录（chats 集合按 updatedAt 新者胜） */
  pullCloudHistory() {
    cb.listDocs('chats').then((list) => {
      if (!list || !list.length) return;
      const doc = list[0];
      if (!doc || !Array.isArray(doc.messages) || !doc.messages.length) return;
      const localT = Number(wx.getStorageSync(HISTORY_TS_KEY) || 0);
      if ((doc.updatedAt || 0) <= localT) return;
      this.setData({ messages: hydrate(doc.messages) });
      wx.setStorageSync(HISTORY_KEY, doc.messages);
      wx.setStorageSync(HISTORY_TS_KEY, doc.updatedAt || 0);
      this.scrollToEnd();
    }).catch(() => { /* 云端不可用则用本地 */ });
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
      elapsedMs: 0,
      elapsedText: '-',
      nodes: [],
      steps: []
    };

    // 上下文只取已完成的对话，不含本次的流式占位
    const history = this.buildHistory();
    const messages = this.data.messages.concat([userMsg, replyMsg]);
    this.replyIndex = messages.length - 1;

    this.fullBuf = '';
    this.shownLen = 0;
    this.thinkingBuf = '';
    this.replyInfo = null;
    this.done = false;
    this.cancelled = false;
    this.activeStepId = '';
    const runId = ++this.runSeq;

    this.setData({ messages: messages, busy: true, scrollInto: replyMsg.id });
    this.startedAt = Date.now();
    this.startPump();

    const dialogue = history.concat([{ role: 'user', content: text }]);

    agent.runAgent({
      messages: dialogue,
      callModel: (req) => this.callModel(req),
      isCancelled: () => this.cancelled || this.runSeq !== runId,
      onToolStart: (t) => {
        if (this.runSeq !== runId) return;
        this.pushStep(t);
      },
      onToolEnd: (t) => {
        if (this.runSeq !== runId) return;
        this.finishStep(t);
      }
    }).then((res) => {
      if (this.runSeq !== runId) return;
      this.done = true;
      this.fullBuf = res.content || '（没有返回内容，请再试一次）';
      this.thinkingBuf = res.reasoning || '';
      this.replyInfo = { elapsedMs: Date.now() - this.startedAt };
      const i = this.replyIndex;
      if (i >= 0 && this.thinkingBuf) {
        this.setData({ ['messages[' + i + '].thinking']: this.thinkingBuf });
      }
    }).catch((err) => {
      if (this.runSeq !== runId) return;
      this.done = true;
      const raw = (err && (err.errMsg || err.message)) || '云端调用失败';
      const msg = raw.replace(/^cloud\.callFunction:fail\s*/, '');
      this.fullBuf = '⚠️ ' + msg;
      this.replyInfo = { elapsedMs: Date.now() - this.startedAt };
    });
  },

  /** 上下文：system + 最近的已完成对话（不含工具过程） */
  buildHistory() {
    const history = this.data.messages
      .filter((m) => !m.streaming && m.content && (m.role === 'user' || m.role === 'assistant'))
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    return [{
      role: 'system',
      content: SYSTEM_PROMPT + '\n\n今天是 ' + todayStr() + '。'
    }].concat(history);
  },

  /** 云函数代理模型调用：tools 由 cloud 透传，Key 留在服务端 */
  callModel(req) {
    if (!cb.envConfigured()) return Promise.reject(new Error('未配置云开发环境'));
    const data = {
      messages: req.messages,
      model: config.CHAT_MODEL,
      temperature: 0.5,
      maxTokens: 2048,
      apiKey: ai.getApiKey() || undefined
    };
    if (req.tools) data.tools = req.tools;

    return wx.cloud.callFunction({ name: 'chat', data: data }).then((res) => {
      const r = (res && res.result) || {};
      if (r.code === 2) throw new Error('云端未配置 SILICONFLOW_KEY，请在云函数环境变量中设置');
      if (r.code !== 0) throw new Error(r.msg || '云端对话失败');
      return r;
    });
  },

  // ---------- 工具步骤 ----------
  pushStep(t) {
    const i = this.replyIndex;
    if (i < 0) return;
    const step = {
      id: 's' + (++this.stepSeq),
      name: t.name,
      label: t.label,
      status: 'running',
      stateText: '执行中',
      summary: ''
    };
    this.activeStepId = step.id;
    const steps = (this.data.messages[i].steps || []).concat([step]);
    this.setData({ ['messages[' + i + '].steps']: steps });
    this.scrollToEnd();
  },

  finishStep(t) {
    const i = this.replyIndex;
    if (i < 0) return;
    const steps = (this.data.messages[i].steps || []).slice();
    const idx = steps.findIndex((s) => s.id === this.activeStepId);
    if (idx < 0) return;

    const step = Object.assign({}, steps[idx], {
      status: t.ok ? 'done' : 'error',
      stateText: t.ok ? '完成' : '失败',
      summary: t.summary || (t.ok ? '已完成' : '执行失败')
    });

    if (t.ok && t.name === 'saveDiaryDraft' && t.result && t.result.requiresConfirm) {
      const full = String(t.result.text || '');
      step.confirm = {
        date: t.result.date,
        text: full,
        preview: full.slice(0, 120) + (full.length > 120 ? '…' : ''),
        existing: !!t.result.existing,
        saved: false,
        dismissed: false
      };
    }

    steps[idx] = step;
    this.setData({ ['messages[' + i + '].steps']: steps });
    this.scrollToEnd();
  },

  /** 用户确认后写入日记（写操作不交给模型自动完成） */
  onConfirmSave(e) {
    const mi = Number(e.currentTarget.dataset.mi);
    const si = Number(e.currentTarget.dataset.si);
    const msg = this.data.messages[mi];
    const step = msg && msg.steps && msg.steps[si];
    if (!step || !step.confirm || step.confirm.saved) return;

    diaryStore.save(step.confirm.date, step.confirm.text);
    const base = 'messages[' + mi + '].steps[' + si + ']';
    const patch = {};
    patch[base + '.confirm.saved'] = true;
    patch[base + '.summary'] = '已保存到 ' + step.confirm.date + ' 的日记';
    this.setData(patch);
    wx.showToast({ title: '已保存到日记', icon: 'success' });
    this.persistHistory();
  },

  onDismissStep(e) {
    const mi = Number(e.currentTarget.dataset.mi);
    const si = Number(e.currentTarget.dataset.si);
    this.setData({ ['messages[' + mi + '].steps[' + si + '].confirm.dismissed']: true });
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

    // 正文自适应步长：积压越多放得越快
    const pending = this.fullBuf.length - this.shownLen;
    if (pending > 0) {
      const step = Math.min(6, 1 + Math.floor(pending / 80));
      this.shownLen = Math.min(this.fullBuf.length, this.shownLen + step);
      const shown = this.fullBuf.slice(0, this.shownLen);
      this.setData({
        ['messages[' + i + '].content']: shown,
        ['messages[' + i + '].nodes']: md.toNodes(shown)
      });
    }

    // 收尾：网络结束 + 正文追平
    if (this.done && this.shownLen >= this.fullBuf.length) {
      const elapsed = this.replyInfo ? this.replyInfo.elapsedMs : (Date.now() - (this.startedAt || Date.now()));
      this.setData({
        ['messages[' + i + '].streaming']: false,
        ['messages[' + i + '].elapsedMs']: elapsed,
        ['messages[' + i + '].elapsedText']: this.formatElapsed(elapsed),
        busy: false
      });
      this.replyInfo = null;
      this.clearPump();
      this.persistHistory();
    }
  },

  // ---------- 停止 ----------
  stop() {
    this.cancelled = true;
    this.runSeq++; // 让在途的模型/工具结果失效
    this.done = true;

    const i = this.replyIndex;
    if (i >= 0) {
      this.shownLen = this.fullBuf.length;
      const elapsed = Date.now() - (this.startedAt || Date.now());

      // 未完成的步骤标记为中断
      const steps = (this.data.messages[i].steps || []).map((s) => {
        if (s.status !== 'running') return s;
        return Object.assign({}, s, { status: 'error', stateText: '已中断' });
      });

      this.setData({
        ['messages[' + i + '].content']: this.fullBuf || '（已停止）',
        ['messages[' + i + '].nodes']: md.toNodes(this.fullBuf || '（已停止）'),
        ['messages[' + i + '].thinking']: this.thinkingBuf,
        ['messages[' + i + '].steps']: steps,
        ['messages[' + i + '].streaming']: false,
        ['messages[' + i + '].elapsedMs']: elapsed,
        ['messages[' + i + '].elapsedText']: this.formatElapsed(elapsed),
        busy: false
      });
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
    this.setData({ scrollInto: 'anchor-bottom' });
  },

  // ---------- 会话管理 ----------
  persistHistory() {
    const slim = this.data.messages
      .filter((m) => !m.streaming && m.content)
      .slice(-30)
      .map(slimMessage);
    wx.setStorageSync(HISTORY_KEY, slim);
    const ts = Date.now();
    wx.setStorageSync(HISTORY_TS_KEY, ts);
    // 异步推云端（失败静默，下次进入拉取时兜底）
    cb.setDoc('chats', 'history', { messages: slim, updatedAt: ts });
  },

  onClear() {
    wx.showModal({
      title: '清空对话',
      content: '确定清空全部对话记录？',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (res.confirm) {
          this.cancelled = true;
          this.runSeq++;
          wx.removeStorageSync(HISTORY_KEY);
          wx.removeStorageSync(HISTORY_TS_KEY);
          cb.removeDoc('chats', 'history');
          this.setData({ messages: [], busy: false });
          this.replyIndex = -1;
          this.fullBuf = '';
          this.shownLen = 0;
          this.thinkingBuf = '';
          this.done = true;
          this.clearPump();
        }
      }
    });
  },

  onSuggestionTap(e) {
    this.setData({ input: e.currentTarget.dataset.text, canSend: !this.data.busy });
  }
});
