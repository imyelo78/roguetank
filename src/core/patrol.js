// 巡逻 / 驻军决策：纯函数，无 three，单机与联机共用。
//
// 为什么单独抽一个文件：
//   以前"看起来像巡逻"的逻辑只存在于单机 Enemy.js 的 `patrol` 状态里，
//   而且那个状态是**以玩家为中心**随机绕圈（离得远时假装巡逻），
//   联机服务端干脆没有——所有敌人一年四季都朝玩家冲。
//   两边各写一份的结果，参考双联炮：单机正常、联机永远单发。
//
// 这里只负责三件事：
//   1. 用种子生成巡逻路线（航点 + 锚点）；
//   2. 给每辆敌车一份独立的巡逻状态（航点索引、等待计时）；
//   3. 每帧根据"离锚点多远 / 离玩家多近"决定：巡逻、追击、回防。
//
// 渲染层不需要知道航点，联机快照也不需要同步航点——它是种子生成的。

/** 巡逻参数。数值偏保守：先让"地图上有驻军"，不追求把玩家追死 */
export const PATROL = {
  /** 巡逻队发现玩家的距离 */
  alertR: 42,
  /** 驻军（守点）发现玩家的距离更近，避免全图一起扑 */
  guardAlertR: 32,
  /** 追出锚点多远后放弃、回防（半固定的核心） */
  leashR: 72,
  /** 驻军几乎不离开岗位 */
  guardLeashR: 26,
  /** Boss：见到你就压上来，但不会从地图一头追到另一头 */
  bossAlertR: 56,
  bossLeashR: 78,
  /** 到航点后停多久 */
  waitAt: 0.7,
  /** 巡逻速度倍率（相对基础速度） */
  routeSpeed: 0.55,
  /** 回防速度倍率，比巡逻快一点，别让玩家看它慢慢挪 */
  returnSpeed: 0.8,
  /** 到点判定半径 */
  arrive: 3,
  /** 一队挨打时，唤醒多大范围内的同伴 */
  callR: 26,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 线段采样：巡逻航点之间不能穿墙，否则敌人会一直顶着楼角 */
function clearLine(blocked, x1, z1, x2, z2) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const steps = Math.max(2, Math.ceil(len / 2));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (blocked(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t, 2.2)) return false;
  }
  return true;
}

/**
 * 生成一组巡逻路线。
 *
 * @param {() => number} rng       种子随机流（0~1）
 * @param {object} opts
 * @param {number} opts.half       地图半边长（HALF）
 * @param {(x:number,z:number,r:number)=>boolean} opts.blocked 碰撞查询
 * @param {{x:number,z:number,r?:number}[]} [opts.avoid] 避开点（通常是玩家出生点）
 * @param {number} [opts.count]    生成几条
 * @param {number} [opts.minGap]   锚点之间的最小间距
 * @returns {{id:number,kind:string,anchor:{x:number,z:number},points:{x:number,z:number}[]}[]}
 */
export function buildPatrolRoutes(rng, {
  half, blocked, avoid = [], count = 6, minGap = 32,
} = {}) {
  const routes = [];
  if (!half || typeof blocked !== 'function') return routes;

  // 最多尝试 count*40 次，避免地图被建筑塞满时死循环
  for (let attempt = 0; attempt < count * 40 && routes.length < count; attempt++) {
    const ax = clamp(-half + 16 + rng() * (half * 2 - 32), -half + 12, half - 12);
    const az = clamp(-half + 16 + rng() * (half * 2 - 32), -half + 12, half - 12);
    if (blocked(ax, az, 2.8)) continue;
    if (avoid.some((a) => Math.hypot(ax - a.x, az - a.z) < (a.r || 30))) continue;
    if (routes.some((r) => Math.hypot(ax - r.anchor.x, az - r.anchor.z) < minGap)) continue;

    const points = [{ x: ax, z: az }];
    const extra = 2 + Math.floor(rng() * 3);   // 全长 3~5 个航点
    let cx = ax;
    let cz = az;
    for (let i = 0; i < extra; i++) {
      let placed = false;
      for (let tries = 0; tries < 14 && !placed; tries++) {
        const a = rng() * Math.PI * 2;
        const len = 18 + rng() * 24;
        const nx = clamp(cx + Math.sin(a) * len, -half + 10, half - 10);
        const nz = clamp(cz + Math.cos(a) * len, -half + 10, half - 10);
        if (Math.hypot(nx - cx, nz - cz) < 12) continue;
        if (!clearLine(blocked, cx, cz, nx, nz)) continue;
        points.push({ x: nx, z: nz });
        cx = nx;
        cz = nz;
        placed = true;
      }
    }
    if (points.length < 3) continue;

    routes.push({
      id: routes.length,
      kind: 'route',
      anchor: { x: ax, z: az },
      points,
    });
  }
  return routes;
}

