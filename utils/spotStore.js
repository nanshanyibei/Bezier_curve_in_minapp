/**
 * 景区级标记（去过 / 想去）
 *
 * 与 travelStore 的 marks（行政区维度）分开：那个回答「去过哪些城市」，
 * 这个回答「去过哪些景区」。本地 storage 即时落盘，异步推云，
 * 云端集合 spot_marks 权限「仅创建者可读写」，_openid 由云开发注入。
 *
 * 本地键 = s_<省adcode>_<名称指纹>；云端 _id = <身份键>_<本地键>，
 * 避免两人标记同一景区时 _id 撞车（集合按 _openid 隔离，但 _id 全局唯一）。
 */
const cb = require('./cb');

const KEY = 'travel.spotMarks';
const COL = 'spot_marks';

function hash(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function provOf(prov) {
  const s = String(prov || '');
  if (!/^\d{6}$/.test(s)) return '';
  return s.slice(0, 2) + '0000';
}

function keyOf(prov, name) {
  const p = provOf(prov);
  const n = String(name || '').trim();
  if (!p || !n) return '';
  return 's_' + p + '_' + hash(n);
}

/**
 * 云端 _id 必须带身份前缀。
 * 集合权限靠 _openid 隔离，但 _id 是全局唯一的：两人都标记「故宫」时，
 * 裸业务键会让后来者的 set 撞上前者的文档（权限拒绝，写入静默失败）。
 */
function cloudKeyOf(k) {
  const u = (cb.getUserKey && cb.getUserKey()) || '';
  return u ? u + '_' + k : k;
}

function loadAll() {
  let d = null;
  try { d = wx.getStorageSync(KEY); } catch (e) { d = null; }
  if (!d || typeof d !== 'object' || d.v !== 1 || !d.marks) {
    d = { v: 1, marks: {}, updatedAt: 0 };
  }
  return d;
}

function save(d) {
  d.updatedAt = Date.now();
  try { wx.setStorageSync(KEY, d); } catch (e) { /* 存不下不影响本次会话 */ }
}

/** 单个景区状态：'visited' | 'want' | '' */
function get(prov, name) {
  const k = keyOf(prov, name);
  const d = loadAll();
  return (k && d.marks[k] && d.marks[k].status) || '';
}

function getAll() {
  return loadAll().marks;
}

function stats() {
  const marks = loadAll().marks;
  let visited = 0;
  let want = 0;
  Object.keys(marks).forEach((k) => {
    if (marks[k].status === 'visited') visited++;
    else if (marks[k].status === 'want') want++;
  });
  return { visited: visited, want: want };
}

/**
 * 设置状态；status 传空串 = 取消。返回最新状态。
 * 本地立即生效，云端异步写，失败只记日志（下次 pull 会以新者胜覆盖回来）。
 */
function set(prov, name, status) {
  const k = keyOf(prov, name);
  if (!k) return '';
  const d = loadAll();
  const at = Date.now();
  if (!status) {
    delete d.marks[k];
  } else {
    d.marks[k] = { name: String(name), prov: provOf(prov), status: status, at: at };
  }
  save(d);

  // 身份键要等 ready（whoami 返回 openid）之后再算，否则会退化成设备键
  const cid = cb.ready().then(() => cloudKeyOf(k));
  if (status) {
    cid.then((id) => cb.setDoc(COL, id, { name: String(name), prov: provOf(prov), status: status, at: at }));
  } else {
    cid.then((id) => cb.removeDoc(COL, id));
  }
  return status || '';
}

/** 拉云端合并（新者胜）；返回 { changed, marks } */
function pullCloud() {
  return cb.listDocs(COL).then((docs) => {
    if (!docs || !docs.length) return { changed: false, marks: loadAll().marks };
    const d = loadAll();
    let changed = false;
    docs.forEach((doc) => {
      if (!doc || !doc.name || !doc.prov) return;
      const k = keyOf(doc.prov, doc.name);
      if (!k) return;
      const local = d.marks[k];
      const remoteAt = doc.at || 0;
      if (doc.status) {
        if (!local || (local.at || 0) < remoteAt) {
          d.marks[k] = { name: doc.name, prov: doc.prov, status: doc.status, at: remoteAt };
          changed = true;
        }
      } else if (local) {
        delete d.marks[k];
        changed = true;
      }
    });
    if (changed) save(d);
    return { changed: changed, marks: d.marks };
  }).catch(() => ({ changed: false, marks: loadAll().marks }));
}

module.exports = { KEY, COL, keyOf, get, getAll, set, stats, pullCloud };
