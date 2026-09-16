require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const guestRoutes = require('./routes/guests');
const travelAgentRoutes = require('./routes/travelAgents');
const reservationRoutes = require('./routes/reservations');
const mealPlanRoutes = require('./routes/mealPlans');
const paymentRoutes = require('./routes/payments');
const invoiceRoutes = require('./routes/invoices');
const tapeChartRoutes = require('./routes/tapeChart');
const floorsRoutes = require('./routes/floors');
const nightAuditRoutes = require('./routes/nightAudit');
const refundRoutes = require('./routes/refunds');
const reportRoutes = require('./routes/reports');
const reservationLifecycleRoutes = require('./routes/reservationLifecycle.routes');
const groupReservationRoutes = require('./routes/groupReservations');
const userRoutes = require('./routes/users');
const roleRoutes = require('./routes/roles');
const permissionRoutes = require('./routes/permissions');
const auditLogRoutes = require('./routes/auditLogs');
const housekeepingRoutes = require('./routes/housekeeping');
const channelRoutes = require('./routes/channels');

const app = express();
//const PORT = process.env.PORT || 5000;
const PORT = process.env.PORT 
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Register routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/audit-logs', auditLogRoutes);
// Register Room routes
app.use('/api/rooms', roomRoutes);
// Register Room Type routes
const roomTypeRoutes = require('./routes/roomTypes');
app.use('/api/room-types', roomTypeRoutes);
app.use('/api/guests', guestRoutes);
app.use('/api/travel-agents', travelAgentRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/group-reservations', groupReservationRoutes);
app.use('/api/meal-plans', mealPlanRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/travel-agent-invoices', invoiceRoutes);
app.use('/api/tape-chart', tapeChartRoutes);
app.use('/api/floors', floorsRoutes);
app.use('/api/night-audit', nightAuditRoutes);
app.use('/api', refundRoutes);
app.use('/api/reports', reportRoutes);
// Housekeeping & Channel Manager
app.use('/api/housekeeping', housekeepingRoutes);
app.use('/api/channels', channelRoutes);
// Reservation lifecycle API (state-machine driven)
app.use('/api', reservationLifecycleRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`Hotel PMS API Server running on port ${PORT}`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    const altPort = 5001;
    console.warn(`Port ${PORT} in use, switching to ${altPort}`);
    app.listen(altPort, () => console.log(`Hotel PMS API Server running on fallback port ${altPort}`));
  } else {
    console.error('Server error:', err);
  }
});
