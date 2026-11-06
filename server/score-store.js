// 本地榜单存储：一个最小可用的 KV 替身
//
// 接口和 Cloudflare KV 保持一致（get / put 都返回 Promise，值都是字符串），
// 所以 functions/api/_lib/leaderboard.js 那份逻辑可以原样跑在本地。
//
// 落盘位置：<项目根>/.data/scores.json（已写进 .gitignore）
// 设计取舍：整文件读写。单房间、几百条成绩的规模下足够；换机器/备份也只是一个 JSON。

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export class FileStore {
  constructor(file) {
    this.file = file;
    // 串行化写入：并发的"读-改-写"互相覆盖是这类存储最容易翻车的地方
    this.queue = Promise.resolve();
    this.cache = null;
  }

  async _load() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw) || {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async _flush() {
    await mkdir(path.dirname(this.file), { recursive: true });
    // 先写临时文件再 rename：断电/中断不会留下半截 JSON
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache), 'utf8');
    await rename(tmp, this.file);
  }

  async get(key) {
    const map = await this._load();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  async put(key, value) {
    const run = async () => {
      const map = await this._load();
      map[key] = String(value);
      await this._flush();
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}

/** 读取请求体（限制大小，防止误传大文件把进程撑爆） */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}
