/**
 * One-off correction for invoices posted by the Zarve sync (zarveSync.controller.ts)
 * before `ZERO_BILL_STATUSES` existed (see zarveSync.ts). Those invoices summed
 * `total` from every matching DAILY invoice in the Zarve mirror, including
 * COMPLIMENTARY ("Gratis / Internal", Zarve itself zeroes the revenue) and VOID
 * (cancelled) ones -- both report their original `total` with `amountPaid` 0, so they
 * were posted here as real, uncollectable receivables.
 *
 * This script re-derives each recap invoice's correct total the same way
 * invoices.controller.ts's `get` reconstructs its source invoices (driver name +
 * vehicle plate + invoice month, capped by whichever is earlier: end of that month or
 * the recap's own created_at), then:
 *   - only touches an invoice whose current line amount matches the *uncorrected* sum
 *     over that exact window (i.e. provably produced by the old sync logic) -- anything
 *     else (manual invoices, partial data, already-corrected rows) is left untouched
 *     and reported separately for manual review;
 *   - reduces the invoice's single DAILY line and total_amount by the
 *     COMPLIMENTARY/VOID amount;
 *   - reduces the matching journal entry's AR debit and income credit lines by the same
 *     amount, keeping the entry balanced.
 * No `payments` rows exist for COMPLIMENTARY/VOID days (zarveSync.ts's dailyAmounts
 * only records days with a non-zero payment), so nothing there needs touching -- this
 * purely removes the phantom receivable.
 *
 * Usage:
 *   npx tsx src/scripts/fixComplimentaryRecap.ts            # dry run, prints the plan
 *   npx tsx src/scripts/fixComplimentaryRecap.ts --apply     # applies the corrections
 */
