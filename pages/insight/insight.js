const diaryStore = require('../../utils/diaryStore');
const ai = require('../../utils/ai');
const { buildPeriodInsightPrompt } = require('../../utils/insightPrompt');
const { normalizeInsight } = require('../../utils/insightParse');
const config = require('../../config');

const FINDING_TYPE_LABEL = {
  change: '变化', pattern: '模式', risk: '风险',
  blindspot: '盲区', growth: '成长', anomaly: '异常'
};
const FINDING_TYPE_COLOR = {
  change: '#6ea8fe', pattern: '#7ed491', risk: '#ef7d7d',
  blindspot: '#f0b35e', growth: '#b48ef0', anomaly: '#f0b35e'
};
const DIRECTION_LABEL = {
  up: '↑ 上升', down: '↓ 下降', flat: '→ 平稳', new: '✦ 新出现', left: '← 离开'
};

Page({
  data: {
    days: 7,
    loading: false,
    error: '',
    raw: '',
    result: null,
    // 渲染辅助
    topicsMax: 1,
    peopleMax: 1,
    emotionRows: []
  },

  onLoad(options) {
    const days = Number(options.days) || 7;
    this.setData({ days: days });
    this.analyze(days);
  },

  analyze(days) {
    if (!ai.hasApiKey()) {
      this.setData({ error: '未配置 API Key，请先到「AI 助手」页右上角 ⚙ 设置硅基流动 Key' });
      return;
    }
    const notes = diaryStore.getRange(days);
    if (!notes.length) {
      this.setData({ error: '这个范围内还没有日记' });
      return;
    }

    this.setData({ loading: true, error: '', raw: '', result: null });

    const prompt = buildPeriodInsightPrompt(notes, days);
    ai.chatCompletion({
      model: config.INSIGHT_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      temperature: 0.4,
      maxTokens: 4096
    }).then((content) => {
      const result = normalizeInsight(content);
      this.setData({
        loading: false,
        raw: content,
        result: result,
        topicsMax: this.maxCount(result.topics),
        peopleMax: this.maxCount(result.people),
        emotionRows: this.buildEmotionRows(result.emotionScores)
      });
    }).catch((err) => {
      this.setData({
        loading: false,
        error: err.message || '分析失败',
        raw: ''
      });
    });
  },

  maxCount(list) {
    let m = 1;
    (list || []).forEach((x) => { if (x.count > m) m = x.count; });
    return m;
  },

  /** 情绪条形图行：每行一个日期 + 五维百分比 */
  buildEmotionRows(scores) {
    return (scores || []).slice(-14).map((s) => ({
      date: s.date.slice(5), // MM-DD
      dims: [
        { name: '快乐', pct: s.happy, color: '#7ed491' },
        { name: '平静', pct: s.calm, color: '#6ea8fe' },
        { name: '焦虑', pct: s.anxiety, color: '#f0b35e' },
        { name: '压力', pct: s.stress, color: '#ef7d7d' },
        { name: '疲惫', pct: s.tiredness, color: '#b48ef0' }
      ]
    }));
  },

  findingLabel(type) {
    return FINDING_TYPE_LABEL[type] || '发现';
  },

  findingColor(type) {
    return FINDING_TYPE_COLOR[type] || '#6ea8fe';
  },

  directionLabel(dir) {
    return DIRECTION_LABEL[dir] || '→ 平稳';
  },

  onCopyRaw() {
    if (!this.data.raw) return;
    wx.setClipboardData({ data: this.data.raw });
  },

  onRetry() {
    this.analyze(this.data.days);
  }
});
