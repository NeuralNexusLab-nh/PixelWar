const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Redis 連線
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

app.use(helmet({
    contentSecurityPolicy: false // 為了讓 Canvas 和 Socket.io 正常運作
}));
app.use(cors());
app.use(express.static('public'));

// ==========================================
// 遊戲狀態 (記憶體內)
// ==========================================
const players = {};
const bullets = [];
const MAP_SIZE = 2000;

// ==========================================
// Socket.io 邏輯
// ==========================================
io.on('connection', async (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // 初始化玩家
    players[socket.id] = {
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        angle: 0,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        score: 0,
        hp: 100
    };

    // 發送當前排行榜給新玩家
    updateLeaderboard();

    // 接收移動指令
    socket.on('input', (data) => {
        const p = players[socket.id];
        if (p && p.hp > 0) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
    });

    // 接收射擊指令
    socket.on('shoot', () => {
        const p = players[socket.id];
        if (p && p.hp > 0) {
            bullets.push({
                x: p.x,
                y: p.y,
                vx: Math.cos(p.angle) * 15, // 子彈速度
                vy: Math.sin(p.angle) * 15,
                owner: socket.id,
                life: 100 // 子彈壽命
            });
        }
    });

    // 斷線處理
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

// ==========================================
// 遊戲主迴圈 (Server Tick 60 FPS)
// ==========================================
setInterval(() => {
    // 1. 更新子彈位置
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        // 子彈消失條件
        if (b.life <= 0 || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        // 2. 碰撞檢測 (簡單圓形碰撞)
        for (const id in players) {
            const p = players[id];
            if (id !== b.owner && p.hp > 0) {
                const dx = p.x - b.x;
                const dy = p.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 20) { // 命中判定半徑
                    p.hp -= 20;
                    bullets.splice(i, 1); // 移除子彈

                    if (p.hp <= 0) {
                        handleKill(b.owner, id); // 處理擊殺
                    }
                    break;
                }
            }
        }
    }

    // 3. 廣播狀態給所有玩家
    io.emit('state', { players, bullets });

}, 1000 / 60);

// ==========================================
// Redis 相關邏輯
// ==========================================

async function handleKill(killerId, victimId) {
    const killer = players[killerId];
    const victim = players[victimId];

    if (killer) {
        killer.score += 1;
        
        // [Redis] 使用 Sorted Set 紀錄排行榜
        // ZINCRBY key increment member
        await redis.zincrby('leaderboard', 1, killerId.substr(0, 5)); 
    }

    if (victim) {
        // 重生
        victim.hp = 100;
        victim.x = Math.random() * MAP_SIZE;
        victim.y = Math.random() * MAP_SIZE;
        victim.score = 0; // 重置分數
        // [Redis] 可以選擇是否在死掉時重置 Redis 排行榜分數，這裡先保留累積
    }

    updateLeaderboard();
}

async function updateLeaderboard() {
    // [Redis] 抓取前 5 名 (分數由高到低)
    // ZREVRANGE key start stop WITHSCORES
    const data = await redis.zrevrange('leaderboard', 0, 4, 'WITHSCORES');
    
    // 格式化 Redis 回傳的資料 [id, score, id, score...]
    const leaderboard = [];
    for (let i = 0; i < data.length; i += 2) {
        leaderboard.push({ name: data[i], score: data[i+1] });
    }

    io.emit('leaderboard', leaderboard);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Game Server running on port ${PORT}`);
});
