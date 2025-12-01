const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
// 如果沒有 Redis URL，不會報錯，只是不存檔
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.static('public'));

// ============================
// 1. 地圖設定
// ============================
const BLOCK_SIZE = 64;
// 地圖: 1=牆, 0=空
const WORLD_MAP = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,1,0,0,0,0,0,0,0,0,1,0,1,0,1,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,1,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,1,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
];

const PLAYERS = {};
const BULLETS = [];

// ============================
// 2. NPC 機器人邏輯
// ============================
const BOT_COUNT = 5;

function spawnBots() {
    for (let i = 0; i < BOT_COUNT; i++) {
        const botId = `bot_${i}`;
        PLAYERS[botId] = {
            id: botId,
            username: `[BOT] Alpha-${i}`,
            x: (3 + i) * BLOCK_SIZE,
            y: (3 + i) * BLOCK_SIZE,
            angle: Math.random() * Math.PI * 2,
            hp: 100, // Bot 血量稍微少一點
            kills: 0,
            deaths: 0,
            isBot: true,
            moveTimer: 0,
            targetAngle: 0
        };
    }
}
spawnBots(); // 啟動時生成

function updateBots() {
    for (const id in PLAYERS) {
        const bot = PLAYERS[id];
        if (!bot.isBot || bot.hp <= 0) continue;

        // 1. 簡單 AI: 隨機移動
        bot.moveTimer--;
        if (bot.moveTimer <= 0) {
            bot.moveTimer = Math.floor(Math.random() * 60) + 30; // 0.5 ~ 1.5秒改變一次決策
            bot.targetAngle = Math.random() * Math.PI * 2;
        }

        // 平滑轉向
        const diff = bot.targetAngle - bot.angle;
        bot.angle += diff * 0.1;

        // 向前移動
        const speed = 2; // Bot 走慢一點
        const nextX = bot.x + Math.cos(bot.angle) * speed;
        const nextY = bot.y + Math.sin(bot.angle) * speed;
        
        // 簡單碰撞檢查
        const gx = Math.floor(nextX / BLOCK_SIZE);
        const gy = Math.floor(nextY / BLOCK_SIZE);
        if (WORLD_MAP[gy] && WORLD_MAP[gy][gx] === 0) {
            bot.x = nextX;
            bot.y = nextY;
        } else {
            // 撞牆就反轉
            bot.targetAngle += Math.PI;
        }

        // 2. 簡單 AI: 隨機射擊
        if (Math.random() < 0.02) { // 2% 機率開槍
            BULLETS.push({
                x: bot.x,
                y: bot.y,
                angle: bot.angle + (Math.random()-0.5)*0.2, // 稍微不準
                owner: id,
                speed: 15,
                life: 60
            });
        }
    }
}

// ============================
// 3. Socket & 遊戲迴圈
// ============================
io.on('connection', (socket) => {
    socket.on('join', (data) => {
        PLAYERS[socket.id] = {
            id: socket.id,
            username: data.username || "Guest",
            x: 2 * BLOCK_SIZE,
            y: 2 * BLOCK_SIZE,
            angle: 0,
            hp: 150,
            kills: 0,
            deaths: 0,
            isBot: false
        };
        socket.emit('init', { map: WORLD_MAP, blockSize: BLOCK_SIZE, id: socket.id });
    });

    socket.on('input', (data) => {
        const p = PLAYERS[socket.id];
        if (!p || p.hp <= 0) return;

        // 更新位置與角度 (信任前端傳來的預測位置，但做基本防作弊檢查可在此加)
        // 為了簡單流暢，這裡直接接受前端的計算結果，但前端要傳送的是 input 狀態，這裡簡化處理
        // 由於我們改成了 Client-Prediction，前端主要傳送 keys 和 angle
        // 這裡為了配合上一版的代碼，我們假設前端可以處理好位置同步，或是我們後端重算
        // 這裡採用: 後端重算 (權威伺服器)
        
        p.angle = data.angle;
        const moveSpeed = 5;
        let dx = 0, dy = 0;
        
        if (data.keys.w) { dx += Math.cos(p.angle) * moveSpeed; dy += Math.sin(p.angle) * moveSpeed; }
        if (data.keys.s) { dx -= Math.cos(p.angle) * moveSpeed; dy -= Math.sin(p.angle) * moveSpeed; }
        // 簡單側移邏輯略過，以保持代碼簡潔

        const newX = p.x + dx;
        const newY = p.y + dy;
        const gridX = Math.floor(newX / BLOCK_SIZE);
        const gridY = Math.floor(newY / BLOCK_SIZE);

        if (WORLD_MAP[gridY] && WORLD_MAP[gridY][gridX] === 0) {
            p.x = newX;
            p.y = newY;
        }
    });

    socket.on('shoot', () => {
        const p = PLAYERS[socket.id];
        if (!p || p.hp <= 0) return;
        BULLETS.push({
            x: p.x,
            y: p.y,
            angle: p.angle,
            owner: socket.id,
            speed: 20,
            life: 50
        });
    });

    socket.on('disconnect', () => {
        delete PLAYERS[socket.id];
    });
});

setInterval(() => {
    updateBots(); // 更新機器人

    // 子彈邏輯
    for (let i = BULLETS.length - 1; i >= 0; i--) {
        const b = BULLETS[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;
        b.life--;

        const gx = Math.floor(b.x / BLOCK_SIZE);
        const gy = Math.floor(b.y / BLOCK_SIZE);
        
        // 撞牆
        if (!WORLD_MAP[gy] || WORLD_MAP[gy][gx] === 1 || b.life <= 0) {
            BULLETS.splice(i, 1);
            continue;
        }

        // 撞人 (玩家 & Bot)
        for (let id in PLAYERS) {
            const p = PLAYERS[id];
            if (id !== b.owner && p.hp > 0) {
                const dist = Math.hypot(p.x - b.x, p.y - b.y);
                if (dist < 30) {
                    p.hp -= 12;
                    BULLETS.splice(i, 1);
                    
                    if (p.hp <= 0) {
                        // 擊殺邏輯
                        const killer = PLAYERS[b.owner];
                        if (killer) killer.kills++;
                        p.deaths++;
                        
                        // 重生
                        setTimeout(() => {
                            if (PLAYERS[id]) {
                                PLAYERS[id].hp = p.isBot ? 100 : 150;
                                PLAYERS[id].x = (Math.random() * 10 + 2) * BLOCK_SIZE;
                                PLAYERS[id].y = (Math.random() * 10 + 2) * BLOCK_SIZE;
                            }
                        }, 3000);
                    }
                    break;
                }
            }
        }
    }
    io.emit('state', { players: PLAYERS, bullets: BULLETS });
}, 1000 / 60);

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
