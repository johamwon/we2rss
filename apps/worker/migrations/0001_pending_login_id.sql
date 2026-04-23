-- Migration: add pending_login_id to accounts for cross-cron login polling
ALTER TABLE accounts ADD COLUMN pending_login_id TEXT;
