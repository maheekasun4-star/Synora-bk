const bcrypt = require('bcryptjs');
const { seedRbac } = require('../src/services/rbac');

const prisma = require('../src/prismaClient');

async function main() {
  console.log('Seeding database...');
  // 1. Create Users
  const adminPasswordHash = await bcrypt.hash('123', 10);
  const foPasswordHash = await bcrypt.hash('123', 10);
  const cashierPasswordHash = await bcrypt.hash('123', 10);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: { passwordHash: adminPasswordHash, isActive: true },
    create: {
      username: 'admin',
      passwordHash: adminPasswordHash,
      fullName: 'Administrator User',
      role: 'admin',
    },
  });

  const fo = await prisma.user.upsert({
    where: { username: 'fo' },
    update: { passwordHash: foPasswordHash, isActive: true },
    create: {
      username: 'fo',
      passwordHash: foPasswordHash,
      fullName: 'Front Office Agent',
      role: 'front_office',
    },
  });

  const cashier = await prisma.user.upsert({
    where: { username: 'cashier' },
    update: { passwordHash: cashierPasswordHash, isActive: true },
    create: {
      username: 'cashier',
      passwordHash: cashierPasswordHash,
      fullName: 'Cashier Staff',
      role: 'cashier',
    },
  });

  console.log('Users created/updated.');
  await seedRbac();
  console.log('Roles and permissions created/updated.');

  // Delete existing data to prevent unique constraints during seeding if rerun
  await prisma.guestChargeTax.deleteMany({});
  await prisma.guestCharge.deleteMany({});
  await prisma.chargeType.deleteMany({});
  await prisma.taxConfig.deleteMany({});
  await prisma.ratePlan.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.travelAgentTaxInvoice.deleteMany({});
  await prisma.reservation.deleteMany({});
  await prisma.room.deleteMany({});
  await prisma.floor.deleteMany({});
  await prisma.roomType.deleteMany({});
  await prisma.guest.deleteMany({});
  await prisma.travelAgent.deleteMany({});

  // 2. Create Room Types
  const deluxeType = await prisma.roomType.create({
    data: {
      typeName: 'Deluxe Room',
      maxOccupancy: 3,
      baseRate: 15000.0, // base rate in LKR
    },
  });

  const standardType = await prisma.roomType.create({
    data: {
      typeName: 'Standard Room',
      maxOccupancy: 2,
      baseRate: 10000.0, // LKR
    },
  });

  const suiteType = await prisma.roomType.create({
    data: {
      typeName: 'Suite Room',
      maxOccupancy: 4,
      baseRate: 25000.0, // LKR
    },
  });

  console.log('Room Types created.');

  // Seed default meal plans (if not present)
  const mpRO = await prisma.mealPlan.upsert({
    where: { code: 'RO' },
    update: {},
    create: { code: 'RO', name: 'Room Only', description: 'Room accommodation only, no meals.', breakfastIncluded: false, lunchIncluded: false, dinnerIncluded: false },
  });
  const mpBB = await prisma.mealPlan.upsert({
    where: { code: 'BB' },
    update: {},
    create: { code: 'BB', name: 'Bed & Breakfast', description: 'Breakfast included.', breakfastIncluded: true },
  });
  const mpHB = await prisma.mealPlan.upsert({
    where: { code: 'HB' },
    update: {},
    create: { code: 'HB', name: 'Half Board', description: 'Breakfast plus Lunch or Dinner.', breakfastIncluded: true },
  });
  const mpFB = await prisma.mealPlan.upsert({
    where: { code: 'FB' },
    update: {},
    create: { code: 'FB', name: 'Full Board', description: 'Breakfast, Lunch and Dinner included.', breakfastIncluded: true, lunchIncluded: true, dinnerIncluded: true },
  });
  const mpAI = await prisma.mealPlan.upsert({
    where: { code: 'AI' },
    update: {},
    create: { code: 'AI', name: 'All Inclusive', description: 'All meals plus drinks and snacks included.', breakfastIncluded: true, lunchIncluded: true, dinnerIncluded: true, drinksIncluded: true, snacksIncluded: true },
  });

  console.log('Meal plans seeded.');

  // 3. Create Floors & Rooms
  const groundFloor = await prisma.floor.create({
    data: { floorName: 'Ground Floor', floorNumber: 0 },
  });
  const firstFloor = await prisma.floor.create({
    data: { floorName: '1st Floor', floorNumber: 1 },
  });
  const secondFloor = await prisma.floor.create({
    data: { floorName: '2nd Floor', floorNumber: 2 },
  });
  console.log('Floors created.');

  const roomData = [
    { roomNumber: '101', roomTypeId: standardType.id, floorId: groundFloor.id, status: 'available' },
    { roomNumber: '102', roomTypeId: standardType.id, floorId: groundFloor.id, status: 'available' },
    { roomNumber: '103', roomTypeId: standardType.id, floorId: groundFloor.id, status: 'dirty' },
    { roomNumber: '104', roomTypeId: deluxeType.id, floorId: groundFloor.id, status: 'available' },
    { roomNumber: '105', roomTypeId: deluxeType.id, floorId: groundFloor.id, status: 'maintenance' },
    { roomNumber: '201', roomTypeId: deluxeType.id, floorId: firstFloor.id, status: 'available' },
    { roomNumber: '202', roomTypeId: deluxeType.id, floorId: firstFloor.id, status: 'available' },
    { roomNumber: '203', roomTypeId: suiteType.id, floorId: firstFloor.id, status: 'available' },
    { roomNumber: '204', roomTypeId: suiteType.id, floorId: firstFloor.id, status: 'available' },
  ];

  for (const r of roomData) {
    await prisma.room.create({
      data: r,
    });
  }

  console.log('Rooms created.');

  // 4. Create Travel Agents
  const agent1 = await prisma.travelAgent.create({
    data: {
      agentName: 'AeroTravel Sri Lanka',
      contactPerson: 'Mr. Perera',
      phone: '+94 11 234 5678',
      email: 'booking@aerotravel.lk',
      commissionRate: 10.0,
    },
  });

  const agent2 = await prisma.travelAgent.create({
    data: {
      agentName: 'Aman Holiday Services',
      contactPerson: 'Mrs. Silva',
      phone: '+94 77 123 4567',
      email: 'reservations@amanholidays.com',
      commissionRate: 12.5,
    },
  });

  console.log('Travel agents created.');

  // 5. Create Seasonal / Agent Rate Plans
  const today = new Date();
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  // Standard room seasonal rate plan
  await prisma.ratePlan.create({
    data: {
      roomTypeId: standardType.id,
      travelAgentId: null,
      rate: 12000.0,
      startDate: today,
      endDate: nextMonth,
    },
  });

  // AeroTravel specific rate plan for Deluxe rooms
  await prisma.ratePlan.create({
    data: {
      roomTypeId: deluxeType.id,
      travelAgentId: agent1.id,
      rate: 13000.0,
      startDate: today,
      endDate: nextMonth,
    },
  });

  // Aman Holiday specific rate plan for Suite rooms
  await prisma.ratePlan.create({
    data: {
      roomTypeId: suiteType.id,
      travelAgentId: agent2.id,
      rate: 22000.0,
      startDate: today,
      endDate: nextMonth,
    },
  });

  console.log('Rate plans created.');

  // 6. Create a couple of guests to start with
  const guest1 = await prisma.guest.create({
    data: {
      fullName: 'John Doe',
      phone: '+1 555 0199',
      email: 'john.doe@example.com',
      nationality: 'American',
      idPassportNo: 'N1234567',
      address: '123 Pine St, Seattle, WA',
    },
  });

  const guest2 = await prisma.guest.create({
    data: {
      fullName: 'Nimal Fernando',
      phone: '+94 71 999 8888',
      email: 'nimal@gmail.com',
      nationality: 'Sri Lankan',
      idPassportNo: '951234567V',
      address: '45 Galle Road, Colombo 03',
    },
  });

  console.log('Guests created.');

  // 7. Create default tax configs
  await prisma.taxConfig.createMany({
    data: [
      { taxType: 'SC', rate: 0.10, compoundOn: 'room_revenue', effectiveFrom: new Date('2020-01-01') },
      { taxType: 'VAT', rate: 0.18, compoundOn: 'room_revenue_plus_sc', effectiveFrom: new Date('2020-01-01') },
      { taxType: 'TDL', rate: 0.01, compoundOn: 'room_revenue', effectiveFrom: new Date('2020-01-01') },
      { taxType: 'NBT', rate: 0.02, compoundOn: 'room_revenue', effectiveFrom: new Date('2020-01-01') },
    ]
  });
  console.log('Tax configurations created.');

  // 8. Create default charge types
  await prisma.chargeType.createMany({
    data: [
      { name: 'Room Charge', defaultAccount: '580001' },
      { name: 'Food & Beverage', defaultAccount: '580002' },
      { name: 'Laundry', defaultAccount: '580003' },
      { name: 'Minibar', defaultAccount: '580004' },
      { name: 'Telephone', defaultAccount: '580005' },
      { name: 'Parking', defaultAccount: '580006' },
      { name: 'Spa', defaultAccount: '580007' },
      { name: 'Room Service', defaultAccount: '580008' },
      { name: 'Extra Bed', defaultAccount: '580009' },
      { name: 'Internet', defaultAccount: '580010' },
      { name: 'Damage', defaultAccount: '580011' },
      { name: 'Miscellaneous', defaultAccount: '580012' },
    ]
  });
  console.log('Charge types created.');

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
