const express = require('express');
const router = express.Router();
const db = require('../db');

// GET all system users (including role and department details)
router.get('/', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT 
                user_id AS id, 
                name, 
                email, 
                role, 
                department, 
                status, 
                last_active AS lastActive, 
                avatar, 
                created_at 
             FROM users 
             ORDER BY created_at DESC`
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ success: false, message: 'Server Error while fetching users' });
    }
});

// POST add a new user profile with specific role and department
router.post('/', async (req, res) => {
    const { name, email, role, department, status, avatar } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ success: false, message: 'Name and email are required' });
    }

    try {
        const userAvatar = avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150';
        const userStatus = status || 'Active';
        const userRole = role || 'Employee';
        const userDept = department || 'General Management';

        const [result] = await db.query(
            `INSERT INTO users (name, email, role, department, status, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, email, userRole, userDept, userStatus, userAvatar]
        );

        const newUser = {
            id: result.insertId.toString(),
            name,
            email,
            role: userRole,
            department: userDept,
            status: userStatus,
            lastActive: 'Just now',
            avatar: userAvatar
        };

        res.status(201).json({ success: true, message: 'User added successfully', data: newUser });
    } catch (err) {
        console.error('Error adding user:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'User with this email already exists.' });
        }
        res.status(500).json({ success: false, message: 'Failed to add user to database' });
    }
});

// PATCH update user status (Active / Inactive)
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    try {
        const [result] = await db.query('UPDATE users SET status = ? WHERE user_id = ?', [status, id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, message: 'User status updated successfully' });
    } catch (err) {
        console.error('Error updating user status:', err);
        res.status(500).json({ success: false, message: 'Database error while updating status' });
    }
});

module.exports = router;