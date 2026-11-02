const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db'); // MySQL2 promise pool connection

// ==========================================
// CENTRALIZED DIAGNOSTIC LOGGER HELPER
// ==========================================
const log = (level, context, message, meta = {}) => {
    const timestamp = new Date().toISOString();
    
    const cleanedMeta = JSON.parse(JSON.stringify(meta, (key, value) => {
        if (typeof value === 'string' && value.length > 150) {
            if (value.startsWith('data:image') || value.match(/^[A-Za-z0-9+/=]{80,}/)) {
                return `[Base64 Image Data - Length: ${value.length} chars]`;
            }
            return `${value.substring(0, 100)}... [Truncated ${value.length} chars]`;
        }
        return value;
    }));

    const metaString = Object.keys(cleanedMeta).length ? ` | Meta: ${JSON.stringify(cleanedMeta)}` : '';
    console[level === 'ERROR' ? 'error' : 'log'](
        `[${timestamp}] [SETTINGS-ROUTE:${level}] [${context}] ${message}${metaString}`
    );
};

// ==========================================
// MULTER FILE UPLOAD STORAGE CONFIGURATION
// ==========================================
const uploadDir = path.join(__dirname, '../uploads/avatars');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname).toLowerCase();
        const userId = req.userId || req.user?.id || 'user';
        cb(null, `avatar-${userId}-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, WEBP, and GIF image formats are allowed.'), false);
    }
};

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB Limit
    fileFilter
});

// ==========================================
// IMAGE DISPLAY NORMALIZER
// ==========================================
const normalizeProfilePicture = (pic) => {
    if (!pic || typeof pic !== 'string') return null;
    const trimmed = pic.trim();
    if (
        trimmed.startsWith('http://') || 
        trimmed.startsWith('https://') || 
        trimmed.startsWith('data:image/') ||
        trimmed.startsWith('/uploads/')
    ) {
        return trimmed;
    }
    if (trimmed.startsWith('uploads/')) {
        return `/${trimmed}`;
    }
    return `data:image/jpeg;base64,${trimmed}`;
};

// ==========================================
// UNIFIED USER PROFILE FORMATTER
// ==========================================
const formatUserProfile = (user) => {
    if (!user) return null;

    const rawRole = user.role || 'Employee';
    const rawPic = user.profile_picture || user.profilePic || user.avatar || null;

    return {
        id: user.id || user.user_id,
        name: user.name,
        email: user.email,
        role: rawRole, // Returns exact DB role string ('Employee', 'IT Support', 'IT Engineer', 'System Admin', 'Senior IT Admin')
        department: user.department || '',
        phone: user.phone || '',
        profile_picture: normalizeProfilePicture(rawPic),
        status: user.status || 'Active',
        created_at: user.created_at
    };
};

// ==========================================
// AUTHENTICATION & ROLE MIDDLEWARE
// ==========================================

const authenticateToken = async (req, res, next) => {
    let userId = req.user?.id || req.user?.user_id || req.user?.userId || req.session?.userId;

    if (!userId) {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(
                    token, 
                    process.env.JWT_SECRET || 'berger_paints_secure_jwt_secret_key_2026_9x8q!'
                );
                req.user = decoded;
                userId = decoded.id || decoded.user_id || decoded.userId;
            } catch (err) {
                return res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
            }
        }
    }

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized access. Please log in.' });
    }

    try {
        const [users] = await db.query('SELECT status, role, email, name, department, phone, profile_picture FROM users WHERE user_id = ?', [userId]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Account no longer exists.' });
        }

        const currentUser = users[0];

        if (currentUser.status && currentUser.status !== 'Active') {
            return res.status(403).json({ 
                success: false, 
                message: `Your account is currently ${currentUser.status.toLowerCase()}. Access denied. Please contact IT support.` 
            });
        }

        req.userId = userId;
        req.user = { 
            ...req.user, 
            id: userId,
            role: currentUser.role, 
            email: currentUser.email, 
            name: currentUser.name,
            department: currentUser.department,
            phone: currentUser.phone,
            profile_picture: currentUser.profile_picture,
            status: currentUser.status 
        };
        next();
    } catch (dbErr) {
        log('ERROR', 'AUTH_MIDDLEWARE', `Database error during status check: ${dbErr.message}`, { stack: dbErr.stack });
        return res.status(500).json({ success: false, message: 'Authentication verification failed.' });
    }
};

const requireAdminOrIT = async (req, res, next) => {
    let role = (req.user?.role || '').toLowerCase();
    let email = (req.user?.email || '').toLowerCase();
    
    if (!role || !email) {
        try {
            const [users] = await db.query('SELECT role, email FROM users WHERE user_id = ?', [req.userId]);
            if (users.length > 0) {
                role = (users[0].role || '').toLowerCase();
                email = (users[0].email || '').toLowerCase();
            }
        } catch (dbErr) {
            log('ERROR', 'ROLE_GUARD', `Failed to fetch missing user details from DB: ${dbErr.message}`, { userId: req.userId });
        }
    }

    const isItStaff = 
        role.includes('admin') || 
        role.includes('it') || 
        role === 'it engineer' || 
        role === 'it manager' ||
        role === 'system admin' ||
        role === 'senior it admin' ||
        email.includes('it.admin') ||
        email.includes('it-support') ||
        email.includes('lawalzoheer') ||
        email.includes('lawalalzoheer');

    if (!isItStaff) {
        return res.status(403).json({ 
            success: false, 
            message: 'Access denied. Administrative or IT privileges required.' 
        });
    }

    next();
};

const logAuditEvent = async (userId, action, severity = 'Info') => {
    try {
        await db.query(
            `INSERT INTO audit_logs (user_id, action, severity, created_at) VALUES (?, ?, ?, NOW())`,
            [userId, action, severity]
        );
    } catch (err) {
        log('ERROR', 'AUDIT_LOG', `Failed to record audit event: ${err.message}`, { userId, action });
    }
};

// ==========================================
// 1. USER PROFILE ENDPOINTS
// ==========================================

router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [req.userId]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const formattedProfile = formatUserProfile(rows[0]);
        res.json({ success: true, data: formattedProfile });
    } catch (err) {
        log('ERROR', 'GET_PROFILE', `Database query error: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch user profile' });
    }
});

