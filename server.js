// server.js (полный, исправленный)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
const { nanoid } = require('nanoid');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const webpush = require('web-push');

// Настройка Web Push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:test@test.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    // ЖЕСТКАЯ НАСТРОЙКА ДЛЯ RAILWAY
    transports: ['websocket', 'polling'], 
    allowUpgrades: false, // Отключаем попытки апгрейда, так как клиент сразу бьет по вебсокету
    pingTimeout: 60000,
    pingInterval: 25000,  // Чуть увеличим интервал пинга, чтобы не спамить
    perMessageDeflate: false
});

// JWT secret (обязательно задайте в .env)
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_change_me_in_production';

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Безопасность
app.use(helmet());

// Rate limiting
// Лимит запросов для API (защита от brute-force) – привязываем к userId, а не к IP
// Rate limiting
// Лимит запросов для API (защита от brute-force) – привязываем к userId, а не к IP
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 150, // чуть увеличим до 150, чтобы не мешать нормальной работе
    validate: false,
    message: { success: false, error: 'Слишком много запросов, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: false, // <-- ОТКЛЮЧАЕМ СТРОГИЕ ПРОВЕРКИ IPV6
    keyGenerator: (req) => {
        // 1) Если авторизован – используем userId
        if (req.user && req.user.userId) {
            return `user:${req.user.userId}`;
        }
        // 2) Если есть токен в заголовке – пробуем извлечь userId
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
                try {
                    const decoded = jwt.verify(token, JWT_SECRET);
                    if (decoded && decoded.userId) {
                        return `user:${decoded.userId}`;
                    }
                } catch (e) {
                    // невалидный токен – игнорируем
                }
            }
        }
        // 3) Для неавторизованных – IP
        return req.ip || req.socket.remoteAddress || 'anonymous';
    },
    skip: (req) => {
        // Пропускаем health-проверки
        return req.path === '/health';
    }
});
app.use('/api/', apiLimiter);

// Более строгий лимит для логина/регистрации
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    skipSuccessfulRequests: true,
    validate: false // <-- ОТКЛЮЧАЕМ ПРОВЕРКИ И ЗДЕСЬ ТОЖЕ
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ========== PostgreSQL подключение ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000
});

pool.on('error', (err) => console.error('Unexpected DB error', err));

// ========== Cloudinary настройка ==========
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ========== Cloudinary настройка ==========
// ... тут твои конфиги cloudinary.config ...

const cloudinaryStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
        let folder = 'therapy_call_general';
        let resource_type = 'auto';
        let format = undefined; // По умолчанию формат определит сам Cloudinary

        if (file.fieldname === 'avatar') {
            folder = 'therapy_call_avatars';
            resource_type = 'image';
        } else if (file.fieldname === 'certificate') {
            folder = 'therapy_call_certificates';
            resource_type = 'image';
        } else if (file.fieldname === 'voice') {
            folder = 'therapy_call_voice';
            resource_type = 'video';
        } else if (file.fieldname === 'image' || file.fieldname === 'chat_image') {
            folder = 'therapy_call_images';
            resource_type = 'image';
        } else if (file.fieldname === 'video' || file.fieldname === 'recording') {
            folder = 'therapy_call_videos';
            resource_type = 'video';
        } else if (file.fieldname === 'file') {
            folder = 'therapy_call_documents';
            resource_type = 'raw';
            // КРИТИЧНО: Чтобы PDF и Word не были пустыми, жестко сохраняем их родное расширение!
            format = file.originalname.split('.').pop().toLowerCase();
        }

        const params = { folder: folder, resource_type: resource_type };
        if (format) params.format = format;
        
        // Лимитируем форматы только для картинок/видео, сырые файлы (документы) пропускаем как есть
        if (resource_type !== 'raw') {
            params.allowed_formats = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'avi', 'webm', 'ogg', 'wav', 'mp3'];
        }

        return params;
    }
});
const uploadMedia = multer({ storage: cloudinaryStorage, limits: { fileSize: 40 * 1024 * 1024 } }); // Оставили 40 МБ для видео, как ты и просил

const docStorageCloudinary = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => ({
        folder: 'therapy_call_documents',
        resource_type: 'raw',
        format: file.originalname.split('.').pop().toLowerCase()
    })
});
const uploadDoc = multer({ storage: docStorageCloudinary, limits: { fileSize: 10 * 1024 * 1024 } });

// ========== Middleware аутентификации ==========
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Требуется авторизация' });
    }
    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ success: false, error: 'Недействительный токен' });
    }
}

function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        try { req.user = jwt.verify(token, JWT_SECRET); } catch (err) {}
    }
    next();
}

function requirePsychologist(req, res, next) {
    if (req.user.role !== 'psychologist') {
        return res.status(403).json({ success: false, error: 'Доступ только для психологов' });
    }
    next();
}

function requireClient(req, res, next) {
    if (req.user.role !== 'client') {
        return res.status(403).json({ success: false, error: 'Доступ только для клиентов' });
    }
    next();
}

