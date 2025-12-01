const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================
// 1. 地圖資料 (1=牆, 0=空)
// ============================
const BLOCK_SIZE = 64;
const MAP_WIDTH = 24;
const MAP_HEIGHT = 24;
// 一個簡單的迷宮地圖
const WORLD_MAP = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,1,0,0,0,0,0,0,0,0,1,0,1,0,1,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,1,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,1,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
];

const PLAYERS = {};
const BULLETS = [];

// ============================
// 2. Auth Routes (簡化版，同上)
// ============================
// ... (與上一個版本相同，這裡為了節省篇幅省略 Auth 程式碼，請直接沿用上一版的 /api/auth 部分) ...
// ... 記得把 Auth 的程式碼貼回來 ...

// 這裡只列出不一樣的遊戲邏輯部分

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        PLAYERS[socket.id] = {
            id: socket.id,
            username: data.username || "Guest",
            x: 2 * BLOCK_SIZE, // 出生點
            y: 2 * BLOCK_SIZE,
            angle: 0,
            hp: 150,
            kills: 0,
            deaths: 0
        };
        socket.emit('init', { map: WORLD_MAP, blockSize: BLOCK_SIZE, id: socket.id });
    });

    socket.on('input', (data) => {
        const p = PLAYERS[socket.id];
        if (!p || p.hp <= 0) return;

        // 簡單的碰撞檢測 (Grid Collision)
        const moveSpeed = 5;
        const rotSpeed = 0.05;

        // 旋轉 (滑鼠控制視角，這裡也接受鍵盤轉向輔助)
        if (data.rotateLeft) p.angle -= rotSpeed;
        if (data.rotateRight) p.angle += rotSpeed;
        if (data.angle !== undefined) p.angle = data.angle; // 來自滑鼠的絕對角度

        // 移動計算
        let dx = 0, dy = 0;
        if (data.keys.w) {
            dx += Math.cos(p.angle) * moveSpeed;
            dy += Math.sin(p.angle) * moveSpeed;
        }
        if (data.keys.s) {
            dx -= Math.cos(p.angle) * moveSpeed;
            dy -= Math.sin(p.angle) * moveSpeed;
        }

        // 檢查新位置是否撞牆
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
        
        // Raycast Shooting (Hitscan) for simplicity in 3D
        // 為了簡化，這裡做一個簡單的射線判定，或產生子彈物件
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

// Game Loop
setInterval(() => {
    // Update Bullets
    for (let i = BULLETS.length - 1; i >= 0; i--) {
        const b = BULLETS[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;
        b.life--;

        // 碰撞 (牆壁)
        const gx = Math.floor(b.x / BLOCK_SIZE);
        const gy = Math.floor(b.y / BLOCK_SIZE);
        if (!WORLD_MAP[gy] || WORLD_MAP[gy][gx] === 1 || b.life <= 0) {
            BULLETS.splice(i, 1);
            continue;
        }

        // 碰撞 (玩家) - 簡單距離判定
        for (let id in PLAYERS) {
            const p = PLAYERS[id];
            if (id !== b.owner && p.hp > 0) {
                const dist = Math.hypot(p.x - b.x, p.y - b.y);
                if (dist < 30) { // Hit radius
                    p.hp -= 12;
                    BULLETS.splice(i, 1);
                    if (p.hp <= 0) {
                        // Handle Kill (Redis logic here)
                        // ...
                        // Respawn
                        p.hp = 150;
                        p.x = 2 * BLOCK_SIZE;
                        p.y = 2 * BLOCK_SIZE;
                    }
                    break;
                }
            }
        }
    }
    io.emit('state', { players: PLAYERS, bullets: BULLETS });
}, 1000 / 60);

server.listen(PORT, () => {
    console.log(`FPS Server running on port ${PORT}`);
});
