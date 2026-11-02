const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db'); // MySQL2 promise pool connection
const { transporter } = require('./forgotp'); // Import transporter for verification emails

// ==========================================
// CENTRALIZED DIAGNOSTIC LOGGER HELPER
// ==========================================
const log = (level, context, message, meta = {}) => {
    const timestamp = new Date().toISOString();
    const metaString = Object.keys(meta).length ? ` | Meta: ${JSON.stringify(meta)}` : '';
    console[level === 'ERROR' ? 'error' : (level === 'WARN' ? 'warn' : 'log')](
        `[${timestamp}] [AUTH-ROUTE:${level}] [${context}] ${message}${metaString}`
    );
};

// Helper function to normalize profile picture Base64 / URI / Server File Path
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

// Helper function to insert audit logs
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

// Helper function to register user session
const recordUserSession = async (userId, req) => {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const userAgent = req.headers['user-agent'] || 'Unknown Browser';
        
        const device = userAgent.includes('Mobile') ? 'Mobile Device' : 'Desktop Workstation';
        const browser = userAgent.includes('Chrome') ? 'Chrome' 
                      : userAgent.includes('Firefox') ? 'Firefox' 
                      : userAgent.includes('Safari') ? 'Safari' 
                      : 'Web Browser';

        await db.query('UPDATE user_sessions SET is_current = 0 WHERE user_id = ?', [userId]);

        const [result] = await db.query(
            `INSERT INTO user_sessions (user_id, device_info, browser_info, ip_address, is_current, last_active) 
             VALUES (?, ?, ?, ?, 1, NOW())`,
            [userId, device, browser, String(ip).split(',')[0].trim()]
        );
        return result.insertId;
    } catch (err) {
        log('ERROR', 'RECORD_SESSION', `Failed to create session record for userId ${userId}: ${err.message}`);
        return null;
    }
};

// ==========================================
// 0. CHECK EMAIL ROLE ENDPOINT (Real-time Login Badge)
// ==========================================
router.get('/check-email-role', async (req, res) => {
    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email query parameter required' });
    }
    try {
        const cleanEmail = String(email).trim().toLowerCase();
        const [users] = await db.query('SELECT role, department FROM users WHERE LOWER(email) = ?', [cleanEmail]);
        if (users.length > 0) {
            return res.json({ 
                success: true, 
                role: users[0].role || 'Employee', 
                department: users[0].department 
            });
        }
        return res.json({ success: true, role: null });
    } catch (err) {
        log('ERROR', 'CHECK_ROLE', `Database error checking role: ${err.message}`);
        return res.status(500).json({ success: false, message: 'Database error checking role' });
    }
});

