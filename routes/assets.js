const express = require('express');
const router = express.Router();
const db = require('../db');

// ==============================================================================
// 1. GET ALL ASSETS (Scoped by Role & User Email)
// ==============================================================================
router.get('/', async (req, res) => {
    const { email, role } = req.query;
    
    const isAdmin = role === 'admin' || (email && (
        email.toLowerCase().includes('it') || 
        email.toLowerCase().includes('admin')
    ));

    try {
        let query = `
            SELECT 
                a.asset_id,
                a.asset_tag,
                a.asset_name AS name,
                a.hostname,
                a.domain_name,
                a.type,
                a.os_version,
                a.status,
                a.location,
                a.ip_address,
                a.serial_number,
                a.ram_gb,
                a.cpu_model,
                a.hardware_status,
                a.assigned_date,
                a.issued_by,
                a.last_seen,
                a.is_functional,
                a.underlying_issues,
                a.assured_date,
                a.last_checked_date,
                a.last_fixed_date,
                u.name AS owner,
                u.email AS owner_email
            FROM assets a
            LEFT JOIN users u ON a.owner_id = u.user_id
        `;

        const queryParams = [];

        if (!isAdmin && email) {
            query += ` WHERE LOWER(u.email) = LOWER(?) OR a.owner_id IN (SELECT user_id FROM users WHERE LOWER(email) = LOWER(?))`;
            queryParams.push(email, email);
        }

        query += ` ORDER BY a.asset_id DESC`;

        const [rows] = await db.query(query, queryParams);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching assets:', err);
        res.status(500).json({ success: false, message: 'Server Error fetching assets.' });
    }
});

// ==============================================================================
// 2. MANUAL ADD / UPDATE ASSET (User Self-Reporting & IT Admin)
// ==============================================================================
router.post('/self-report', async (req, res) => {
    const { 
        asset_tag, 
        device_name, 
        type, 
        serial_number, 
        hostname,
        domain_name,
        os_version,
        ram_gb,
        cpu_model,
        location, 
        owner_email, 
        owner_name 
    } = req.body;

    if (!owner_email || !device_name) {
        return res.status(400).json({ success: false, message: 'Device name and owner email are required.' });
    }

    try {
        // 1. Find or create user
        let owner_id = null;
        const [users] = await db.query('SELECT user_id FROM users WHERE LOWER(email) = LOWER(?)', [owner_email]);
        
        if (users.length > 0) {
            owner_id = users[0].user_id;
        } else {
            const userName = owner_name || owner_email.split('@')[0].toUpperCase();
            const [newUser] = await db.query(
                'INSERT INTO users (name, email, role) VALUES (?, ?, "user")', 
                [userName, owner_email]
            );
            owner_id = newUser.insertId;
        }

        // 2. Generate Tag or use provided tag
        const tag = asset_tag || `BERGER-A-${Math.floor(1000 + Math.random() * 9000)}`;
        const userHostname = hostname || `${(owner_name || owner_email.split('@')[0]).toUpperCase()}-PC`;

        // 3. Check if user already registered an asset
        const [existing] = await db.query('SELECT asset_id FROM assets WHERE owner_id = ? LIMIT 1', [owner_id]);

        if (existing.length > 0) {
            await db.query(`
                UPDATE assets SET 
                    asset_tag = COALESCE(?, asset_tag),
                    asset_name = ?, 
                    type = COALESCE(?, 'Laptop'), 
                    serial_number = ?, 
                    hostname = ?,
                    domain_name = COALESCE(?, 'BERGERPAINTS.LOCAL'),
                    os_version = ?,
                    ram_gb = ?,
                    cpu_model = ?,
                    location = COALESCE(?, 'Head Office'), 
                    hardware_status = 'Pending Verification',
                    last_seen = CURRENT_TIMESTAMP 
                WHERE owner_id = ?
            `, [
                tag, 
                device_name, 
                type, 
                serial_number || null, 
                userHostname, 
                domain_name, 
                os_version || null,
                ram_gb || 16,
                cpu_model || null,
                location, 
                owner_id
            ]);
        } else {
            await db.query(`
                INSERT INTO assets (
                    asset_tag, asset_name, type, serial_number, hostname, 
                    domain_name, os_version, ram_gb, cpu_model, location, owner_id, status, hardware_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Use', 'Pending Verification')
            `, [
                tag, 
                device_name, 
                type || 'Laptop', 
                serial_number || null, 
                userHostname, 
                domain_name || 'BERGERPAINTS.LOCAL', 
                os_version || null, 
                ram_gb || 16,
                cpu_model || null,
                location || 'Head Office', 
                owner_id
            ]);
        }

        res.json({ success: true, message: 'Asset hardware details saved successfully.' });
    } catch (err) {
        console.error('Error saving self-reported asset:', err);
        res.status(500).json({ success: false, message: 'Failed to save asset details.' });
    }
});

