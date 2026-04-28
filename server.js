const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingTimeout: 120000,
    pingInterval: 25000,
    upgradeTimeout: 30000
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== PostgreSQL ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000
});

pool.on('error', (err) => console.error('Unexpected DB error', err));

// ========== Cloudinary конфигурация ==========
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const videoStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'therapy_call_videos',
        resource_type: 'video',
        allowed_formats: ['mp4', 'mov', 'avi', 'webm', 'mkv']
    }
});

const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'therapy_call_images',
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp']
    }
});

const memoryStorage = multer.memoryStorage();
const upload = multer({ storage: memoryStorage, limits: { fileSize: 100 * 1024 * 1024 } });
const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 100 * 1024 * 1024 } });
const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// ========== Хеширование паролей ==========
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return verifyHash === hash;
}

// ========== JWT (долгий токен 90 дней) ==========
const JWT_SECRET = process.env.JWT_SECRET || 'therapy_call_secret_change_me';
function generateAccessToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '90d' });
}

function verifyAccessToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Требуется авторизация' });
    const decoded = verifyAccessToken(token);
    if (!decoded) return res.status(403).json({ success: false, error: 'Недействительный токен' });
    req.userId = decoded.userId;
    next();
}

// ========== Инициализация таблиц ==========
async function initDatabase() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(50) PRIMARY KEY,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT,
            password TEXT NOT NULL,
            role TEXT NOT NULL,
            specialization TEXT,
            experience TEXT,
            about TEXT,
            price INTEGER DEFAULT 0,
            topics JSONB DEFAULT '[]',
            schedule JSONB DEFAULT '{}',
            certificates JSONB DEFAULT '[]',
            rating FLOAT DEFAULT 0,
            avatar TEXT,
            appointments JSONB DEFAULT '[]',
            clients JSONB DEFAULT '[]',
            notifications JSONB DEFAULT '[]',
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS user_unreads (
            user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            from_user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            count INT DEFAULT 0,
            PRIMARY KEY (user_id, from_user_id)
        )`,
        `CREATE TABLE IF NOT EXISTS posts (
            id VARCHAR(50) PRIMARY KEY,
            author_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            image TEXT,
            video TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS likes (
            id VARCHAR(50) PRIMARY KEY,
            post_id VARCHAR(50) REFERENCES posts(id) ON DELETE CASCADE,
            user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS comments (
            id VARCHAR(50) PRIMARY KEY,
            post_id VARCHAR(50) REFERENCES posts(id) ON DELETE CASCADE,
            author_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(50) PRIMARY KEY,
            from_user VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            to_user VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            text TEXT,
            image TEXT,
            voice TEXT,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS appointments (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id),
            client_id VARCHAR(50) REFERENCES users(id),
            psychologist_name TEXT,
            client_name TEXT,
            date TEXT,
            time TEXT,
            room_id TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS tasks (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            due_date TEXT,
            completed BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS reviews (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            client_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            client_name TEXT,
            rating INTEGER,
            text TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS notes (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            title TEXT,
            content TEXT,
            attachment TEXT,
            attachment_type TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS subscriptions (
            id VARCHAR(50) PRIMARY KEY,
            follower_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            following_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS certificates (
            id VARCHAR(50) PRIMARY KEY,
            user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            title TEXT,
            image TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS time_slots (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            status TEXT DEFAULT 'free',
            appointment_id VARCHAR(50),
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(psychologist_id, date, time)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id)`,
        `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_psychologist ON appointments(psychologist_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
        `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
        `CREATE INDEX IF NOT EXISTS idx_time_slots_psychologist ON time_slots(psychologist_id)`
    ];
    for (const q of queries) {
        try { await pool.query(q); } catch (err) { console.error('Ошибка создания таблицы:', err.message); }
    }
    console.log('✅ База данных инициализирована');
}

// ========== Вспомогательные функции ==========
function safeJSONParse(str, defaultValue) {
    if (!str || str === 'null' || str === 'undefined') return defaultValue;
    if (typeof str === 'object') return str;
    try { return JSON.parse(str); } catch (e) { return defaultValue; }
}

async function getUser(id) {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (result.rows.length === 0) return null;
        const r = result.rows[0];
        const unreadsRes = await pool.query('SELECT from_user_id, count FROM user_unreads WHERE user_id = $1', [id]);
        const unreadCounts = {};
        unreadsRes.rows.forEach(row => { unreadCounts[row.from_user_id] = row.count; });
        return {
            id: r.id,
            fullName: r.full_name,
            email: r.email,
            phone: r.phone,
            password: r.password,
            role: r.role,
            specialization: r.specialization,
            experience: r.experience,
            about: r.about,
            price: r.price,
            topics: safeJSONParse(r.topics, []),
            schedule: safeJSONParse(r.schedule, {}),
            certificates: safeJSONParse(r.certificates, []),
            rating: r.rating || 0,
            avatar: r.avatar,
            appointments: safeJSONParse(r.appointments, []),
            clients: safeJSONParse(r.clients, []),
            notifications: safeJSONParse(r.notifications, []),
            unreadCounts,
            createdAt: r.created_at
        };
    } catch (err) { console.error('getUser error:', err); return null; }
}

async function updateUser(user) {
    await pool.query(
        `UPDATE users SET
            full_name=$2, email=$3, phone=$4, password=$5, role=$6,
            specialization=$7, experience=$8, about=$9, price=$10,
            topics=$11, schedule=$12, certificates=$13, rating=$14,
            avatar=$15, appointments=$16, clients=$17, notifications=$18
         WHERE id=$1`,
        [
            user.id, user.fullName || '', user.email, user.phone || '', user.password,
            user.role, user.specialization || '', user.experience || '', user.about || '',
            user.price || 0, JSON.stringify(user.topics || []), JSON.stringify(user.schedule || {}),
            JSON.stringify(user.certificates || []), user.rating || 0, user.avatar || '',
            JSON.stringify(user.appointments || []), JSON.stringify(user.clients || []),
            JSON.stringify(user.notifications || [])
        ]
    );
}

function fileToBase64(file) {
    if (!file) return null;
    const mime = file.mimetype;
    const b64 = file.buffer.toString('base64');
    return `data:${mime};base64,${b64}`;
}

// ========== Маршруты регистрации / логина ==========
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, phone, password, role, specialization, experience, about } = req.body;
        if (!fullName || !email || !password) return res.json({ success: false, error: 'Заполните обязательные поля' });
        const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
        if (existing.rows.length > 0) return res.json({ success: false, error: 'Email уже используется' });
        if (role === 'psychologist' && (!specialization || !experience)) {
            return res.json({ success: false, error: 'Заполните специализацию и опыт' });
        }
        const id = nanoid(12);
        const hashed = hashPassword(password);
        const avatar = `https://ui-avatars.com/api/?background=8bca8b&color=fff&name=${encodeURIComponent(fullName)}&size=128`;
        await pool.query(
            `INSERT INTO users (id,full_name,email,phone,password,role,specialization,experience,about,price,topics,schedule,certificates,rating,avatar,appointments,clients,notifications,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [id, fullName, email, phone || '', hashed, role, specialization || '', experience || '', about || '', 0,
             '[]', '{}', '[]', 0, avatar, '[]', '[]', '[]', new Date().toISOString()]
        );
        const token = generateAccessToken(id);
        res.json({ success: true, accessToken: token, userId: id, role });
    } catch (err) {
        console.error('Register error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT id, password, role, full_name FROM users WHERE email=$1', [email]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'Неверный email или пароль' });
        const user = result.rows[0];
        const valid = verifyPassword(password, user.password);
        if (!valid) return res.json({ success: false, error: 'Неверный email или пароль' });
        const token = generateAccessToken(user.id);
        res.json({ success: true, accessToken: token, userId: user.id, role: user.role, fullName: user.full_name });
    } catch (err) {
        console.error('Login error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await getUser(req.userId);
        if (!user) return res.status(401).json({ success: false, error: 'Пользователь не найден' });
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) {
        console.error('/api/me error:', err);
        res.status(500).json({ success: false });
    }
});

// ========== Пользователи ==========
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await getUser(req.params.id);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        const { password, ...userData } = user;
        res.json({ success: true, user: userData });
    } catch (err) {
        console.error('Get user error:', err);
        res.json({ success: false });
    }
});

app.put('/api/user/profile', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        const user = await getUser(req.userId);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        const { fullName, phone, about, specialization, experience, price, avatar } = req.body;
        if (fullName) user.fullName = fullName;
        if (phone !== undefined) user.phone = phone;
        if (about !== undefined) user.about = about;
        if (specialization !== undefined) user.specialization = specialization;
        if (experience !== undefined) user.experience = experience;
        if (price !== undefined) user.price = parseInt(price) || 0;
        if (req.file) {
            user.avatar = fileToBase64(req.file);
        } else if (avatar && avatar.startsWith('data:image')) {
            user.avatar = avatar;
        }
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) {
        console.error('Profile update error:', err);
        res.json({ success: false });
    }
});

// ========== Расписание ==========
app.get('/api/schedule/:psychologistId', async (req, res) => {
    try {
        const slots = await pool.query(
            `SELECT date, time FROM time_slots WHERE psychologist_id=$1 AND status='free' ORDER BY date, time`,
            [req.params.psychologistId]
        );
        const schedule = {};
        slots.rows.forEach(s => {
            if (!schedule[s.date]) schedule[s.date] = [];
            schedule[s.date].push(s.time);
        });
        res.json({ success: true, schedule });
    } catch (err) {
        console.error('Get schedule error:', err);
        res.json({ success: false });
    }
});

app.put('/api/schedule', authenticateToken, async (req, res) => {
    try {
        const user = await getUser(req.userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        const { schedule } = req.body;
        await pool.query(`DELETE FROM time_slots WHERE psychologist_id=$1 AND status='free'`, [user.id]);
        for (const [date, times] of Object.entries(schedule)) {
            for (const time of times) {
                await pool.query(
                    `INSERT INTO time_slots (id, psychologist_id, date, time, status) VALUES ($1,$2,$3,$4,'free')`,
                    [nanoid(12), user.id, date, time]
                );
            }
        }
        user.schedule = schedule;
        await updateUser(user);
        res.json({ success: true, schedule });
    } catch (err) {
        console.error('Schedule update error:', err);
        res.json({ success: false });
    }
});

// ========== Запись на приём ==========
app.post('/api/appointment', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { psychologistId, date, time } = req.body;
        const clientUser = await getUser(req.userId);
        const psychologist = await getUser(psychologistId);
        if (!clientUser || !psychologist) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        const slotRes = await client.query(
            `SELECT id FROM time_slots WHERE psychologist_id=$1 AND date=$2 AND time=$3 AND status='free' FOR UPDATE`,
            [psychologistId, date, time]
        );
        if (slotRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Это время уже занято или не входит в расписание' });
        }
        const slotId = slotRes.rows[0].id;
        const roomId = nanoid(8).toUpperCase();
        const appointmentId = nanoid(12);
        await client.query(`UPDATE time_slots SET status='pending', appointment_id=$1 WHERE id=$2`, [appointmentId, slotId]);
        await client.query(
            `INSERT INTO appointments (id,psychologist_id,client_id,psychologist_name,client_name,date,time,room_id,status,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [appointmentId, psychologistId, clientUser.id, psychologist.fullName, clientUser.fullName, date, time, roomId, 'pending', new Date().toISOString()]
        );
        if (!clientUser.appointments) clientUser.appointments = [];
        clientUser.appointments.push({
            id: appointmentId, psychologistId, psychologistName: psychologist.fullName,
            clientId: clientUser.id, clientName: clientUser.fullName, date, time, roomId, status: 'pending'
        });
        if (!psychologist.clients) psychologist.clients = [];
        psychologist.clients.push({
            clientId: clientUser.id, clientName: clientUser.fullName,
            appointmentId, date, time, status: 'pending', roomId
        });
        const notification = {
            id: nanoid(12), type: 'new_appointment',
            title: 'Новая заявка',
            message: `${clientUser.fullName} хочет записаться на ${date} в ${time}`,
            appointmentId, roomId, createdAt: new Date().toISOString()
        };
        if (!psychologist.notifications) psychologist.notifications = [];
        psychologist.notifications.unshift(notification);
        await updateUser(psychologist);
        await updateUser(clientUser);
        await client.query('COMMIT');
        io.to(psychologistId).emit('notification', notification);
        io.to(psychologistId).emit('appointment_created', { id: appointmentId, psychologist_id: psychologistId, client_id: clientUser.id, date, time, room_id: roomId, status: 'pending' });
        res.json({ success: true, appointment: { id: appointmentId, roomId, date, time, status: 'pending' } });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Appointment error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/appointment/confirm', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { appointmentId, clientId } = req.body;
        const psychologist = await getUser(req.userId);
        if (!psychologist || psychologist.role !== 'psychologist') {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Нет прав' });
        }
        const aptRes = await client.query('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
        if (aptRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Запись не найдена' });
        }
        const apt = aptRes.rows[0];
        await client.query(
            `UPDATE time_slots SET status='booked' WHERE psychologist_id=$1 AND date=$2 AND time=$3 AND appointment_id=$4`,
            [psychologist.id, apt.date, apt.time, appointmentId]
        );
        await client.query('UPDATE appointments SET status=$1 WHERE id=$2', ['confirmed', appointmentId]);
        const clientUser = await getUser(clientId);
        if (clientUser) {
            const appt = (clientUser.appointments || []).find(a => a.id === appointmentId);
            if (appt) appt.status = 'confirmed';
            await updateUser(clientUser);
        }
        if (psychologist) {
            const c = (psychologist.clients || []).find(c => c.appointmentId === appointmentId);
            if (c) c.status = 'confirmed';
            psychologist.notifications = (psychologist.notifications || []).filter(n => n.appointmentId !== appointmentId);
            await updateUser(psychologist);
        }
        const clientNotif = {
            id: nanoid(12), type: 'appointment_confirmed',
            title: 'Запись подтверждена!',
            message: `${psychologist.fullName} подтвердил запись на ${apt.date} в ${apt.time}`,
            appointmentId, roomId: apt.room_id, createdAt: new Date().toISOString()
        };
        if (clientUser) {
            if (!clientUser.notifications) clientUser.notifications = [];
            clientUser.notifications.unshift(clientNotif);
            await updateUser(clientUser);
        }
        await client.query('COMMIT');
        io.to(clientId).emit('notification', clientNotif);
        io.to(clientId).emit('appointment_updated', apt);
        io.to(psychologist.id).emit('appointment_updated', apt);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Confirm appointment error:', err);
        res.json({ success: false });
    } finally {
        client.release();
    }
});

app.post('/api/appointment/complete', authenticateToken, async (req, res) => {
    try {
        const { appointmentId } = req.body;
        await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', ['completed', appointmentId]);
        const aptRes = await pool.query('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
        const apt = aptRes.rows[0];
        if (!apt) return res.json({ success: false });
        const psychologist = await getUser(apt.psychologist_id);
        const client = await getUser(apt.client_id);
        if (psychologist) {
            const c = (psychologist.clients || []).find(c => c.appointmentId === appointmentId);
            if (c) c.status = 'completed';
            await updateUser(psychologist);
        }
        if (client) {
            const a = (client.appointments || []).find(a => a.id === appointmentId);
            if (a) a.status = 'completed';
            await updateUser(client);
        }
        io.to(apt.psychologist_id).emit('appointment_completed', appointmentId);
        io.to(apt.client_id).emit('appointment_completed', appointmentId);
        res.json({ success: true });
    } catch (err) {
        console.error('Complete appointment error:', err);
        res.json({ success: false });
    }
});

// ========== Посты ==========
app.post('/api/posts', authenticateToken, async (req, res) => {
    try {
        const author = await getUser(req.userId);
        if (!author || author.role !== 'psychologist') return res.json({ success: false, error: 'Только психологи могут создавать посты' });
        const { text, image, video } = req.body;
        const newPost = {
            id: nanoid(12), author_id: req.userId, text,
            image: image || null, video: video || null,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO posts (id,author_id,text,image,video,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
            [newPost.id, newPost.author_id, newPost.text, newPost.image, newPost.video, newPost.created_at]);
        io.emit('post_created', newPost);
        res.json({ success: true, post: newPost });
    } catch (err) { console.error('Create post error:', err); res.json({ success: false }); }
});

app.get('/api/posts', async (req, res) => {
    try {
        const userId = req.query.userId || null;
        const postsRes = await pool.query(`
            SELECT
                p.id, p.text, p.image, p.video, p.created_at,
                u.id AS author_id, u.full_name AS author_name,
                u.avatar AS author_avatar, u.rating AS author_rating,
                COALESCE(COUNT(DISTINCT l.id), 0) AS likes_count
            FROM posts p
            JOIN users u ON p.author_id = u.id
            LEFT JOIN likes l ON l.post_id = p.id
            GROUP BY p.id, p.text, p.image, p.video, p.created_at,
                     u.id, u.full_name, u.avatar, u.rating
            ORDER BY p.created_at DESC
        `);
        const postIds = postsRes.rows.map(p => p.id);
        if (postIds.length === 0) return res.json({ success: true, posts: [] });
        const commentsRes = await pool.query(`
            SELECT c.id, c.post_id, c.text, c.created_at,
                   u.id AS author_id, u.full_name AS author_name, u.avatar AS author_avatar
            FROM comments c
            JOIN users u ON c.author_id = u.id
            WHERE c.post_id = ANY($1::text[])
            ORDER BY c.created_at ASC
        `, [postIds]);
        let userLikedSet = new Set();
        if (userId) {
            const likedRes = await pool.query(`SELECT post_id FROM likes WHERE user_id=$1 AND post_id=ANY($2::text[])`, [userId, postIds]);
            likedRes.rows.forEach(r => userLikedSet.add(r.post_id));
        }
        const commentsByPost = {};
        commentsRes.rows.forEach(c => {
            if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
            commentsByPost[c.post_id].push({
                id: c.id, text: c.text, createdAt: c.created_at,
                author: { id: c.author_id, fullName: c.author_name, avatar: c.author_avatar }
            });
        });
        const posts = postsRes.rows.map(p => ({
            id: p.id, text: p.text, image: p.image, video: p.video, createdAt: p.created_at,
            author: { id: p.author_id, fullName: p.author_name, avatar: p.author_avatar, rating: p.author_rating || 0 },
            likesCount: p.likes_count,
            commentsCount: (commentsByPost[p.id] || []).length,
            comments: commentsByPost[p.id] || [],
            userLiked: userLikedSet.has(p.id)
        }));
        res.json({ success: true, posts });
    } catch (err) { console.error('Get posts error:', err); res.json({ success: false }); }
});

app.put('/api/posts/:id', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const { text } = req.body;
        const postRes = await pool.query('SELECT * FROM posts WHERE id=$1', [postId]);
        if (postRes.rows.length === 0) return res.json({ success: false, error: 'Пост не найден' });
        if (postRes.rows[0].author_id !== req.userId) return res.json({ success: false, error: 'Нет прав' });
        await pool.query('UPDATE posts SET text=$1 WHERE id=$2', [text, postId]);
        io.emit('post_updated', { id: postId, text });
        res.json({ success: true });
    } catch (err) { console.error('Update post error:', err); res.json({ success: false }); }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const postRes = await pool.query('SELECT * FROM posts WHERE id=$1', [postId]);
        if (postRes.rows.length === 0) return res.json({ success: false, error: 'Пост не найден' });
        if (postRes.rows[0].author_id !== req.userId) return res.json({ success: false, error: 'Нет прав' });
        await pool.query('DELETE FROM comments WHERE post_id=$1', [postId]);
        await pool.query('DELETE FROM likes WHERE post_id=$1', [postId]);
        await pool.query('DELETE FROM posts WHERE id=$1', [postId]);
        io.emit('post_deleted', postId);
        res.json({ success: true });
    } catch (err) { console.error('Delete post error:', err); res.json({ success: false }); }
});

app.post('/api/posts/:id/comment', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const { text } = req.body;
        const newComment = {
            id: nanoid(12), post_id: postId, author_id: req.userId, text,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO comments (id,post_id,author_id,text,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [newComment.id, newComment.post_id, newComment.author_id, newComment.text, newComment.created_at]);
        const author = await getUser(req.userId);
        const commentWithAuthor = {
            id: newComment.id, text: newComment.text, createdAt: newComment.created_at,
            author: { id: author.id, fullName: author.fullName, avatar: author.avatar }
        };
        io.emit('comment_created', { postId, comment: commentWithAuthor });
        res.json({ success: true });
    } catch (err) { console.error('Add comment error:', err); res.json({ success: false }); }
});

app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const userId = req.userId;
        const existing = await pool.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
        } else {
            await pool.query(`INSERT INTO likes (id,post_id,user_id,created_at) VALUES ($1,$2,$3,$4)`, [nanoid(12), postId, userId, new Date().toISOString()]);
        }
        const countRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM likes WHERE post_id=$1', [postId]);
        const likesCount = countRes.rows[0].cnt;
        const liked = existing.rows.length === 0;
        io.emit('post_liked', { postId, likesCount, userId, liked });
        res.json({ success: true, liked, likesCount });
    } catch (err) { console.error('Like error:', err); res.json({ success: false }); }
});

// ========== Загрузка медиа через Cloudinary ==========
app.post('/api/upload-video', authenticateToken, uploadVideo.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Видео не загружено' });
    res.json({ success: true, videoUrl: req.file.path });
});

app.post('/api/upload-image', authenticateToken, uploadImage.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Изображение не загружено' });
    res.json({ success: true, imageUrl: req.file.path });
});

