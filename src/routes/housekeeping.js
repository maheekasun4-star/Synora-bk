const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = require('../prismaClient');
const { authenticateToken, requirePermission } = require('../middlewares/auth');

// Utility for audit logging (mirrors roomTypes.js, module-specific)
async function logAudit(userId, action, entityType, entityId, description, oldValues, newValues, req) {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      module: 'Housekeeping',
      entityType,
      entityId,
      description,
      oldValues,
      newValues,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    }
  });
}

const VALID_TASK_TYPES = ['checkout_clean', 'stayover_clean', 'turndown', 'deep_clean', 'inspection'];

// ---------- Staff ----------
// GET /api/housekeeping/staff – list staff (paginated, filter by active)
router.get('/staff', authenticateToken, requirePermission('housekeeping.view'), async (req, res) => {
  try {
    const { isActive, search, page = 1, limit = 50 } = req.query;
    const where = {};
    if (isActive !== undefined) where.isActive = isActive === 'true' || isActive === true;
    if (search) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [staff, total] = await Promise.all([
      prisma.housekeepingStaff.findMany({ where, skip, take: Number(limit), orderBy: [{ name: 'asc' }] }),
      prisma.housekeepingStaff.count({ where }),
    ]);
    res.json({ data: staff, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /housekeeping/staff] error:', err);
    res.status(500).json({ error: 'Failed to fetch housekeeping staff' });
  }
});

// POST /api/housekeeping/staff – create staff
router.post('/staff', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const { userId, name, phone, shift, isActive } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const existing = await prisma.housekeepingStaff.findFirst({ where: { name: name.trim() } });
    if (existing) return res.status(409).json({ error: 'Staff member with this name already exists' });

    const created = await prisma.housekeepingStaff.create({
      data: {
        userId: userId ? Number(userId) : null,
        name: name.trim(),
        phone,
        shift,
        isActive: isActive !== undefined ? isActive : true,
      },
    });
    await logAudit(req.user.id, 'CREATE', 'HousekeepingStaff', created.id, 'Created housekeeping staff', null, created, req);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Referenced user not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A staff member for this user already exists' });
    console.error('[POST /housekeeping/staff] error:', err);
    res.status(500).json({ error: 'Failed to create housekeeping staff' });
  }
});

// PUT /api/housekeeping/staff/:id – update staff
router.put('/staff/:id', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { userId, name, phone, shift, isActive } = req.body;
    const existing = await prisma.housekeepingStaff.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Housekeeping staff not found' });

    const updated = await prisma.housekeepingStaff.update({
      where: { id },
      data: {
        ...(userId !== undefined && { userId: userId ? Number(userId) : null }),
        ...(name !== undefined && { name: name.trim() }),
        ...(phone !== undefined && { phone }),
        ...(shift !== undefined && { shift }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    await logAudit(req.user.id, 'UPDATE', 'HousekeepingStaff', updated.id, 'Updated housekeeping staff', existing, updated, req);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /housekeeping/staff/:id] error:', err);
    res.status(500).json({ error: 'Failed to update housekeeping staff' });
  }
});

// ---------- Rooms / clean status board ----------
// GET /api/housekeeping/rooms/status – room grid with clean status
router.get('/rooms/status', authenticateToken, requirePermission('housekeeping.view'), async (req, res) => {
  try {
    const { floorId, cleanStatus } = req.query;
    const where = {};
    if (floorId) where.floorId = Number(floorId);
    if (cleanStatus) where.cleanStatus = cleanStatus;
    const [rooms, total] = await Promise.all([
      prisma.room.findMany({
        where,
        include: {
          floor: { select: { id: true, floorName: true } },
          roomType: { select: { id: true, typeName: true, code: true } },
        },
        orderBy: [{ floorId: 'asc' }, { roomNumber: 'asc' }],
      }),
      prisma.room.count({ where }),
    ]);
    res.json({ data: rooms, total, page: 1, limit: rooms.length });
  } catch (err) {
    console.error('[GET /housekeeping/rooms/status] error:', err);
    res.status(500).json({ error: 'Failed to fetch room clean status' });
  }
});

// ---------- Tasks ----------
// GET /api/housekeeping/tasks?date=&roomId=&staffId=&status=
router.get('/tasks', authenticateToken, requirePermission('housekeeping.view'), async (req, res) => {
  try {
    const { date, roomId, staffId, status, page = 1, limit = 50 } = req.query;
    const where = {};
    if (date) where.scheduledFor = new Date(date);
    if (roomId) where.roomId = Number(roomId);
    if (staffId) where.staffId = Number(staffId);
    if (status) where.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      prisma.housekeepingTask.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: [{ scheduledFor: 'desc' }, { id: 'asc' }],
        include: { room: { include: { roomType: true } }, staff: true, creator: true, checklist: true },
      }),
      prisma.housekeepingTask.count({ where }),
    ]);
    res.json({ data: tasks, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /housekeeping/tasks] error:', err);
    res.status(500).json({ error: 'Failed to fetch housekeeping tasks' });
  }
});

