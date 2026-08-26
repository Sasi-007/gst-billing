-- Allow weekly settlement cycle in credit ledger

ALTER TABLE credit_accounts
  DROP CONSTRAINT IF EXISTS credit_accounts_settlement_cycle_check;

ALTER TABLE credit_accounts
  ADD CONSTRAINT credit_accounts_settlement_cycle_check
  CHECK (settlement_cycle IN ('daily', 'weekly', 'monthly'));
