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

// ============================
// 1. Local Filesystem Database
// ============================
// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

function readDb() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { users: {} };
    }
}

function writeDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ============================
// 2. Middleware & Config
// ============================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================
// 3. Auth Routes (FS Based)
// ============================
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3) return res.status(400).json({ error: "Invalid input" });

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

// ============================
// 4. Game Logic & Rooms
// ============================
const BLOCK_SIZE = 64;
// Map: 1=Wall, 0=Empty
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

// State per room
const ROOMS = {}; 

function getRoomState(roomName) {
    if (!ROOMS[roomName]) {
        ROOMS[roomName] = {
            players: {},
            bullets: [],
            bots: []
        };
        // Spawn bots for this room
        for (let i = 0; i < 5; i++) {
            ROOMS[roomName].bots.push({
                id: `bot_${roomName}_${i}`,
                username: `[BOT] NPC-${i}`,
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
    // Get server room from query param
    const roomName = socket.handshake.query.server || 'server';
    socket.join(roomName);
    
    const room = getRoomState(roomName);

    socket.on('join', (data) => {
        // Fetch latest stats from DB
        const db = readDb();
        const userStats = db.users[data.username] || { kills: 0, deaths: 0 };

        room.players[socket.id] = {
            id: socket.id,
            username: data.username,
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
        // Simple movement validation could go here
        // For responsiveness, we trust client Input mostly but check collisions
        const moveSpeed = 5;
        let dx = 0, dy = 0;
        if (data.keys.w) { dx += Math.cos(p.angle)*moveSpeed; dy += Math.sin(p.angle)*moveSpeed; }
        if (data.keys.s) { dx -= Math.cos(p.angle)*moveSpeed; dy -= Math.sin(p.angle)*moveSpeed; }
        
        const nextX = p.x + dx;
        const nextY = p.y + dy;
        const gx = Math.floor(nextX / BLOCK_SIZE);
        const gy = Math.floor(nextY / BLOCK_SIZE);

        if (WORLD_MAP[gy] && WORLD_MAP[gy][gx] === 0) {
            p.x = nextX;
            p.y = nextY;
        }
    });

    socket.on('shoot', () => {
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;
        
        room.bullets.push({
            x: p.x, y: p.y, angle: p.angle,
            owner: socket.id, speed: 20, life: 50, damage: 10 // Player Damage
        });
    });

    socket.on('disconnect', () => {
        // Save stats on disconnect
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

    // Handle Ping
    socket.on('ping_check', () => socket.emit('pong_check', Date.now()));
});

// Game Loop (Process all rooms)
setInterval(() => {
    for (const roomName in ROOMS) {
        const room = ROOMS[roomName];
        
        // 1. Bot Logic
        room.bots.forEach(bot => {
            if (bot.hp <= 0) {
                 // Respawn bot
                 if (Math.random() < 0.01) {
                     bot.hp = 100;
                     bot.x = (Math.random()*10 + 2) * BLOCK_SIZE;
                     bot.y = (Math.random()*10 + 2) * BLOCK_SIZE;
                 }
                 return;
            }

            // Move Randomly
            if (Math.random() < 0.05) bot.angle += (Math.random()-0.5);
            const bx = bot.x + Math.cos(bot.angle) * 2;
            const by = bot.y + Math.sin(bot.angle) * 2;
            if (WORLD_MAP[Math.floor(by/BLOCK_SIZE)] && WORLD_MAP[Math.floor(by/BLOCK_SIZE)][Math.floor(bx/BLOCK_SIZE)] === 0) {
                bot.x = bx; bot.y = by;
            } else {
                bot.angle += 3.14; // Turn around
            }

            // Fire Randomly (0.6 ~ 2.3 seconds)
            // 60 ticks per sec. 0.6s = 36 ticks, 2.3s = 138 ticks
            if (bot.fireTimer <= 0) {
                room.bullets.push({
                    x: bot.x, y: bot.y, angle: bot.angle + (Math.random()-0.5)*0.1,
                    owner: bot.id, speed: 15, life: 60, damage: 30 // NPC Damage
                });
                bot.fireTimer = Math.floor(Math.random() * (138 - 36) + 36);
            }
            bot.fireTimer--;
        });

        // 2. Bullet Logic
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            b.x += Math.cos(b.angle) * b.speed;
            b.y += Math.sin(b.angle) * b.speed;
            b.life--;

            const gx = Math.floor(b.x / BLOCK_SIZE);
            const gy = Math.floor(b.y / BLOCK_SIZE);

            if (!WORLD_MAP[gy] || WORLD_MAP[gy][gx] === 1 || b.life <= 0) {
                room.bullets.splice(i, 1);
                continue;
            }

            // Collision with Players & Bots
            const allEntities = [...Object.values(room.players), ...room.bots];
            
            for (const entity of allEntities) {
                if (entity.hp <= 0 || entity.id === b.owner) continue;

                const dist = Math.hypot(entity.x - b.x, entity.y - b.y);
                if (dist < 30) {
                    entity.hp -= b.damage;
                    room.bullets.splice(i, 1);

                    if (entity.hp <= 0) {
                        entity.deaths = (entity.deaths || 0) + 1;
                        
                        // Identify killer name
                        let killerName = "Unknown";
                        if (b.owner.startsWith('bot')) {
                             const bot = room.bots.find(x => x.id === b.owner);
                             killerName = bot ? bot.username : "NPC";
                        } else if (room.players[b.owner]) {
                             killerName = room.players[b.owner].username;
                             room.players[b.owner].kills++;
                        }

                        // Send Death Event if it's a real player
                        if (!entity.isBot) {
                            io.to(entity.id).emit('died', { killer: killerName });
                            // Respawn timer handled by client request or auto logic
                            setTimeout(() => {
                                if (room.players[entity.id]) {
                                    room.players[entity.id].hp = 150;
                                    room.players[entity.id].x = 2 * BLOCK_SIZE;
                                    room.players[entity.id].y = 2 * BLOCK_SIZE;
                                }
                            }, 3000);
                        }
                    }
                    break;
                }
            }
        }
        
        // Broadcast to this room only
        io.to(roomName).emit('state', { 
            players: room.players, 
            bots: room.bots,
            bullets: room.bullets,
            playerCount: Object.keys(room.players).length
        });
    }
}, 1000 / 60);

// API to get room counts
app.get('/api/servers', (req, res) => {
    const list = {};
    const servers = ["battle", "nex", "playground", "server", "index", "space", "universe", "contraption"];
    servers.forEach(s => {
        list[s] = ROOMS[s] ? Object.keys(ROOMS[s].players).length : 0;
    });
    res.json(list);
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
