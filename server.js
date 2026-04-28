const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Подключение к БД (замените на вашу DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Создание таблицы постов, если её нет
pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        text TEXT,
        image TEXT,
        video TEXT,
        created_at TIMESTAMP DEFAULT NOW()
    )
`).catch(console.error);

// API для получения постов (публичный, без токена)
app.get('/api/posts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM posts ORDER BY created_at DESC');
        res.json({ success: true, posts: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Ошибка БД' });
    }
});

// API для создания поста (для теста, можно через curl)
app.post('/api/posts', async (req, res) => {
    const { text, image, video } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Нет текста' });
    try {
        const result = await pool.query(
            'INSERT INTO posts (text, image, video) VALUES ($1, $2, $3) RETURNING *',
            [text, image || null, video || null]
        );
        res.json({ success: true, post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));