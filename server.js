const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Initialize DB
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

function readDb() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { return { users: {} }; }
}

function writeDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    // 限制 1~20 字元
    if (!username || !password || username.length < 1 || username.length > 20) {
        return res.status(400).json({ error: "Username must be 1-20 chars" });
    }

    const db = readDb();
    if (db.users[username]) return res.status(400).json({ error: "User already exists" });

    const hash = await bcrypt.hash(password, 10);
    db.users[username] = { password: hash, kills: 0, deaths: 0 };
    writeDb(db);
    res.json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const db = readDb();
    const user = db.users[username];
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    res.json({ success: true, kills: user.kills, deaths: user.deaths });
});

// Game Configuration
const BLOCK_SIZE = 64;
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
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
];

const ROOMS = {}; 

function getRoomState(roomName) {
    if (!ROOMS[roomName]) {
        ROOMS[roomName] = { players: {}, bullets: [], bots: [] };
        // Spawn 5 Bots
        for (let i = 0; i < 5; i++) {
            ROOMS[roomName].bots.push({
                id: `bot_${roomName}_${i}`,
                username: `[BOT] NPC-${i+1}`, // 機器人名字
                x: (3 + i) * BLOCK_SIZE, 
                y: (3 + i) * BLOCK_SIZE,
                angle: Math.random() * 6.28, 
                hp: 100, 
                isBot: true, 
                fireTimer: 0
            });
        }
    }
    return ROOMS[roomName];
}

io.on('connection', (socket) => {
    // 預設 server 邏輯在前端處理，但後端做個保底
    const roomName = socket.handshake.query.server || 'server';
    socket.join(roomName);
    const room = getRoomState(roomName);

    socket.on('join', (data) => {
        const db = readDb();
        const userStats = db.users[data.username] || { kills: 0, deaths: 0 };
        
        // 確保名字不超過 20 字
        const safeName = (data.username || "Guest").substring(0, 20);

        room.players[socket.id] = {
            id: socket.id,
            username: safeName,
            x: 2 * BLOCK_SIZE, 
            y: 2 * BLOCK_SIZE, 
            angle: 0, 
            hp: 150,
            kills: userStats.kills, 
            deaths: userStats.deaths, 
            isBot: false
        };
        socket.emit('init', { map: WORLD_MAP, id: socket.id });
    });

    socket.on('input', (data) => {
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;
        p.angle = data.angle;
        
        // 簡單的移動更新 (主要依賴前端預測，後端做基礎驗證)
        const moveSpeed = 5;
        let dx = 0, dy = 0;
        if (data.keys.w) { dx += Math.cos(p.angle)*moveSpeed; dy += Math.sin(p.angle)*moveSpeed; }
        if (data.keys.s) { dx -= Math.cos(p.angle)*moveSpeed; dy -= Math.sin(p.angle)*moveSpeed; }
        
        const nextX = p.x + dx; 
        const nextY = p.y + dy;
        
        // 簡單碰撞檢查
        if (WORLD_MAP[Math.floor(nextY/BLOCK_SIZE)] && WORLD_MAP[Math.floor(nextY/BLOCK_SIZE)][Math.floor(nextX/BLOCK_SIZE)] === 0) {
            p.x = nextX; p.y = nextY;
        }
    });

    socket.on('shoot', () => {
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;
        room.bullets.push({
            x: p.x, y: p.y, angle: p.angle, owner: socket.id,
            speed: 20, life: 50, damage: 10
        });
    });

    socket.on('disconnect', () => {
        const p = room.players[socket.id];
        if (p) {
            const db = readDb();
            if (db.users[p.username]) {
                db.users[p.username].kills = p.kills;
                db.users[p.username].deaths = p.deaths;
                writeDb(db);
            }
            delete room.players[socket.id];
        }
    });

    // Ping Check: 收到 Ping 請求，直接回傳 Pong
    socket.on('ping_check', () => {
        socket.emit('pong_check');
    });
});

// Game Loop
setInterval(() => {
    for (const roomName in ROOMS) {
        const room = ROOMS[roomName];
        
        // Bots AI
        room.bots.forEach(bot => {
            if (bot.hp <= 0) {
                 if (Math.random() < 0.01) { 
                     bot.hp = 100; 
                     bot.x = (Math.random()*10+2)*BLOCK_SIZE; 
                     bot.y = (Math.random()*10+2)*BLOCK_SIZE; 
                 }
                 return;
            }
            // Move
            if (Math.random() < 0.05) bot.angle += (Math.random()-0.5);
            const bx = bot.x + Math.cos(bot.angle) * 2;
            const by = bot.y + Math.sin(bot.angle) * 2;
            if (WORLD_MAP[Math.floor(by/BLOCK_SIZE)] && WORLD_MAP[Math.floor(by/BLOCK_SIZE)][Math.floor(bx/BLOCK_SIZE)] === 0) {
                bot.x = bx; bot.y = by;
            } else bot.angle += 3.14; // Hit wall, turn around

            // Shoot
            if (bot.fireTimer <= 0) {
                room.bullets.push({ x: bot.x, y: bot.y, angle: bot.angle+(Math.random()-0.5)*0.1, owner: bot.id, speed: 15, life: 60, damage: 30 });
                bot.fireTimer = Math.floor(Math.random()*(138-36)+36);
            }
            bot.fireTimer--;
        });

        // Bullets
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.life--;

            const gx = Math.floor(b.x/BLOCK_SIZE);
            const gy = Math.floor(b.y/BLOCK_SIZE);

            if (!WORLD_MAP[gy] || WORLD_MAP[gy][gx] === 1 || b.life <= 0) {
                room.bullets.splice(i, 1);
                continue;
            }

            const allEntities = [...Object.values(room.players), ...room.bots];
            for (const entity of allEntities) {
                if (entity.hp <= 0 || entity.id === b.owner) continue;
                if (Math.hypot(entity.x - b.x, entity.y - b.y) < 30) {
                    entity.hp -= b.damage;
                    room.bullets.splice(i, 1);
                    if (entity.hp <= 0) {
                        entity.deaths = (entity.deaths || 0) + 1;
                        let killerName = "Unknown";
                        if (b.owner.startsWith('bot')) {
                             const bot = room.bots.find(x => x.id === b.owner);
                             killerName = bot ? bot.username : "NPC";
                        } else if (room.players[b.owner]) {
                             killerName = room.players[b.owner].username;
                             room.players[b.owner].kills++;
                        }
                        
                        if (!entity.isBot) {
                            io.to(entity.id).emit('died', { killer: killerName });
                            setTimeout(() => { 
                                if (room.players[entity.id]) { 
                                    room.players[entity.id].hp = 150; 
                                    room.players[entity.id].x = 2*BLOCK_SIZE; 
                                    room.players[entity.id].y = 2*BLOCK_SIZE; 
                                }
                            }, 3000);
                        }
                    }
                    break;
                }
            }
        }
        io.to(roomName).emit('state', { players: room.players, bots: room.bots, bullets: room.bullets });
    }
}, 1000/60);

app.get('/api/servers', (req, res) => {
    const list = {};
    ["server", "battle", "playground", "universe", "field"].forEach(s => {
        list[s] = ROOMS[s] ? Object.keys(ROOMS[s].players).length : 0;
    });
    res.json(list);
});

app.get("/plugin/:file", (req, res) => {
    res.sendFile(path.join(__dirname, "plugin", req.params.file));
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
