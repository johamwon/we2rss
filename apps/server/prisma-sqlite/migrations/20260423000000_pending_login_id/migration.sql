-- AlterTable: add pending_login_id to support cross-cron login polling
ALTER TABLE "accounts" ADD COLUMN "pending_login_id" TEXT;