// POST /api/housekeeping/tasks – create a task manually
router.post('/tasks', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const { roomId, staffId, taskType, scheduledFor, notes, checklist } = req.body;
    if (!roomId || !taskType || !scheduledFor) {
      return res.status(400).json({ error: 'roomId, taskType and scheduledFor are required' });
    }
    if (!VALID_TASK_TYPES.includes(taskType)) {
      return res.status(400).json({ error: `Invalid taskType. Allowed: ${VALID_TASK_TYPES.join(', ')}` });
    }
    const room = await prisma.room.findUnique({ where: { id: Number(roomId) } });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const created = await prisma.housekeepingTask.create({ data: {
      roomId: Number(roomId),
      staffId: staffId ? Number(staffId) : null,
      taskType,
      scheduledFor: new Date(scheduledFor),
      notes,
      createdBy: req.user.id,
      ...(Array.isArray(checklist) && checklist.length > 0 && {
        checklist: {
          create: checklist.map((label) => ({ label: String(label) })),
        },
      }),
    }, include: { room: true, staff: true, creator: true, checklist: true } });
    await logAudit(req.user.id, 'CREATE', 'HousekeepingTask', created.id, `Created ${taskType} task for room ${room.roomNumber}`, null, created, req);
    res.status(201).json(created);
  } catch (err) {
    console.error('[POST /housekeeping/tasks] error:', err);
    res.status(500).json({ error: 'Failed to create housekeeping task' });
  }
});

// PATCH /api/housekeeping/tasks/:id/assign – assign to staff
router.patch('/tasks/:id/assign', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { staffId } = req.body;
    const existing = await prisma.housekeepingTask.findUnique({ where: { id }, include: { room: true } });
    if (!existing) return res.status(404).json({ error: 'Housekeeping task not found' });

    let staff = null;
    if (staffId) {
      staff = await prisma.housekeepingStaff.findUnique({ where: { id: Number(staffId) } });
      if (!staff) return res.status(404).json({ error: 'Housekeeping staff not found' });
    }

    const updated = await prisma.housekeepingTask.update({
      where: { id },
      data: {
        staffId: staffId ? Number(staffId) : null,
        status: staffId ? 'assigned' : 'pending',
      },
      include: { room: true, staff: true, creator: true, checklist: true },
    });
    await logAudit(req.user.id, 'ASSIGN', 'HousekeepingTask', updated.id, `Assigned task to staff ${staff ? staff.name : '(unassigned)'}`, existing, updated, req);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /housekeeping/tasks/:id/assign] error:', err);
    res.status(500).json({ error: 'Failed to assign housekeeping task' });
  }
});

// PATCH /api/housekeeping/tasks/:id/start – mark in progress
router.patch('/tasks/:id/start', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.housekeepingTask.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Housekeeping task not found' });
    if (existing.status === 'completed') return res.status(409).json({ error: 'Cannot start a completed task' });

    const updated = await prisma.housekeepingTask.update({
      where: { id },
      data: { status: 'in_progress', startedAt: new Date() },
    });
    await logAudit(req.user.id, 'START', 'HousekeepingTask', updated.id, `Task started (status=${updated.taskType})`, existing, updated, req);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /housekeeping/tasks/:id/start] error:', err);
    res.status(500).json({ error: 'Failed to start housekeeping task' });
  }
});

