//index.js
Page({
  data: {
    screen_width: '',
    screen_height: '',
    leftAnimationShow: false,
    rightAnimationShow: false,
    leftAnimation: [
      'https://ss0.bdstatic.com/70cFvHSh_Q1YnxGkpoWK1HF6hhy/it/u=2510163673,100790501&fm=26&gp=0.jpg',
      'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898475146&di=856669a32a74f9cbe8b445a3930dad48&imgtype=0&src=http%3A%2F%2Fimg5.duitang.com%2Fuploads%2Fitem%2F201408%2F25%2F20140825000809_dme4E.jpeg',
      'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898475145&di=6e2fe945935753bb69541e4aca108612&imgtype=0&src=http%3A%2F%2F5b0988e595225.cdn.sohucs.com%2Fq_70%2Cc_zoom%2Cw_640%2Fimages%2F20190318%2Ff61ffcfed19c4e3aae35953ad63586d7.jpeg',
      'https://ss1.bdstatic.com/70cFvXSh_Q1YnxGkpoWK1HF6hhy/it/u=4171782178,2970106987&fm=26&gp=0.jpg',
      'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898578359&di=d1000ff22a871641636ad9bdf44e0149&imgtype=0&src=http%3A%2F%2Fimages.liqucn.com%2Fimg%2Fh1%2Fh991%2Fimg201712091054090_info400X400.jpg',
      'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898599561&di=70f04e0b84293944ce6f6626a5843a84&imgtype=0&src=http%3A%2F%2Fimages.liqucn.com%2Fimg%2Fh1%2Fh966%2Fimg201709181055480_info300X300.jpg',
      'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898638141&di=ee6ef88905af49c664ba708a03893c0a&imgtype=0&src=http%3A%2F%2Fwww.tbw-xie.com%2FtuxieJDEwLmFsaWNkbi5jb20vaTIvMjA0MDk0NzQ4MC9UQjIzUTl6c2lDWUJ1TmtTbmFWWFhjTXNWWGFfISEyMDQwOTQ3NDgwJDk.jpg',
      'https://ss1.bdstatic.com/70cFvXSh_Q1YnxGkpoWK1HF6hhy/it/u=2054029736,963620309&fm=26&gp=0.jpg'
    ],
    rightAnimation: [
      {
        avatar: 'https://timgsa.baidu.com/timg?image&quality=80&size=b10000_10000&sec=1564888769&di=c74fc6d965d1ab989c38dd84aa58c1fc&src=http://www.ghost64.com/qqtupian/zixunImg/local/2016/12/09/14812558367740.jpg',
        text: '不知道发什么评论，反正我是凑字数的'
      },{
        avatar: 'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898724316&di=a626e0a36343d432a99130823b633d67&imgtype=0&src=http%3A%2F%2Fuploads.xuexila.com%2Fallimg%2F1609%2F676-160ZG51427-50.jpg',
        text: '楼上好，我也是凑字数的'
      },{
        avatar: 'https://ss2.bdstatic.com/70cFvnSh_Q1YnxGkpoWK1HF6hhy/it/u=4003613396,4254608602&fm=26&gp=0.jpg',
        text: '这么巧，看来大家都是凑字数的哈'
      },{
        avatar: 'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1564898801280&di=7924a3351d146fa0fbe2fd84b2d08af3&imgtype=0&src=http%3A%2F%2Fimg.duoziwang.com%2F2016%2F09%2F02%2F0827558796.jpg',
        text: '来一个超长内容，啊啊啊啊啊啊啊啊啊啊啊啊，还是不知道说啥'
      },{
        avatar: 'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1565493539&di=565a82ca5035c11bb1a313179fbeeb77&imgtype=jpg&er=1&src=http%3A%2F%2Fimg.duoziwang.com%2Fuploads%2F1707%2F1-1FG02204080-L.jpg',
        text: '一二三四五六七，七六五四三二一'
      },{
        avatar: 'https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1565493555&di=8aa6df0e8d717894abf672a1e4b51fe3&imgtype=jpg&er=1&src=http%3A%2F%2Fimg.duoziwang.com%2Fuploads%2F1512%2F1-1512261603200-L.jpg',
        text: '一二三四，二二三四，三二三四，四二三四，五五六六，七七八八'
      }
    ]
  },
  onReady(){
    this.tempPath = ''
    this.leftCounter = 0
    this.rightCounter = 0
    setTimeout(() => {
      this.setData({
        leftAnimationShow: true
      })
    }, 1000)

  },
  onLoad(){
    this.model = ''
    this.screen_width = ''
    this.screen_height = ''
    this.avatarUrl = ''
    this.nickName = ''
    this.resTempPath = ''
    const that = this
    wx.getSystemInfo({
      success: function(res){
        that.setData({
          screen_width: res.windowWidth / 375,
          screen_height: res.windowHeight
        })
        that.model = res.model        
      }
    })
    wx.getUserInfo({
      success(res){
        that.nickName = res.userInfo.nickName
        that.avatarUrl = res.userInfo.avatarUrl
        that.generateImage()
      }
    })
  },
  generateImage(){
    const ctx = wx.createCanvasContext('myCanvas')
    let rpx = this.data.screen_width
    ctx.fillStyle = "#000000"
    ctx.setFontSize(15 * rpx)
    ctx.font = 'normal 400 Source Han Sans CN'
    ctx.fillText(this.nickName, 10 * rpx, 110 * rpx)
    let that = this
    wx.downloadFile({
      url: this.avatarUrl,
      success: (res) => {
        ctx.save()
        ctx.beginPath()
        ctx.arc(45 * rpx, 45 * rpx, 35 * rpx, 0, Math.PI * 2, false)
        ctx.clip()        
        ctx.drawImage(res.tempFilePath, 10 * rpx, 10 * rpx, 80 * rpx, 80 * rpx)
        ctx.restore()
        ctx.draw()
        wx.canvasToTempFilePath({
          canvasId: 'myCanvas',
          success: function (res) {
            that.resTempPath = res.tempFilePath
          },
          fail: function (res) {
            console.log(res);
          }
        })
      }
    })    
  },
  onShareAppMessage(){
    wx.showShareMenu({
      withShareTicket: true
    })
    const resImageUrl = this.resTempPath ? this.resTempPath : "http://pic13.nipic.com/20110409/7119492_114440620000_2.jpg"
    return {
      title: '雷佳佳的小程序',
      path: 'pages/share/share?test=111',
      imageUrl: resImageUrl
    }
  },
  rightAnimationEnd(e){
    if (e.currentTarget.dataset.index === this.data.rightAnimation.length - 1) {
      this.setData({
        rightAnimationShow: false
      })
      if (this.rightCounter < 3) {
        setTimeout(() => {
          this.setData({
            rightAnimationShow: true
          })
          this.rightCounter ++
        }, 2000)
      } else {
        this.setData({
          rightAnimationShow: false
        })
      }
    }
  },
  leftAnimationEnd(e){
    if (e.currentTarget.dataset.index === this.data.leftAnimation.length - 1) {
      this.setData({
        leftAnimationShow: false
      })
      if (this.leftCounter < 5) {
        this.setData({
          leftAnimationShow: true
        })
        this.leftCounter ++
      } else {
        this.setData({
          rightAnimationShow: true,
          leftAnimationShow: false
        })
        this.rightCounter ++
      }
    }
  }
})