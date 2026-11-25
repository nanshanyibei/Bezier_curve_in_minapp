/**
 * Agent 工具集：定义 + 本地执行 + 结果摘要
 *
 * 执行位置：全部在客户端。直接复用本地优先的 store（travelStore / memoryStore /
 * wardrobeStore / diaryStore），因此能看到尚未同步到云端的数据，也不必在云函数里
 * 重写一套数据访问。模型调用仍由云函数代理，Key 不下发客户端。
 *
 * 约定：
 * - 读工具只返回摘要，控制体积（≤ 3000 字符），不要把整表塞给模型。
 * - 写工具只产出草稿（requiresConfirm），真正落库由页面上的用户确认触发。
 */
const attractionLayer = require('./attractionLayer');
const travelStore = require('./travelStore');
const memoryStore = require('./memoryStore');
const wardrobeStore = require('./wardrobeStore');
const diaryStore = require('./diaryStore');

const MAX_RESULT_CHARS = 3000;

const LABELS = {
  searchAttractions: '查询景点',
  getFootprint: '查看旅行足迹',
  getWardrobe: '查询电子衣橱',
  saveDiaryDraft: '生成日记草稿'
};

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'searchAttractions',
      description: '按关键词、省份或城市查询国家5A级旅游景区，返回名称、城市、类型、评定年份和坐标。用户问到具体景点、某地有什么好玩的时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '景点名或城市关键词，如“故宫”“成都”' },
          province: { type: 'string', description: '省份名称或6位adcode，如“四川”' },
          city: { type: 'string', description: '城市名，如“成都”' },
          limit: { type: 'integer', description: '返回条数，默认8，最大15' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getFootprint',
      description: '查询用户的旅行足迹：去过的省市数量、覆盖率、按省分组的已去/想去清单，以及最近的旅行回忆。用户问自己去过哪、覆盖率、想去哪时使用。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['visited', 'want', 'all'], description: '筛选状态，默认all' },
          province: { type: 'string', description: '只看某个省，可选' },
          includeMemories: { type: 'boolean', description: '是否附带最近旅行回忆，默认true' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getWardrobe',
      description: '查询用户的电子衣橱：总件数、分类统计，以及按类别/季节筛选的单品清单。用户问自己有哪些衣服、某季节穿什么时使用。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['top', 'bottom', 'outer', 'shoes', 'bag', 'accessory'], description: '类别，可选' },
          season: { type: 'string', enum: ['all', 'spring', 'summer', 'autumn', 'winter'], description: '季节，可选' },
          limit: { type: 'integer', description: '返回条数，默认20，最大40' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'saveDiaryDraft',
      description: '为用户生成一篇日记草稿。只生成草稿，不会直接保存；必须由用户在界面上确认后才会写入。用户说“帮我写日记/记录今天”时使用。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          text: { type: 'string', description: '日记正文，第一人称，200字以内更佳' }
        },
        required: ['text']
      }
    }
  }
];

// ---------- 通用 ----------

let _spots = null;

/** 全部 5A 景点（懒加载，约 358 条） */
function getSpots() {
  if (_spots) return _spots;
  _spots = [];
  attractionLayer.provinces().forEach(function (p) {
    attractionLayer.spotsOf(p.adcode).forEach(function (s) { _spots.push(s); });
  });
  return _spots;
}

function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function clamp(v, min, max, def) {
  const n = Number(v);
  if (!n && n !== 0) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 省名/adcode → 省级 adcode；无法识别返回 NaN，空输入返回 null */
function resolveProvince(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  if (/^\d{6}$/.test(raw)) return Number(raw);
  const short = raw.replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, '');
  const keys = Object.keys(attractionLayer.NAME);
  for (let i = 0; i < keys.length; i++) {
    const code = keys[i];
    const name = attractionLayer.NAME[code];
    if (name === raw || name === short) return Number(code);
    if (short.length >= 2 && (name.indexOf(short) >= 0 || short.indexOf(name) >= 0)) return Number(code);
  }
  return NaN;
}

// ---------- 工具实现 ----------