// ==========================================
// 1. USER SIGNUP / REGISTRATION (HANDLES PENDING RE-ATTEMPTS CLEANLY)
// ==========================================
router.post('/signup', async (req, res) => {
    const { name, email, password, department } = req.body;
    log('INFO', 'SIGNUP', `Signup request received for email: ${email}`);

    if (!name || !email || !password) {
        log('WARN', 'SIGNUP', 'Missing required registration fields');
        return res.status(400).json({ success: false, message: 'Name, email, and password are required fields.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const isItStaff = cleanEmail.includes('it') || cleanEmail.includes('admin') || cleanEmail === 'lawalzoheer1@gmail.com';
    const role = isItStaff ? 'IT Engineer' : 'Employee';

    // Handle department resolution cleanly
    const cleanedDepartment = (department && typeof department === 'string') ? department.trim() : '';
    const userDepartment = cleanedDepartment || (isItStaff ? 'IT Department' : 'General Management');

    try {
        // Check if user account already exists in DB
        const [existingUsers] = await db.query('SELECT user_id, status FROM users WHERE LOWER(email) = ?', [cleanEmail]);

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Generate 6-digit verification code & set 15-minute expiration
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        let userId;

        if (existingUsers.length > 0) {
            const existingUser = existingUsers[0];

            // If account is already active, block registration
            if (existingUser.status === 'Active') {
                log('WARN', 'SIGNUP', `Duplicate registration attempt for active email: ${cleanEmail}`);
                return res.status(400).json({ success: false, message: 'Email address is already registered. Please sign in.' });
            }

            // If account is still 'Pending', overwrite details and send a new verification code
            userId = existingUser.user_id;
            await db.query(
                `UPDATE users 
                 SET name = ?, password = ?, role = ?, department = ?, verification_code = ?, verification_expires = ? 
                 WHERE user_id = ?`,
                [name, hashedPassword, role, userDepartment, verificationCode, expiresAt, userId]
            );
            log('INFO', 'SIGNUP', `Updated pending registration for User ID: ${userId}`);
        } else {
            // Fresh account registration
            const [result] = await db.query(
                `INSERT INTO users (name, email, password, role, department, status, verification_code, verification_expires, created_at) 
                 VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, NOW())`,
                [name, cleanEmail, hashedPassword, role, userDepartment, verificationCode, expiresAt]
            );
            userId = result.insertId;
            log('INFO', 'SIGNUP', `User registered (Pending Verification) with ID: ${userId}`);
        }

        // Send verification email with robust console fallback
        try {
            await transporter.sendMail({
                from: process.env.EMAIL_FROM || '"Berger IT Help Desk" <no-reply@berger.com>',
                to: cleanEmail,
                subject: 'Verify Your Account - Berger IT Help Desk',
                html: `
                  <div style="font-family: Arial, sans-serif; padding: 25px; background-color: #f9f9f9; border-radius: 8px; color: #333;">
                    <h2 style="color: #004080; margin-top: 0;">Welcome to Berger IT Help Desk</h2>
                    <p>Hello ${name},</p>
                    <p>Please enter the verification code below to activate your corporate account:</p>
                    <div style="background: #ffffff; border: 1px solid #ddd; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #004080; margin: 20px 0; border-radius: 6px;">
                      ${verificationCode}
                    </div>
                    <p>This code will expire in <strong>15 minutes</strong>.</p>
                  </div>
                `,
            });
            log('INFO', 'SIGNUP_MAIL', `Verification email dispatched to ${cleanEmail}`);
        } catch (mailErr) {
            log('ERROR', 'SIGNUP_MAIL', `Failed to send email: ${mailErr.message}`);
            
            // GUARANTEED CONSOLE FALLBACK
            console.log(`\n====================================================`);
            console.log(`🔑 [DEV FALLBACK] Verification Code for ${cleanEmail}: ${verificationCode}`);
            console.log(`====================================================\n`);
        }

        res.status(201).json({ 
            success: true, 
            message: 'A 6-digit verification code has been sent to your email.'
        });
    } catch (err) {
        log('ERROR', 'SIGNUP', `Server error during signup: ${err.message}`, { stack: err.stack });
        res.status(500).json({ success: false, message: 'Server Error during registration' });
    }
});

// ==========================================
// 2. SIGNUP EMAIL VERIFICATION (/verify-signup-code)
// ==========================================
router.post('/verify-signup-code', async (req, res) => {
    const { email, code } = req.body;
    log('INFO', 'VERIFY_SIGNUP', `Verification attempt for email: ${email}`);

    if (!email || !code) {
        return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    try {
        const cleanEmail = String(email).trim().toLowerCase();
        const [rows] = await db.query(
            'SELECT * FROM users WHERE LOWER(email) = ? AND verification_code = ?', 
            [cleanEmail, String(code).trim()]
        );

        if (rows.length === 0) {
            log('WARN', 'VERIFY_SIGNUP', `Invalid verification code attempt for: ${cleanEmail}`);
            return res.status(400).json({ success: false, message: 'Invalid verification code.' });
        }

        const user = rows[0];
        const userId = user.user_id || user.id;

        // Check if code has expired
        if (new Date() > new Date(user.verification_expires)) {
            log('WARN', 'VERIFY_SIGNUP', `Expired verification code attempt for: ${cleanEmail}`);
            return res.status(400).json({ success: false, message: 'Verification code has expired. Please register again.' });
        }

        // Activate account & clear code
        await db.query(
            `UPDATE users SET status = 'Active', verification_code = NULL, verification_expires = NULL WHERE user_id = ?`,
            [userId]
        );

        await logAuditEvent(userId, `Account verified and activated for ${cleanEmail}`, 'Info');
        log('INFO', 'VERIFY_SIGNUP', `Account successfully activated for user ID ${userId}`);

        res.json({
            success: true,
            message: 'Account verified successfully! You can now sign in.'
        });
    } catch (err) {
        log('ERROR', 'VERIFY_SIGNUP', `Server error during verification: ${err.message}`, { stack: err.stack });
        res.status(500).json({ success: false, message: 'Server error during account verification.' });
    }
});

// ==========================================
// 3. RESEND VERIFICATION CODE (/resend-verification-code)
// ==========================================
router.post('/resend-verification-code', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    try {
        const cleanEmail = String(email).trim().toLowerCase();
        const [users] = await db.query('SELECT user_id, name, status FROM users WHERE LOWER(email) = ?', [cleanEmail]);

        if (users.length === 0 || users[0].status !== 'Pending') {
            return res.status(400).json({ success: false, message: 'No unverified account found for this email address.' });
        }

        const user = users[0];
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await db.query(
            'UPDATE users SET verification_code = ?, verification_expires = ? WHERE user_id = ?',
            [verificationCode, expiresAt, user.user_id]
        );

        try {
            await transporter.sendMail({
                from: process.env.EMAIL_FROM || '"Berger IT Help Desk" <no-reply@berger.com>',
                to: cleanEmail,
                subject: 'New Verification Code - Berger IT Help Desk',
                html: `
                  <div style="font-family: Arial, sans-serif; padding: 25px; background-color: #f9f9f9; border-radius: 8px;">
                    <h2 style="color: #004080;">Your New Verification Code</h2>
                    <p>Hello ${user.name},</p>
                    <div style="background: #ffffff; border: 1px solid #ddd; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #004080; margin: 20px 0; border-radius: 6px;">
                      ${verificationCode}
                    </div>
                    <p>Expires in 15 minutes.</p>
                  </div>
                `,
            });
        } catch (mailErr) {
            log('ERROR', 'RESEND_MAIL', `Failed to send email: ${mailErr.message}`);
            console.log(`\n====================================================`);
            console.log(`🔑 [DEV FALLBACK] Resent Code for ${cleanEmail}: ${verificationCode}`);
            console.log(`====================================================\n`);
        }

        res.json({ success: true, message: 'A new verification code has been generated.' });
    } catch (err) {
        log('ERROR', 'RESEND_CODE', `Error resending verification code: ${err.message}`);
        res.status(500).json({ success: false, message: 'Failed to resend verification code.' });
    }
});

// ==========================================
// 4. USER LOGIN
// ==========================================
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    log('INFO', 'LOGIN', `Login attempt for email: ${email}`);

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        const cleanEmail = String(email).trim().toLowerCase();
        const [rows] = await db.query('SELECT * FROM users WHERE LOWER(email) = ?', [cleanEmail]);

        if (rows.length === 0) {
            log('WARN', 'LOGIN', `Login failed: No user found for email ${cleanEmail}`);
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const user = rows[0];
        const userId = user.user_id || user.id;

        // 1. PASSWORD VERIFICATION
        let isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch && password === user.password) {
            log('INFO', 'LOGIN', `Upgrading legacy password hash for user ID ${userId}`);
            isMatch = true;
            const upgradedHash = await bcrypt.hash(password, 10);
            await db.query('UPDATE users SET password = ? WHERE user_id = ?', [upgradedHash, userId]);
        }

        if (!isMatch) {
            log('WARN', 'LOGIN', `Invalid password attempt for email: ${cleanEmail}`);
            await logAuditEvent(userId, `Failed login attempt for ${cleanEmail}`, 'Warning');
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // 2. LIVE ACCOUNT STATUS CHECK
        if (user.status === 'Pending') {
            return res.status(403).json({ 
                success: false, 
                message: 'Your account is not verified yet. Please complete verification.' 
            });
        }

        if (user.status && user.status !== 'Active') {
            log('WARN', 'LOGIN', `Blocked login for status '${user.status}' on User ID ${userId}`);
            await logAuditEvent(userId, `Blocked login attempt on ${user.status.toLowerCase()} account`, 'Warning');
            
            return res.status(403).json({ 
                success: false, 
                message: `Your account is currently ${user.status.toLowerCase()}. Access denied.` 
            });
        }

        const dbRoleLower = (user.role || '').toLowerCase();
        const isItStaff = dbRoleLower.includes('it') || dbRoleLower.includes('admin') || cleanEmail.includes('it');

        // 3. GENERATE SIGNED JWT TOKEN
        const token = jwt.sign(
            { 
                id: userId, 
                user_id: userId, 
                email: user.email, 
                role: user.role,
                status: user.status || 'Active'
            },
            process.env.JWT_SECRET || 'berger_paints_secure_jwt_secret_key_2026_9x8q!',
            { expiresIn: '24h' }
        );

        // 4. RECORD ACTIVE SESSION & AUDIT LOG
        await recordUserSession(userId, req);
        await logAuditEvent(userId, `User logged in successfully`, 'Info');

        log('INFO', 'LOGIN', `Login successful for user ID ${userId}`);

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: userId,
                name: user.name,
                email: user.email,
                role: isItStaff ? 'it' : 'user',
                dbRole: user.role,
                department: user.department,
                phone: user.phone || '',
                profile_picture: normalizeProfilePicture(user.profile_picture),
                status: user.status || 'Active'
            }
        });
    } catch (err) {
        log('ERROR', 'LOGIN', `Server error during login: ${err.message}`, { stack: err.stack });
        res.status(500).json({ success: false, message: 'Server Error during login' });
    }
});

