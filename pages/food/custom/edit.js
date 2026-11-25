const foodStore = require('../../../utils/foodStore');

const EMOJI_CHOICES = ['🥗', '🍳', '🥘', '🍲', '🥟', '🍖', '🍗', '🥩', '🥬', '🥔', '🍆', '🌶️', '🐟', '🦐', '🦆', '🥣', '🍜', '🍚', '🍳', '🫑', '🧈', '🍄', '🥒'];

Page({
  data: {
    isEdit: false,
    id: '',
    name: '',
    emoji: '🥗',
    emojiList: EMOJI_CHOICES,
    allTags: [],
    selectedTags: [],
    difficulty: 1,
    timeMinutes: '',
    ingredientsText: '',
    stepsText: '',
    saved: false
  },

  onLoad(options) {
    this.setData({ allTags: foodStore.getAllTags() });
    if (options.id) {
      const dish = foodStore.getDishById(options.id);
      if (dish) {
        this.setData({
          isEdit: true,
          id: dish.id,
          name: dish.name,
          emoji: dish.emoji || '🥗',
          selectedTags: dish.tags || [],
          difficulty: dish.difficulty || 1,
          timeMinutes: dish.timeMinutes ? String(dish.timeMinutes) : '',
          ingredientsText: (dish.ingredients || []).join('\n'),
          stepsText: (dish.steps || []).join('\n')
        });
        wx.setNavigationBarTitle({ title: '编辑菜品' });
      }
    }
  },

  onInputName(e) { this.setData({ name: e.detail.value }); },
  onInputTime(e) { this.setData({ timeMinutes: e.detail.value }); },
  onInputIngredients(e) { this.setData({ ingredientsText: e.detail.value }); },
  onInputSteps(e) { this.setData({ stepsText: e.detail.value }); },

  onPickEmoji(e) {
    this.setData({ emoji: e.currentTarget.dataset.emoji });
  },

  onToggleTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const list = this.data.selectedTags.slice();
    const idx = list.indexOf(tag);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(tag);
    this.setData({ selectedTags: list });
  },

  onSetDifficulty(e) {
    this.setData({ difficulty: Number(e.currentTarget.dataset.val) });
  },

  onSave() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '请先输入菜名', icon: 'none' });
      return;
    }

    const ingredients = this.data.ingredientsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const steps = this.data.stepsText.split('\n').map((s) => s.trim()).filter(Boolean);
    const timeMinutes = Number(this.data.timeMinutes) || 30;

    const payload = {
      name: name,
      emoji: this.data.emoji,
      tags: this.data.selectedTags,
      difficulty: this.data.difficulty,
      timeMinutes: timeMinutes,
      ingredients: ingredients,
      steps: steps
    };

    if (this.data.isEdit) {
      foodStore.updateCustomDish(this.data.id, payload);
      wx.showToast({ title: '已更新', icon: 'success' });
    } else {
      foodStore.addCustomDish(payload);
      wx.showToast({ title: '已添加 ✓', icon: 'success' });
    }

    this.setData({ saved: true });
    setTimeout(() => { wx.navigateBack(); }, 800);
  },

  onDelete() {
    if (!this.data.isEdit) return;
    wx.showModal({
      title: '删除这道菜？',
      content: '删除后不可恢复',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (res.confirm) {
          foodStore.removeCustomDish(this.data.id);
          wx.showToast({ title: '已删除', icon: 'none' });
          setTimeout(() => { wx.navigateBack(); }, 600);
        }
      }
    });
  }
});
