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
    shareTicket: null
  },
})

// 登录预热 + 首次本地数据上云
cb.ready().then(function () {
  if (!cb.getLoginInfo().logged) return; // 未登录不推送，避免产生无法归属的孤儿数据
  migrateLocalToCloud();
}).catch(function () { /* 失败已内部降级，业务层走本地 */ });

/**
 * 一次性迁移：把本机已有的标记/日记推到云端（老用户升级后数据不丢）
 * 用 storage 标记去重，失败不写标记，下次启动重试
 */
function migrateLocalToCloud() {
  var FLAG = 'sync.pushed.v1';
  if (wx.getStorageSync(FLAG)) return;
  var travelStore = require('./utils/travelStore');
  var diaryStore = require('./utils/diaryStore');

  var marks = travelStore.getAll();
  var keys = Object.keys(marks || {});
  var entries = (diaryStore.list() || []).filter(function (e) { return e && e.text; });
  if (!keys.length && !entries.length) {
    wx.setStorageSync(FLAG, 1);
    return;
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

  Promise.all(jobs).then(function (rs) {
    var allOk = rs.every(function (x) { return x !== false; });
    if (allOk) {
      wx.setStorageSync(FLAG, 1);
      console.log('[migrate] 本地数据已上云：marks=' + keys.length + ' diaries=' + entries.length);
    }
  }).catch(function () { /* 保留标记缺失状态，下次重试 */ });
}