// ========== Инициализация таблиц и индексов ==========
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
            emergency_contacts JSONB DEFAULT '[]',
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
            duration_seconds INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS recordings (
            id VARCHAR(50) PRIMARY KEY,
            url TEXT NOT NULL,
            from_user VARCHAR(50),
            to_user VARCHAR(50),
            room_id TEXT,
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
            appointment_id VARCHAR(50) REFERENCES appointments(id) ON DELETE SET NULL,
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
        `CREATE TABLE IF NOT EXISTS client_profiles (
            user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            birth_date DATE,
            gender VARCHAR(10),
            emergency_phone TEXT,
            complaints TEXT,
            goals TEXT,
            additional_data JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS client_notes (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            client_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            note TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS client_homeworks (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            client_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            due_date DATE,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS client_progress (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            client_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            value INTEGER CHECK (value >= 1 AND value <= 10),
            type VARCHAR(20) DEFAULT 'psychologist',
            date DATE DEFAULT CURRENT_DATE,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS questionnaires (
            id VARCHAR(50) PRIMARY KEY,
            psychologist_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT,
            is_published BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS questions (
            id VARCHAR(50) PRIMARY KEY,
            questionnaire_id VARCHAR(50) REFERENCES questionnaires(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            type VARCHAR(20) DEFAULT 'text',
            options JSONB DEFAULT '[]',
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS answers (
            id VARCHAR(50) PRIMARY KEY,
            client_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
            questionnaire_id VARCHAR(50) REFERENCES questionnaires(id) ON DELETE CASCADE,
            question_id VARCHAR(50) REFERENCES questions(id) ON DELETE CASCADE,
            answer_value TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id)`,
        `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_likes_post_user ON likes(post_id, user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_psychologist ON appointments(psychologist_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
        `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
        `CREATE INDEX IF NOT EXISTS idx_time_slots_psychologist ON time_slots(psychologist_id)`,
        `CREATE INDEX IF NOT EXISTS idx_reviews_appointment_id ON reviews(appointment_id)`,
        `CREATE INDEX IF NOT EXISTS idx_client_homeworks_client ON client_homeworks(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_client_progress_client ON client_progress(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_answers_client ON answers(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_subscriptions_follower_following ON subscriptions(follower_id, following_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date)`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS push_subscriptions JSONB DEFAULT '[]'`
    ];
    
    for (const q of queries) {
        try {
            await pool.query(q);
        } catch (err) {
            console.error('Ошибка выполнения запроса:', err.message);
        }
    }
    
    // Убедимся, что колонка emergency_contacts существует
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contacts JSONB DEFAULT '[]'`);
    } catch (err) {
        // Игнорируем
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
        const followingRes = await pool.query('SELECT following_id FROM subscriptions WHERE follower_id = $1', [id]);
        const following = followingRes.rows.map(row => row.following_id);
        return {
            id: r.id,
            fullName: r.full_name,
            email: r.email,
            phone: r.phone,
            password: r.password, // будет удалён в ответе клиенту
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
            emergencyContacts: safeJSONParse(r.emergency_contacts, []),
            unreadCounts,
            following,
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
            avatar=$15, appointments=$16, clients=$17, notifications=$18,
            emergency_contacts=$19
         WHERE id=$1`,
        [
            user.id,
            user.fullName || '',
            user.email,
            user.phone || '',
            user.password,
            user.role,
            user.specialization || '',
            user.experience || '',
            user.about || '',
            user.price || 0,
            JSON.stringify(user.topics || []),
            JSON.stringify(user.schedule || {}),
            JSON.stringify(user.certificates || []),
            user.rating || 0,
            user.avatar || '',
            JSON.stringify(user.appointments || []),
            JSON.stringify(user.clients || []),
            JSON.stringify(user.notifications || []),
            JSON.stringify(user.emergencyContacts || [])
        ]
    );
}

// Эндпоинт для сохранения подписки клиента
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const subscription = req.body;
        const user = await getUser(req.user.userId);
        if (!user) return res.json({ success: false });

        let subs = user.pushSubscriptions || [];
        // Проверяем, нет ли уже этой подписки
        if (!subs.some(s => s.endpoint === subscription.endpoint)) {
            subs.push(subscription);
            await pool.query('UPDATE users SET push_subscriptions=$1 WHERE id=$2', [JSON.stringify(subs), user.id]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Push subscribe error:', err);
        res.json({ success: false });
    }
});

// Функция для отправки пушей подписчикам психолога
async function sendPushToFollowers(psychologistId, title, body, url = '/') {
    try {
        const followersRes = await pool.query('SELECT follower_id FROM subscriptions WHERE following_id=$1', [psychologistId]);
        const followerIds = followersRes.rows.map(r => r.follower_id);
        if (followerIds.length === 0) return;

        const usersRes = await pool.query('SELECT push_subscriptions FROM users WHERE id = ANY($1::text[])', [followerIds]);
        const payload = JSON.stringify({ title, body, url });

        usersRes.rows.forEach(row => {
            const subs = safeJSONParse(row.push_subscriptions, []);
            subs.forEach(sub => {
                webpush.sendNotification(sub, payload).catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) console.log('Подписка устарела');
                });
            });
        });
    } catch (err) { console.error('Send push error:', err); }
}

// ========== РЕГИСТРАЦИЯ / ЛОГИН ==========
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, phone, password, role, specialization, experience, about } = req.body;
        const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
        if (existing.rows.length > 0) return res.json({ success: false, error: 'Email уже используется' });
        if (role === 'psychologist' && (!specialization || !experience)) {
            return res.json({ success: false, error: 'Заполните специализацию и опыт' });
        }
        const id = nanoid(12);
        const hashedPassword = await bcrypt.hash(password, 10);
        const avatar = `https://ui-avatars.com/api/?background=8bca8b&color=fff&name=${encodeURIComponent(fullName)}&size=128`;
        await pool.query(
            `INSERT INTO users (id, full_name, email, phone, password, role, specialization, experience, about, price, topics, schedule, certificates, rating, avatar, appointments, clients, notifications, emergency_contacts, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [id, fullName, email, phone || '', hashedPassword, role, specialization || '', experience || '', about || '', 0, '[]', '{}', '[]', 0, avatar, '[]', '[]', '[]', '[]', new Date().toISOString()]
        );
        res.json({ success: true, userId: id, role });
    } catch (err) {
        console.error('Register error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT id, password, role, full_name FROM users WHERE email=$1', [email]);
        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Неверный email или пароль' });
        }
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.json({ success: false, error: 'Неверный email или пароль' });
        }
        const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, userId: user.id, role: user.role, fullName: user.full_name });
    } catch (err) {
        console.error('Login error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ========== ПОЛЬЗОВАТЕЛИ (защищённые) ==========
app.get('/api/user/:id', optionalAuth, async (req, res) => {
    try {
        // Если это гость ИЛИ человек смотрит чужой профиль, отдаем только публичные данные
        if (!req.user || (req.params.id !== req.user.userId && req.user.role !== 'psychologist')) {
            const publicUser = await pool.query('SELECT id, full_name, avatar, role, specialization, rating, about, price, experience FROM users WHERE id=$1', [req.params.id]);
            if (publicUser.rows.length === 0) return res.json({ success: false });
            const p = publicUser.rows[0];
            return res.json({ success: true, user: { id: p.id, fullName: p.full_name, avatar: p.avatar, role: p.role, specialization: p.specialization, rating: p.rating, about: p.about, price: p.price, experience: p.experience } });
        }
        
        // Если это владелец профиля или психолог смотрит клиента
        const user = await getUser(req.params.id);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        const { password, ...userData } = user;
        res.json({ success: true, user: userData });
    } catch (err) {
        console.error('Get user error:', err);
        res.json({ success: false });
    }
});

app.put('/api/user/profile', authenticateToken, uploadMedia.single('avatar'), async (req, res) => {
    try {
        const { userId, fullName, phone, about, specialization, experience, price, avatar } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(userId);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        if (fullName) user.fullName = fullName;
        if (phone !== undefined) user.phone = phone;
        if (about !== undefined) user.about = about;
        if (specialization !== undefined) user.specialization = specialization;
        if (experience !== undefined) user.experience = experience;
        if (price !== undefined) user.price = parseInt(price) || 0;
        if (req.file) user.avatar = req.file.path;
        else if (avatar && avatar.startsWith('http')) user.avatar = avatar;
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) {
        console.error('Profile update error:', err);
        res.json({ success: false });
    }
});

// ========== РАСПИСАНИЕ ==========
app.get('/api/schedule/:psychologistId', authenticateToken, async (req, res) => {
    try {
        const slots = await pool.query(`SELECT date, time FROM time_slots WHERE psychologist_id=$1 AND status='free' ORDER BY date, time`, [req.params.psychologistId]);
        const schedule = {};
        slots.rows.forEach(s => {
            if (!schedule[s.date]) schedule[s.date] = [];
            schedule[s.date].push(s.time);
        });
        for (const date in schedule) schedule[date].sort();
        res.json({ success: true, schedule });
    } catch (err) {
        console.error('Get schedule error:', err);
        res.json({ success: false });
    }
});

app.put('/api/schedule', authenticateToken, async (req, res) => {
    try {
        const { userId, schedule } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        await pool.query(`DELETE FROM time_slots WHERE psychologist_id=$1 AND status='free'`, [user.id]);
        for (const [date, times] of Object.entries(schedule)) {
            for (const time of times) {
                const existing = await pool.query(`SELECT id FROM time_slots WHERE psychologist_id=$1 AND date=$2 AND time=$3 AND status IN ('pending', 'booked')`, [user.id, date, time]);
                if (existing.rows.length === 0) {
                    await pool.query(`INSERT INTO time_slots (id, psychologist_id, date, time, status) VALUES ($1,$2,$3,$4,'free')`, [nanoid(12), user.id, date, time]);
                }
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

// ========== ЗАПИСЬ НА ПРИЁМ ==========
app.post('/api/appointment', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { clientId, psychologistId, date, time } = req.body;
        if (req.user.userId !== clientId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const clientUser = await getUser(clientId);
        const psychologist = await getUser(psychologistId);
        if (!clientUser || !psychologist) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        const slotRes = await client.query(`SELECT id FROM time_slots WHERE psychologist_id=$1 AND date=$2 AND time=$3 AND status='free' FOR UPDATE`, [psychologistId, date, time]);
        if (slotRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Это время уже занято или не входит в расписание' });
        }
        const slotId = slotRes.rows[0].id;
        const roomId = nanoid(16).toUpperCase();
        const appointmentId = nanoid(12);
        await client.query(`UPDATE time_slots SET status='pending', appointment_id=$1 WHERE id=$2`, [appointmentId, slotId]);
        await client.query(`INSERT INTO appointments (id, psychologist_id, client_id, psychologist_name, client_name, date, time, room_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [appointmentId, psychologistId, clientId, psychologist.fullName, clientUser.fullName, date, time, roomId, 'pending', new Date().toISOString()]);
        if (!clientUser.appointments) clientUser.appointments = [];
        clientUser.appointments.push({ id: appointmentId, psychologistId, psychologistName: psychologist.fullName, clientId, clientName: clientUser.fullName, date, time, roomId, status: 'pending' });
        if (!psychologist.clients) psychologist.clients = [];
        psychologist.clients.push({ clientId, clientName: clientUser.fullName, appointmentId, date, time, status: 'pending', roomId });
        const notification = { id: nanoid(12), type: 'new_appointment', title: 'Новая заявка', message: `${clientUser.fullName} хочет записаться на ${date} в ${time}`, appointmentId, roomId, createdAt: new Date().toISOString() };
        if (!psychologist.notifications) psychologist.notifications = [];
        psychologist.notifications.unshift(notification);
        await updateUser(psychologist);
        await updateUser(clientUser);
        await client.query('COMMIT');
        io.to(psychologistId).emit('notification', notification);
        io.to(psychologistId).emit('appointment_created', { id: appointmentId, psychologist_id: psychologistId, client_id: clientId, date, time, room_id: roomId, status: 'pending' });
        res.json({ success: true, appointment: { id: appointmentId, roomId, date, time, status: 'pending' } });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Appointment error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    } finally { client.release(); }
});