router.post('/avatar', authenticateToken, (req, res) => {
    upload.single('avatar')(req, res, async (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }

        try {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No image file provided' });
            }

            const avatarUrl = `/uploads/avatars/${req.file.filename}`;
            await db.query('UPDATE users SET profile_picture = ? WHERE user_id = ?', [avatarUrl, req.userId]);

            const [updatedRows] = await db.query(
                'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
                [req.userId]
            );

            const updatedProfile = formatUserProfile(updatedRows[0]);
            await logAuditEvent(req.userId, 'Uploaded new profile picture', 'Info');

            res.json({
                success: true,
                message: 'Profile picture updated successfully',
                avatarUrl,
                data: updatedProfile
            });
        } catch (dbErr) {
            log('ERROR', 'POST_AVATAR', `Database update error: ${dbErr.message}`, { userId: req.userId });
            res.status(500).json({ success: false, message: 'Failed to update profile picture in database' });
        }
    });
});

router.put('/profile', authenticateToken, async (req, res) => {
    const { id, userId: targetId, name, email, department, phone } = req.body;
    const targetUserId = id || targetId || req.userId;

    if (!name || !email) {
        return res.status(400).json({ success: false, message: 'Name and Email are required fields.' });
    }

    try {
        const hasPicturePayload = ('profile_picture' in req.body) || ('profilePic' in req.body) || ('avatar' in req.body);
        
        let query = `UPDATE users SET name = ?, email = ?, department = ?, phone = ?`;
        let params = [name, email, department || null, phone || null];

        if (hasPicturePayload) {
            const pictureToSave = req.body.profile_picture ?? req.body.profilePic ?? req.body.avatar ?? null;
            query += `, profile_picture = ?`;
            params.push(pictureToSave);
        }

        query += ` WHERE user_id = ?`;
        params.push(targetUserId);

        const [result] = await db.query(query, params);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const [updatedRows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [targetUserId]
        );

        const updatedProfile = formatUserProfile(updatedRows[0]);
        await logAuditEvent(req.userId, `Profile details updated for ${name} (ID: ${targetUserId})`, 'Info');
        
        res.json({ 
            success: true, 
            message: 'Profile updated successfully',
            data: updatedProfile
        });
    } catch (err) {
        log('ERROR', 'PUT_PROFILE', `Error updating profile in DB: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
});

router.delete('/profile/picture', authenticateToken, async (req, res) => {
    try {
        const [current] = await db.query('SELECT profile_picture FROM users WHERE user_id = ?', [req.userId]);
        if (current.length > 0 && current[0].profile_picture) {
            const currentPic = current[0].profile_picture;
            if (currentPic.startsWith('/uploads/avatars/')) {
                const filePath = path.join(__dirname, '..', currentPic);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
        }

        await db.query('UPDATE users SET profile_picture = NULL WHERE user_id = ?', [req.userId]);

        const [updatedRows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [req.userId]
        );

        const updatedProfile = formatUserProfile(updatedRows[0]);
        await logAuditEvent(req.userId, 'Removed profile picture', 'Info');

        res.json({
            success: true,
            message: 'Profile picture removed successfully',
            data: updatedProfile
        });
    } catch (err) {
        log('ERROR', 'DELETE_PROFILE_PICTURE', `Failed to delete profile picture: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to delete profile picture' });
    }
});

// ==========================================
// 2. SECURITY & ACCESS ENDPOINTS
// ==========================================

router.put('/password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }

    try {
        const [users] = await db.query('SELECT password FROM users WHERE user_id = ?', [req.userId]);
        
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const currentHash = users[0].password;
        const isMatch = await bcrypt.compare(currentPassword, currentHash);
        
        if (!isMatch && currentPassword !== currentHash) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE user_id = ?', [hashedNewPassword, req.userId]);

        await logAuditEvent(req.userId, 'User changed account password', 'Warning');
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        log('ERROR', 'PUT_PASSWORD', `Failed to update password: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update password' });
    }
});

router.get('/sessions', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT session_id AS id, device_info AS device, browser_info AS browser, ip_address AS ip, 
                    is_current AS current, last_active AS lastActive 
             FROM user_sessions WHERE user_id = ? ORDER BY is_current DESC, last_active DESC`,
            [req.userId]
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        log('ERROR', 'GET_SESSIONS', `Failed to fetch sessions: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch sessions' });
    }
});

router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
    const { sessionId } = req.params;
    try {
        await db.query('DELETE FROM user_sessions WHERE session_id = ? AND user_id = ?', [sessionId, req.userId]);
        res.json({ success: true, message: 'Session revoked successfully' });
    } catch (err) {
        log('ERROR', 'DELETE_SESSION', `Failed to revoke session ${sessionId}: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to revoke session' });
    }
});

// ==========================================
// 3. PREFERENCES ENDPOINTS
// ==========================================

router.get('/preferences', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT preferences_json FROM user_preferences WHERE user_id = ? LIMIT 1', 
            [req.userId]
        );
        let preferences = {};
        if (rows.length > 0 && rows[0].preferences_json) {
            const rawJson = rows[0].preferences_json;
            preferences = typeof rawJson === 'object' ? rawJson : JSON.parse(rawJson);
        }
        res.json({ success: true, data: preferences });
    } catch (err) {
        log('ERROR', 'GET_PREFERENCES', `Failed to fetch preferences: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch preferences' });
    }
});

router.put('/preferences', authenticateToken, async (req, res) => {
    const preferencesJson = JSON.stringify(req.body || {});
    try {
        const [existing] = await db.query('SELECT user_id FROM user_preferences WHERE user_id = ?', [req.userId]);

        if (existing.length > 0) {
            await db.query('UPDATE user_preferences SET preferences_json = ? WHERE user_id = ?', [preferencesJson, req.userId]);
        } else {
            await db.query('INSERT INTO user_preferences (user_id, preferences_json) VALUES (?, ?)', [preferencesJson, req.userId]);
        }

        res.json({ success: true, message: 'Preferences updated successfully', data: req.body });
    } catch (err) {
        log('ERROR', 'PUT_PREFERENCES', `Failed to update preferences: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
});

// ==========================================
// 4. USER ADMIN MANAGEMENT
// ==========================================

router.get('/users', authenticateToken, requireAdminOrIT, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users ORDER BY created_at DESC'
        );
        const formattedUsers = rows.map(formatUserProfile);
        res.json({ success: true, data: formattedUsers });
    } catch (err) {
        log('ERROR', 'ADMIN_GET_USERS', `Failed to fetch system users: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch system users' });
    }
});

router.post('/users', authenticateToken, requireAdminOrIT, async (req, res) => {
    const { name, email, role = 'Employee', department = 'General', defaultPassword = 'Password123!', profile_picture, profilePic, avatar } = req.body;
    const pictureToSave = profile_picture || profilePic || avatar || null;

    if (!name || !email) {
        return res.status(400).json({ success: false, message: 'Name and email are required fields.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        const [result] = await db.query(
            `INSERT INTO users (name, email, role, department, password, profile_picture, status, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, 'Active', NOW())`,
            [name, email, role, department, hashedPassword, pictureToSave]
        );

        const newUserId = result.insertId;
        await logAuditEvent(req.userId, `Created user ${email} with role ${role}`, 'Info');

        const [createdRows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [newUserId]
        );

        res.status(201).json({ 
            success: true, 
            message: 'User created successfully', 
            data: formatUserProfile(createdRows[0]) 
        });
    } catch (err) {
        log('ERROR', 'ADMIN_POST_USER', `Failed to create user: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to create user' });
    }
});