function searchAttractions(args) {
  const a = args || {};
  let keyword = norm(a.keyword);
  const city = norm(String(a.city || '').replace(/市$/, ''));
  let provCode = resolveProvince(a.province);

  if (provCode !== null && isNaN(provCode)) {
    return { count: 0, list: [], hint: '没有识别出这个省份，请用省名或6位adcode' };
  }
  // 关键词本身就是省名时，当作省份筛选
  if (!provCode && keyword) {
    const byKeyword = resolveProvince(keyword);
    if (byKeyword && !isNaN(byKeyword)) {
      provCode = byKeyword;
      keyword = '';
    }
  }

  if (!keyword && !city && !provCode) {
    const provs = attractionLayer.provinces().slice()
      .sort(function (x, y) { return y.n - x.n; })
      .slice(0, 10)
      .map(function (p) { return { province: p.name, count: p.n }; });
    return {
      total: getSpots().length,
      provinces: provs,
      hint: '未指定范围，先给出5A数量最多的省份；可继续按省/城市/关键词查询'
    };
  }

  const matched = getSpots().filter(function (s) {
    if (provCode && s.prov !== provCode) return false;
    if (city && norm(s.city).indexOf(city) < 0) return false;
    if (keyword) {
      const name = norm(s.name);
      if (name.indexOf(keyword) < 0 && norm(s.city).indexOf(keyword) < 0) return false;
    }
    return true;
  });

  const scored = matched.map(function (s) {
    let score = 0;
    if (keyword) {
      const name = norm(s.name);
      if (name === keyword) score = 4;
      else if (name.indexOf(keyword) === 0) score = 3;
      else if (name.indexOf(keyword) > 0) score = 2;
      else score = 1;
    }
    return { s: s, score: score };
  });
  scored.sort(function (x, y) {
    if (y.score !== x.score) return y.score - x.score;
    return Number(y.s.year) - Number(x.s.year);
  });

  const limit = clamp(a.limit, 1, 15, 8);
  return {
    count: matched.length,
    list: scored.slice(0, limit).map(function (it) {
      return {
        name: it.s.name,
        province: attractionLayer.NAME[it.s.prov] || '',
        city: it.s.city,
        year: it.s.year,
        tags: it.s.tags,
        lat: it.s.lat || 0,
        lng: it.s.lng || 0
      };
    }),
    hint: matched.length ? '' : '没有匹配的景点，可以换个关键词或放宽省份'
  };
}

function getFootprint(args) {
  const a = args || {};
  const cov = travelStore.coverage();
  const wantStatus = a.status === 'visited' || a.status === 'want' ? a.status : '';
  const provFilter = norm(String(a.province || '').replace(/省|市|自治区/g, ''));

  let groups = travelStore.groupByProvince();
  if (provFilter) {
    groups = groups.filter(function (g) { return norm(g.name).indexOf(provFilter) >= 0; });
  }

  const provinces = groups.map(function (g) {
    const items = g.items
      .filter(function (it) { return !wantStatus || it.status === wantStatus; })
      .slice(0, 6)
      .map(function (it) { return { name: it.name, status: it.status }; });
    return {
      province: g.name,
      visited: g.visitedCount,
      want: g.wantCount,
      items: items
    };
  }).filter(function (g) { return g.items.length; }).slice(0, 12);

  const out = {
    summary: {
      provinceVisited: cov.provinceVisited,
      provinceTotal: cov.provinceTotal,
      pct: cov.pct,
      cityVisited: cov.cityVisited,
      visited: cov.visited,
      want: cov.want
    },
    visitedProvinces: groups.filter(function (g) { return g.visitedCount > 0; })
      .map(function (g) { return g.name; }),
    provinces: provinces
  };

  if (a.includeMemories !== false) {
    out.recentMemories = memoryStore.listAll().slice(0, 3).map(function (m) {
      return {
        date: m.date,
        city: m.cityName,
        title: m.title,
        text: String(m.text || '').slice(0, 120)
      };
    });
  }
  return out;
}

