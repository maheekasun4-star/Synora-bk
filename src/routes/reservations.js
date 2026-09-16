const express = require('express');
const { validateMealPlanCompatibility } = require('../utils/validation');
const router = express.Router();
const { getActiveRate, calculateTaxBreakdown } = require('../services/taxInvoiceService');
const { authenticateToken, requireRole, requirePermission } = require('../middlewares/auth');
const { renderPdfFromHtml } = require('../services/pdfRenderer');
const fs = require('fs');
const sm = require('../services/reservationStateMachine');
const {
  DEFAULT_EXPECTED_CHECK_IN_TIME,
  DEFAULT_EXPECTED_CHECK_OUT_TIME,
  parseReservationDateTime,
  datePart,
  combineDateAndTime,
  fallbackExpectedDateTime,
  validateExpectedDateRange,
  validateActiveBusinessDateRange,
} = require('../utils/reservationDateTime');

const prisma = require('../prismaClient');

// Helper to generate a unique confirmation number
function generateConfoNo() {
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ELLA-${dateStr}-${rand}`;
}

// Helper to extract human-readable error messages from Prisma errors
function getPrismaErrorMessage(error) {
  if (!error) return null;
  
  // Handle validation errors
  if (error.code === 'P2025') {
    return 'Referenced record not found. Please verify that the guest, room, meal plan, and rate plan all exist.';
  }
  
  // Handle unique constraint violations
  if (error.code === 'P2002') {
    const field = error.meta?.target?.[0];
    if (field === 'confoNo' || field === 'confo_no') {
      return 'A reservation with this confirmation number already exists.';
    }
    if (field) {
      return `A reservation with this ${field} already exists.`;
    }
    return 'A reservation with these details already exists.';
  }
  
  // Handle foreign key constraint violations
  if (error.code === 'P2003') {
    const fieldName = error.meta?.field_name;
    const relationName = error.meta?.relation_name;
    
    // Check the relation name if available (more reliable than field_name)
    if (relationName) {
      if (relationName.toLowerCase().includes('guest')) {
        return 'Guest not found. Please verify the guest ID.';
      }
      if (relationName.toLowerCase().includes('room')) {
        return 'Room not found. Please verify the room ID.';
      }
      if (relationName.toLowerCase().includes('travelagent')) {
        return 'Travel agent not found. Please verify the travel agent ID.';
      }
      if (relationName.toLowerCase().includes('user')) {
        return 'User not found. Please verify the user ID.';
      }
    }
    
    // Fallback to field_name
    if (fieldName) {
      const lowerFieldName = fieldName.toLowerCase();
      if (lowerFieldName.includes('guest')) return 'Guest not found. Please verify the guest ID.';
      if (lowerFieldName.includes('room')) return 'Room not found. Please verify the room ID.';
      if (lowerFieldName.includes('mealplan')) return 'Meal plan not found. Please verify the meal plan ID.';
      if (lowerFieldName.includes('rateplan')) return 'Rate plan not found. Please verify the rate plan ID.';
      if (lowerFieldName.includes('agent')) return 'Travel agent not found. Please verify the travel agent ID.';
      if (lowerFieldName.includes('user') || lowerFieldName.includes('created') || lowerFieldName.includes('by')) {
        return 'User not found. Please verify the user ID.';
      }
    }
    
    return 'One or more referenced records do not exist. Please verify all IDs.';
  }
  
  // Handle required field violations
  if (error.code === 'P2011') {
    const field = error.meta?.field_name;
    if (field) {
      return `${field} is required.`;
    }
    return 'A required field is missing.';
  }
  
  // Handle invalid data type
  if (error.code === 'P2012') {
    return 'One or more fields contain invalid data types.';
  }
  
  return null;
}

// Helper to handle and format errors for reservation creation
function handleReservationCreationError(error) {
  const prismaErrorMessage = getPrismaErrorMessage(error);
  if (prismaErrorMessage) {
    return {
      statusCode: 400,
      message: prismaErrorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    };
  }
  
  // If error has a custom status, use it
  if (error.status) {
    return {
      statusCode: error.status,
      message: error.message,
    };
  }
  
  // Default to generic server error
  return {
    statusCode: 500,
    message: 'Failed to create reservation. Please check the request data and try again.',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined,
  };
}

function normalizeReservationStatus(status) {
  if (!status) return status;

  const value = String(status).trim();
  const legacyMapping = {
    confirmed: 'guaranteed',
    do_check_in: 'checked_in',
    due_checkout: 'due_checkout',
    completed: 'completed',
    checked_in: 'checked_in',
    checked_out: 'checked_out',
    room_assigned: 'room_assigned',
    closed: 'closed',
    cancelled: 'cancelled',
    no_show: 'no_show',
    tentative: 'tentative',
    guaranteed: 'guaranteed',
    in_house: 'in_house',
  };

  return legacyMapping[value] || value;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  if (typeof value === 'number') return value === 1;
  return Boolean(value);
}

function validateComplimentaryRequest({ isComplimentary, complimentaryReason, existingIsComplimentary = false, allowBlankWhenNotComplimentary = true }) {
  const nextValue = normalizeBoolean(isComplimentary);
  const trimmedReason = typeof complimentaryReason === 'string' ? complimentaryReason.trim() : '';

  if (nextValue || existingIsComplimentary) {
    if (!trimmedReason) {
      throw Object.assign(new Error('A complimentary reason is required when the reservation is marked complimentary.'), { status: 400 });
    }
  } else if (!allowBlankWhenNotComplimentary && !trimmedReason) {
    throw Object.assign(new Error('Complimentary reason is required for this change.'), { status: 400 });
  }

  return {
    isComplimentary: nextValue,
    complimentaryReason: trimmedReason || null,
  };
}

async function logComplimentaryAudit({ prismaClient, reservationId, userId, previousState, nextState, reason }) {
  try {
    if (!prismaClient || !prismaClient.auditLog) return;
    await prismaClient.auditLog.create({
      data: {
        userId: userId || 1,
        action: nextState ? 'marked_complimentary' : 'removed_complimentary',
        module: 'reservationPricing',
        entityType: 'reservations',
        entityId: reservationId,
        description: nextState
          ? `Reservation marked complimentary: ${reason}`
          : `Complimentary flag removed for reservation. Reason: ${reason || 'not provided'}`,
        oldValues: { isComplimentary: previousState, complimentaryReason: reason },
        newValues: { isComplimentary: nextState, complimentaryReason: reason },
      },
    });
  } catch (err) {
    console.warn('Could not write complimentary audit log:', err);
  }
}

// Get all reservations
router.get('/', authenticateToken, requirePermission('reservations.view'), async (req, res) => {
  // Accept both legacy (checkIn/checkOut) and new (startDate/endDate) query params
  const { search, status, checkIn, checkOut, startDate, endDate } = req.query;

  // Determine the effective date range
  const dateFrom = startDate || checkIn;
  const dateTo = endDate || checkOut;

  try {
    let whereClause = {};

    if (status) {
      whereClause.status = normalizeReservationStatus(status);
    }

    if (dateFrom && dateTo) {
      const start = new Date(`${dateFrom}T00:00:00.000Z`);
      const end = new Date(`${dateTo}T23:59:59.999Z`);

      // Include reservations that overlap the selected date window, even when the user picks a single date.
      // This is intentionally inclusive so a reservation starting or ending on the selected day still appears.
      whereClause.AND = [
        { checkIn: { lte: end } },
        { checkOut: { gte: start } }
      ];
    }

    if (search) {
      whereClause.guest = {
        OR: [
          { fullName: { contains: search } },
          { phone: { contains: search } },
          { email: { contains: search } }
        ]
      };
    }

    const reservations = await prisma.reservation.findMany({
      where: whereClause,
      include: {
        guest: true,
        room: { include: { roomType: true } },
        travelAgent: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(reservations);
  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// Get all charge types
router.get('/charge-types', authenticateToken, requirePermission('reservations.view'), async (req, res) => {
  try {
    const types = await prisma.chargeType.findMany({
      orderBy: { name: 'asc' },
    });
    res.json(types);
  } catch (error) {
    console.error('Error fetching charge types:', error);
    res.status(500).json({ error: 'Failed to fetch charge types' });
  }
});

// Get reservation by ID
router.get('/:id', authenticateToken, requirePermission('reservations.view'), async (req, res) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        guest: true,
        room: { include: { roomType: true } },
        travelAgent: true,
        payments: { include: { user: { select: { id: true, username: true, fullName: true } } } },
      },
    });

    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    res.json(reservation);
  } catch (error) {
    console.error('Error fetching reservation:', error);
    res.status(500).json({ error: 'Failed to fetch reservation' });
  }
});

// Create reservation
router.post('/', authenticateToken, requirePermission('reservations.create'), async (req, res) => {
  const {
    guestId,
    travelAgentId,
    roomId,
    checkIn,
    checkOut,
    expected_check_in_at: expectedCheckInAtInput,
    expected_check_out_at: expectedCheckOutAtInput,
    expectedCheckInAt,
    expectedCheckOutAt,
    adults,
    children,
    status,
    bookingSource,
    rate,
    createdBy,
    guaranteeMethod,
    guaranteeReason,
    ratePlanId,
    mealPlanId,
    is_complimentary: isComplimentaryInput,
    isComplimentary,
    complimentary_reason: complimentaryReasonInput,
    complimentaryReason,
  } = req.body;

  if (!guestId || !roomId || !checkIn || !checkOut || !rate) {
    return res.status(400).json({ error: 'Missing required reservation fields' });
  }

  // If reservation is being created as guaranteed, require a guarantee reason
  if (status === 'guaranteed' && !guaranteeReason) {
    return res.status(400).json({ error: 'Guarantee reason is required when marking reservation as guaranteed.' });
  }

  const requestedComplimentaryValue = isComplimentaryInput !== undefined ? isComplimentaryInput : isComplimentary;
  const requestedComplimentaryReason = complimentaryReasonInput !== undefined ? complimentaryReasonInput : complimentaryReason;

  try {
    const { isComplimentary: finalComplimentaryValue, complimentaryReason: finalComplimentaryReason } = validateComplimentaryRequest({
      isComplimentary: requestedComplimentaryValue,
      complimentaryReason: requestedComplimentaryReason,
      existingIsComplimentary: false,
    });
    const confoNo = generateConfoNo();

    const normalizedStatus = normalizeReservationStatus(status);
    const finalExpectedCheckInAt = parseReservationDateTime(expectedCheckInAtInput || expectedCheckInAt, 'Expected check-in')
      || fallbackExpectedDateTime(checkIn, DEFAULT_EXPECTED_CHECK_IN_TIME);
    const finalExpectedCheckOutAt = parseReservationDateTime(expectedCheckOutAtInput || expectedCheckOutAt, 'Expected check-out')
      || fallbackExpectedDateTime(checkOut, DEFAULT_EXPECTED_CHECK_OUT_TIME);
    validateExpectedDateRange(finalExpectedCheckInAt, finalExpectedCheckOutAt);
    validateActiveBusinessDateRange(finalExpectedCheckInAt, finalExpectedCheckOutAt);

    // Room conflict check — reject if another active reservation overlaps this room & date range
    const finalCheckIn = combineDateAndTime(datePart(finalExpectedCheckInAt), '00:00');
    const finalCheckOut = combineDateAndTime(datePart(finalExpectedCheckOutAt), '00:00');
    const roomConflict = await prisma.reservation.findFirst({
      where: {
        roomId: parseInt(roomId),
        status: { notIn: ['cancelled', 'no_show'] },
        checkIn: { lt: finalCheckOut },
        checkOut: { gt: finalCheckIn },
      },
    });
    if (roomConflict) {
      return res.status(409).json({
        error: `Room is not available for the selected dates. Conflict with reservation ${roomConflict.confoNo}.`,
      });
    }

    // Validate MealPlan compatibility if RatePlan provided
    try {
      await validateMealPlanCompatibility(req.body.ratePlanId, req.body.mealPlanId);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }
    // If a ratePlanId is provided, fetch its meal plan to snapshot into reservation
    let mealPlanSnapshot = null;
    if (req.body.ratePlanId) {
      const rpId = parseInt(req.body.ratePlanId);
      const rp = await prisma.ratePlan.findUnique({ where: { id: rpId }, include: { mealPlan: true } });
      if (rp && rp.mealPlan) {
        mealPlanSnapshot = rp.mealPlan;
      }
    }

    const reservation = await prisma.reservation.create({
      data: {
        confoNo,
        guestId: parseInt(guestId),
        travelAgentId: travelAgentId ? parseInt(travelAgentId) : null,
        roomId: parseInt(roomId),
        checkIn: combineDateAndTime(datePart(finalExpectedCheckInAt), '00:00'),
        checkOut: combineDateAndTime(datePart(finalExpectedCheckOutAt), '00:00'),
        expectedCheckInAt: finalExpectedCheckInAt,
        expectedCheckOutAt: finalExpectedCheckOutAt,
        adults: adults ? parseInt(adults) : 1,
        children: children ? parseInt(children) : 0,
        status: normalizedStatus || 'tentative',
        bookingSource: bookingSource || 'direct',
        rate: parseFloat(rate),
        mealPlanId: mealPlanSnapshot ? mealPlanSnapshot.id : null,
        mealPlanCode: mealPlanSnapshot ? mealPlanSnapshot.code : null,
        mealPlanName: mealPlanSnapshot ? mealPlanSnapshot.name : null,
        mp_breakfast_inc: mealPlanSnapshot ? mealPlanSnapshot.breakfastIncluded : null,
        mp_lunch_inc: mealPlanSnapshot ? mealPlanSnapshot.lunchIncluded : null,
        mp_dinner_inc: mealPlanSnapshot ? mealPlanSnapshot.dinnerIncluded : null,
        mp_drinks_inc: mealPlanSnapshot ? mealPlanSnapshot.drinksIncluded : null,
        mp_snacks_inc: mealPlanSnapshot ? mealPlanSnapshot.snacksIncluded : null,
        hb_selection: (mealPlanSnapshot && mealPlanSnapshot.code === 'HB' && req.body.hbSelection) ? req.body.hbSelection : null,
        createdBy: req.user.id,
        // Map guarantee fields if provided
        guarantee_method: guaranteeMethod || null,
        guarantee_reason: guaranteeReason || null,
        guaranteed_at: normalizedStatus === 'guaranteed' ? new Date() : null,
        guaranteed_by: normalizedStatus === 'guaranteed' ? (createdBy ? parseInt(createdBy) : null) : null,
        isComplimentary: finalComplimentaryValue,
        complimentaryReason: finalComplimentaryReason,
        complimentaryApprovedBy: finalComplimentaryValue ? (req.user?.id || null) : null,
      },
      include: {
        guest: true,
        room: true,
      },
    });

    if (finalComplimentaryValue) {
      await logComplimentaryAudit({
        prismaClient: prisma,
        reservationId: reservation.id,
        userId: req.user?.id,
        previousState: false,
        nextState: true,
        reason: finalComplimentaryReason,
      });
    }

    // If checked in immediately, update room status
    if (normalizeReservationStatus(reservation.status) === 'in_house') {
      if (parseInt(roomId)) {
        await sm.assertRoomCleanForCheckIn(parseInt(roomId));
      }
      await prisma.room.update({
        where: { id: reservation.roomId },
        data: { status: 'occupied' },
      });
    }

    res.status(201).json(reservation);
  } catch (error) {
    console.error('Error creating reservation:', {
      message: error.message,
      code: error.code,
      meta: error.meta,
      stack: error.stack,
    });
    const errorResponse = handleReservationCreationError(error);
    res.status(errorResponse.statusCode).json({
      error: errorResponse.message,
      ...(errorResponse.details && { details: errorResponse.details }),
    });
  }
});

router.post('/:id/force-complete', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { reason } = req.body || {};
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  if (!trimmedReason) {
    return res.status(400).json({ error: 'Reason is required.' });
  }

  try {
    const reservationId = Number(req.params.id);
    const updated = await require('../services/reservationStateMachine').forceCompleteReservation(reservationId, {
      userId: req.user.id,
      reason: trimmedReason,
    });

    return res.json({
      message: 'Reservation force-completed successfully.',
      reservation: updated,
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({ error: err.message || 'Force complete failed.' });
  }
});

// Change Room
router.put('/:id/change-room', authenticateToken, async (req, res) => {
  const reservationId = parseInt(req.params.id);
  const { newRoomId } = req.body;

  if (!newRoomId) {
    return res.status(400).json({ error: 'newRoomId is required' });
  }

  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const LOCKED_STATUSES = ['checked_out', 'completed', 'closed', 'cancelled', 'no_show'];
    const normalizedReservationStatus = normalizeReservationStatus(reservation.status);
    if (LOCKED_STATUSES.includes(normalizedReservationStatus)) {
      return res.status(409).json({
        error: `Reservation is ${normalizedReservationStatus.replace('_', ' ')} and can no longer be changed.`,
      });
    }

    const oldRoomId = reservation.roomId;

    // Update reservation with new room
    const updatedReservation = await prisma.reservation.update({
      where: { id: reservationId },
      data: { roomId: parseInt(newRoomId) },
      include: { room: true },
    });

    // Update room statuses
    if (normalizedReservationStatus === 'in_house') {
      // the freshly assigned room must be housekeeping-ready before move-in
      await sm.assertRoomCleanForCheckIn(parseInt(newRoomId));
      // old room is now dirty
      await prisma.room.update({
        where: { id: oldRoomId },
        data: { status: 'dirty', cleanStatus: 'dirty' },
      });
      // new room is now occupied
      await prisma.room.update({
        where: { id: parseInt(newRoomId) },
        data: { status: 'occupied' },
      });
    }

    res.json(updatedReservation);
  } catch (error) {
    console.error('Error changing room:', error);
    res.status(500).json({ error: 'Failed to change room' });
  }
});

// Update Status
router.put('/:id/status', async (req, res) => {
  console.log('[DEBUG] PUT /api/reservations/:id/status body=', req.body);
  const reservationId = parseInt(req.params.id);
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const LOCKED_STATUSES = ['checked_out', 'completed', 'closed', 'cancelled', 'no_show'];
    const normalizedStatus = normalizeReservationStatus(status);
    const normalizedOldStatus = normalizeReservationStatus(reservation.status);

    if (LOCKED_STATUSES.includes(normalizedOldStatus)) {
      return res.status(409).json({
        error: `Reservation is already ${normalizedOldStatus.replace('_', ' ')} and cannot change status again.`,
      });
    }

    const oldStatus = normalizedOldStatus;
    const roomId = reservation.roomId;

    const allowedFrom = {
      tentative: ['tentative', 'guaranteed', 'room_assigned'],
      guaranteed: ['tentative', 'guaranteed', 'room_assigned'],
      room_assigned: ['tentative', 'guaranteed', 'room_assigned'],
      checked_in: ['tentative', 'guaranteed', 'room_assigned', 'checked_in'],
      in_house: ['checked_in', 'in_house'],
      due_checkout: ['in_house', 'due_checkout'],
      early_checkout: ['in_house'],
      checked_out: ['checked_in', 'in_house', 'due_checkout', 'early_checkout', 'checked_out'],
      completed: ['checked_out'],
      cancelled: ['tentative', 'guaranteed', 'room_assigned'],
      no_show: ['tentative'],
    };

    if (normalizedStatus === 'checked_in') {
      const allowedUpdatingFrom = allowedFrom.checked_in;
      if (!allowedUpdatingFrom.includes(oldStatus)) {
        return res.status(409).json({ error: `Reservation cannot be checked in from status '${oldStatus}'.` });
      }

      if (roomId) {
        await sm.assertRoomCleanForCheckIn(roomId);
      }

      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'checked_in',
          checkedInAt: reservation.checkedInAt || new Date(),
          checked_in_by: req.user?.id || reservation.checked_in_by || null,
        },
      });

      if (roomId) {
        await prisma.room.update({
          where: { id: roomId },
          data: { status: 'occupied' },
        });
      }

      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'in_house') {
      const allowedUpdatingFrom = ['tentative', 'guaranteed', 'room_assigned', 'checked_in', 'in_house'];
      if (!allowedUpdatingFrom.includes(oldStatus)) {
        return res.status(409).json({ error: `Reservation cannot be moved to in-house from status '${oldStatus}'.` });
      }

      if (roomId) {
        await sm.assertRoomCleanForCheckIn(roomId);
      }

      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'in_house',
          checkedInAt: reservation.checkedInAt || new Date(),
          checked_in_by: req.user?.id || reservation.checked_in_by || null,
        },
      });

      if (roomId) {
        await prisma.room.update({
          where: { id: roomId },
          data: { status: 'occupied' },
        });
      }

      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'early_checkout') {
      if (oldStatus !== 'in_house') {
        return res.status(409).json({ error: `Early checkout can only be applied to in-house reservations. Current status: '${oldStatus}'.` });
      }

      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'early_checkout',
          originalCheckOut: reservation.originalCheckOut || reservation.checkOut,
          earlyCheckoutAt: new Date(),
          checkout_type: 'early',
          checkout_reason: req.body.reason || null,
        },
      });

      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'checked_out') {
      if (!['checked_in', 'in_house', 'due_checkout', 'early_checkout'].includes(oldStatus)) {
        return res.status(409).json({ error: `Reservation can only move to checked out from checked-in, in-house, or due-checkout status.` });
      }

      const balance = await getFolioBalance(reservationId);
      if (balance > 0.009) {
        return res.status(409).json({
          error: `Outstanding balance must be settled before checkout.`,
        });
      }

      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'checked_out',
          checkedOutAt: reservation.checkedOutAt || new Date(),
          checked_out_by: req.user?.id || reservation.checked_out_by || null,
        },
      });

      if (roomId) {
        await prisma.$transaction(async (tx) => {
          await tx.room.update({ where: { id: roomId }, data: { status: 'dirty', cleanStatus: 'dirty' } });
          await sm.createCheckoutCleanTask(tx, roomId, req.user?.id, new Date());
        });
      }

      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'completed') {
      if (oldStatus !== 'checked_out') {
        return res.status(409).json({ error: `Reservation can only move to completed from checked-out status.` });
      }

      const balance = await getFolioBalance(reservationId);
      if (balance > 0.009) {
        return res.status(409).json({
          error: `Outstanding balance of ${balance.toFixed(2)} must be settled before completion. No role can bypass payment settlement.`,
        });
      }

      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'completed',
          checkedOutAt: reservation.checkedOutAt || new Date(),
          checked_out_by: req.user?.id || reservation.checked_out_by || null,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user?.id || reservation.checked_out_by || 1,
          action: 'RESERVATION_COMPLETED',
          module: 'reservationLifecycle',
          entityType: 'reservations',
          entityId: reservationId,
          description: 'Reservation completion finalized after checkout/folio closure.',
          oldValues: { status: reservation.status },
          newValues: { status: 'completed' },
        },
      });

      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'cancelled') {
      if (!['tentative', 'guaranteed', 'room_assigned'].includes(oldStatus)) {
        return res.status(409).json({ error: `Cancellation is only allowed before check-in. Current status: '${oldStatus}'. Use checkout for in-house guests.` });
      }
      const cancellationReason = req.body.cancellationReason || req.body.reason;
      if (!cancellationReason || !cancellationReason.trim()) {
        return res.status(400).json({ error: 'Cancellation reason is required.' });
      }
      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: req.user?.id || null,
          cancellationReason: cancellationReason.trim(),
        },
      });
      if (roomId) {
        await prisma.room.update({ where: { id: roomId }, data: { status: 'available' } });
      }
      return res.json(updatedReservation);
    }

    if (normalizedStatus === 'no_show') {
      if (oldStatus !== 'tentative') {
        return res.status(409).json({ error: `No-show can only be applied to tentative reservations. Current status: '${oldStatus}'.` });
      }
      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'no_show',
          noShowAt: new Date(),
          noShowBy: req.user?.id || null,
        },
      });
      if (roomId) {
        await prisma.room.update({ where: { id: roomId }, data: { status: 'available' } });
      }
      return res.json(updatedReservation);
    }

    const updatedReservation = await prisma.reservation.update({
      where: { id: reservationId },
      data: { status: normalizedStatus },
    });

    res.json(updatedReservation);
  } catch (error) {
    console.error('Error updating status:', error);
    // Return more details for debugging (remove or simplify in production)
    res.status(500).json({ error: 'Failed to update reservation status', details: error.message, stack: error.stack });
  }
});

// Get charges for a specific reservation
router.get('/:id/charges', async (req, res) => {
  try {
    const charges = await prisma.guestCharge.findMany({
      where: { reservationId: parseInt(req.params.id) },
      include: {
        chargeType: true,
        user: { select: { fullName: true, username: true } },
        taxes: true,
      },
      orderBy: { postedAt: 'desc' },
    });
    res.json(charges);
  } catch (error) {
    console.error('Error fetching charges:', error);
    res.status(500).json({ error: 'Failed to fetch charges' });
  }
});

// Post a new guest charge against a reservation folio
router.post('/:id/charges', async (req, res) => {
  const { chargeTypeId, description, amount, postedBy } = req.body;

  if (!chargeTypeId || amount === undefined || !postedBy) {
    return res.status(400).json({ error: 'chargeTypeId, amount, and postedBy are required' });
  }

  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: parseInt(req.params.id) },
      select: { status: true, checkIn: true },
    });

    const activeReservationStatuses = new Set(['tentative', 'guaranteed', 'room_assigned', 'checked_in', 'in_house']);
    const isReservationActive = reservation && reservation.status && activeReservationStatuses.has(normalizeReservationStatus(reservation.status));

    // Night Audit lock check: active reservations can still post charges as long as they are still live.
    const lastAudit = await prisma.nightAudit.findFirst({
      where: { completed: true },
      orderBy: { auditDate: 'desc' },
    });
    if (lastAudit && !isReservationActive) {
      const tzOffset = new Date().getTimezoneOffset() * 60000;
      const localTodayStr = new Date(Date.now() - tzOffset).toISOString().slice(0, 10);
      const auditDateStr = lastAudit.auditDate.toISOString().slice(0, 10);
      if (reservation && reservation.checkIn) {
        const resCheckInStr = new Date(reservation.checkIn).toISOString().slice(0, 10);
        if (resCheckInStr <= auditDateStr) {
          return res.status(409).json({ error: `Business date is locked (last audited date: ${auditDateStr}). No new charges can be posted for reservations on or before that date.` });
        }
      } else if (localTodayStr <= auditDateStr) {
        return res.status(409).json({ error: `Business date is locked (last audited date: ${auditDateStr}). No new charges can be posted.` });
      }
    }

    const chargeType = await prisma.chargeType.findUnique({
      where: { id: parseInt(chargeTypeId) }
    });

    if (!chargeType) {
      return res.status(404).json({ error: 'Charge type not found' });
    }

    const baseAmount = parseFloat(amount);

    // Dynamic tax calculation using config-driven rates
    const scConfig = await getActiveRate('SC', { propertyId: 1 });
    const vatConfig = await getActiveRate('VAT', { propertyId: 1 });
    const tdlConfig = await getActiveRate('TDL', { propertyId: 1 });
    const nbtConfig = await getActiveRate('NBT', { propertyId: 1 });

    const scAmount = Math.round(baseAmount * scConfig.rate * 100) / 100;
    const vatBase = vatConfig.compoundOn === 'room_revenue_plus_sc' ? baseAmount + scAmount : baseAmount;
    const vatAmount = Math.round(vatBase * vatConfig.rate * 100) / 100;

    // Apply TDL and NBT only to Room Charge and Food & Beverage
    const isRoomOrFood = chargeType.name === 'Room Charge' || chargeType.name === 'Food & Beverage';
    const tdlAmount = isRoomOrFood ? Math.round(baseAmount * tdlConfig.rate * 100) / 100 : 0;
    const nbtAmount = isRoomOrFood ? Math.round(baseAmount * nbtConfig.rate * 100) / 100 : 0;

    const result = await prisma.$transaction(async (tx) => {
      const charge = await tx.guestCharge.create({
        data: {
          reservationId: parseInt(req.params.id),
          chargeTypeId: parseInt(chargeTypeId),
          description,
          amount: baseAmount,
          postedBy: parseInt(postedBy),
        }
      });

      const taxData = [];
      if (scAmount > 0) taxData.push({ guestChargeId: charge.id, taxType: 'SC', amount: scAmount });
      if (vatAmount > 0) taxData.push({ guestChargeId: charge.id, taxType: 'VAT', amount: vatAmount });
      if (tdlAmount > 0) taxData.push({ guestChargeId: charge.id, taxType: 'TDL', amount: tdlAmount });
      if (nbtAmount > 0) taxData.push({ guestChargeId: charge.id, taxType: 'NBT', amount: nbtAmount });

      if (taxData.length > 0) {
        await tx.guestChargeTax.createMany({ data: taxData });
      }

      return tx.guestCharge.findUnique({
        where: { id: charge.id },
        include: { taxes: true, chargeType: true }
      });
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Error posting guest charge:', error);
    res.status(500).json({ error: 'Failed to post guest charge' });
  }
});

// Void a guest charge
router.put('/charges/:id/void', async (req, res) => {
  const chargeId = parseInt(req.params.id);
  const { voidReason } = req.body;

  if (!voidReason) {
    return res.status(400).json({ error: 'Void reason is required' });
  }

  try {
    const charge = await prisma.guestCharge.findUnique({
      where: { id: chargeId },
      select: { reservation: { select: { status: true, checkIn: true } } },
    });

    const activeReservationStatuses = new Set(['tentative', 'guaranteed', 'room_assigned', 'checked_in', 'in_house']);
    const isReservationActive = charge && charge.reservation && activeReservationStatuses.has(normalizeReservationStatus(charge.reservation.status));

    // Night Audit lock check: active reservations can still void charges when they are still live.
    const lastAudit = await prisma.nightAudit.findFirst({
      where: { completed: true },
      orderBy: { auditDate: 'desc' },
    });
    if (lastAudit && !isReservationActive) {
      const tzOffset = new Date().getTimezoneOffset() * 60000;
      const localTodayStr = new Date(Date.now() - tzOffset).toISOString().slice(0, 10);
      const auditDateStr = lastAudit.auditDate.toISOString().slice(0, 10);
      if (charge && charge.reservation && charge.reservation.checkIn) {
        const resCheckInStr = new Date(charge.reservation.checkIn).toISOString().slice(0, 10);
        if (resCheckInStr <= auditDateStr) {
          return res.status(409).json({ error: `Business date is locked (last audited date: ${auditDateStr}). Charges cannot be voided for reservations on or before that date.` });
        }
      } else if (localTodayStr <= auditDateStr) {
        return res.status(409).json({ error: `Business date is locked (last audited date: ${auditDateStr}). Charges cannot be voided.` });
      }
    }

    const updatedCharge = await prisma.guestCharge.update({
      where: { id: chargeId },
      data: {
        isVoid: true,
        voidReason,
      },
      include: { chargeType: true, taxes: true },
    });
    res.json(updatedCharge);
  } catch (error) {
    console.error('Error voiding charge:', error);
    res.status(500).json({ error: 'Failed to void charge' });
  }
});

// Get consolidated guest folio details
router.get('/:id/folio', async (req, res) => {
  const reservationId = parseInt(req.params.id);

  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        guest: true,
        room: { include: { roomType: true } },
        travelAgent: true,
        payments: { include: { user: { select: { id: true, username: true, fullName: true } } } },
        guestCharges: {
          include: { chargeType: true, taxes: true }
        }
      }
    });

    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    // 1. Calculate Room Revenue & Taxes
    const checkInDate = new Date(reservation.checkIn);
    const checkOutDate = new Date(reservation.checkOut);
    const diffTime = Math.abs(checkOutDate - checkInDate);
    const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;

    // If there are explicit guest charges of type 'Room Charge' posted (e.g. Night Audit),
    // derive room revenue and taxes from those charges. Otherwise fall back to the
    // legacy calculation (reservation.rate * nights) with tax breakdown.
    const roomChargeEntries = reservation.guestCharges.filter(c => !c.isVoid && c.chargeType && c.chargeType.name === 'Room Charge');

    let roomRevenue = 0;
    let roomTaxBreakdown;

    if (reservation.isComplimentary) {
      roomRevenue = 0;
      roomTaxBreakdown = { roomRevenue: 0, sc: 0, vat: 0, tdl: 0, nbt: 0, totalAmount: 0 };
    } else if (roomChargeEntries.length > 0) {
      // Sum posted room charge base amounts
      roomRevenue = roomChargeEntries.reduce((sum, c) => sum + (c.amount || 0), 0);

      // Sum their tax allocations (guestChargeTax rows already included as c.taxes)
      let sc = 0, vat = 0, tdl = 0, nbt = 0;
      roomChargeEntries.forEach(c => {
        (c.taxes || []).forEach(t => {
          if (t.taxType === 'SC') sc += t.amount || 0;
          if (t.taxType === 'VAT') vat += t.amount || 0;
          if (t.taxType === 'TDL') tdl += t.amount || 0;
          if (t.taxType === 'NBT') nbt += t.amount || 0;
        });
      });

      // Round values
      sc = Math.round(sc * 100) / 100;
      vat = Math.round(vat * 100) / 100;
      tdl = Math.round(tdl * 100) / 100;
      nbt = Math.round(nbt * 100) / 100;

      roomTaxBreakdown = { roomRevenue, sc, vat, tdl, nbt, totalAmount: Math.round((roomRevenue + sc + vat + tdl + nbt) * 100) / 100 };
    } else {
      roomRevenue = reservation.rate * nights;
      roomTaxBreakdown = await calculateTaxBreakdown(roomRevenue, {
        propertyId: reservation.propertyId,
        onDate: reservation.checkIn
      });
    }

    // 2. Sum Incidental Charges & Taxes (excluding voided ones)
    let incidentalBase = 0;
    let incidentalSC = 0;
    let incidentalVAT = 0;
    let incidentalTDL = 0;
    let incidentalNBT = 0;

    const activeCharges = reservation.guestCharges.filter(c => !c.isVoid && !(c.chargeType && c.chargeType.name === 'Room Charge'));

    activeCharges.forEach(charge => {
      incidentalBase += charge.amount;
      charge.taxes.forEach(t => {
        if (t.taxType === 'SC') incidentalSC += t.amount;
        if (t.taxType === 'VAT') incidentalVAT += t.amount;
        if (t.taxType === 'TDL') incidentalTDL += t.amount;
        if (t.taxType === 'NBT') incidentalNBT += t.amount;
      });
    });

    // Rounding sums
    incidentalBase = Math.round(incidentalBase * 100) / 100;
    incidentalSC = Math.round(incidentalSC * 100) / 100;
    incidentalVAT = Math.round(incidentalVAT * 100) / 100;
    incidentalTDL = Math.round(incidentalTDL * 100) / 100;
    incidentalNBT = Math.round(incidentalNBT * 100) / 100;

    const incidentalTaxTotal = incidentalSC + incidentalVAT + incidentalTDL + incidentalNBT;
    const incidentalTotal = incidentalBase + incidentalTaxTotal;

    // 3. Payments and Refunds
    const paymentRefundMeta = await Promise.all((reservation.payments || []).map(async (payment) => {
      const refundRows = await prisma.refund.findMany({
        where: {
          paymentId: payment.id,
          status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] },
        },
        select: { amount: true },
      });
      const alreadyRefunded = refundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return {
        ...payment,
        alreadyRefunded,
        refundableAmount: Math.max(Number(payment.amount) - alreadyRefunded, 0),
      };
    }));

    const totalPayments = paymentRefundMeta.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const refundHistory = await prisma.refund.findMany({
      where: { reservationId },
      include: {
        user: { select: { id: true, fullName: true, username: true } },
        payment: true,
      },
      orderBy: { refundDate: 'desc' },
    });
    const totalRefunds = refundHistory.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);

    // 4. Grand Totals
    const grandBase = roomRevenue + incidentalBase;
    const grandSC = roomTaxBreakdown.sc + incidentalSC;
    const grandVAT = roomTaxBreakdown.vat + incidentalVAT;
    const grandTDL = roomTaxBreakdown.tdl + incidentalTDL;
    const grandNBT = roomTaxBreakdown.nbt + incidentalNBT;
    const grandTaxTotal = grandSC + grandVAT + grandTDL + grandNBT;
    const grandTotal = grandBase + grandTaxTotal;

    const netPaid = Math.max(totalPayments - totalRefunds, 0);
    const balanceDue = Math.round((grandTotal - netPaid) * 100) / 100;

    res.json({
      reservation: {
        id: reservation.id,
        confoNo: reservation.confoNo,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        status: reservation.status,
        rate: reservation.rate,
        guest: reservation.guest,
        room: reservation.room,
        travelAgent: reservation.travelAgent,
      },
      nights,
      roomRevenue,
      roomTaxes: {
        sc: roomTaxBreakdown.sc,
        vat: roomTaxBreakdown.vat,
        tdl: roomTaxBreakdown.tdl,
        nbt: roomTaxBreakdown.nbt,
        total: roomTaxBreakdown.sc + roomTaxBreakdown.vat + roomTaxBreakdown.tdl + roomTaxBreakdown.nbt,
      },
      incidentals: {
        charges: reservation.guestCharges,
        base: incidentalBase,
        sc: incidentalSC,
        vat: incidentalVAT,
        tdl: incidentalTDL,
        nbt: incidentalNBT,
        total: incidentalTotal
      },
      payments: paymentRefundMeta,
      refunds: refundHistory,
      totals: {
        base: grandBase,
        sc: grandSC,
        vat: grandVAT,
        tdl: grandTDL,
        nbt: grandNBT,
        tax: grandTaxTotal,
        grandTotal,
        payments: totalPayments,
        refunds: totalRefunds,
        netPaid,
        balance: balanceDue
      }
    });
  } catch (error) {
    console.error('Error compiling folio:', error);
    res.status(500).json({ error: 'Failed to compile folio statement' });
  }
});

const LOCKED_STATUSES = ['checked_out'];

/**
 * PUT /api/reservations/:id
 * General edit: dates, room, rate, guest counts, etc.
 * Blocked once the reservation is checked_out or cancelled.
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      checkIn, checkOut, roomId, adults, children, rate,
      expected_check_in_at: expectedCheckInAtInput,
      expected_check_out_at: expectedCheckOutAtInput,
      expectedCheckInAt,
      expectedCheckOutAt,
      travelAgentId, guaranteedMethodId, marketSegmentId,
      ratePlanId, mealPlanId,
      is_complimentary: isComplimentaryInput,
      isComplimentary,
      complimentary_reason: complimentaryReasonInput,
      complimentaryReason,
    } = req.body;

    const existing = await prisma.reservation.findUnique({ where: { id: Number(id) } });
    if (!existing) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const normalizedExistingStatus = normalizeReservationStatus(existing.status);
    // Validate MealPlan compatibility if RatePlan provided
    try {
      await validateMealPlanCompatibility(ratePlanId, mealPlanId);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }
    if (LOCKED_STATUSES.includes(normalizedExistingStatus)) {
      return res.status(409).json({
        error: `Reservation is ${normalizedExistingStatus.replace('_', ' ')} and can no longer be edited.`,
      });
    }

    const requestedComplimentaryValue = isComplimentaryInput !== undefined ? isComplimentaryInput : isComplimentary;
    const requestedComplimentaryReason = complimentaryReasonInput !== undefined ? complimentaryReasonInput : complimentaryReason;
    const requestedComplimentaryState = validateComplimentaryRequest({
      isComplimentary: requestedComplimentaryValue !== undefined ? requestedComplimentaryValue : existing.isComplimentary,
      complimentaryReason: requestedComplimentaryReason !== undefined ? requestedComplimentaryReason : existing.complimentaryReason,
      existingIsComplimentary: Boolean(existing.isComplimentary),
    });

    // Preserve the legacy date columns while validating exact expected timestamps.
    const existingExpectedCheckInAt = existing.expectedCheckInAt || fallbackExpectedDateTime(existing.checkIn, DEFAULT_EXPECTED_CHECK_IN_TIME);
    const existingExpectedCheckOutAt = existing.expectedCheckOutAt || fallbackExpectedDateTime(existing.checkOut, DEFAULT_EXPECTED_CHECK_OUT_TIME);
    const requestedExpectedCheckInAt = expectedCheckInAtInput || expectedCheckInAt;
    const requestedExpectedCheckOutAt = expectedCheckOutAtInput || expectedCheckOutAt;
    const finalExpectedCheckInAt = requestedExpectedCheckInAt
      ? parseReservationDateTime(requestedExpectedCheckInAt, 'Expected check-in')
      : (checkIn ? combineDateAndTime(checkIn, existingExpectedCheckInAt.toISOString().slice(11, 16)) : existingExpectedCheckInAt);
    const finalExpectedCheckOutAt = requestedExpectedCheckOutAt
      ? parseReservationDateTime(requestedExpectedCheckOutAt, 'Expected check-out')
      : (checkOut ? combineDateAndTime(checkOut, existingExpectedCheckOutAt.toISOString().slice(11, 16)) : existingExpectedCheckOutAt);
    validateExpectedDateRange(finalExpectedCheckInAt, finalExpectedCheckOutAt);
    validateActiveBusinessDateRange(finalExpectedCheckInAt, finalExpectedCheckOutAt);
    const finalCheckIn = combineDateAndTime(datePart(finalExpectedCheckInAt), '00:00');
    const finalCheckOut = combineDateAndTime(datePart(finalExpectedCheckOutAt), '00:00');

    if (finalCheckOut <= finalCheckIn) {
      return res.status(400).json({ error: 'Check-out date must be after check-in date.' });
    }

    // Rule 4: If guest is checked in, the check-in date cannot be changed
    if (normalizedExistingStatus === 'in_house' && (checkIn || requestedExpectedCheckInAt)) {
      const existingCheckInStr = datePart(existing.checkIn);
      const newCheckInStr = datePart(finalExpectedCheckInAt);
      if (existingCheckInStr !== newCheckInStr) {
        return res.status(409).json({ error: 'Cannot change check-in date once guest has checked in.' });
      }
    }

    // Rule 2: Room conflict check
    const finalRoomId = roomId ? Number(roomId) : existing.roomId;
    const conflict = await prisma.reservation.findFirst({
      where: {
        roomId: finalRoomId,
        id: { not: Number(id) },
        status: { notIn: ['cancelled', 'no_show'] },
        checkIn: { lt: finalCheckOut },
        checkOut: { gt: finalCheckIn },
      }
    });
    if (conflict) {
      return res.status(409).json({ error: 'Room is not available for the selected dates' });
    }

    // Rule 5: Recalculate rate if dates changed
    const datesChanged = 
      (checkIn && new Date(checkIn).toISOString().slice(0,10) !== new Date(existing.checkIn).toISOString().slice(0,10)) ||
      (checkOut && new Date(checkOut).toISOString().slice(0,10) !== new Date(existing.checkOut).toISOString().slice(0,10)) ||
      (requestedExpectedCheckInAt && datePart(finalExpectedCheckInAt) !== datePart(existing.checkIn)) ||
      (requestedExpectedCheckOutAt && datePart(finalExpectedCheckOutAt) !== datePart(existing.checkOut)) ||
      (roomId && Number(roomId) !== existing.roomId);

    let finalRate = rate !== undefined ? Number(rate) : undefined;
    if (finalRate === undefined && datesChanged) {
      const targetRoom = await prisma.room.findUnique({
        where: { id: finalRoomId },
        include: { roomType: true }
      });
      if (targetRoom) {
        const agentId = travelAgentId !== undefined ? (travelAgentId ? Number(travelAgentId) : null) : existing.travelAgentId;
        const plan = await prisma.ratePlan.findFirst({
          where: {
            roomTypeId: targetRoom.roomTypeId,
            travelAgentId: agentId,
            startDate: { lte: finalCheckIn },
            endDate: { gte: finalCheckIn },
          }
        });
        if (plan) {
          finalRate = plan.rate;
        } else {
          finalRate = targetRoom.roomType.baseRate;
        }
      }
    }

    // optional: guard against editing a reservation another user has locked for editing
    const lock = await prisma.reservationLock?.findUnique?.({ where: { reservationId: Number(id) } }).catch(() => null);
    if (lock && lock.lockedBy !== req.user?.id) {
      return res.status(423).json({ error: 'Reservation is currently being edited by another user.' });
    }

    const reservation = await prisma.reservation.update({
      where: { id: Number(id) },
      data: {
        ...((checkIn || requestedExpectedCheckInAt) && { checkIn: finalCheckIn }),
        ...((checkOut || requestedExpectedCheckOutAt) && { checkOut: finalCheckOut }),
        ...((checkIn || requestedExpectedCheckInAt) && { expectedCheckInAt: finalExpectedCheckInAt }),
        ...((checkOut || requestedExpectedCheckOutAt) && { expectedCheckOutAt: finalExpectedCheckOutAt }),
        ...(roomId && { roomId: Number(roomId) }),
        ...(adults !== undefined && { adults: Number(adults) }),
        ...(children !== undefined && { children: Number(children) }),
        ...(finalRate !== undefined && { rate: finalRate }),
        ...(travelAgentId !== undefined && { travelAgentId: travelAgentId ? Number(travelAgentId) : null }),
        ...(guaranteedMethodId !== undefined && { guaranteedMethodId: guaranteedMethodId ? Number(guaranteedMethodId) : null }),
        ...(marketSegmentId !== undefined && { marketSegmentId: marketSegmentId ? Number(marketSegmentId) : null }),
        ...(requestedComplimentaryValue !== undefined && {
          isComplimentary: requestedComplimentaryState.isComplimentary,
          complimentaryReason: requestedComplimentaryState.complimentaryReason,
          complimentaryApprovedBy: requestedComplimentaryState.isComplimentary ? (req.user?.id || existing.complimentaryApprovedBy || null) : null,
        }),
      },
      include: { guest: true, room: true, travelAgent: true },
    });

    if (requestedComplimentaryValue !== undefined && Boolean(existing.isComplimentary) !== requestedComplimentaryState.isComplimentary) {
      await logComplimentaryAudit({
        prismaClient: prisma,
        reservationId: Number(id),
        userId: req.user?.id,
        previousState: Boolean(existing.isComplimentary),
        nextState: requestedComplimentaryState.isComplimentary,
        reason: requestedComplimentaryState.complimentaryReason,
      });
    }

    // Rule 6: Log the change
    try {
      if (prisma.auditLog && req.user?.id) {
        await prisma.auditLog.create({
          data: {
            tableName: 'reservations',
            recordId: Number(id),
            action: 'update',
            changedBy: req.user.id,
            beforeData: { checkIn: existing.checkIn, checkOut: existing.checkOut },
            afterData: { checkIn: reservation.checkIn, checkOut: reservation.checkOut }
          }
        });
      }
    } catch (auditErr) {
      console.warn('Could not write audit log:', auditErr);
    }

    return res.json(reservation);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    console.error('[PUT /api/reservations/:id] error:', err);
    return res.status(500).json({ error: 'Failed to update reservation' });
  }
});

async function getFolioBalance(reservationId) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      payments: true,
      refunds: true,
      guestCharges: {
        where: { isVoid: false },
        include: { taxes: true, chargeType: true }
      }
    }
  });

  if (!reservation) return 0;

  // 1. Calculate Room Revenue & Taxes
  const checkInDate = new Date(reservation.checkIn);
  const checkOutDate = new Date(reservation.checkOut);
  const diffTime = Math.abs(checkOutDate - checkInDate);
  const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;

  // If explicit Room Charge guestCharges exist, derive room totals from them. Otherwise fall back to reservation.rate * nights
  const roomChargeEntries = reservation.guestCharges.filter(c => !c.isVoid && c.chargeType && c.chargeType.name === 'Room Charge');
  let roomRevenue = 0;
  let roomTaxTotal = 0;
  if (roomChargeEntries.length > 0) {
    roomRevenue = roomChargeEntries.reduce((sum, c) => sum + (c.amount || 0), 0);
    roomChargeEntries.forEach(c => {
      (c.taxes || []).forEach(t => { roomTaxTotal += t.amount || 0; });
    });
    // round
    roomRevenue = Math.round(roomRevenue * 100) / 100;
    roomTaxTotal = Math.round(roomTaxTotal * 100) / 100;
  } else {
    roomRevenue = reservation.rate * nights;
    const { calculateTaxBreakdown } = require('../services/taxInvoiceService');
    const roomTaxBreakdown = await calculateTaxBreakdown(roomRevenue, {
      propertyId: reservation.propertyId,
      onDate: reservation.checkIn
    });
    roomTaxTotal = roomTaxBreakdown.sc + roomTaxBreakdown.vat + roomTaxBreakdown.tdl + roomTaxBreakdown.nbt;
  }
  const roomTotal = Math.round((roomRevenue + roomTaxTotal) * 100) / 100;

  // 2. Sum Incidental Charges & Taxes
  let incidentalTotal = 0;
  reservation.guestCharges.forEach(charge => {
    // exclude room charges as those are accounted above
    if (charge.chargeType && charge.chargeType.name === 'Room Charge') return;
    const taxes = charge.taxes || [];
    const taxSum = taxes.reduce((s, t) => s + (t.amount || 0), 0);
    const taxableSumAvailable = taxes.length > 0 && taxes.every(t => typeof t.taxableAmount === 'number');
    const taxableSum = taxableSumAvailable ? taxes.reduce((s, t) => s + (t.taxableAmount || 0), 0) : null;
    if (taxableSumAvailable && Math.abs((taxableSum + taxSum) - charge.amount) < 0.01) {
      // charge.amount already contains taxes (gross). Use it as the line gross amount.
      incidentalTotal += charge.amount;
    } else {
      // charge.amount is treated as net (tax-exclusive)
      incidentalTotal += charge.amount + taxSum;
    }
  });
  incidentalTotal = Math.round(incidentalTotal * 100) / 100;

  // 3. Sum deposits if table exists
  let depositsTotal = 0;
  try {
    if (prisma.reservationDeposit) {
      const deposits = await prisma.reservationDeposit.findMany({
        where: { reservationId, isRefunded: false }
      });
      depositsTotal = deposits.reduce((sum, d) => sum + d.amount, 0);
    }
  } catch (e) {
    // Ignore if model doesn't exist
  }

  // 4. Payments and refunds
  const totalPaid = reservation.payments.reduce((sum, p) => sum + p.amount, 0) + depositsTotal;
  const totalRefunded = (reservation.refunds || []).reduce((sum, refund) => sum + Number(refund.amount || 0), 0);

  // 5. Balance
  const totalCharges = roomTotal + incidentalTotal;
  const netPaid = Math.max(totalPaid - totalRefunded, 0);
  return Math.round((totalCharges - netPaid) * 100) / 100;
}

// Generate PDF invoice for reservation
router.get('/:id/invoice/pdf', async (req, res) => {
  const reservationId = parseInt(req.params.id);
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        guest: true,
        room: { include: { roomType: true } },
        travelAgent: true,
        payments: true,
        guestCharges: { include: { taxes: true, chargeType: true } }
      }
    });

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

    // Calculate nights and room revenue
    const checkInDate = new Date(reservation.checkIn);
    const checkOutDate = new Date(reservation.checkOut);
    const diffTime = Math.abs(checkOutDate - checkInDate);
    const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
    const roomRevenue = reservation.rate * nights;

    const roomTaxBreakdown = await calculateTaxBreakdown(roomRevenue, { propertyId: reservation.propertyId, onDate: reservation.checkIn });

    // Incidental charges (excluding voids)
    let incidentalBase = 0;
    let incidentalSC = 0;
    let incidentalVAT = 0;
    let incidentalTDL = 0;
    let incidentalNBT = 0;
    const activeCharges = reservation.guestCharges.filter(c => !c.isVoid && c.chargeType?.name !== 'Room Charge');
    activeCharges.forEach(charge => {
      const taxes = charge.taxes || [];
      const taxSum = taxes.reduce((s, t) => s + (t.amount || 0), 0);
      const taxableSumAvailable = taxes.length > 0 && taxes.every(t => typeof t.taxableAmount === 'number');
      const taxableSum = taxableSumAvailable ? taxes.reduce((s, t) => s + (t.taxableAmount || 0), 0) : null;
      if (taxableSumAvailable && Math.abs((taxableSum + taxSum) - charge.amount) < 0.01) {
        // amount already includes taxes (gross). Use taxableSum as base for reporting and keep taxes separate.
        incidentalBase += taxableSum;
      } else {
        // amount is net (tax-exclusive)
        incidentalBase += charge.amount;
      }
      taxes.forEach(t => {
        if (t.taxType === 'SC') incidentalSC += t.amount;
        if (t.taxType === 'VAT') incidentalVAT += t.amount;
        if (t.taxType === 'TDL') incidentalTDL += t.amount;
        if (t.taxType === 'NBT') incidentalNBT += t.amount;
      });
    });

    incidentalBase = Math.round(incidentalBase * 100) / 100;
    incidentalSC = Math.round(incidentalSC * 100) / 100;
    incidentalVAT = Math.round(incidentalVAT * 100) / 100;
    incidentalTDL = Math.round(incidentalTDL * 100) / 100;
    incidentalNBT = Math.round(incidentalNBT * 100) / 100;

    const incidentalTaxTotal = incidentalSC + incidentalVAT + incidentalTDL + incidentalNBT;
    const incidentalTotal = incidentalBase + incidentalTaxTotal;

    const totalPayments = reservation.payments.reduce((s, p) => s + p.amount, 0);

    const grandBase = roomRevenue + incidentalBase;
    const grandSC = roomTaxBreakdown.sc + incidentalSC;
    const grandVAT = roomTaxBreakdown.vat + incidentalVAT;
    const grandTDL = roomTaxBreakdown.tdl + incidentalTDL;
    const grandNBT = roomTaxBreakdown.nbt + incidentalNBT;
    const grandTaxTotal = grandSC + grandVAT + grandTDL + grandNBT;
    const grandTotal = grandBase + grandTaxTotal;

    // Build simple HTML for the invoice
    const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Tax Invoice ${reservation.confoNo}</title>
        <style>
          @page { size: A4; margin: 20mm; }
          body { font-family: Arial, Helvetica, sans-serif; color: #111; }
          .container { max-width: 800px; margin: 0 auto; padding: 12px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #eee; }
          .totals { margin-top: 12px; }
          .totals .row { display:flex; justify-content:space-between; padding:4px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Ella Hotel — Tax Invoice</h1>
          <p><strong>Confirmation:</strong> ${reservation.confoNo}</p>
          <p><strong>Guest:</strong> ${reservation.guest?.fullName || ''}</p>
          <p><strong>Room:</strong> ${reservation.room?.roomNumber || ''} ${reservation.room?.roomType?.typeName ? '('+reservation.room.roomType.typeName+')' : ''}</p>
          <p><strong>Period:</strong> ${new Date(reservation.checkIn).toLocaleDateString()} - ${new Date(reservation.checkOut).toLocaleDateString()} (${nights} night(s))</p>

          <table>
            <thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th></tr></thead>
            <tbody>
              <tr>
                <td>Room Charges</td>
                <td style="text-align:right">${nights}</td>
                <td style="text-align:right">${(roomRevenue / nights).toLocaleString()}</td>
                <td style="text-align:right">${roomRevenue.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          ${activeCharges.length > 0 ? `
            <h3 style="margin-top:16px;">Incidental Charges</h3>
            <table>
              <thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th></tr></thead>
              <tbody>
                ${activeCharges.map(charge => {
                  const taxes = charge.taxes || [];
                  const taxSum = taxes.reduce((s, t) => s + (t.amount || 0), 0);
                  const taxableSumAvailable = taxes.length > 0 && taxes.every(t => typeof t.taxableAmount === 'number');
                  const taxableSum = taxableSumAvailable ? taxes.reduce((s, t) => s + (t.taxableAmount || 0), 0) : null;
                  let lineTotal;
                  if (taxableSumAvailable && Math.abs((taxableSum + taxSum) - charge.amount) < 0.01) {
                    // charge.amount already gross
                    lineTotal = Math.round(charge.amount * 100) / 100;
                  } else {
                    lineTotal = Math.round((charge.amount + taxSum) * 100) / 100;
                  }
                  return `<tr><td>${charge.chargeType?.name || 'Charge'}${charge.description ? ' - ' + charge.description : ''}</td><td style="text-align:right">1</td><td style="text-align:right">${charge.amount.toLocaleString()}</td><td style="text-align:right">${lineTotal.toLocaleString()}</td></tr>`;
                }).join('') }
              </tbody>
            </table>
          ` : ''}

          <div class="totals">
            <div class="row"><span>Room Revenue:</span><span>LKR ${roomRevenue.toLocaleString()}</span></div>
            <div class="row"><span>Service Charge (SC):</span><span>LKR ${roomTaxBreakdown.sc.toLocaleString()}</span></div>
            <div class="row"><span>VAT:</span><span>LKR ${roomTaxBreakdown.vat.toLocaleString()}</span></div>
            <div class="row"><span>TDL:</span><span>LKR ${roomTaxBreakdown.tdl.toLocaleString()}</span></div>
            <div class="row"><span>NBT:</span><span>LKR ${roomTaxBreakdown.nbt.toLocaleString()}</span></div>
            <div class="row" style="font-weight:bold; border-top:1px solid #ddd; padding-top:8px;"><span>Total Amount:</span><span>LKR ${grandTotal.toLocaleString()}</span></div>
            <div class="row"><span>Payments:</span><span>LKR ${totalPayments.toLocaleString()}</span></div>
            <div class="row"><span>Balance Due:</span><span>LKR ${(grandTotal - totalPayments).toLocaleString()}</span></div>
          </div>

          <p style="margin-top:16px; font-size:11px; color:#666">This is a computer generated invoice.</p>
        </div>
      </body>
      </html>`;

    // Save generated HTML for debugging (helps verify incidental lines before PDF render)
    try {
      const path = require('path');
      const tmpDir = path.join(__dirname, '../../tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const savePath = path.join(tmpDir, `invoice_${reservationId}.html`);
      fs.writeFileSync(savePath, html, 'utf8');
      console.log('Saved invoice HTML to', savePath);
    } catch (e) {
      console.warn('Failed to save invoice HTML for debugging:', e);
    }

    // If requested, return the raw HTML for debugging
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // Render PDF using shared browser instance
    const rawPdf = await renderPdfFromHtml(html, { format: 'A4', printBackground: true });
    // Ensure we send a proper Node Buffer (avoid sending typed-array or object that would be JSON-serialized)
    const pdfBuffer = Buffer.isBuffer(rawPdf) ? rawPdf : Buffer.from(rawPdf);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice_${reservationId}.pdf`);
    res.setHeader('Content-Length', pdfBuffer.length);
    console.log(`Generated PDF for reservation ${reservationId}, size=${pdfBuffer.length} bytes`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF invoice:', error);
    return res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

// ADMIN FORCE COMPLETE endpoint (admin only)
router.post('/:id/force-complete', authenticateToken, requireRole(['admin']), async (req, res) => {
  const reservationId = parseInt(req.params.id);
  const { reason } = req.body;
  // Validate reason
  if (typeof reason !== 'string') {
    return res.status(400).json({ error: 'Reason must be a string' });
  }
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return res.status(400).json({ error: 'Reason is required' });
  }
  if (trimmedReason.length > 200) {
    return res.status(400).json({ error: 'Reason must not exceed 200 characters' });
  }
  try {
    const updated = await sm.forceCompleteReservation(reservationId, { userId: req.user.id, reason: trimmedReason });
    res.json(updated);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Force complete failed' });
  }
});

// DEDICATED EARLY CHECKOUT endpoint
router.post('/:id/early-checkout', authenticateToken, async (req, res) => {
  const reservationId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const updated = await sm.performEarlyCheckout(reservationId, { userId: req.user.id, reason });
    res.json(updated);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Early checkout failed' });
  }
});

// DEDICATED CANCEL endpoint
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  const reservationId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const updated = await sm.cancelReservation(reservationId, { userId: req.user.id, reason });
    res.json(updated);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Cancellation failed' });
  }
});

// DEDICATED NO-SHOW endpoint
router.post('/:id/no-show', authenticateToken, async (req, res) => {
  const reservationId = parseInt(req.params.id);
  try {
    const updated = await sm.markNoShow(reservationId, { userId: req.user.id });
    res.json(updated);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'No-show marking failed' });
  }
});

module.exports = router;