app.post('/api/appointment/confirm', authenticateToken, async (req, res) => {
    try {
        const { appointmentId, psychologistId, clientId } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const psychologist = await getUser(psychologistId);
        const client = await getUser(clientId);
        if (!psychologist || !client) return res.json({ success: false, error: 'Пользователь не найден' });
        const aptRes = await pool.query('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
        if (aptRes.rows.length === 0) return res.json({ success: false, error: 'Запись не найдена' });
        const apt = aptRes.rows[0];
        await pool.query(`UPDATE time_slots SET status='booked' WHERE psychologist_id=$1 AND date=$2 AND time=$3 AND appointment_id=$4`, [psychologistId, apt.date, apt.time, appointmentId]);
        await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', ['confirmed', appointmentId]);
        if (psychologist) {
            const c = (psychologist.clients || []).find(c => c.appointmentId === appointmentId);
            if (c) c.status = 'confirmed';
            const schedule = psychologist.schedule || {};
            if (schedule[apt.date]) {
                schedule[apt.date] = schedule[apt.date].filter(t => t !== apt.time);
                if (schedule[apt.date].length === 0) delete schedule[apt.date];
                psychologist.schedule = schedule;
            }
            psychologist.notifications = (psychologist.notifications || []).filter(n => n.appointmentId !== appointmentId);
            await updateUser(psychologist);
        }
        if (client) {
            const a = (client.appointments || []).find(a => a.id === appointmentId);
            if (a) a.status = 'confirmed';
            await updateUser(client);
        }
        const clientNotif = { id: nanoid(12), type: 'appointment_confirmed', title: 'Запись подтверждена!', message: `${psychologist.fullName} подтвердил запись на ${apt.date} в ${apt.time}`, appointmentId, roomId: apt.room_id, createdAt: new Date().toISOString() };
        if (client) {
            if (!client.notifications) client.notifications = [];
            client.notifications.unshift(clientNotif);
            await updateUser(client);
        }
        io.to(clientId).emit('notification', clientNotif);
        io.to(clientId).emit('appointment_updated', apt);
        io.to(psychologistId).emit('appointment_updated', apt);
        res.json({ success: true });
    } catch (err) {
        console.error('Confirm appointment error:', err);
        res.json({ success: false });
    }
});

app.post('/api/appointment/complete', authenticateToken, async (req, res) => {
    try {
        const { appointmentId } = req.body;
        const aptRes = await pool.query('SELECT * FROM appointments WHERE id=$1', [appointmentId]);
        if (aptRes.rows.length === 0) return res.json({ success: false });
        const apt = aptRes.rows[0];
        // Проверяем, что текущий пользователь – либо психолог, либо клиент этой записи
        if (req.user.userId !== apt.psychologist_id && req.user.userId !== apt.client_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', ['completed', appointmentId]);
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

app.post('/api/appointment/duration', authenticateToken, async (req, res) => {
    try {
        const { roomId, duration } = req.body;
        await pool.query('UPDATE appointments SET duration_seconds = $1 WHERE room_id = $2', [duration, roomId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Duration update error:', err);
        res.json({ success: false });
    }
});

// ========== ЗАГРУЗКА ФАЙЛОВ ==========
app.post('/api/upload-avatar', authenticateToken, uploadMedia.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, avatarUrl: req.file.path });
});
app.post('/api/upload', authenticateToken, uploadMedia.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    if (req.file.size > 5 * 1024 * 1024) return res.json({ success: false, error: 'Файл слишком большой (максимум 5 МБ)' });
    res.json({ success: true, fileUrl: req.file.path });
});
app.post('/api/upload-chat-image', authenticateToken, uploadMedia.single('image'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, imageUrl: req.file.path });
});
app.post('/api/upload-voice', authenticateToken, uploadMedia.single('voice'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    if (req.file.size > 5 * 1024 * 1024) return res.json({ success: false, error: 'Размер голосового сообщения не должен превышать 5 МБ' });
    res.json({ success: true, voiceUrl: req.file.path });
});
app.post('/api/upload-recording', authenticateToken, uploadMedia.single('recording'), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    await pool.query(`INSERT INTO recordings (id,url,from_user,to_user,room_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [nanoid(12), req.file.path, req.body.from, req.body.to, req.body.roomId, new Date().toISOString()]);
    res.json({ success: true, recordingUrl: req.file.path });
});
app.post('/api/upload-video', authenticateToken, uploadMedia.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Видео не загружено' });
    res.json({ success: true, videoUrl: req.file.path });
});
app.post('/api/upload-image', authenticateToken, uploadMedia.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Изображение не загружено' });
    res.json({ success: true, imageUrl: req.file.path });
});
app.post('/api/upload-doc', authenticateToken, uploadDoc.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'Файл не загружен' });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Файл слишком большой (максимум 5 МБ)' });
    res.json({ success: true, fileUrl: `/uploads/documents/${req.file.filename}` });
});

// ========== ПОСТЫ ==========
app.post('/api/posts', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { authorId, text, image, video } = req.body;
        if (req.user.userId !== authorId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const author = await getUser(authorId);
        if (!author || author.role !== 'psychologist') return res.json({ success: false, error: 'Только психологи могут создавать посты' });
        const newPost = { id: nanoid(12), author_id: authorId, text, image: image || null, video: video || null, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO posts (id,author_id,text,image,video,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newPost.id, newPost.author_id, newPost.text, newPost.image, newPost.video, newPost.created_at]);
        io.emit('post_created', newPost);
        sendPushToFollowers(authorId, 'Новый пост', `${author.fullName} опубликовал(а) новый пост.`, '/');
        res.json({ success: true, post: newPost });
    } catch (err) { console.error('Create post error:', err); res.json({ success: false }); }
});
app.get('/api/posts', optionalAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 15, 50);
        const offset = parseInt(req.query.offset) || 0;
        const userId = req.user ? req.user.userId : null;

        const postsRes = await pool.query(
            `SELECT p.id, p.text, p.image, p.video, p.created_at,
                    u.id AS author_id, u.full_name AS author_name, u.avatar AS author_avatar, u.rating AS author_rating,
                    COALESCE(COUNT(DISTINCT l.id), 0) AS likes_count
             FROM posts p
             JOIN users u ON p.author_id = u.id
             LEFT JOIN likes l ON l.post_id = p.id
             GROUP BY p.id, p.text, p.image, p.video, p.created_at, u.id, u.full_name, u.avatar, u.rating
             ORDER BY p.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const postIds = postsRes.rows.map(p => p.id);
        let commentsCountMap = {};
        let userLikedSet = new Set();
        if (postIds.length > 0) {
            const countRes = await pool.query(`SELECT post_id, COUNT(*)::int as cnt FROM comments WHERE post_id = ANY($1::text[]) GROUP BY post_id`, [postIds]);
            countRes.rows.forEach(r => { commentsCountMap[r.post_id] = r.cnt; });
            if (userId) {
                const likedRes = await pool.query(`SELECT post_id FROM likes WHERE user_id=$1 AND post_id=ANY($2::text[])`, [userId, postIds]);
                likedRes.rows.forEach(r => userLikedSet.add(r.post_id));
            }
        }

        const posts = postsRes.rows.map(p => ({
            id: p.id,
            text: p.text,
            image: p.image,
            video: p.video,
            createdAt: p.created_at,
            author: { id: p.author_id, fullName: p.author_name, avatar: p.author_avatar, rating: p.author_rating || 0 },
            likesCount: p.likes_count,
            commentsCount: commentsCountMap[p.id] || 0,
            comments: [],
            userLiked: userLikedSet.has(p.id)
        }));

        res.json({ success: true, posts, hasMore: postsRes.rows.length === limit });
    } catch (err) {
        console.error('Posts error:', err);
        res.status(500).json({ success: false, error: 'Ошибка загрузки постов' });
    }
});
app.get('/api/posts/:id/comments', optionalAuth, async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.text, c.created_at, u.id AS author_id, u.full_name AS author_name, u.avatar AS author_avatar FROM comments c JOIN users u ON c.author_id = u.id WHERE c.post_id = $1 ORDER BY c.created_at ASC`, [req.params.id]);
        const comments = result.rows.map(c => ({ id: c.id, text: c.text, created_at: c.created_at, author_id: c.author_id, author_name: c.author_name, author_avatar: c.author_avatar }));
        res.json({ success: true, comments });
    } catch (err) { console.error('Get comments error:', err); res.json({ success: false }); }
});
app.put('/api/posts/:id', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const { text } = req.body;
        const userId = req.user.userId; // Берем ID строго из проверенного токена!

        // 1. Защита от "пустых" постов в обход фронтенда
        if (!text || !text.trim()) {
            return res.json({ success: false, error: 'Текст не может быть пустым' });
        }

        // 2. Ищем пост (запрашиваем только нужное поле author_id для экономии памяти)
        const postRes = await pool.query('SELECT author_id FROM posts WHERE id=$1', [postId]);
        
        if (postRes.rows.length === 0) {
            return res.json({ success: false, error: 'Пост не найден' });
        }
        
        // 3. Проверяем: совпадает ли владелец токена с автором поста?
        if (postRes.rows[0].author_id !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав на редактирование этого поста' });
        }

        // 4. Обновляем текст в БД
        await pool.query('UPDATE posts SET text=$1 WHERE id=$2', [text.trim(), postId]);
        
        // 5. Оповещаем всех (сокеты)
        io.emit('post_updated', { id: postId, text: text.trim() });
        res.json({ success: true });
        
    } catch (err) { 
        console.error('Update post error:', err); 
        res.status(500).json({ success: false, error: 'Ошибка сервера' }); 
    }
});
app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const { authorId } = req.body;
        if (req.user.userId !== authorId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const postRes = await pool.query('SELECT * FROM posts WHERE id=$1', [postId]);
        if (postRes.rows.length === 0) return res.json({ success: false, error: 'Пост не найден' });
        if (postRes.rows[0].author_id !== authorId) return res.json({ success: false, error: 'Нет прав' });
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
        const { userId, text } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const newComment = { id: nanoid(12), post_id: postId, author_id: userId, text, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO comments (id,post_id,author_id,text,created_at) VALUES ($1,$2,$3,$4,$5)`, [newComment.id, newComment.post_id, newComment.author_id, newComment.text, newComment.created_at]);
        const author = await getUser(userId);
        const commentWithAuthor = { id: newComment.id, text: newComment.text, createdAt: newComment.created_at, author: { id: author.id, fullName: author.fullName, avatar: author.avatar } };
        io.emit('comment_created', { postId, comment: commentWithAuthor });
        res.json({ success: true });
    } catch (err) { console.error('Add comment error:', err); res.json({ success: false }); }
});
app.put('/api/posts/:postId/comment/:commentId', authenticateToken, async (req, res) => {
    try {
        const { userId, text } = req.body;
        const commentId = req.params.commentId;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query('SELECT author_id FROM comments WHERE id=$1', [commentId]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'Комментарий не найден' });
        if (result.rows[0].author_id !== userId) return res.json({ success: false, error: 'Нет прав' });
        await pool.query('UPDATE comments SET text=$1 WHERE id=$2', [text, commentId]);
        res.json({ success: true });
    } catch (err) { console.error('Edit comment error:', err); res.json({ success: false }); }
});
app.delete('/api/posts/:postId/comment/:commentId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.body;
        const commentId = req.params.commentId;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query('SELECT author_id, post_id FROM comments WHERE id=$1', [commentId]);
        if (result.rows.length === 0) return res.json({ success: false, error: 'Комментарий не найден' });
        if (result.rows[0].author_id !== userId) return res.json({ success: false, error: 'Нет прав' });
        await pool.query('DELETE FROM comments WHERE id=$1', [commentId]);
        io.emit('comment_deleted', { commentId, postId: result.rows[0].post_id });
        res.json({ success: true });
    } catch (err) { console.error('Delete comment error:', err); res.json({ success: false }); }
});
app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const { userId } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const existing = await pool.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
        let liked;
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
            liked = false;
        } else {
            await pool.query(`INSERT INTO likes (id,post_id,user_id,created_at) VALUES ($1,$2,$3,$4)`, [nanoid(12), postId, userId, new Date().toISOString()]);
            liked = true;
        }
        const countRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM likes WHERE post_id=$1', [postId]);
        const likesCount = countRes.rows[0].cnt;
        io.emit('post_liked', { postId, likesCount, userId, liked });
        res.json({ success: true, liked, likesCount });
    } catch (err) { console.error('Like error:', err); res.json({ success: false }); }
});

