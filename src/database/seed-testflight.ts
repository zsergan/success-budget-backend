import dataSource from '@config/typeorm-cli.data-source';
import { readSchemaState, schemaProblem } from './schema-check';
import { provisionTestFlightAccount, readTestFlightInput } from './testflight-account';

// Creates the shared TestFlight demo account. Unlike the dev seed it may run
// against production: it writes nothing once the email exists.
async function provision() {
  const input = readTestFlightInput(process.env);

  try {
    await dataSource.initialize();

    const problem = schemaProblem(await readSchemaState(dataSource));

    if (problem) {
      throw new Error(problem);
    }

    const outcome = await provisionTestFlightAccount(dataSource, input);

    console.log(
      outcome === 'created'
        ? `Created the TestFlight account ${input.email}.`
        : `The TestFlight account ${input.email} already exists and accepts this password. Nothing was changed.`,
    );
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

provision().catch((error) => {
  // the message only: a failed query's error also carries its parameters
  console.error(error instanceof Error ? error.message : 'TestFlight account provisioning failed.');
  process.exit(1);
});
