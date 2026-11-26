// 从 Wikimedia Commons 搜索候选图片（临时脚本，用完删除）
const { execFileSync } = require('child_process');

const PROXY = 'http://127.0.0.1:7897';
const UA = 'nanshan-walk-content-bot/1.0 (https://github.com/nanshanyibei/Bezier_curve_in_minapp)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url) {
  const out = execFileSync('curl.exe', ['-s', '-m', '30', '-x', PROXY, '-A', UA, url], { maxBuffer: 20 * 1024 * 1024 });
  return out.toString('utf8');
}

const fs = require('fs');
const CACHE = 'scripts/.commons-cache.json';
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { cache = {}; }

async function getJson(url) {
  if (cache[url]) return cache[url];
  for (let i = 0; i < 4; i++) {
    const t = get(url);
    if (t.trim().startsWith('{')) {
      const j = JSON.parse(t);
      cache[url] = j;
      fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
      return j;
    }
    console.log('    (限流，等待重试...)');
    await sleep(6000 * (i + 1));
  }
  throw new Error('非 JSON 响应（可能被限流）');
}

function strip(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function search(term, limit = 6) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&generator=search&gsrnamespace=6&gsrlimit=' + limit
    + '&gsrsearch=' + encodeURIComponent(term)
    + '&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900';
  const j = await getJson(u);
  await sleep(1200);
  if (!j.query || !j.query.pages) return [];
  return Object.values(j.query.pages).map((p) => {
    const ii = (p.imageinfo && p.imageinfo[0]) || {};
    const md = ii.extmetadata || {};
    return {
      title: p.title,
      index: p.index,
      mime: ii.mime,
      w: ii.width,
      h: ii.height,
      thumb: ii.thumburl,
      page: ii.descriptionurl,
      license: strip(md.LicenseShortName && md.LicenseShortName.value),
      artist: strip(md.Artist && md.Artist.value),
    };
  }).filter((x) => x.mime && (x.mime === 'image/jpeg' || x.mime === 'image/png'))
    .sort((a, b) => (a.index || 0) - (b.index || 0));
}

const SPOTS = [
  ['太昊伏羲陵文化旅游区', ['太昊陵', 'Taihao Mausoleum']],
  ['鸡公山景区', ['鸡公山', 'Jigong Mountain']],
  ['八里沟景区', ['八里沟', 'Baligou']],
  ['红旗渠－太行大峡谷旅游景区', ['红旗渠', 'Red Flag Canal', '太行大峡谷']],
  ['嵖岈山旅游景区', ['嵖岈山', 'Chaya Mountain']],
  ['西峡恐龙遗迹园-伏牛山-老界岭旅游区', ['伏牛山', 'Funiu Mountains', '老界岭']],
  ['龙潭大峡谷景区', ['龙潭大峡谷', 'Longtan Grand Canyon']],
  ['老君山－鸡冠洞旅游区', ['老君山', 'Laojun Mountain', '鸡冠洞']],
  ['尧山－中原大佛景区', ['中原大佛', 'Spring Temple Buddha', '尧山']],
  ['清明上河园景区', ['清明上河园', 'Qingming Riverside Landscape Garden']],
  ['嵩山少林景区', ['少林寺', 'Shaolin Monastery']],
  ['宝泉旅游区', ['宝泉', 'Baoquan']],
  ['芒砀山汉文化旅游景区', ['芒砀山', 'Mangdang Mountain']],
  ['白云山景区', ['白云山 洛阳', 'Baiyun Mountain Luoyang']],
  ['殷墟景区', ['殷墟', 'Yinxu']],
  ['云台山－神农山－青天河风景区', ['云台山', 'Yuntaishan', '神农山', '青天河']],
  ['龙门石窟景区', ['龙门石窟', 'Longmen Grottoes']],
];

(async () => {
  const out = [];
  for (const [name, terms] of SPOTS) {
    console.log('\n=== ' + name + ' ===');
    const all = [];
    for (const t of terms) {
      let list = [];
      try { list = await search(t); } catch (e) { console.log('  ! ' + t + ' err ' + e.message); continue; }
      if (!list.length) { console.log('  [' + t + '] 无结果'); continue; }
      console.log('  [' + t + ']');
      list.slice(0, 4).forEach((c) => {
        console.log('    - ' + c.title + ' | ' + c.w + 'x' + c.h + ' | ' + c.license + ' | ' + c.artist.slice(0, 40));
      });
      all.push({ term: t, list });
    }
    out.push({ name, all });
  }
  require('fs').writeFileSync('scripts/.commons-henan.json', JSON.stringify(out, null, 1), 'utf8');
})();
