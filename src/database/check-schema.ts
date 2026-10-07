import dataSource from '@config/typeorm-cli.data-source';
import { readSchemaState, schemaProblem } from './schema-check';

// Run after migrations, before the new build starts: the same check the app
// makes on boot, as a deploy step of its own.
async function check() {
  await dataSource.initialize();

  try {
    const state = await readSchemaState(dataSource);
    const problem = schemaProblem(state);

    if (problem) {
      throw new Error(problem);
    }

    if (state.unknown.length > 0) {
      console.warn(`The database ran migrations this build does not know: ${state.unknown.join(', ')}`);
    }

    console.log(`Schema OK: ${dataSource.migrations.length} migrations applied.`);
  } finally {
    await dataSource.destroy();
  }
}

check().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
