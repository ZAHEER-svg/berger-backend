const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const db = require('../db');

// Configure Nodemailer Transporter
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const ADMIN_ROLES = [
    'it', 'system admin', 'admin', 'administrator', 
    'it support', 'it engineer', 'it admin', 
    'super admin', 'super administrator', 'senior it admin', 
    'support', 'help desk', 'consultant', 'vendor'
];

/**
 * Helper to send email alerts to admins when a ticket is created
 */
async function sendAdminNotification(ticket) {
    try {
        let adminEmails = [];
        try {
            const [settingRows] = await db.query(
                `SELECT setting_value FROM system_settings WHERE setting_key = ?`,
                ['ticket_notification_email']
            );
            if (settingRows.length > 0 && settingRows[0].setting_value) {
                adminEmails = settingRows[0].setting_value.split(/[,;]+/).map(e => e.trim()).filter(Boolean);
            }
        } catch (settingErr) {
            console.log('System setting lookup skipped, falling back to admin roles.');
        }

        if (adminEmails.length === 0) {
            const [admins] = await db.query(
                `SELECT email FROM users WHERE LOWER(role) IN (?)`,
                [ADMIN_ROLES]
            );
            adminEmails = admins.map(a => a.email).filter(Boolean);
        }

        if (!adminEmails.length) return;

        const mailOptions = {
            from: `"Help Desk Alert" <${process.env.SMTP_USER || 'noreply@helpdesk.com'}>`,
            to: adminEmails,
            subject: `🚨 [New Ticket ${ticket.ticket_code}] - ${ticket.subject}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #2563eb;">New Support Ticket Submitted</h2>
                    <p>A new ticket has been opened and requires attention:</p>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                        <tr><td style="padding: 8px; font-weight: bold; width: 130px;">Ticket Code:</td><td>${ticket.ticket_code}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Subject:</td><td>${ticket.subject}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Category:</td><td>${ticket.category}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Priority:</td><td><strong style="color: red;">${ticket.priority}</strong></td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Requester:</td><td>${ticket.requester_name || 'User'} (${ticket.requester_email || 'N/A'})</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Description:</td><td>${ticket.description}</td></tr>
                    </table>
                    <br/>
                    <p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background-color: #2563eb; color: white; padding: 10px 18px; text-decoration: none; border-radius: 8px; font-weight: bold;">Open Help Desk Queue</a></p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
    } catch (err) {
        console.error('Failed to send admin email notification:', err.message);
    }
}

/**
 * Helper to send email alerts to users when their ticket is assigned/elevated
 */
async function sendAssignmentNotification(ticket, assigneeName, elevationNotes, isConsultant) {
    try {
        if (!ticket.requester_email) return;

        const actionTitle = isConsultant ? 'Elevated to Consultant' : 'Assigned to Specialist';
        const mailOptions = {
            from: `"Help Desk" <${process.env.SMTP_USER || 'noreply@helpdesk.com'}>`,
            to: ticket.requester_email,
            subject: `ℹ️ [Ticket Update ${ticket.ticket_code}] - ${actionTitle}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #2563eb;">Ticket Status Update: ${actionTitle}</h2>
                    <p>Hello ${ticket.requester_name || 'Valued User'},</p>
                    <p>Your support ticket has been ${isConsultant ? 'elevated to a specialist consultant' : 'assigned to an IT specialist'} for resolution.</p>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background-color: #f8fafc; border-radius: 8px; padding: 12px;">
                        <tr><td style="padding: 8px; font-weight: bold; width: 140px;">Ticket Code:</td><td>${ticket.ticket_code}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Subject:</td><td>${ticket.subject}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Assigned To:</td><td><strong>${assigneeName}</strong> ${isConsultant ? '(External Consultant)' : ''}</td></tr>
                        ${elevationNotes ? `<tr><td style="padding: 8px; font-weight: bold;">Notes:</td><td>${elevationNotes}</td></tr>` : ''}
                    </table>
                    <br/>
                    <p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background-color: #2563eb; color: white; padding: 10px 18px; text-decoration: none; border-radius: 8px; font-weight: bold;">View Ticket Status</a></p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
    } catch (err) {
        console.error('Failed to send assignment notification:', err.message);
    }
}

/**
 * Helper to send email alerts to users when their ticket is resolved
 */
async function sendUserResolutionNotification(ticket) {
    try {
        if (!ticket.requester_email) return;

        const mailOptions = {
            from: `"Help Desk" <${process.env.SMTP_USER || 'noreply@helpdesk.com'}>`,
            to: ticket.requester_email,
            subject: `✅ [Ticket Resolved ${ticket.ticket_code}] - ${ticket.subject}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #16a34a;">Your Support Ticket Has Been Resolved</h2>
                    <p>Hello ${ticket.requester_name || 'Valued User'},</p>
                    <p>Good news! Your support ticket has been marked as <strong>Resolved</strong> by the IT support team.</p>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; background-color: #f8fafc; border-radius: 8px;">
                        <tr><td style="padding: 8px; font-weight: bold; width: 140px;">Ticket Code:</td><td>${ticket.ticket_code}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Subject:</td><td>${ticket.subject}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Category:</td><td>${ticket.category}</td></tr>
                        <tr><td style="padding: 8px; font-weight: bold;">Resolution Notes:</td><td>${ticket.resolution_notes || 'Issue resolved successfully.'}</td></tr>
                    </table>
                    <br/>
                    <p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background-color: #2563eb; color: white; padding: 10px 18px; text-decoration: none; border-radius: 8px; font-weight: bold;">Open Help Desk Portal</a></p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
    } catch (err) {
        console.error('Failed to send user resolution email notification:', err.message);
    }
}

/**
 * Helper to fetch a complete ticket record with detailed requester, assignee & dynamic live timer calculation.
 */
async function fetchTicketByIdOrCode(id) {
    const decodedId = decodeURIComponent(id);
    const query = `
        SELECT 
            t.ticket_id,
            t.ticket_code,
            t.ticket_code AS id,
            t.subject,
            t.description,
            t.category,
            t.priority,
            t.status,
            t.sla_status,
            t.is_paused,
            t.paused_at,
            t.total_paused_seconds,
            t.timer_started_at,
            t.is_elevated,
            t.elevation_notes,
            CASE 
                WHEN t.is_paused = 1 OR t.status IN ('Resolved', 'Closed') THEN COALESCE(t.time_spent, 0)
                WHEN t.timer_started_at IS NOT NULL THEN 
                    COALESCE(t.time_spent, 0) + TIMESTAMPDIFF(SECOND, t.timer_started_at, CURRENT_TIMESTAMP)
                ELSE COALESCE(t.time_spent, 0)
            END AS time_spent,
            t.resolution_notes,
            t.resolved_at,
            t.created_at,
            t.updated_at,
            t.requester_id,
            u1.name AS requester,
            u1.name AS requester_name,
            u1.email AS requester_email,
            u1.avatar AS avatar,
            t.assigned_to AS assigned_id,
            COALESCE(u2.name, 'IT Support Team') AS assignedTo,
            u2.name AS assignee_name,
            u2.email AS assignee_email,
            u2.role AS assignee_role,
            u2.avatar AS assignedAvatar
        FROM tickets t
        INNER JOIN users u1 ON t.requester_id = u1.user_id
        LEFT JOIN users u2 ON t.assigned_to = u2.user_id
        WHERE t.ticket_id = ? OR t.ticket_code = ?
    `;
    const [rows] = await db.query(query, [decodedId, decodedId]);
    return rows[0] || null;
}

/**
 * GET /api/tickets/users/list
 * Allows filtering assignees by role (e.g. ?role=admin_only)
 */
router.get('/users/list', async (req, res) => {
    try {
        const { role } = req.query;
        let sql = 'SELECT user_id, name, email, role, avatar FROM users';
        const queryParams = [];

        if (role === 'admin_only') {
            sql += ' WHERE LOWER(role) IN (?)';
            queryParams.push(ADMIN_ROLES);
        }

        sql += ' ORDER BY name ASC';

        const [users] = await db.query(sql, queryParams);
        res.json({ success: true, data: users });
    } catch (err) {
        console.error('Error fetching users list:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch users list' });
    }
});

/**
 * GET /api/tickets
 */
router.get('/', async (req, res) => {
    try {
        const { status, priority, category, search, requester_id, assigned_to, user_id, user_role } = req.query;
        
        const currentUserId = req.user?.id || req.user?.user_id || (user_id && user_id !== 'null' && user_id !== 'undefined' ? user_id : null);
        let currentUserRole = (req.user?.role || user_role || 'Employee').trim().toLowerCase();
        
        let isItStaff = ADMIN_ROLES.includes(currentUserRole);

        if (currentUserId && !isItStaff) {
            try {
                const [userRows] = await db.query('SELECT role FROM users WHERE user_id = ?', [currentUserId]);
                if (userRows.length > 0 && userRows[0].role) {
                    const dbRole = userRows[0].role.trim().toLowerCase();
                    if (ADMIN_ROLES.includes(dbRole)) {
                        currentUserRole = dbRole;
                        isItStaff = true;
                    }
                }
            } catch (dbErr) {
                console.error('Failed to verify user role from DB:', dbErr.message);
            }
        }

        if (!isItStaff && !currentUserId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Unauthorized: Valid user identifier is required to view personal tickets.' 
            });
        }

        let query = `
            SELECT 
                t.ticket_id,
                t.ticket_code,
                t.ticket_code AS id,
                t.subject,
                t.description,
                t.category,
                t.priority,
                t.status,
                t.sla_status,
                t.is_paused,
                t.paused_at,
                t.total_paused_seconds,
                t.timer_started_at,
                t.is_elevated,
                t.elevation_notes,
                CASE 
                    WHEN t.is_paused = 1 OR t.status IN ('Resolved', 'Closed') THEN COALESCE(t.time_spent, 0)
                    WHEN t.timer_started_at IS NOT NULL THEN 
                        COALESCE(t.time_spent, 0) + TIMESTAMPDIFF(SECOND, t.timer_started_at, CURRENT_TIMESTAMP)
                    ELSE COALESCE(t.time_spent, 0)
                END AS time_spent,
                t.resolution_notes,
                t.resolved_at,
                t.created_at,
                t.updated_at,
                t.requester_id,
                u1.name AS requester,
                u1.email AS requester_email,
                u1.avatar AS avatar,
                t.assigned_to AS assigned_id,
                COALESCE(u2.name, 'IT Support Team') AS assignedTo,
                u2.role AS assignee_role,
                u2.avatar AS assignedAvatar
            FROM tickets t
            INNER JOIN users u1 ON t.requester_id = u1.user_id
            LEFT JOIN users u2 ON t.assigned_to = u2.user_id
            WHERE 1=1
        `;

        const queryParams = [];

        if (!isItStaff) {
            query += ` AND t.requester_id = ?`;
            queryParams.push(currentUserId);
        } else if (requester_id) {
            query += ` AND t.requester_id = ?`;
            queryParams.push(requester_id);
        }

        if (status && status !== 'All') {
            query += ` AND t.status = ?`;
            queryParams.push(status);
        }
        if (priority && priority !== 'All') {
            query += ` AND t.priority = ?`;
            queryParams.push(priority);
        }
        if (category && category !== 'All') {
            query += ` AND t.category = ?`;
            queryParams.push(category);
        }
        if (assigned_to) {
            if (assigned_to === 'unassigned') {
                query += ` AND t.assigned_to IS NULL`;
            } else {
                query += ` AND t.assigned_to = ?`;
                queryParams.push(assigned_to);
            }
        }
        if (search) {
            query += ` AND (t.subject LIKE ? OR t.ticket_code LIKE ? OR u1.name LIKE ? OR t.description LIKE ?)`;
            const searchPattern = `%${search}%`;
            queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY t.created_at DESC`;

        const [rows] = await db.query(query, queryParams);
        res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        console.error('Error fetching tickets:', err);
        res.status(500).json({ success: false, message: 'Server error while fetching tickets' });
    }
});

/**
 * GET /api/tickets/:id
 */
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    const { user_id, user_role } = req.query;

    const currentUserId = req.user?.id || req.user?.user_id || (user_id && user_id !== 'null' && user_id !== 'undefined' ? user_id : null);
    let currentUserRole = (req.user?.role || user_role || 'Employee').trim().toLowerCase();
    let isItStaff = ADMIN_ROLES.includes(currentUserRole);

    if (currentUserId && !isItStaff) {
        try {
            const [userRows] = await db.query('SELECT role FROM users WHERE user_id = ?', [currentUserId]);
            if (userRows.length > 0 && userRows[0].role) {
                const dbRole = userRows[0].role.trim().toLowerCase();
                if (ADMIN_ROLES.includes(dbRole)) {
                    isItStaff = true;
                }
            }
        } catch (dbErr) {
            console.error('Failed to verify user role from DB:', dbErr.message);
        }
    }

    try {
        const ticket = await fetchTicketByIdOrCode(id);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        if (!isItStaff && String(ticket.requester_id) !== String(currentUserId)) {
            return res.status(403).json({ success: false, message: 'Unauthorized access to this ticket' });
        }

        res.json({ success: true, data: ticket });
    } catch (err) {
        console.error('Error fetching ticket details:', err);
        res.status(500).json({ success: false, message: 'Server error while fetching ticket' });
    }
});

