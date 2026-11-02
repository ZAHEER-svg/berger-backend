const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper function to evaluate staff status
const checkIsStaff = (req) => {
    if (req.user && (req.user.role === 'admin' || req.user.isItStaff)) {
        return true;
    }
    return req.query.isStaff === 'true';
};

// Helper function to ensure tables and columns exist
const ensureTablesAndColumnsExist = async () => {
    // 1. Ensure categories table
    await db.query(`
        CREATE TABLE IF NOT EXISTS kb_categories (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE
        )
    `);

    // 2. Ensure knowledge_base columns exist
    try {
        await db.query(`ALTER TABLE knowledge_base ADD COLUMN is_quick_info BOOLEAN DEFAULT FALSE`);
    } catch (e) {
        // Column already exists
    }

    try {
        await db.query(`ALTER TABLE knowledge_base ADD COLUMN image_url LONGTEXT NULL`);
    } catch (e) {
        // Column already exists
    }
};

// ==========================================
// CATEGORIES ROUTES
// ==========================================

// GET distinct categories with article counts (including 0-article categories)
router.get('/categories', async (req, res) => {
    try {
        await ensureTablesAndColumnsExist();
        const isStaff = checkIsStaff(req);

        const query = `
            SELECT 
                c.id,
                c.name, 
                COUNT(k.id) AS article_count 
            FROM kb_categories c
            LEFT JOIN knowledge_base k 
                ON c.name = k.category 
                ${!isStaff ? "AND k.status = 'Published'" : ''}
            GROUP BY c.id, c.name
            ORDER BY c.name ASC
        `;

        const [rows] = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching categories:', err);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// POST create and save a new category to MySQL
router.post('/categories', async (req, res) => {
    const { name } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Category name is required' });
    }

    const categoryName = name.trim();

    try {
        await ensureTablesAndColumnsExist();

        const [result] = await db.query(
            'INSERT INTO kb_categories (name) VALUES (?) ON DUPLICATE KEY UPDATE name = name',
            [categoryName]
        );

        res.status(201).json({ 
            id: result.insertId || null,
            name: categoryName, 
            article_count: 0,
            message: 'Category created successfully' 
        });
    } catch (err) {
        console.error('Error saving category:', err);
        res.status(500).json({ error: 'Failed to save category' });
    }
});

// PUT update an existing category name and sync matching articles
router.put('/categories/:id', async (req, res) => {
    const param = req.params.id;
    const id = parseInt(param, 10);
    const { name } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Category name is required' });
    }

    const newCategoryName = name.trim();

    try {
        await ensureTablesAndColumnsExist();

        let existing = [];
        if (!isNaN(id)) {
            [existing] = await db.query('SELECT name FROM kb_categories WHERE id = ?', [id]);
        } else {
            [existing] = await db.query('SELECT name FROM kb_categories WHERE name = ?', [param]);
        }

        if (existing.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const oldCategoryName = existing[0].name;

        if (!isNaN(id)) {
            await db.query('UPDATE kb_categories SET name = ? WHERE id = ?', [newCategoryName, id]);
        } else {
            await db.query('UPDATE kb_categories SET name = ? WHERE name = ?', [newCategoryName, param]);
        }

        if (oldCategoryName !== newCategoryName) {
            await db.query('UPDATE knowledge_base SET category = ? WHERE category = ?', [newCategoryName, oldCategoryName]);
        }

        res.json({ message: 'Category updated successfully', name: newCategoryName });
    } catch (err) {
        console.error('Error updating category:', err);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

// DELETE a category by ID (or name)
router.delete('/categories/:id', async (req, res) => {
    const param = req.params.id;
    const id = parseInt(param, 10);

    try {
        await ensureTablesAndColumnsExist();

        let result;
        if (!isNaN(id)) {
            [result] = await db.query('DELETE FROM kb_categories WHERE id = ?', [id]);
        } else {
            [result] = await db.query('DELETE FROM kb_categories WHERE name = ?', [param]);
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        res.json({ message: 'Category deleted successfully' });
    } catch (err) {
        console.error('Error deleting category:', err);
        res.status(500).json({ error: 'Failed to delete category' });
    }
});

// ==========================================
// ARTICLES ROUTES
// ==========================================

// GET all articles
router.get('/articles', async (req, res) => {
    try {
        await ensureTablesAndColumnsExist();
        const isStaff = checkIsStaff(req);
        let query = `
            SELECT 
                id, 
                title, 
                category, 
                summary, 
                content, 
                tags, 
                status, 
                is_quick_info,
                image_url,
                views, 
                author_id, 
                updated_at 
            FROM knowledge_base 
            WHERE 1=1
        `;

        if (!isStaff) {
            query += ` AND status = 'Published'`;
        }

        query += ` ORDER BY updated_at DESC`;

        const [rows] = await db.query(query);

        // Normalize tinyint/boolean
        const formatted = rows.map(item => ({
            ...item,
            is_quick_info: Boolean(item.is_quick_info)
        }));

        res.json(formatted);
    } catch (err) {
        console.error('Error fetching articles:', err);
        res.status(500).json({ error: 'Failed to fetch articles' });
    }
});

// GET single article by ID
router.get('/articles/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid article ID' });

    try {
        await ensureTablesAndColumnsExist();
        const [rows] = await db.query(
            `SELECT 
                id, 
                title, 
                category, 
                summary, 
                content, 
                tags, 
                status, 
                is_quick_info,
                image_url,
                views, 
                author_id, 
                updated_at 
             FROM knowledge_base 
             WHERE id = ?`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }

        const article = {
            ...rows[0],
            is_quick_info: Boolean(rows[0].is_quick_info)
        };

        res.json(article);
    } catch (err) {
        console.error('Error fetching article:', err);
        res.status(500).json({ error: 'Failed to fetch article' });
    }
});

// POST create a new article
router.post('/articles', async (req, res) => {
    const { title, category, summary, content, tags, status, is_quick_info, image_url, author_id } = req.body;

    if (!title || !title.trim() || !category || !content || !content.trim()) {
        return res.status(400).json({ error: 'Title, category, and content are required' });
    }

    const trimmedCategory = category.trim();

    try {
        await ensureTablesAndColumnsExist();

        await db.query(
            'INSERT INTO kb_categories (name) VALUES (?) ON DUPLICATE KEY UPDATE name = name',
            [trimmedCategory]
        );

        const [result] = await db.query(
            `INSERT INTO knowledge_base 
                (title, category, summary, content, tags, status, is_quick_info, image_url, author_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                title.trim(), 
                trimmedCategory, 
                summary ? summary.trim() : '', 
                content.trim(), 
                tags || null, 
                status || 'Published', 
                is_quick_info ? 1 : 0,
                image_url || null,
                author_id || (req.user ? req.user.id : 1)
            ]
        );

        res.status(201).json({ 
            id: result.insertId, 
            message: 'Article created successfully' 
        });
    } catch (err) {
        console.error('Error creating article:', err);
        res.status(500).json({ error: 'Failed to create article' });
    }
});

// PUT update an existing article
router.put('/articles/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { title, category, summary, content, tags, status, is_quick_info, image_url, author_id } = req.body;

    if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid article ID' });
    }

    if (!title || !title.trim() || !category || !content || !content.trim()) {
        return res.status(400).json({ error: 'Title, category, and content are required' });
    }

    const trimmedCategory = category.trim();

    try {
        await ensureTablesAndColumnsExist();

        await db.query(
            'INSERT INTO kb_categories (name) VALUES (?) ON DUPLICATE KEY UPDATE name = name',
            [trimmedCategory]
        );

        const [result] = await db.query(
            `UPDATE knowledge_base 
             SET title = ?, category = ?, summary = ?, content = ?, tags = ?, status = ?, is_quick_info = ?, image_url = ?, author_id = ? 
             WHERE id = ?`,
            [
                title.trim(), 
                trimmedCategory, 
                summary ? summary.trim() : '', 
                content.trim(), 
                tags || null, 
                status || 'Published', 
                is_quick_info ? 1 : 0,
                image_url || null,
                author_id || (req.user ? req.user.id : 1), 
                id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }

        res.json({ message: 'Article updated successfully' });
    } catch (err) {
        console.error('Error updating article:', err);
        res.status(500).json({ error: 'Failed to update article' });
    }
});

// DELETE an article
router.delete('/articles/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid article ID' });
    }

    try {
        const [result] = await db.query('DELETE FROM knowledge_base WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }

        res.json({ message: 'Article deleted successfully' });
    } catch (err) {
        console.error('Error deleting article:', err);
        res.status(500).json({ error: 'Failed to delete article' });
    }
});

// POST increment article views
router.post('/articles/:id/view', async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid article ID' });
    }

    try {
        const [result] = await db.query(
            'UPDATE knowledge_base SET views = COALESCE(views, 0) + 1 WHERE id = ?', 
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Article not found' });
        }

        res.json({ message: 'View count updated' });
    } catch (err) {
        console.error('Error updating view count:', err);
        res.status(500).json({ error: 'Failed to increment view count' });
    }
});

module.exports = router;