//app.js

App({
  onLaunch(){
    const that = this
    wx.getUserInfo({
      success: (res) => {
        that.globalData.userInfo = res.userInfo
        if(that.userInfoReadyCallback){
          that.userInfoReadyCallback(res)
        }
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