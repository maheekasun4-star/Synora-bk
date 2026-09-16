const prisma = require('../prismaClient');
const { getFolioBalance } = require('./folioService');
const {
  DEFAULT_EXPECTED_CHECK_OUT_TIME,
  fallbackExpectedDateTime,
} = require('../utils/reservationDateTime');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeLegacyLifecycleStatus(status) {
  const value = String(status ?? '').trim();
  const legacyMap = {
    confirmed: 'guaranteed',
    do_check_in: 'checked_in',
    checked_in: 'checked_in',
    due_checkout: 'due_checkout',
    early_checkout: 'early_checkout',
    checked_out: 'checked_out',
    completed: 'completed',
    room_assigned: 'room_assigned',
    closed: 'closed',
    cancelled: 'cancelled',
    no_show: 'no_show',
    tentative: 'tentative',
    guaranteed: 'guaranteed',
    in_house: 'in_house',
  };
  return legacyMap[value] || value;
}

// ---------- Transition table ----------
const ALLOWED_TRANSITIONS = {
  tentative: ['guaranteed', 'room_assigned', 'cancelled', 'no_show'],
  guaranteed: ['room_assigned', 'checked_in', 'in_house', 'cancelled'],
  room_assigned: ['checked_in', 'in_house', 'cancelled'],
  checked_in: ['in_house'],
  in_house: ['due_checkout', 'early_checkout', 'checked_out'],
  early_checkout: ['checked_out'],
  due_checkout: ['checked_out'],
  checked_out: ['completed'],
  completed: [],
  closed: [],
  cancelled: [],
  no_show: [],
};

async function assertTransition(reservationId, toStatus) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new HttpError(404, 'Reservation not found');

  const normalizedCurrentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  const normalizedToStatus = normalizeLegacyLifecycleStatus(toStatus);
  const allowed = ALLOWED_TRANSITIONS[normalizedCurrentStatus] || [];
  if (!allowed.includes(normalizedToStatus)) {
    throw new HttpError(409, `Cannot move reservation from '${normalizedCurrentStatus}' to '${normalizedToStatus}'`);
  }
  return { ...reservation, status: normalizedCurrentStatus };
}

async function logTransition(reservationId, fromStatus, toStatus, userId, extra = {}) {
  try {
    const effectiveUserId = userId || SYSTEM_USER_ID;
    if (!effectiveUserId) {
      return;
    }

    await prisma.auditLog.create({
      data: {
        userId: effectiveUserId,
        action: `STATUS_${String(fromStatus).toUpperCase()}_TO_${String(toStatus).toUpperCase()}`,
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: `Status change ${fromStatus} -> ${toStatus}`,
        oldValues: { status: fromStatus },
        newValues: { status: toStatus, ...extra },
      },
    });
  } catch (e) {
    console.error('Failed to write audit log for reservation transition:', e);
  }
}

// System user id (cached)
let SYSTEM_USER_ID = null;
async function loadSystemUserId() {
  if (SYSTEM_USER_ID) return SYSTEM_USER_ID;
  const user = await prisma.user.findUnique({ where: { username: 'system_night_audit' } }).catch(() => null);
  SYSTEM_USER_ID = user?.id || null;
  return SYSTEM_USER_ID;
}
loadSystemUserId();

// ---------- Housekeeping integration ----------
// A room must be clean or inspected before it can be assigned to a checked-in guest.
async function assertRoomCleanForCheckIn(roomId) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { cleanStatus: true, roomNumber: true } });
  if (!room) return;
  const ready = ['clean', 'inspected'].includes(room.cleanStatus);
  if (!ready) {
    throw new HttpError(409, `Room ${room.roomNumber} (#${roomId}) is not ready for guests. Clean status is "${room.cleanStatus}"; it must be clean or inspected before check-in.`);
  }
}

// Queue a checkout_clean housekeeping task for a room that just checked out.
async function createCheckoutCleanTask(tx, roomId, userId, scheduledFor) {
  const effectiveUserId = userId || SYSTEM_USER_ID || 1;
  if (!effectiveUserId) return null;
  return tx.housekeepingTask.create({
    data: {
      roomId,
      taskType: 'checkout_clean',
      scheduledFor,
      createdBy: effectiveUserId,
      status: 'pending',
    },
  });
}