// ========== ЗАДАЧИ ==========
app.get('/api/tasks/:psychologistId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.psychologistId && req.user.role !== 'psychologist') {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query('SELECT * FROM tasks WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const tasks = result.rows.map(t => ({ id: t.id, psychologistId: t.psychologist_id, text: t.text, dueDate: t.due_date, completed: t.completed, createdAt: t.created_at }));
        res.json({ success: true, tasks });
    } catch (err) { console.error('Get tasks error:', err); res.json({ success: false }); }
});
app.post('/api/tasks', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, text, dueDate } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const newTask = { id: nanoid(12), psychologist_id: psychologistId, text, due_date: dueDate || null, completed: false, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO tasks (id,psychologist_id,text,due_date,completed,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newTask.id, newTask.psychologist_id, newTask.text, newTask.due_date, newTask.completed, newTask.created_at]);
        res.json({ success: true, task: { ...newTask, dueDate: newTask.due_date, createdAt: newTask.created_at } });
    } catch (err) { console.error('Create task error:', err); res.json({ success: false }); }
});
app.put('/api/tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        const { completed, text, dueDate } = req.body;
        // Проверим, что задача принадлежит психологу текущего пользователя
        const taskRes = await pool.query('SELECT psychologist_id FROM tasks WHERE id=$1', [req.params.taskId]);
        if (taskRes.rows.length === 0) return res.json({ success: false });
        if (req.user.userId !== taskRes.rows[0].psychologist_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query('UPDATE tasks SET completed=$1, text=COALESCE($2,text), due_date=COALESCE($3,due_date) WHERE id=$4', [completed, text || null, dueDate || null, req.params.taskId]);
        res.json({ success: true });
    } catch (err) { console.error('Update task error:', err); res.json({ success: false }); }
});
app.delete('/api/tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        const taskRes = await pool.query('SELECT psychologist_id FROM tasks WHERE id=$1', [req.params.taskId]);
        if (taskRes.rows.length === 0) return res.json({ success: false });
        if (req.user.userId !== taskRes.rows[0].psychologist_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.taskId]);
        res.json({ success: true });
    } catch (err) { console.error('Delete task error:', err); res.json({ success: false }); }
});

