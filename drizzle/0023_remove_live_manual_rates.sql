-- GHS and YellowCard currencies are priced live with the admin's buffer; their old manual rates go
DELETE FROM "exchange_rates"
WHERE "from_currency" IN ('GHS','KES','XAF','ZAR','TZS','UGX','XOF','RWF','BWP','ZMW','MWK','CDF')
   OR "to_currency" IN ('GHS','KES','XAF','ZAR','TZS','UGX','XOF','RWF','BWP','ZMW','MWK','CDF');
