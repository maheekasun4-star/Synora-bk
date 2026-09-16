-- AlterTable: add clean_status to rooms (housekeeping readiness flag)
ALTER TABLE `rooms` ADD COLUMN `clean_status` ENUM('dirty', 'cleaning_in_progress', 'clean', 'inspected', 'out_of_service') NOT NULL DEFAULT 'dirty';

-- Backfill clean_status from the existing housekeeping status so check-in is not
-- blocked for rooms that are currently ready. Without this, every room would
-- default to 'dirty' and no room could be checked in until manually re-cleaned.
UPDATE `rooms` SET `clean_status` = 'clean' WHERE `status` IN ('available', 'clean');
UPDATE `rooms` SET `clean_status` = 'inspected' WHERE `status` = 'occupied';
UPDATE `rooms` SET `clean_status` = 'dirty' WHERE `status` = 'dirty';
UPDATE `rooms` SET `clean_status` = 'out_of_service' WHERE `status` = 'maintenance';

-- CreateTable
CREATE TABLE `housekeeping_staff` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NULL,
    `name` VARCHAR(100) NOT NULL,
    `phone` VARCHAR(30) NULL,
    `shift` VARCHAR(30) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `housekeeping_tasks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `room_id` INTEGER NOT NULL,
    `staff_id` INTEGER NULL,
    `task_type` ENUM('checkout_clean', 'stayover_clean', 'turndown', 'deep_clean', 'inspection') NOT NULL,
    `scheduled_for` DATE NOT NULL,
    `started_at` TIMESTAMP(0) NULL,
    `completed_at` TIMESTAMP(0) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `notes` VARCHAR(255) NULL,
    `created_by` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `housekeeping_checklist_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `task_id` INTEGER NOT NULL,
    `label` VARCHAR(150) NOT NULL,
    `is_checked` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `housekeeping_attendance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `staff_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `clock_in` TIMESTAMP(0) NULL,
    `clock_out` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `housekeeping_staff` ADD CONSTRAINT `housekeeping_staff_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `housekeeping_tasks` ADD CONSTRAINT `housekeeping_tasks_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `housekeeping_tasks` ADD CONSTRAINT `housekeeping_tasks_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `housekeeping_staff` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `housekeeping_tasks` ADD CONSTRAINT `housekeeping_tasks_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `housekeeping_checklist_items` ADD CONSTRAINT `housekeeping_checklist_items_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `housekeeping_tasks` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `housekeeping_attendance` ADD CONSTRAINT `housekeeping_attendance_staff_id_fkey` FOREIGN KEY (`staff_id`) REFERENCES `housekeeping_staff` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX `housekeeping_attendance_staff_id_date_key` ON `housekeeping_attendance`(`staff_id`, `date`);