// ========== СТАТИСТИКА ПСИХОЛОГА ==========
app.get('/api/psychologist/:id/stats', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        // Любой может смотреть статистику психолога? Ограничим только для владельца или публично
        if (req.user.userId !== id && req.user.role !== 'psychologist') {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const postsRes = await pool.query('SELECT id FROM posts WHERE author_id = $1', [id]);
        const postIds = postsRes.rows.map(p => p.id);
        let totalLikes = 0;
        if (postIds.length > 0) {
            const likesRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM likes WHERE post_id = ANY($1::text[])', [postIds]);
            totalLikes = likesRes.rows[0].cnt;
        }
        const followersRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM subscriptions WHERE following_id = $1', [id]);
        const followersCount = followersRes.rows[0].cnt;
        const postsCount = postIds.length;
        res.json({ success: true, totalLikes, followersCount, postsCount });
    } catch (err) { console.error('Stats error:', err); res.json({ success: false, error: err.message }); }
});

// ========== ЗАМЕТКИ ==========
app.get('/api/notes/:psychologistId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query('SELECT * FROM notes WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const notes = result.rows.map(n => ({ id: n.id, psychologistId: n.psychologist_id, title: n.title, content: n.content, attachment: n.attachment, attachmentType: n.attachment_type, createdAt: n.created_at }));
        res.json({ success: true, notes });
    } catch (err) { console.error('Get notes error:', err); res.json({ success: false }); }
});
app.post('/api/notes', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, title, content, attachment, attachmentType } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const newNote = { id: nanoid(12), psychologist_id: psychologistId, title, content, attachment: attachment || null, attachment_type: attachmentType || null, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO notes (id,psychologist_id,title,content,attachment,attachment_type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newNote.id, newNote.psychologist_id, newNote.title, newNote.content, newNote.attachment, newNote.attachment_type, newNote.created_at]);
        res.json({ success: true, note: newNote });
    } catch (err) { console.error('Create note error:', err); res.json({ success: false }); }
});
app.delete('/api/notes/:noteId', authenticateToken, async (req, res) => {
    try {
        const noteRes = await pool.query('SELECT psychologist_id FROM notes WHERE id=$1', [req.params.noteId]);
        if (noteRes.rows.length === 0) return res.json({ success: false });
        if (req.user.userId !== noteRes.rows[0].psychologist_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query('DELETE FROM notes WHERE id=$1', [req.params.noteId]);
        res.json({ success: true });
    } catch (err) { console.error('Delete note error:', err); res.json({ success: false }); }
});

// ========== ОТЗЫВЫ ==========
app.post('/api/reviews', authenticateToken, requireClient, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { psychologistId, clientId, rating, text, appointmentId } = req.body;
        if (req.user.userId !== clientId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const aptRes = await client.query(`SELECT id FROM appointments WHERE id = $1 AND client_id = $2 AND status = 'completed'`, [appointmentId, clientId]);
        if (aptRes.rows.length === 0) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Нет завершённой сессии для этого отзыва' }); }
        const existingReview = await client.query(`SELECT id FROM reviews WHERE appointment_id = $1`, [appointmentId]);
        if (existingReview.rows.length > 0) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Вы уже оставили отзыв на эту сессию' }); }
        const clientUser = await getUser(clientId);
        if (!clientUser) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Пользователь не найден' }); }
        const newReview = { id: nanoid(12), psychologist_id: psychologistId, client_id: clientId, client_name: clientUser.fullName, rating: Math.min(5, Math.max(1, rating)), text, appointment_id: appointmentId, created_at: new Date().toISOString() };
        await client.query(`INSERT INTO reviews (id, psychologist_id, client_id, client_name, rating, text, appointment_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newReview.id, newReview.psychologist_id, newReview.client_id, newReview.client_name, newReview.rating, newReview.text, newReview.appointment_id, newReview.created_at]);
        await recalcPsychologistRating(psychologistId);
        await client.query('COMMIT');
        const updatedPsychologist = await getUser(psychologistId);
        res.json({ success: true, review: newReview, newRating: updatedPsychologist.rating });
    } catch (err) { await client.query('ROLLBACK'); console.error('Review error:', err); res.json({ success: false, error: 'Ошибка сервера' }); } finally { client.release(); }
});
app.put('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { userId, rating, text } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const reviewRes = await pool.query('SELECT client_id, psychologist_id FROM reviews WHERE id = $1', [reviewId]);
        if (reviewRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Отзыв не найден' });
        const review = reviewRes.rows[0];
        if (review.client_id !== userId) return res.status(403).json({ success: false, error: 'Нет прав' });
        await pool.query('UPDATE reviews SET rating = $1, text = $2 WHERE id = $3', [rating, text, reviewId]);
        try { await recalcPsychologistRating(review.psychologist_id); } catch (err) { }
        res.json({ success: true });
    } catch (err) { console.error('Update review error:', err); res.status(500).json({ success: false, error: err.message }); }
});
app.delete('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { userId } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const reviewRes = await pool.query('SELECT client_id, psychologist_id FROM reviews WHERE id = $1', [reviewId]);
        if (reviewRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Отзыв не найден' });
        const review = reviewRes.rows[0];
        if (review.client_id !== userId) return res.status(403).json({ success: false, error: 'Нет прав' });
        await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
        try { await recalcPsychologistRating(review.psychologist_id); } catch (err) { }
        res.json({ success: true });
    } catch (err) { console.error('Delete review error:', err); res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/reviews/:psychologistId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reviews WHERE psychologist_id=$1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const reviews = result.rows.map(r => ({ id: r.id, psychologistId: r.psychologist_id, clientId: r.client_id, clientName: r.client_name, rating: r.rating, text: r.text, createdAt: r.created_at }));
        res.json({ success: true, reviews });
    } catch (err) { console.error('Get reviews error:', err); res.json({ success: false }); }
});
app.get('/api/can-review/:psychologistId/:clientId', authenticateToken, async (req, res) => {
    try {
        const { psychologistId, clientId } = req.params;
        if (req.user.userId !== clientId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query(`SELECT a.id FROM appointments a LEFT JOIN reviews r ON r.appointment_id = a.id WHERE a.psychologist_id = $1 AND a.client_id = $2 AND a.status = 'completed' AND r.id IS NULL`, [psychologistId, clientId]);
        res.json({ success: true, canReview: result.rows.length > 0, appointmentId: result.rows[0]?.id || null });
    } catch (err) { console.error('can-review error:', err); res.json({ success: false }); }
});
async function recalcPsychologistRating(psychologistId) {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const reviewsRes = await pool.query(`SELECT rating FROM reviews WHERE psychologist_id = $1 AND created_at >= $2`, [psychologistId, thirtyDaysAgo.toISOString()]);
        const reviews = reviewsRes.rows;
        const totalReviews = reviews.length;
        if (totalReviews === 0) { await pool.query('UPDATE users SET rating = 0 WHERE id = $1', [psychologistId]); return 0; }
        const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
        let newRating = sum / totalReviews;
        newRating = Math.min(5, Math.max(0, newRating));
        await pool.query('UPDATE users SET rating = $1 WHERE id = $2', [newRating, psychologistId]);
        return newRating;
    } catch (err) { console.error('recalcPsychologistRating error:', err); return null; }
}

// ========== СЕРТИФИКАТЫ ==========
app.post('/api/certificates', authenticateToken, requirePsychologist, uploadMedia.single('certificate'), async (req, res) => {
    try {
        const { userId, title } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
        const newCert = { id: nanoid(12), user_id: userId, title: title || 'Сертификат', image: req.file.path, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO certificates (id,user_id,title,image,created_at) VALUES ($1,$2,$3,$4,$5)`, [newCert.id, newCert.user_id, newCert.title, newCert.image, newCert.created_at]);
        if (!user.certificates) user.certificates = [];
        user.certificates.push({ id: newCert.id, title: newCert.title, image: newCert.image });
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, certificate: newCert, user: safeUser });
    } catch (err) { console.error('Certificate error:', err); res.json({ success: false }); }
});
app.delete('/api/certificates/:userId/:certId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(req.params.userId);
        if (!user) return res.json({ success: false });
        await pool.query('DELETE FROM certificates WHERE id=$1', [req.params.certId]);
        user.certificates = (user.certificates || []).filter(c => c.id !== req.params.certId);
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) { res.json({ success: false, error: err.message }); }
});

