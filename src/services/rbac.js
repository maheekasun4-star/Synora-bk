const { PrismaClient } = require('@prisma/client');

const prisma = require('../prismaClient');

// Keep permission keys stable; they are also used by the frontend navigation.
const PERMISSIONS = [
  ['users.view', 'View users', 'users', 'view'],
  ['users.create', 'Create users', 'users', 'create'],
  ['users.update', 'Update users', 'users', 'update'],
  ['users.delete', 'Deactivate users', 'users', 'delete'],
  ['roles.view', 'View roles', 'roles', 'view'],
  ['roles.create', 'Create roles', 'roles', 'create'],
  ['roles.update', 'Update roles', 'roles', 'update'],
  ['roles.delete', 'Delete roles', 'roles', 'delete'],
  ['permissions.view', 'View permissions', 'permissions', 'view'],
  ['audit.view', 'View audit logs', 'audit', 'view'],
  ['reservations.view', 'View reservations', 'reservations', 'view'],
  ['reservations.create', 'Create reservations', 'reservations', 'create'],
  ['reservations.update', 'Update reservations', 'reservations', 'update'],
  ['reservations.cancel', 'Cancel reservations', 'reservations', 'cancel'],
  ['rooms.view', 'View rooms', 'rooms', 'view'],
  ['rooms.manage', 'Manage rooms', 'rooms', 'manage'],
  ['guests.view', 'View guests', 'guests', 'view'],
  ['guests.create', 'Create guests', 'guests', 'create'],
  ['payments.view', 'View payments', 'payments', 'view'],
  ['payments.create', 'Post payments', 'payments', 'create'],
  ['reports.view', 'View reports', 'reports', 'view'],
  ['reports.financial', 'View financial reports', 'reports', 'financial'],
  ['refund.view', 'View refunds', 'refund', 'view'],
  ['refund.create', 'Create refunds', 'refund', 'create'],
  ['refund.approve', 'Approve refunds', 'refund', 'approve'],
  ['refund.process', 'Process refunds', 'refund', 'process'],
  ['refund.cancel', 'Cancel refunds', 'refund', 'cancel'],
  ['night_audit.run', 'Run night audit', 'night_audit', 'run'],
  ['group_reservation.view', 'View group reservations', 'group_reservation', 'view'],
  ['group_reservation.create', 'Create group reservations', 'group_reservation', 'create'],
  ['group_reservation.edit', 'Edit group reservations', 'group_reservation', 'edit'],
  ['group_reservation.checkin', 'Check in group reservations', 'group_reservation', 'checkin'],
  ['group_reservation.checkout', 'Check out group reservations', 'group_reservation', 'checkout'],
  ['housekeeping.view', 'View housekeeping staff, tasks & room status', 'housekeeping', 'view'],
  ['housekeeping.manage', 'Manage housekeeping staff, tasks & assignments', 'housekeeping', 'manage'],
  ['channel_manager.view', 'View channel configurations & sync logs', 'channels', 'view'],
  ['channel_manager.manage', 'Manage channel configurations & trigger sync', 'channels', 'manage'],
];

const ROLE_DEFAULTS = {
  admin: PERMISSIONS.map(([key]) => key),
  front_office: [
    'reservations.view', 'reservations.create', 'reservations.update', 'reservations.cancel',
    'rooms.view', 'guests.view', 'guests.create', 'reports.view', 'refund.view', 'refund.create',
    'night_audit.run', 'group_reservation.view', 'group_reservation.create', 'group_reservation.edit', 'group_reservation.checkin', 'group_reservation.checkout',
    'housekeeping.view', 'housekeeping.manage', 'channel_manager.view',
  ],
  cashier: [
    'reservations.view', 'payments.view', 'payments.create', 'reports.view', 'refund.view', 'refund.process',
  ],
};

async function seedRbac() {
  const permissions = {};
  for (const [key, name, module, action] of PERMISSIONS) {
    permissions[key] = await prisma.permission.upsert({
      where: { key },
      update: { name, module, action },
      create: { key, name, module, action },
    });
  }

  for (const [name, permissionKeys] of Object.entries(ROLE_DEFAULTS)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { isSystem: true },
      create: { name, description: `${name.replace('_', ' ')} system role`, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissionKeys.map((key) => ({ roleId: role.id, permissionId: permissions[key].id })),
      skipDuplicates: true,
    });
    await prisma.user.updateMany({ where: { role: name }, data: { roleId: role.id } });
  }
  return { permissions, roles: Object.keys(ROLE_DEFAULTS) };
}

async function writeAudit(req, data) {
  if (!req.user?.id) return;
  try {
    await prisma.auditLog.create({
      data: {
        userId: Number(req.user.id),
        action: data.action,
        module: data.module,
        entityType: data.entityType || data.module,
        entityId: Number(data.entityId || 0),
        description: data.description,
        oldValues: data.oldValues,
        newValues: data.newValues,
        ipAddress: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 255),
      },
    });
  } catch (error) {
    // Auditing must not turn a successful business operation into a failure.
    console.error('Audit log error:', error.message);
  }
}

module.exports = { prisma, PERMISSIONS, ROLE_DEFAULTS, seedRbac, writeAudit };