// ========== Остальные загрузки (base64) ==========
app.post('/api/upload-avatar', authenticateToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, avatarUrl: fileToBase64(req.file) });
});

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, fileUrl: fileToBase64(req.file) });
});

app.post('/api/upload-chat-image', authenticateToken, upload.single('image'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, imageUrl: fileToBase64(req.file) });
});

app.post('/api/upload-voice', authenticateToken, upload.single('voice'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    if (req.file.size > 5 * 1024 * 1024) {
        return res.json({ success: false, error: 'Размер голосового сообщения не должен превышать 5 МБ' });
    }
    res.json({ success: true, voiceUrl: fileToBase64(req.file) });
});

app.post('/api/upload-recording', authenticateToken, upload.single('recording'), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    const recording = { id: nanoid(12), url: fileToBase64(req.file), from_user: req.userId, to_user: req.body.to, room_id: req.body.roomId, created_at: new Date().toISOString() };
    await pool.query(`INSERT INTO recordings (id,url,from_user,to_user,room_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [recording.id, recording.url, recording.from_user, recording.to_user, recording.room_id, recording.created_at]);
    res.json({ success: true, recordingUrl: recording.url });
});

// ========== Задачи ==========
app.get('/api/tasks/:psychologistId', authenticateToken, async (req, res) => {
    if (req.params.psychologistId !== req.userId) return res.json({ success: false, error: 'Нет прав' });
    try {
        const result = await pool.query('SELECT * FROM tasks WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.userId]);
        const tasks = result.rows.map(t => ({ id: t.id, psychologistId: t.psychologist_id, text: t.text, dueDate: t.due_date, completed: t.completed, createdAt: t.created_at }));
        res.json({ success: true, tasks });
    } catch (err) { console.error('Get tasks error:', err); res.json({ success: false }); }
});

app.post('/api/tasks', authenticateToken, async (req, res) => {
    try {
        const { text, dueDate } = req.body;
        const newTask = { id: nanoid(12), psychologist_id: req.userId, text, due_date: dueDate || null, completed: false, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO tasks (id,psychologist_id,text,due_date,completed,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
            [newTask.id, newTask.psychologist_id, newTask.text, newTask.due_date, newTask.completed, newTask.created_at]);
        res.json({ success: true, task: { ...newTask, dueDate: newTask.due_date, createdAt: newTask.created_at } });
    } catch (err) { console.error('Create task error:', err); res.json({ success: false }); }
});

app.put('/api/tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        const { completed, text, dueDate } = req.body;
        await pool.query('UPDATE tasks SET completed=$1, text=COALESCE($2,text), due_date=COALESCE($3,due_date) WHERE id=$4 AND psychologist_id=$5',
            [completed, text || null, dueDate || null, req.params.taskId, req.userId]);
        res.json({ success: true });
    } catch (err) { console.error('Update task error:', err); res.json({ success: false }); }
});

app.delete('/api/tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM tasks WHERE id=$1 AND psychologist_id=$2', [req.params.taskId, req.userId]);
        res.json({ success: true });
    } catch (err) { console.error('Delete task error:', err); res.json({ success: false }); }
});

// ========== Заметки ==========
app.get('/api/notes/:psychologistId', authenticateToken, async (req, res) => {
    if (req.params.psychologistId !== req.userId) return res.json({ success: false, error: 'Нет прав' });
    try {
        const result = await pool.query('SELECT * FROM notes WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.userId]);
        const notes = result.rows.map(n => ({ id: n.id, psychologistId: n.psychologist_id, title: n.title, content: n.content, attachment: n.attachment, attachmentType: n.attachment_type, createdAt: n.created_at }));
        res.json({ success: true, notes });
    } catch (err) { console.error('Get notes error:', err); res.json({ success: false }); }
});

app.post('/api/notes', authenticateToken, async (req, res) => {
    try {
        const { title, content, attachment, attachmentType } = req.body;
        const newNote = { id: nanoid(12), psychologist_id: req.userId, title, content, attachment: attachment || null, attachment_type: attachmentType || null, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO notes (id,psychologist_id,title,content,attachment,attachment_type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newNote.id, newNote.psychologist_id, newNote.title, newNote.content, newNote.attachment, newNote.attachment_type, newNote.created_at]);
        res.json({ success: true, note: newNote });
    } catch (err) { console.error('Create note error:', err); res.json({ success: false }); }
});

app.delete('/api/notes/:noteId', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM notes WHERE id=$1 AND psychologist_id=$2', [req.params.noteId, req.userId]);
        res.json({ success: true });
    } catch (err) { console.error('Delete note error:', err); res.json({ success: false }); }
});

// ========== Отзывы ==========
app.post('/api/reviews', authenticateToken, async (req, res) => {
    try {
        const { psychologistId, rating, text } = req.body;
        const client = await getUser(req.userId);
        const psychologist = await getUser(psychologistId);
        if (!client || !psychologist) return res.json({ success: false, error: 'Пользователь не найден' });
        const hasAppointment = (client.appointments || []).some(a => a.psychologistId === psychologistId && a.status === 'confirmed');
        if (!hasAppointment) return res.json({ success: false, error: 'Вы можете оставить отзыв только после подтверждённого звонка' });
        const existing = await pool.query('SELECT 1 FROM reviews WHERE psychologist_id=$1 AND client_id=$2', [psychologistId, req.userId]);
        if (existing.rows.length > 0) return res.json({ success: false, error: 'Вы уже оставляли отзыв этому психологу' });
        const newReview = { id: nanoid(12), psychologist_id: psychologistId, client_id: req.userId, client_name: client.fullName, rating: Math.min(5, Math.max(1, rating)), text, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO reviews (id,psychologist_id,client_id,client_name,rating,text,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [newReview.id, newReview.psychologist_id, newReview.client_id, newReview.client_name, newReview.rating, newReview.text, newReview.created_at]);
        const reviewsRes = await pool.query('SELECT rating FROM reviews WHERE psychologist_id=$1', [psychologistId]);
        const sum = reviewsRes.rows.reduce((s, r) => s + r.rating, 0);
        const avgRating = reviewsRes.rows.length ? sum / reviewsRes.rows.length : 0;
        const postsRes = await pool.query('SELECT id FROM posts WHERE author_id=$1', [psychologistId]);
        let totalLikes = 0;
        if (postsRes.rows.length > 0) {
            const pids = postsRes.rows.map(p => p.id);
            const likesRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM likes WHERE post_id=ANY($1::text[])', [pids]);
            totalLikes = likesRes.rows[0].cnt;
        }
        const bonus = Math.min(1, totalLikes * 0.01);
        psychologist.rating = Math.min(5, avgRating + bonus);
        await updateUser(psychologist);
        res.json({ success: true, review: newReview, newRating: psychologist.rating });
    } catch (err) { console.error('Review error:', err); res.json({ success: false }); }
});

app.get('/api/reviews/:psychologistId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reviews WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const reviews = result.rows.map(r => ({ id: r.id, psychologistId: r.psychologist_id, clientId: r.client_id, clientName: r.client_name, rating: r.rating, text: r.text, createdAt: r.created_at }));
        res.json({ success: true, reviews });
    } catch (err) { console.error('Get reviews error:', err); res.json({ success: false }); }
});

// ========== Сертификаты ==========
app.post('/api/certificates', authenticateToken, upload.single('certificate'), async (req, res) => {
    try {
        const user = await getUser(req.userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        const { title } = req.body;
        if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
        const imageBase64 = fileToBase64(req.file);
        const newCert = { id: nanoid(12), user_id: req.userId, title: title || 'Сертификат', image: imageBase64, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO certificates (id,user_id,title,image,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [newCert.id, newCert.user_id, newCert.title, newCert.image, newCert.created_at]);
        if (!user.certificates) user.certificates = [];
        user.certificates.push({ id: newCert.id, title: newCert.title, image: newCert.image });
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, certificate: newCert, user: safeUser });
    } catch (err) { console.error('Certificate error:', err); res.json({ success: false }); }
});

app.delete('/api/certificates/:certId', authenticateToken, async (req, res) => {
    try {
        const user = await getUser(req.userId);
        if (!user) return res.json({ success: false });
        await pool.query('DELETE FROM certificates WHERE id=$1 AND user_id=$2', [req.params.certId, req.userId]);
        user.certificates = (user.certificates || []).filter(c => c.id !== req.params.certId);
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// ========== Подписки ==========
app.get('/api/subscriptions/:userId', async (req, res) => {
    try {
        const followingRes = await pool.query('SELECT following_id FROM subscriptions WHERE follower_id=$1', [req.params.userId]);
        const followersRes = await pool.query('SELECT follower_id FROM subscriptions WHERE following_id=$1', [req.params.userId]);
        res.json({ success: true, following: followingRes.rows.map(r => r.following_id), followers: followersRes.rows.map(r => r.follower_id) });
    } catch (err) { console.error('Subscriptions error:', err); res.json({ success: false }); }
});

app.post('/api/subscriptions', authenticateToken, async (req, res) => {
    try {
        const { followingId } = req.body;
        const followerId = req.userId;
        const existing = await pool.query('SELECT 1 FROM subscriptions WHERE follower_id=$1 AND following_id=$2', [followerId, followingId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM subscriptions WHERE follower_id=$1 AND following_id=$2', [followerId, followingId]);
            res.json({ success: true, subscribed: false });
        } else {
            await pool.query(`INSERT INTO subscriptions (id,follower_id,following_id,created_at) VALUES ($1,$2,$3,$4)`, [nanoid(12), followerId, followingId, new Date().toISOString()]);
            res.json({ success: true, subscribed: true });
        }
    } catch (err) { console.error('Subscription error:', err); res.json({ success: false }); }
});

// ========== Психологи, поиск ==========
app.get('/api/psychologists', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id,full_name,avatar,specialization,rating,price FROM users WHERE role='psychologist'`);
        const psychologists = result.rows.map(p => ({ id: p.id, full_name: p.full_name, avatar: p.avatar, specialization: p.specialization, rating: p.rating, price: p.price }));
        res.json({ success: true, psychologists });
    } catch (err) { console.error('Get psychologists error:', err); res.json({ success: false }); }
});