// ========== ПОДПИСКИ ==========
app.get('/api/subscriptions/:userId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const followingRes = await pool.query('SELECT following_id FROM subscriptions WHERE follower_id=$1', [req.params.userId]);
        const followersRes = await pool.query('SELECT follower_id FROM subscriptions WHERE following_id=$1', [req.params.userId]);
        res.json({ success: true, following: followingRes.rows.map(r => r.following_id), followers: followersRes.rows.map(r => r.follower_id) });
    } catch (err) { console.error('Subscriptions error:', err); res.json({ success: false }); }
});
app.post('/api/subscriptions', authenticateToken, async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        if (req.user.userId !== followerId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
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

// ========== ЧАТ ==========
app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(userId);
        if (!user) return res.json({ success: false });
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
        const { from, to, text, image, voice } = req.body;
        if (req.user.userId !== from) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        if (from === to) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Нельзя отправить сообщение самому себе' }); }
        const newMsg = { id: nanoid(12), from_user: from, to_user: to, text: text || '', image: image || null, voice: voice || null, is_read: false, created_at: new Date().toISOString() };
        await client.query(`INSERT INTO messages (id,from_user,to_user,text,image,voice,is_read,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newMsg.id, newMsg.from_user, newMsg.to_user, newMsg.text, newMsg.image, newMsg.voice, newMsg.is_read, newMsg.created_at]);
        await client.query(`INSERT INTO user_unreads (user_id, from_user_id, count) VALUES ($1, $2, 1) ON CONFLICT (user_id, from_user_id) DO UPDATE SET count = user_unreads.count + 1`, [to, from]);
        const unreadRes = await client.query(`SELECT count FROM user_unreads WHERE user_id=$1 AND from_user_id=$2`, [to, from]);
        const newCount = unreadRes.rows[0]?.count || 1;
        await client.query('COMMIT');
        const msgForClient = { id: newMsg.id, from: newMsg.from_user, to: newMsg.to_user, text: newMsg.text, image: newMsg.image, voice: newMsg.voice, created_at: newMsg.created_at };
        io.to(to).emit('new_message', msgForClient);
        io.to(to).emit('unread_update', { from, count: newCount });
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); console.error('Send message error:', err); res.json({ success: false, error: 'Ошибка сервера' }); } finally { client.release(); }
});
app.post('/api/messages/read', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { userId, fromUserId } = req.body;
        if (req.user.userId !== userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await client.query(`DELETE FROM user_unreads WHERE user_id=$1 AND from_user_id=$2`, [userId, fromUserId]);
        await client.query(`UPDATE messages SET is_read=true WHERE to_user=$1 AND from_user=$2`, [userId, fromUserId]);
        await client.query('COMMIT');
        io.to(userId).emit('unread_update', { from: fromUserId, count: 0 });
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); console.error('Mark read error:', err); res.json({ success: false }); } finally { client.release(); }
});

// ========== ПСИХОЛОГИ, ПОИСК (публичные или защищённые) ==========
app.get('/api/psychologists', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id,full_name,avatar,specialization,rating,price FROM users WHERE role='psychologist'`);
        res.json({ success: true, psychologists: result.rows });
    } catch (err) { console.error('Get psychologists error:', err); res.json({ success: false }); }
});
app.get('/api/search/psychologists', async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase() || '';
        const result = await pool.query(`SELECT id,full_name,avatar,specialization,rating FROM users WHERE role='psychologist' AND LOWER(full_name) LIKE $1`, [`%${query}%`]);
        res.json({ success: true, psychologists: result.rows });
    } catch (err) { console.error('Search error:', err); res.json({ success: false }); }
});

// ========== КАРТА КЛИЕНТА ==========
app.get('/api/client-card/:clientId', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { clientId } = req.params;
        const psychologistId = req.user.userId; // текущий психолог
        const apptCheck = await pool.query(`SELECT id FROM appointments WHERE psychologist_id=$1 AND client_id=$2 AND status IN ('confirmed','completed')`, [psychologistId, clientId]);
        if (apptCheck.rows.length === 0) return res.status(403).json({ success: false, error: 'Доступ запрещён' });
        const clientUser = await getUser(clientId);
        if (!clientUser) return res.json({ success: false, error: 'Клиент не найден' });
        const profileRes = await pool.query(`SELECT * FROM client_profiles WHERE user_id=$1`, [clientId]);
        const profile = profileRes.rows[0] || null;
        const notesRes = await pool.query(`SELECT * FROM client_notes WHERE client_id=$1 ORDER BY created_at DESC`, [clientId]);
        const homeworksRes = await pool.query(`SELECT * FROM client_homeworks WHERE client_id=$1 ORDER BY due_date ASC`, [clientId]);
        const progressRes = await pool.query(`SELECT * FROM client_progress WHERE client_id=$1 ORDER BY date ASC`, [clientId]);
        const answersRes = await pool.query(`SELECT a.*, q.questionnaire_id, q.text as question_text FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.client_id=$1 ORDER BY a.created_at DESC`, [clientId]);
        res.json({
            success: true,
            client: { id: clientUser.id, fullName: clientUser.fullName, avatar: clientUser.avatar, phone: clientUser.phone, about: clientUser.about },
            profile, notes: notesRes.rows, homeworks: homeworksRes.rows, progress: progressRes.rows, answers: answersRes.rows
        });
    } catch (err) { console.error('Client card error:', err); res.json({ success: false, error: err.message }); }
});

// ========== ДОМАШНИЕ ЗАДАНИЯ ==========
app.post('/api/homeworks', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, clientId, text, dueDate } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const apptCheck = await pool.query(`SELECT id FROM appointments WHERE psychologist_id=$1 AND client_id=$2 AND status IN ('confirmed','completed')`, [psychologistId, clientId]);
        if (apptCheck.rows.length === 0) return res.json({ success: false, error: 'Доступ запрещён' });
        const newHomework = { id: nanoid(12), psychologist_id: psychologistId, client_id: clientId, text, due_date: dueDate || null, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        await pool.query(`INSERT INTO client_homeworks (id, psychologist_id, client_id, text, due_date, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newHomework.id, newHomework.psychologist_id, newHomework.client_id, newHomework.text, newHomework.due_date, newHomework.status, newHomework.created_at, newHomework.updated_at]);
        const client = await getUser(clientId);
        if (client) {
            const psychologist = await getUser(psychologistId);
            const notif = { id: nanoid(12), type: 'homework', title: 'Новое домашнее задание', message: `${psychologist.fullName} добавил задание: ${text.substring(0, 50)}`, createdAt: new Date().toISOString() };
            if (!client.notifications) client.notifications = [];
            client.notifications.unshift(notif);
            await updateUser(client);
            io.to(clientId).emit('notification', notif);
        }
        res.json({ success: true, homework: newHomework });
    } catch (err) { console.error('Create homework error:', err); res.json({ success: false, error: err.message }); }
});
app.put('/api/homeworks/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        // Проверка прав: может обновлять либо клиент, либо психолог, создавший задание
        const homeworkRes = await pool.query('SELECT psychologist_id, client_id FROM client_homeworks WHERE id=$1', [id]);
        if (homeworkRes.rows.length === 0) return res.json({ success: false });
        const hw = homeworkRes.rows[0];
        if (req.user.userId !== hw.psychologist_id && req.user.userId !== hw.client_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query('UPDATE client_homeworks SET status=$1, updated_at=NOW() WHERE id=$2', [status, id]);
        res.json({ success: true });
    } catch (err) { console.error('Update homework error:', err); res.json({ success: false }); }
});
app.get('/api/client-homeworks/:clientId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.clientId && req.user.role !== 'psychologist') {
            // Психолог может смотреть свои задания клиенту, но нужно проверить, что он ведёт этого клиента
            if (req.user.role === 'psychologist') {
                const checkAppt = await pool.query(`SELECT id FROM appointments WHERE psychologist_id=$1 AND client_id=$2`, [req.user.userId, req.params.clientId]);
                if (checkAppt.rows.length === 0) {
                    return res.status(403).json({ success: false, error: 'Нет прав' });
                }
            } else {
                return res.status(403).json({ success: false, error: 'Нет прав' });
            }
        }
        const result = await pool.query(`SELECT id, text, due_date, status FROM client_homeworks WHERE client_id=$1 ORDER BY due_date ASC`, [req.params.clientId]);
        res.json({ success: true, homeworks: result.rows });
    } catch (err) {
        console.error('Get client homeworks error:', err);
        res.json({ success: false });
    }
});

// ========== ЗАМЕТКИ ПСИХОЛОГА О КЛИЕНТЕ ==========
app.post('/api/client-notes', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, clientId, note } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const apptCheck = await pool.query(`SELECT id FROM appointments WHERE psychologist_id=$1 AND client_id=$2 AND status IN ('confirmed','completed')`, [psychologistId, clientId]);
        if (apptCheck.rows.length === 0) return res.json({ success: false, error: 'Доступ запрещён' });
        const newNote = { id: nanoid(12), psychologist_id: psychologistId, client_id: clientId, note, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        await pool.query(`INSERT INTO client_notes (id, psychologist_id, client_id, note, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newNote.id, newNote.psychologist_id, newNote.client_id, newNote.note, newNote.created_at, newNote.updated_at]);
        res.json({ success: true, note: newNote });
    } catch (err) { console.error('Create client note error:', err); res.json({ success: false }); }
});

