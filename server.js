const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Подключение к PostgreSQL с оптимизациями
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000
});

pool.connect((err) => {
    if (err) console.error('❌ Ошибка подключения к БД:', err);
    else console.log('✅ PostgreSQL подключена');
});

// Создание папок для загрузки
const uploadDirs = ['public/uploads', 'public/uploads/images', 'public/uploads/audio', 'public/uploads/recordings', 'public/uploads/files', 'public/uploads/certificates', 'public/uploads/videos'];
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') cb(null, 'public/uploads/images/');
        else if (file.fieldname === 'image') cb(null, 'public/uploads/images/');
        else if (file.fieldname === 'video') cb(null, 'public/uploads/videos/');
        else if (file.fieldname === 'voice') cb(null, 'public/uploads/audio/');
        else if (file.fieldname === 'recording') cb(null, 'public/uploads/recordings/');
        else if (file.fieldname === 'certificate') cb(null, 'public/uploads/certificates/');
        else if (file.fieldname === 'file') cb(null, 'public/uploads/files/');
        else cb(null, 'public/uploads/');
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ======================================================================
// СОЗДАНИЕ ТАБЛИЦ С ИНДЕКСАМИ
// ======================================================================
async function initDatabase() {
    const createTableQueries = [
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
            unread_counts JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT NOW()
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
        // Индексы для ускорения запросов
        `CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id)`,
        `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_psychologist ON appointments(psychologist_id)`,
        `CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
        `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`
    ];
    
    for (const query of createTableQueries) {
        try {
            await pool.query(query);
        } catch (err) {
            console.error('Ошибка создания таблицы:', err.message);
        }
    }
    console.log('✅ База данных инициализирована с индексами');
}

// ======================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ======================================================================
function safeJSONParse(str, defaultValue) {
    if (!str || str === 'null' || str === 'undefined') return defaultValue;
    if (typeof str === 'object') return str;
    try {
        return JSON.parse(str);
    } catch (e) {
        console.warn('⚠️ Ошибка парсинга JSON:', e.message);
        return defaultValue;
    }
}

async function getUser(id) {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    const dbUser = result.rows[0];
    const user = {
        id: dbUser.id,
        fullName: dbUser.full_name,
        email: dbUser.email,
        phone: dbUser.phone,
        password: dbUser.password,
        role: dbUser.role,
        specialization: dbUser.specialization,
        experience: dbUser.experience,
        about: dbUser.about,
        price: dbUser.price,
        topics: safeJSONParse(dbUser.topics, []),
        schedule: safeJSONParse(dbUser.schedule, {}),
        certificates: safeJSONParse(dbUser.certificates, []),
        rating: dbUser.rating || 0,
        avatar: dbUser.avatar,
        appointments: safeJSONParse(dbUser.appointments, []),
        clients: safeJSONParse(dbUser.clients, []),
        notifications: safeJSONParse(dbUser.notifications, []),
        unreadCounts: safeJSONParse(dbPlayer.unread_counts, {}),
        createdAt: dbUser.created_at
    };
    return user;
}

async function updateUser(user) {
    await pool.query(
        `UPDATE users SET 
            full_name = $2, email = $3, phone = $4, password = $5, role = $6,
            specialization = $7, experience = $8, about = $9, price = $10,
            topics = $11, schedule = $12, certificates = $13, rating = $14,
            avatar = $15, appointments = $16, clients = $17, notifications = $18, unread_counts = $19
         WHERE id = $1`,
        [
            user.id, 
            user.fullName || user.full_name, 
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
            JSON.stringify(user.unreadCounts || {})
        ]
    );
}

// ======================================================================
// API ЭНДПОЙНТЫ
// ======================================================================

// ---- Регистрация ----
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, phone, password, role, specialization, experience, about } = req.body;
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.json({ success: false, error: 'Email уже используется' });
        if (role === 'psychologist' && (!specialization || !experience)) {
            return res.json({ success: false, error: 'Заполните специализацию и опыт' });
        }
        const id = Date.now().toString();
        const newUser = {
            id, 
            fullName, 
            email, 
            phone: phone || '', 
            password, 
            role,
            specialization: specialization || '', 
            experience: experience || '', 
            about: about || '',
            price: 0, 
            topics: [], 
            schedule: {}, 
            certificates: [], 
            rating: 0,
            avatar: `https://ui-avatars.com/api/?background=8bca8b&color=fff&name=${encodeURIComponent(fullName)}&size=128`,
            appointments: [], 
            clients: [], 
            notifications: [], 
            unreadCounts: {}
        };
        await pool.query(
            `INSERT INTO users (id, full_name, email, phone, password, role, specialization, experience, about, price, topics, schedule, certificates, rating, avatar, appointments, clients, notifications, unread_counts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [
                newUser.id, newUser.fullName, newUser.email, newUser.phone, newUser.password,
                newUser.role, newUser.specialization, newUser.experience, newUser.about, newUser.price,
                JSON.stringify(newUser.topics), JSON.stringify(newUser.schedule),
                JSON.stringify(newUser.certificates), newUser.rating, newUser.avatar,
                JSON.stringify(newUser.appointments), JSON.stringify(newUser.clients),
                JSON.stringify(newUser.notifications), JSON.stringify(newUser.unreadCounts)
            ]
        );
        res.json({ success: true, userId: id, role });
    } catch (err) {
        console.error('Register error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Логин ----
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT id, role, full_name FROM users WHERE email = $1 AND password = $2', [email, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, userId: result.rows[0].id, role: result.rows[0].role, fullName: result.rows[0].full_name });
        } else {
            res.json({ success: false, error: 'Неверный email или пароль' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Получить пользователя ----
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await getUser(req.params.id);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        const { password, ...userData } = user;
        res.json({ success: true, user: userData });
    } catch (err) {
        console.error('Get user error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Обновить профиль ----
app.put('/api/user/profile', upload.single('avatar'), async (req, res) => {
    try {
        const { userId, fullName, phone, about, specialization, experience, price } = req.body;
        const user = await getUser(userId);
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        if (fullName) user.fullName = fullName;
        if (phone) user.phone = phone;
        if (about) user.about = about;
        if (specialization) user.specialization = specialization;
        if (experience) user.experience = experience;
        if (price) user.price = parseInt(price);
        if (req.file) user.avatar = `/uploads/images/${req.file.filename}`;
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) {
        console.error('Profile update error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Расписание ----
app.put('/api/schedule', async (req, res) => {
    try {
        const { userId, schedule } = req.body;
        const user = await getUser(userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        user.schedule = schedule;
        await updateUser(user);
        res.json({ success: true, schedule: user.schedule });
    } catch (err) {
        console.error('Schedule update error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Загрузка файлов ----
app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, avatarUrl: `/uploads/images/${req.file.filename}` });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, fileUrl: `/uploads/files/${req.file.filename}` });
});

app.post('/api/upload-chat-image', upload.single('image'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, imageUrl: `/uploads/images/${req.file.filename}` });
});

app.post('/api/upload-voice', upload.single('voice'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, voiceUrl: `/uploads/audio/${req.file.filename}` });
});

app.post('/api/upload-recording', upload.single('recording'), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    res.json({ success: true, recordingUrl: `/uploads/recordings/${req.file.filename}` });
});

// ---- Сертификаты ----
app.post('/api/certificates', upload.single('certificate'), async (req, res) => {
    try {
        const { userId, title } = req.body;
        const user = await getUser(userId);
        if (!user || user.role !== 'psychologist') return res.json({ success: false, error: 'Нет прав' });
        if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
        const newCert = {
            id: Date.now().toString(),
            user_id: userId,
            title: title || 'Сертификат',
            image: `/uploads/certificates/${req.file.filename}`
        };
        await pool.query(`INSERT INTO certificates (id, user_id, title, image) VALUES ($1, $2, $3, $4)`,
            [newCert.id, newCert.user_id, newCert.title, newCert.image]);
        if (!user.certificates) user.certificates = [];
        user.certificates.push({ id: newCert.id, title: newCert.title, image: newCert.image });
        await updateUser(user);
        const { password, ...safeUser } = user;
        res.json({ success: true, certificate: newCert, user: safeUser });
    } catch (err) {
        console.error('Certificate error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.delete('/api/certificates/:userId/:certId', async (req, res) => {
    try {
        const user = await getUser(req.params.userId);
        if (!user) return res.json({ success: false });
        await pool.query('DELETE FROM certificates WHERE id = $1', [req.params.certId]);
        if (user.certificates) {
            user.certificates = user.certificates.filter(c => c.id !== req.params.certId);
            await updateUser(user);
        }
        const { password, ...safeUser } = user;
        res.json({ success: true, user: safeUser });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ---- Посты ----
app.post('/api/posts', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
    try {
        const { authorId, text } = req.body;
        const author = await getUser(authorId);
        if (!author || author.role !== 'psychologist') return res.json({ success: false, error: 'Только психологи могут создавать посты' });
        const imageFile = req.files?.image?.[0];
        const videoFile = req.files?.video?.[0];
        const newPost = {
            id: Date.now().toString(),
            author_id: authorId,
            text,
            image: imageFile ? `/uploads/images/${imageFile.filename}` : null,
            video: videoFile ? `/uploads/videos/${videoFile.filename}` : null,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO posts (id, author_id, text, image, video, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [newPost.id, newPost.author_id, newPost.text, newPost.image, newPost.video, newPost.created_at]);
        io.emit('post_created', newPost);
        res.json({ success: true, post: newPost });
    } catch (err) {
        console.error('Create post error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/posts', async (req, res) => {
    try {
        const postsRes = await pool.query('SELECT * FROM posts ORDER BY created_at DESC');
        const posts = postsRes.rows;
        const enriched = [];
        for (const post of posts) {
            const author = await getUser(post.author_id);
            const likesCountRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [post.id]);
            const likesCount = parseInt(likesCountRes.rows[0].count);
            const commentsRes = await pool.query('SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC', [post.id]);
            const comments = [];
            for (const c of commentsRes.rows) {
                const commentAuthor = await getUser(c.author_id);
                comments.push({
                    id: c.id,
                    text: c.text,
                    createdAt: c.created_at,
                    author: { id: commentAuthor.id, fullName: commentAuthor.fullName, avatar: commentAuthor.avatar }
                });
            }
            let userLiked = false;
            if (req.query.userId) {
                const likedRes = await pool.query('SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2', [post.id, req.query.userId]);
                userLiked = likedRes.rows.length > 0;
            }
            enriched.push({
                id: post.id,
                text: post.text,
                image: post.image,
                video: post.video,
                createdAt: post.created_at,
                author: { id: author.id, fullName: author.fullName, avatar: author.avatar, rating: author.rating || 0 },
                likesCount,
                commentsCount: comments.length,
                comments,
                userLiked
            });
        }
        res.json({ success: true, posts: enriched });
    } catch (err) {
        console.error('Get posts error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.put('/api/posts/:id', upload.single('image'), async (req, res) => {
    try {
        const postId = req.params.id;
        const { authorId, text } = req.body;
        const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length === 0) return res.json({ success: false, error: 'Пост не найден' });
        const post = postRes.rows[0];
        if (post.author_id !== authorId) return res.json({ success: false, error: 'Нет прав' });
        let newImage = post.image;
        if (req.file) newImage = `/uploads/images/${req.file.filename}`;
        await pool.query('UPDATE posts SET text = $1, image = $2 WHERE id = $3', [text, newImage, postId]);
        io.emit('post_updated', { id: postId, text, image: newImage });
        res.json({ success: true });
    } catch (err) {
        console.error('Update post error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.delete('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        const { authorId } = req.body;
        const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length === 0) return res.json({ success: false, error: 'Пост не найден' });
        const post = postRes.rows[0];
        if (post.author_id !== authorId) return res.json({ success: false, error: 'Нет прав' });
        await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
        await pool.query('DELETE FROM likes WHERE post_id = $1', [postId]);
        await pool.query('DELETE FROM comments WHERE post_id = $1', [postId]);
        io.emit('post_deleted', postId);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete post error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Комментарии ----
app.post('/api/posts/:id/comment', async (req, res) => {
    try {
        const { userId, text } = req.body;
        const postId = req.params.id;
        const newComment = {
            id: Date.now().toString(),
            post_id: postId,
            author_id: userId,
            text,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO comments (id, post_id, author_id, text, created_at) VALUES ($1, $2, $3, $4, $5)`,
            [newComment.id, newComment.post_id, newComment.author_id, newComment.text, newComment.created_at]);
        const author = await getUser(userId);
        const commentWithAuthor = { 
            id: newComment.id,
            text: newComment.text,
            createdAt: newComment.created_at,
            author: { id: author.id, fullName: author.fullName, avatar: author.avatar } 
        };
        io.emit('comment_created', { postId, comment: commentWithAuthor });
        res.json({ success: true });
    } catch (err) {
        console.error('Add comment error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Лайки ----
app.post('/api/posts/:id/like', async (req, res) => {
    try {
        const { userId } = req.body;
        const postId = req.params.id;
        const existing = await pool.query('SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
            const countRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [postId]);
            const likesCount = parseInt(countRes.rows[0].count);
            io.emit('post_liked', { postId, likesCount, userId, liked: false });
            res.json({ success: true, liked: false, likesCount });
        } else {
            await pool.query(`INSERT INTO likes (id, post_id, user_id, created_at) VALUES ($1, $2, $3, $4)`,
                [Date.now().toString(), postId, userId, new Date().toISOString()]);
            const countRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [postId]);
            const likesCount = parseInt(countRes.rows[0].count);
            io.emit('post_liked', { postId, likesCount, userId, liked: true });
            res.json({ success: true, liked: true, likesCount });
        }
    } catch (err) {
        console.error('Like error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Запись на приём ----
app.post('/api/appointment', async (req, res) => {
    try {
        const { clientId, psychologistId, date, time } = req.body;
        const client = await getUser(clientId);
        const psychologist = await getUser(psychologistId);
        if (!client || !psychologist) return res.json({ success: false, error: 'Пользователь не найден' });
        
        const schedule = psychologist.schedule || {};
        const daySchedule = schedule[date];
        if (!daySchedule || !daySchedule.includes(time)) {
            return res.json({ success: false, error: 'Это время уже занято или не входит в расписание' });
        }
        
        schedule[date] = daySchedule.filter(t => t !== time);
        if (schedule[date].length === 0) delete schedule[date];
        psychologist.schedule = schedule;
        await updateUser(psychologist);
        
        const roomId = Math.random().toString(36).substring(2, 10).toUpperCase();
        const appointment = {
            id: Date.now().toString(),
            psychologist_id: psychologistId,
            client_id: clientId,
            psychologist_name: psychologist.fullName,
            client_name: client.fullName,
            date, time, room_id: roomId, status: 'pending', created_at: new Date().toISOString()
        };
        await pool.query(
            `INSERT INTO appointments (id, psychologist_id, client_id, psychologist_name, client_name, date, time, room_id, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [appointment.id, appointment.psychologist_id, appointment.client_id, appointment.psychologist_name,
             appointment.client_name, appointment.date, appointment.time, appointment.room_id, appointment.status, appointment.created_at]
        );
        
        if (!client.appointments) client.appointments = [];
        client.appointments.push({
            id: appointment.id,
            psychologistId: psychologistId,
            psychologistName: psychologist.fullName,
            clientId: clientId,
            clientName: client.fullName,
            date, time, roomId, status: 'pending'
        });
        
        if (!psychologist.clients) psychologist.clients = [];
        psychologist.clients.push({ 
            clientId, 
            clientName: client.fullName, 
            appointmentId: appointment.id, 
            date, time, status: 'pending', roomId 
        });
        
        await updateUser(client);
        await updateUser(psychologist);
        
        const notification = {
            id: Date.now().toString(),
            type: 'new_appointment',
            title: 'Новая заявка',
            message: `${client.fullName} хочет записаться на ${date} в ${time}`,
            appointmentId: appointment.id,
            roomId,
            createdAt: new Date().toISOString()
        };
        if (!psychologist.notifications) psychologist.notifications = [];
        psychologist.notifications.unshift(notification);
        await updateUser(psychologist);
        
        io.to(psychologistId).emit('notification', notification);
        res.json({ success: true });
    } catch (err) {
        console.error('Appointment error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/appointment/confirm', async (req, res) => {
    try {
        const { appointmentId, psychologistId, clientId } = req.body;
        await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', ['confirmed', appointmentId]);
        
        const psychologist = await getUser(psychologistId);
        const client = await getUser(clientId);
        
        if (psychologist && psychologist.clients) {
            const c = psychologist.clients.find(c => c.appointmentId === appointmentId);
            if (c) c.status = 'confirmed';
            await updateUser(psychologist);
        }
        if (client && client.appointments) {
            const a = client.appointments.find(a => a.id === appointmentId);
            if (a) a.status = 'confirmed';
            await updateUser(client);
        }
        
        const appointmentRes = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
        const appointment = appointmentRes.rows[0];
        
        const clientNotif = {
            id: Date.now().toString(),
            type: 'appointment_confirmed',
            title: 'Запись подтверждена!',
            message: `${psychologist.fullName} подтвердил запись на ${appointment.date} в ${appointment.time}`,
            appointmentId,
            roomId: appointment.room_id,
            createdAt: new Date().toISOString()
        };
        if (!client.notifications) client.notifications = [];
        client.notifications.unshift(clientNotif);
        await updateUser(client);
        
        io.to(clientId).emit('notification', clientNotif);
        res.json({ success: true });
    } catch (err) {
        console.error('Confirm appointment error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// ---- Задачи ----
app.get('/api/tasks/:psychologistId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tasks WHERE psychologist_id = $1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const tasks = result.rows.map(t => ({
            id: t.id,
            psychologistId: t.psychologist_id,
            text: t.text,
            dueDate: t.due_date,
            completed: t.completed,
            createdAt: t.created_at
        }));
        res.json({ success: true, tasks });
    } catch (err) {
        console.error('Get tasks error:', err);
        res.json({ success: false });
    }
});

app.post('/api/tasks', async (req, res) => {
    try {
        const { psychologistId, text, dueDate } = req.body;
        const newTask = {
            id: Date.now().toString(),
            psychologist_id: psychologistId,
            text,
            due_date: dueDate || null,
            completed: false,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO tasks (id, psychologist_id, text, due_date, completed, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [newTask.id, newTask.psychologist_id, newTask.text, newTask.due_date, newTask.completed, newTask.created_at]);
        res.json({ success: true, task: newTask });
    } catch (err) {
        console.error('Create task error:', err);
        res.json({ success: false });
    }
});

app.put('/api/tasks/:taskId', async (req, res) => {
    try {
        const { completed, text, dueDate } = req.body;
        await pool.query('UPDATE tasks SET completed = $1, text = $2, due_date = $3 WHERE id = $4',
            [completed, text, dueDate, req.params.taskId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Update task error:', err);
        res.json({ success: false });
    }
});

app.delete('/api/tasks/:taskId', async (req, res) => {
    try {
        await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.taskId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete task error:', err);
        res.json({ success: false });
    }
});

// ---- Заметки ----
app.get('/api/notes/:psychologistId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notes WHERE psychologist_id = $1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const notes = result.rows.map(n => ({
            id: n.id,
            psychologistId: n.psychologist_id,
            title: n.title,
            content: n.content,
            attachment: n.attachment,
            attachmentType: n.attachment_type,
            createdAt: n.created_at
        }));
        res.json({ success: true, notes });
    } catch (err) {
        console.error('Get notes error:', err);
        res.json({ success: false });
    }
});

app.post('/api/notes', async (req, res) => {
    try {
        const { psychologistId, title, content, attachment, attachmentType } = req.body;
        const newNote = {
            id: Date.now().toString(),
            psychologist_id: psychologistId,
            title, content,
            attachment: attachment || null,
            attachment_type: attachmentType || null,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO notes (id, psychologist_id, title, content, attachment, attachment_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newNote.id, newNote.psychologist_id, newNote.title, newNote.content, newNote.attachment, newNote.attachment_type, newNote.created_at]);
        res.json({ success: true, note: newNote });
    } catch (err) {
        console.error('Create note error:', err);
        res.json({ success: false });
    }
});

app.delete('/api/notes/:noteId', async (req, res) => {
    try {
        await pool.query('DELETE FROM notes WHERE id = $1', [req.params.noteId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete note error:', err);
        res.json({ success: false });
    }
});

// ---- Отзывы ----
app.post('/api/reviews', async (req, res) => {
    try {
        const { psychologistId, clientId, rating, text } = req.body;
        const client = await getUser(clientId);
        const psychologist = await getUser(psychologistId);
        if (!client || !psychologist) return res.json({ success: false, error: 'Пользователь не найден' });
        
        const hasAppointment = client.appointments?.some(a => a.psychologistId === psychologistId && a.status === 'confirmed');
        if (!hasAppointment) return res.json({ success: false, error: 'Вы можете оставить отзыв только после подтверждённого звонка' });
        
        const existing = await pool.query('SELECT 1 FROM reviews WHERE psychologist_id = $1 AND client_id = $2', [psychologistId, clientId]);
        if (existing.rows.length > 0) return res.json({ success: false, error: 'Вы уже оставляли отзыв этому психологу' });
        
        const newReview = {
            id: Date.now().toString(),
            psychologist_id: psychologistId,
            client_id: clientId,
            client_name: client.fullName,
            rating: Math.min(5, Math.max(1, rating)),
            text,
            created_at: new Date().toISOString()
        };
        await pool.query(`INSERT INTO reviews (id, psychologist_id, client_id, client_name, rating, text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newReview.id, newReview.psychologist_id, newReview.client_id, newReview.client_name, newReview.rating, newReview.text, newReview.created_at]);
        
        // Пересчитываем рейтинг
        const reviewsRes = await pool.query('SELECT rating FROM reviews WHERE psychologist_id = $1', [psychologistId]);
        let avgRating = 0;
        if (reviewsRes.rows.length) {
            const sum = reviewsRes.rows.reduce((s, r) => s + r.rating, 0);
            avgRating = sum / reviewsRes.rows.length;
        }
        
        // Бонус за лайки
        const postsRes = await pool.query('SELECT id FROM posts WHERE author_id = $1', [psychologist.id]);
        let totalLikes = 0;
        for (const p of postsRes.rows) {
            const likesRes = await pool.query('SELECT COUNT(*) FROM likes WHERE post_id = $1', [p.id]);
            totalLikes += parseInt(likesRes.rows[0].count);
        }
        const bonus = Math.min(1, totalLikes * 0.01);
        psychologist.rating = Math.min(5, avgRating + bonus);
        await updateUser(psychologist);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Review error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/reviews/:psychologistId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reviews WHERE psychologist_id = $1 ORDER BY created_at DESC', [req.params.psychologistId]);
        const reviews = result.rows.map(r => ({
            id: r.id,
            psychologistId: r.psychologist_id,
            clientId: r.client_id,
            clientName: r.client_name,
            rating: r.rating,
            text: r.text,
            createdAt: r.created_at
        }));
        res.json({ success: true, reviews });
    } catch (err) {
        console.error('Get reviews error:', err);
        res.json({ success: false });
    }
});

// ---- Поиск психологов ----
app.get('/api/search/psychologists', async (req, res) => {
    try {
        const query = req.query.q?.toLowerCase() || '';
        const result = await pool.query(
            `SELECT id, full_name, avatar, specialization, rating FROM users WHERE role = 'psychologist' AND LOWER(full_name) LIKE $1`,
            [`%${query}%`]
        );
        const psychologists = result.rows.map(p => ({
            id: p.id,
            full_name: p.full_name,
            avatar: p.avatar,
            specialization: p.specialization,
            rating: p.rating
        }));
        res.json({ success: true, psychologists });
    } catch (err) {
        console.error('Search error:', err);
        res.json({ success: false });
    }
});

// ---- Подписки ----
app.get('/api/subscriptions/:userId', async (req, res) => {
    try {
        const followingRes = await pool.query('SELECT following_id FROM subscriptions WHERE follower_id = $1', [req.params.userId]);
        const followersRes = await pool.query('SELECT follower_id FROM subscriptions WHERE following_id = $1', [req.params.userId]);
        res.json({
            success: true,
            following: followingRes.rows.map(r => r.following_id),
            followers: followersRes.rows.map(r => r.follower_id)
        });
    } catch (err) {
        console.error('Subscriptions error:', err);
        res.json({ success: false });
    }
});

app.post('/api/subscriptions', async (req, res) => {
    try {
        const { followerId, followingId } = req.body;
        const existing = await pool.query('SELECT 1 FROM subscriptions WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM subscriptions WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
            res.json({ success: true, subscribed: false });
        } else {
            await pool.query(`INSERT INTO subscriptions (id, follower_id, following_id, created_at) VALUES ($1, $2, $3, $4)`,
                [Date.now().toString(), followerId, followingId, new Date().toISOString()]);
            res.json({ success: true, subscribed: true });
        }
    } catch (err) {
        console.error('Subscription error:', err);
        res.json({ success: false });
    }
});

// ---- Чат ----
app.get('/api/messages/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const messagesRes = await pool.query('SELECT * FROM messages WHERE from_user = $1 OR to_user = $1 ORDER BY created_at ASC', [userId]);
        const messages = messagesRes.rows.map(m => ({
            id: m.id,
            from_user: m.from_user,
            to_user: m.to_user,
            text: m.text,
            image: m.image,
            voice: m.voice,
            is_read: m.is_read,
            created_at: m.created_at
        }));
        res.json({ success: true, messages });
    } catch (err) {
        console.error('Get messages error:', err);
        res.json({ success: false });
    }
});

app.post('/api/messages', async (req, res) => {
    try {
        const { from, to, text, image, voice } = req.body;
        const newMsg = {
            id: Date.now().toString(),
            from_user: from,
            to_user: to,
            text: text || '',
            image: image || null,
            voice: voice || null,
            is_read: false,
            created_at: new Date().toISOString()
        };
        
        // Сохраняем сообщение
        await pool.query(`INSERT INTO messages (id, from_user, to_user, text, image, voice, is_read, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [newMsg.id, newMsg.from_user, newMsg.to_user, newMsg.text, newMsg.image, newMsg.voice, newMsg.is_read, newMsg.created_at]);
        
        // Форматируем для клиента
        const msgForClient = {
            id: newMsg.id,
            from: newMsg.from_user,
            to: newMsg.to_user,
            text: newMsg.text,
            image: newMsg.image,
            voice: newMsg.voice,
            createdAt: newMsg.created_at
        };
        
        // Обновляем unreadCounts у получателя
        const recipient = await getUser(to);
        if (recipient) {
            if (!recipient.unreadCounts) recipient.unreadCounts = {};
            recipient.unreadCounts[from] = (recipient.unreadCounts[from] || 0) + 1;
            await updateUser(recipient);
            
            // Отправляем уведомление о непрочитанных
            io.to(to).emit('unread_update', { from, count: recipient.unreadCounts[from] });
            
            // Отправляем новое сообщение получателю
            io.to(to).emit('new_message', msgForClient);
        }
        
        // Отправляем подтверждение отправителю (чтобы он знал, что сообщение доставлено)
        io.to(from).emit('message_sent', msgForClient);
        
        res.json({ success: true, messageId: newMsg.id });
    } catch (err) {
        console.error('Send message error:', err);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/messages/read', async (req, res) => {
    try {
        const { userId, fromUserId } = req.body;
        
        // Обновляем статус прочитанных в базе
        await pool.query('UPDATE messages SET is_read = true WHERE to_user = $1 AND from_user = $2', [userId, fromUserId]);
        
        // Обновляем unreadCounts у пользователя
        const user = await getUser(userId);
        if (user && user.unreadCounts && user.unreadCounts[fromUserId]) {
            delete user.unreadCounts[fromUserId];
            await updateUser(user);
            
            // Уведомляем отправителя, что сообщение прочитано
            io.to(fromUserId).emit('messages_read', { by: userId, from: fromUserId });
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Mark read error:', err);
        res.json({ success: false });
    }
});

app.get('/api/psychologists', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, avatar, specialization, rating, price FROM users WHERE role = $1', ['psychologist']);
        const psychologists = result.rows.map(p => ({
            id: p.id,
            full_name: p.full_name,
            avatar: p.avatar,
            specialization: p.specialization,
            rating: p.rating,
            price: p.price
        }));
        res.json({ success: true, psychologists });
    } catch (err) {
        console.error('Get psychologists error:', err);
        res.json({ success: false });
    }
});

// ======================================================================
// WEBSOCKET / WEBRTC
// ======================================================================
const activeRooms = new Map();

io.on('connection', (socket) => {
    console.log('🔌 WebSocket connected:', socket.id);
    
    socket.on('register_user', (userId) => {
        socket.userId = userId;
        if (userId) {
            socket.join(userId);
            console.log(`✅ User ${userId} registered, joined room ${userId}`);
        }
    });
    
    socket.on('join-call-room', (roomId, userId, userType) => {
        try {
            console.log(`📞 User ${userId} (${userType}) joining room ${roomId}`);
            
            if (!activeRooms.has(roomId)) {
                activeRooms.set(roomId, { psychologist: null, client: null, users: new Map() });
            }
            const room = activeRooms.get(roomId);
            
            if (userType === 'psychologist' && room.psychologist && room.psychologist !== socket.id) {
                io.to(room.psychologist).emit('partner-disconnected');
                const oldSocket = io.sockets.sockets.get(room.psychologist);
                if (oldSocket) oldSocket.leave(roomId);
                room.psychologist = socket.id;
                room.users.delete(room.psychologist);
            } else if (userType === 'client' && room.client && room.client !== socket.id) {
                io.to(room.client).emit('partner-disconnected');
                const oldSocket = io.sockets.sockets.get(room.client);
                if (oldSocket) oldSocket.leave(roomId);
                room.client = socket.id;
                room.users.delete(room.client);
            }
            
            room.users.set(socket.id, { userId, userType });
            if (userType === 'psychologist') room.psychologist = socket.id;
            else room.client = socket.id;
            
            socket.join(roomId);
            socket.roomId = roomId;
            socket.userId = userId;
            socket.userType = userType;
            
            if (room.psychologist && room.client) {
                console.log(`🎥 Both users ready in room ${roomId}`);
                io.to(room.psychologist).emit('call-ready', { partnerId: room.client });
                io.to(room.client).emit('call-ready', { partnerId: room.psychologist });
            }
            socket.emit('room-joined');
        } catch (err) { 
            console.error('join-call-room error:', err); 
        }
    });
    
    socket.on('call-message', (msgData) => {
        const room = activeRooms.get(socket.roomId);
        if (room) {
            const targetId = socket.userType === 'psychologist' ? room.client : room.psychologist;
            if (targetId) {
                io.to(targetId).emit('call-message', { 
                    from: socket.userId, 
                    text: msgData.text, 
                    time: new Date().toISOString() 
                });
            }
        }
    });
    
    socket.on('offer', (data) => {
        if (data.target) {
            socket.to(data.target).emit('offer', { sdp: data.sdp, from: socket.id });
        }
    });
    
    socket.on('answer', (data) => {
        if (data.target) {
            socket.to(data.target).emit('answer', { sdp: data.sdp, from: socket.id });
        }
    });
    
    socket.on('ice-candidate', (data) => {
        if (data.target) {
            socket.to(data.target).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
        }
    });
    
    socket.on('end-call', () => {
        if (socket.roomId) {
            console.log(`📞 Call ended in room ${socket.roomId}`);
            socket.to(socket.roomId).emit('call-ended');
            socket.leave(socket.roomId);
            const room = activeRooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (socket.userType === 'psychologist') room.psychologist = null;
                else room.client = null;
                if (room.users.size === 0) {
                    setTimeout(() => {
                        if (activeRooms.get(socket.roomId)?.users.size === 0) {
                            activeRooms.delete(socket.roomId);
                            console.log(`🗑️ Room ${socket.roomId} deleted`);
                        }
                    }, 10000);
                }
            }
            delete socket.roomId;
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`🔌 WebSocket disconnected: ${socket.id}`);
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner-disconnected');
            const room = activeRooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                if (socket.userType === 'psychologist') room.psychologist = null;
                else room.client = null;
                if (room.users.size === 0) {
                    setTimeout(() => {
                        if (activeRooms.get(socket.roomId)?.users.size === 0) {
                            activeRooms.delete(socket.roomId);
                        }
                    }, 10000);
                }
            }
            socket.leave(socket.roomId);
            delete socket.roomId;
        }
    });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// ======================================================================
// ЗАПУСК СЕРВЕРА
// ======================================================================
const PORT = process.env.PORT || 3000;

async function startServer() {
    await initDatabase();
    server.listen(PORT, '0.0.0.0', () => console.log(`✅ Сервер запущен на порту ${PORT}`));
}

startServer().catch(console.error);