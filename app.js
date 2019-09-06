//app.js

App({
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