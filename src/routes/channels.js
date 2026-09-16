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
      module: 'ChannelManager',
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

// GET /api/channels – list channels
router.get('/', authenticateToken, requirePermission('channel_manager.view'), async (req, res) => {
  try {
    const { isActive, search, page = 1, limit = 50 } = req.query;
    const where = {};
    if (isActive !== undefined) where.isActive = isActive === 'true' || isActive === true;
    if (search) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { code: { contains: term, mode: 'insensitive' } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [channels, total] = await Promise.all([
      prisma.channel.findMany({ where, skip, take: Number(limit), orderBy: [{ name: 'asc' }] }),
      prisma.channel.count({ where }),
    ]);
    res.json({ data: channels, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /channels] error:', err);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// POST /api/channels – create a channel configuration
router.post('/', authenticateToken, requirePermission('channel_manager.manage'), async (req, res) => {
  try {
    const { name, code, isActive, apiEndpoint, credentialRef } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!code || !code.trim()) return res.status(400).json({ error: 'code is required' });
    const trimmedCode = code.trim().toUpperCase();

    const existing = await prisma.channel.findUnique({ where: { code: trimmedCode } });
    if (existing) return res.status(409).json({ error: 'Channel code must be unique' });

    const created = await prisma.channel.create({
      data: {
        name: name.trim(),
        code: trimmedCode,
        isActive: isActive !== undefined ? isActive : true,
        apiEndpoint,
        credentialRef,
      },
    });
    await logAudit(req.user.id, 'CREATE', 'Channel', created.id, `Created channel config ${created.code}`, null, created, req);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Channel code must be unique' });
    console.error('[POST /channels] error:', err);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// PUT /api/channels/:id – update a channel configuration
router.put('/:id', authenticateToken, requirePermission('channel_manager.manage'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, code, isActive, apiEndpoint, credentialRef } = req.body;
    const existing = await prisma.channel.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Channel not found' });

    if (code) {
      const trimmedCode = code.trim().toUpperCase();
      const conflict = await prisma.channel.findFirst({ where: { code: trimmedCode, NOT: { id } } });
      if (conflict) return res.status(409).json({ error: 'Channel code must be unique' });
    }

    const updated = await prisma.channel.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(code !== undefined && { code: code.trim().toUpperCase() }),
        ...(isActive !== undefined && { isActive }),
        ...(apiEndpoint !== undefined && { apiEndpoint }),
        ...(credentialRef !== undefined && { credentialRef }),
      },
    });
    await logAudit(req.user.id, 'UPDATE', 'Channel', updated.id, `Updated channel config ${updated.code}`, existing, updated, req);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /channels/:id] error:', err);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// GET /api/channels/:id/availability?roomTypeId=&from=&to=
router.get('/:id/availability', authenticateToken, requirePermission('channel_manager.view'), async (req, res) => {
  try {
    const channelId = Number(req.params.id);
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const { roomTypeId, from, to } = req.query;
    const where = { channelId };
    if (roomTypeId) where.roomTypeId = Number(roomTypeId);
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    const [rows, total] = await Promise.all([
      prisma.channelRateAvailability.findMany({
        where,
        orderBy: [{ date: 'asc' }],
        include: { channel: true, roomType: true },
      }),
      prisma.channelRateAvailability.count({ where }),
    ]);
    res.json({ data: rows, total, page: 1, limit: rows.length });
  } catch (err) {
    console.error('[GET /channels/:id/availability] error:', err);
    res.status(500).json({ error: 'Failed to fetch channel availability' });
  }
});

// POST /api/channels/:id/sync – manual trigger
// NOTE: Real OTA/provider calls are intentionally NOT wired yet. Confirm the
// channel-manager provider and API credentials with the team before enqueueing
// outbound requests. This endpoint records the sync attempt for visibility.
router.post('/:id/sync', authenticateToken, requirePermission('channel_manager.manage'), async (req, res) => {
  try {
    const channelId = Number(req.params.id);
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.isActive) return res.status(409).json({ error: 'Cannot sync an inactive channel' });

    const { direction = 'push' } = req.body || {};
    if (!['push', 'pull'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });

    const log = await prisma.channelSyncLog.create({
      data: {
        channelId,
        direction,
        status: 'pending',
        message: `Manual ${direction} sync triggered. Awaiting provider integration confirmation before external calls are made.`,
      },
    });
    await logAudit(req.user.id, 'SYNC_TRIGGER', 'Channel', channelId, `Manual ${direction} sync triggered (log #${log.id})`, null, log, req);
    res.status(201).json(log);
  } catch (err) {
    console.error('[POST /channels/:id/sync] error:', err);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

// GET /api/channels/:id/sync-logs
router.get('/:id/sync-logs', authenticateToken, requirePermission('channel_manager.view'), async (req, res) => {
  try {
    const channelId = Number(req.params.id);
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const { status, page = 1, limit = 50 } = req.query;
    const where = { channelId };
    if (status) where.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      prisma.channelSyncLog.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { startedAt: 'desc' },
      }),
      prisma.channelSyncLog.count({ where }),
    ]);
    res.json({ data: logs, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[GET /channels/:id/sync-logs] error:', err);
    res.status(500).json({ error: 'Failed to fetch sync logs' });
  }
});

module.exports = router;
