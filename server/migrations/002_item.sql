-- "note (optional)" was never the right shape: every purchase IS a thing you
-- bought, so it gets a name, not an afterthought. Rename rather than add, so
-- existing entries keep whatever text they already had.
ALTER TABLE entries RENAME COLUMN note TO item;
