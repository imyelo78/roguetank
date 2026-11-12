// 多人对局的核心状态（与渲染无关）
//
// 这一层刻意不 import three —— 它要能在浏览器和 Node 里跑同一份代码。
// 服务端用它算权威状态，客户端用它做预测与插值。

/** 输入意图：客户端唯一有权限说的东西 */
export const emptyInput = () => ({
  seq: 0,
  // 移动方向（世界坐标，-1 / 0 / 1）。与单机一致：八方向平移，
  // 不是"油门 + 方向盘"。旧版这里是 forward/turn，联机手感因此与单机完全不同。
  mx: 0,
  mz: 0,
  aimX: 0,      // 瞄准点（世界坐标）
  aimZ: 0,
  fire: false,
});

/** 玩家一局内的战斗统计 */
export const newStats = () => ({
  kills: 0,
  score: 0,
  damage: 0,
  shots: 0,
  hits: 0,
});

export const PLAYER_RADIUS = 1.9;

/**
 * 单个玩家的权威状态。
 * 服务端与客户端用同一结构，字段越多越要省着加（每帧都要同步）。
 */
export function createPlayer({ id, name, chassisId, x = 0, z = 0, hp = 120, maxHp = 120 }) {
  return {
    id,
    name: (name || '指挥官').slice(0, 12),
    chassis: chassisId || 'panther',
    x,
    z,
    yaw: Math.PI,          // 车体朝向
    turretYaw: Math.PI,    // 炮塔朝向（必须单独同步）
    speed: 0,              // 当前前进速度（用于履带动画与惯性）
    hp,
    maxHp,
    alive: true,
    down: false,           // 倒地待救
    downT: 0,              // 倒地剩余时间
    reviveT: 0,            // 救援进度
    respawnT: 0,           // 复活倒计时
    fireCd: 0,
    heat: 0,
    overheated: false,
    stats: newStats(),
    joinedAt: 0,
  };
}

/**
 * 倒地与救援。
 *
 * 为什么要有这套：4 人房里"死了就变观战"会让人立刻退房，
 * 倒地 30 秒 + 队友 3 秒拉起，能把失误转化成一次团队配合。
 */
export const DOWN_TIME = 30;
export const REVIVE_TIME = 3;
export const REVIVE_RANGE = 4.5;
export const RESPAWN_DELAY = 6;

/**
 * 推进救援逻辑。返回本 tick 发生的事件列表（给表现层播动画/音效）。
 * @param {object[]} players
 * @param {number} dt
 */
export function updateRevive(players, dt) {
  const events = [];

  for (const p of players) {
    if (p.down) {
      p.downT -= dt;
      // 只要有存活队友贴近，就在累积救援进度
      let helper = null;
      for (const q of players) {
        if (q === p || !q.alive || q.down) continue;
        if (Math.hypot(q.x - p.x, q.z - p.z) <= REVIVE_RANGE) { helper = q; break; }
      }
      if (helper) {
        p.reviveT += dt;
        if (p.reviveT >= REVIVE_TIME) {
          p.down = false;
          p.alive = true;
          p.hp = Math.round(p.maxHp * 0.4);
          p.reviveT = 0;
          p.downT = 0;
          events.push({ type: 'revive', id: p.id, by: helper.id });
        }
      } else {
        p.reviveT = Math.max(0, p.reviveT - dt * 2); // 松手后退回得快一些
      }

      if (p.downT <= 0) {
        // 没救回来：进入复活倒计时，不踢出房间
        p.down = false;
        p.alive = false;
        p.downT = 0;
        p.respawnT = RESPAWN_DELAY;
        events.push({ type: 'gone', id: p.id });
      }
    } else if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) {
        p.alive = true;
        p.hp = Math.round(p.maxHp * 0.6);
        events.push({ type: 'respawn', id: p.id });
      }
    } else if (p.hp <= 0) {
      p.down = true;
      p.downT = DOWN_TIME;
      p.reviveT = 0;
      p.hp = 0;
      events.push({ type: 'down', id: p.id });
    }
  }

  return events;
}

/**
 * 人数缩放。线性放大会变成推墙，不放大会变成切菜，所以：
 *   敌人血量 sqrt(n)，数量 n^0.6。
 *
 * 数量指数从 0.85 降到 0.6 是 r30 的核心平衡改动：
 *   - 0.85 时 4 人第 12 波是 122 只 / 5.3 万血，玩家只有 4 倍火力，
 *     实际打起来是"清不完、只能一直跑"；
 *   - 0.6 时 4 人数量 ×2.30（3 人 ×1.93），总血量约为单人的 4.6 倍，
 *     和 4 倍火力基本对齐。
 * 省下来的数量预算不靠堆血量补，而是交给巡逻/驻军质量（core/patrol.js）。
 *
 * Boss 血量也吃 hpMul：以前 Boss 完全不随人数缩放，4 人打 Boss
 * 等于 4 倍 DPS 打同一个血条，是联机里最大的白给点。
 */
export function scaleForPlayers(n) {
  const c = Math.max(1, Math.min(4, n));
  return {
    hpMul: Math.sqrt(c),
    countMul: Math.pow(c, 0.6),
    scoreMul: Math.sqrt(c), // 得分同步放大，跨人数才勉强可比
  };
}
