import { Game } from './Game.js';

const canvas = document.getElementById('scene');
const game = new Game(canvas);
game.mount();

// 便于调试
window.__game = game;
