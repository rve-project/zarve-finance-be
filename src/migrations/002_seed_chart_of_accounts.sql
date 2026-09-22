-- Starter chart of accounts, mirrored from the account codes/names actually seen in
-- the client's "Data Odoo Report 1.xlsx" export (Balance Sheet / P&L / Trial Balance
-- sheets), so imported data lands on accounts the client already recognizes. This is
-- a starting set, not exhaustive -- add more accounts via the accounts API as needed.

INSERT INTO accounts (code, name, type) VALUES
-- Assets: cash & bank
('1101001', 'Kas Kecil (Petty Cash)', 'asset'),
('1101002', 'Undeposited Funds', 'asset'),
('1101003', 'Gopay', 'asset'),
('1111001', 'Bank BCA', 'asset'),
('1111002', 'Bank Mandiri', 'asset'),
('1111003', 'Bank Danamon', 'asset'),
('1112', 'Transfer Antar Rekening', 'asset'),
-- Assets: receivables
('1201', 'Piutang Usaha', 'asset'),
('1202', 'Piutang Karyawan / Driver', 'asset'),
('1203', 'Piutang Denda Tilang (ETLE)', 'asset'),
('1204', 'Piutang Lain-lain', 'asset'),
('1205', 'Piutang Pihak Ketiga', 'asset'),
-- Assets: prepaid / fixed assets
('1303', 'Pajak Dibayar Dimuka - PPh 23', 'asset'),
('1401', 'Biaya Dibayar Dimuka', 'asset'),
('1501', 'Kendaraan', 'asset'),
('1502', 'Akumulasi Penyusutan - Kendaraan', 'asset'),
('1511', 'Peralatan dan Inventaris Kantor', 'asset'),
('1512', 'Akumulasi Penyusutan - Peralatan', 'asset'),
('1701', 'Deposit Sewa Kendaraan', 'asset'),
('1702', 'Uang Muka Pembelian Aset', 'asset'),
('1992', 'Outstanding Payments', 'asset'),
('1993', 'Outstanding Receipts', 'asset'),
('1994', 'Bank Suspense Account', 'asset'),
-- Liabilities
('2101', 'Utang Usaha', 'liability'),
('2302', 'Utang Pajak - PPh Pasal 23', 'liability'),
('2503', 'Deposit Jaminan Mitra', 'liability'),
('2506', 'Cadangan Fee Referral', 'liability'),
('2507', 'Cadangan THR Driver', 'liability'),
-- Equity
('3101', 'Modal Disetor', 'equity'),
('3102', 'Laba Ditahan', 'equity'),
-- Income
('410101', 'Pendapatan Sewa Innova', 'income'),
('410102', 'Pendapatan Sewa Denza D9', 'income'),
('410103', 'Pendapatan Sewa Kendaraan Lainnya', 'income'),
('4105', 'Pendapatan Surcharge', 'income'),
('4106', 'Pendapatan Administrasi Driver', 'income'),
('4107', 'Potongan & Kompensasi Sewa', 'income'),
-- Expenses
('5101', 'Beban Gaji dan Upah', 'expense'),
('5105', 'Beban Insentif Koordinator Lapangan', 'expense'),
('5201', 'Beban Bahan Bakar dan Pengisian Daya (Charging)', 'expense'),
('5202', 'Beban Perawatan dan Servis Kendaraan', 'expense'),
('5203', 'Beban Asuransi Kendaraan', 'expense'),
('5204', 'Beban Pajak Kendaraan Bermotor (PKB/KIR)', 'expense'),
('5205', 'Beban Penyusutan Kendaraan', 'expense'),
('5206', 'Beban Logistik dan Mobilisasi Unit', 'expense'),
('5207', 'Beban Sewa Kendaraan Pihak Ketiga', 'expense'),
('5208', 'Beban Parkir dan Tol', 'expense'),
('5301', 'Beban Sewa Gedung / Kantor', 'expense'),
('5302', 'Beban Listrik', 'expense'),
('5313', 'Beban Renovasi dan Perbaikan Gedung/Kantor', 'expense');
