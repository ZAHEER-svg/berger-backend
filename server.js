require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const app = express();

// ==========================================
// 1. CORE MIDDLEWARE & SECURITY SETUP
// ==========================================

// Explicit CORS configuration to allow authorization headers and credentials
app.use(cors({
  origin: true, // Echoes request origin to allow localhost:3000, 5173, etc.
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

// Basic Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Body Parsing Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static Uploads Directory (For attachments and assets)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Global JWT Extractor Middleware
// Decodes Bearer token from headers and populates req.user before routes execute
app.use((req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(
        token, 
        process.env.JWT_SECRET || 'berger_paints_secure_jwt_secret_key_2026_9x8q!'
      );
      req.user = decoded;
    } catch (err) {
      console.warn(`[GLOBAL AUTH] Token decoding failed on ${req.method} ${req.url}: ${err.message}`);
    }
  }
  next();
});

// ==========================================
// 2. ROUTE IMPORTS
// ==========================================
const ticketRoutes = require('./routes/tickets');
const assetRoutes = require('./routes/assets');
const dashboardRoutes = require('./routes/dashboard');
const kbRoutes = require('./routes/kb');
const userRoutes = require('./routes/users');
const settingRoutes = require('./routes/settings');
const authRoutes = require('./routes/auth');
const forgotPasswordRoutes = require('./routes/forgotp');

// ==========================================
// 3. HEALTH CHECK ROUTE
// ==========================================
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Berger Paints IT Help Desk API is online',
    timestamp: new Date()
  });
});

// ==========================================
// 4. API ROUTE MOUNTS
// ==========================================
app.use('/api/tickets', ticketRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Mounted on both /api/kb and /api/knowledge-base for React frontend compatibility
app.use('/api/kb', kbRoutes);
app.use('/api/knowledge-base', kbRoutes);

app.use('/api/users', userRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', forgotPasswordRoutes);

// ==========================================
// 5. ERROR HANDLING MIDDLEWARE
// ==========================================

// Handle 404 for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl} - Endpoint not found` });
});

// Global 500 server error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack || err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred on the server'
  });
});

// ==========================================
// 6. SERVER INITIALIZATION & DB CHECK
// ==========================================
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, async () => {
  console.log(`🚀 Berger IT Help Desk server running on port ${PORT}`);

  try {
    if (db.getConnection) {
      const conn = await db.getConnection();
      console.log('✅ Connected to Database: berger_helpdesk');
      conn.release();
    } else if (db.query) {
      console.log('✅ Database module loaded successfully');
    }
  } catch (err) {
    console.error('❌ Database connection error on startup:', err.message);
  }
});

// Single-execution flag to prevent repeated logs on fast double Ctrl+C
let isShuttingDown = false;

const handleShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received. Closing HTTP server and database connections...`);

  server.close(async () => {
    console.log('HTTP server closed.');

    if (db.end) {
      try {
        await db.end();
        console.log('Database connection pool closed.');
      } catch (err) {
        console.error('Error closing database pool:', err.message);
      }
    }

    process.exit(0);
  });

  // Force exit if connections take too long to drain
  setTimeout(() => {
    console.warn('Forced shutdown timeout reached. Terminating process...');
    process.exit(1);
  }, 3000);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));