// ---------- Transitions ----------
async function transitionToGuaranteed(reservationId, { userId, method = 'advance_payment', reason = null } = {}) {
  const reservation = await assertTransition(reservationId, 'guaranteed');

  if (method === 'manual' && !reason) {
    throw new HttpError(400, 'A reason is required to manually guarantee a reservation without an advance payment.');
  }

  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      status: 'guaranteed',
      guaranteeMethod: method,
      guaranteeReason: reason,
      guaranteedAt: new Date(),
      guaranteedBy: userId || null,
    },
  });

  await logTransition(reservationId, reservation.status, 'guaranteed', userId, { method, reason });
  return updated;
}

async function markDoCheckIn(reservationId, { userId = null } = {}) {
  await loadSystemUserId();
  const reservation = await assertTransition(reservationId, 'checked_in');

  const updated = await prisma.reservation.update({ where: { id: reservationId }, data: { status: 'checked_in' } });
  await logTransition(reservationId, reservation.status, 'checked_in', userId || SYSTEM_USER_ID);
  return updated;
}

async function performCheckIn(reservationId, { userId, roomId = null } = {}) {
  const reservation = await assertTransition(reservationId, 'checked_in');

  const updates = {
    status: 'checked_in',
    checkedInAt: new Date(),
    checked_in_by: userId || null,
  };
  if (roomId) updates.roomId = roomId;

  const targetRoomId = roomId || reservation.roomId;

  // Block check-in when the assigned room is not housekeeping-ready.
  if (targetRoomId) {
    await assertRoomCleanForCheckIn(targetRoomId);
  }

  const txOps = [
    prisma.reservation.update({ where: { id: reservationId }, data: updates }),
  ];
  if (targetRoomId) {
    txOps.push(prisma.room.update({ where: { id: targetRoomId }, data: { status: 'occupied' } }));
  }

  const results = await prisma.$transaction(txOps);
  const updated = results[0];

  await logTransition(reservationId, reservation.status, 'checked_in', userId);
  return updated;
}

async function markDueCheckout(reservationId, { userId = null } = {}) {
  await loadSystemUserId();
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new HttpError(404, 'Reservation not found');

  const currentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  if (!['checked_in', 'in_house'].includes(currentStatus)) {
    throw new HttpError(409, `Due checkout can only be flagged for checked-in or in-house reservations. Current status: ${currentStatus}`);
  }

  const flaggedAt = new Date();
  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      status: 'due_checkout',
      dueCheckoutAt: flaggedAt,
    },
  });

  if (userId || SYSTEM_USER_ID) {
    await prisma.auditLog.create({
      data: {
        userId: userId || SYSTEM_USER_ID,
        action: 'DUE_CHECKOUT_FLAG',
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: `Reservation flagged as due checkout because expected checkout date was reached while the guest remained in-house.`,
        oldValues: { status: currentStatus },
        newValues: { status: 'due_checkout', dueCheckoutAt: flaggedAt.toISOString() },
      }
    });
  }

  return {
    ...updated,
    status: 'due_checkout',
    dueCheckoutAt: flaggedAt,
    message: 'Reservation is flagged as due checkout; actual checkout remains a manual operation and must set checked_out_at.'
  };
}

