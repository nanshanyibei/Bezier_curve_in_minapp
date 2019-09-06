//index.js
let app = getApp()

Page({
  data: {
    userInfo: app.globalData.userInfo
  },
  onReady(){
  },
  onLoad: function(options) {
    const that = this
    console.log(app.globalData)
    app.userInfoReadyCallback = function(){
      console.log("fasdjfs", app.globalData)
      that.setData({
        userInfo: app.globalData.userInfo
      })
    }
  },
})