/**
 * POST /api/tickets
 */
router.post('/', async (req, res) => {
    const { 
        ticket_code, 
        subject, 
        description, 
        category, 
        priority = 'Medium', 
        requester_id, 
        assigned_to = null,
        notify_admin = true
    } = req.body;

    if (!subject || !description || !category || !requester_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing required fields: subject, description, category, and requester_id.' 
        });
    }

    try {
        const generatedCode = ticket_code || `#B-${Math.floor(1000 + Math.random() * 9000)}`;

        const [result] = await db.query(
            `INSERT INTO tickets 
                (ticket_code, subject, description, category, priority, status, requester_id, assigned_to, sla_status, is_paused, total_paused_seconds, time_spent, timer_started_at) 
             VALUES (?, ?, ?, ?, ?, 'New', ?, ?, 'On Track', 0, 0, 0, CURRENT_TIMESTAMP)`,
            [generatedCode, subject, description, category, priority, requester_id, assigned_to || null]
        );

        const newTicket = await fetchTicketByIdOrCode(result.insertId);

        if (notify_admin) {
            sendAdminNotification(newTicket);
        }

        res.status(201).json({
            success: true,
            message: 'Ticket created successfully',
            data: newTicket
        });
    } catch (err) {
        console.error('Error creating ticket:', err);
        res.status(500).json({ success: false, message: 'Failed to create ticket' });
    }
});