// ==============================================================================
// 3. MANUAL ADD ASSET (IT Admin Direct Create)
// ==============================================================================
router.post('/', async (req, res) => {
    const { 
        asset_tag, 
        asset_name, 
        type, 
        status, 
        owner_id, 
        location, 
        hostname, 
        domain_name, 
        serial_number, 
        ram_gb, 
        cpu_model, 
        os_version 
    } = req.body;

    try {
        const tag = asset_tag || `BERGER-A-${Math.floor(1000 + Math.random() * 9000)}`;
        const [result] = await db.query(
            `INSERT INTO assets (
                asset_tag, asset_name, type, status, owner_id, location, 
                hostname, domain_name, serial_number, ram_gb, cpu_model, os_version, 
                hardware_status, assigned_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Verified Clean', CURRENT_TIMESTAMP)`,
            [
                tag, 
                asset_name, 
                type || 'Laptop', 
                status || 'In Use', 
                owner_id || null, 
                location || 'Head Office',
                hostname || null,
                domain_name || 'BERGERPAINTS.LOCAL',
                serial_number || null,
                ram_gb || 16,
                cpu_model || null,
                os_version || null
            ]
        );

        res.status(201).json({ success: true, message: 'Asset added successfully', assetId: result.insertId });
    } catch (err) {
        console.error('Error manually adding asset:', err);
        res.status(500).json({ success: false, message: 'Failed to add asset.' });
    }
});

// ==============================================================================
// 4. UPDATE ASSET HEALTH / VERIFY
// ==============================================================================
router.patch('/:id/health', async (req, res) => {
    const { id } = req.params;
    const { hardware_status } = req.body;
    try {
        await db.query(`UPDATE assets SET hardware_status = ? WHERE asset_id = ?`, [hardware_status || 'Verified Clean', id]);
        res.json({ success: true, message: 'Hardware status updated successfully.' });
    } catch (err) {
        console.error('Error updating hardware status:', err);
        res.status(500).json({ success: false, message: 'Failed to update hardware status.' });
    }
});

// ==============================================================================
// 5. UPDATE ADMIN MAINTENANCE & ISSUE LOG DETAILS (NEW)
// ==============================================================================
router.patch('/:id/admin-details', async (req, res) => {
    const { id } = req.params;
    const { 
        underlying_issues, 
        is_functional, 
        assured_date, 
        last_checked_date, 
        last_fixed_date 
    } = req.body;

    try {
        await db.query(`
            UPDATE assets SET 
                underlying_issues = ?,
                is_functional = ?,
                assured_date = ?,
                last_checked_date = ?,
                last_fixed_date = ?
            WHERE asset_id = ?
        `, [
            underlying_issues || null,
            is_functional !== undefined ? is_functional : true,
            assured_date || null,
            last_checked_date || null,
            last_fixed_date || null,
            id
        ]);

        res.json({ success: true, message: 'Admin maintenance & issue log updated successfully.' });
    } catch (err) {
        console.error('Error updating admin asset details:', err);
        res.status(500).json({ success: false, message: 'Failed to update admin asset details.' });
    }
});

// ==============================================================================
// 6. GET REPORTED ISSUES
// ==============================================================================
router.get('/issues', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT 
                i.issue_id,
                i.asset_id,
                i.issue_type,
                i.title,
                i.description,
                i.severity,
                i.status,
                i.detected_at,
                a.asset_tag,
                a.asset_name,
                a.hostname
            FROM asset_issues i
            JOIN assets a ON i.asset_id = a.asset_id
            ORDER BY i.detected_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching asset issues:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch asset issues.' });
    }
});

module.exports = router;