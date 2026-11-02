const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

// Import database connection
const db = require('../db'); 

// Temporary in-memory store for reset codes
const passwordResetStore = new Map();

// Configure Nodemailer transporter dynamically from environment variables.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: process.env.SMTP_PORT == 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Database connectivity sanity check
db.query('SELECT 1')
  .then(() => console.log('[DB TEST SUCCESS]: MySQL connection is active.'))
  .catch(err => console.error('[DB TEST FAILED]: Could not connect to MySQL:', err.message));

// --- 1. REQUEST FORGOT PASSWORD CODE ---
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' });
    }

    console.log(`[AUTH] Forgot password requested for: ${email}`);

    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);

    if (!results || results.length === 0) {
      return res.status(404).json({ message: 'No account found with this corporate email.' });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000;

    passwordResetStore.set(email, { code: resetCode, expires: expiresAt });

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"Berger IT Help Desk" <no-reply@berger.com>',
        to: email,
        subject: 'Password Reset Verification Code - Berger IT Help Desk',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 25px; background-color: #f9f9f9; border-radius: 8px; color: #333;">
            <h2 style="color: #004080; margin-top: 0;">Berger IT Help Desk</h2>
            <p>Hello,</p>
            <p>We received a request to reset your password. Use the verification code below to proceed:</p>
            <div style="background: #ffffff; border: 1px solid #ddd; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #004080; margin: 20px 0; border-radius: 6px;">
              ${resetCode}
            </div>
            <p>This code will expire in <strong>15 minutes</strong>.</p>
            <p style="font-size: 12px; color: #777; margin-top: 30px;">If you did not request a password reset, please ignore this email or contact system administration.</p>
          </div>
        `,
      });
      console.log(`[EMAIL SUCCESS] Reset code emailed successfully to ${email}`);
    } catch (mailError) {
      console.error('[EMAIL WARNING] Could not send live email. Check SMTP settings. Fallback code logged below:');
      console.log(`========================================`);
      console.log(`[DEV FALLBACK] RESET CODE FOR ${email}: ${resetCode}`);
      console.log(`========================================`);
    }

    return res.status(200).json({ message: 'Reset code sent successfully to your corporate email.' });
  } catch (error) {
    console.error('Server error in /forgot-password:', error);
    return res.status(500).json({ message: 'Database error occurred: ' + error.message });
  }
});

// --- 2. VERIFY RESET CODE ---
router.post('/verify-reset-code', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ message: 'Email and verification code are required.' });
    }
  
    const record = passwordResetStore.get(email);
    if (!record) {
      return res.status(400).json({ message: 'No active reset request found. Please request a new code.' });
    }

    if (Date.now() > record.expires) {
      passwordResetStore.delete(email);
      return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
    }

    if (String(record.code) !== String(code)) {
      return res.status(400).json({ message: 'Invalid verification code.' });
    }

    return res.status(200).json({ message: 'Code verified successfully.' });
  } catch (error) {
    console.error('Server error in /verify-reset-code:', error);
    return res.status(500).json({ message: 'Server error verifying code.' });
  }
});

// --- 3. RESET PASSWORD ---
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    const record = passwordResetStore.get(email);
    if (!record || String(record.code) !== String(code) || Date.now() > record.expires) {
      return res.status(400).json({ message: 'Session invalid or expired. Please start over.' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await db.query('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, email]);

    passwordResetStore.delete(email);

    return res.status(200).json({ message: 'Password updated successfully.' });

  } catch (error) {
    console.error('Server error in /reset-password:', error);
    return res.status(500).json({ message: 'Database error updating password: ' + error.message });
  }
});

// Export both the express router AND the transporter for auth_3.js reuse
module.exports = router;
module.exports.transporter = transporter;