app.get('/api/search/psychologists', async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase() || '';
        const result = await pool.query(`SELECT id,full_name,avatar,specialization,rating FROM users WHERE role='psychologist' AND LOWER(full_name) LIKE $1`, [`%${query}%`]);
        const psychologists = result.rows.map(p => ({ id: p.id, full_name: p.full_name, avatar: p.avatar, specialization: p.specialization, rating: p.rating }));
        res.json({ success: true, psychologists });
    } catch (err) { console.error('Search error:', err); res.json({ success: false }); }
});

// ========== Чат ==========
app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const messagesRes = await pool.query(`SELECT * FROM messages WHERE from_user=$1 OR to_user=$1 ORDER BY created_at ASC`, [userId]);
        const messages = messagesRes.rows;
        const contactIdSet = new Set();
        messages.forEach(m => { const otherId = m.from_user === userId ? m.to_user : m.from_user; if (otherId) contactIdSet.add(otherId); });
        const contactIds = Array.from(contactIdSet);
        let users = [];
        if (contactIds.length > 0) {
            const usersRes = await pool.query(`SELECT id,full_name,avatar,role FROM users WHERE id=ANY($1::text[])`, [contactIds]);
            users = usersRes.rows.map(u => ({ id: u.id, fullName: u.full_name, avatar: u.avatar, role: u.role }));
        }
        res.json({ success: true, messages, users });
    } catch (err) { console.error('Get messages error:', err); res.json({ success: false }); }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { to, text, image, voice } = req.body;
        const from = req.userId;
        if (from === to) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Нельзя отправить сообщение самому себе' }); }
        const newMsg = { id: nanoid(12), from_user: from, to_user: to, text: text || '', image: image || null, voice: voice || null, is_read: false, created_at: new Date().toISOString() };
        await client.query(`INSERT INTO messages (id,from_user,to_user,text,image,voice,is_read,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newMsg.id, newMsg.from_user, newMsg.to_user, newMsg.text, newMsg.image, newMsg.voice, newMsg.is_read, newMsg.created_at]);
        await client.query(`INSERT INTO user_unreads (user_id, from_user_id, count) VALUES ($1, $2, 1) ON CONFLICT (user_id, from_user_id) DO UPDATE SET count = user_unreads.count + 1`, [to, from]);
        const unreadRes = await client.query(`SELECT count FROM user_unreads WHERE user_id=$1 AND from_user_id=$2`, [to, from]);
        const newCount = unreadRes.rows[0]?.count || 1;
        await client.query('COMMIT');
        const msgForClient = { id: newMsg.id, from: newMsg.from_user, to: newMsg.to_user, text: newMsg.text, image: newMsg.image, voice: newMsg.voice, created_at: newMsg.created_at };
        io.to(to).emit('new_message', msgForClient);
        io.to(to).emit('unread_update', { from, count: newCount });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Send message error:', err);
        res.json({ success: false });
    } finally { client.release(); }
});

app.post('/api/messages/read', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { fromUserId } = req.body;
        const userId = req.userId;
        await client.query(`DELETE FROM user_unreads WHERE user_id=$1 AND from_user_id=$2`, [userId, fromUserId]);
        await client.query(`UPDATE messages SET is_read=true WHERE to_user=$1 AND from_user=$2`, [userId, fromUserId]);
        await client.query('COMMIT');
        io.to(userId).emit('unread_update', { from: fromUserId, count: 0 });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Mark read error:', err);
        res.json({ success: false });
    } finally { client.release(); }
});

// ========== WebRTC / Socket.IO ==========
const activeRooms = new Map();
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);
    socket.on('register_user', (userId) => { socket.userId = userId; if (userId) socket.join(userId); });
    socket.on('join-call-room', (roomId, userId, userType) => {
        try {
            if (!activeRooms.has(roomId)) activeRooms.set(roomId, { psychologist: null, client: null, users: new Map() });
            const room = activeRooms.get(roomId);
            if (userType === 'psychologist' && room.psychologist && room.psychologist !== socket.id) {
                io.to(room.psychologist).emit('partner-disconnected');
                const old = io.sockets.sockets.get(room.psychologist);
                if (old) old.leave(roomId);
                room.users.delete(room.psychologist);
            } else if (userType === 'client' && room.client && room.client !== socket.id) {
                io.to(room.client).emit('partner-disconnected');
                const old = io.sockets.sockets.get(room.client);
                if (old) old.leave(roomId);
                room.users.delete(room.client);
            }
            room.users.set(socket.id, { userId, userType });
            if (userType === 'psychologist') room.psychologist = socket.id;
            else room.client = socket.id;
            socket.join(roomId);
            socket.roomId = roomId;
            socket.userId = userId;
            socket.userType = userType;
            socket.emit('room-joined');
            if (room.psychologist && room.client) {
                io.to(room.psychologist).emit('call-ready', { partnerId: room.client });
                io.to(room.client).emit('call-ready', { partnerId: room.psychologist });
            }
        } catch (err) { console.error('join-call-room error:', err); }
    });
    socket.on('call-message', (msgData) => {
        const room = activeRooms.get(socket.roomId);
        if (room) {
            const targetId = socket.userType === 'psychologist' ? room.client : room.psychologist;
            if (targetId) io.to(targetId).emit('call-message', { from: socket.userId, text: msgData.text, time: new Date().toISOString() });
        }
    });
    socket.on('offer', (data) => { socket.to(data.target).emit('offer', { sdp: data.sdp, from: socket.id }); });
    socket.on('answer', (data) => { socket.to(data.target).emit('answer', { sdp: data.sdp, from: socket.id }); });
    socket.on('ice-candidate', (data) => { socket.to(data.target).emit('ice-candidate', { candidate: data.candidate, from: socket.id }); });
    socket.on('end-call', async () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('call-ended');
            const room = activeRooms.get(socket.roomId);
            if (room && room.users.size >= 2) {
                try {
                    const result = await pool.query('SELECT * FROM appointments WHERE room_id=$1', [socket.roomId]);
                    const apt = result.rows[0];
                    if (apt && apt.status === 'confirmed') {
                        await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', ['completed', apt.id]);
                        const psychologist = await getUser(apt.psychologist_id);
                        const client = await getUser(apt.client_id);
                        if (psychologist) {
                            const c = (psychologist.clients || []).find(c => c.appointmentId === apt.id);
                            if (c) c.status = 'completed';
                            await updateUser(psychologist);
                        }
                        if (client) {
                            const a = (client.appointments || []).find(a => a.id === apt.id);
                            if (a) a.status = 'completed';
                            await updateUser(client);
                        }
                        io.to(apt.psychologist_id).emit('appointment_completed', apt.id);
                        io.to(apt.client_id).emit('appointment_completed', apt.id);
                    }
                } catch (err) { console.error('end-call DB error:', err); }
            }
            if (room) { room.users.delete(socket.id); if (socket.userType === 'psychologist') room.psychologist = null; else room.client = null; }
            socket.leave(socket.roomId);
            delete socket.roomId;
        }
    });
    socket.on('disconnect', () => {
        console.log('WebSocket disconnected:', socket.id);
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner-disconnected');
            const room = activeRooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (socket.userType === 'psychologist') room.psychologist = null;
                else room.client = null;
                if (room.users.size === 0) setTimeout(() => { const r = activeRooms.get(socket.roomId); if (r && r.users.size === 0) activeRooms.delete(socket.roomId); }, 10000);
            }
        }
    });
});

// ========== Запуск сервера ==========
app.get('/health', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 3000;

async function startServer() {
    await initDatabase();
    server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер запущен на порту ${PORT}`));
}

startServer().catch(console.error);