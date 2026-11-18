/**
 * 洞察结果解析与归一化（移植自 life-insight 插件 src/services/insightService.ts）
 * AI 返回的 JSON 需要剥离代码围栏并做字段兜底。
 */

/**
 * 剥离 ```json ... ``` 围栏
 */
function stripJsonFence(text) {
  if (typeof text !== 'string') return '';
  let t = text.trim();
  // 去掉开头 ```json / ``` 与结尾 ```
  const fenceStart = t.match(/^```[a-zA-Z]*\s*\n/);
  if (fenceStart) t = t.slice(fenceStart[0].length);
  if (t.endsWith('```')) t = t.slice(0, -3);
  return t.trim();
}

/**
 * 从回复文本中提取第一个完整 JSON 对象（容错：AI 可能在 JSON 前后加话）
 */
function extractJsonObject(text) {
  const t = stripJsonFence(text);
  const start = t.indexOf('{');
  if (start < 0) throw new Error('回复中未找到 JSON');
  // 从后往前找最后一个 '}'，之间内容尝试 parse
  const end = t.lastIndexOf('}');
  if (end <= start) throw new Error('JSON 结构不完整');
  return JSON.parse(t.slice(start, end + 1));
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeSentiment(s) {
  return ['positive', 'negative', 'neutral'].indexOf(s) >= 0 ? s : 'neutral';
}

const FINDING_TYPES = ['change', 'pattern', 'risk', 'blindspot', 'growth', 'anomaly'];
const LIFE_DIRECTIONS = ['up', 'down', 'flat', 'new', 'left'];

function normalizeItems(arr, fields) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
    const out = {};
    fields.forEach(function (f) { out[f.key] = x[f.key] != null ? x[f.key] : f.def; });
    return out;
  });
}

/**
 * 归一化 PeriodInsight，任何字段缺失都有兜底，保证页面渲染不崩
 */
function normalizeInsight(raw) {
  const obj = typeof raw === 'string' ? extractJsonObject(raw) : raw;

  const emotionScores = normalizeItems(obj.emotionScores, [
    { key: 'date', def: '' },
    { key: 'happy', def: 0 }, { key: 'anxiety', def: 0 },
    { key: 'stress', def: 0 }, { key: 'tiredness', def: 0 },
    { key: 'calm', def: 0 }
  ]).map(function (s) {
    return {
      date: String(s.date || ''),
      happy: clamp(s.happy, 0, 100, 0),
      anxiety: clamp(s.anxiety, 0, 100, 0),
      stress: clamp(s.stress, 0, 100, 0),
      tiredness: clamp(s.tiredness, 0, 100, 0),
      calm: clamp(s.calm, 0, 100, 0)
    };
  }).filter(function (s) { return !!s.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  const lifeChanges = normalizeItems(obj.lifeChanges, [
    { key: 'name', def: '未命名' },
    { key: 'direction', def: 'flat' },
    { key: 'magnitude', def: 5 },
    { key: 'reason', def: '' },
    { key: 'interpretation', def: '' },
    { key: 'confidence', def: 0.5 }
  ]).map(function (c) {
    return {
      name: String(c.name),
      direction: LIFE_DIRECTIONS.indexOf(c.direction) >= 0 ? c.direction : 'flat',
      magnitude: clamp(c.magnitude, 1, 10, 5),
      reason: String(c.reason || ''),
      interpretation: String(c.interpretation || ''),
      confidence: clamp(c.confidence, 0, 1, 0.5)
    };
  });

  const aiFindings = normalizeItems(obj.aiFindings, [
    { key: 'type', def: 'pattern' },
    { key: 'title', def: 'AI 发现' },
    { key: 'evidence', def: '' },
    { key: 'explanation', def: '' },
    { key: 'suggestion', def: '' },
    { key: 'confidence', def: 0.5 }
  ]).map(function (f) {
    return {
      type: FINDING_TYPES.indexOf(f.type) >= 0 ? f.type : 'pattern',
      title: String(f.title),
      evidence: String(f.evidence || ''),
      explanation: String(f.explanation || ''),
      suggestion: String(f.suggestion || ''),
      confidence: clamp(f.confidence, 0, 1, 0.5)
    };
  });

  return {
    overallState: String(obj.overallState || '暂无整体状态描述'),
    topics: normalizeItems(obj.topics, [
      { key: 'name', def: '未知' }, { key: 'count', def: 1 },
      { key: 'sentiment', def: 'neutral' }
    ]).map(function (t) {
      t.count = clamp(t.count, 0, 9999, 1);
      t.sentiment = normalizeSentiment(t.sentiment);
      return t;
    }).sort(function (a, b) { return b.count - a.count; }),
    people: normalizeItems(obj.people, [
      { key: 'name', def: '未知' }, { key: 'count', def: 1 },
      { key: 'sentiment', def: 'neutral' }
    ]).map(function (p) {
      p.count = clamp(p.count, 0, 9999, 1);
      p.sentiment = normalizeSentiment(p.sentiment);
      return p;
    }).sort(function (a, b) { return b.count - a.count; }),
    emotionChanges: Array.isArray(obj.emotionChanges)
      ? obj.emotionChanges.map(String).filter(Boolean) : [],
    lifeChanges: lifeChanges,
    aiFindings: aiFindings,
    cycleInsight: String(obj.cycleInsight || ''),
    insight: String(obj.insight || ''),
    highlight: String(obj.highlight || ''),
    confidence: clamp(obj.confidence, 0, 1, 0.5),
    emotionScores: emotionScores
  };
}

module.exports = {
  stripJsonFence,
  extractJsonObject,
  normalizeInsight
};
