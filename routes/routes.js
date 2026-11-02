const express = require('express');
const router = express.Router();
const db = require('../db'); // points to your db.js pool

// GET all tickets (with filters if needed)
router.get('/', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT t.*, u1.name as requester_name, u2.name as assignee_name 
            FROM tickets t
            LEFT JOIN users u1 ON t.requester_id = u1.user_id
            LEFT JOIN users u2 ON t.assigned_to = u2.user_id
            ORDER BY t.created_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// POST create a new ticket (e.g. #B-4910 style)
router.post('/', async (req, res) => {
    const { ticket_code, subject, description, category, priority, requester_id } = req.body;
    try {
        const [result] = await db.query(
            `INSERT INTO tickets (ticket_code, subject, description, category, priority, requester_id, status) 
             VALUES (?, ?, ?, ?, ?, ?, 'New')`,
            [ticket_code, subject, description, category, priority, requester_id]
        );
        res.status(201).json({ success: true, message: 'Ticket created successfully', ticketId: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to create ticket' });
    }
});

module.exports = router;