// ========== ПРОГРЕСС КЛИЕНТА ==========
app.post('/api/client-progress', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, clientId, value, type, notes } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const apptCheck = await pool.query(`SELECT id FROM appointments WHERE psychologist_id=$1 AND client_id=$2 AND status IN ('confirmed','completed')`, [psychologistId, clientId]);
        if (apptCheck.rows.length === 0) return res.json({ success: false, error: 'Доступ запрещён' });
        const newProgress = { id: nanoid(12), psychologist_id: psychologistId, client_id: clientId, value, type: type || 'psychologist', date: new Date().toISOString().split('T')[0], notes: notes || null, created_at: new Date().toISOString() };
        await pool.query(`INSERT INTO client_progress (id, psychologist_id, client_id, value, type, date, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newProgress.id, newProgress.psychologist_id, newProgress.client_id, newProgress.value, newProgress.type, newProgress.date, newProgress.notes, newProgress.created_at]);
        res.json({ success: true, progress: newProgress });
    } catch (err) { console.error('Create progress error:', err); res.json({ success: false }); }
});

// ========== АНКЕТЫ (опросники) ==========
app.get('/api/questionnaires/available', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, title, description, psychologist_id FROM questionnaires WHERE is_published = true ORDER BY created_at DESC`);
        res.json({ success: true, questionnaires: result.rows });
    } catch (err) { console.error('Get questionnaires error:', err); res.json({ success: false }); }
});
app.post('/api/questionnaires', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { psychologistId, title, description, questions } = req.body;
        if (req.user.userId !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const user = await getUser(psychologistId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        const qId = nanoid(12);
        await pool.query(`INSERT INTO questionnaires (id, psychologist_id, title, description, is_published, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`, [qId, psychologistId, title, description || '', false]);
        if (questions && Array.isArray(questions)) {
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                await pool.query(`INSERT INTO questions (id, questionnaire_id, text, type, options, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`, [nanoid(12), qId, q.text, q.type || 'text', JSON.stringify(q.options || []), i]);
            }
        }
        res.json({ success: true, questionnaireId: qId });
    } catch (err) { console.error('Create questionnaire error:', err); res.json({ success: false }); }
});
app.post('/api/questionnaires/:id/submit', authenticateToken, requireClient, async (req, res) => {
    try {
        const { clientId, answers } = req.body;
        if (req.user.userId !== clientId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const questionnaireId = req.params.id;
        for (const ans of answers) {
            await pool.query(`INSERT INTO answers (id, client_id, questionnaire_id, question_id, answer_value, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`, [nanoid(12), clientId, questionnaireId, ans.questionId, ans.value]);
        }
        res.json({ success: true });
    } catch (err) { console.error('Submit answers error:', err); res.json({ success: false }); }
});
app.get('/api/questionnaires/psychologist/:psychologistId', authenticateToken, async (req, res) => {
    try {
        if (req.user.userId !== req.params.psychologistId && req.user.role !== 'psychologist') {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        const result = await pool.query(`SELECT id, title, description, is_published, created_at FROM questionnaires WHERE psychologist_id=$1 ORDER BY created_at DESC`, [req.params.psychologistId]);
        res.json({ success: true, questionnaires: result.rows });
    } catch (err) { console.error('Get psychologist questionnaires error:', err); res.json({ success: false }); }
});
app.post('/api/questionnaires/publish/:id', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_published } = req.body;
        // Проверим, что опросник принадлежит текущему психологу
        const qRes = await pool.query('SELECT psychologist_id FROM questionnaires WHERE id=$1', [id]);
        if (qRes.rows.length === 0) return res.json({ success: false });
        if (req.user.userId !== qRes.rows[0].psychologist_id) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        await pool.query(`UPDATE questionnaires SET is_published=$1, updated_at=NOW() WHERE id=$2`, [is_published, id]);
        if (is_published) {
    const user = await getUser(req.user.userId);
    sendPushToFollowers(req.user.userId, 'Новая анкета', `${user.fullName} добавил(а) новый опросник.`, '/');
}
        res.json({ success: true });
    } catch (err) { console.error('Publish questionnaire error:', err); res.json({ success: false }); }
});
app.get('/api/questionnaires/:id/questions', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, text, type, options, sort_order FROM questions WHERE questionnaire_id=$1 ORDER BY sort_order`, [req.params.id]);
        const questions = result.rows.map(q => ({ id: q.id, text: q.text, type: q.type, options: safeJSONParse(q.options, []) }));
        res.json({ success: true, questions });
    } catch (err) { console.error('Get questions error:', err); res.json({ success: false }); }
});
app.get('/api/questionnaires/:questionnaireId/responses', authenticateToken, requirePsychologist, async (req, res) => {
    try {
        const { questionnaireId } = req.params;
        const psychologistId = req.user.userId;
        const questCheck = await pool.query(`SELECT psychologist_id FROM questionnaires WHERE id = $1`, [questionnaireId]);
        if (questCheck.rows.length === 0) return res.json({ success: false, error: 'Опросник не найден' });
        if (questCheck.rows[0].psychologist_id !== psychologistId) {
            return res.status(403).json({ success: false, error: 'Доступ запрещён' });
        }
        const result = await pool.query(`
            SELECT 
                a.client_id, 
                u.full_name as client_name,
                q.text as question_text, 
                a.answer_value,
                q.type as question_type,
                a.created_at as answered_at
            FROM answers a
            JOIN users u ON a.client_id = u.id
            JOIN questions q ON a.question_id = q.id
            WHERE q.questionnaire_id = $1
            ORDER BY a.client_id, a.created_at
        `, [questionnaireId]);
        const responsesByClient = {};
        for (const row of result.rows) {
            if (!responsesByClient[row.client_id]) {
                responsesByClient[row.client_id] = {
                    clientId: row.client_id,
                    clientName: row.client_name,
                    answeredAt: row.answered_at,
                    answers: []
                };
            }
            responsesByClient[row.client_id].answers.push({
                question: row.question_text,
                answer: row.answer_value,
                type: row.question_type
            });
        }
        res.json({ success: true, responses: Object.values(responsesByClient) });
    } catch (err) {
        console.error('Get questionnaire responses error:', err);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// ========== ПРОФИЛЬ КЛИЕНТА ==========
app.post('/api/client-profile', authenticateToken, requireClient, async (req, res) => {
    try {
        const { userId, birthDate, gender, emergencyContacts, complaints, goals } = req.body;
        if (req.user.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Нет прав' });
        }
        // Проверяем, что пользователь существует и является клиентом
        const userExists = await pool.query('SELECT 1 FROM users WHERE id=$1 AND role=$2', [userId, 'client']);
        if (userExists.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Клиент не найден' });
        }
        const emergencyPhoneJson = JSON.stringify(emergencyContacts || []);
        await pool.query(
            `INSERT INTO client_profiles (user_id, birth_date, gender, emergency_phone, complaints, goals, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                birth_date = EXCLUDED.birth_date,
                gender = EXCLUDED.gender,
                emergency_phone = EXCLUDED.emergency_phone,
                complaints = EXCLUDED.complaints,
                goals = EXCLUDED.goals,
                updated_at = NOW()`,
            [userId, birthDate || null, gender || null, emergencyPhoneJson, complaints || '', goals || '']
        );
        // Также обновляем emergency_contacts в таблице users для совместимости (если используется)
        await pool.query('UPDATE users SET emergency_contacts = $1 WHERE id = $2', [emergencyPhoneJson, userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Save client profile error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== WEBRTC / SOCKET.IO ==========
const activeRooms = new Map();
// Маппинг userId -> socket.id (для роутинга WebRTC сигналов)
const userSockets = new Map();

io.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (!token) {
        return next(new Error('Authentication error'));
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    console.log('🔌 WebSocket connected:', socket.id);
    socket.on('register_user', (userId) => {
    socket.userId = userId || socket.user.userId;
    if (socket.userId) {
        // Сохраняем маппинг
        userSockets.set(socket.userId, socket.id);
        socket.join(socket.userId);
    }
    console.log(`User ${socket.userId} registered with socket ${socket.id}`);
});
    socket.on('join-call-room', async (roomId, userId, userType) => {
        try {
            const aptRes = await pool.query(
                `SELECT psychologist_id, client_id FROM appointments WHERE room_id = $1`,
                [roomId]
            );
            if (aptRes.rows.length === 0) {
                socket.emit('error', 'Неверная комната');
                return;
            }
            const apt = aptRes.rows[0];
            const isPsych = (userType === 'psychologist' && apt.psychologist_id === userId);
            const isClient = (userType === 'client' && apt.client_id === userId);
            if (!isPsych && !isClient) {
                socket.emit('error', 'У вас нет прав для этого звонка');
                return;
            }

            // ---> ВАЖНО: ЧИСТИМ СТАРУЮ КОМНАТУ, ЕСЛИ ЮЗЕР ТАМ ЗАСТРЯЛ <---
            if (socket.roomId && socket.roomId !== roomId) {
                const oldRoom = activeRooms.get(socket.roomId);
                if (oldRoom) {
                    oldRoom.users.delete(socket.id);
                    if (socket.userType === 'psychologist') oldRoom.psychologist = null;
                    else oldRoom.client = null;
                }
                socket.leave(socket.roomId);
            }
        // --- далее ваш существующий код без изменений ---
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
            if (room.psychologist && room.client) {
    const partnerPsychId = room.users.get(room.psychologist)?.userId;
    const partnerClientId = room.users.get(room.client)?.userId;
    io.to(room.psychologist).emit('call-ready', { partnerId: room.client, partnerUserId: partnerClientId });
    io.to(room.client).emit('call-ready', { partnerId: room.psychologist, partnerUserId: partnerPsychId });
}
        }
    } catch (err) {
        console.error('join-call-room error:', err);
        socket.emit('error', 'Ошибка сервера');
    }
});
    socket.on('call-message', (msgData) => {
        const room = activeRooms.get(socket.roomId);
        if (room) {
            const targetId = socket.userType === 'psychologist' ? room.client : room.psychologist;
            if (targetId) io.to(targetId).emit('call-message', { from: socket.userId, text: msgData.text, time: new Date().toISOString() });
        }
    });
    socket.on('screen-share-started', ({ roomId }) => { socket.to(roomId).emit('screen-share-started'); });
    socket.on('screen-share-stopped', ({ roomId }) => { socket.to(roomId).emit('screen-share-stopped'); });
    socket.on('offer', async (data) => {
    const { targetUserId, sdp } = data;
    const targetSocketId = userSockets.get(targetUserId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('offer', { sdp, fromUserId: socket.userId });
    } else {
        console.warn(`Offer: target user ${targetUserId} not connected`);
    }
});

socket.on('answer', (data) => {
    const { targetUserId, sdp } = data;
    const targetSocketId = userSockets.get(targetUserId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('answer', { sdp, fromUserId: socket.userId });
    }
});

socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data;
    const targetSocketId = userSockets.get(targetUserId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('ice-candidate', { candidate, fromUserId: socket.userId });
    }
});
    // Событие: Временный выход (не завершает сессию)
    socket.on('leave-call', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner-disconnected'); // Говорим собеседнику, что мы вышли
            const room = activeRooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (socket.userType === 'psychologist') room.psychologist = null;
                else room.client = null;
            }
            socket.leave(socket.roomId);
            socket.roomId = null; // Очищаем память сервера
        }
    });

    // Событие: Полное завершение (закрывает сессию в БД)
    socket.on('end-call', async () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('call-ended');
            
            try {
                // БЕЗУСЛОВНО завершаем звонок в БД (убрали багнутое ограничение room.users.size)
                const result = await pool.query('SELECT * FROM appointments WHERE room_id=$1', [socket.roomId]);
                if (result.rows.length > 0) {
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
                        
                        if (psychologist && client) {
                            const notif = { id: nanoid(12), type: 'request_review', title: 'Оцените сессию', message: `Как прошла сессия с ${psychologist.fullName}? Пожалуйста, оставьте отзыв.`, appointmentId: apt.id, psychologistId: apt.psychologist_id, psychologistName: psychologist.fullName, createdAt: new Date().toISOString() };
                            if (!client.notifications) client.notifications = [];
                            client.notifications.unshift(notif);
                            await updateUser(client);
                            io.to(apt.client_id).emit('notification', notif);
                        }
                    }
                }
            } catch (err) { console.error('end-call DB error:', err); }

            // Чистим серверный кэш комнат
            const room = activeRooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (socket.userType === 'psychologist') room.psychologist = null;
                else room.client = null;
            }
            socket.leave(socket.roomId);
            socket.roomId = null; 
        }
    });
    socket.on('disconnect', (reason) => {
        if (socket.userId) {
            // Удаляем сокет ТОЛЬКО если он не был перезаписан новым подключением
            if (userSockets.get(socket.userId) === socket.id) {
                userSockets.delete(socket.userId);
            }
        }
        console.log('WebSocket disconnected:', socket.id, 'reason:', reason);
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
    socket.on('request-reconnect', ({ roomId, role }) => {
        const room = activeRooms.get(roomId);
        if (!room) return;
        const targetId = (role === 'psychologist') ? room.client : room.psychologist;
        if (targetId) {
            io.to(targetId).emit('request-reconnect');
        }
    });
});

// ========== ЗАПУСК ==========
// ========== ЗДОРОВЬЕ ==========
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========== ОБРАБОТЧИК 404 (должен быть ПОСЛЕ всех маршрутов) ==========
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Маршрут не найден' });
});

// ========== ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК ==========
app.use((err, req, res, next) => {
    console.error('Global error:', err.stack);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Внутренняя ошибка сервера' });
});

// ========== ЗАПУСК СЕРВЕРА ==========
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initDatabase();
        console.log('✅ База данных инициализирована');

        // Периодический пересчёт рейтинга (раз в сутки)
        setInterval(async () => {
            console.log('Running daily rating recalculation...');
            try {
                const psychologistsRes = await pool.query('SELECT id FROM users WHERE role = $1', ['psychologist']);
                for (const row of psychologistsRes.rows) {
                    await recalcPsychologistRating(row.id);
                }
                console.log('Daily rating recalculation finished.');
            } catch (err) {
                console.error('Error during rating recalculation:', err);
            }
        }, 24 * 60 * 60 * 1000);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Сервер запущен на порту ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();