// ==========================================
// 5. CURRENT USER VERIFICATION (/me)
// ==========================================
router.get('/me', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'No authorization token provided.' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(
            token, 
            process.env.JWT_SECRET || 'berger_paints_secure_jwt_secret_key_2026_9x8q!'
        );
        const userId = decoded.id || decoded.user_id;

        const [rows] = await db.query(
            'SELECT user_id AS id, name, email, role, department, phone, profile_picture, status, created_at FROM users WHERE user_id = ?', 
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User account not found.' });
        }

        const user = rows[0];

        if (user.status && user.status !== 'Active') {
            return res.status(403).json({ 
                success: false, 
                message: `Account is ${user.status.toLowerCase()}. Access denied.` 
            });
        }

        const dbRoleLower = (user.role || '').toLowerCase();
        const isItStaff = dbRoleLower.includes('it') || dbRoleLower.includes('admin');

        res.json({ 
            success: true, 
            user: {
                ...user,
                role: isItStaff ? 'it' : 'user',
                dbRole: user.role,
                profile_picture: normalizeProfilePicture(user.profile_picture)
            } 
        });
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
});

// ==========================================
// 6. LOGOUT ENDPOINT
// ==========================================
router.post('/logout', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(
                token, 
                process.env.JWT_SECRET || 'berger_paints_secure_jwt_secret_key_2026_9x8q!'
            );
            const userId = decoded.id || decoded.user_id;
            
            await db.query('UPDATE user_sessions SET is_current = 0 WHERE user_id = ?', [userId]);
            await logAuditEvent(userId, 'User logged out', 'Info');
        } catch (err) {
            // Token expired or invalid
        }
    }

    res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;