/** 给一辆车建独立巡逻状态（同一路线上的车错开航点，不要排成一列） */
export function createPatrolState(route, rng = Math.random) {
  if (!route || !route.points?.length) return null;
  return {
    route,
    idx: Math.floor(rng() * route.points.length) % route.points.length,
    waitT: rng() * PATROL.waitAt,
    // route | chase | return | hunter
    mode: 'route',
  };
}

/**
 * 单点锚位路线：驻军（guard）与 Boss（boss）用。
 * 只守一个点，警戒圈内才动，追出 leash 就回防。
 */
export function anchorRoute(kind, x, z) {
  return { id: -1, kind, anchor: { x, z }, points: [{ x, z }] };
}

/** 被玩家打了：立刻转入追击（哪怕玩家还在警戒圈外） */
export function wakePatrol(state) {
  if (!state) return;
  if (state.mode === 'route' || state.mode === 'return') state.mode = 'chase';
}

/** 残局兜底：剩下的巡逻队全部转成猎杀，避免玩家满地图找最后一只 */
export function sendHunting(state) {
  if (state) state.mode = 'hunter';
}

/**
 * 每帧决策。返回 null 表示"这辆车没有巡逻行为，按原来的追击 AI 走"。
 *
 * @param {object|null} state
 * @param {number} dt
 * @param {number} distToNearest 离最近玩家的水平距离
 * @param {{x:number,z:number}} self 车的位置
 * @returns {{mode:'chase'|'patrol'|'return'|'hold', tx?:number, tz?:number, speedMul?:number}|null}
 */
export function stepPatrol(state, dt, distToNearest, self) {
  if (!state) return null;
  if (state.mode === 'hunter') return { mode: 'chase' };

  const route = state.route;
  const boss = route.kind === 'boss';
  const guard = route.kind === 'guard';
  const alertR = boss ? PATROL.bossAlertR : guard ? PATROL.guardAlertR : PATROL.alertR;
  const leashR = boss ? PATROL.bossLeashR : guard ? PATROL.guardLeashR : PATROL.leashR;
  const a = route.anchor;
  const fromAnchor = Math.hypot(self.x - a.x, self.z - a.z);

  // 追击中离锚点太远 → 放弃，回防。先判这个再判警戒，
  // 否则玩家把你拉出去之后，你会在原地来回切状态。
  if (state.mode === 'chase') {
    if (fromAnchor > leashR) state.mode = 'return';
    else return { mode: 'chase' };
  }

  if (state.mode === 'return') {
    if (fromAnchor < PATROL.arrive) {
      state.mode = 'route';
      state.waitT = PATROL.waitAt;
    } else {
      return { mode: 'return', tx: a.x, tz: a.z, speedMul: PATROL.returnSpeed };
    }
  }

  if (distToNearest < alertR) {
    state.mode = 'chase';
    return { mode: 'chase' };
  }

  const pts = route.points;
  const target = pts[state.idx] || pts[0];
  if (Math.hypot(target.x - self.x, target.z - self.z) < PATROL.arrive) {
    state.waitT -= dt;
    if (state.waitT <= 0) {
      state.idx = (state.idx + 1) % pts.length;
      state.waitT = PATROL.waitAt;
    }
    return { mode: 'hold', tx: target.x, tz: target.z, speedMul: 0 };
  }
  return {
    mode: 'patrol',
    tx: target.x,
    tz: target.z,
    speedMul: guard ? 0.45 : PATROL.routeSpeed,
  };
}