import { pool } from "../db";
import { ZERO_BILL_STATUSES } from "../utils/zarveSync";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const [invoiceRows] = await pool.query(
    `SELECT i.id, i.number, i.invoice_date, i.created_at, i.ref, i.total_amount,
       p.name AS partner_name, v.plate_number AS vehicle_plate_number,
       il.id AS line_id, il.amount AS line_amount, il.tax_rate AS line_tax_rate
     FROM invoices i
     JOIN partners p ON p.id = i.partner_id
     LEFT JOIN vehicles v ON v.id = i.vehicle_id
     JOIN invoice_lines il ON il.invoice_id = i.id AND il.category = 'DAILY'
     WHERE i.id NOT IN (SELECT invoice_id FROM invoice_lines GROUP BY invoice_id HAVING COUNT(*) > 1)`
  );

  type Fix = {
    invoiceId: number;
    number: string;
    lineId: number;
    oldAmount: number;
    newAmount: number;
    oldTotal: number;
    newTotal: number;
    newTaxAmount: number;
    excludedCount: number;
    excludedTotal: number;
  };
  const fixes: Fix[] = [];
  const skippedMismatch: { number: string; lineAmount: number; sumAll: number }[] = [];
  const alreadyClean: string[] = [];

  for (const row of invoiceRows as any[]) {
    const [sourceRows] = await pool.query(
      `SELECT zi.total, zi.status
       FROM zarve_invoices zi
       WHERE zi.driver_name = ?
         AND REPLACE(UPPER(zi.vehicle_plate), ' ', '') = REPLACE(UPPER(?), ' ', '')
         AND zi.type = 'DAILY'
         AND zi.invoice_date >= DATE_FORMAT(?, '%Y-%m-01')
         AND zi.invoice_date <= LEAST(LAST_DAY(?), DATE(?))`,
      [row.partner_name, row.ref ?? row.vehicle_plate_number ?? "", row.invoice_date, row.invoice_date, row.created_at]
    );
    const matched = sourceRows as { total: string | number; status: string }[];
    if (!matched.length) continue; // not a Zarve-sync recap invoice (or no window match) -- leave alone

    const sumAll = round2(matched.reduce((s, r) => s + Number(r.total), 0));
    const excluded = matched.filter((r) => ZERO_BILL_STATUSES.includes(r.status));
    const excludedTotal = round2(excluded.reduce((s, r) => s + Number(r.total), 0));
    const lineAmount = round2(Number(row.line_amount));

    if (Math.abs(sumAll - lineAmount) > 0.01) {
      // Line amount doesn't match the uncorrected sum over this exact window -- could be
      // a manual invoice, an already-corrected one, or a window that doesn't line up.
      // Don't touch it; surface it for a human to check instead.
      skippedMismatch.push({ number: row.number, lineAmount, sumAll });
      continue;
    }

    if (excludedTotal <= 0.01) {
      alreadyClean.push(row.number); // matched the window exactly and nothing to exclude
      continue;
    }

    const newAmount = round2(lineAmount - excludedTotal);
    const taxRate = Number(row.line_tax_rate) || 0;
    const newTaxAmount = round2(newAmount * taxRate);
    const newTotal = round2(newAmount + newTaxAmount);

    fixes.push({
      invoiceId: row.id,
      number: row.number,
      lineId: row.line_id,
      oldAmount: lineAmount,
      newAmount,
      oldTotal: round2(Number(row.total_amount)),
      newTotal,
      newTaxAmount,
      excludedCount: excluded.length,
      excludedTotal,
    });
  }

  console.log(`Recap invoices scanned matching a Zarve window: fixable=${fixes.length}, already clean=${alreadyClean.length}, needs manual review=${skippedMismatch.length}\n`);

  if (skippedMismatch.length) {
    console.log("-- Needs manual review (line amount doesn't match any clean derivation) --");
    for (const s of skippedMismatch) {
      console.log(`  ${s.number}: line amount ${s.lineAmount}, window sum ${s.sumAll}`);
    }
    console.log();
  }

  let totalDiff = 0;
  for (const f of fixes) {
    totalDiff += f.oldTotal - f.newTotal;
    console.log(
      `${f.number}: total_amount ${f.oldTotal} -> ${f.newTotal} (excluding ${f.excludedCount} complimentary/void invoice(s) worth ${f.excludedTotal})`
    );
  }
  console.log(`\nTotal reduction across ${fixes.length} invoice(s): ${round2(totalDiff)}`);

  if (!apply) {
    console.log("\nDry run only -- re-run with --apply to write these changes.");
    return;
  }

  for (const f of fixes) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query("UPDATE invoice_lines SET amount = ?, tax_amount = ? WHERE id = ?", [
        f.newAmount,
        f.newTaxAmount,
        f.lineId,
      ]);
      await conn.query("UPDATE invoices SET total_amount = ? WHERE id = ?", [f.newTotal, f.invoiceId]);

      const [jeRows] = await conn.query(
        "SELECT id FROM journal_entries WHERE source_type = 'invoice' AND source_id = ?",
        [f.invoiceId]
      );
      const journalEntryId = (jeRows as any[])[0]?.id;
      if (!journalEntryId) {
        throw new Error(`No journal entry found for invoice ${f.number} (id ${f.invoiceId})`);
      }

      const [jlRows] = await conn.query(
        "SELECT id, account_id, debit, credit FROM journal_lines WHERE journal_entry_id = ?",
        [journalEntryId]
      );
      const lines = jlRows as { id: number; account_id: number; debit: number; credit: number }[];
      const debitLine = lines.find((l) => Number(l.debit) > 0);
      const creditLine = lines.find((l) => Number(l.credit) > 0 && l.id !== debitLine?.id);
      if (!debitLine || !creditLine) {
        throw new Error(`Journal entry ${journalEntryId} for invoice ${f.number} doesn't have the expected AR debit + income credit lines`);
      }

      await conn.query("UPDATE journal_lines SET debit = ? WHERE id = ?", [f.newTotal, debitLine.id]);
      await conn.query("UPDATE journal_lines SET credit = ? WHERE id = ?", [f.newAmount, creditLine.id]);

      await conn.commit();
      console.log(`Applied: ${f.number}`);
    } catch (err) {
      await conn.rollback();
      console.error(`FAILED on ${f.number}:`, err);
      throw err;
    } finally {
      conn.release();
    }
  }

  console.log(`\nDone. ${fixes.length} invoice(s) corrected.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
