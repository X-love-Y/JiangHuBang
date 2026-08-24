// drafts —— 草稿箱：两个视图
//   草稿：列表 + 立即发布 + 删除 + 加入委托链
//   委托链：按链分组管理（改序号重排/改触发方式/改定时/移出链/改总步数/解散链）
const { call, callWithToast } = require('../../utils/api');
const { formatAmount, formatDateTime } = require('../../utils/format');

const STATUS_TEXT = {
  draft: '草稿',
  scheduled: '定时中',
  waiting: '链中等待',
  ready: '待确认',
  published: '已发布',
  skipped: '已跳过',
  failed: '发布失败',
  cancelled: '已作废'
};
const STATUS_BADGE = {
  draft: 'badge--ink',
  scheduled: 'badge--info',
  waiting: 'badge--info',
  ready: 'badge--gold',
  published: 'badge--success',
  skipped: 'badge--cinnabar',
  failed: 'badge--cinnabar',
  cancelled: 'badge--ink'
};

const TRIGGER_TEXT = { auto: '🤖 自动', manual: '👆 需确认', pause: '⏸ 停留' };

Page({
  data: { tab: 'draft', list: [], chains: [], histories: [], loading: false },

  onShow() {
    this.fetch();
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  fetch() {
    this.setData({ loading: true });
    Promise.all([
      call('draft', { action: 'list' }).catch(() => ({ list: [] })),
      call('draft', { action: 'chainHistory' }).catch(() => ({ list: [] }))
    ])
      .then(([data, hist]) => {
        const list = (data.list || []).map((d) => Object.assign({}, d, {
          statusText: STATUS_TEXT[d.status] || d.status,
          statusBadge: STATUS_BADGE[d.status] || 'badge--ink',
          amountText: formatAmount(d.amount, d.currency),
          scheduledText: d.scheduledAt ? formatDateTime(d.scheduledAt) : '',
          isPublic: d.mode === 'public',
          triggerText: TRIGGER_TEXT[d.chain && d.chain.trigger] || '',
          canPublish: ['draft', 'ready', 'failed', 'skipped', 'waiting'].includes(d.status),
          canDelete: ['draft', 'scheduled', 'failed', 'waiting', 'ready', 'skipped'].includes(d.status)
        }));
        const histories = (hist.list || []).map((h) => Object.assign({}, h, {
          disbandedText: formatDateTime(h.disbandedAt),
          stepsSummary: (h.steps || []).slice(0, 6).map((s) => `${s.seq}.${s.title}`).join('  ')
        }));
        this.setData({ list, chains: this.groupChains(list), histories });
      })
      .finally(() => this.setData({ loading: false }));
  },

  // 按链分组（含已作废步骤，便于清理）
  groupChains(list) {
    const map = {};
    list.forEach((d) => {
      if (!d.chain || !d.chain.chainId) return;
      if (!map[d.chain.chainId]) {
        map[d.chain.chainId] = { chainId: d.chain.chainId, total: d.chain.total, steps: [] };
      }
      map[d.chain.chainId].steps.push(d);
    });
    return Object.values(map).map((c) => {
      c.steps.sort((a, b) => (a.chain.seq || 0) - (b.chain.seq || 0));
      const active = c.steps.filter((s) => s.status !== 'cancelled');
      c.total = Math.max(c.total || 0, ...active.map((s) => s.chain.seq || 0));
      c.publishedCount = active.filter((s) => s.status === 'published').length;
      return c;
    });
  },

  // ===== 草稿操作 =====
  publishDraft(e) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || '';
    wx.showModal({
      title: '发布草稿',
      content: `确定立即发布「${title}」？金额将按委托托管扣款。`,
      confirmText: '发布',
      success: (res) => {
        if (res.confirm) {
          callWithToast('draft', { action: 'publish', draftId: id }, { loading: true, loadingText: '发布中…' })
            .then(() => {
              wx.showToast({ title: '发布成功', icon: 'success' });
              this.fetch();
            })
            .catch(() => {});
        }
      }
    });
  },

  removeDraft(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除草稿',
      content: '删除后不可恢复，确定删除？',
      confirmText: '删除',
      success: (res) => {
        if (res.confirm) {
          callWithToast('draft', { action: 'delete', draftId: id }, { loading: true })
            .then(() => this.fetch())
            .catch(() => {});
        }
      }
    });
  },

  // 加入委托链：三步弹窗（选链 → 序号/总步数 → 触发方式）
  openChain(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.list.find((x) => x._id === id);
    if (!d) return;
    const chains = [];
    this.data.list.forEach((x) => {
      if (x.chain && x.chain.chainId && !chains.some((c) => c.chainId === x.chain.chainId)) {
        chains.push({ chainId: x.chain.chainId, total: x.chain.total });
      }
    });
    const items = ['🔗 新建委托链（编号自动生成）']
      .concat(chains.map((c) => `加入已有链 ${c.chainId}（共 ${c.total} 步）`));
    wx.showActionSheet({
      itemList: items,
      success: (res1) => {
        const isNew = res1.tapIndex === 0;
        const picked = isNew ? null : chains[res1.tapIndex - 1];
        wx.showModal({
          title: isNew ? '新链：第 1 步 / 总步数' : '序号 / 总步数',
          editable: true,
          placeholderText: isNew ? '如 1/3（这是链的第 1 单）' : '如 2/5（第 2 单，共 5 单）',
          confirmText: '下一步',
          success: (res2) => {
            if (!res2.confirm) return;
            const parts = String(res2.content || '').split('/');
            const seq = Number(parts[0]);
            const total = Number(parts[1]);
            if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1 || seq > total || total > 100) {
              return wx.showToast({ title: '格式：序号/总步数（如 2/5）', icon: 'none' });
            }
            if (isNew && seq !== 1) return wx.showToast({ title: '新链的第一单请填 1/总步数', icon: 'none' });
            if (!isNew && picked && total !== picked.total) {
              return wx.showToast({ title: `该链共 ${picked.total} 步，请保持一致`, icon: 'none' });
            }
            wx.showActionSheet({
              itemList: [
                '🤖 自动（上一步结算后自动上架）',
                '👆 需确认（通知你确认后发布）'
              ],
              success: (res3) => {
                const trigger = res3.tapIndex === 0 ? 'auto' : 'manual';
                callWithToast('draft', {
                  action: 'chainSet', draftId: id,
                  chain: { chainId: isNew ? undefined : picked.chainId, seq, total, trigger }
                }, { loading: true })
                  .then((r) => {
                    wx.showToast({ title: `已加入链 ${r.chainId}（第 ${seq} 步）`, icon: 'none' });
                    this.fetch();
                  })
                  .catch(() => {});
              }
            });
          }
        });
      }
    });
  },

  // ===== 链管理操作 =====
  changeSeq(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.list.find((x) => x._id === id);
    if (!d || !d.chain) return;
    wx.showModal({
      title: '修改序号（重排）',
      editable: true,
      content: String(d.chain.seq),
      placeholderText: `新序号（1-${d.chain.total} 的整数）`,
      confirmText: '修改',
      success: (res) => {
        if (!res.confirm) return;
        const seq = Number(res.content);
        if (!Number.isInteger(seq) || seq < 1 || seq > d.chain.total) {
          return wx.showToast({ title: `序号需在 1-${d.chain.total} 之间`, icon: 'none' });
        }
        callWithToast('draft', { action: 'chainUpdate', draftId: id, patch: { seq } }, { loading: true })
          .then(() => this.fetch())
          .catch(() => {});
      }
    });
  },

  changeTrigger(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.list.find((x) => x._id === id);
    if (!d || !d.chain) return;
    wx.showActionSheet({
      itemList: [
        '🤖 自动（上一步结算后自动上架）',
        '👆 需确认（通知你确认后发布）'
      ],
      success: (res) => {
        const trigger = res.tapIndex === 0 ? 'auto' : 'manual';
        callWithToast('draft', {
          action: 'chainUpdate', draftId: id, patch: { trigger }
        }, { loading: true })
          .then(() => this.fetch())
          .catch(() => {});
      }
    });
  },

  // 交换序号：列出同链其他可交换的步骤
  changeSwap(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.list.find((x) => x._id === id);
    if (!d || !d.chain) return;
    const others = this.data.list.filter((x) =>
      x.chain && x.chain.chainId === d.chain.chainId &&
      x._id !== id && !['published', 'cancelled'].includes(x.status)
    );
    if (!others.length) return wx.showToast({ title: '没有其他可交换的步骤', icon: 'none' });
    wx.showActionSheet({
      itemList: others.map((x) => `与第 ${x.chain.seq} 步「${x.title}」交换`),
      success: (res) => {
        const other = others[res.tapIndex];
        callWithToast('draft', {
          action: 'chainSwap', draftId: id, withSeq: other.chain.seq
        }, { loading: true })
          .then(() => {
            wx.showToast({ title: '已交换顺序', icon: 'success' });
            this.fetch();
          })
          .catch(() => {});
      }
    });
  },

  restoreChain(e) {
    const chainId = e.currentTarget.dataset.chain;
    wx.showModal({
      title: '恢复历史链',
      content: '链内未删除的草稿将按原序号恢复，确定恢复？',
      confirmText: '恢复',
      success: (res) => {
        if (res.confirm) {
          callWithToast('draft', { action: 'chainRestore', chainId }, { loading: true })
            .then((r) => {
              const skipped = (r.skipped || []).join('；');
              wx.showToast({
                title: `已恢复 ${r.restored} 步${skipped ? '，跳过：' + skipped : ''}`,
                icon: 'none'
              });
              this.fetch();
            })
            .catch(() => {});
        }
      }
    });
  },

  changeSchedule(e) {
    const id = e.currentTarget.dataset.id;
    const d = this.data.list.find((x) => x._id === id);
    if (!d) return;
    wx.showModal({
      title: '修改定时发布时间',
      editable: true,
      content: d.scheduledText ? `${d.scheduledText}` : '',
      placeholderText: '格式 2026-08-25 14:30；留空取消定时',
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return;
        const v = String(res.content || '').trim();
        const patch = {};
        if (!v) {
          patch.scheduledAt = null;
        } else {
          const t = new Date(v.replace(/-/g, '/')).getTime();
          if (isNaN(t)) return wx.showToast({ title: '格式：2026-08-25 14:30', icon: 'none' });
          if (t <= Date.now()) return wx.showToast({ title: '时间需晚于当前', icon: 'none' });
          patch.scheduledAt = t;
        }
        callWithToast('draft', { action: 'chainUpdate', draftId: id, patch }, { loading: true })
          .then(() => this.fetch())
          .catch(() => {});
      }
    });
  },

  removeFromChain(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '移出委托链',
      content: '该草稿将移出链（不删除，变回普通草稿）',
      confirmText: '移出',
      success: (res) => {
        if (res.confirm) {
          callWithToast('draft', { action: 'chainUpdate', draftId: id, patch: { clearChain: true } }, { loading: true })
            .then(() => this.fetch())
            .catch(() => {});
        }
      }
    });
  },

  changeTotal(e) {
    const chainId = e.currentTarget.dataset.chain;
    const c = this.data.chains.find((x) => x.chainId === chainId);
    if (!c) return;
    wx.showModal({
      title: '修改链总步数',
      editable: true,
      content: String(c.total),
      placeholderText: '新的总步数（1-100）',
      confirmText: '修改',
      success: (res) => {
        if (!res.confirm) return;
        const total = Number(res.content);
        if (!Number.isInteger(total) || total < 1 || total > 100) {
          return wx.showToast({ title: '总步数需为 1-100 的整数', icon: 'none' });
        }
        callWithToast('draft', { action: 'chainUpdateTotal', chainId, total }, { loading: true })
          .then(() => this.fetch())
          .catch(() => {});
      }
    });
  },

  disbandChain(e) {
    const chainId = e.currentTarget.dataset.chain;
    wx.showModal({
      title: '解散委托链',
      content: '链内未发布的草稿将移出链（已发布的委托保留历史），确定解散？',
      confirmText: '解散',
      success: (res) => {
        if (res.confirm) {
          callWithToast('draft', { action: 'chainDisband', chainId }, { loading: true })
            .then(() => this.fetch())
            .catch(() => {});
        }
      }
    });
  }
});