// Admin forced completion of a reservation (balance must be settled — no bypass allowed)
async function forceCompleteReservation(reservationId, { userId = null, reason = '' } = {}) {
  if (typeof reason !== 'string') {
    throw new HttpError(400, 'Force complete reason must be a string');
  }
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new HttpError(400, 'Force complete reason is required and cannot be empty');
  }
  if (trimmedReason.length > 200) {
    throw new HttpError(400, 'Force complete reason exceeds maximum length of 200 characters');
  }

  await loadSystemUserId();
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new HttpError(404, 'Reservation not found');

  const currentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  if (!['due_checkout', 'in_house', 'checked_in', 'checked_out'].includes(currentStatus)) {
    throw new HttpError(409, `Force complete can only be applied to due_checkout, in_house, checked_in, or checked_out reservations. Current status: ${currentStatus}`);
  }

  // ENFORCE: No role can complete an unpaid reservation (Section 13)
  const outstandingBalance = await getFolioBalance(reservationId);
  if (outstandingBalance > 0.009) {
    throw new HttpError(409, `Outstanding balance of ${outstandingBalance.toFixed(2)} must be settled before completion. No role can bypass payment settlement.`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const resUpdate = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'completed',
        checkedOutAt: reservation.checkedOutAt || new Date(),
        checked_out_by: userId || SYSTEM_USER_ID || reservation.checked_out_by,
        checkout_reason: trimmedReason,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: userId || SYSTEM_USER_ID || reservation.checked_out_by || 1,
        action: 'FORCE_COMPLETE_RESERVATION',
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: 'Admin completed reservation lifecycle (balance verified settled).',
        oldValues: { status: reservation.status, outstandingBalance },
        newValues: { status: 'completed', outstandingBalance: 0, reason: trimmedReason },
      },
    });

    return resUpdate;
  });

  return { ...updated, outstandingBalance: 0, status: 'completed' };
}

async function attemptCheckout(reservationId, { userId = null } = {}) {
  await loadSystemUserId();
  const reservation = await assertTransition(reservationId, 'checked_out');

  const lastAudit = await prisma.nightAudit.findFirst({
    where: { completed: true },
    orderBy: { auditDate: 'desc' },
  });

  if (lastAudit && reservation.checkOut) {
    const lastAuditDate = new Date(lastAudit.auditDate);
    const checkoutDate = new Date(reservation.checkOut);
    if (checkoutDate <= lastAuditDate) {
      return {
        blocked: true,
        requiresForceComplete: true,
        message: 'This reservation requires administrative force completion after Night Audit. Normal checkout is not allowed.',
        balance: await getFolioBalance(reservationId),
      };
    }
  }

  const balance = await getFolioBalance(reservationId);
  if (balance > 0.009) {
    return { blocked: true, balance, status: 'checked_out', message: 'Outstanding balance must be settled before checkout.' };
  }

  const effectiveUserId = userId || SYSTEM_USER_ID || 1;

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id: reservationId },
      data: { status: 'checked_out', checkedOutAt: new Date(), checked_out_by: userId || null },
    });
    if (reservation.roomId) {
      await tx.room.update({
        where: { id: reservation.roomId },
        data: { status: 'dirty', cleanStatus: 'dirty' },
      });
      // Queue a checkout_clean housekeeping task so the room is refreshed for the next guest.
      await createCheckoutCleanTask(tx, reservation.roomId, effectiveUserId, new Date());
    }
    return res;
  });

  await logTransition(reservationId, reservation.status, 'checked_out', userId, { balance });
  return { blocked: false, balance: 0, reservation: updated };
}

async function autoCancelTentative(reservationId) {
  await loadSystemUserId();
  const reservation = await assertTransition(reservationId, 'cancelled');

  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: SYSTEM_USER_ID,
      cancellationReason: 'Automatically cancelled by Night Audit — guest did not arrive or check in, no advance payment received.',
    },
  });

  await logTransition(reservationId, reservation.status, 'cancelled', SYSTEM_USER_ID, { auto: true });
  return updated;
}

// Transition to due_checkout status
async function transitionToDueCheckout(reservationId, { userId = null } = {}) {
  await loadSystemUserId();
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new HttpError(404, 'Reservation not found');
  const currentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  if (currentStatus !== 'in_house') {
    throw new HttpError(409, `Due checkout can only be set from in_house status. Current status: ${currentStatus}`);
  }
  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: { status: 'due_checkout' },
  });
  await logTransition(reservationId, reservation.status, 'due_checkout', userId || SYSTEM_USER_ID);
  return updated;
}