function getWardrobe(args) {
  const a = args || {};
  const stats = wardrobeStore.stats();
  const catLabel = {};
  wardrobeStore.CATEGORIES.forEach(function (c) { catLabel[c.key] = c.label; });
  const seasonLabel = {};
  wardrobeStore.SEASONS.forEach(function (s) { seasonLabel[s.key] = s.label; });

  let items = wardrobeStore.list();
  if (a.category && catLabel[a.category]) {
    items = items.filter(function (i) { return i.category === a.category; });
  }
  // 选「夏」时，四季单品也算可用
  if (a.season && a.season !== 'all' && seasonLabel[a.season]) {
    items = items.filter(function (i) { return i.season === a.season || i.season === 'all'; });
  }

  const limit = clamp(a.limit, 1, 40, 20);
  return {
    total: stats.total,
    byCategory: stats.byCategory,
    matched: items.length,
    items: items.slice(0, limit).map(function (i) {
      return {
        name: i.name,
        category: catLabel[i.category] || i.category,
        season: seasonLabel[i.season] || i.season,
        color: i.color || ''
      };
    }),
    hint: stats.total ? '' : '衣橱还没有单品'
  };
}

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d;
}

function saveDiaryDraft(args) {
  const a = args || {};
  const text = String(a.text || '').trim();
  if (!text) throw new Error('日记正文为空，无法生成草稿');

  let date = String(a.date || '').trim();
  if (!validDate(date)) date = diaryStore.today();

  const existing = !!diaryStore.get(date);
  return {
    requiresConfirm: true,
    date: date,
    text: text.slice(0, 2000),
    existing: existing,
    note: existing ? '当天已有日记，用户确认后会覆盖' : '草稿已生成，等待用户确认后保存'
  };
}

const RUNNERS = {
  searchAttractions: searchAttractions,
  getFootprint: getFootprint,
  getWardrobe: getWardrobe,
  saveDiaryDraft: saveDiaryDraft
};

function isKnownTool(name) {
  return Object.prototype.hasOwnProperty.call(RUNNERS, String(name));
}

function toolLabel(name) {
  return LABELS[name] || String(name || '工具');
}

/** 执行工具；失败 reject，由调用方把错误回灌给模型 */
function runTool(name, args) {
  const fn = RUNNERS[name];
  if (!fn) return Promise.reject(new Error('未知工具：' + name));
  return new Promise(function (resolve, reject) {
    try {
      resolve(fn(args || {}));
    } catch (e) {
      reject(e);
    }
  });
}

/** 工具结果序列化为给模型看的文本，超长截断 */
function serializeResult(result) {
  let s;
  try {
    s = JSON.stringify(result);
  } catch (e) {
    s = '{"error":"结果无法序列化"}';
  }
  if (s == null) s = 'null';
  if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + '…(已截断)';
  return s;
}

/** 给页面展示的一行摘要 */
function summarize(name, result) {
  const r = result || {};
  if (name === 'searchAttractions') {
    if (r.count === undefined && r.total) return '共收录 ' + r.total + ' 个5A景区';
    const n = r.count || 0;
    const names = (r.list || []).slice(0, 3).map(function (s) { return s.name; }).join('、');
    return n ? ('找到 ' + n + ' 个景点' + (names ? '：' + names : '')) : '没有匹配的景点';
  }
  if (name === 'getFootprint') {
    const s = r.summary || {};
    return '去过 ' + (s.provinceVisited || 0) + ' 省 · ' + (s.cityVisited || 0) +
      ' 城，想去 ' + (s.want || 0) + ' 处';
  }
  if (name === 'getWardrobe') {
    const extra = r.matched !== undefined ? '，匹配 ' + r.matched + ' 件' : '';
    return '衣橱共 ' + (r.total || 0) + ' 件' + extra;
  }
  if (name === 'saveDiaryDraft') {
    return '已生成 ' + (r.date || '') + ' 的日记草稿' +
      (r.existing ? '（当天已有日记）' : '') + '，待确认';
  }
  return '已完成';
}

module.exports = {
  TOOL_SCHEMAS: TOOL_SCHEMAS,
  MAX_RESULT_CHARS: MAX_RESULT_CHARS,
  isKnownTool: isKnownTool,
  toolLabel: toolLabel,
  runTool: runTool,
  serializeResult: serializeResult,
  summarize: summarize
};
