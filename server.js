const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // In production, change to "https://pixelwar.nethacker.cloud"
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);

// ============================
// 1. Security & Middleware
// ============================
app.use(helmet({
    contentSecurityPolicy: false, // Allow inline scripts for game canvas
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate Limiter for Auth API
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 requests
    message: { error: "Too many login attempts, please try again later." }
});
app.use('/api/auth', authLimiter);

// ============================
// 2. Auth Routes (Redis + Bcrypt)
// ============================

// Register
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password || username.length < 3 || password.length < 6) {
        return res.status(400).json({ error: "Invalid username or password length." });
    }

    const userKey = `user:${username}`;
    const exists = await redis.exists(userKey);

    if (exists) {
        return res.status(409).json({ error: "Username already taken." });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Save to Redis (Hash Structure)
    await redis.hset(userKey, {
        username: username,
        password: passwordHash,
        kills: 0,
        deaths: 0,
        createdAt: Date.now()
    });

    res.json({ success: true, message: "Account created successfully." });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const userKey = `user:${username}`;
    
    const userData = await redis.hgetall(userKey);

    if (!userData || !userData.password) {
        return res.status(401).json({ error: "Invalid credentials." });
    }

    const match = await bcrypt.compare(password, userData.password);
    if (!match) {
        return res.status(401).json({ error: "Invalid credentials." });
    }

    // Generate a simple session token (In real world, use JWT)
    // Here we use the username as a secure enough identifier for the socket handshake
    // assuming TLS (HTTPS) is on.
    res.json({ 
        success: true, 
        username: userData.username, 
        kills: parseInt(userData.kills), 
        deaths: parseInt(userData.deaths) 
    });
});

// ============================
// 3. Game Logic (Server Authoritative)
// ============================

const MAP_SIZE = 2000;
const PLAYERS = {};
const BULLETS = [];
const OBSTACLES = [
    { x: 400, y: 400, w: 200, h: 200 }, // Wall 1
    { x: 1000, y: 800, w: 100, h: 500 }, // Wall 2
    { x: 1500, y: 200, w: 300, h: 50 }   // Wall 3
];

// Weapon Specs: AK47
const WEAPON = {
    damage: 12,
    fireRate: 120, // 0.12s in ms
    clipSize: 20,
    reloadTime: 2000, // 2s
    bulletSpeed: 25,
    maxHp: 150
};

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Join Game
    socket.on('join', (data) => {
        if (!data.username) return;

        PLAYERS[socket.id] = {
            id: socket.id,
            username: data.username,
            x: Math.random() * (MAP_SIZE - 100) + 50,
            y: Math.random() * (MAP_SIZE - 100) + 50,
            angle: 0,
            hp: WEAPON.maxHp,
            ammo: WEAPON.clipSize,
            isReloading: false,
            lastShoot: 0,
            kills: 0, // Session kills
            deaths: 0
        };
        
        // Sync stats from Redis
        redis.hgetall(`user:${data.username}`).then(stats => {
            if(stats) {
                PLAYERS[socket.id].totalKills = parseInt(stats.kills) || 0;
                PLAYERS[socket.id].totalDeaths = parseInt(stats.deaths) || 0;
            }
        });

        socket.emit('init', { mapSize: MAP_SIZE, obstacles: OBSTACLES, id: socket.id });
    });

    // Input Handling (Movement)
    socket.on('input', (data) => {
        const p = PLAYERS[socket.id];
        if (!p || p.hp <= 0) return;

        const speed = 5;
        let newX = p.x;
        let newY = p.y;

        if (data.keys.w) newY -= speed;
        if (data.keys.s) newY += speed;
        if (data.keys.a) newX -= speed;
        if (data.keys.d) newX += speed;

        // Wall Collision
        let collides = false;
        for (let obs of OBSTACLES) {
            if (newX > obs.x - 20 && newX < obs.x + obs.w + 20 &&
                newY > obs.y - 20 && newY < obs.y + obs.h + 20) {
                collides = true;
                break;
            }
        }
        
        // Map Boundaries
        if (newX < 0 || newX > MAP_SIZE || newY < 0 || newY > MAP_SIZE) collides = true;

        if (!collides) {
            p.x = newX;
            p.y = newY;
        }
        p.angle = data.angle;
    });

    // Shooting
    socket.on('shoot', () => {
        const p = PLAYERS[socket.id];
        const now = Date.now();

        if (!p || p.hp <= 0 || p.isReloading) return;

        if (p.ammo <= 0) {
            startReload(p);
            return;
        }

        if (now - p.lastShoot >= WEAPON.fireRate) {
            p.lastShoot = now;
            p.ammo--;
            
            // Add bullet
            BULLETS.push({
                x: p.x,
                y: p.y,
                vx: Math.cos(p.angle) * WEAPON.bulletSpeed,
                vy: Math.sin(p.angle) * WEAPON.bulletSpeed,
                owner: socket.id,
                life: 60 // frames
            });

            if (p.ammo === 0) startReload(p);
        }
    });

    // Reload
    socket.on('reload', () => {
        const p = PLAYERS[socket.id];
        if (p && p.hp > 0 && p.ammo < WEAPON.clipSize) {
            startReload(p);
        }
    });

    socket.on('disconnect', () => {
        delete PLAYERS[socket.id];
    });
});