/**
 * PATCH /api/tickets/:id/pause-timer
 */
router.patch('/:id/pause-timer', async (req, res) => {
    const { id } = req.params;
    const { is_paused } = req.body;
    const decodedId = decodeURIComponent(id);

    try {
        const ticket = await fetchTicketByIdOrCode(decodedId);
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const shouldPause = is_paused !== undefined ? Boolean(is_paused) : !ticket.is_paused;

        if (shouldPause) {
            await db.query(
                `UPDATE tickets 
                 SET time_spent = COALESCE(time_spent, 0) + CASE 
                         WHEN timer_started_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, timer_started_at, CURRENT_TIMESTAMP)
                         ELSE 0 
                     END,
                     timer_started_at = NULL,
                     is_paused = 1, 
                     paused_at = CURRENT_TIMESTAMP, 
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE ticket_id = ? OR ticket_code = ?`,
                [decodedId, decodedId]
            );
        } else {
            await db.query(
                `UPDATE tickets 
                 SET total_paused_seconds = COALESCE(total_paused_seconds, 0) + TIMESTAMPDIFF(SECOND, COALESCE(paused_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP),
                     timer_started_at = CURRENT_TIMESTAMP,
                     is_paused = 0, 
                     paused_at = NULL, 
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE ticket_id = ? OR ticket_code = ?`,
                [decodedId, decodedId]
            );
        }

        const updatedTicket = await fetchTicketByIdOrCode(decodedId);
        res.json({
            success: true,
            message: shouldPause ? 'Timer paused successfully' : 'Timer resumed successfully',
            data: updatedTicket
        });
    } catch (err) {
        console.error('Error toggling ticket timer:', err);
        res.status(500).json({ success: false, message: 'Failed to toggle ticket timer' });
    }
});

