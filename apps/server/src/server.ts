import { buildApp } from './app';

async function start() {
  const app = await buildApp();
  const port = parseInt(process.env.PORT || '3000', 10);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
