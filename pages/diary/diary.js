const diaryStore = require('../../utils/diaryStore');

Page({
  data: {
    today: '',
    selectedDate: '',
    content: '',
    entries: [],
    stats: { count: 0, chars: 0 },
    editing: false // 编辑的是否为历史日记
  },

  onLoad() {
    const t = diaryStore.today();
    this.setData({
      today: t,
      selectedDate: t,
      content: diaryStore.get(t) || ''
    });
  },

  onShow() {
    this.setData({
      entries: diaryStore.list(),
      stats: diaryStore.stats()
    });
    this.pullCloud();
  },

  /** 拉云端日记并合并（换手机/重装后靠这一步认回） */
  pullCloud() {
    diaryStore.pullCloud().then((r) => {
      if (!r || !r.changed) return;
      const patch = {
        entries: diaryStore.list(),
        stats: diaryStore.stats()
      };
      // 当前编辑框为空时用云端内容补上，避免覆盖正在输入的文字
      if (!this.data.content) {
        const cur = diaryStore.get(this.data.selectedDate);
        if (cur) patch.content = cur;
      }
      this.setData(patch);
    }).catch(() => { /* 云端不可用时用本地 */ });
  },

  onDateChange(e) {
    const date = e.detail.value;
    this.setData({
      selectedDate: date,
      content: diaryStore.get(date) || '',
      editing: date !== this.data.today
    });
  },

  onInput(e) {
    this.setData({ content: e.detail.value });
  },

  onSave() {
    const d = this.data;
    if (!d.content.trim()) {
      wx.showToast({ title: '内容为空', icon: 'none' });
      return;
    }
    diaryStore.save(d.selectedDate, d.content);
    this.setData({
      entries: diaryStore.list(),
      stats: diaryStore.stats()
    });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  onPickEntry(e) {
    const date = e.currentTarget.dataset.date;
    this.setData({
      selectedDate: date,
      content: diaryStore.get(date) || '',
      editing: date !== this.data.today
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /* @dev:begin */
  onAnalyze(e) {
    const days = Number(e.currentTarget.dataset.days) || 7;
    const notes = diaryStore.getRange(days);
    if (!notes.length) {
      wx.showToast({ title: '这个范围内还没有日记', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/insight/insight?days=' + days
    });
  },
  /* @dev:end */

  onDelete(e) {
    const date = e.currentTarget.dataset.date;
    wx.showModal({
      title: '删除日记',
      content: '确定删除 ' + date + ' 的日记？',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (res.confirm) {
          diaryStore.save(date, '');
          this.setData({
            entries: diaryStore.list(),
            stats: diaryStore.stats(),
            content: this.data.selectedDate === date ? '' : this.data.content
          });
        }
      }
    });
  }
});