/**
 * PATCH /api/tickets/:id/status
 */
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, resolution_notes } = req.body;
    const decodedId = decodeURIComponent(id);

    if (!status) {
        return res.status(400).json({ success: false, message: 'Status field is required.' });
    }

    const validStatuses = ['New', 'In Progress', 'Pending', 'Resolved', 'Closed'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid ticket status provided.' });
    }

    try {
        const currentTicket = await fetchTicketByIdOrCode(decodedId);
        if (!currentTicket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const isStopping = status === 'Pending' || status === 'Resolved' || status === 'Closed';
        const isResolving = status === 'Resolved';
        const notesToSave = resolution_notes || currentTicket.resolution_notes || null;

        if (isStopping && !currentTicket.is_paused) {
            await db.query(
                `UPDATE tickets 
                 SET status = ?,
                     time_spent = COALESCE(time_spent, 0) + CASE 
                         WHEN timer_started_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, timer_started_at, CURRENT_TIMESTAMP)
                         ELSE 0 
                     END,
                     timer_started_at = NULL,
                     is_paused = 1,
                     paused_at = CURRENT_TIMESTAMP,
                     resolution_notes = ?,
                     resolved_at = IF(? = 1 AND resolved_at IS NULL, CURRENT_TIMESTAMP, resolved_at),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE ticket_id = ? OR ticket_code = ?`,
                [status, notesToSave, isResolving ? 1 : 0, decodedId, decodedId]
            );
        } else if (!isStopping && currentTicket.is_paused) {
            await db.query(
                `UPDATE tickets 
                 SET status = ?,
                     total_paused_seconds = COALESCE(total_paused_seconds, 0) + TIMESTAMPDIFF(SECOND, COALESCE(paused_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP),
                     timer_started_at = CURRENT_TIMESTAMP,
                     is_paused = 0,
                     paused_at = NULL,
                     resolution_notes = ?,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE ticket_id = ? OR ticket_code = ?`,
                [status, notesToSave, decodedId, decodedId]
            );
        } else {
            await db.query(
                `UPDATE tickets 
                 SET status = ?, 
                     resolution_notes = ?,
                     resolved_at = IF(? = 1 AND resolved_at IS NULL, CURRENT_TIMESTAMP, resolved_at),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE ticket_id = ? OR ticket_code = ?`,
                [status, notesToSave, isResolving ? 1 : 0, decodedId, decodedId]
            );
        }

        const updatedTicket = await fetchTicketByIdOrCode(decodedId);

        if (status === 'Resolved') {
            sendUserResolutionNotification(updatedTicket);
        }

        res.json({ 
            success: true, 
            message: `Ticket status successfully updated to "${status}"`, 
            data: updatedTicket 
        });
    } catch (err) {
        console.error('Error updating ticket status:', err);
        res.status(500).json({ success: false, message: 'Failed to update ticket status' });
    }
});

