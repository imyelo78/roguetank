import { RARITY } from './upgrades.js';
import { CHASSIS_LIST } from './chassis.js';
import { loadCallsign, saveCallsign, todayKey, fetchSummary, fetchDay } from './daily.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.app = $('app');
    this.crosshair = $('crosshair');
    this.hud = $('hud');
    this.vignette = $('vignette');

    this.hpFill = $('hp-fill');
    this.hpGhost = $('hp-ghost');
    this.hpText = $('hp-text');
    this.waveEl = $('wave');
    this.leftEl = $('left');
    this.killsEl = $('kills');
    this.scoreEl = $('score');
    this.chipsEl = $('chips');
    this.reloadFill = $('reload-fill');
    this.msg = $('center-msg');

    this.overlay = $('overlay');
    this.bestBox = $('best');
    this.bestText = $('best-text');

    this.reward = $('reward');
    this.rewardWave = $('reward-wave');
    this.rewardTitle = $('reward-title');
    this.rewardSub = $('reward-sub');
    this.cards = $('cards');

    this.weaponIcon = $('weapon-icon');
    this.weaponName = $('weapon-name');
    this.weaponTag = $('weapon-tag');
    this.heatRow = $('heat-row');
    this.heatFill = $('heat-fill');

    this.bossBar = $('boss-bar');
    this.bossName = $('boss-name');
    this.bossHpText = $('boss-hp-text');
    this.bossFill = $('boss-fill');
    this._bossKind = null;

    this.modifierEl = $('modifier');

    this.gameover = $('gameover');
    this.finalWave = $('final-wave');
    this.finalKills = $('final-kills');
    this.finalScore = $('final-score');
    this.finalTime = $('final-time');
    this.newRecord = $('new-record');
    this.bestLine = $('best-line');
    this.lb = $('lb');
    this.lbList = $('lb-list');
    this.lbTitle = $('lb-title');

    // 呼号
    this.callsignEl = $('callsign');
    if (this.callsignEl) this.callsignEl.value = loadCallsign();
    this.callsignErr = $('callsign-err');

    // 排行榜面板
    this.lbPanel = $('lb-panel');
    this.lbBody = $('lb-body');
    this.lbSub = $('lb-sub');
    this.lbSource = $('lb-source');
    this.lbTabButtons = Array.from(document.querySelectorAll('.lb-tab[data-view]'));
    this._lbView = 'day';
    this._lbDate = '';
    this._lbAll = [];
    this._lbDays = [];

    this.msgTimer = 0;
    this._pickHandler = null;
    this._weaponHandler = null;
    this._panelKind = 'upgrade';

    // 车体选择
    this.chassisEl = $('chassis-cards');
    this.selectedChassis = 'balanced';
    this.renderChassis();
  }

  /** 渲染开始菜单的车体选择卡（1~4 或点击） */
  renderChassis() {
    if (!this.chassisEl) return;
    this.chassisEl.innerHTML = '';
    CHASSIS_LIST.forEach((c, i) => {
      const perk = c.perks?.damageTakenMul
        ? `受伤 -${Math.round((1 - c.perks.damageTakenMul) * 100)}%`
        : c.perks?.killHeal
          ? `击杀回甲 +${c.perks.killHeal}`
          : '无特性';
      const btn = document.createElement('button');
      btn.className = 'chassis-card' + (c.id === this.selectedChassis ? ' sel' : '');
      btn.dataset.id = c.id;
      btn.innerHTML = `
        <span class="chassis-key">${i + 1}</span>
        <span class="chassis-icon">${c.icon}</span>
        <b>${c.name}</b>
        <i>装甲 ${c.hp} · 移速 ${c.speed}</i>
        <em>${c.tag} · ${perk}</em>
      `;
      btn.addEventListener('click', () => this.selectChassis(i));
      this.chassisEl.appendChild(btn);
    });
  }

  selectChassis(index) {
    const c = CHASSIS_LIST[index];
    if (!c) return;
    this.selectedChassis = c.id;
    for (const el of this.chassisEl.children) {
      el.classList.toggle('sel', el.dataset.id === c.id);
    }
  }

  /** 呼号校验提示 */
  setCallsignError(msg) {
    if (!this.callsignErr) return;
    this.callsignErr.textContent = msg || '';
    this.callsignErr.classList.toggle('hidden', !msg);
  }

  // ---------------- 排行榜面板 ----------------

  /** 打开排行榜：默认今日，可切总榜 / 历史每日 */
  async openLeaderboard() {
    if (!this.lbPanel) return;
    this.lbPanel.classList.remove('hidden');
    this._lbView = 'day';
    this._lbDate = todayKey();
    this.lbTabButtons?.forEach((b) => b.classList.toggle('sel', b.dataset.view === 'day'));
    this.lbSub.textContent = this._lbDate;
    this.lbBody.innerHTML = '<li class="lb-empty">读取中…</li>';

    const [summary] = await Promise.all([fetchSummary()]);
    this._lbDays = summary.days || [];
    this.lbSource.textContent = summary.remote ? '全服' : '本机（未绑定 KV）';
    this.renderDayBoard();
  }

  closeLeaderboard() {
    this.lbPanel?.classList.add('hidden');
  }

  async renderDayBoard() {
    if (!this._lbDate) return;
    this.lbSub.textContent = this._lbDate;
    const { list, remote } = await fetchDay(this._lbDate);
    this.lbSource.textContent = remote ? '全服' : '本机（未绑定 KV）';
    this.renderBoardList(list || [], `${this._lbDate} 战绩`);
  }

  renderSummaryBoard() {
    this.lbSub.textContent = '全部历史';
    this.renderBoardList(this._lbAll || [], '历史总榜', true);
  }

  renderHistoryBoard() {
    const days = this._lbDays || [];
    this.lbSub.textContent = `${days.length} 天有战绩`;
    this.lbBody.innerHTML = '';
    if (days.length === 0) {
      this.lbBody.innerHTML = '<li class="lb-empty">还没有任何战绩</li>';
      return;
    }
    days.forEach((d, i) => {
      const li = document.createElement('li');
      li.className = 'lb-day';
      li.innerHTML = `<i>${i + 1}</i><b>${d}</b><span>查看当日战绩</span>`;
      li.addEventListener('click', () => {
        this._lbDate = d;
        this._lbView = 'day';
        this.lbTabButtons?.forEach((b) => b.classList.toggle('sel', b.dataset.view === 'day'));
        this.renderDayBoard();
      });
      this.lbBody.appendChild(li);
    });
  }

  renderBoardList(list, title = '', overall = false) {
    this.lbBody.innerHTML = '';
    if (!list || list.length === 0) {
      this.lbBody.innerHTML = `<li class="lb-empty">${title}暂无记录</li>`;
      return;
    }
    const me = (loadCallsign() || '').trim();
    list.slice(0, 20).forEach((e, i) => {
      const li = document.createElement('li');
      if (me && e.name === me) li.className = 'me';
      li.innerHTML = `<i>${i + 1}</i><b>${e.name}</b><span>第 ${e.wave} 波</span><em>${e.score}</em>`;
      this.lbBody.appendChild(li);
    });
  }

  bind({ onStart, onDaily, onRestart, onPick, onWeapon }) {
    // 开局强制填写呼号：空值就地提示，不弹窗打断
    const ensureName = () => {
      const name = (this.callsignEl?.value || '').trim();
      if (name) {
        saveCallsign(name);
        this.setCallsignError('');
        return name;
      }
      this.setCallsignError('先填一个呼号再出击');
      this.callsignEl?.focus();
      this.callsignEl?.classList.add('shake');
      setTimeout(() => this.callsignEl?.classList.remove('shake'), 420);
      return null;
    };

    $('start-btn').addEventListener('click', () => {
      const name = ensureName();
      if (name) onStart(this.selectedChassis, { name });
    });
    if ($('daily-btn')) {
      $('daily-btn').addEventListener('click', () => {
        const name = ensureName();
        if (name) onStart(this.selectedChassis, { daily: true, name });
      });
    }
    if (this.callsignEl) {
      this.callsignEl.addEventListener('change', () => {
        const v = this.callsignEl.value.trim();
        if (v) { saveCallsign(v); this.setCallsignError(''); }
      });
      this.callsignEl.addEventListener('input', () => {
        if (this.callsignEl.value.trim()) this.setCallsignError('');
      });
      // 呼号框里按 Enter 直接出击（走和按钮完全一致的校验流程）
      this.callsignEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('start-btn')?.click();
        }
      });
    }
    $('lb-open')?.addEventListener('click', () => this.openLeaderboard());
    $('lb-close')?.addEventListener('click', () => this.closeLeaderboard());
    this.lbTabButtons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.lbTabButtons.forEach((b) => b.classList.toggle('sel', b === btn));
        const view = btn.dataset.view;
        if (view === 'day') {
          this._lbDate = todayKey();
          this.renderDayBoard();
        } else if (view === 'all') {
          const s = await fetchSummary();
          this._lbAll = s.all || [];
          this._lbDays = s.days || [];
          this.lbSource.textContent = s.remote ? '全服' : '本机（未绑定 KV）';
          this.renderSummaryBoard();
        } else {
          const s = await fetchSummary();
          this._lbAll = s.all || [];
          this._lbDays = s.days || this._lbDays;
          this.lbSource.textContent = s.remote ? '全服' : '本机（未绑定 KV）';
          this.renderHistoryBoard();
        }
      });
    });
    $('again-btn').addEventListener('click', onRestart);
    this._pickHandler = onPick;
    this._weaponHandler = onWeapon;
    this.cards.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (this._panelKind === 'weapon') {
        if (this._weaponHandler) this._weaponHandler(card.dataset.id);
      } else if (this._pickHandler) {
        this._pickHandler(card.dataset.id);
      }
    });
  }

  // ---------------- 场景切换 ----------------
  startPlaying() {
    this.overlay.classList.add('hidden');
    this.reward.classList.add('hidden');
    this.gameover.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.crosshair.classList.remove('hidden');
    this.app.classList.add('playing');
  }

  showRewards(wave, choices, counts) {
    this._panelKind = 'upgrade';
    this.rewardWave.textContent = String(wave);
    this.rewardTitle.textContent = '选择强化';
    this.rewardSub.textContent = '本波已清除，装甲已修复 6 点';
    this.cards.innerHTML = '';

    choices.forEach((u, i) => {
      const level = counts[u.id] || 0;
      const rarity = RARITY[u.rarity] || RARITY.common;
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = u.id;
      card.style.setProperty('--rarity', rarity.color);
      card.innerHTML = `
        <span class="card-rarity">${u.armory ? '军械' : rarity.label}</span>
        <span class="card-key">${i + 1}</span>
        <div class="card-icon">${u.icon}</div>
        <div class="card-name">${u.name}</div>
        <div class="card-desc">${u.desc}</div>
        <div class="card-lv">${u.armory ? 'NEW · 更换主炮' : `${level === 0 ? 'NEW' : `Lv.${level}`} → Lv.${level + 1} / ${u.max === 99 ? '∞' : u.max}`}</div>
      `;
      this.cards.appendChild(card);
    });

    this.reward.classList.remove('hidden');
    this.app.classList.remove('playing');
  }

  /** 军械面板：wares 为可选武器定义 */
  showArmory(wave, wares, currentId) {
    this._panelKind = 'weapon';
    this.rewardWave.textContent = String(wave);
    this.rewardTitle.textContent = '军械补给';
    this.rewardSub.textContent = '选择一门主炮。已解锁的武器可以在战斗中按 Q 切换';
    this.cards.innerHTML = '';

    wares.forEach((w, i) => {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = w.id;
      card.style.setProperty('--rarity', w.uiColor || '#ffcf8a');
      card.innerHTML = `
        <span class="card-rarity">武器</span>
        <span class="card-key">${i + 1}</span>
        <div class="card-icon">${w.icon}</div>
        <div class="card-name">${w.name}</div>
        <div class="card-desc">${w.desc}</div>
        <div class="card-lv">${w.tag}${w.id === currentId ? ' · 当前装备' : ' · 点击装备'}</div>
      `;
      this.cards.appendChild(card);
    });

    this.reward.classList.remove('hidden');
    this.app.classList.remove('playing');
  }

  hideRewards() {
    this.reward.classList.add('hidden');
    this.app.classList.add('playing');
  }

  showGameOver({ wave, kills, score, time, best, isNew, daily, myName, leaderboard, overall }) {
    this.finalWave.textContent = String(wave);
    this.finalKills.textContent = String(kills);
    this.finalScore.textContent = String(score);
    this.finalTime.textContent = time;
    this.newRecord.classList.toggle('hidden', !isNew);
    this.bestLine.textContent = `第 ${best.wave} 波 · ${best.score} 分`;

    // 每日挑战：今日 Top5 + 历史总榜
    if (this.lb && this.lbList && this.lbTitle) {
      const hasDay = !!daily && Array.isArray(leaderboard) && leaderboard.length > 0;
      const hasAll = !!daily && Array.isArray(overall) && overall.length > 0;
      this.lb.classList.toggle('hidden', !(hasDay || hasAll));
      this.lbList.innerHTML = '';
      if (hasDay || hasAll) {
        this.lbTitle.textContent = '今日排行榜';
        const render = (list, label) => {
          if (!list || !list.length) return;
          const head = document.createElement('li');
          head.className = 'lb-group';
          head.textContent = label;
          this.lbList.appendChild(head);
          list.slice(0, 5).forEach((e, i) => {
            const li = document.createElement('li');
            if (myName && e.name === myName) li.className = 'me';
            li.innerHTML = `<i>${i + 1}</i><b>${e.name}</b><span>第 ${e.wave} 波</span><em>${e.score}</em>`;
            this.lbList.appendChild(li);
          });
        };
        render(leaderboard, '今日');
        render(overall, '历史总榜');
      }
    }

    this.gameover.classList.remove('hidden');
    this.hud.classList.add('hidden');
    this.crosshair.classList.add('hidden');
    this.app.classList.remove('playing');
  }

  setBest(best) {
    if (best && best.wave > 0) {
      this.bestBox.classList.remove('hidden');
      this.bestText.textContent = `第 ${best.wave} 波 · ${best.score} 分`;
    } else {
      this.bestBox.classList.add('hidden');
    }
  }

  // ---------------- HUD 数值 ----------------
  setHealth(hp, maxHp) {
    const ratio = Math.max(0, hp / maxHp);
    this.hpFill.style.width = `${ratio * 100}%`;
    this.hpGhost.style.width = `${ratio * 100}%`;
    this.hpText.textContent = `${Math.max(0, Math.round(hp))} / ${maxHp}`;
    this.hpFill.style.background = ratio > 0.5
      ? 'linear-gradient(90deg,#9bd35a,#ffb03a)'
      : ratio > 0.25
        ? 'linear-gradient(90deg,#ffb03a,#ff7a3a)'
        : 'linear-gradient(90deg,#ff5a3a,#c81e1e)';
  }

  setReload(ratio) {
    this.reloadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  }

  setWeapon(w) {
    this.weaponIcon.textContent = w.icon;
    this.weaponName.textContent = w.name;
    this.weaponTag.textContent = w.tag;
    this.weaponTag.style.color = w.uiColor || 'var(--muted)';
    this.heatRow.classList.toggle('hidden', !w.heat);
  }

  setHeat(ratio, overheated, visible = true) {
    this.heatRow.classList.toggle('hidden', !visible);
    if (!visible) return;
    const v = Math.max(0, Math.min(1, ratio));
    this.heatFill.style.width = `${v * 100}%`;
    this.heatFill.classList.toggle('hot', v > 0.62 && !overheated);
    this.heatFill.classList.toggle('over', !!overheated);
    this.heatRow.classList.toggle('over', !!overheated);
  }

  showBossBar(name, kind, hp, maxHp, enraged) {
    this.bossBar.classList.remove('hidden');
    if (this._bossKind !== kind) {
      this._bossKind = kind;
      this.bossBar.dataset.kind = kind;
      this.bossName.textContent = name;
    }
    this.setBossHealth(hp, maxHp, enraged);
  }

  setBossHealth(hp, maxHp, enraged) {
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    this.bossFill.style.width = `${ratio * 100}%`;
    this.bossHpText.textContent = `${Math.max(0, Math.ceil(hp))} / ${maxHp}`;
    this.bossBar.classList.toggle('enraged', !!enraged);
  }

  hideBossBar() {
    this.bossBar.classList.add('hidden');
    this._bossKind = null;
  }

  setWave(n) { this.waveEl.textContent = String(n); }

  /** 顶部显示本局挑战词条 */
  setModifier(mod) {
    if (!this.modifierEl) return;
    if (mod && mod.id) {
      this.modifierEl.textContent = `${mod.icon} ${mod.name} · ${mod.desc}`;
      this.modifierEl.classList.remove('hidden');
    } else {
      this.modifierEl.classList.add('hidden');
    }
  }
  setLeft(n) { this.leftEl.textContent = String(n); }
  setKills(n) { this.killsEl.textContent = String(n); }
  setScore(n) { this.scoreEl.textContent = String(n); }

  /** 用强化定义渲染徽章（图标 + 等级） */
  renderChips(list) {
    this.chipsEl.innerHTML = '';
    for (const { icon, name, level } of list) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = `${name} Lv.${level}`;
      chip.innerHTML = `<span>${icon}</span><i>${level}</i>`;
      this.chipsEl.appendChild(chip);
    }
  }

  hurt() {
    this.vignette.classList.add('hit');
    clearTimeout(this._hurtT);
    this._hurtT = setTimeout(() => this.vignette.classList.remove('hit'), 90);
  }

  showMessage(text, seconds = 1.6) {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = seconds;
  }

  moveCrosshair(x, y) {
    this.crosshair.style.left = `${x}px`;
    this.crosshair.style.top = `${y}px`;
  }

  update(dt) {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }
  }
}
