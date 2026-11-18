/**
 * 日记分析 Prompt（移植自 life-insight 插件 src/services/aiService.ts）
 * 要求 AI 返回严格 JSON 的 PeriodInsight 结构。
 */

/**
 * 按分析范围切换策略（对应 getRangeStrategy）
 */
function getRangeStrategy(days) {
  if (days <= 7) {
    return '这是短周期复盘。重点关注：本周的情绪波动、关键事件、人物互动质量，给出下周可执行的小建议。';
  }
  if (days <= 30) {
    return '这是月度回顾。重点关注：一个月内的状态变化曲线、出现的新模式、被反复提及的主题与人物，指出值得延续与需要调整的地方。';
  }
  if (days <= 365) {
    return '这是年度故事线。重点关注：贯穿全年的主线变化（工作/关系/健康/成长）、重要转折点、年度关键词，用讲故事的方式概括这一年。';
  }
  return '这是长期人生画像。重点关注：几个阶段的人生章节、长期坚持与长期忽视的事情、个人成长的轨迹与模式。';
}

/**
 * 构建周期洞察 Prompt
 * @param {Array<{date: string, text: string}>} notes 日记数组
 * @param {number} days 分析范围天数
 */
function buildPeriodInsightPrompt(notes, days) {
  const strategy = getRangeStrategy(days);
  const dateRange = notes.length
    ? (notes[0].date + ' 至 ' + notes[notes.length - 1].date)
    : '（无日记）';

  const system = [
    '你是一位温和、敏锐的个人成长分析师，擅长从用户的日记中发现用户自己没有意识到的东西。',
    '',
    '核心目标：发现用户没发现的变化、模式、问题、成长。',
    '',
    '安全边界：',
    '- 禁止医学诊断，涉及心理健康时只描述现象并建议寻求专业帮助；',
    '- 禁止命运预测、算命式表达；',
    '- 语气温和尊重，不评判用户。'
  ].join('\n');

  const user = [
    '请分析我 ' + dateRange + '（共 ' + notes.length + ' 篇）的日记。',
    '分析策略：' + strategy,
    '',
    '请严格只输出一个 JSON 对象，不要输出任何其他文字或代码围栏标记，结构如下：',
    '{',
    '  "overallState": "整体状态一句话",',
    '  "topics": [{ "name": "主题名", "count": 出现次数, "sentiment": "positive|negative|neutral" }],',
    '  "people": [{ "name": "人物称呼", "count": 出现次数, "sentiment": "positive|negative|neutral" }],',
    '  "emotionChanges": ["情绪变化描述1", "情绪变化描述2"],',
    '  "lifeChanges": [{ "name": "变化领域", "direction": "up|down|flat|new|left", "magnitude": 1-10数字, "reason": "原因", "interpretation": "解读", "confidence": 0-1数字 }],',
    '  "aiFindings": [{ "type": "change|pattern|risk|blindspot|growth|anomaly", "title": "标题", "evidence": "日记中的证据", "explanation": "解释", "suggestion": "建议", "confidence": 0-1数字 }],',
    '  "cycleInsight": "周期性洞察一句话",',
    '  "insight": "核心洞察一段话",',
    '  "highlight": "最值得记住的一句原文或总结",',
    '  "confidence": 0-1数字,',
    '  "emotionScores": [{ "date": "YYYY-MM-DD", "happy": 0-100, "anxiety": 0-100, "stress": 0-100, "tiredness": 0-100, "calm": 0-100 }]',
    '}',
    '',
    '规则：',
    '- emotionScores 尽量为有日记的每一天估算五维情绪分数（0-100）；',
    '- confidence 反映你对该判断的确信度；',
    '- 各数组可为空，但字段必须齐全；',
    '- 只输出 JSON，不要输出 markdown 代码块标记。'
  ].join('\n');

  const diaryText = notes
    .map(function (n) { return '## ' + n.date + '\n' + n.text; })
    .join('\n\n---\n\n');

  return {
    system: system,
    user: user + '\n\n以下是日记内容：\n\n' + diaryText
  };
}

module.exports = {
  getRangeStrategy,
  buildPeriodInsightPrompt
};
