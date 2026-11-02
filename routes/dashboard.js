const express = require('express');
const router = express.Router();
const db = require('../db');

// GET overall dashboard summary statistics and system health status
router.get('/', async (req, res) => {
    try {
        // Query aggregated ticket counts and priorities
        const [ticketStats] = await db.query(`
            SELECT 
                COUNT(*) as total_tickets,
                SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) as new_tickets,
                SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_tickets,
                SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved_tickets,
                SUM(CASE WHEN priority = 'Critical' THEN 1 ELSE 0 END) as critical_tickets,
                SUM(CASE WHEN sla_status = 'Breached' THEN 1 ELSE 0 END) as breached_sla_count
            FROM tickets
        `);

        // Query total monitored assets
        const [assetStats] = await db.query(`SELECT COUNT(*) as total_assets FROM assets`);

        // Query live system health infrastructure nodes
        const [healthRows] = await db.query(`SELECT * FROM system_health`);

        res.json({
            success: true,
            data: {
                metrics: ticketStats[0],
                totalAssets: assetStats[0].total_assets,
                systemHealth: healthRows
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard metrics' });
    }
});

module.exports = router;