/**
 * PATCH /api/tickets/:id/assign
 * Endpoint to Assign or Elevate a ticket to IT Staff or Consultants
 */
router.patch('/:id/assign', async (req, res) => {
    const { id } = req.params;
    const { assigned_to, is_elevated = false, elevation_notes = '' } = req.body;
    const decodedId = decodeURIComponent(id);

    try {
        const [result] = await db.query(
            `UPDATE tickets 
             SET assigned_to = ?, 
                 is_elevated = ?, 
                 elevation_notes = ?,
                 status = IF(status = 'New', 'In Progress', status),
                 updated_at = CURRENT_TIMESTAMP 
             WHERE ticket_id = ? OR ticket_code = ?`,
            [assigned_to || null, is_elevated ? 1 : 0, elevation_notes || null, decodedId, decodedId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const updatedTicket = await fetchTicketByIdOrCode(decodedId);

        // Fetch assignee details for notification
        let assigneeName = 'IT Support Team';
        if (assigned_to) {
            const [uRows] = await db.query('SELECT name, role FROM users WHERE user_id = ?', [assigned_to]);
            if (uRows.length > 0) {
                assigneeName = uRows[0].name;
            }
        }

        sendAssignmentNotification(updatedTicket, assigneeName, elevation_notes, is_elevated);

        res.json({
            success: true,
            message: is_elevated ? 'Ticket successfully elevated to Consultant!' : 'Ticket assignment successfully updated!',
            data: updatedTicket
        });
    } catch (err) {
        console.error('Error updating ticket assignment:', err);
        res.status(500).json({ success: false, message: 'Failed to assign or elevate ticket' });
    }
});

/**
 * PATCH /api/tickets/:id
 */
router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const decodedId = decodeURIComponent(id);
    const { subject, description, category, priority, status, assigned_to, resolution_notes, is_elevated, elevation_notes } = req.body;

    try {
        const updates = [];
        const queryParams = [];

        if (subject !== undefined) { updates.push('subject = ?'); queryParams.push(subject); }
        if (description !== undefined) { updates.push('description = ?'); queryParams.push(description); }
        if (category !== undefined) { updates.push('category = ?'); queryParams.push(category); }
        if (priority !== undefined) { updates.push('priority = ?'); queryParams.push(priority); }
        if (status !== undefined) { updates.push('status = ?'); queryParams.push(status); }
        if (assigned_to !== undefined) { updates.push('assigned_to = ?'); queryParams.push(assigned_to || null); }
        if (resolution_notes !== undefined) { updates.push('resolution_notes = ?'); queryParams.push(resolution_notes); }
        if (is_elevated !== undefined) { updates.push('is_elevated = ?'); queryParams.push(is_elevated ? 1 : 0); }
        if (elevation_notes !== undefined) { updates.push('elevation_notes = ?'); queryParams.push(elevation_notes); }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields provided to update.' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        queryParams.push(decodedId, decodedId);

        const sql = `UPDATE tickets SET ${updates.join(', ')} WHERE ticket_id = ? OR ticket_code = ?`;
        const [result] = await db.query(sql, queryParams);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const updatedTicket = await fetchTicketByIdOrCode(decodedId);
        res.json({
            success: true,
            message: 'Ticket details successfully updated',
            data: updatedTicket
        });
    } catch (err) {
        console.error('Error updating ticket details:', err);
        res.status(500).json({ success: false, message: 'Failed to update ticket details' });
    }
});

/**
 * DELETE /api/tickets/:id
 */
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const decodedId = decodeURIComponent(id);

    try {
        const [result] = await db.query(
            `DELETE FROM tickets WHERE ticket_id = ? OR ticket_code = ?`,
            [decodedId, decodedId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        res.json({ success: true, message: 'Ticket deleted successfully' });
    } catch (err) {
        console.error('Error deleting ticket:', err);
        res.status(500).json({ success: false, message: 'Failed to delete ticket' });
    }
});

module.exports = router;