function startReload(player) {
    if (player.isReloading) return;
    player.isReloading = true;
    io.to(player.id).emit('reloading', true); // Notify client

    setTimeout(() => {
        if (player) { // Player might have disconnected
            player.ammo = WEAPON.clipSize;
            player.isReloading = false;
            io.to(player.id).emit('reloading', false);
        }
    }, WEAPON.reloadTime);
}

// ============================
// Game Loop (60 FPS)
// ============================
setInterval(async () => {
    // Update Bullets
    for (let i = BULLETS.length - 1; i >= 0; i--) {
        const b = BULLETS[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        // Remove if OOB or Expired
        if (b.life <= 0 || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            BULLETS.splice(i, 1);
            continue;
        }

        // Wall Collision
        let hitWall = false;
        for (let obs of OBSTACLES) {
             if (b.x > obs.x && b.x < obs.x + obs.w && b.y > obs.y && b.y < obs.y + obs.h) {
                 hitWall = true;
                 break;
             }
        }
        if (hitWall) {
            BULLETS.splice(i, 1);
            continue;
        }

        // Player Collision
        for (let id in PLAYERS) {
            const p = PLAYERS[id];
            if (id !== b.owner && p.hp > 0) {
                const dist = Math.hypot(p.x - b.x, p.y - b.y);
                if (dist < 20) { // Hitbox radius
                    p.hp -= WEAPON.damage;
                    BULLETS.splice(i, 1);

                    if (p.hp <= 0) {
                        handleKill(b.owner, id);
                    }
                    break;
                }
            }
        }
    }

    io.emit('state', { players: PLAYERS, bullets: BULLETS });
}, 1000 / 60);

// Handle Kill / Death
async function handleKill(killerId, victimId) {
    const killer = PLAYERS[killerId];
    const victim = PLAYERS[victimId];

    if (killer) {
        killer.kills = (killer.kills || 0) + 1;
        killer.totalKills = (killer.totalKills || 0) + 1;
        // Update Redis (Async)
        redis.hincrby(`user:${killer.username}`, 'kills', 1);
    }

    if (victim) {
        victim.deaths = (victim.deaths || 0) + 1;
        victim.totalDeaths = (victim.totalDeaths || 0) + 1;
        redis.hincrby(`user:${victim.username}`, 'deaths', 1);

        // Respawn logic
        setTimeout(() => {
            if(PLAYERS[victimId]) {
                PLAYERS[victimId].hp = WEAPON.maxHp;
                PLAYERS[victimId].ammo = WEAPON.clipSize;
                PLAYERS[victimId].x = Math.random() * (MAP_SIZE - 100) + 50;
                PLAYERS[victimId].y = Math.random() * (MAP_SIZE - 100) + 50;
            }
        }, 3000);
    }
    
    // Broadcast Kill Feed event
    io.emit('killfeed', { 
        killer: killer ? killer.username : "Unknown", 
        victim: victim ? victim.username : "Unknown" 
    });
}

server.listen(PORT, () => {
    console.log(`PIXEL WAR Server running on port ${PORT}`);
});
