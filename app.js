//app.js
const cb = require('./utils/cb');

App({
  /* @dev:begin */
  onLaunch(){
    const that = this
    wx.getUserInfo({
      success: (res) => {
        console.log("getUserInfo => res")
        that.globalData.userInfo = res.userInfo
        if(that.userInfoReadyCallback){
          console.log("数据传递回来了")
          that.userInfoReadyCallback(res)
        }
      },
      fail: function(){
        console.log("获取用户信息失败")
      }
    })
  },
  /* @dev:end */
  onShow(e){
    if(e.shareTicket){
      this.globalData.shareTicket = e.shareTicket
    }
  },
  globalData: {
    userInfo: null,
    shareTicket: null,
    travelFocus: '', // 足迹清单页 → 地图页的一次性定位请求（adcode）
    syncPromise: null // 登录 + 数据双向同步的 Promise，页面可等待后再渲染
  },
})

// 登录预热 → 本地数据上云 → 云端数据回灌本地
// 顺序不能颠倒：先 push 保证本机新数据不丢，再 pull 用 updatedAt 新者胜合并
var syncPromise = cb.ready()
  .then(function () {
    if (!cb.getLoginInfo().logged) return null; // 未登录不推不拉，避免产生无法归属的孤儿数据
    return migrateLocalToCloud().then(syncFromCloud);
  })
  .catch(function () { return null; /* 失败已内部降级，业务层走本地 */ });

(function attach(tries) {
  var app = getApp();
  if (app && app.globalData) { app.globalData.syncPromise = syncPromise; return; }
  if ((tries || 0) < 20) setTimeout(function () { attach((tries || 0) + 1); }, 50);
})(0);

/**
 * 云端 → 本地回灌
 * 清缓存 / 换手机后本地为空，靠这一步把数据取回来；各页面 onLoad 也会各自拉一次兜底
 */
function syncFromCloud() {
  var travelStore = require('./utils/travelStore');
  var diaryStore = require('./utils/diaryStore');
  return Promise.all([travelStore.pullCloud(), diaryStore.pullCloud()]);
}

/**
 * 一次性迁移：把本机已有的标记/日记推到云端（老用户升级后数据不丢）
 * 用 storage 标记去重，失败不写标记，下次启动重试
 */
function migrateLocalToCloud() {
  var FLAG = 'sync.pushed.v1';
  if (wx.getStorageSync(FLAG)) return Promise.resolve();
  var travelStore = require('./utils/travelStore');
  var diaryStore = require('./utils/diaryStore');

  var marks = travelStore.getAll();
  var keys = Object.keys(marks || {});
  var entries = (diaryStore.list() || []).filter(function (e) { return e && e.text; });
  if (!keys.length && !entries.length) {
    wx.setStorageSync(FLAG, 1);
    return Promise.resolve();
  }

  var jobs = [];
  keys.forEach(function (k) {
    var m = marks[k] || {};
    if (!m.status) return;
    jobs.push(cb.pushMark({
      adcode: k,
      status: m.status,
      name: m.name || '',
      center: m.center || null,
      updatedAt: m.updatedAt || Date.now()
    }));
  });
  entries.forEach(function (e) {
    jobs.push(cb.setDoc('diaries', e.date, {
      date: e.date,
      text: e.text,
      updatedAt: e.updatedAt || Date.now()
    }));
  });

  return Promise.all(jobs).then(function (rs) {
    var allOk = rs.every(function (x) { return x !== false; });
    if (allOk) {
      wx.setStorageSync(FLAG, 1);
      console.log('[migrate] 本地数据已上云：marks=' + keys.length + ' diaries=' + entries.length);
    }
  }).catch(function () { /* 保留标记缺失状态，下次重试 */ });
}