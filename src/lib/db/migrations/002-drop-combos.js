// The Combos feature is removed from this fork (phase `no-combo`): the code no
// longer reads or writes the table, so drop it. Older DBs still carry it until
// this migration runs; fresh DBs never create it (the table is gone from
// schema.js, which syncSchemaFromTables() uses for additive sync).
export default {
  version: 2,
  name: "drop-combos",
  up(db) {
    db.exec("DROP TABLE IF EXISTS combos");
    db.exec("DROP INDEX IF EXISTS idx_combo_name");
  },
};
