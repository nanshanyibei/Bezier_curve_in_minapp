/**
 * 内容质量规则的唯一事实源：gen-details / gen-all / validate-details 三方共用
 *
 * - hasBanned(text)：套话扫描（含专名豁免）
 * - isDone(spot)：条目是否算「已完成」（人工撰写，或 intro 达标且无套话）
 *   gen-details 用它决定要不要重写，gen-all 用它统计进度，口径必须一致
 */

/** 硬套话/绝对化用语 */
const BANNED = /秀丽|历史悠久|值得一游|必去|必来|第一|最美|驰名|闻名遐迩|人间仙境|美不胜收|不容错过|打卡圣地/;

/**
 * 专名/史实豁免：这些短语含「第一」「最美」但属官方名号或客观事实，先摘出再扫。
 * 广告法禁的是「最高级」用于自身宣传，不是禁止引用匾额原文和铁路史。
 */
const EXEMPT = [
  '天下第一泉', '天下第一关', '天下第一雄关', '天下第一山', '天下第一曲水', '天下第一秀水',
  '中华第一关',
  '华夏第一牌楼', '第一展室', '第一条', '第一座', '第一桥', '第一批', '第一大跨国瀑布', '第一跨国瀑布',
  '中国最美旅游洞穴',
  /时[分节光]?最美/, /季节最美/
];

const len = (s) => (typeof s === 'string' ? Array.from(s.trim()).length : 0);

/** 命中返回命中的词，否则返回 null */
function hasBanned(text) {
  let s = String(text || '');
  EXEMPT.forEach((e, i) => {
    if (typeof e === 'string') {
      s = s.split(e).join('\u0000' + i + '\u0000');
    } else {
      s = s.replace(new RegExp(e.source, 'g'), '\u0000' + i + '\u0000');
    }
  });
  const m = BANNED.exec(s);
  return m ? m[0] : null;
}

/**
 * 条目是否算已完成：
 * - 人工撰写（src.intro === 'manual'）永远算完成，AI 不许碰
 * - AI 条目要求 intro ≥ 120 且无套话；不达标 = 待重写
 */
function isDone(spot) {
  if (!spot || !spot.name) return false;
  if (spot.src && spot.src.intro === 'manual') return true;
  return len(spot.intro) >= 120 && !hasBanned(spot.intro);
}

module.exports = { BANNED, EXEMPT, hasBanned, isDone, len };
