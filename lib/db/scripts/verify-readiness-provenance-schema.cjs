const assert = require("node:assert/strict");
const { Client } = require("pg");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sets'
        AND column_name IN ('measurement_source', 'provenance')
    `);

    const columns = new Map(rows.map((row) => [row.column_name, row]));
    const source = columns.get("measurement_source");
    const provenance = columns.get("provenance");

    assert(source, "sets.measurement_source is missing");
    assert(provenance, "sets.provenance is missing");
    assert.equal(source.is_nullable, "NO", "measurement_source must be required");
    assert.equal(provenance.is_nullable, "NO", "provenance must be required");
    assert.match(source.column_default ?? "", /legacy_unclassified/);
    assert.match(provenance.column_default ?? "", /pre-provenance migration/);

    await client.query(
      "SELECT measurement_source, provenance FROM sets ORDER BY created_at DESC LIMIT 1",
    );
    console.log("Readiness provenance schema verification passed.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Readiness provenance schema verification failed:", error);
  process.exitCode = 1;
});