// ---------- Early Checkout ----------
async function performEarlyCheckout(reservationId, { userId = null, reason = null } = {}) {
  const reservation = await assertTransition(reservationId, 'early_checkout');

  const now = new Date();
  const expectedCheckOutAt = reservation.expectedCheckOutAt
    || fallbackExpectedDateTime(reservation.checkOut, DEFAULT_EXPECTED_CHECK_OUT_TIME);
  if (now >= expectedCheckOutAt) {
    throw new HttpError(409, 'Early checkout is only available before the expected checkout date and time.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'early_checkout',
        originalCheckOut: reservation.originalCheckOut || reservation.checkOut, // preserve original only on first early checkout
        earlyCheckoutAt: now,
        checkout_type: 'early',
        checkout_reason: reason || null,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: userId || SYSTEM_USER_ID || 1,
        action: 'EARLY_CHECKOUT',
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: `Guest requested early checkout. Original checkout: ${expectedCheckOutAt.toISOString()}.${reason ? ' Reason: ' + reason : ''}`,
        oldValues: { status: reservation.status, expectedCheckOutAt },
        newValues: { status: 'early_checkout', earlyCheckoutAt: now.toISOString(), expectedCheckOutAt },
      },
    });

    return res;
  });

  await logTransition(reservationId, reservation.status, 'early_checkout', userId, { reason, originalCheckOut: reservation.checkOut });
  return updated;
}

// ---------- No-Show (tentative only) ----------
async function markNoShow(reservationId, { userId = null } = {}) {
  await loadSystemUserId();
  const reservation = await assertTransition(reservationId, 'no_show');

  // Double-check: no-show is only for tentative reservations
  const currentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  if (currentStatus !== 'tentative') {
    throw new HttpError(409, `No-show can only be applied to tentative reservations. Current status: ${currentStatus}`);
  }

  const now = new Date();
  const effectiveUserId = userId || SYSTEM_USER_ID;

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'no_show',
        noShowAt: now,
        noShowBy: effectiveUserId,
      },
    });

    // Free up the room if one was assigned
    if (reservation.roomId) {
      await tx.room.update({
        where: { id: reservation.roomId },
        data: { status: 'available' },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: effectiveUserId || 1,
        action: 'NO_SHOW',
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: 'Guest did not arrive. Reservation marked as no-show.',
        oldValues: { status: reservation.status },
        newValues: { status: 'no_show', noShowAt: now.toISOString() },
      },
    });

    return res;
  });

  await logTransition(reservationId, reservation.status, 'no_show', effectiveUserId);
  return updated;
}

// ---------- Cancel Reservation (pre-check-in only) ----------
async function cancelReservation(reservationId, { userId = null, reason = '' } = {}) {
  const reservation = await assertTransition(reservationId, 'cancelled');

  const currentStatus = normalizeLegacyLifecycleStatus(reservation.status);
  if (!['tentative', 'guaranteed', 'room_assigned'].includes(currentStatus)) {
    throw new HttpError(409, `Cancellation is only allowed before check-in. Current status: ${currentStatus}. Use checkout for in-house guests.`);
  }

  if (!reason || !reason.trim()) {
    throw new HttpError(400, 'Cancellation reason is required.');
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: userId || null,
        cancellationReason: reason.trim(),
      },
    });

    // Free up the room if one was assigned
    if (reservation.roomId) {
      await tx.room.update({
        where: { id: reservation.roomId },
        data: { status: 'available' },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: userId || 1,
        action: 'RESERVATION_CANCELLED',
        module: 'reservationLifecycle',
        entityType: 'reservations',
        entityId: reservationId,
        description: `Reservation cancelled. Reason: ${reason.trim()}`,
        oldValues: { status: reservation.status },
        newValues: { status: 'cancelled', cancelledAt: now.toISOString(), cancellationReason: reason.trim() },
      },
    });

    return res;
  });

  await logTransition(reservationId, reservation.status, 'cancelled', userId, { reason: reason.trim() });
  return updated;
}

module.exports = {
  transitionToDueCheckout,
  transitionToGuaranteed,
  markDoCheckIn,
  performCheckIn,
  markDueCheckout,
  attemptCheckout,
  forceCompleteReservation,
  autoCancelTentative,
  performEarlyCheckout,
  markNoShow,
  cancelReservation,
  assertRoomCleanForCheckIn,
  createCheckoutCleanTask,
  HttpError,
};