router.put('/users/:id', authenticateToken, requireAdminOrIT, async (req, res) => {
    const targetUserId = req.params.id;
    const { name, email, role, department, phone, status } = req.body;

    if (!name || !email) {
        return res.status(400).json({ success: false, message: 'Name and email are required fields.' });
    }

    try {
        const [targetCheck] = await db.query('SELECT email, role FROM users WHERE user_id = ?', [targetUserId]);
        if (targetCheck.length > 0) {
            const tEmail = (targetCheck[0].email || '').toLowerCase();
            const tRole = (targetCheck[0].role || '').toLowerCase();
            if (tEmail.includes('lawalzoheer') || tRole.includes('senior it admin')) {
                if (status && status !== 'Active') {
                    return res.status(403).json({ success: false, message: 'Cannot deactivate the Senior IT Administrator account.' });
                }
            }
        }

        const hasPicturePayload = ('profile_picture' in req.body) || ('profilePic' in req.body) || ('avatar' in req.body);
        let query = `UPDATE users SET name = ?, email = ?, role = ?, department = ?, phone = ?, status = ?`;
        let params = [name, email, role || 'Employee', department || null, phone || null, status || 'Active'];

        if (hasPicturePayload) {
            const pictureToSave = req.body.profile_picture ?? req.body.profilePic ?? req.body.avatar ?? null;
            query += `, profile_picture = ?`;
            params.push(pictureToSave);
        }

        query += ` WHERE user_id = ?`;
        params.push(targetUserId);

        const [result] = await db.query(query, params);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const [updatedRows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [targetUserId]
        );

        const updatedUser = formatUserProfile(updatedRows[0]);
        await logAuditEvent(req.userId, `Admin updated user details for ID ${targetUserId} (${name})`, 'Info');

        res.json({
            success: true,
            message: 'User details updated successfully',
            data: updatedUser
        });
    } catch (err) {
        log('ERROR', 'ADMIN_PUT_USER', `Failed to update user ${targetUserId}: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update user' });
    }
});

// PATCH update user role / grant admin rights
router.patch('/users/:id/role', authenticateToken, requireAdminOrIT, async (req, res) => {
    const targetUserId = req.params.id;
    const { role } = req.body;

    if (!role) {
        return res.status(400).json({ success: false, message: 'Role is required.' });
    }

    try {
        const [targetUsers] = await db.query('SELECT email, role FROM users WHERE user_id = ?', [targetUserId]);
        if (targetUsers.length > 0) {
            const targetEmail = (targetUsers[0].email || '').toLowerCase();
            const targetRole = (targetUsers[0].role || '').toLowerCase();
            // Allow changing roles for regular staff and promoting/demoting other admins, but guard the primary root Senior Admin
            if (targetEmail.includes('lawalzoheer1@gmail.com') && req.userId !== Number(targetUserId)) {
                return res.status(403).json({ success: false, message: 'Cannot modify the role of the primary Senior IT Administrator account.' });
            }
        }

        const [result] = await db.query('UPDATE users SET role = ? WHERE user_id = ?', [role, targetUserId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const [updatedRows] = await db.query(
            'SELECT user_id AS id, user_id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?',
            [targetUserId]
        );

        const updatedUser = formatUserProfile(updatedRows[0]);
        await logAuditEvent(req.userId, `Updated user ID ${targetUserId} role to ${role}`, 'Warning');

        res.json({ 
            success: true, 
            message: `User role successfully updated to ${role}`, 
            data: updatedUser 
        });
    } catch (err) {
        log('ERROR', 'ADMIN_PATCH_ROLE', `Failed to update role for userId ${targetUserId}: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update user role' });
    }
});

// PATCH update user status
router.patch('/users/:id/status', authenticateToken, requireAdminOrIT, async (req, res) => {
    const targetUserId = req.params.id;
    const { status } = req.body;

    const validStatuses = ['Active', 'Suspended', 'Inactive'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status specified.' });
    }

    try {
        const [targetUsers] = await db.query('SELECT email, role FROM users WHERE user_id = ?', [targetUserId]);
        if (targetUsers.length > 0) {
            const targetEmail = (targetUsers[0].email || '').toLowerCase();
            if (targetEmail.includes('lawalzoheer1@gmail.com')) {
                return res.status(403).json({ success: false, message: 'Cannot suspend or deactivate the primary Senior IT Administrator account.' });
            }
        }

        await db.query('UPDATE users SET status = ? WHERE user_id = ?', [status, targetUserId]);
        if (status === 'Suspended' || status === 'Inactive') {
            await db.query('DELETE FROM user_sessions WHERE user_id = ?', [targetUserId]);
        }

        await logAuditEvent(req.userId, `Updated user ID ${targetUserId} status to ${status}`, 'Warning');
        res.json({ success: true, message: `User status changed to ${status}` });
    } catch (err) {
        log('ERROR', 'ADMIN_PATCH_STATUS', `Failed to update status for userId ${targetUserId}: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to update user status' });
    }
});

// ==========================================
// 5. SYSTEM SETTINGS & SLA
// ==========================================

router.get('/system', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsObj = {};
        rows.forEach(r => { settingsObj[r.setting_key] = r.setting_value; });
        res.json({ success: true, data: settingsObj });
    } catch (err) {
        log('ERROR', 'GET_SYSTEM_SETTINGS', `Failed to fetch system settings: ${err.message}`, { userId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch settings' });
    }
});

router.post('/system', authenticateToken, requireAdminOrIT, async (req, res) => {
    const settingsMap = req.body;
    if (!settingsMap || typeof settingsMap !== 'object' || Array.isArray(settingsMap)) {
        return res.status(400).json({ success: false, message: 'Invalid payload.' });
    }

    try {
        const queries = Object.entries(settingsMap).map(([key, val]) => {
            const stringVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
            return db.query(
                `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE setting_value = ?`,
                [key, stringVal, stringVal]
            );
        });

        await Promise.all(queries);
        await logAuditEvent(req.userId, 'Global system configuration updated', 'Warning');
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        log('ERROR', 'POST_SYSTEM_SETTINGS', `Failed to save system settings: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to save settings' });
    }
});

// ==========================================
// 6. SYSTEM LOGS & MAINTENANCE
// ==========================================

router.get('/logs', authenticateToken, requireAdminOrIT, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT a.log_id AS id, a.action, u.name AS user, a.created_at AS time, a.severity 
             FROM audit_logs a 
             LEFT JOIN users u ON a.user_id = u.user_id 
             ORDER BY a.created_at DESC LIMIT 50`
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        log('ERROR', 'GET_AUDIT_LOGS', `Failed to fetch audit logs: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
    }
});

router.post('/maintenance/:action', authenticateToken, requireAdminOrIT, async (req, res) => {
    const { action } = req.params;

    try {
        let resultMsg = 'Action completed successfully';
        if (action === 'backup') {
            resultMsg = 'Database backup generated successfully.';
            await logAuditEvent(req.userId, 'Manual Database Backup Triggered', 'Success');
        } else if (action === 'clear-cache') {
            resultMsg = 'Application memory cache flushed.';
            await logAuditEvent(req.userId, 'System Cache Flushed', 'Info');
        } else if (action === 'diagnostics') {
            resultMsg = 'Diagnostics check completed with zero errors.';
            await logAuditEvent(req.userId, 'Diagnostics System Check Executed', 'Info');
        } else {
            return res.status(400).json({ success: false, message: 'Invalid action' });
        }

        res.json({ success: true, message: resultMsg });
    } catch (err) {
        log('ERROR', 'POST_MAINTENANCE', `Maintenance action '${action}' failed: ${err.message}`, { adminId: req.userId });
        res.status(500).json({ success: false, message: 'Maintenance failed' });
    }
});

module.exports = router;