// PATCH /api/housekeeping/tasks/:id/complete – mark complete, update room clean status
router.patch('/tasks/:id/complete', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { isInspection = false } = req.body || {};
    const existing = await prisma.housekeepingTask.findUnique({ where: { id }, include: { room: true } });
    if (!existing) return res.status(404).json({ error: 'Housekeeping task not found' });
    if (existing.status === 'completed') return res.status(409).json({ error: 'Task already completed' });

    const updated = await prisma.$transaction(async (tx) => {
      // mark all checklist items as checked
      await tx.housekeepingChecklistItem.updateMany({
        where: { taskId: existing.id },
        data: { isChecked: true },
      });

      const task = await tx.housekeepingTask.update({
        where: { id: existing.id },
        data: { status: 'completed', completedAt: new Date() },
      });

      // Update room clean status. Inspection tasks mark the room inspected;
      // all other completed tasks mark it clean.
      if (existing.roomId) {
        if (existing.taskType === 'inspection' || isInspection) {
          await tx.room.update({ where: { id: existing.roomId }, data: { cleanStatus: 'inspected' } });
        } else {
          await tx.room.update({ where: { id: existing.roomId }, data: { cleanStatus: 'clean' } });
        }
      }
      return task;
    });

    await logAudit(req.user.id, 'COMPLETE', 'HousekeepingTask', updated.id, `Task completed; room ${existing.room?.roomNumber} clean status updated`, existing, updated, req);
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /housekeeping/tasks/:id/complete] error:', err);
    res.status(500).json({ error: 'Failed to complete housekeeping task' });
  }
});

// ---------- Attendance ----------
// GET /api/housekeeping/attendance?staffId=&date=
router.get('/attendance', authenticateToken, requirePermission('housekeeping.view'), async (req, res) => {
  try {
    const { staffId, date } = req.query;
    const where = {};
    if (staffId) where.staffId = Number(staffId);
    if (date) where.date = new Date(date);
    const records = await prisma.housekeepingAttendance.findMany({
      where,
      include: { staff: true },
      orderBy: [{ date: 'desc' }, { staff: { name: 'asc' } }],
    });
    res.json({ data: records, total: records.length, page: 1, limit: records.length });
  } catch (err) {
    console.error('[GET /housekeeping/attendance] error:', err);
    res.status(500).json({ error: 'Failed to fetch housekeeping attendance' });
  }
});

// POST /api/housekeeping/attendance/clock-in { staffId, date }
router.post('/attendance/clock-in', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const { staffId, date } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    const staff = await prisma.housekeepingStaff.findUnique({ where: { id: Number(staffId) } });
    if (!staff) return res.status(404).json({ error: 'Housekeeping staff not found' });

    const attendanceDate = date ? new Date(date) : new Date();
    const record = await prisma.housekeepingAttendance.upsert({
      where: { staffId_date: { staffId: Number(staffId), date: attendanceDate } },
      update: { clockIn: new Date(), clockOut: null },
      create: { staffId: Number(staffId), date: attendanceDate, clockIn: new Date() },
    });
    await logAudit(req.user.id, 'CLOCK_IN', 'HousekeepingAttendance', record.id, `Staff ${staff.name} clocked in`, null, record, req);
    res.json(record);
  } catch (err) {
    console.error('[POST /housekeeping/attendance/clock-in] error:', err);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// POST /api/housekeeping/attendance/clock-out { staffId, date }
router.post('/attendance/clock-out', authenticateToken, requirePermission('housekeeping.manage'), async (req, res) => {
  try {
    const { staffId, date } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    const staff = await prisma.housekeepingStaff.findUnique({ where: { id: Number(staffId) } });
    if (!staff) return res.status(404).json({ error: 'Housekeeping staff not found' });

    const attendanceDate = date ? new Date(date) : new Date();
    const existing = await prisma.housekeepingAttendance.findUnique({
      where: { staffId_date: { staffId: Number(staffId), date: attendanceDate } },
    });
    if (!existing || !existing.clockIn) return res.status(409).json({ error: 'No active clock-in found for this staff on this date' });

    const record = await prisma.housekeepingAttendance.update({
      where: { staffId_date: { staffId: Number(staffId), date: attendanceDate } },
      data: { clockOut: new Date() },
    });
    await logAudit(req.user.id, 'CLOCK_OUT', 'HousekeepingAttendance', record.id, `Staff ${staff.name} clocked out`, existing, record, req);
    res.json(record);
  } catch (err) {
    console.error('[POST /housekeeping/attendance/clock-out] error:', err);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

module.exports = router;
