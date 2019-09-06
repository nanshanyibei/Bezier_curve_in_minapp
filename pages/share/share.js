//index.js
let app = getApp()

Page({
  data: {
    userInfo: ''
  },
  onReady(){
  },
  onLoad: function(options) {
    console.log(options)
    const that = this
    app.userInfoReadyCallback = function(){
      that.setData({
        userInfo: app.globalData.userInfo
      })
      console.log("onLoad", app)
    }
  },
})